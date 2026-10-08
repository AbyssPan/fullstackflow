#!/usr/bin/env node
/**
 * dispatch.js — 工作流调度器（只读，零写权限）
 *
 * 职责:
 *   - 读取 e2e-state.json，只读地给出「下一步做什么」: status / nextAgent / agentPrompt / advanceCommand / recovery
 *   - 预跑 policy.js 门控，用于决定「该干活还是该推进」，但不写任何状态
 *   - 识别终态（未建流 / 状态解析失败 / 已归档 / 已完成）并给出对应的 recovery 命令
 *   - 汇总 open-questions.json 未确认项与 fix-request.json 修复回路状态，作为不阻塞的告警输出
 *
 * 用法:
 *   node plugins/fsflow/scripts/commands/dispatch.js <storyId>
 *     storyId 可带 plans/ 或 .codebuddy/plans/ 前缀，脚本会自动剥离
 *   输出为纯 JSON，主 Agent 按 status 分支机械执行:
 *     ready     Spawn nextAgent 注入 agentPrompt 干活，或执行 advanceCommand 推进
 *     blocked   状态异常，按 recovery.command / description 修复
 *     fix_loop  Phase 3/4 失败，执行 recovery.command 按原因恢复，再重新 dispatch
 *     terminal  冷启动未建流 / 已归档 / 已完成，recovery 给出创建、复档或归档命令
 *
 * 使用场景:
 *   - harness-conductor 三步循环的 Step 1 每一次都执行它，主 Agent 只按 status 分支执行，
 *     不自行判断当前 Phase，也不直接读 e2e-state.json
 *   - 某 Phase 的 Agent 汇报完成后，重新执行 dispatch.js 取新 Phase 的指令与 advanceCommand，
 *     而不是自己算 targetPhase
 *   - 不确定 Story 停在哪个 Phase、该 Spawn 哪个 Agent 时，用它查表（Phase→Agent 映射的唯一出口）
 *   - 冷启动（e2e-state.json 尚不存在）时，用它的 recovery.command 拿到创建工作流的命令
 *
 * 说明:
 *   - ┌─ 职责边界（本插件控制流的核心约定）────────────────────────────┐
 *     │  dispatch.js      = 读状态 + 说下一步   （只读，零写权限）      │
 *     │  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）  │
 *     │  主 Agent         = 触发                （无判断权，机械执行）  │
 *     └───────────────────────────────────────────────────────────────┘
 *   - 为什么用脚本取代原 dispatcher Agent:
 *     1. dispatcher.md 自己承认 "Phase→Agent 映射是确定的，不需要判断，只需要查表"
 *        —— 查表不该花一次 LLM 往返，更不该承担幻觉风险。
 *     2. dispatcher.md 声称"只读"却持有 Bash 工具，是状态文件保护的唯一无人看守通道。
 *        脚本的只读性由代码本身保证，可审计。
 *     3. 输出里混有自然语言 TODO（如 "从 task-dag.json 提取并行任务列表"），
 *        迫使主 Agent 自己去读文件、自己判断——判断权回流即失控。
 *   - 门控预检只是"预读"，真正的裁定权在 advance-phase.js。dispatch.js 的门控结论仅用于
 *     决定"该干活还是该修复"，绝不代替 advance-phase.js 写状态。
 *   - fix_loop 只给恢复命令；写入恢复上下文后重新 dispatch，避免提前构造的 prompt 缺少本轮问题。
 *   - agentPrompt 只在本脚本确定当前 Phase 需要 Spawn 时，由 services/prompt-builder.js 构造。
 *     门控已通过的推进分支不预构造下一 Phase prompt，推进后重新 dispatch。
 *   - 冷启动处理: 状态文件不存在时不再静默失败，而是返回 terminal + 创建工作流的 recovery 命令，
 *     避免 Phase 0 之前无法调度的死锁。
 *   - 四态互斥且穷尽（ready / blocked / fix_loop / terminal），主 Agent 按 status 分支，不做任何自行判断。
 *   - module.exports = { dispatch }: 当前无其他脚本 require，主要作为 CLI 被 harness-conductor
 *     三步循环的 Step 1 调用；导出保留供后续编排层复用。
 *
 * @module dispatch
 */

