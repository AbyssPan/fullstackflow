#!/usr/bin/env node
/**
 * metrics-aggregator.js — 跨 Story 度量聚合与全局洞察生成
 *
 * 职责:
 *   1. 读取当前项目所有 Story 的 trace.jsonl + e2e-state.json
 *   2. 计算 8 项核心指标（Phase 耗时、门控通过率、Fix-loop 触发率等）
 *   3. 生成跨项目通用的流程级洞察（非项目特定逻辑）
 *   4. 合并到全局经验库 ~/.codebuddy/experience/metrics-insights.json
 *   5. 供 advance-phase.js 和 session-start.js 注入到 Agent prompt
 *
 * 用法:
 *   独立执行:
 *     node plugins/fullstackflow/scripts/audit/metrics-aggregator.js                 # 聚合当前项目 + 合并到全局
 *     node plugins/fullstackflow/scripts/audit/metrics-aggregator.js --json          # JSON 输出（不写入全局）
 *     node plugins/fullstackflow/scripts/audit/metrics-aggregator.js --global-stats  # 查看全局统计
 *
 * 输出:
 *   - --json: { project, metrics, insights }
 *   - --global-stats: 全局洞察库摘要（totalProjects / totalStories / insights 列表）
 *   - 默认: 人读报告（Story 数 / Phase 耗时 / 门控一次通过率 / Fix-loop 触发率与成功率 /
 *     dev-pass 限域精度 / Skill 与 MCP 资源使用），并合并洞察到全局经验库
 *
 * 使用场景:
 *   - 自动触发: Phase 7 完成时由 commands/advance-phase.js 通过 execSync 调用，
 *     把本 Story 的洞察合并进全局经验库（超时或失败均非阻塞）
 *   - 自动消费: hooks/session-start.js 与 services/prompt-builder.js 通过
 *     experience.getMetricsInsights(phase) 读取全局洞察，按 targetPhase 注入 Agent prompt
 *   - 人工诊断: /harness-evolve 的 Step 1 度量；或想定位本项目流程瓶颈
 *     （哪个 Phase 最慢、门控是否一次通过、fix-loop 是否反复触发）时手动跑
 *
 * 说明:
 *   - 8 项核心指标: phaseDurations、gateFirstTryRate、fixLoopTriggerRate、fixLoopSuccessRate、
 *     blockerCount、devPassPrecision、storyCompletionRate、resourceUsage
 *   - 洞察按 targetPhase 定向注入，触发规则见 THRESHOLDS（如 Phase 平均耗时 > 20min、
 *     门控一次通过率 < 80%、Fix-loop 触发率 > 40%、dev-pass 限域精度 < 70%）
 *   - Fix-loop 触发率会扣除「全部 issue 均为 skipped 误报、fix-verification.json 中无任何
 *     status=fixed」的空转轮次，避免误报把指标拉高
 *   - dev-pass 限域精度只从 trace 的 dev_pass 事件读取，因为 dev-pass.json
 *     在 Phase 2 → 3 撤销后即被删除，事后无法追溯
 *
 * @module metrics-aggregator
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  PROJECT_ROOT,
  listStoryDirs,
  readStateFile,
  getStoryDir,
  getPhaseName,
  PHASE_SLUGS
} = require('../lib/state')

const experience = require('../services/experience')

// ─── 常量 ──────────────────────────────────────────────────

/** 当前项目名（用于 sourceProjects 追踪） */
const PROJECT_NAME = path.basename(PROJECT_ROOT)

/** 阈值常量 */
const THRESHOLDS = {
  PHASE_DURATION_MS: 20 * 60 * 1000,      // Phase 耗时 > 20min → 瓶颈
  GATE_FIRST_TRY_RATE: 0.8,                 // 一次通过率 < 80% → 警告
  FIX_LOOP_TRIGGER_RATE: 0.4,              // Fix-loop 触发率 > 40% → 警告
  FIX_LOOP_SUCCESS_RATE: 0.8,              // Fix-loop 成功率 < 80% → 警告
  DEV_PASS_PRECISION: 0.7                   // dev-pass 限域精度 < 70% → 提示
}

// ─── trace.jsonl 解析 ──────────────────────────────────────

/**
 * 读取指定 Story 的 trace.jsonl 并解析为事件数组
 * @param {string} storyId - Story ID
 * @returns {Array<Object>} trace 事件列表
 */
