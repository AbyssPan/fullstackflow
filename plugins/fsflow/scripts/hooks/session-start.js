#!/usr/bin/env node
/**
 * session-start.js — 会话启动时扫描工作流状态并注入上下文
 *
 * 职责:
 *   - 扫描 .codebuddy/plans/ 下所有 Story 的 e2e-state.json，找出活跃工作流
 *   - 执行门控验证、汇总未解决确认项，并注入上轮产出物摘要 / 经验教训 / 契约文件清单
 *   - 输出 additionalContext，让新会话无需回放完整对话历史即可接续工作
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: SessionStart
 *   输入: stdin JSON（SessionStart 事件数据；为空或非法 JSON 时按空输入降级）
 *   输出: stdout JSON（{ continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }）
 *   手动调试: echo '{}' | node session-start.js
 *
 * 使用场景:
 *   - 新会话/断点续跑时 Agent 不知道当前 Story 停在哪个 Phase：
 *     不注入会让 Agent 凭猜测继续，可能重复已完成的工作，或从错误的 Phase 往下推进。
 *   - 上一轮遗留了未确认的 open-questions 或门控 blocker：
 *     不注入会让 Agent 无视阻断项直接推进 Phase 1，把未定稿的需求带进开发阶段。
 *
 * 说明:
 *   - 功能清单:
 *       1. 扫描 .codebuddy/plans/ 子目录下的 e2e-state.json（新版 Story 目录结构）
 *       2. 对每个活跃的工作流执行门控验证脚本（services/validate-phase-gate）
 *       3. 检查 open-questions.json 是否有未解决项
 *       4. 加载最新 Phase summary（上轮产出物摘要）替代完整对话历史
 *       5. 注入经验教训（历史失败模式提醒）
 *       6. 注入契约文件清单（当前 Phase 应优先加载的文件）
 *       7. 将所有内容作为 additionalContext 注入到 Agent 上下文中
 *   - 注入文本末尾附带强制规则（禁止推进到 Phase 1 的条件、状态文件由 advance-phase.js 独占维护等），不可违反。
 *   - 无活跃工作流时 additionalContext 只输出一行提示，保持低成本。
 *   - @module session-start-hook
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// ─── 引入公共模块 ──────────────────────────────────────────────

const hookUtils = require(path.join(__dirname, '..', 'lib', 'state'))
const contextRefresh = require(path.join(__dirname, '..', 'services', 'context-refresh'))
const experience = require(path.join(__dirname, '..', 'services', 'experience'))

/** 项目根目录 / plans 目录 — 复用 lib/state.js 单一信源（已归一化 Git Bash 风格路径） */
const PROJECT_ROOT = hookUtils.PROJECT_ROOT
const PLANS_DIR = hookUtils.PLANS_DIR

/** 验证脚本路径 — 服务层 services/ 目录 */
const GATE_SCRIPT = path.join(__dirname, '..', 'services', 'validate-phase-gate')

/**
 * 执行门控验证脚本
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {Object|null} 验证结果，脚本不存在时返回 null
 */
