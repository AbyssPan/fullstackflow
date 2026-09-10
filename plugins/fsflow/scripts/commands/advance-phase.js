#!/usr/bin/env node
/**
 * advance-phase.js — Phase 门控裁定与状态跃迁的唯一执行者
 *
 * 职责:
 *   - 独立校验 targetPhase 入参合法性（范围 0~7、步长必须为 +1），越权一律拒绝
 *   - 委托 policy.js 执行门控校验，失败时输出结构化 blockers 与 nextAction
 *   - 门控通过后在 e2e-state.json 中完成相位跃迁，并签发/撤销 dev-pass
 *   - 生成 phase-N-summary.md 上下文摘要、委托 prompt-builder 构造下个 Agent 的 prompt
 *   - 处理 --rollback 回退与 --fix-loop 修复回路两条特殊分支
 *
 * 用法:
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> <phase>
 *     推进到指定 Phase（必须等于 currentPhase + 1）
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> 2 --renew-pass
 *     Phase 2 续签 dev-pass，不推进相位
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> 3 --lint-fix
 *     Phase 2→3 时按 task-dag.json 涉及的仓库逐个执行 eslint --fix
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> <phase> --auto-fix
 *     门控失败时先让 policy.js 尝试自动恢复，再重跑一遍门控
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> <phase> --rollback
 *     回退到更早 Phase：归档中间产出物；targetPhase <= 2 时重置修复预算
 *   node plugins/fsflow/scripts/commands/advance-phase.js <storyId> 2 --fix-loop
 *     修复回路：提取 BLOCKER → 回退 Phase 2 → 签发限域 dev-pass → 输出 spawnPrompt
 *   参数解析：第一个纯数字视为 storyId，最后一个纯数字视为 targetPhase；
 *   非数字参数（可带 plans/ 或 .codebuddy/plans/ 前缀）优先作为 storyId。
 *
 * 使用场景:
 *   - 某 Phase 的 Agent 汇报产出完成、且 dispatch.js 的 status=ready 给出 advanceCommand 后，
 *     主 Agent 执行本命令裁断门控并真正写入 phase
 *   - Phase 3 代码审查 / Phase 4 功能测试出现未修复 BLOCKER 时，主 Agent 执行 --fix-loop
 *     取回 spawnPrompt，交给全栈开发工程师做限域修复
 *   - Phase 2 开发未完成但 dev-pass 已过期时，用 --renew-pass 续签，避免回退重来
 *   - 发现前一 Phase 方向错误（如任务拆解不合理）需要重做时，用 --rollback 归档中间产物并回退
 *   - 门控因格式类问题（如 acceptance-criteria.json 字段缺失）失败时，加 --auto-fix 先尝试自动恢复
 *
 * 说明:
 *   - 三层解耦后的职责划分:
 *       本文件 = Stateful Workflow (确定性状态控制，不应被自主化接管)
 *       policy.js = Policy Runtime (门控校验，独立于编排)
 *       trace.js = Trace 记录 (全链路可观测性)
 *       experience.js = 经验沉淀 (失败模式记录)
 *       context-refresh.js = 上下文刷新 (Phase summary)
 *   - 相位跃迁唯一执行者：只有本文件能改写 state.phase。主 Agent 与 dispatch.js 只有"触发权"，
 *     没有"决定权"——命令可以由任何人敲，但是否合法由本脚本独立裁定。
 *   - targetPhase 入参独立校验：越界会写出 phase: 99 / phases["99_undefined"] 这类污染状态；
 *     跨 Phase 会跳过中间 Phase 的门控、dev-pass 签发/撤销与 phase-N-summary.md 生成；
 *     倒退会使已完成 Phase 的产出物与状态不一致（那是 --rollback 的职责）。
 *   - e2e-state 完整性校验：若 state.phases 中某 Phase 已标记 completed 但 state.phase 仍在其之前，
 *     判定为 Agent 绕过脚本直接改状态（历史教训 STORY-20260710-01），拒绝推进并输出人工修复指引，
 *     同时写入 phase_integrity_violation 事件到 trace。
 *   - 归档状态守卫：Story 已归档时禁止 --rollback / --fix-loop，需先执行 archive-story.js restore。
 *   - 持久化顺序：writeStateFile 先于 trace 写入，确保 trace 不会领先于 state；
 *     summary 生成、trace 记录、度量聚合失败均不阻塞推进。
 *   - Agent prompt 统一委托 services/prompt-builder.js 构造，与 dispatch.js 共用同一信源，
 *     避免出现两份自称权威的 prompt 来源迫使主 Agent 自行拼接。
 *   - Phase 7 完成时自动触发 audit/metrics-aggregator.js 聚合度量，并标记工作流为 completed 终态。
 *
 * @module advance-phase
 */

const fs = require('fs')
const path = require('path')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  ensureStoryDir,
  readStateFile,
  writeStateFile,
  getDevPassAllowedPaths,
  issueDevPass,
  revokeDevPass,
  readJsonArtifact,
  loadRepos,
  getRepoRoot,
  DEV_PASS_TTL,
  PHASE_SLUGS,
  PHASE_NAMES,
  getPhaseSlug,
  getPhaseName,
  errorToString,
  errorToType,
  getMaxFixRounds
} = require('../lib/state')

const policy = require('../services/policy')
const trace = require('../lib/trace')
const experience = require('../services/experience')
const contextRefresh = require('../services/context-refresh')

// ========================
// CLI 参数解析
// ========================

const args = process.argv.slice(2)
let storyId = null
let targetPhase = null
let renewFlag = false
let lintFixFlag = false
let autoFixFlag = false
let rollbackFlag = false
let fixLoopFlag = false

// 纯数字参数可能同时包含 storyId（TAPD 需求 ID 为纯数字）与 phase 数字。
// 解析规则：第一个纯数字视为 storyId，最后一个纯数字视为 targetPhase。
// 非数字参数（含路径前缀）优先作为 storyId。
const numericArgs = []
const nonNumericArgs = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--renew-pass') renewFlag = true
  else if (arg === '--lint-fix') lintFixFlag = true
  else if (arg === '--auto-fix') autoFixFlag = true
  else if (arg === '--rollback') rollbackFlag = true
  else if (arg === '--fix-loop') fixLoopFlag = true
  else if (/^\d+$/.test(arg)) numericArgs.push(arg)
  else nonNumericArgs.push(arg)
}

// 非数字参数优先作为 storyId（兼容 plans/xxx 前缀）
if (nonNumericArgs.length > 0) {
  storyId = nonNumericArgs[0].replace(/^(plans\/|\.codebuddy\/plans\/)/i, '')
}
// 纯数字：第一个为 storyId，最后一个为 targetPhase
if (numericArgs.length > 0) {
  if (!storyId) storyId = numericArgs[0]
  targetPhase = parseInt(numericArgs[numericArgs.length - 1], 10)
}