function readTraceEvents (storyId) {
  const traceFile = path.join(getStoryDir(storyId), 'trace.jsonl')
  if (!fs.existsSync(traceFile)) return []

  const events = []
  const lines = fs.readFileSync(traceFile, 'utf-8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (e) { /* 跳过损坏行 */ }
  }
  return events
}

// ─── 指标计算 ──────────────────────────────────────────────

/**
 * 计算单个 Story 的 Phase 耗时
 * @param {Object} state - e2e-state.json 状态对象
 * @returns {Object<number, number>} Phase 编号 → 耗时（毫秒）
 */
function computePhaseDurations (state) {
  const durations = {}
  if (!state.phases) return durations

  for (let p = 0; p <= 7; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    const phaseState = state.phases[phaseKey]
    if (!phaseState) continue

    const start = phaseState.startedAt ? new Date(phaseState.startedAt).getTime() : null
    const end = phaseState.completedAt
      ? new Date(phaseState.completedAt).getTime()
      : (phaseState.rolledBackAt ? new Date(phaseState.rolledBackAt).getTime() : null)

    if (start && end && end > start) {
      durations[p] = end - start
    }
  }
  return durations
}

/**
 * 聚合所有 Story 的度量数据
 * @returns {Object} 聚合后的度量对象
 */
