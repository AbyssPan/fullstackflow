#!/usr/bin/env node
/**
 * session-stop.js — Agent 每轮回答结束时的自动收尾
 *
 * 职责:
 *   - 单次扫描所有 Story 目录，产出 session 变更摘要（活跃工作流 / src 变更 / 知识库待办）
 *   - 清理过期 dev-pass，把 trace.jsonl 中的 Hook 拒绝事件沉淀到经验库
 *   - 当前激活 Story 走到终态时自动关闭 Harness 模式（harness end）
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: Stop
 *   输入: stdin JSON（含 stop_hook_active；为 true 说明本 Hook 已在续跑循环中，直接放行不做收尾）
 *   输出: stdout JSON（{ continue: true, hookSpecificOutput: { hookEventName: 'Stop', additionalContext } }，
 *         additionalContext 上限 8000 字符，超限逐级降级）
 *   手动调试: echo '{}' | node session-stop.js
 *
 * 使用场景:
 *   - Agent 一轮回答结束后留下过期的 dev-pass.json：
 *     不清理会留下可被 enforce-dev-pass.js 误信的过期凭证，src/ 限域出现空窗。
 *   - 本轮触发过 Hook 拒绝（越界编辑、跳 Phase、写状态文件）：
 *     不沉淀到经验库，同样的失败模式会在下一轮、下一个 Story 反复重演，门控只能一直硬拦而无法自省。
 *   - Story 已走完 Phase 8 但 .harness-active 未关闭：
 *     不自动结束会让 src/ 持续处于限域保护下，后续正常的非 Harness 编辑被无谓拦截。
 *
 * 说明:
 *   - 注册在 Claude Code 的 `Stop` 事件下，**每轮回答结束都会触发**（不是会话终止）。
 *     会话终止对应 `SessionEnd` 事件 —— 不要按「会话结束才跑一次」来理解本脚本的执行频率。
 *   - 功能清单:
 *       1. 单次扫描所有工作流（活跃 + 已完成），替代早期的两次扫描
 *       2. 清理过期的 dev-pass 文件
 *       3. 从 trace.jsonl 沉淀 Hook 拒绝事件到经验库
 *       4. 所有工作流完成后自动结束 Harness 模式
 *       5. 输出 session 变更摘要
 *   - 各环节独立 try/catch，单点失败不阻塞整体收尾。
 *   - autoEndHarness 演进说明：旧逻辑要求「所有活跃工作流都完成」才 end；新逻辑改为「当前激活 Story
 *     走到终态（status='completed' 且 phase >= 8）即 end」——因为 .harness-active 一次只激活一个 Story，
 *     它走到终态即代表本次 Harness 主流程结束。无激活 Story 时回退到旧逻辑。
 *   - additionalContext 超过 MAX_CONTEXT_CHARS(8000) 时逐级降级：完整 → 去掉 src 文件清单 → 只保留核心计数。
 *   - 诊断日志走 stderr，不污染 stdout 的 JSON 输出。
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  listStoryDirs,
  readStateFile,
  getPhaseName,
  revokeDevPass,
  readStdin
} = require('../lib/state')
const experience = require('../services/experience')

// ─── 常量 ────────────────────────────────────────────────────────

const HARNESS_ACTIVE_FILE = path.join(PLANS_DIR, '.harness-active')
const GIT_TIMEOUT = 5000

/** 非代码文件目录前缀，不计入 src 变更统计 */
const NON_SRC_PREFIXES = ['node_modules/', 'dist/', '.codebuddy/', '.git/']

/** additionalContext 字符上限（Claude Code 对 hook 输出有截断，留出安全余量） */
const MAX_CONTEXT_CHARS = 8000

/** summary.changedFiles.src 最多列举的文件数，超出只记数量 */
const MAX_SRC_FILES = 50

// ─── 工作流扫描（单次迭代） ──────────────────────────────────────

/**
 * 单次扫描所有 Story 目录，同时分类为 active / completed
 * @returns {{ active: Array, completed: Array }}
 */
