#!/usr/bin/env node
/**
 * trace.js — 全链路 Trace 事件的追加写入器
 *
 * 职责:
 *   - 记录 Agent 间消息、工具调用、门控决策、协调事件到 story 目录下的 trace.jsonl
 *   - 供调试、审计、经验沉淀使用
 *   - 提供 CLI 入口，让 AI / 人工在无 hook 自动采集的场景下手动补记 Agent 与 Git 事件
 *
 * 用法:
 *   作为模块引用:
 *     const { traceGateDecision, traceToolCall } = require('../lib/trace')
 *   独立执行:
 *     node plugins/fullstackflow/scripts/lib/trace.js agent-spawn  <storyId> <agentName> [taskId] [phase]
 *     node plugins/fullstackflow/scripts/lib/trace.js agent-result <storyId> <agentName> <completed|failed> [detailsJSON]
 *     node plugins/fullstackflow/scripts/lib/trace.js git          <storyId> <init|add|commit|push|mr> [success|failed] [detailsJSON]
 *     node plugins/fullstackflow/scripts/lib/trace.js phase-outcome <storyId> <phase> <outcome> [detailsJSON]
 *     不带子命令时打印 usage JSON
 *
 * 使用场景:
 *   - 被 hooks/enforce-dev-pass.js、hooks/enforce-artifact.js require: 记录守卫放行 / 拒绝事件，
 *     供事后复盘「为什么这次编辑被拦下」
 *   - 被 commands/advance-phase.js require: 记录门控决策、Phase 转换、fix-loop 与经验事件
 *   - 被 commands/archive-story.js require: Story 归档时补记收尾事件
 *   - 人工 / AI 手动执行 CLI: hook 未覆盖的手工 Agent 调用、手工 git 操作，用 CLI 补记进证据链
 *
 * 说明:
 *   - trace.jsonl 每行一条 JSON，字段含 ts / storyId / type，type 覆盖
 *     agent_spawn、agent_result、tool_call、agent_message、gate_decision、
 *     phase_transition、error_recovery、experience、git
 *   - tool_call 与 agent_message 互补: tool_call 记录「调了什么工具」，
 *     agent_message 记录「产出/消费了哪些产物、命中了哪些知识库域」，两者结合才能还原完整证据链
 *   - tool_call 的 ts 与 resourceHash 是「时间戳前置校验」与「特征指纹」的依据，
 *     用于判断注入的教训/设计是否真正影响了产物
 *   - storyId 为空或 Story 目录不存在时静默跳过，不抛错打断主流程
 *
 * @module trace
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir } = require('./state')

/**
 * 追加一条 trace 记录到 story 的 trace.jsonl
 * @param {string} storyId - Story ID
 * @param {Object} entry - trace 条目
 * @param {string} entry.type - 事件类型: agent_spawn|tool_call|gate_decision|agent_message|phase_transition|error_recovery|experience
 * @param {string} [entry.agent] - 涉及的 Agent 名称
 * @param {string} [entry.tool] - 工具名称
 * @param {string} [entry.phase] - Phase 编号
 * @param {string} [entry.result] - 结果: pass|fail|block|allow|deny
 * @param {string} [entry.reason] - 原因说明
 * @param {Object} [entry.details] - 附加详情
 */
function appendTrace (storyId, entry) {
  if (!storyId) return
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) return

  const traceFile = path.join(storyDir, 'trace.jsonl')
  const record = {
    ts: new Date().toISOString(),
    storyId,
    ...entry
  }
  fs.appendFileSync(traceFile, JSON.stringify(record) + '\n', 'utf-8')
}

/**
 * 记录 Agent spawn 事件
 * @param {string} storyId
 * @param {string} agentName - Agent 名称
 * @param {string} taskId - 任务 ID
 * @param {Object} [details] - 附加详情
 */
function traceAgentSpawn (storyId, agentName, taskId, details = {}) {
  appendTrace(storyId, {
    type: 'agent_spawn',
    agent: agentName,
    taskId,
    result: 'spawned',
    details
  })
}

/**
 * 记录 Agent 完成/失败结果
 * @param {string} storyId
 * @param {string} agentName - Agent 名称
 * @param {'completed'|'failed'} status - 结果状态
 * @param {Object} [details] - 附加详情（failed 时建议包含 error 字段）
 */
function traceAgentResult (storyId, agentName, status, details = {}) {
  appendTrace(storyId, {
    type: 'agent_result',
    agent: agentName,
    result: status,
    details
  })
}