function aggregateMetrics () {
  const storyDirs = listStoryDirs()
  const allPhaseDurations = {}  // { phase: [duration1, duration2, ...] }
  let totalAdvances = 0
  let gateFirstTryPasses = 0
  let totalPhase3_4Advances = 0
  let fixLoopCount = 0
  let fixLoopSucceeded = 0
  let totalBlockers = 0
  let remainingBlockers = 0
  let totalDevPass = 0
  let preciseDevPass = 0
  let completedStories = 0
  let totalStories = 0
  // 资源使用统计（S3：skill / 知识库 / MCP 消费情况）
  let totalSkillCalls = 0
  let totalKbCalls = 0
  let totalMcpCalls = 0
  const skillCounts = {}   // { skillName: count }
  const mcpCounts = {}     // { mcpServer: count }

  for (const storyId of storyDirs) {
    const state = readStateFile(storyId)
    if (!state) continue
    totalStories++

    // Story 完成状态
    if (state.status === 'completed' || (state.phase >= 7 && state.phases && state.phases['7_deployment'] && state.phases['7_deployment'].status === 'completed')) {
      completedStories++
    }

    // Phase 耗时
    const durations = computePhaseDurations(state)
    for (const [phase, dur] of Object.entries(durations)) {
      if (!allPhaseDurations[phase]) allPhaseDurations[phase] = []
      allPhaseDurations[phase].push(dur)
    }

    // 门控结果
    if (state.gateChecks && Array.isArray(state.gateChecks.gateValidationResults)) {
      for (const gate of state.gateChecks.gateValidationResults) {
        totalAdvances++
        if (gate.pass && (!gate.warnings || gate.warnings.length === 0)) {
          gateFirstTryPasses++
        }
        // 统计 Phase 3/4 相关推进
        if (gate.targetPhase === 4 || gate.targetPhase === 5) {
          totalPhase3_4Advances++
        }
      }
    }

    // Trace 事件统计
    const events = readTraceEvents(storyId)
    let storyFixLoopCount = 0
    let storyFixLoopSucceeded = false
    // 有效 fix-loop 数：扣除「全部 issue 均为误报(skipped)、无任何真实修复」的空转 fix-loop
    let storyValidFixLoopCount = 0

    // 读取 fix-verification.json 判断是否有真实修复（status=fixed），用于区分误报空转
    const fixVerificationPath = path.join(getStoryDir(storyId), 'fix-verification.json')
    let fixHasRealFix = false
    if (fs.existsSync(fixVerificationPath)) {
      try {
        const fv = JSON.parse(fs.readFileSync(fixVerificationPath, 'utf-8'))
        if (fv && Array.isArray(fv.fixes)) {
          fixHasRealFix = fv.fixes.some(f => f.status === 'fixed')
        }
      } catch (e) { /* 解析失败则按有真实修复处理，不误伤 */ }
    }

    for (const evt of events) {
      // Fix-loop 事件
      if (evt.type === 'fix_loop') {
        storyFixLoopCount++
        // P-003: 该 Story 的 fix-verification.json 中无任何 status=fixed 的真实修复
        // （全部为 skipped 误报）时，该次 fix-loop 视为误报空转，不计入有效触发率
        if (fixHasRealFix) {
          fixLoopCount++
          storyValidFixLoopCount++
        }
      }

      // Phase 3 门控通过（fix-loop 后成功修复）
      if (evt.type === 'gate_decision' && evt.phase === '3' && evt.result === 'pass' && storyFixLoopCount > 0) {
        storyFixLoopSucceeded = true
      }

      // dev-pass 签发事件（精度统计从 trace 读取，
      // 因为 dev-pass.json 在 Phase 2→3 撤销后即被删除，无法追溯）
      if (evt.type === 'dev_pass' && evt.result === 'issued') {
        totalDevPass++
        const src = evt.details && evt.details.source
        if (src && src !== 'fallback-src-glob' && src !== 'none') {
          preciseDevPass++
        }
      }

      // 资源调用统计（S3：tool_call 事件，来自 trace-command.js 的旁路采集）
      if (evt.type === 'tool_call') {
        if (evt.skill) {
          totalSkillCalls++
          skillCounts[evt.skill] = (skillCounts[evt.skill] || 0) + 1
          // 知识库检索（kb-query / graphify 双源）
          if (evt.skill === 'kb-query' || evt.skill === 'graphify') {
            totalKbCalls++
          }
        }
        if (evt.mcp) {
          totalMcpCalls++
          mcpCounts[evt.mcp] = (mcpCounts[evt.mcp] || 0) + 1
        }
      }
    }

    // 仅统计「有真实修复」的有效 fix-loop（与 fixLoopCount 的口径一致，扣除误报空转）
    if (storyValidFixLoopCount > 0 && storyFixLoopSucceeded) {
      fixLoopSucceeded++
    }

    // BLOCKER 统计（从 gateChecks）
    if (state.gateChecks && Array.isArray(state.gateChecks.gateValidationResults)) {
      for (const gate of state.gateChecks.gateValidationResults) {
        if (gate.blockers && Array.isArray(gate.blockers)) {
          totalBlockers += gate.blockers.length
        }
      }
    }
  }

  // 计算 Phase 耗时统计
  const phaseDurationStats = {}
  for (const [phase, durations] of Object.entries(allPhaseDurations)) {
    if (durations.length === 0) continue
    const sorted = [...durations].sort((a, b) => a - b)
    const sum = durations.reduce((a, b) => a + b, 0)
    phaseDurationStats[phase] = {
      avg: Math.round(sum / durations.length),
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      count: durations.length
    }
  }

  return {
    storyCount: totalStories,
    completedStories,
    phaseDurations: phaseDurationStats,
    gateFirstTryRate: totalAdvances > 0 ? gateFirstTryPasses / totalAdvances : 1,
    fixLoopTriggerRate: totalPhase3_4Advances > 0 ? fixLoopCount / totalPhase3_4Advances : 0,
    fixLoopSuccessRate: fixLoopCount > 0 ? fixLoopSucceeded / fixLoopCount : 1,
    blockerCount: totalBlockers,
    devPassPrecision: totalDevPass > 0 ? preciseDevPass / totalDevPass : 1,
    storyCompletionRate: totalStories > 0 ? completedStories / totalStories : 0,
    // 资源使用（S3）
    resourceUsage: {
      skillCalls: totalSkillCalls,
      kbCalls: totalKbCalls,
      mcpCalls: totalMcpCalls,
      skillCounts,
      mcpCounts
    }
  }
}

// ─── 洞察生成 ──────────────────────────────────────────────

/**
 * 根据度量数据生成跨项目通用洞察
 * 每条洞察包含 targetPhase（注入目标）+ recommendation（具体建议）
 * @param {Object} metrics - 聚合后的度量数据
 * @returns {Array<Object>} 洞察列表
 */
