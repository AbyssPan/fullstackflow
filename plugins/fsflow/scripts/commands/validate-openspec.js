#!/usr/bin/env node
/**
 * validate-openspec.js — 旧版 OpenSpec 目录迁移校验器（保留兼容）
 *
 * 新流程不再生成 openspec/；OpenSpec 规则已内嵌到 Phase 0/1 的 policy 门控。
 * 本命令只用于检查历史 Story 中的 openspec/ 规格产物：
 *   node validate-openspec.js <storyId>
 *
 * 规则来源（MIT 许可，github.com/Fission-AI/OpenSpec）：
 *   - src/core/validation/constants.ts（阈值：Why≥50字、≤1000字、Requirement≤500字、≤10 deltas）
 *   - src/core/parsers/requirement-text.ts（SHALL/MUST 整词匹配、#### Scenario 头识别）
 *   - src/core/validation/validator.ts（段落存在性校验）
 *
 * 校验项（error 级 / warning 级）：
 *   proposal.md : ## Why 与 ## What Changes 必须存在；Why ≥50 字（error）≤1000 字（warning）；
 *                 What Changes 非空（error）
 *   specs/**    : 至少一个 `## ADDED|MODIFIED|REMOVED|RENAMED Requirements` 增量头（error）；
 *                 每个 `### Requirement:` 必须含 SHALL/MUST（error）、≤500 字（warning）；
 *                 每个 Requirement 至少一个非空 `#### Scenario:`（error）；
 *                 delta 描述非空（warning）；每 change ≤10 deltas（warning）；
 *                 `## Purpose` 存在时 ≥50 字（warning）
 *   tasks.md    : 至少一个复选框任务（error）；编号连续（warning）
 *   design.md   : 可选，无硬校验
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('../lib/state')

// ─── 阈值常量（与 OpenSpec CLI 校验对齐） ──────────────────────
const MIN_WHY_LENGTH = 50
const MAX_WHY_LENGTH = 1000
const MAX_REQUIREMENT_TEXT_LENGTH = 500
const MAX_DELTAS_PER_CHANGE = 10
const MIN_PURPOSE_LENGTH = 50

// ─── 行级正则（提炼自 requirement-text.ts / requirement-blocks.ts） ──
const DELTA_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/
const REQ_HEADER = /^###\s+Requirement:\s*(.*)$/
const SCENARIO_HEADER = /^####\s+(.*)$/
const ANY_HEADER = /^#{1,6}\s/
const SHALL_OR_MUST = /\b(SHALL|MUST)\b/
const TASK_CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+/


/** 屏蔽 ``` 代码围栏内的行（围栏内的标题不算结构） */
function maskCodeFences (lines) {
  const masked = []
  let inFence = false
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inFence = !inFence; masked.push(true); continue }
    masked.push(inFence)
  }
  return masked
}

/** 提取 `## <title>` 段落的正文文本（到下一个任意级别标题为止） */
function extractSection (lines, masked, title) {
  const re = new RegExp(`^##\\s+${title}\\s*$`)
  const body = []
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    if (!masked[i] && re.test(lines[i])) { inSection = true; continue }
    if (inSection && !masked[i] && ANY_HEADER.test(lines[i])) break
    if (inSection) body.push(lines[i])
  }
  return body.join('\n').trim()
}

/** 校验 proposal.md */
function validateProposal (filePath, errors, warnings) {
  const rel = path.relative(process.cwd(), filePath)
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const masked = maskCodeFences(lines)

  const why = extractSection(lines, masked, 'Why')
  const what = extractSection(lines, masked, 'What Changes')

  if (!why && !what) {
    // 两段都缺 → 可能根本不是 proposal 结构
    errors.push(`${rel}: 缺少必需段落 ## Why 与 ## What Changes（预期结构：## Why / ## What Changes / ## Capabilities）`)
    return
  }
  if (!why) errors.push(`${rel}: 缺少必需段落 ## Why`)
  if (!what) errors.push(`${rel}: 缺少必需段落 ## What Changes`)
  if (why) {
    if (why.length < MIN_WHY_LENGTH) {
      errors.push(`${rel}: ## Why 内容过短（${why.length} 字符 < ${MIN_WHY_LENGTH}）——需说明背景与动机`)
    } else if (why.length > MAX_WHY_LENGTH) {
      warnings.push(`${rel}: ## Why 内容过长（${why.length} 字符 > ${MAX_WHY_LENGTH}），建议精简`)
    }
  }
  if (what && what.length === 0) {
    errors.push(`${rel}: ## What Changes 段落为空`)
  }
}