if (!storyId || targetPhase === null) {
  console.log(JSON.stringify({
    error: '用法: node advance-phase.js <storyId> <phase> [--renew-pass] [--lint-fix] [--auto-fix] [--rollback] [--fix-loop]',
    example: '  node advance-phase.js STORY-002 2\n  node advance-phase.js STORY-002 1 --rollback\n  node advance-phase.js STORY-002 2 --fix-loop'
  }, null, 2))
  process.exit(1)
}

// ========================
// 加载 e2e-state.json
// ========================

const state = readStateFile(storyId)
if (!state || state._parseError) {
  console.log(JSON.stringify({ error: state?._parseError || 'e2e-state.json 不存在', storyId }, null, 2))
  process.exit(1)
}

// ========================
// Phase 2 dev-pass 续签
// ========================

if (renewFlag && targetPhase === 2) {
  const pass = issueDevPass(storyId, DEV_PASS_TTL)
  if (!pass) {
    console.log(JSON.stringify({ error: '签发 dev-pass 失败' }, null, 2))
    process.exit(1)
  }
  trace.tracePhaseTransition(storyId, 2, 2)
  console.log(JSON.stringify({
    success: true, storyId, phase: 2,
    pass: { expiresAt: pass.expiresAt, allowedPaths: pass.allowedPaths.length + ' files', source: pass.pathSource }
  }, null, 2))
  process.exit(0)
}

// ========================
// Phase 推进逻辑
// ========================

const currentPhase = (state.phase !== undefined && state.phase !== null) ? state.phase : -1
const currentPhaseName = getPhaseName(currentPhase)

// ========================
// 🛡️ targetPhase 入参独立校验
// 原则: 不信任调用方传入的 targetPhase。主 Agent / dispatch.js 只有"触发权"，
//       没有"决定权"——命令可以由任何人敲，但是否合法由本脚本独立裁定。
// 校验 1: 范围。越界会导致 PHASE_SLUGS[targetPhase] 为 undefined，
//         写出 phase: 99 / phases["99_undefined"] 这类污染状态。
// ========================

const MAX_PHASE = PHASE_SLUGS.length - 1

if (targetPhase < 0 || targetPhase > MAX_PHASE) {
  console.log(JSON.stringify({
    error: `targetPhase 越界: ${targetPhase}，合法范围 0~${MAX_PHASE}`,
    storyId,
    currentPhase,
    hint: `Phase 定义: ${PHASE_SLUGS.map((s, i) => `${i}=${getPhaseName(i)}`).join(', ')}`
  }, null, 2))
  process.exit(1)
}

// ========================
// 🛡️ e2e-state 完整性校验: 检测 Agent 是否绕过脚本直接修改了 phase
// 历史教训: STORY-20260710-01 中 task-planner Agent 直接修改 phase 导致门控被跳过
// 策略: 检测到篡改 → 拒绝推进 + 输出明确修复指引（不自动修复，要求人工确认）
// ========================

/**
 * 校验 state.phases 中每个 phase 的状态与实际 phase 值是否一致
 * 如果某个 phase 标记为 completed 但 state.phase 仍在该 phase 之前 → 发现篡改
 * @param {Object} state - e2e-state.json 解析对象
 * @returns {{ valid: boolean, actualPhase: number, declaredPhase: number }}
 */
function validatePhaseIntegrity (state) {
  const declaredPhase = state.phase
  let maxCompletedPhase = -1
  if (state.phases) {
    for (const [key, val] of Object.entries(state.phases)) {
      if (val.status === 'completed') {
        const phaseMatch = key.match(/^(\d+)_/)
        if (phaseMatch) {
          const p = parseInt(phaseMatch[1], 10)
          if (p > maxCompletedPhase) maxCompletedPhase = p
        }
      }
    }
  }
  if (maxCompletedPhase > declaredPhase) {
    return { valid: false, actualPhase: maxCompletedPhase, declaredPhase }
  }
  return { valid: true, actualPhase: declaredPhase, declaredPhase }
}

const integrityCheck = validatePhaseIntegrity(state)
if (!integrityCheck.valid) {
  const errorOutput = {
    error: 'e2e-state.json 完整性校验失败: 检测到 Agent 越权修改状态文件',
    storyId,
    details: {
      declaredPhase: integrityCheck.declaredPhase,
      actualPhase: integrityCheck.actualPhase,
      rootCause: `Agent 在 Phase ${integrityCheck.declaredPhase} 完成后直接修改了 state.phase，将 phases.${integrityCheck.actualPhase}_* 标记为 completed，但未通过 advance-phase.js 推进`,
      whyBlocked: [
        '1. 跳过 advance-phase.js 的门控校验（产出物完整性、AC 格式、open-questions 等）',
        '2. 跳过 dev-pass 的签发/撤销逻辑（Phase 1→2 签发、Phase 2→3 撤销）',
        '3. 跳过上下文摘要（phase-N-summary.md）生成',
        '4. trace.jsonl 缺失关键事件记录，审计链断裂'
      ]
    },
    fixCommand: `node advance-phase.js ${storyId} ${integrityCheck.actualPhase}`,
    fixSteps: [
      `1. 确认 Phases ${integrityCheck.declaredPhase + 1}~${integrityCheck.actualPhase} 的产出物是否已由 Agent 生成`,
      `2. 手动将 e2e-state.json 的 phase 改回 ${integrityCheck.declaredPhase}`,
      `3. 逐 Phase 执行 advance-phase.js 推进（从 ${integrityCheck.declaredPhase} 到 ${integrityCheck.actualPhase}），让脚本重新执行门控`,
      `4. 或者直接执行: node advance-phase.js ${storyId} ${integrityCheck.actualPhase}（跳过的 Phase 门控将无法追溯）`
    ],
    prevention: [
      'Agent prompt 中必须包含: "禁止修改 e2e-state.json，Phase 推进由主 Agent 调用 advance-phase.js 完成"',
      'Agent 完成任务后只汇报产出物路径，不操作状态文件'
    ]
  }

  // 记录 trace（篡改事件）
  trace.appendTrace(storyId, {
    type: 'phase_integrity_violation',
    phase: String(integrityCheck.declaredPhase),
    actualPhase: String(integrityCheck.actualPhase),
    result: 'blocked',
    reason: 'agent_direct_state_mutation_detected'
  })

  console.log(JSON.stringify(errorOutput, null, 2))
  process.exit(1)
}

// ========================
// --rollback: 回退 Phase（归档当前阶段产出物，更新 phase）
// ========================