const fs = require('fs')
const path = require('path')

const {
  PLANS_DIR,
  PHASE_SLUGS,
  readStateFile,
  getPhaseName,
  getPhaseAgent,
  errorToString,
  errorToType,
  getMaxFixRounds
} = require('../lib/state')

const policy = require('../services/policy')
const promptBuilder = require('../services/prompt-builder')

const MAX_PHASE = PHASE_SLUGS.length - 1

/** 插件根目录下 advance-phase.js 的调用形式（文档中统一用 ${CLAUDE_PLUGIN_ROOT}） */
const ADVANCE_CMD = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/advance-phase.js'
const VERIFICATION_CMD = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/create-workflow.js'

/**
 * 构造调度结果骨架
 * @param {string} storyId - Story ID
 * @param {Object|null} state - 状态对象
 * @returns {Object} 调度结果骨架
 */
function baseResult (storyId, state) {
  const phase = state && typeof state.phase === 'number' ? state.phase : null
  return {
    storyId,
    phase,
    phaseName: phase !== null ? getPhaseName(phase) : null,
    status: 'ready',
    nextAgent: null,
    agentLabel: null,
    agentPrompt: null,
    advanceCommand: null,
    warnings: [],
    recovery: null
  }
}

/**
 * 检查 open-questions.json 中是否有未确认项
 * @param {string} storyId - Story ID
 * @returns {string[]} 告警列表
 */
function checkOpenQuestions (storyId) {
  const p = path.join(PLANS_DIR, storyId, 'open-questions.json')
  if (!fs.existsSync(p)) return []
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const list = Array.isArray(data.questions) ? data.questions : (Array.isArray(data) ? data : [])
    const unresolved = list.filter(q => q && q.resolved !== true)
    if (unresolved.length === 0) return []
    const ids = unresolved.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    return [`open-questions.json 中有 ${unresolved.length} 个未确认问题: ${ids}。请与用户确认后再继续。`]
  } catch (e) {
    return [`open-questions.json 解析失败: ${e.message}`]
  }
}

/**
 * 检测修复回路状态
 * @param {string} storyId - Story ID
 * @returns {{ active: boolean, round?: number, maxRounds?: number, issueCount?: number }}
 */
function detectFixLoop (storyId) {
  const p = path.join(PLANS_DIR, storyId, 'fix-request.json')
  if (!fs.existsSync(p)) return { active: false }
  try {
    const fr = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return {
      active: true,
      sourcePhase: fr.sourcePhase,
      round: fr.round,
      maxRounds: fr.maxRounds,
      issueCount: Array.isArray(fr.issues) ? fr.issues.length : 0,
      affectedFiles: fr.affectedFiles || []
    }
  } catch (e) {
    return { active: false }
  }
}

/**
 * 主调度逻辑
 * @param {string} storyId - Story ID
 * @returns {Object} 调度指令
 */