function generateInsights (metrics) {
  const insights = []

  // 规则 1: Phase 耗时瓶颈
  for (const [phaseStr, stats] of Object.entries(metrics.phaseDurations)) {
    const phase = parseInt(phaseStr, 10)
    if (stats.avg > THRESHOLDS.PHASE_DURATION_MS && stats.count >= 2) {
      const avgMin = Math.round(stats.avg / 60000)
      const maxMin = Math.round(stats.max / 60000)
      insights.push({
        id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
        targetPhase: Math.max(0, phase - 1), // 注入到上一个 Phase（规划阶段优化）
        type: 'bottleneck',
        severity: 'warning',
        title: `Phase ${phase}(${getPhaseName(phase)})平均耗时 ${avgMin}min，最长 ${maxMin}min`,
        description: `${getPhaseName(phase)}阶段耗时偏长，可能影响整体交付效率`,
        recommendation: getRecommendationForPhase(phase),
        evidence: `${stats.count} 个 Story 统计: avg=${avgMin}min, median=${Math.round(stats.median / 60000)}min, max=${maxMin}min`
      })
    }
  }

  // 规则 2: 门控一次通过率
  if (metrics.gateFirstTryRate < THRESHOLDS.GATE_FIRST_TRY_RATE && metrics.storyCount >= 2) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 0,
      type: 'gate_quality',
      severity: 'warning',
      title: `门控一次通过率 ${Math.round(metrics.gateFirstTryRate * 100)}%`,
      description: `${Math.round((1 - metrics.gateFirstTryRate) * 100)}% 的 Phase 推进需要多次门控尝试`,
      recommendation: '需求分析阶段确保 AC 格式正确（id/description/criteria 非空）、open-questions 全部 resolved、task-dag 使用 title 而非 name',
      evidence: `通过率 ${Math.round(metrics.gateFirstTryRate * 100)}% (基于 ${metrics.storyCount} 个 Story)`
    })
  }

  // 规则 3: Fix-loop 触发率
  if (metrics.fixLoopTriggerRate > THRESHOLDS.FIX_LOOP_TRIGGER_RATE) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 2,
      type: 'fix_loop_trigger',
      severity: 'warning',
      title: `Fix-loop 触发率 ${Math.round(metrics.fixLoopTriggerRate * 100)}%`,
      description: '代码审查/测试失败率偏高，开发阶段自测不充分',
      recommendation: '开发阶段加强自测：参考知识库 pitfalls.md 避免已知坑点，ESLint 0 error 后再提交审查',
      evidence: `触发率 ${Math.round(metrics.fixLoopTriggerRate * 100)}%`
    })
  }

  // 规则 4: Fix-loop 第 1 轮成功率
  if (metrics.fixLoopSuccessRate < THRESHOLDS.FIX_LOOP_SUCCESS_RATE && metrics.fixLoopTriggerRate > 0) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 3,
      type: 'fix_loop_success',
      severity: 'warning',
      title: `Fix-loop 第 1 轮成功率 ${Math.round(metrics.fixLoopSuccessRate * 100)}%`,
      description: 'BLOCKER 修复建议的可操作性不足，导致需要多轮修复',
      recommendation: '代码审查师在 FIX_DATA 块中给出代码级建议（含具体行号和替换方案），而非泛泛描述问题',
      evidence: `成功率 ${Math.round(metrics.fixLoopSuccessRate * 100)}%`
    })
  }

  // 规则 5: dev-pass 限域精度
  if (metrics.devPassPrecision < THRESHOLDS.DEV_PASS_PRECISION) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 1,
      type: 'dev_pass_scope',
      severity: 'info',
      title: `dev-pass 限域精度 ${Math.round(metrics.devPassPrecision * 100)}%`,
      description: 'task-dag.json 的 files 声明不完整，dev-pass 降级为 src/** 全局授权',
      recommendation: '任务规划时为每个 task 声明完整的 files 列表，确保 dev-pass 精确限域',
      evidence: `精度 ${Math.round(metrics.devPassPrecision * 100)}%`
    })
  }

  // 规则 6: Story 完成率
  if (metrics.storyCount >= 3 && metrics.storyCompletionRate < 0.7) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 0,
      type: 'completion_rate',
      severity: 'warning',
      title: `Story 完成率 ${Math.round(metrics.storyCompletionRate * 100)}%`,
      description: '部分 Story 未完成，可能存在需求不清晰或阻塞未解决',
      recommendation: '需求分析阶段确保 open-questions 全部 resolved，需求边界明确后再进入开发',
      evidence: `${metrics.completedStories}/${metrics.storyCount} 完成`
    })
  }

  // 规则 7: 知识库检索空转（S3 资源利用）
  const ru = metrics.resourceUsage || {}
  if (metrics.storyCount >= 1 && ru.kbCalls === 0 && ru.skillCalls > 0) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 0,
      type: 'kb_not_consumed',
      severity: 'warning',
      title: '知识库检索（kb-query/graphify）调用为 0 次',
      description: '有 skill 调用但从未做知识库检索，注入的历史教训可能未被查证',
      recommendation: '需求分析/任务规划/代码审查阶段必须调用 kb-query ∥ graphify 双源检索',
      evidence: `skill 调用 ${ru.skillCalls} 次，kb 检索 0 次`
    })
  }

  return insights
}