if (rollbackFlag) {
  // 🛡️ 归档状态守卫：归档后禁止 --rollback（归档后产出物已移走，回退无意义）
  if (state.status === 'archived') {
    console.log(JSON.stringify({
      error: `Story 已归档 (round ${state.archiveRound || '?'})，禁止 --rollback`,
      hint: '归档后的 Story 不支持回退操作。如需恢复，请先执行: node archive-story.js ' + storyId + ' restore'
    }, null, 2))
    process.exit(1)
  }

  if (targetPhase >= currentPhase) {
    console.log(JSON.stringify({
      error: `--rollback 必须回退到更早的 Phase: 当前 ${currentPhase}(${currentPhaseName}) → 目标 ${targetPhase}(${getPhaseName(targetPhase)})`,
      hint: '回退时 targetPhase 必须 < currentPhase'
    }, null, 2))
    process.exit(1)
  }

  const now = new Date()
  const archiveDir = path.join(PLANS_DIR, storyId, 'archive')
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true })
  }

  // 归档 targetPhase+1 ~ currentPhase 的产出物
  for (let p = targetPhase + 1; p <= currentPhase; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    // 标记 phase 状态为 rolled_back
    if (state.phases && state.phases[phaseKey]) {
      state.phases[phaseKey].status = 'rolled_back'
      state.phases[phaseKey].rolledBackAt = now.toISOString()
    }
    // 归档该 phase 的产出物文件（重命名为 .archived 后缀，不删除）
    const phaseArtifacts = require('../lib/state').PHASE_ARTIFACTS[p]
    if (phaseArtifacts && phaseArtifacts.artifacts) {
      for (const art of phaseArtifacts.artifacts) {
        if (!art.fileName) continue
        const filePath = path.join(PLANS_DIR, storyId, art.fileName)
        if (fs.existsSync(filePath)) {
          const archivedPath = path.join(archiveDir, `${art.fileName}.phase-${p}.archived`)
          fs.renameSync(filePath, archivedPath)
        }
      }
    }
  }

  // 更新 phase
  const targetPhaseKey = `${targetPhase}_${PHASE_SLUGS[targetPhase]}`
  if (!state.phases) state.phases = {}
  state.phases[targetPhaseKey] = { status: 'running', startedAt: now.toISOString() }
  state.phase = targetPhase
  state.status = 'running'
  state.updatedAt = now.toISOString()

  // Phase 2 特殊处理：回退到 Phase 2 → 重新签发 dev-pass
  if (targetPhase === 2) {
    const allowedInfo = getDevPassAllowedPaths(storyId)
    issueDevPass(storyId, DEV_PASS_TTL, allowedInfo.paths)
    console.log('  ✓ dev-pass 已重新签发')
  } else {
    // 回退到非 Phase 2 → 撤销 dev-pass
    revokeDevPass(storyId)
  }

  // 修复预算重置：回退到 Phase 2 或更早 = 开发重来一遍，修复轮次不应继承上一轮的计数。
  // fix-request.json 的 round 是 fix-loop 的唯一计数源（见下方 --fix-loop 分支），
  // 手工 --rollback 后若不重置，剩余预算会被上一轮吃掉，甚至直接撞 fix_loop_exhausted。
  let fixBudgetReset = null
  if (targetPhase <= 2) {
    const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
    if (fs.existsSync(fixRequestPath)) {
      let prevRound = 0
      try {
        prevRound = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8')).round || 0
      } catch (e) { /* 解析失败按 0 处理 */ }
      fs.renameSync(fixRequestPath, path.join(archiveDir, `fix-request.json.rollback-${targetPhase}.archived`))
      fixBudgetReset = { previousRound: prevRound }
      trace.appendTrace(storyId, {
        type: 'fix_budget_reset',
        phase: String(targetPhase),
        from: String(currentPhase),
        to: String(targetPhase),
        previousRound: String(prevRound),
        reason: 'manual_rollback'
      })
      console.log(`  ✓ 修复预算已重置（上一轮 round=${prevRound}，fix-request.json 已归档）`)
    }
  }

  // 记录 trace
  trace.tracePhaseTransition(storyId, currentPhase, targetPhase)
  trace.appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(targetPhase),
    from: String(currentPhase),
    to: String(targetPhase),
    reason: 'rollback'
  })

  // 持久化
  writeStateFile(storyId, state)

  console.log(JSON.stringify({
    success: true,
    storyId,
    fromPhase: currentPhase,
    toPhase: targetPhase,
    toPhaseName: getPhaseName(targetPhase),
    archivedPhases: `${targetPhase + 1}-${currentPhase}`,
    archiveDir: path.relative(PROJECT_ROOT, archiveDir),
    fixBudgetReset,
    note: '已归档产出物到 archive/ 目录，dev-pass 已处理'
  }, null, 2))
  process.exit(0)
}

// ========================
// --fix-loop: 修复回路（Phase 3/4 失败 → 提取 BLOCKER → 回退 Phase 2 → 签发 dev-pass）
// ========================

/**
 * 从 code-review.json 中提取 BLOCKER 级别问题
 * 保留 issue 的 project/repoPath —— 跨仓 Story 中 issue.file 只是「问题出现位置」，
 * 修复点可能在别的仓库（如落地页），fix-loop 需据此把受影响文件定位到正确仓库。
 * @param {string} storyDir - Story 目录路径
 * @returns {Array<{id, severity, file, line, description, suggestion, project, repoPath}>}
 */
function extractFixIssuesFromReview(storyDir) {
  const crJsonPath = path.join(storyDir, 'code-review.json')
  if (!fs.existsSync(crJsonPath)) return []

  try {
    const crData = JSON.parse(fs.readFileSync(crJsonPath, 'utf-8'))
    const openBlockers = (crData.issues || []).filter(
      i => i.severity === 'BLOCKER' && i.status === 'open'
    )
    return openBlockers.map((b, idx) => ({
      id: b.id || `FIX-${String(idx + 1).padStart(2, '0')}`,
      severity: 'BLOCKER',
      file: b.file || '',
      line: b.line ? String(b.line) : '',
      description: b.title ? `${b.title}: ${b.description || ''}` : (b.description || ''),
      suggestion: b.suggestion || '',
      project: b.project || undefined,
      repoPath: b.repoPath || undefined
    }))
  } catch (e) {
    return []
  }
}

/**
 * 从 acceptance-verification.json 中提取 status=failed 的 AC
 * @param {Object} verification - 解析后的 acceptance-verification.json 对象
 * @returns {Array<{id, severity, file, line, description, suggestion}>}
 */
function extractFixIssuesFromVerification(verification) {
  if (!verification || !Array.isArray(verification.results)) return []

  return verification.results
    .filter(r => r.status === 'failed')
    .map((r, idx) => ({
      id: `FIX-${String(idx + 1).padStart(2, '0')}`,
      severity: 'BLOCKER',
      acId: r.id,
      description: `验收标准 ${r.id}: ${r.title || '未通过验收'}`,
      suggestion: Array.isArray(r.evidence) ? r.evidence.join('; ') : (r.notes || '请根据验收标准修复相关功能'),
      notes: r.notes || ''
    }))
}

