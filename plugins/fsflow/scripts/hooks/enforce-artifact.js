#!/usr/bin/env node
/**
 * enforce-artifact.js — 写入状态文件时校验前置 Phase 产出物，防跳 Phase
 *
 * 职责:
 *   - 拦截针对 .codebuddy/plans/<storyId>/e2e-state.json 的写入/编辑，解析出目标 phase=N
 *   - 逐项检查 Phase 0..N-1 的产出物是否齐全，缺失则 deny 并列出缺失清单
 *   - 拒绝时写入 trace.jsonl 的 hook_rejection 事件，并携带 recordFailure 结构化失败信息
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: PreToolUse
 *   输入: stdin JSON（{ tool_name, tool_input: { filePath | file_path | content | new_str | command } }）
 *   输出: stdout JSON（放行 { continue: true }；拒绝 { continue: false, stopReason, hookSpecificOutput.permissionDecision: 'deny', recordFailure }）
 *   退出码: 0=放行，2=阻止
 *   手动调试: echo '{"tool_name":"Write","tool_input":{"filePath":"<plans>/<storyId>/e2e-state.json","content":"{\\"phase\\":2}"}}' | node enforce-artifact.js
 *
 * 使用场景:
 *   - Agent 在 Phase 0 产出物（requirement-analysis.md）还没落盘时就把状态推进到 Phase 2：
 *     不拦截会让后续 Phase 在缺失需求基线的情况下继续，产出物层层悬空、返工成本极高，
 *     且 e2e-state.json 一旦被写入就形成了「已完成」的假象，难以回溯真实进度。
 *   - Agent 用 replace_in_file 只改一个 phase 字段绕过完整写入检查：
 *     本 Hook 对内容无法解析出 phase 时，会回读磁盘上的现有 phase 并按 phase+1 保守检查，
 *     不拦截等于给跳 Phase 留了一条稳定后门。
 *
 * 说明:
 *   - 本 Hook 是 PreToolUse 门控链的第 2 道（#1 为 enforce-dev-pass.js）。
 *   - 拦截工具: write_to_file / replace_in_file / apply_patch / Write / Edit；其余工具直接放行。
 *   - apply_patch 场景从 command 文本中解析 `*** Add|Update|Delete File:` 路径，再定位状态文件。
 *   - CCHF v2: 单个 Phase 可能声明多个产出物，检查时遍历 checkPhaseArtifact 返回的 missing 数组逐项报告，而非只报第一个。
 *   - 放行策略: 无法判断目标 phase、目标 phase=0（新建状态文件）、前置产出物齐全，均放行——解析失败不阻断正常操作。
 *   - 拒绝时 recordFailure.failureType = 'phase_skip_attempt'，resolution 指向 advance-phase.js 统一推进。
 */

const fs = require('fs')
const path = require('path')
const {
  readStdin,
  isStateFile,
  PLANS_DIR,
  PHASE_SLUGS,
  getPhaseName,
  checkPhaseArtifact
} = require('../lib/state')

const trace = require('../lib/trace')

// ─── Hook 主逻辑 ─────────────────────────────────────────────────

const stdinData = readStdin()

if (!stdinData.trim()) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

let inputData = {}
try {
  inputData = JSON.parse(stdinData)
} catch (e) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

const toolName = inputData.tool_name || ''
const toolInput = inputData.tool_input || {}
const patchText = toolName === 'apply_patch' ? String(toolInput.command || '') : ''
const patchPaths = patchText
  ? [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim())
  : []
const filePath = patchPaths.find(isStateFile) || toolInput.filePath || toolInput.file_path || ''
const fileContent = patchText || toolInput.content || toolInput.new_str || ''

// 只处理文件写入/编辑工具
const writeTools = ['write_to_file', 'replace_in_file', 'apply_patch', 'Write', 'Edit']
if (!writeTools.includes(toolName)) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 检查文件路径是否为 e2e-state.json
if (!isStateFile(filePath)) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 从文件路径提取 storyId（新版: plans/<storyId>/e2e-state.json）
const storyId = path.basename(path.dirname(filePath))