function scanAllWorkflows() {
  const dirs = listStoryDirs()
  const active = []
  const completed = []

  for (const dir of dirs) {
    const stateFile = path.join(PLANS_DIR, dir, 'e2e-state.json')
    if (!fs.existsSync(stateFile)) continue

    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      if (state.status === 'running' || state.status === 'paused') {
        active.push({ storyId: dir, state })
      } else if (state.status === 'completed') {
        completed.push({ storyId: dir, state })
      }
    } catch (_) { /* JSON 损坏，跳过 */ }
  }

  return { active, completed }
}

// ─── Git 变更检测 ────────────────────────────────────────────────

/** 安全执行 git 命令，失败返回空字符串 */
function safeGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT
    })
  } catch (_) {
    return ''
  }
}

/**
 * 获取本次 session 所有变更文件（去重）
 */
function getChangedFiles() {
  const staged = safeGit('diff --cached --name-only').split('\n').filter(Boolean)
  const unstaged = safeGit('diff --name-only').split('\n').filter(Boolean)
  const untracked = safeGit('ls-files --others --exclude-standard').split('\n').filter(Boolean)

  return [...new Set([...staged, ...unstaged, ...untracked])]
}

/** src/ 下是否有变更 */
function hasSrcChanges(files) {
  return files.some(f => {
    const n = f.replace(/\\/g, '/')
    return n.startsWith('src/') && !NON_SRC_PREFIXES.some(p => n.startsWith(p))
  })
}

// ─── 知识库更新 ──────────────────────────────────────────────────

function checkKbUpdateTasks(activeWorkflows, changedFiles) {
  if (!hasSrcChanges(changedFiles)) return []

  return activeWorkflows
    .filter(wf => {
      const dev = wf.state.phases?.['2_development']
      return dev?.status === 'completed'
    })
    .map(wf => ({
      storyId: wf.storyId,
      title: wf.state.title || '',
      reason: wf.state.phases?.['5_git_submit']?.commitHash
        ? `可增量更新 (commit: ${wf.state.phases['5_git_submit'].commitHash})`
        : '开发已完成，知识库未更新'
    }))
}

// ─── Dev-Pass 清理 ───────────────────────────────────────────────

function cleanupDevPasses() {
  if (!fs.existsSync(PLANS_DIR)) return

  const dirs = listStoryDirs()
  const now = new Date()
  let cleaned = 0

  for (const dir of dirs) {
    const fp = path.join(PLANS_DIR, dir, 'dev-pass.json')
    if (!fs.existsSync(fp)) continue
    try {
      const pass = JSON.parse(fs.readFileSync(fp, 'utf-8'))
      if (new Date(pass.expiresAt) < now) {
        fs.unlinkSync(fp)
        cleaned++
      }
    } catch (_) {
      try { fs.unlinkSync(fp); cleaned++ } catch (__) { /* 无法删除，放弃 */ }
    }
  }
  return cleaned
}

// ─── Trace 经验沉淀 ──────────────────────────────────────────────

function recordHookRejectionsFromTraces() {
  if (!fs.existsSync(PLANS_DIR)) return

  const dirs = listStoryDirs()
  let recorded = 0

  for (const dir of dirs) {
    const traceFile = path.join(PLANS_DIR, dir, 'trace.jsonl')
    if (!fs.existsSync(traceFile)) continue

    try {
      const lines = fs.readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'hook_rejection' && entry.recordFailure) {
            experience.recordHookFailure(entry.recordFailure, entry.phase ? parseInt(entry.phase) : -1, dir)
            recorded++
          }
        } catch (_) { /* 单行损坏 */ }
      }
    } catch (_) { /* 文件读取失败 */ }
  }

  return recorded
}

// ─── Harness 自动结束 ────────────────────────────────────────────