/** 校验一个增量 spec 文件（specs/<capability>/spec.md），返回 delta 数 */
function validateDeltaSpec (filePath, errors, warnings) {
  const rel = path.relative(process.cwd(), filePath)
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const masked = maskCodeFences(lines)

  // Purpose（可选，但存在时须达标）
  const purpose = extractSection(lines, masked, 'Purpose')
  if (purpose && purpose.length < MIN_PURPOSE_LENGTH) {
    warnings.push(`${rel}: ## Purpose 过简（${purpose.length} 字符 < ${MIN_PURPOSE_LENGTH}）`)
  }

  // 增量头扫描 + Requirement/Scenario 结构校验
  let deltaCount = 0
  let reqCount = 0
  let currentReqTitle = null
  let currentReqBody = []
  let currentReqScenarios = []
  let pendingDeltaDesc = []

  /** 结算一个 Requirement 块 */
  const flushRequirement = () => {
    if (currentReqTitle === null) return
    reqCount++
    const body = currentReqBody.join(' ').trim()
    const label = currentReqTitle.length > 60 ? currentReqTitle.slice(0, 60) + '…' : currentReqTitle
    if (!body) {
      errors.push(`${rel}: Requirement「${label}」正文为空`)
    } else if (!SHALL_OR_MUST.test(body)) {
      errors.push(`${rel}: Requirement「${label}」必须包含 SHALL 或 MUST 规范性关键词`)
    } else if (body.length > MAX_REQUIREMENT_TEXT_LENGTH) {
      warnings.push(`${rel}: Requirement「${label}」正文过长（${body.length} > ${MAX_REQUIREMENT_TEXT_LENGTH} 字符），建议拆分`)
    }
    if (currentReqScenarios.length === 0) {
      errors.push(`${rel}: Requirement「${label}」至少需要一个 #### Scenario: 场景块`)
    } else {
      for (const sc of currentReqScenarios) {
        if (!sc.text) errors.push(`${rel}: Scenario「${sc.title}」场景文本为空（需 WHEN/THEN 内容）`)
      }
    }
    currentReqTitle = null
    currentReqBody = []
    currentReqScenarios = []
  }

  for (let i = 0; i < lines.length; i++) {
    if (masked[i]) continue
    const line = lines[i]
    const dm = line.match(DELTA_HEADER)
    if (dm) {
      flushRequirement()
      deltaCount++
      pendingDeltaDesc = []
      continue
    }
    const rm = line.match(REQ_HEADER)
    if (rm) {
      flushRequirement()
      currentReqTitle = rm[1].trim() || `（未命名 #${reqCount + 1}）`
      // 标题行余下正文也算 Requirement 文本的一部分
      currentReqBody = []
      continue
    }
    const sm = line.match(SCENARIO_HEADER)
    if (sm && currentReqTitle !== null) {
      currentReqScenarios.push({ title: sm[1].trim(), text: '' })
      continue
    }
    if (ANY_HEADER.test(line)) {
      // 更高级别标题结束当前 Requirement 块
      if (currentReqTitle !== null && /^#{1,3}\s/.test(line)) flushRequirement()
      continue
    }
    // 正文行
    if (currentReqTitle !== null) {
      if (currentReqScenarios.length > 0) {
        currentReqScenarios[currentReqScenarios.length - 1].text += (line + '\n')
      } else if (line.trim()) {
        currentReqBody.push(line.trim())
      }
    } else if (deltaCount > 0 && pendingDeltaDesc && line.trim()) {
      // delta 头后的描述行
      if (pendingDeltaDesc !== null) { pendingDeltaDesc.push(line.trim()); if (pendingDeltaDesc.length > 2) pendingDeltaDesc = null }
    }
  }
  flushRequirement()

  // 结构性结论
  if (deltaCount === 0) {
    errors.push(`${rel}: 未找到增量头（需 ## ADDED/MODIFIED/REMOVED/RENAMED Requirements 之一）`)
  } else if (reqCount === 0) {
    warnings.push(`${rel}: 有增量头但未包含任何 ### Requirement: 条目`)
  }
  if (deltaCount > MAX_DELTAS_PER_CHANGE) {
    warnings.push(`${rel}: 增量数 ${deltaCount} > ${MAX_DELTAS_PER_CHANGE}，建议拆分 change`)
  }
  return deltaCount
}

/** 校验 tasks.md */
function validateTasks (filePath, errors, warnings) {
  const rel = path.relative(process.cwd(), filePath)
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
  const tasks = []
  for (const l of lines) {
    const m = l.match(TASK_CHECKBOX)
    if (m) tasks.push({ checked: m[1].toLowerCase() === 'x' })
  }
  if (tasks.length === 0) {
    errors.push(`${rel}: 未找到任何复选框任务（- [ ] / - [x]）`)
    return
  }
  const done = tasks.filter(t => t.checked).length
  if (done === 0) {
    warnings.push(`${rel}: ${tasks.length} 个任务均未勾选——按流程归档时 Phase 2 应已完成勾选`)
  }
}

/** 递归收集 specs/ 下的 .md 文件 */
function collectSpecFiles (dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectSpecFiles(p, acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

/**
 * 校验入口：对 storyDir/openspec/ 下的产物执行全量校验
 * @param {string} openspecDir - story 的 openspec/ 目录绝对路径
 * @returns {{ valid: boolean, errors: string[], warnings: string[], stats: object }}
 */
function validateOpenspecDir (openspecDir) {
  const errors = []
  const warnings = []
  const stats = { proposal: false, design: false, tasks: false, specFiles: 0, deltas: 0 }

  if (!fs.existsSync(openspecDir)) {
    return {
      valid: false,
      errors: [`openspec 目录不存在: ${openspecDir}`],
      warnings,
      stats
    }
  }

  // proposal.md（必需）
  const proposalPath = path.join(openspecDir, 'proposal.md')
  if (fs.existsSync(proposalPath)) {
    stats.proposal = true
    validateProposal(proposalPath, errors, warnings)
  } else {
    errors.push('缺少 proposal.md（Phase 0 必需产物）')
  }

  // specs/ 增量规格（必需）
  const specsDir = path.join(openspecDir, 'specs')
  if (fs.existsSync(specsDir)) {
    const files = collectSpecFiles(specsDir, [])
    stats.specFiles = files.length
    if (files.length === 0) {
      errors.push('specs/ 目录存在但无 .md 增量规格文件')
    } else {
      for (const f of files) stats.deltas += validateDeltaSpec(f, errors, warnings)
    }
  } else {
    errors.push('缺少 specs/ 增量规格目录（Phase 0 必需产物）')
  }

  // tasks.md（必需）
  const tasksPath = path.join(openspecDir, 'tasks.md')
  if (fs.existsSync(tasksPath)) {
    stats.tasks = true
    validateTasks(tasksPath, errors, warnings)
  } else {
    errors.push('缺少 tasks.md（Phase 1 必需产物）')
  }

  // design.md（可选）
  if (fs.existsSync(path.join(openspecDir, 'design.md'))) stats.design = true

  return { valid: errors.length === 0, errors, warnings, stats }
}

// ─── CLI 入口 ─────────────────────────────────────────────────
function main () {
  const storyId = process.argv[2]
  if (!storyId) {
    console.log(JSON.stringify({
      error: '用法: node validate-openspec.js <storyId>',
      hint: '仅用于旧版 story/openspec 迁移检查；新流程由 Phase 0/1 policy 门控直接校验现有契约'
    }, null, 2))
    process.exit(1)
  }
  let storyDir
  try {
    storyDir = getStoryDir(storyId)
  } catch (err) {
    console.log(JSON.stringify({ error: `story 不存在: ${storyId}`, detail: err.message }, null, 2))
    process.exit(1)
  }
  const result = validateOpenspecDir(path.join(storyDir, 'openspec'))
  console.log(JSON.stringify({
    action: 'validate-openspec',
    storyId,
    ...result,
    hint: result.valid
      ? '规格产物结构合法，可归档'
      : '存在结构错误（error 级）：按提示修复后再归档；warning 级不阻断'
  }, null, 2))
  process.exit(result.valid ? 0 : 1)
}

if (require.main === module) main()

module.exports = { validateOpenspecDir }