/**
 * 记录一次工具 / Skill / MCP 调用 —— 资源消费证据链的核心节点
 *
 * 时间戳 `ts` 由 appendTrace 自动写入，是「时间戳前置校验」（Temporal Check）
 * 的依据：一次有效的资源消费，其 ts 必须早于产物落盘时间。
 * `resourceHash` 是「特征指纹」（Artifact Fingerprint）的依据，用于把
 * 注入的教训/设计与产物侧做 AST 级对应，判断是否真正「影响了」产物。
 *
 * @param {string} storyId - Story ID
 * @param {Object} opts - 调用参数
 * @param {string} opts.tool - 工具名（use_skill / mcp_call_tool / graphify 等）
 * @param {string} [opts.skill] - Skill 名（kb-query / graphify / figma-to-component-map）
 * @param {string} [opts.mcp] - MCP 名（figma / playwright / tapd）
 * @param {string} [opts.mcpTool] - MCP 工具名（get_design_context / get_screenshot）
 * @param {number} [opts.phase] - Phase 编号
 * @param {string} [opts.agent] - 发起调用的 Agent 名
 * @param {string} [opts.resourceHash] - 资源指纹（教训/设计的 hash）
 * @param {string} [opts.result] - 结果: success / failed
 * @param {Object} [opts.details] - 附加信息
 */
function traceToolCall (storyId, opts = {}) {
  appendTrace(storyId, {
    type: 'tool_call',
    tool: opts.tool || null,
    skill: opts.skill || null,
    mcp: opts.mcp || null,
    mcpTool: opts.mcpTool || null,
    phase: opts.phase != null ? String(opts.phase) : null,
    agent: opts.agent || null,
    resourceHash: opts.resourceHash || null,
    result: opts.result || 'success',
    details: opts.details || {}
  })
}

/**
 * 记录 Agent 间消息 —— 用于追踪产物 / 知识库的「产出」与「消费」关系
 *
 * 与 tool_call 互补：tool_call 记录「调了什么工具」，
 * agent_message 记录「这个 Agent 产出/消费了哪些产物、命中了哪些知识库域」。
 * 两者结合才能还原完整的资源消费证据链。
 *
 * @param {string} storyId - Story ID
 * @param {Object} opts - 消息参数
 * @param {number} opts.phase - Phase 编号
 * @param {string} opts.agent - Agent 名
 * @param {'produce'|'consume'} opts.kind - 产出 or 消费
 * @param {string[]} [opts.artifacts] - 引用的产物文件名
 * @param {string[]} [opts.kbDomains] - 命中的知识库域
 * @param {Object} [opts.details] - 附加信息
 */
function traceAgentMessage (storyId, opts = {}) {
  appendTrace(storyId, {
    type: 'agent_message',
    phase: opts.phase != null ? String(opts.phase) : null,
    agent: opts.agent || null,
    kind: opts.kind || 'produce',
    artifacts: opts.artifacts || [],
    kbDomains: opts.kbDomains || [],
    details: opts.details || {}
  })
}

/**
 * 记录门控决策
 * @param {string} storyId
 * @param {number} phase - Phase 编号
 * @param {boolean} passed - 是否通过
 * @param {string[]} blockers - 阻塞项
 * @param {string[]} warnings - 警告项
 */
function traceGateDecision (storyId, phase, passed, blockers = [], warnings = []) {
  appendTrace(storyId, {
    type: 'gate_decision',
    phase: String(phase),
    result: passed ? 'pass' : 'block',
    reason: blockers.length > 0 ? blockers.join('; ') : (warnings.length > 0 ? warnings.join('; ') : 'all passed'),
    details: { blockerCount: blockers.length, warningCount: warnings.length }
  })
}

/**
 * 记录 Phase 转换
 * @param {string} storyId
 * @param {number} fromPhase - 起 Phase
 * @param {number} toPhase - 目 Phase
 */
function tracePhaseTransition (storyId, fromPhase, toPhase) {
  appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(toPhase),
    result: 'transitioned',
    details: { fromPhase, toPhase }
  })
}

/**
 * 记录 Phase 的业务结果（不改写工作流状态）。
 * 用于区分“正常完成”与“用户明确选择跳过”等可审计结果；
 * Phase 跃迁仍只能由 advance-phase.js 执行。
 * @param {string} storyId - Story ID
 * @param {number|string} phase - Phase 编号
 * @param {string} outcome - 业务结果，如 skipped_by_user
 * @param {Object} [details] - 附加说明
 */