/**
 * Stop Hook 自动结束 Harness 模式（harness end）
 *
 * 触发条件：当前激活的 Story（.harness-active 标记）流程已走到最后一步——
 * e2e-state.json 中 status='completed' 且 phase >= 8（终态）。满足即删除
 * .harness-active 标记文件，关闭 Harness 模式，src/ 编辑恢复正常。
 *
 * 演进说明（相对旧逻辑）：
 * 旧逻辑要求「所有活跃工作流都完成」才 end；新逻辑改为「当前激活 Story 走到
 * 终态即 end」——因为 .harness-active 一次只激活一个 Story，它走到 Phase 8
 * 终态即代表本次 Harness 主流程结束。
 *
 * @param {Array} activeWorkflows - 活跃/暂停工作流列表（保留用于提示，不再作为 end 前提）
 * @param {Array} completedWorkflows - 已完成工作流列表
 * @returns {{ ended: boolean, message: string }}
 */
function autoEndHarness(activeWorkflows, completedWorkflows) {
  if (!fs.existsSync(HARNESS_ACTIVE_FILE)) {
    return { ended: false, message: 'Harness 模式未激活' }
  }

  // 读取当前激活的 Story
  let activeStoryId = null
  try {
    const flag = JSON.parse(fs.readFileSync(HARNESS_ACTIVE_FILE, 'utf-8'))
    activeStoryId = flag && flag.active ? flag.storyId : null
  } catch (_) { /* 标记文件损坏，视为无激活 Story */ }

  // 无激活 Story 时回退到旧逻辑（无活跃工作流才关闭）
  if (!activeStoryId) {
    if (activeWorkflows.length > 0) {
      return { ended: false, message: `${activeWorkflows.length} 个活跃工作流，保持 Harness 模式` }
    }
    if (completedWorkflows.length === 0) {
      return { ended: false, message: '无工作流记录，保持 Harness 模式（手动 /harness end）' }
    }
    try {
      fs.unlinkSync(HARNESS_ACTIVE_FILE)
      return {
        ended: true,
        message: `所有工作流已完成 (${completedWorkflows.map(w => w.storyId).join(', ')})，Harness 已自动关闭`
      }
    } catch (e) {
      return { ended: false, message: `标记文件删除失败: ${e.message}` }
    }
  }

  // 有激活 Story：检查它是否已走到最后一步（终态）
  const stateFile = path.join(PLANS_DIR, activeStoryId, 'e2e-state.json')
  if (!fs.existsSync(stateFile)) {
    return { ended: false, message: `激活 Story ${activeStoryId} 无状态文件，保持 Harness 模式` }
  }

  let state
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  } catch (_) {
    return { ended: false, message: `激活 Story ${activeStoryId} 状态损坏，保持 Harness 模式` }
  }

  const isTerminal = state.status === 'completed' && Number(state.phase) >= 8
  if (!isTerminal) {
    return { ended: false, message: `${activeStoryId} 流程未走完最后一步 (phase=${state.phase}, status=${state.status})，保持 Harness 模式` }
  }

  try {
    fs.unlinkSync(HARNESS_ACTIVE_FILE)
    return {
      ended: true,
      message: `${activeStoryId} 已走完最后一步 (Phase ${state.phase})，Harness 模式已自动关闭（harness end）`
    }
  } catch (e) {
    return { ended: false, message: `标记文件删除失败: ${e.message}` }
  }
}

// ─── 摘要构建 ────────────────────────────────────────────────────

function buildSummary(activeWorkflows, completedWorkflows, changedFiles, harnessResult, kbTasks) {
  const allSrcFiles = changedFiles
    .filter(f => f.replace(/\\/g, '/').startsWith('src/'))
    .map(f => f.replace(/\\/g, '/'))

  const srcFiles = allSrcFiles.slice(0, MAX_SRC_FILES)
  const srcOmitted = allSrcFiles.length - srcFiles.length

  return {
    sessionEndedAt: new Date().toISOString(),
    activeWorkflows: activeWorkflows.map(w => ({
      storyId: w.storyId,
      title: w.state.title || '',
      phase: w.state.phase,
      phaseName: getPhaseName(w.state.phase),
      status: w.state.status
    })),
    harness: {
      active: fs.existsSync(HARNESS_ACTIVE_FILE),
      ended: harnessResult.ended,
      message: harnessResult.message
    },
    changedFiles: {
      total: changedFiles.length,
      srcTotal: allSrcFiles.length,
      src: srcFiles,
      ...(srcOmitted > 0 ? { srcOmitted } : {})
    },
    kbUpdateTasks: kbTasks
  }
}