if (fixLoopFlag) {
  // 🛡️ 归档状态守卫：归档后禁止 --fix-loop（归档后产出物已移走，无法提取修复问题）
  if (state.status === 'archived') {
    console.log(JSON.stringify({
      error: `Story 已归档 (round ${state.archiveRound || '?'})，禁止 --fix-loop`,
      hint: '归档后的 Story 不支持修复回路。如需恢复，请先执行: node archive-story.js ' + storyId + ' restore'
    }, null, 2))
    process.exit(1)
  }

  const storyDir = path.join(PLANS_DIR, storyId)

  // 1. 从失败 Phase 的产出物中提取待修复问题
  let issues = []
  let sourcePhase = null
  let sourceFile = null

  // 从 code-review.json 提取未修复 BLOCKER（唯一信源）
  const extracted = extractFixIssuesFromReview(storyDir)
  if (extracted.length > 0) {
    issues = extracted
    sourcePhase = 3
    sourceFile = 'code-review.json'
  }

  // 如果审查报告没有 BLOCKER，尝试从 acceptance-verification.json 提取 failed
  if (issues.length === 0) {
    const verifyPath = path.join(storyDir, 'acceptance-verification.json')
    if (fs.existsSync(verifyPath)) {
      try {
        const verification = JSON.parse(fs.readFileSync(verifyPath, 'utf-8'))
        const failures = extractFixIssuesFromVerification(verification)
        if (failures.length > 0) {
          issues = failures
          sourcePhase = 4
          sourceFile = 'acceptance-verification.json'
        }
      } catch (e) { /* 解析失败，跳过 */ }
    }
  }

  // 也尝试从 test-report.md 提取（兜底）
  if (issues.length === 0) {
    const testReportPath = path.join(storyDir, 'test-report.md')
    if (fs.existsSync(testReportPath)) {
      const testContent = fs.readFileSync(testReportPath, 'utf-8')
      // 搜索 "需修改" 模式
      const fixSection = testContent.match(/需修改[：:]\s*(.+)/g)
      if (fixSection && fixSection.length > 0) {
        issues = fixSection.map((s, idx) => ({
          id: `FIX-${String(idx + 1).padStart(2, '0')}`,
          severity: 'BLOCKER',
          description: s.replace(/需修改[：:]\s*/, '').trim(),
          suggestion: '请根据测试报告中的具体建议进行修复'
        }))
        sourcePhase = 4
        sourceFile = 'test-report.md'
      }
    }
  }

  if (issues.length === 0) {
    console.log(JSON.stringify({
      status: 'no_issues_found',
      message: '未在 code-review.json / acceptance-verification.json / test-report.md 中找到可修复问题',
      hint: '如果确实需要修复，请手动创建 fix-request.json'
    }, null, 2))
    process.exit(1)
  }

  // 2. 修复预算按失败源独立计数（code-review 与 test 各 2 次，不共享额度）
  const MAX_FIX_ROUNDS = getMaxFixRounds(storyId, sourcePhase)

  // 检查修复轮次
  const fixRequestPath = path.join(storyDir, 'fix-request.json')
  let currentRound = 0
  if (fs.existsSync(fixRequestPath)) {
    try {
      const prevFix = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8'))
      // round 独立计数：仅当上次 fix-loop 与本次同源才累加；跨源（review→test 或反之）视为该阶段首次
      currentRound = (prevFix.sourcePhase === sourcePhase) ? (prevFix.round || 0) : 0
    } catch (e) { /* 解析失败，从 0 开始 */ }
  }

  if (currentRound >= MAX_FIX_ROUNDS) {
    const sourceLabel = sourcePhase === 3 ? '代码审查 (Phase 3)' : '功能测试 (Phase 4)'
    console.log(JSON.stringify({
      action: 'human_intervention_required',
      status: 'fix_loop_exhausted',
      message: `已达 ${sourceLabel} 的最大修复轮次 (${MAX_FIX_ROUNDS})，需人工介入决策`,
      remainingIssues: issues.map(i => `${i.id}: ${i.description}`),
      escalation: [
        '1. 人工评审剩余 BLOCKER，判断是否可降级为 WARNING',
        '2. 联系需求分析师确认是否需要调整 AC',
        '3. 或联系任务规划师重新拆解任务'
      ],
      blockerCount: issues.length
    }, null, 2))
    process.exit(1)
  }

  const nextRound = currentRound + 1

  // 3. 提取受影响文件 —— 跨仓 Story 中 issue.file 只是「问题出现位置」，修复点可能在别的仓库
  //    （如跳转参数无人消费，问题报在跳出端，要改的是落地页）。
  //    收集规则：
  //      - issue.file：问题出现位置（必收）
  //      - issue.repoPath：若它是具体修复点文件（非仓库根路径）→ 作为额外受影响文件加入；
  //        若它是仓库根 → 仅用于把 issue.file 定位到该仓库
  //    dev-pass 限域据此把每个受影响文件归到正确仓库，避免跨仓修复时被误拦截。
  const reposForFix = loadRepos(storyId)
  // 已注册仓库根路径集合，用于判断 repoPath 是「仓库根」还是「具体文件」
  const repoRoots = new Set(Object.values(reposForFix.repos).map(r => path.resolve(r).replace(/\\/g, '/')))
  const affectedFileRepo = {} // 文件(相对路径) → { repo, repoPath }

  function addAffectedFile (relPath, repoName, explicitRepoPath) {
    if (!relPath) return
    const trimmed = String(relPath).trim()
    if (!trimmed) return
    const validRepo = reposForFix.repos[repoName] ? repoName : reposForFix.primary
    if (!affectedFileRepo[trimmed]) {
      affectedFileRepo[trimmed] = { repo: validRepo, repoPath: explicitRepoPath || reposForFix.repos[validRepo] }
    }
  }

  for (const issue of issues) {
    const repoName = issue.project || reposForFix.primary
    // repoPath 是仓库根还是具体修复点文件？
    let repoPathIsRoot = false
    if (issue.repoPath) {
      const rpAbs = path.resolve(issue.repoPath).replace(/\\/g, '/')
      repoPathIsRoot = repoRoots.has(rpAbs)
    }
    // 修复点文件：repoPath 是具体文件（非仓库根）时采用；否则用 issue.file 并归到 project 仓库
    if (issue.repoPath && !repoPathIsRoot) {
      addAffectedFile(issue.repoPath, repoName, issue.repoPath)
    } else {
      addAffectedFile(issue.file, repoName, issue.repoPath)
    }
  }

  const affectedFiles = Object.keys(affectedFileRepo)

  // 4. 生成 fix-request.json
  const fixRequest = {
    source: sourcePhase === 3 ? 'code-review' : 'acceptance-test',
    sourcePhase,
    sourceFile,
    round: nextRound,
    maxRounds: MAX_FIX_ROUNDS,
    generatedAt: new Date().toISOString(),
    issues,
    affectedFiles,
    constraint: '⛔ 仅修复以上 affectedFiles 中的文件，禁止修改其他文件'
  }
  fs.writeFileSync(fixRequestPath, JSON.stringify(fixRequest, null, 2), 'utf-8')

  // 5. 归档当前 Phase 产出物（sourcePhase）
  const archiveDir = path.join(storyDir, 'archive')
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true })
  }
  if (sourcePhase && sourceFile) {
    const srcPath = path.join(storyDir, sourceFile)
    if (fs.existsSync(srcPath)) {
      const archivedPath = path.join(archiveDir, `${sourceFile}.fix-round-${nextRound}.archived`)
      fs.copyFileSync(srcPath, archivedPath)
    }
  }

  // 6. 回退到 Phase 2 + 重新运行 Phase 2
  const now = new Date()
  const phase2Key = '2_development'
  const phase3Key = '3_code_review'
  const phase4Key = '4_e2e_verification'

  // 标记当前及中间 Phase 为 rolled_back
  for (let p = 3; p <= currentPhase; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    if (state.phases && state.phases[phaseKey]) {
      state.phases[phaseKey].status = 'rolled_back'
      state.phases[phaseKey].rolledBackAt = now.toISOString()
    }
  }

  // 重新启动 Phase 2
  if (!state.phases) state.phases = {}
  state.phases[phase2Key] = {
    status: 'running',
    startedAt: now.toISOString(),
    fixRound: nextRound
  }
  state.phase = 2
  state.status = 'running'
  state.updatedAt = now.toISOString()

  // 7. 重新签发 dev-pass（限域到 affectedFiles，跨仓时按 issue 的 project/repoPath 定位到正确仓库）
  const repos = loadRepos(storyId)
  const scopedPaths = affectedFiles.length > 0
    ? affectedFiles.map(f => {
        const fr = affectedFileRepo[f] || { repo: repos.primary }
        return { repo: fr.repo, path: f }
      })
    : [{ repo: repos.primary, path: 'src/**' }]

  const devPass = {
    storyId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEV_PASS_TTL).toISOString(),
    phase: 2,
    reason: `Fix loop round ${nextRound}/${MAX_FIX_ROUNDS} (from Phase ${sourcePhase})`,
    allowedPaths: scopedPaths,
    pathSource: 'fix-loop-scoped',
    pathWarnings: affectedFiles.length === 0 ? ['affectedFiles 为空，降级为全 src/** 授权'] : [],
    fixRound: nextRound
  }
  const devPassPath = path.join(storyDir, 'dev-pass.json')
  fs.writeFileSync(devPassPath, JSON.stringify(devPass, null, 2), 'utf-8')

  // 8. 记录 trace
  trace.tracePhaseTransition(storyId, currentPhase, 2)
  trace.appendTrace(storyId, {
    type: 'fix_loop',
    phase: '2',
    from: String(currentPhase),
    sourcePhase: String(sourcePhase),
    round: String(nextRound),
    maxRounds: String(MAX_FIX_ROUNDS),
    issueCount: String(issues.length),
    result: 'prepared'
  })

  // 9. 持久化 state
  writeStateFile(storyId, state)

  // 9.5 生成 fix-context.md（上下文延续，供下轮审查/测试 Agent 加载）
  const fixContextPath = path.join(storyDir, 'fix-context.md')
  const issueListForContext = issues.map((i) =>
    `- **${i.id}** [${i.severity}]${i.file ? ` \`${i.file}${i.line ? ':' + i.line : ''}\`` : ''}\n  - 问题: ${i.description}\n  - 建议: ${i.suggestion || '请根据上下文分析并修复'}`
  ).join('\n')
  const fixContextContent = [
    `# 修复回路上下文 (第 ${nextRound}/${MAX_FIX_ROUNDS} 轮)`,
    '',
    `> Story: ${storyId} | 来源: Phase ${sourcePhase} (${sourcePhase === 3 ? '代码审查' : '功能测试'}) | 生成时间: ${now.toISOString()}`,
    `> 本文件供下轮代码审查师/测试工程师加载，了解上轮发现的问题和本轮修复情况。`,
    '',
    '## 上轮发现的问题',
    '',
    issueListForContext,
    '',
    '## 受影响文件',
    affectedFiles.length > 0 ? affectedFiles.map(f => `- \`${f}\``).join('\n') : '- 未明确（从 fix-request.json 获取）',
    '',
    '## 修复核对报告',
    '',
    '修复完成后，开发者会产出 `fix-verification.json`，逐项标记每个问题的修复状态（fixed/partially/skipped）。',
    '审查/测试时应以该文件为锚点，逐项核对修复是否到位。',
    '',
    '## 审查/测试指引',
    '',
    '- 优先复查 `affectedFiles` 中的文件改动',
    '- 逐项核对 `fix-verification.json` 中每个 FIX-XX 的修复状态',
    '- `status=skipped` 的问题需重点确认是否有合理理由',
    '- `status=partially` 的问题需重点复查是否完全修复',
    '- 确认修复未引入新的 BLOCKER',
    ''
  ].join('\n')
  fs.writeFileSync(fixContextPath, fixContextContent, 'utf-8')

  // 10. 构造 spawnPrompt（主 Agent 直接注入给全栈开发工程师）
  const issueList = issues.map((i, idx) =>
    `\n**${i.id}** [${i.severity}]${i.file ? ` \`${i.file}${i.line ? ':' + i.line : ''}\`` : ''}\n` +
    `- 问题: ${i.description}\n` +
    `- 建议: ${i.suggestion || '请根据上下文分析并修复'}\n`
  ).join('\n')

  const spawnPrompt = [
    `## 🔧 修复任务 (第 ${nextRound}/${MAX_FIX_ROUNDS} 轮)`,
    '',
    `你正在接收来自 **${sourcePhase === 3 ? '代码审查 (Phase 3)' : '功能测试 (Phase 4)'}** 的修复请求。`,
    '',
    `### 待修复问题 (共 ${issues.length} 个)`,
    issueList,
    `### 受影响文件`,
    affectedFiles.length > 0
      ? affectedFiles.map(f => `- \`${f}\``).join('\n')
      : '- 未明确（从 fix-request.json 获取）',
    '',
    '### 约束',
    '- ⛔ 仅修复以上列出的文件，禁止修改其他文件',
    '- ⛔ 禁止顺手重构不相关的代码',
    '- ✅ 每修复一个问题后输出 `✅ [问题ID] 已修复: <实际改动说明>`',
    `- ✅ 修复完成后执行 \`npx eslint --fix <修改的文件路径>\`（执行前询问用户）`,
    `- ✅ 修复完成后生成 \`fix-report-round${nextRound}.md\`（记录实际改动）`,
    '',
    `### 修复请求详情文件`,
    `- 完整修复请求: \`.codebuddy/plans/${storyId}/fix-request.json\``,
    `- 请先读取该文件了解完整上下文`,
    '',
    `### 修复完成后`,
    `- 产出 \`fix-verification.json\`（逐项核对修复结果），格式:`,
    `  \`{"round": ${nextRound}, "source": "${sourcePhase === 3 ? 'code-review' : 'acceptance-test'}", "fixes": [{"id":"FIX-01","status":"fixed|partially|skipped","actualChange":"改动说明","filesModified":["src/xxx"]}], "summary":{"total":N,"fixed":N,"partially":N,"skipped":N}}\``,
    `- 通知主 Agent 执行: \`advance-phase.js ${storyId} 3\`（会自动注入修复上下文给审查师）`,
    ''
  ].join('\n')

  // 11. 输出结构化结果
  console.log(JSON.stringify({
    status: 'fix_loop_prepared',
    action: 'spawn_frontend_developer',
    storyId,
    sourcePhase,
    round: nextRound,
    maxRounds: MAX_FIX_ROUNDS,
    issueCount: issues.length,
    affectedFiles,
    fixRequestPath: path.relative(PROJECT_ROOT, fixRequestPath),
    devPassExpiresAt: devPass.expiresAt,
    devPassScope: affectedFiles.length > 0 ? `${affectedFiles.length} files` : 'src/**',
    spawnPrompt,
    nextSteps: [
      `1. 主 Agent 将上述 spawnPrompt 作为 Prompt Spawn 全栈开发工程师(agent 注册名: fullstack-developer)`,
      `2. 开发者修复完成后 → 主 Agent 执行: advance-phase.js ${storyId} 3`,
      `3. 如果 Phase 3/4 仍失败 → 再次执行: advance-phase.js ${storyId} 2 --fix-loop`,
      `4. 达到 ${MAX_FIX_ROUNDS} 轮上限 → 人工介入处理`
    ]
  }, null, 2))
  process.exit(0)
}