function tracePhaseOutcome (storyId, phase, outcome, details = {}) {
  appendTrace(storyId, {
    type: 'phase_outcome',
    phase: String(phase),
    result: outcome,
    details
  })
}

/**
 * 记录错误恢复
 * @param {string} storyId
 * @param {number} phase - Phase 编号
 * @param {string} errorType - 错误类型
 * @param {string} recoveryAction - 恢复动作
 * @param {boolean} recovered - 是否成功恢复
 */
function traceErrorRecovery (storyId, phase, errorType, recoveryAction, recovered) {
  appendTrace(storyId, {
    type: 'error_recovery',
    phase: String(phase),
    result: recovered ? 'recovered' : 'failed',
    reason: errorType,
    details: { recoveryAction }
  })
}

/**
 * 记录 Git 操作事件（commit、push、MR 等）
 * @param {string} storyId
 * @param {string} action - 操作: init|add|commit|push|mr
 * @param {string} result - 结果: success|failed
 * @param {Object} [details] - 附加详情（commit 时建议包含 hash、message）
 */
function traceGitEvent (storyId, action, result, details = {}) {
  appendTrace(storyId, {
    type: 'git',
    action,
    result,
    details
  })
}

/**
 * 记录经验事件（失败模式捕获）
 * @param {string} storyId
 * @param {string} phase - Phase 编号
 * @param {string} failureType - 失败类型
 * @param {string} rootCause - 根因
 * @param {string} resolution - 解决方案
 */
function traceExperience (storyId, phase, failureType, rootCause, resolution) {
  appendTrace(storyId, {
    type: 'experience',
    phase: String(phase),
    result: 'captured',
    reason: failureType,
    details: { rootCause, resolution }
  })
}

module.exports = {
  appendTrace,
  traceAgentSpawn,
  traceAgentResult,
  traceToolCall,
  traceAgentMessage,
  traceGitEvent,
  traceGateDecision,
  tracePhaseTransition,
  tracePhaseOutcome,
  traceErrorRecovery,
  traceExperience
}

// ─── CLI 入口（供 AI 手动调用记录 Agent 事件） ─────────────────

if (require.main === module) {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const storyId = args[1]

  if (cmd === 'agent-result' && storyId && args[2]) {
    const agentName = args[2]
    const status = args[3] === 'failed' ? 'failed' : 'completed'
    const detailStr = args.slice(4).join(' ')
    let details = {}
    try { details = JSON.parse(detailStr) } catch { details = { summary: detailStr } }
    traceAgentResult(storyId, agentName, status, details)
    console.log(JSON.stringify({ ok: true, storyId, agent: agentName, status }))
  } else if (cmd === 'agent-spawn' && storyId && args[2]) {
    const agentName = args[2]
    const taskId = args[3] || ''
    traceAgentSpawn(storyId, agentName, taskId, { phase: args[4] || '?' })
    console.log(JSON.stringify({ ok: true, storyId, agent: agentName, taskId }))
  } else if (cmd === 'git' && storyId && args[2]) {
    const action = args[2]
    const result = args[3] === 'failed' ? 'failed' : 'success'
    const detailStr = args.slice(4).join(' ')
    let details = {}
    try { details = JSON.parse(detailStr) } catch { details = { message: detailStr } }
    traceGitEvent(storyId, action, result, details)
    console.log(JSON.stringify({ ok: true, storyId, action, result }))
  } else if (cmd === 'phase-outcome' && storyId && args[2] && args[3]) {
    const phase = args[2]
    const outcome = args[3]
    const detailStr = args.slice(4).join(' ')
    let details = {}
    try { details = detailStr ? JSON.parse(detailStr) : {} } catch { details = { summary: detailStr } }
    tracePhaseOutcome(storyId, phase, outcome, details)
    console.log(JSON.stringify({ ok: true, storyId, phase: String(phase), outcome }))
  } else {
    console.log(JSON.stringify({
      usage: {
        'agent-spawn': 'node trace.js agent-spawn <storyId> <agentName> [taskId] [phase]',
        'agent-result': 'node trace.js agent-result <storyId> <agentName> <completed|failed> [detailsJSON]',
        'git': 'node trace.js git <storyId> <init|add|commit|push|mr> [success|failed] [detailsJSON]',
        'phase-outcome': 'node trace.js phase-outcome <storyId> <phase> <outcome> [detailsJSON]'
      }
    }, null, 2))
  }
}
