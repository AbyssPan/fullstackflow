#!/usr/bin/env node
/**
 * enforce-dev-pass.js — /harness 模式下按 dev-pass 限域保护 src/ 编辑
 *
 * 职责:
 *   - /harness 模式激活时，拦截对 src/ 文件的写入/编辑，校验 dev-pass.json 是否有效
 *   - dev-pass 有效且声明了 allowedPaths 时，逐个校验目标文件是否落在限域范围内
 *   - 拒绝时写入 trace.jsonl 的 hook_rejection 事件，并携带 recordFailure 结构化失败信息
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: PreToolUse
 *   输入: stdin JSON（{ tool_name, tool_input: { filePath | file_path | command } }）
 *   输出: stdout JSON（放行 { continue: true, hookSpecificOutput.additionalContext }；
 *                      拒绝 { continue: false, stopReason, hookSpecificOutput.permissionDecision: 'deny', recordFailure }）
 *   退出码: 0=放行，2=阻止
 *   手动调试: echo '{"tool_name":"Write","tool_input":{"filePath":"<repo>/src/views/Foo.vue"}}' | node enforce-dev-pass.js
 *
 * 使用场景:
 *   - Agent 在 Phase 2 未签发 dev-pass 时就动手改 src/（例如直接跳到写代码）：
 *     不拦截会让「先规划后编码」的流程约束失效，需求/DAG 未定稿就产生代码，后续返工面极大。
 *   - Agent 编辑 task-dag.json 限域外的文件（顺手改公共组件、改别人的模块、改配置）：
 *     这是经验库里长期占比最高的失败模式（failureType: dev_pass_scope_violation，
 *     具体频次见 failure-patterns.json，不在此写死以免随统计变动而失真）。
 *     越界改动会污染其他任务的代码基线、引入无人审查的隐性缺陷，
 *     且事后难以从一次大 diff 中剥离出哪些改动属于本次 Story。
 *   - dev-pass 已随 Phase 2→3 撤销但 dev-pass.json 残留：
 *     过期凭证若仍被信任，等于任何时刻都能改 src/，限域体系整体失效。
 *
 * 说明:
 *   - 本 Hook 是 PreToolUse 门控链的第 1 道（#2 为 enforce-artifact.js）。
 *   - v5 CCHF 限域逻辑（file-level scope via task-dag.json allowedPaths + 经验采集）：
 *       Normal  → unrestricted（.harness-active 未激活，直接放行）
 *       Harness → check dev-pass:
 *         - invalid             → block + recordFailure
 *         - valid + src/**      → allow (fallback)
 *         - valid + precise     → check file against allowedPaths
 *   - 拦截工具: write_to_file / replace_in_file / apply_patch / Write / Edit；非 src/ 目标直接放行。
 *   - allowedPaths 统一为 { repo, path } 对象数组，按 multi-repo 配置的仓库根解析为绝对路径后匹配；
 *     无通配符的目录型 pattern 按目录前缀匹配，含通配符的 pattern 转为 glob 正则匹配（statSync 失败则降级为正则）。
 *   - dev-pass 撤销双保险: Phase 2→3（主）+ Phase 4→5（兜底）；currentPhase > 2 时即便 dev-pass 文件有效也拒绝。
 *   - 拒绝事件通过 hookSpecificOutput.recordFailure 携带结构化失败信息（failureType / rootCause / resolution），
 *     供 session-stop.js 从 trace.jsonl 读取并沉淀到经验库。
 *   - recordFailure.failureType 取值: dev_pass_missing / dev_pass_expired / dev_pass_scope_violation。
 */
const fs = require('fs')
const path = require('path')
const hookUtils = require('../lib/state')
const { readStdin, isSrcFile, checkDevPass, PLANS_DIR, PROJECT_ROOT } = hookUtils
const trace = require('../lib/trace')

const stdinData = readStdin()
if (!stdinData.trim()) { console.log(JSON.stringify({ continue: true })); process.exit(0) }

let inputData = {}
try { inputData = JSON.parse(stdinData) } catch { console.log(JSON.stringify({ continue: true })); process.exit(0) }