function dispatchCore (storyId) {
  // ── 冷启动: 状态文件不存在 ────────────────────────────────
  // 原 dispatcher Agent 要求先读 e2e-state.json 才能输出下一步，
  // 导致 Phase 0 之前无法调度（冷启动死锁）。此处显式处理。
  const state = readStateFile(storyId)
  if (!state) {
    return {
      storyId,
      phase: null,
      phaseName: null,
      status: 'terminal',
      nextAgent: null,
      agentLabel: null,
      agentPrompt: null,
      advanceCommand: null,
      warnings: [`工作流尚未创建: .codebuddy/plans/${storyId}/e2e-state.json 不存在`],
      recovery: {
        type: 'not_started',
        command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js start ' + storyId + ' "<标题>"',
        description: '先创建工作流，再重新执行 dispatch.js'
      }
    }
  }

  if (state._parseError) {
    return {
      storyId,
      phase: null,
      phaseName: null,
      status: 'blocked',
      nextAgent: null,
      agentLabel: null,
      agentPrompt: null,
      advanceCommand: null,
      warnings: [],
      recovery: {
        type: 'state_parse_error',
        command: null,
        description: `e2e-state.json 解析失败: ${state._parseError}。需人工修复 JSON 语法后重试。`
      }
    }
  }

  const result = baseResult(storyId, state)
  const phase = result.phase

  // ── 终态: 已归档 ──────────────────────────────────────────
  if (state.status === 'archived') {
    result.status = 'terminal'
    result.warnings.push(
      state.archiveRound
        ? `Story 已归档 (round ${state.archiveRound})，工作流结束。`
        : 'Story 已归档，工作流结束。'
    )
    result.recovery = {
      type: 'archived',
      command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js ' + storyId + ' restore',
      description: '如需继续该 Story，先执行复档'
    }
    return result
  }

  // ── 终态: 流程完成 ────────────────────────────────────────
  if (phase > MAX_PHASE - 1 || state.status === 'completed') {
    result.status = 'terminal'
    result.warnings.push('工作流已完成全部 Phase。')
    result.recovery = {
      type: 'completed',
      command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js ' + storyId + ' archive',
      description: '可执行归档收尾'
    }
    return result
  }

  // ── open-questions 告警（不阻塞，仅提示用户确认） ─────────
  result.warnings.push(...checkOpenQuestions(storyId))

  // ── 门控预检: 判断当前 Phase 的产出物是否已就绪 ───────────
  // 注意: 这里只是"预读"，真正的裁定权在 advance-phase.js。
  //       dispatch.js 的门控结论仅用于决定"该干活还是该修复"，
  //       绝不代替 advance-phase.js 写状态。
  let gate = { passed: true, blockers: [], warnings: [], recoveries: [] }
  try {
    gate = policy.runGateCheck(storyId, phase, state)
  } catch (e) {
    result.status = 'blocked'
    result.recovery = {
      type: 'gate_check_error', command: null,
      description: `门控预检异常，无法确认可推进：${e.message}。修复报告或门控错误后重新 dispatch。`
    }
    return result
  }
  result.warnings.push(...(gate.warnings || []))

  if (gate._meta && gate._meta.verificationChoiceRequired) {
    result.status = 'blocked'
    result.recovery = {
      type: 'verification_choice_required',
      command: null,
      description: '主动询问用户是否执行独立功能测试；等待明确回答后执行对应选项的 command，再重新 dispatch。未回答时不得启动测试或推进，不把默认选项当成回答。',
      question: '代码审查已通过，是否执行独立功能测试？测试会运行页面/接口验证，耗时较长；跳过则继续交付，保留代码审查和项目原有检查。',
      options: [
        { label: '执行测试', value: 'full', command: `${VERIFICATION_CMD} ${storyId} --set-verification=full` },
        { label: '跳过独立测试', value: 'review-only', command: `${VERIFICATION_CMD} ${storyId} --set-verification=review-only` }
      ]
    }
    return result
  }

  const failureRecovery = gate._meta && gate._meta.failureRecovery
  if (!gate.passed && failureRecovery && failureRecovery.targetPhase !== null) {
    const target = failureRecovery.targetPhase
    const previousFix = detectFixLoop(storyId)
    const rounds = target === 2
      ? Math.max(state.fixRounds?.[phase] || 0, previousFix.sourcePhase === phase ? previousFix.round || 0 : 0)
      : state.recoveryRounds?.[phase] || 0
    const maxRounds = getMaxFixRounds(storyId, phase)
    if (rounds >= maxRounds) {
      result.status = 'blocked'
      result.recovery = {
        type: target === 2 ? 'fix_loop_exhausted' : 'recovery_exhausted', command: null,
        description: `Phase ${phase} 已达 ${maxRounds} 轮恢复上限，需人工介入。`,
        causes: failureRecovery.causes
      }
      return result
    }
    result.status = 'fix_loop'
    result.recovery = {
      type: target === 2 ? 'fix_loop' : 'failure_recovery',
      command: `${ADVANCE_CMD} ${storyId} ${target} ${target === 2 ? '--fix-loop' : '--recover-failure'}`,
      description: failureRecovery.description,
      targetPhase: target,
      causes: failureRecovery.causes,
      blockers: gate.blockers.map(b => ({ type: errorToType(b), message: errorToString(b) }))
    }
    result.instruction = '执行 recovery.command，成功后重新 dispatch，使用持久化后的恢复上下文调度 Agent。'
    return result
  }

  // ── 分支 A: 当前 Phase 产出物未就绪 → 该 Phase 的 Agent 干活 ──
  if (!gate.passed) {
    const agentInfo = getPhaseAgent(phase)

    // 常规情况: 本 Phase 的 Agent 尚未产出，让它干活
    if (agentInfo) {
      const pb = promptBuilder.buildAgentPrompt({
        storyId,
        targetPhase: phase,
        summaryPhase: phase - 1
      })
      result.status = 'ready'
      result.nextAgent = pb.agent
      result.agentLabel = pb.agentLabel
      result.agentPrompt = pb.agentPrompt
      if (failureRecovery && failureRecovery.targetPhase === null) result.agentPrompt += `\n${failureRecovery.description}\n`
      result.expectedOutputs = pb.expectedOutputs
      result.advanceCommand = `${ADVANCE_CMD} ${storyId} ${phase + 1}`
      result.pendingBlockers = gate.blockers.map(b => ({
        type: errorToType(b),
        message: errorToString(b)
      }))
      if (pb.fixLoopContext) result.fixLoopContext = pb.fixLoopContext
      return result
    }

    // 无对应 Agent（不应发生，Phase 0-7 均有 Agent）
    result.status = 'blocked'
    result.recovery = {
      type: 'no_agent_for_phase',
      command: null,
      description: `Phase ${phase} 未在 PHASE_AGENTS 中登记 Agent，需补充 scripts/lib/state.js 的映射表`
    }
    return result
  }

  // ── 分支 B: 当前 Phase 已就绪 → 推进到下一 Phase ──────────
  // 门控已通过，说明本 Phase 的活干完了，下一步是执行推进命令。
  // 推进后主 Agent 应再次执行 dispatch.js 获取新 Phase 的指令。
  const nextPhase = phase + 1
  result.status = 'ready'
  result.advanceCommand = `${ADVANCE_CMD} ${storyId} ${nextPhase}`
  result.readyToAdvance = true
  result.instruction = `执行 advanceCommand 推进到 Phase ${nextPhase}，然后重新执行 dispatch.js 获取唯一的下一步指令`

  return result
}