if (targetPhase === currentPhase) {
  // Phase 0 复用检测: 如果推进到 Phase 1 时 Phase 0 产出物已存在，输出提示
  if (currentPhase === 0 && targetPhase === 0) {
    const storyDir = path.join(PLANS_DIR, storyId)
    const raPath = path.join(storyDir, 'requirement-analysis.md')
    const acPath = path.join(storyDir, 'acceptance-criteria.json')
    const hasPhase0Artifacts = fs.existsSync(raPath) && fs.existsSync(acPath)
    if (hasPhase0Artifacts) {
      console.log(JSON.stringify({
        success: true, storyId, phase: currentPhase, name: currentPhaseName,
        note: '已在目标 Phase，无需推进',
        phase0Reuse: {
          detected: true,
          message: 'Phase 0 产出物已存在，可直接复用。如 bug 分析报告有更新但 AC 未反映，请手动更新 acceptance-criteria.json 后推进到 Phase 1'
        }
      }, null, 2))
      process.exit(0)
    }
  }
  console.log(JSON.stringify({ success: true, storyId, phase: currentPhase, name: currentPhaseName, note: '已在目标 Phase，无需推进' }, null, 2))
  process.exit(0)
}

// ========================
// 🛡️ targetPhase 入参独立校验 — 校验 2: 步长
// 到此处说明是正常推进路径（--rollback / --fix-loop 已在上方 exit）。
// 相位跃迁必须严格 +1：既不允许倒退（那是 --rollback 的职责），
// 也不允许跨越（跨 Phase 会跳过中间 Phase 的产出物门控与 dev-pass 签发/撤销）。
// ========================