function runGateValidation (storyId, targetPhase) {
  if (!fs.existsSync(GATE_SCRIPT)) {
    return null
  }
  try {
    const result = execSync(
      `node "${GATE_SCRIPT}" ${storyId} ${targetPhase}`,
      { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return JSON.parse(result)
  } catch (e) {
    // 验证脚本退出码非 0 表示验证失败
    const output = e.stdout || ''
    try {
      return JSON.parse(output)
    } catch {
      return { pass: false, blockers: [e.stderr || e.message], warnings: [] }
    }
  }
}

/**
 * 构建注入到 Agent 上下文的 additionalContext 文本
 * 包含：工作流状态、上轮摘要、经验教训、契约文件清单
 * @param {Array<{storyId: string, state: Object, gateResult: Object|null, unresolved: Array}>} workflowResults
 * @returns {string} 上下文文本
 */
function buildAdditionalContext (workflowResults) {
  if (workflowResults.length === 0) {
    return '✅ 无活跃工作流。正常服务用户请求。'
  }

  const lines = []

  for (const wf of workflowResults) {
    const { storyId, state, gateResult, unresolved } = wf

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    lines.push(`⚡ 工作流恢复: Story ${storyId}`)
    lines.push(`   标题: ${state.title || '未知'}`)
    lines.push(`   当前 Phase: ${state.phase} (${hookUtils.getPhaseName(state.phase)})`)
    lines.push(`   状态: ${state.status}`)
    lines.push(`   最后更新: ${state.updatedAt || '未知'}`)

    // ── Gap A: 上轮产出物摘要 ────────────────────────────────
    // 只取编号不超过当前 Phase 的最新 summary（避免加载后续 Phase 的摘要）
    const summaryInfo = contextRefresh.loadLatestSummary(storyId, state.phase - 1)
    if (summaryInfo) {
      lines.push('')
      lines.push(`## 上轮产出物摘要 (Phase ${summaryInfo.phase} → Phase ${state.phase})`)
      lines.push(`> 替代完整对话历史，以下内容包含了上一轮的关键产出物、决策和下一步指引。`)
      lines.push('')
      lines.push(summaryInfo.content)
    } else {
      lines.push('')
      lines.push(`## 上轮产出物摘要: 无（Phase ${state.phase} 尚无 summary 文件）`)
      lines.push(`> 请自行 read_file .codebuddy/plans/${storyId}/e2e-state.json 查看状态`)
    }

    // ── 待确认项 ────────────────────────────────────────────
    if (unresolved.length > 0) {
      lines.push('')
      lines.push(`⛔ 待确认项 (${unresolved.length} 项未解决，阻断 Phase 推进):`)
      for (const item of unresolved) {
        lines.push(`   - [${item.source || '未知来源'}] ${item.question}`)
      }
      lines.push(`   → 必须等待用户逐项确认后才可推进到 Phase 1`)
    }

    // ── gateChecks 状态 ────────────────────────────────────
    if (state.gateChecks) {
      lines.push('')
      lines.push(`🔒 门控检查状态:`)
      lines.push(`   - prototypeConfirmed: ${state.gateChecks.prototypeConfirmed ? '✅ 已确认' : '❌ 未确认'}`)
      lines.push(`   - documentConfirmed: ${state.gateChecks.documentConfirmed ? '✅ 已确认' : '❌ 未确认'}`)
      lines.push(`   - apiSpecConfirmed: ${state.gateChecks.apiSpecConfirmed ? '✅ 已确认' : '❌ 未确认'}`)
    }

    // ── 门控验证结果 ────────────────────────────────────────
    if (gateResult) {
      lines.push('')
      if (gateResult.pass) {
        lines.push(`✅ 门控验证通过: 可以从 Phase ${state.phase} 推进`)
      } else {
        lines.push(`❌ 门控验证失败 — 以下项目阻断推进:`)
        for (const blocker of gateResult.blockers) {
          lines.push(`   ⛔ ${blocker}`)
        }
        if (gateResult.warnings && gateResult.warnings.length > 0) {
          lines.push(`⚠️ 警告:`)
          for (const w of gateResult.warnings) {
            lines.push(`   - ${w}`)
          }
        }
      }
    }

    // ── Gap B: 经验教训注入 ────────────────────────────────
    const lessons = experience.getLessonsForPhase(state.phase)
    if (lessons) {
      lines.push('')
      lines.push(lessons.trim())
    }

    // ── 度量洞察注入（跨项目通用经验） ────────────────────
    const metricsInsights = experience.getMetricsInsights(state.phase)
    if (metricsInsights) {
      lines.push('')
      lines.push(metricsInsights.trim())
    }

    // ── Gap C: 契约文件清单注入 ────────────────────────────
    // getContractFiles(storyId, completedPhase) 返回下个 Phase 需加载的契约文件
    // 当前 Phase = state.phase，刚完成的 Phase = state.phase - 1
    const completedPhase = state.phase - 1
    const contractFiles = contextRefresh.getContractFiles(storyId, completedPhase)
    if (contractFiles.length > 0) {
      lines.push('')
      lines.push('## 当前 Phase 应优先加载的契约文件')
      for (const c of contractFiles) {
        lines.push(`   → read_file ${c}`)
      }
    }

    lines.push('')
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('')
  lines.push('⛔ 强制规则（不可违反）:')
  lines.push('1. open-questions.json 中存在 resolved=false → 禁止推进到 Phase 1')
  lines.push('2. 主 Agent 不亲自编写代码 → 必须 spawn 专用 Agent 执行')
  lines.push('3. 禁止直接写/改 e2e-state.json 和 dev-pass.json → 状态机由 advance-phase.js 独占维护')
  lines.push('4. 推进 Phase → 必须执行 node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/advance-phase.js <storyId> <targetPhase>')
  lines.push('')
  lines.push('如果门控验证失败 → 向用户报告 blockers，等待用户解决，不可自行推进')

  return lines.join('\n')
}

/**
 * 读取 stdin 全部内容（Windows 兼容）
 * @returns {string} stdin 内容
 */
function readStdin () {
  try {
    const buf = Buffer.alloc(65536)
    const fd = fs.openSync(process.stdin.fd, 'r')
    const bytesRead = fs.readSync(fd, buf, 0, 65536, null)
    fs.closeSync(fd)
    if (bytesRead > 0) {
      return buf.toString('utf-8', 0, bytesRead)
    }
    return ''
  } catch (e) {
    return ''
  }
}

// ─── Hook 入口 ──────────────────────────────────────────────────────

/**
 * 从 stdin 读取输入数据并执行 SessionStart Hook 逻辑
 * 输出 JSON 格式的 HookOutput 到 stdout
 */
function main () {
  let inputData = {}
  try {
    const stdinData = readStdin()
    if (stdinData.trim()) {
      inputData = JSON.parse(stdinData)
    }
  } catch (e) {
    // stdin 为空或 JSON 解析失败，忽略
  }

  // 扫描活跃工作流（复用 hook-utils 的新版路径逻辑）
  const activeWorkflows = hookUtils.findActiveWorkflows()

  // 对每个活跃工作流执行门控验证 + 提取未解决确认项
  const workflowResults = activeWorkflows.map(wf => {
    const targetPhase = wf.state.phase + 1
    const gateResult = runGateValidation(wf.storyId, targetPhase)
    // 从 open-questions.json 读取未解决确认项（单一数据源）
    const oqCheck = hookUtils.checkOpenQuestions(wf.storyId)
    const unresolved = (oqCheck.exists && !oqCheck.allResolved)
      ? oqCheck.unresolved.map(q => ({ question: q.question, source: 'open-questions.json' }))
      : []

    return {
      storyId: wf.storyId,
      state: wf.state,
      gateResult,
      unresolved
    }
  })

  // 构建 additionalContext（包含 summary + 经验 + 契约）
  const additionalContext = buildAdditionalContext(workflowResults)

  // 输出 HookOutput
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  }

  console.log(JSON.stringify(output, null, 0))
  return 0
}

main()