/**
 * 序列化 summary，超过上限时逐级降级，保证不撞 hook 输出截断
 * 降级顺序：完整 → 去掉 src 文件清单 → 只保留核心计数
 * @param {object} summary
 * @returns {string} 保证 length <= MAX_CONTEXT_CHARS 的 JSON 字符串
 */
function serializeSummary(summary) {
  let json = JSON.stringify(summary)
  if (json.length <= MAX_CONTEXT_CHARS) return json

  // 降级 1：丢掉 src 文件清单，保留计数
  const lite = {
    ...summary,
    changedFiles: {
      total: summary.changedFiles.total,
      srcTotal: summary.changedFiles.srcTotal,
      src: [],
      srcOmitted: summary.changedFiles.srcTotal,
      truncated: true
    }
  }
  json = JSON.stringify(lite)
  if (json.length <= MAX_CONTEXT_CHARS) return json

  // 降级 2：只保留核心计数
  return JSON.stringify({
    sessionEndedAt: summary.sessionEndedAt,
    activeWorkflows: summary.activeWorkflows.map(w => ({ storyId: w.storyId, phase: w.phase, status: w.status })),
    harness: summary.harness,
    changedFiles: { total: summary.changedFiles.total, srcTotal: summary.changedFiles.srcTotal, src: [], truncated: true },
    kbUpdateTasks: summary.kbUpdateTasks.map(t => ({ storyId: t.storyId })),
    truncated: true
  }).slice(0, MAX_CONTEXT_CHARS)
}

// ─── 入口 ────────────────────────────────────────────────────────

function main() {
  const startedAt = Date.now()

  // 0. 消费 stdin（避免管道场景 EPIPE），解析 Stop 输入
  let input = {}
  try {
    const raw = readStdin()
    if (raw && raw.trim()) input = JSON.parse(raw)
  } catch (_) { /* stdin 缺失或非法 JSON，按空输入降级 */ }

  // stop_hook_active = true 说明本 hook 已在续跑循环中，直接放行不再做收尾
  if (input.stop_hook_active === true) {
    console.log(JSON.stringify({ continue: true }))
    console.error('[session-stop] stop_hook_active=true, skipped')
    process.exit(0)
  }

  // 1. 单次扫描（替代之前的 findActive + findCompleted 两次扫描）
  const { active, completed } = scanAllWorkflows()

  // 2. 各环节独立执行，互不阻塞
  let changedFiles = []
  try { changedFiles = getChangedFiles() } catch (_) { /* 非 git 仓库 */ }

  let devPassCleaned = 0
  try { devPassCleaned = cleanupDevPasses() } catch (_) { /* 清理失败不阻塞 */ }

  let traceRecorded = 0
  try { traceRecorded = recordHookRejectionsFromTraces() } catch (_) {}

  const harnessResult = autoEndHarness(active, completed)

  const kbTasks = checkKbUpdateTasks(active, changedFiles)

  // 3. 构建输出
  const summary = buildSummary(active, completed, changedFiles, harnessResult, kbTasks)
  const additionalContext = serializeSummary(summary)

  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext
    }
  }

  console.log(JSON.stringify(output))

  // 诊断日志（stderr，不影响 stdout JSON）
  const elapsed = Date.now() - startedAt
  const parts = []
  if (active.length > 0) parts.push(`${active.length} active workflows`)
  if (completed.length > 0) parts.push(`${completed.length} completed`)
  if (devPassCleaned > 0) parts.push(`${devPassCleaned} expired dev-pass cleaned`)
  if (traceRecorded > 0) parts.push(`${traceRecorded} trace rejections recorded`)
  parts.push(`context ${additionalContext.length} chars`)
  parts.push(`took ${elapsed}ms`)
  console.error(`[session-stop] ${parts.join(' | ')}`)

  process.exit(0)
}

main()