/**
 * 获取 Phase 对应的优化建议
 * @param {number} phase - Phase 编号
 * @returns {string} 建议文本
 */
function getRecommendationForPhase (phase) {
  const recommendations = {
    0: '需求分析阶段确保 AC 覆盖完整、格式正确，open-questions 全部 resolved 后再推进',
    1: '任务规划时将大 task 拆为 Fork-Join 并行，单 task 控制在 15min 内，为每个 task 声明完整 files',
    2: '开发阶段加强自测，ESLint 0 error 后再提交审查，参考知识库 pitfalls.md 避免已知坑点',
    3: '代码审查师在 FIX_DATA 块中给出代码级建议（含行号和替换方案）',
    4: '测试工程师确保 AC 100% 覆盖，evidence 数组至少 1 条',
    5: 'Git 提交确保 commit 格式规范，禁止 --no-verify',
    6: '知识库更新时保留手工批注',
    7: '部署前确认构建产物完整'
  }
  return recommendations[phase] || '优化该 Phase 的执行效率'
}

// ─── CLI 入口 ──────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonOnly = args.includes('--json')
const globalStats = args.includes('--global-stats')

// 查看全局统计
if (globalStats) {
  const globalData = experience.readMetricsInsights()
  console.log(JSON.stringify({
    totalProjects: globalData.totalProjects,
    totalStories: globalData.totalStories,
    insightCount: globalData.insights.length,
    lastUpdated: globalData.lastUpdated,
    insights: globalData.insights.map(i => ({
      id: i.id,
      targetPhase: i.targetPhase,
      type: i.type,
      title: i.title,
      occurrences: i.occurrences,
      sourceProjects: i.sourceProjects
    }))
  }, null, 2))
  process.exit(0)
}

// 聚合当前项目度量
const metrics = aggregateMetrics()
const insights = generateInsights(metrics)

if (jsonOnly) {
  // JSON 输出模式（不写入全局）
  console.log(JSON.stringify({
    project: PROJECT_NAME,
    metrics,
    insights
  }, null, 2))
  process.exit(0)
}

// 合并到全局经验库
console.log(`\n📊 度量聚合 — 项目: ${PROJECT_NAME}`)
console.log(`   Story 数: ${metrics.storyCount}`)
console.log(`   已完成: ${metrics.completedStories}`)
console.log(`   Phase 耗时统计:`)
for (const [phase, stats] of Object.entries(metrics.phaseDurations)) {
  console.log(`     Phase ${phase}(${getPhaseName(parseInt(phase, 10))}): avg=${Math.round(stats.avg / 60000)}min, max=${Math.round(stats.max / 60000)}min`)
}
console.log(`   门控一次通过率: ${Math.round(metrics.gateFirstTryRate * 100)}%`)
console.log(`   Fix-loop 触发率: ${Math.round(metrics.fixLoopTriggerRate * 100)}%`)
console.log(`   Fix-loop 成功率: ${Math.round(metrics.fixLoopSuccessRate * 100)}%`)
console.log(`   dev-pass 限域精度: ${Math.round(metrics.devPassPrecision * 100)}%`)
const ru = metrics.resourceUsage || {}
console.log(`\n🔧 资源使用:`)
console.log(`   Skill 调用: ${ru.skillCalls || 0} 次 (kb-query/graphify: ${ru.kbCalls || 0} 次)`)
console.log(`   MCP 调用: ${ru.mcpCalls || 0} 次`)
if (ru.skillCounts && Object.keys(ru.skillCounts).length > 0) {
  for (const [s, c] of Object.entries(ru.skillCounts)) console.log(`     - ${s}: ${c} 次`)
}
if (ru.mcpCounts && Object.keys(ru.mcpCounts).length > 0) {
  for (const [m, c] of Object.entries(ru.mcpCounts)) console.log(`     - ${m}: ${c} 次`)
}

console.log(`\n💡 生成 ${insights.length} 条洞察:`)
for (const i of insights) {
  console.log(`   ${i.severity === 'warning' ? '⚠️' : '📊'} [Phase ${i.targetPhase}] ${i.title}`)
}

// 合并到全局
if (insights.length > 0) {
  experience.mergeInsightsToGlobal(insights, PROJECT_NAME)
  console.log(`\n✅ 已合并到全局经验库: ~/.codebuddy/experience/metrics-insights.json`)
} else {
  console.log(`\nℹ️ 无新洞察需要合并`)
}

process.exit(0)