function dispatch (storyId) {
  const result = dispatchCore(storyId)
  const state = readStateFile(storyId)
  if (state && !state._parseError) {
    result.workflowRoute = require('../services/workflow-route').selectRoute(storyId, state)
    try {
      const report = require('../services/workflow-metrics').collectMetrics(storyId)
      result.progress = {
        current: report.phases[result.phase] || null, totals: report.totals,
        reportCommand: `node \${CLAUDE_PLUGIN_ROOT}/scripts/commands/workflow-metrics.js ${storyId}`,
        measurement: report.measurement
      }
    } catch { result.metricsWarning = '阶段度量暂不可用，执行流程继续' }
  }
  return result
}

// ─── CLI ────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2)
  const storyId = args[0] ? args[0].replace(/^(plans\/|\.codebuddy\/plans\/)/i, '') : null

  if (!storyId) {
    console.error(JSON.stringify({
      error: '用法: node dispatch.js <storyId>',
      example: '  node dispatch.js STORY-001'
    }, null, 2))
    process.exit(1)
  }

  try {
    const out = dispatch(storyId)
    console.log(JSON.stringify(out, null, 2))
    process.exit(0)
  } catch (e) {
    console.error(JSON.stringify({
      error: 'dispatch 执行异常',
      storyId,
      message: e.message,
      stack: (e.stack || '').split('\n').slice(0, 5).join('\n')
    }, null, 2))
    process.exit(1)
  }
}

module.exports = { dispatch }
