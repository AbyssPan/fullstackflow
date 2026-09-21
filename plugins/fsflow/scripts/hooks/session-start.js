#!/usr/bin/env node
/**
 * session-start.js — 会话启动时扫描工作流状态并注入上下文
 *
 * 职责:
 *   - 扫描 .codebuddy/plans/ 下所有 Story 的 e2e-state.json，找出活跃工作流
 *   - 汇总未解决确认项并指引通过 dispatch 重新验证门控，并注入上轮产出物摘要 / 经验教训 / 契约文件清单
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
 *       2. 指引恢复后调用 dispatch.js，以当前生效门控决定下一步
 *       3. 检查 open-questions.json 是否有未解决项
 *       4. 加载最新 Phase summary（上轮产出物摘要）替代完整对话历史
 *       5. 注入经验教训（历史失败模式提醒）
 *       6. 注入契约文件清单（当前 Phase 应优先加载的文件）
 *       7. 将所有内容作为 additionalContext 注入到 Agent 上下文中
 *   - 注入文本末尾附带强制规则（禁止推进到 Phase 1 的条件、状态文件由 advance-phase.js 独占维护等），不可违反。
 *   - 无活跃工作流时 additionalContext 只输出一行提示，保持低成本。
 *   - @module session-start-hook
 */

const path = require('path')

// ─── 引入公共模块 ──────────────────────────────────────────────

const hookUtils = require(path.join(__dirname, '..', 'lib', 'state'))
const contextRefresh = require(path.join(__dirname, '..', 'services', 'context-refresh'))
const experience = require(path.join(__dirname, '..', 'services', 'experience'))

/**
 * 构建注入到 Agent 上下文的 additionalContext 文本
 * 包含：工作流状态、上轮摘要、经验教训、契约文件清单
 * @param {Array<{storyId: string, state: Object, unresolved: Array}>} workflowResults
 * @returns {string} 上下文文本
 */
function buildAdditionalContext (workflowResults) {
  if (workflowResults.length === 0) {
    return '✅ 无活跃工作流。正常服务用户请求。'
  }

  const lines = []

  for (const wf of workflowResults) {
    const { storyId, state, unresolved } = wf

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    lines.push(`⚡ 工作流恢复: Story ${storyId}`)
    lines.push(`   标题: ${state.title || '未知'}`)
    lines.push(`   当前 Phase: ${state.phase} (${hookUtils.getPhaseName(state.phase)})`)
    lines.push(`   状态: ${state.status}`)
    lines.push(`   最后更新: ${state.updatedAt || '未知'}`)
    if (state.phase === 4 && state.verificationMode === 'ask') {
      lines.push('   测试选择待确认：重新 dispatch，按 recovery.question 主动询问用户是否执行独立测试。未收到明确回答前，不启动测试、不推进；此前已有明确回答则按该选择记录，不重复询问。')
    } else if (state.verificationMode === 'review-only') {
      lines.push('   用户已选择跳过独立功能测试；不要求测试报告，不重复询问是否测试，不得声称测试通过。')
    }

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

    // 启动只恢复快照，避免调用废弃校验器，或在 Hook 超时窗口内重复运行 lint/build。
    lines.push('')
    lines.push('门控尚未重新验证；先执行以下调度命令，再按其结果继续：')
    lines.push(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/commands/dispatch.js" ${storyId}`)

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
  lines.push('4. 推进 Phase → 必须执行 node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/advance-phase.js" <storyId> <targetPhase>')
  lines.push('5. 子 Agent 中断或未落盘产出物 → 重新 dispatch/重派对应 Agent 或转人工，禁止主 Agent 接管该 Phase 的实质工作、跑测试/编译或手写产出物')
  lines.push('')
  lines.push('恢复后先执行 dispatch.js，按 ready / fix_loop / blocked / terminal 四态处理，不依据恢复快照自行推进')

  return lines.join('\n')
}

// ─── Hook 入口 ──────────────────────────────────────────────────────

/**
 * 从 stdin 读取输入数据并执行 SessionStart Hook 逻辑
 * 输出 JSON 格式的 HookOutput 到 stdout
 */
function main () {
  let inputData = {}
  try {
    const stdinData = hookUtils.readStdin()
    if (stdinData.trim()) {
      inputData = JSON.parse(stdinData)
    }
  } catch (e) {
    // stdin 为空或 JSON 解析失败，忽略
  }

  // 扫描活跃工作流（复用 hook-utils 的新版路径逻辑）
  const activeWorkflows = hookUtils.findActiveWorkflows()

  // 为每个活跃工作流提取未解决确认项
  const workflowResults = activeWorkflows.map(wf => {
    // 从 open-questions.json 读取未解决确认项（单一数据源）
    const oqCheck = hookUtils.checkOpenQuestions(wf.storyId)
    const unresolved = (oqCheck.exists && !oqCheck.allResolved)
      ? oqCheck.unresolved.map(q => ({ question: q.question, source: 'open-questions.json' }))
      : []

    return {
      storyId: wf.storyId,
      state: wf.state,
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