const toolName = inputData.tool_name || ''
const toolInput = inputData.tool_input || {}
const patchPaths = toolName === 'apply_patch'
  ? [...String(toolInput.command || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim())
  : []
const filePaths = patchPaths.length > 0
  ? patchPaths
  : [toolInput.filePath || toolInput.file_path || ''].filter(Boolean)
const srcFilePaths = filePaths.filter(isSrcFile)
const filePath = srcFilePaths[0] || ''

const writeTools = ['write_to_file', 'replace_in_file', 'apply_patch', 'Write', 'Edit']
if (!writeTools.includes(toolName)) { console.log(JSON.stringify({ continue: true })); process.exit(0) }
if (srcFilePaths.length === 0) { console.log(JSON.stringify({ continue: true })); process.exit(0) }

const harnessFlag = path.join(PLANS_DIR, '.harness-active')
let harnessActive = false
if (fs.existsSync(harnessFlag)) {
  try { const flag = JSON.parse(fs.readFileSync(harnessFlag, 'utf-8')); harnessActive = flag.active === true } catch {}
}

if (!harnessActive) {
  console.log(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Normal mode' } }))
  process.exit(0)
}

const devPass = checkDevPass()

if (!devPass.valid) {
  // 写入 trace 记录 Hook 拒绝事件
  trace.appendTrace(null, {
    type: 'hook_rejection',
    result: 'deny',
    reason: 'dev_pass_missing',
    phase: '-1',
    recordFailure: {
      failureType: 'dev_pass_missing',
      rootCause: 'Agent 试图在无 dev-pass 时编辑 src/ 文件: ' + filePath,
      resolution: '必须在 Phase 2 通过 advance-phase.js 签发 dev-pass 后才能编辑 src/。dev-pass 撤销点：Phase 2→3（主）+ Phase 4→5（兜底）'
    }
  })

  console.log(JSON.stringify({
    continue: false,
    stopReason: 'HARNESS MODE - no valid dev-pass. Must advance to Phase 2. dev-pass revoked at Phase 2→3 (primary) and Phase 4→5 (safety net).',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'No valid dev-pass',
      recordFailure: {
        failureType: 'dev_pass_missing',
        rootCause: 'Agent 试图在无 dev-pass 时编辑 src/ 文件: ' + filePath,
        resolution: '必须在 Phase 2 通过 advance-phase.js 签发 dev-pass 后才能编辑 src/'
      }
    }
  }, null, 0))
  process.exit(2)
}

// 🔴 CCHF v5: 即使 dev-pass 文件有效，也需校验当前 phase 是否仍是 Phase 2
// dev-pass 撤销双保险：Phase 2→3（主） + Phase 4→5（兜底）
// Phase 3+ 时 dev-pass 应已失效，但防止过期 dev-pass.json 残留导致非法编辑
var currentPhase = -1
if (devPass.valid && devPass.storyId) {
  try {
    var statePath = path.join(PLANS_DIR, devPass.storyId, 'e2e-state.json')
    if (fs.existsSync(statePath)) {
      var state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      currentPhase = (state.phase !== undefined && state.phase !== null) ? state.phase : -1
    }
  } catch (e) { /* 无法读取 state，降级为仅检查 dev-pass 文件 */ }
}

if (currentPhase > 2) {
  // 写入 trace 记录 Hook 拒绝事件
  trace.appendTrace(devPass.storyId || null, {
    type: 'hook_rejection',
    result: 'deny',
    reason: 'dev_pass_expired',
    phase: String(currentPhase),
    recordFailure: {
      failureType: 'dev_pass_expired',
      rootCause: `Agent 在 Phase ${currentPhase} 试图编辑 src/，dev-pass 仅在 Phase 2 有效`,
      resolution: 'dev-pass 撤销点：Phase 2→3（主）+ Phase 4→5（兜底）。如需编辑请先回到 Phase 2'
    }
  })

  console.log(JSON.stringify({
    continue: false,
    stopReason: `HARNESS MODE - dev-pass expired (current phase=${currentPhase}, dev-pass only valid in Phase 2). Revoked at Phase 2→3 (primary) + Phase 4→5 (safety net).`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'dev-pass expired - not in Phase 2',
      recordFailure: {
        failureType: 'dev_pass_expired',
        rootCause: `Agent 在 Phase ${currentPhase} 试图编辑 src/，dev-pass 仅在 Phase 2 有效`,
        resolution: 'dev-pass 撤销点：Phase 2→3（主）+ Phase 4→5（兜底）。如需编辑请先回到 Phase 2'
      }
    }
  }, null, 0))
  process.exit(2)
}

// --- CCHF v6: multi-repo file-level scope check ---
/**
 * 检查目标文件是否在 dev-pass 允许的路径范围内
 * 统一模式：allowedPatterns 为 { repo, path } 对象数组，按仓库根解析为绝对路径匹配
 * @param {string} targetFile - 目标文件路径（绝对或相对）
 * @param {Array<{repo:string,path:string}>} allowedPatterns - 允许的路径列表
 * @param {Object|string} [reposOrStoryId] - 已加载的 repos 配置 或 storyId（string）
 * @returns {boolean}
 */