// 尝试从写入内容中解析 phase 值
let targetPhase = null

// 策略1: 直接解析 JSON content（write_to_file 场景）
if (fileContent) {
  try {
    // 对于 replace_in_file，content 可能不是完整 JSON
    // 尝试提取 phase 字段
    const phaseMatch = fileContent.match(/"phase"\s*:\s*(\d+)/)
    if (phaseMatch) {
      targetPhase = parseInt(phaseMatch[1])
    } else {
      // 尝试完整 JSON 解析
      const parsed = JSON.parse(fileContent)
      if (typeof parsed.phase === 'number') {
        targetPhase = parsed.phase
      }
    }
  } catch (e) {
    // 内容不是完整 JSON（可能是 replace_in_file 的 new_str），尝试从文件读取当前 phase
  }
}

// 策略2: 如果无法从内容中解析，读取现有文件的 phase 值
if (targetPhase === null) {
  try {
    const existingPath = filePath
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'))
      // 如果内容中包含 "phase" 字样，说明在修改 phase
      if (fileContent && fileContent.includes('"phase"')) {
        // 无法确定新值，保守策略：读取现有 phase + 1 作为检查目标
        targetPhase = existing.phase + 1
      } else {
        // 没有修改 phase，放行
        console.log(JSON.stringify({ continue: true }))
        process.exit(0)
      }
    } else {
      // 文件不存在，是新建，phase 应该是 0
      targetPhase = 0
    }
  } catch (e) {
    // 无法判断，放行（不阻断正常操作）
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }
}

// ── Phase 0: 新建状态文件，无前置检查 ──
if (targetPhase === 0) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// ── 检查前置 Phase 的产出物 ──
const blockers = []

for (let p = 0; p < targetPhase; p++) {
  const artifact = checkPhaseArtifact(storyId, p)

  if (!artifact.exists) {
    // CCHF v2: 每个 Phase 可能有多个产出物，逐个报告缺失项
    for (const m of artifact.missing) {
      blockers.push(
        `Phase ${p} (${getPhaseName(p)}) 产出物缺失: ${m.description}` +
        (m.fileName ? ` → ${m.fileName}` : '')
      )
    }
  }
}

if (blockers.length > 0) {
  // 写入 trace 记录 Hook 拒绝事件
  trace.appendTrace(storyId, {
    type: 'hook_rejection',
    result: 'deny',
    reason: 'phase_skip_attempt',
    phase: String(targetPhase),
    recordFailure: {
      failureType: 'phase_skip_attempt',
      rootCause: `Agent 试图跳 Phase 将状态推进到 Phase ${targetPhase}，但前置产出物缺失: ${blockers.join('; ')}`,
      resolution: `请先完成前置 Phase 的产出物，或使用 advance-phase.js ${storyId} ${targetPhase} 统一推进`
    }
  })

  const output = {
    continue: false,
    stopReason: [
      `⛔ 无法将状态推进到 Phase ${targetPhase} (${getPhaseName(targetPhase)})`,
      '',
      '以下前置产出物缺失:',
      ...blockers.map((b, i) => `  ${i + 1}. ${b}`),
      '',
      '请先完成对应 Phase 的产出物，或使用 advance-phase.js 统一推进:',
      `  node .codebuddy/scripts/advance-phase.js ${storyId} ${targetPhase}`
    ].join('\n'),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `前置 Phase 产出物检查失败: ${blockers.length} 项缺失`,
      recordFailure: {
        failureType: 'phase_skip_attempt',
        rootCause: `Agent 试图跳 Phase 将状态推进到 Phase ${targetPhase}，但前置产出物缺失: ${blockers.join('; ')}`,
        resolution: `请先完成前置 Phase 的产出物，或使用 advance-phase.js ${storyId} ${targetPhase} 统一推进`
      }
    }
  }

  console.log(JSON.stringify(output, null, 0))
  process.exit(2)
}

// ✅ 所有前置产出物存在 → 放行
console.log(JSON.stringify({ continue: true }))
process.exit(0)