if (targetPhase !== currentPhase + 1) {
  const isBackward = targetPhase < currentPhase
  console.log(JSON.stringify({
    error: isBackward
      ? `禁止倒退推进: 当前 Phase ${currentPhase}(${currentPhaseName}) → 目标 Phase ${targetPhase}(${getPhaseName(targetPhase)})`
      : `禁止跨 Phase 推进: 当前 Phase ${currentPhase}(${currentPhaseName}) → 目标 Phase ${targetPhase}(${getPhaseName(targetPhase)})，一次只能推进一个 Phase`,
    storyId,
    currentPhase,
    targetPhase,
    whyBlocked: isBackward
      ? ['倒退会使已完成 Phase 的产出物与状态不一致', '回退请使用 --rollback，它会归档中间产出物']
      : [
          `跳过了 Phase ${currentPhase + 1}~${targetPhase - 1} 的门控校验（产出物完整性、AC 格式、open-questions）`,
          '跳过了 dev-pass 的签发/撤销时机（Phase 1→2 签发、Phase 2→3 撤销）',
          '跳过了中间 Phase 的 phase-N-summary.md 生成，上下文链断裂'
        ],
    fixCommand: isBackward
      ? `node advance-phase.js ${storyId} ${targetPhase} --rollback`
      : `node advance-phase.js ${storyId} ${currentPhase + 1}`,
    hint: isBackward
      ? '如需回退，请加 --rollback'
      : `请逐 Phase 推进：先执行到 Phase ${currentPhase + 1}，完成产出物后再推进下一个`
  }, null, 2))

  trace.appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(currentPhase),
    to: String(targetPhase),
    result: 'blocked',
    reason: isBackward ? 'backward_transition_without_rollback' : 'phase_skip_attempt'
  })

  process.exit(1)
}

// ========================
// 门控校验 (委托给 policy.js)
// ========================

/** @type {{ passed: boolean, blockers: Array<{type:string,message:string,level:number,resolution:string}>, warnings: string[], recoveries: Array, _meta: Object }} */
let combinedResult = { passed: true, blockers: [], warnings: [], recoveries: [], _meta: {} }

for (let p = currentPhase; p < targetPhase; p++) {
  console.log(`\n--- Phase ${p}(${getPhaseName(p)}) → Phase ${p + 1}(${getPhaseName(p + 1)}) 门控检查 ---`)

  const gateResult = policy.runGateCheck(storyId, p, state)

  // 输出检查结果
  if (gateResult.blockers.length === 0) {
    console.log(`  ✓ Phase ${p} 门控通过`)
  }
  for (const w of gateResult.warnings) {
    console.log(`  ⚠ ${w}`)
  }
  for (const b of gateResult.blockers) {
    console.log(`  ✗ ${errorToString(b)}`)
  }

  // 记录 trace — blockers 为结构化对象，转为字符串供 trace
  trace.traceGateDecision(storyId, p, gateResult.passed, gateResult.blockers.map(b => errorToString(b)), gateResult.warnings)

  // 合并结果（去重：同类型 blocker 只保留一条 + count 信息）
  combinedResult.passed = combinedResult.passed && gateResult.passed
  for (const b of gateResult.blockers) {
    const bType = errorToType(b)
    const existing = combinedResult.blockers.find(cb => errorToType(cb) === bType)
    if (!existing) {
      combinedResult.blockers.push(b)
    }
    // 如果已存在同类型 blocker，合并 count 信息（不在 message 层面重复）
  }
  combinedResult.warnings.push(...gateResult.warnings)
  combinedResult.recoveries.push(...gateResult.recoveries)
  // 合并 _meta（fixLoopAvailable 等标记）
  if (gateResult._meta) {
    combinedResult._meta = { ...combinedResult._meta, ...gateResult._meta }
  }

  if (!gateResult.passed) break // 遇到阻塞就停止
}

// ========================
// 错误恢复站点 (#4)
// ========================