function isFileInAllowedPaths(targetFile, allowedPatterns, reposOrStoryId) {
  if (!allowedPatterns || allowedPatterns.length === 0) return false
  var reposConfig
  if (typeof reposOrStoryId === 'string') {
    reposConfig = hookUtils.loadRepos(reposOrStoryId)
  } else if (reposOrStoryId && typeof reposOrStoryId === 'object') {
    reposConfig = reposOrStoryId
  } else {
    reposConfig = hookUtils.loadRepos()
  }
  var absTarget = path.resolve(targetFile).replace(/\\/g, "/")

  for (var i = 0; i < allowedPatterns.length; i++) {
    var p = allowedPatterns[i]
    var repoName, pattern

    // 统一格式：{ repo, path } 对象
    if (typeof p === 'object' && p !== null && p.repo && p.path) {
      repoName = p.repo
      pattern = p.path
    } else if (typeof p === 'string') {
      // 兼容防御：旧格式字符串（统一模式后理论上不应出现，回退到 primary）
      repoName = reposConfig.primary
      pattern = p
    } else {
      continue
    }

    var repoRoot = reposConfig.repos[repoName]
    if (!repoRoot) continue

    // src/** 通配：匹配该仓库 src/ 下任意文件
    if (pattern === 'src/**') {
      var srcDir = path.resolve(repoRoot, 'src').replace(/\\/g, "/") + "/"
      if (absTarget.indexOf(srcDir) === 0) return true
      continue
    }

    // 精确/glob 匹配：按仓库根解析为绝对路径后正则匹配
    var absAllowed = path.resolve(repoRoot, pattern).replace(/\\/g, "/")
    // 目录级限域增强：允许 files 声明「模块目录」而非精确文件。
    //   仅当 pattern 是「无通配符的目录路径」（以 / 结尾，或在磁盘上实际是目录）时，
    //   才按目录前缀匹配该目录下任意层级文件 —— 这样开发在模块目录内新增/修改
    //   符合规范的文件（如新增枚举常量文件）不再被误拦截。
    //   含通配符（** / *）的模式仍走下方 glob 正则转换（如 src/**、src/views/*.vue）。
    var isPlainDirPattern = /\/$/.test(pattern) || pattern === '.'
    if (!isPlainDirPattern && absAllowed !== '') {
      // TOCTOU 保护：existsSync+statSync 间目录可能被删，statSync 失败按非目录降级（走 glob 正则）
      try {
        isPlainDirPattern = fs.statSync(absAllowed).isDirectory()
      } catch (_) { /* 目录不存在或不可访问，非目录模式 */ }
    }
    if (isPlainDirPattern) {
      var dirAbs = /\/$/.test(absAllowed) ? absAllowed : absAllowed + "/"
      if (absTarget.indexOf(dirAbs) === 0) return true
      continue
    }

    // 精确文件或 glob 通配：转换为正则匹配
    var escaped = absAllowed.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    var r = "^" + escaped.replace(/\*\*/g, "__STARSTAR__").replace(/\*/g, "[^/]+").replace(/__STARSTAR__/g, ".*") + "$"
    try { if (new RegExp(r).test(absTarget)) return true } catch {}
  }
  return false
}

var passFile = null
try {
  var pp = path.join(PLANS_DIR, devPass.storyId, "dev-pass.json")
  if (fs.existsSync(pp)) { passFile = JSON.parse(fs.readFileSync(pp, "utf-8")) }
} catch {}

if (passFile && Array.isArray(passFile.allowedPaths) && passFile.allowedPaths.length > 0) {
  const deniedFile = srcFilePaths.find(target => !isFileInAllowedPaths(target, passFile.allowedPaths, devPass.storyId))
  if (deniedFile) {
    // 写入 trace 记录 Hook 拒绝事件
    trace.appendTrace(devPass.storyId || null, {
      type: 'hook_rejection',
      result: 'deny',
      reason: 'dev_pass_scope_violation',
      phase: '2',
      recordFailure: {
        failureType: 'dev_pass_scope_violation',
        rootCause: 'Agent 试图编辑 dev-pass 限域外的文件: ' + deniedFile,
        resolution: '只允许编辑 task-dag.json 中声明的文件，请检查 files 列表'
      }
    })

    console.log(JSON.stringify({
      continue: false,
      stopReason: "File " + deniedFile + " not in dev-pass scope. Allowed: " + passFile.allowedPaths.join(", "),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'File not in dev-pass scope',
        recordFailure: {
          failureType: 'dev_pass_scope_violation',
          rootCause: 'Agent 试图编辑 dev-pass 限域外的文件: ' + deniedFile,
          resolution: '只允许编辑 task-dag.json 中声明的文件，请检查 files 列表'
        }
      }
    }, null, 0))
    process.exit(2)
  }
}

var scope = (passFile && passFile.pathSource === "task-dag.json")
  ? " (scoped: " + passFile.allowedPaths.length + " files)"
  : (passFile && passFile.pathSource === "fallback-src-glob") ? " (fallback src/**)" : ""
console.log(JSON.stringify({
  continue: true,
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: "dev-pass valid" + scope + ": " + devPass.reason }
}, null, 0))
process.exit(0)