if (!combinedResult.passed) {
  // Level 1: 尝试自动修复
  if (autoFixFlag && combinedResult.recoveries.length > 0) {
    console.log('\n--- 🔧 自动修复尝试 ---')
    const recovery = policy.attemptAutoRecovery(storyId, combinedResult.recoveries)
    for (const d of recovery.details) {
      console.log(`  ${d}`)
    }

    if (recovery.fixed) {
      console.log(`\n--- 🔄 重新门控检查 ---`)
      // 重新执行门控
      combinedResult = { passed: true, blockers: [], warnings: [], recoveries: [], _meta: {} }
      for (let p = currentPhase; p < targetPhase; p++) {
        const gateResult = policy.runGateCheck(storyId, p, state)
        trace.traceErrorRecovery(storyId, p, 'gate_failure', 'auto_fix', gateResult.passed)
        combinedResult.passed = combinedResult.passed && gateResult.passed
        for (const b of gateResult.blockers) {
          const bType = errorToType(b)
          if (!combinedResult.blockers.find(cb => errorToType(cb) === bType)) {
            combinedResult.blockers.push(b)
          }
        }
        combinedResult.warnings.push(...gateResult.warnings)
        if (gateResult._meta) {
          combinedResult._meta = { ...combinedResult._meta, ...gateResult._meta }
        }
        if (!gateResult.passed) break
      }
    }
  }

  // 仍然失败: 记录经验 — 按 failureType 聚合，避免同根因产生大量重复记录
  if (!combinedResult.passed) {
    // 1. 按 failureType 聚合 blockers
    /** @type {Map<string, {count:number, sampleRootCause:string, sampleResolution:string, levels:Set<number>}>} */
    const aggregated = new Map()
    for (const b of combinedResult.blockers) {
      const failureType = errorToType(b)
      const suggestion = policy.matchRecoverySuggestion(b)
      const key = failureType !== 'unknown'
        ? failureType
        : (suggestion ? suggestion.action.split(' ')[0] || 'unknown' : 'unknown')

      if (aggregated.has(key)) {
        const entry = aggregated.get(key)
        entry.count++
        entry.levels.add(b.level || 2)
      } else {
        aggregated.set(key, {
          count: 1,
          sampleRootCause: errorToString(b),
          sampleResolution: b.resolution || (suggestion ? suggestion.action : '需人工分析并补充到 RECOVERY_SUGGESTIONS'),
          levels: new Set([b.level || 2])
        })
      }
    }

    // 2. 按聚合后的类型逐条记录
    for (const [failureType, agg] of aggregated) {
      experience.recordFailurePattern({
        phase: currentPhase,
        failureType,
        rootCause: `${agg.count} 个 ${failureType} 问题 (示例: ${agg.sampleRootCause.slice(0, 200)})`,
        resolution: agg.sampleResolution,
        storyId,
        blockers: combinedResult.blockers.map(b => errorToString(b))
      })

      trace.appendTrace(storyId, {
        type: 'experience',
        phase: String(currentPhase),
        result: 'captured',
        reason: failureType,
        details: {
          count: agg.count,
          maxLevel: Math.max(...agg.levels),
          sampleRootCause: agg.sampleRootCause.slice(0, 300),
          resolution: agg.sampleResolution
        }
      })
    }

    // 输出恢复建议
    const recoveryHints = combinedResult.recoveries
      .filter(r => r.suggestion)
      .map(r => `  → ${r.suggestion.action} (Level ${r.suggestion.level})`)

    // nextAction 强语义输出：降低主 Agent 理解成本，直接给出下一步动作
    const nextAction = combinedResult._meta?.fixLoopAvailable
      ? { action: 'run_fix_loop', command: combinedResult._meta.fixLoopHint, description: '执行修复回路: 提取问题 → 回退 Phase 2 → 签发限域 dev-pass → Spawn 开发者修复' }
      : (autoFixFlag
        ? { action: 'manual_fix', command: null, description: '自动修复未能解决所有 blockers，需人工分析处理' }
        : { action: 'retry_with_auto_fix', command: `node advance-phase.js ${storyId} ${targetPhase} --auto-fix`, description: '可尝试 --auto-fix 自动修复格式类问题' })

    console.log(JSON.stringify({
      success: false,
      storyId,
      targetPhase,
      targetPhaseName: getPhaseName(targetPhase),
      gatePassed: false,
      nextAction,
      fixLoopAvailable: combinedResult._meta?.fixLoopAvailable || false,
      fixLoopHint: combinedResult._meta?.fixLoopHint || null,
      blockers: combinedResult.blockers.map(b => errorToString(b)),
      structuredBlockers: combinedResult.blockers,  // ← 新增：结构化 blocker 供主 Agent 使用
      warnings: combinedResult.warnings,
      recoverySuggestions: recoveryHints.length > 0 ? recoveryHints : undefined,
      hint: combinedResult._meta?.fixLoopAvailable
        ? `发现可修复问题，建议执行: ${combinedResult._meta.fixLoopHint}`
        : (autoFixFlag ? '自动修复未能解决所有问题，请手动处理' : '可添加 --auto-fix 尝试自动修复')
    }, null, 2))
    process.exit(1)
  }
}

// ========================
// 推进 Phase
// ========================

const now = new Date()
const phaseKey = `${targetPhase}_${PHASE_SLUGS[targetPhase]}`
const currentPhaseKey = `${currentPhase}_${PHASE_SLUGS[currentPhase]}`

// 完成当前 Phase
if (state.phases && state.phases[currentPhaseKey]) {
  state.phases[currentPhaseKey].status = (
    currentPhase === 4 && state.verificationMode === 'review-only'
  ) ? 'skipped' : 'completed'
  state.phases[currentPhaseKey].completedAt = now.toISOString()
  if (state.phases[currentPhaseKey].status === 'skipped') {
    state.phases[currentPhaseKey].skipReason = 'verification_mode_review_only'
  }
}

// 启动目标 Phase
if (!state.phases) state.phases = {}
state.phases[phaseKey] = { status: 'running', startedAt: now.toISOString() }
state.phase = targetPhase
state.status = 'running'
state.updatedAt = now.toISOString()

// 记录门控结果
if (!state.gateChecks) state.gateChecks = {}
if (!Array.isArray(state.gateChecks.gateValidationResults)) {
  state.gateChecks.gateValidationResults = []
}
state.gateChecks.gateValidationResults.push({
  targetPhase, pass: true, timestamp: now.toISOString(),
  blockers: [], warnings: combinedResult.warnings
})

// 空转检测：当前 Phase 完成时无产出物 → 标记为 noop
// 放在 state 写入之前，信息注入到 state 中
const phaseArtifacts = require('../lib/state').PHASE_ARTIFACTS
const completedPhaseArtifacts = phaseArtifacts && phaseArtifacts[currentPhase]
if (completedPhaseArtifacts && Array.isArray(completedPhaseArtifacts.artifacts)) {
  const allMissing = completedPhaseArtifacts.artifacts.every(art => {
    // Phase 2/5/6/7 产出物不是文件（git diff / commit / 部署），跳过
    if (!art.fileName) return false
    try {
      const artPath = path.join(PLANS_DIR, storyId, art.fileName)
      return !fs.existsSync(artPath)
    } catch (_) { return false }
  })
  if (allMissing && completedPhaseArtifacts.artifacts.length > 0) {
    trace.appendTrace(storyId, {
      type: 'phase_noop',
      phase: String(currentPhase),
      result: 'noop',
      details: { reason: 'no artifacts produced', artifactCount: completedPhaseArtifacts.artifacts.length }
    })
  }
}

// ========================
// Phase 2 特殊逻辑: 签发 dev-pass
// ========================

let devPass = null
if (targetPhase === 2) {
  const allowedInfo = getDevPassAllowedPaths(storyId)
  devPass = issueDevPass(storyId, DEV_PASS_TTL, allowedInfo.paths)
  state.devPass = devPass.storyId + '-' + now.toISOString().slice(0, 10).replace(/-/g, '')
  trace.appendTrace(storyId, {
    type: 'dev_pass',
    phase: '2',
    result: 'issued',
    reason: 'phase_1_to_2',
    details: {
      expiresAt: devPass.expiresAt,
      allowedPathsCount: devPass.allowedPaths.length,
      source: devPass.pathSource
    }
  })
}

// ========================
// Phase 2→3 特殊逻辑: 撤销 dev-pass + lint fix
// ========================

if (targetPhase === 3) {
  revokeDevPass(storyId)
  console.log('  ✓ dev-pass 已撤销 (Phase 2→3)')
  trace.appendTrace(storyId, { type: 'dev_pass', phase: String(targetPhase), result: 'revoked', reason: 'phase_2_to_3' })

  if (state.devPass) delete state.devPass

  if (lintFixFlag) {
    const { execSync } = require('child_process')
    const repos = loadRepos(storyId)
    // 从 task-dag.json 提取涉及的仓库（缺省 primary），逐仓库执行 eslint --fix
    const taskData = readJsonArtifact(storyId, 'task-dag.json')
    const involvedRepos = new Set()
    if (taskData && Array.isArray(taskData.tasks)) {
      for (const t of taskData.tasks) involvedRepos.add(t.repo || repos.primary)
    } else {
      involvedRepos.add(repos.primary)
    }
    let allSuccess = true
    for (const repoName of involvedRepos) {
      const repoRoot = getRepoRoot(repoName, repos)
      try {
        execSync('npx eslint src/ --fix --format compact 2>&1', {
          cwd: repoRoot, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        })
        console.log(`  ✓ eslint --fix 完成 (${repoName})`)
      } catch (e) {
        allSuccess = false
        console.log(`  ⚠ eslint --fix 异常 (${repoName}): ` + (e.stderr || e.message || '').slice(0, 200))
        combinedResult.warnings.push(`eslint --fix 异常 (${repoName})（非阻塞）`)
      }
    }
    trace.appendTrace(storyId, { type: 'lint_fix', result: allSuccess ? 'success' : 'partial' })
  }
}

// ========================
// Phase 4→5 特殊逻辑: 兜底撤销 dev-pass（双保险）
// 正常流程下 Phase 2→3 已撤销，此处防止 fix-loop 重新签发后残留
// revokeDevPass 幂等，文件不存在时安全跳过
// ========================

if (targetPhase === 5) {
  const devPassPath = path.join(PLANS_DIR, storyId, 'dev-pass.json')
  if (fs.existsSync(devPassPath)) {
    revokeDevPass(storyId)
    console.log('  ✓ dev-pass 兜底撤销 (Phase 4→5，审查+测试双通过，开发窗口关闭)')
    trace.appendTrace(storyId, { type: 'dev_pass', phase: String(targetPhase), result: 'revoked', reason: 'phase_4_to_5_safety_net' })
    if (state.devPass) delete state.devPass
  }
  // 标记 Git 提交阶段开始（后续 git 操作应通过 trace.js CLI 逐条记录）
  trace.appendTrace(storyId, {
    type: 'git',
    action: 'phase_start',
    result: 'pending',
    details: { note: 'Phase 5 Git 提交阶段开始，使用 node trace.js git <storyId> <action> success <details> 逐条记录' }
  })
}

// ========================
// 上下文刷新: 生成 Phase summary + 加载内容注入 (#2)
// ========================

try {
  const summaryPath = contextRefresh.generatePhaseSummary(storyId, currentPhase)
  if (summaryPath) {
    console.log(`  ✓ 上下文摘要已生成: ${path.basename(summaryPath)}`)
    trace.appendTrace(storyId, { type: 'context_refresh', phase: String(currentPhase), result: 'success', details: { file: path.basename(summaryPath) } })

  }
} catch (e) {
  // summary 生成失败不阻塞推进
  console.log(`  ⚠ 上下文摘要生成失败: ${e.message}`)
}

// 持久化 — 最关键的步骤，必须在 trace 之前完成
writeStateFile(storyId, state)

// 记录 trace（state 写入成功后才记录，确保 trace 不会领先于 state）
try {
  trace.tracePhaseTransition(storyId, currentPhase, targetPhase)
} catch (_) {
  // trace 失败不阻塞主流程
}

// ========================
// 输出结果
// ========================

const result = {
  success: true,
  storyId,
  fromPhase: currentPhase,
  fromPhaseName: currentPhaseName,
  toPhase: targetPhase,
  toPhaseName: getPhaseName(targetPhase),
  gateChecks: {
    passed: true,
    checks: combinedResult.warnings.length > 0 ? ['warnings: ' + combinedResult.warnings.join('; ')] : ['all passed']
  }
}

if (devPass) {
  result.devPass = { expiresAt: devPass.expiresAt, allowedFiles: devPass.allowedPaths.length, source: devPass.pathSource }
}

// advance-phase 只返回推进结果。下一个 Agent 及 prompt 必须回到 dispatch.js 获取，
// 避免在一次循环中构造、输出两份完整 prompt。
result.nextAction = 'rerun_dispatch'

// Phase 7 完成时自动触发度量聚合 + 标记工作流为 completed（终态）
if (currentPhase === 7 && targetPhase > 7) {
  // 度量聚合
  try {
    const { execSync } = require('child_process')
    const aggregatorPath = path.join(__dirname, '..', 'audit', 'metrics-aggregator.js')
    if (fs.existsSync(aggregatorPath)) {
      execSync(`node "${aggregatorPath}"`, { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT_ROOT })
      console.log('  ✓ 度量聚合已完成，洞察已合并到全局经验库')
      trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'success' })
    } else {
      // 路径不存在时显式告警，避免 existsSync 静默跳过导致度量永不聚合
      console.log('  ⚠ 度量聚合脚本不存在（非阻塞）: ' + aggregatorPath)
      trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'skipped', reason: 'aggregator_not_found: ' + aggregatorPath })
    }
  } catch (e) {
    console.log('  ⚠ 度量聚合失败（非阻塞）: ' + (e.message || '').slice(0, 100))
    trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'failed', reason: (e.message || '').slice(0, 200) })
  }

  // 标记工作流为终态（completed）
  state.status = 'completed'
  state.completedAt = now.toISOString()
  state.updatedAt = now.toISOString()
  writeStateFile(storyId, state)
  trace.appendTrace(storyId, { type: 'workflow', action: 'completed', result: 'success' })
  console.log('  ✓ 工作流已标记为 completed')
}

console.log(JSON.stringify(result, null, 2))
process.exit(0)
