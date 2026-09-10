#!/usr/bin/env node
/**
 * validate-phase-gate.js — 端到端工作流门控验证脚本（人工诊断工具）
 *
 * ⚠️ 已废弃（DEPRECATED，2026-08-14）—— 本文件不在生效路径上。
 *
 * 真正生效的门控是 services/policy.js 的 runGateCheck，由 advance-phase.js 在每次 Phase 推进时调用。
 * 本文件全仓无任何 .js 调用方，仅可作为人工诊断工具手动执行。
 *
 * 职责:
 *   - 按 PHASE_GATE_CONDITIONS 逐项检查目标 Phase 的前置条件与完成条件
 *   - 输出 JSON 格式的 { pass, blockers, warnings, details }，供人工定位卡点
 *
 * 用法:
 *   独立执行（仅人工诊断）:
 *     node plugins/fullstackflow/scripts/services/validate-phase-gate.js <storyId> <targetPhase>
 *     退出码 0 = pass，1 = 存在 blocker
 *
 * 使用场景:
 *   - 人工诊断尚未迁入 policy.js 的三项检查（保留本文件的唯一价值，勿删）:
 *     checkPrototypeConfirmation（原型确认）、checkStateConsistency（state 与产出物一致性）、
 *     checkBugAnalysisReport（Bug 类 Story 的分析报告）
 *   - 需要离线复核某个 Story 的 Phase 前置条件时手动执行
 *
 * 说明:
 *   - 本文件无 module.exports，require 会立即执行 CLI 逻辑，只能独立执行、不能被引用
 *   - 两者的 phase 编号语义不同，切勿混用:
 *     - policy.runGateCheck(storyId, phaseNum, state) → phaseNum 是「来源」phase（检查 phaseNum → phaseNum+1）
 *     - 本文件 validateGate(storyId, targetPhase)   → targetPhase 是「目标」phase
 *   - 已迁入 policy.js 的检查（此处保留仅为对照）:
 *     - hasFigmaMapIfDesign      → PHASE_ARTIFACTS[1] 的 requiredWhen: hasFigmaDesign
 *     - contractReferencesValid  → checkPhase1Gate / validateContractReferences
 *     - noLintErrors             → checkPhase2Gate（并修正了语义：原本 key 在 target=2，
 *                                  意为「代码还没写就 lint」；现改为 Phase 2→3 增量 lint）
 *     - validateTaskFigmaReferences → checkPhase1Gate（invalidRefs→BLOCKER, unmatched→WARNING）
 *   - 执行时会向 stderr 打印 DEPRECATED 提示与上述语义差异说明
 *
 * @module validate-phase-gate
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  getStoryDir,
  readStateFile,
  isPhaseCompleted,
  getPhaseSlug,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  checkAcceptanceVerification,
  hasFigmaDesign,
  checkFigmaFrameInventory,
  validateTaskFigmaReferences,
  getStoryMode,
  findBugAnalysisReports,
  getPhaseName: getPhaseNameFromUtils
} = require('../lib/state')

/** Phase 门控条件定义 */
const PHASE_GATE_CONDITIONS = {
  0: {
    name: '需求分析',
    description: 'Phase 0 开始无前置条件，但完成需要满足以下条件',
    completionChecks: [
      'hasRequirementDoc',
      'hasAcceptanceCriteriaContract',
      'noPendingConfirmations',
      'userConfirmedPrototype'
    ],
    conditionalChecks: []
  },
  1: {
    name: '任务规划',
    description: 'Phase 1 开始前需要 Phase 0 完成',
    prerequisites: ['phase0Completed'],
    completionChecks: ['hasTaskDAG', 'hasTaskDagJson', 'contractReferencesValid'],
    // frame-inventory 在 Phase 1 产出（任务规划师拆 task 时拉取），与 task 的 figmaNodeId 有效性一并校验
    conditionalChecks: ['hasFigmaFrameInventoryIfDesign', 'figmaNodeIdsValidIfDesign']
  },
  2: {
    name: '代码开发',
    description: 'Phase 2 开始前需要 Phase 1 完成',
    prerequisites: ['phase0Completed', 'phase1Completed'],
    completionChecks: ['noLintErrors'],
    conditionalChecks: []
  },
  3: {
    name: '代码审查',
    description: 'Phase 3 开始前需要 Phase 2 完成',
    prerequisites: ['phase0Completed', 'phase1Completed', 'phase2Completed']
  },
  4: {
    name: '功能测试',
    description: 'Phase 4 开始前需要 Phase 3 通过',
    prerequisites: ['phase0Completed', 'phase1Completed', 'phase2Completed', 'phase3Completed']
  },
  5: {
    name: 'Git提交',
    description: 'Phase 5 开始前需要 Phase 4 通过 + AC 全量验收（CCHF）',
    prerequisites: ['phase0Completed', 'phase1Completed', 'phase2Completed', 'phase3Completed', 'phase4Completed'],
    completionChecks: ['acceptanceVerificationPassed']
  },
  6: {
    name: '知识库更新',
    description: 'Phase 6 开始前需要 Phase 5 完成（建议但不强制阻断部署）',
    prerequisites: ['phase0Completed', 'phase1Completed', 'phase2Completed', 'phase3Completed', 'phase4Completed', 'phase5Completed']
  },
  7: {
    name: '云端部署',
    description: 'Phase 7 开始前需要 Phase 5 完成（Phase 6 失败不阻断）',
    prerequisites: ['phase0Completed', 'phase1Completed', 'phase2Completed', 'phase3Completed', 'phase4Completed', 'phase5Completed']
  }
}

// ─── 检查函数 ──────────────────────────────────────────────────────

/**
 * 读取需求分析文档
 * @param {string} storyId - Story ID
 * @returns {string|null} 文档内容，不存在时返回 null
 */
function readRequirementDoc (storyId) {
  const filePath = path.join(PLANS_DIR, storyId, 'requirement-analysis.md')
  if (!fs.existsSync(filePath)) {
    return null
  }
  return fs.readFileSync(filePath, 'utf-8')
}

/**
 * 检查需求分析文档中是否有未解决的待确认项
 * @param {string} storyId
 * @returns {{ hasPending: boolean, items: string[] }}
 */
function checkPendingConfirmations (storyId) {
  const doc = readRequirementDoc(storyId)
  if (!doc) {
    return { hasPending: true, items: ['需求分析文档不存在'] }
  }

  const items = []

  // 检查文档中的"待确认"标记
  const pendingPatterns = [
    /待确认[项]?\s*[：:]/g,
    /需要确认/g,
    /需确认/g,
    /TAPD 附件.*无法/g,
    /原型.*无法自动抓取/g,
    /请用户确认/g,
    /请用户查看/g
  ]

  for (const pattern of pendingPatterns) {
    const matches = doc.match(pattern)
    if (matches) {
      // 提取匹配行的上下文
      const lines = doc.split('\n')
      for (const line of lines) {
        if (pattern.test(line)) {
          items.push(line.trim().replace(/^[-*]\s*/, ''))
        }
        pattern.lastIndex = 0 // 重置正则的 lastIndex
      }
    }
  }

  // 检查 open-questions.json 中的未解决问题
  const oqCheck = checkOpenQuestions(storyId)
  if (oqCheck.exists && !oqCheck.allResolved) {
    for (const q of oqCheck.unresolved) {
      items.push(`[open-questions.json] ${q.question}`)
    }
  }

  return { hasPending: items.length > 0, items }
}

/**
 * 检查原型/设计稿是否已被用户确认
 * @param {string} storyId
 * @returns {{ confirmed: boolean, reason: string }}
 */
function checkPrototypeConfirmation (storyId) {
  const state = readStateFile(storyId)
  if (!state) {
    return { confirmed: false, reason: '状态文件不存在' }
  }

  // 本 Story 根本不需要原型（fixbugs 模式 / 未提供原型链接）→ 直接放行
  // create-workflow.js 在建流程时按 story-input.json 判定并写入此字段
  if (state.gateChecks?.prototypeRequired === false) {
    return {
      confirmed: true,
      reason: `无原型依赖: ${state.gateChecks.prototypeRequiredReason || '未提供原型/Figma 链接'}`
    }
  }

  // 检查 gateChecks 中是否有 prototypeConfirmed
  if (state.gateChecks?.prototypeConfirmed) {
    return { confirmed: true, reason: '已确认' }
  }

  // 检查需求文档中是否有"原型无法自动抓取"标记
  const doc = readRequirementDoc(storyId)
  if (doc && /原型.*无法自动抓取/.test(doc)) {
    return {
      confirmed: false,
      reason: '需求分析文档标注"原型无法自动抓取"，需要用户手动提供原型截图或文案'
    }
  }

  return { confirmed: true, reason: '无原型依赖或已隐含确认' }
}

/**
 * fixbugs 模式下检查 Phase 0 的 Bug 分析报告
 *
 * 两项检查:
 *   1. 报告必须存在（blocker）—— 否则后续 Phase 拿不到 Bug 事实，
 *      开发工程师只能凭 requirement-analysis.md 的转述猜代码位置。
 *   2. 报告不应包含修复方案（warning）—— 修复设计属于开发工程师。
 *      关键词匹配是启发式的，「根因」段落里出现"建议"类措辞会误报，
 *      因此**只警告不阻断**，由人判断。
 *
 * @param {string} storyId
 * @returns {{ exists: boolean, files: string[], solutionHints: string[] }}
 */
function checkBugAnalysisReport (storyId) {
  const found = findBugAnalysisReports(storyId)
  const solutionHints = []

  // 只扫描标题行 —— 正文里出现"修复"是正常的（如"该 Bug 在 xx 版本已修复"），
  // 而独立的「修复建议 / 解决方案」章节才是越界信号
  const SOLUTION_HEADINGS = /^#{1,6}\s*.*(修复建议|修复方案|解决方案|改造建议|优化建议|测试验证)/

  for (const p of found.paths) {
    let raw
    try {
      raw = fs.readFileSync(p, 'utf-8')
    } catch (e) {
      continue
    }
    const name = path.basename(p)
    for (const line of raw.split(/\r?\n/)) {
      if (SOLUTION_HEADINGS.test(line.trim())) {
        solutionHints.push(`${name}: ${line.trim()}`)
      }
    }
  }

  return { exists: found.exists, files: found.files, solutionHints }
}

/**
 * 检查状态文件是否与 git 变更一致（是否过时）
 * @param {Object} state
 * @returns {{ consistent: boolean, warnings: string[] }}
 */
function checkStateConsistency (state) {
  const warnings = []

  if (!state) {
    return { consistent: false, warnings: ['状态文件不存在'] }
  }

  // 检查 updatedAt 是否过时
  const updatedAt = new Date(state.updatedAt)
  const now = new Date()
  const staleMinutes = (now - updatedAt) / (1000 * 60)

  // 如果 updatedAt 超过 10 分钟且 phase < 实际代码变更状态，说明状态文件没有随开发推进更新
  try {
    const gitDiffStat = execSync('git diff --stat', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()

    if (gitDiffStat && state.phase < 2) {
      warnings.push(
        `状态文件显示 phase=${state.phase}（< 2 开发阶段），但 git 已有未提交的代码变更。` +
        `状态文件可能未随开发推进更新。`
      )
    }
  } catch (e) {
    // git 命令可能失败（如不在 git 仓库中），忽略
  }

  // 检查 phase 与 phases 子状态是否一致
  const phaseNum = state.phase
  const phaseKey = `${phaseNum}_${getPhaseSlug(phaseNum)}`
  const currentPhaseStatus = state.phases?.[phaseKey]?.status

  if (currentPhaseStatus === 'completed' && state.status === 'running') {
    // 当前 phase 已完成但整体状态还是 running，说明应该推进到下一 phase
    warnings.push(
      `Phase ${phaseNum} (${getPhaseSlug(phaseNum)}) 已完成，但整体 phase 未推进。` +
      `应更新 phase 为 ${phaseNum + 1}。`
    )
  }

  return { consistent: warnings.length === 0, warnings }
}

/**
 * 检查是否有 lint 错误
 * @returns {{ hasErrors: boolean, details: string }}
 */
function checkLintErrors () {
  try {
    const result = execSync('npx eslint src/ --format compact 2>&1', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000
    })
    const errorLines = result.split('\n').filter(l => l.includes('error'))
    return {
      hasErrors: errorLines.length > 0,
      details: errorLines.slice(0, 5).join('\n')
    }
  } catch (e) {
    // eslint 可能输出到 stderr
    const output = e.stdout || e.stderr || e.message
    const errorLines = (typeof output === 'string' ? output : '').split('\n').filter(l => l.includes('error'))
    return {
      hasErrors: errorLines.length > 0,
      details: errorLines.slice(0, 5).join('\n')
    }
  }
}

// ─── 主验证逻辑 ──────────────────────────────────────────────────────

/**
 * 执行门控验证
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标推进到的 Phase 编号
 * @returns {Object} 验证结果 { pass, blockers, warnings, details }
 */
function validateGate (storyId, targetPhase) {
  const blockers = []
  const warnings = []
  const details = {}

  const state = readStateFile(storyId)

  // ── 基础检查 ──
  if (!state) {
    blockers.push(`状态文件不存在: .codebuddy/plans/${storyId}/e2e-state.json`)
    return { pass: false, blockers, warnings, details }
  }

  if (state._parseError) {
    blockers.push(`状态文件 JSON 解析失败: ${state._parseError}`)
    return { pass: false, blockers, warnings, details }
  }

  // ── Phase 前置条件检查 ──
  const gateDef = PHASE_GATE_CONDITIONS[targetPhase]
  if (!gateDef) {
    blockers.push(`无效的目标 Phase: ${targetPhase}`)
    return { pass: false, blockers, warnings, details }
  }

  // 检查前置 Phase 是否已完成
  // 注意: 紧邻的前一 Phase 允许 "running"（advance-phase 会将其标记为 completed）
  if (gateDef.prerequisites) {
    for (const prereq of gateDef.prerequisites) {
      const prereqPhase = parseInt(prereq.replace('phase', '').replace('Completed', ''))
      const phaseStatus = state.phases?.[`${prereqPhase}_${getPhaseSlug(prereqPhase)}`]?.status || '未定义'

      // 紧邻的前一 Phase: 允许 running
      if (prereqPhase === targetPhase - 1 && phaseStatus === 'running') {
        continue
      }

      if (phaseStatus !== 'completed') {
        blockers.push(
          `前置条件未满足: Phase ${prereqPhase} (${getPhaseSlug(prereqPhase)}) 未完成。` +
          `当前状态: ${phaseStatus}`
        )
      }
    }
  }

  // ── Phase 0 特殊门控：待确认项检查 ──
  if (targetPhase >= 1) {
    const pendingCheck = checkPendingConfirmations(storyId)
    details.openQuestionsCheck = pendingCheck
    if (pendingCheck.hasPending) {
      blockers.push(
        `Phase 0 有未解决的待确认项 (${pendingCheck.items.length} 项):\n` +
        pendingCheck.items.map((item, i) => `  ${i + 1}. ${item}`).join('\n')
      )
    }
  }

  // ── Phase 0 特殊门控：原型确认 ──
  if (targetPhase >= 1) {
    const protoCheck = checkPrototypeConfirmation(storyId)
    details.prototypeConfirmation = protoCheck
    if (!protoCheck.confirmed) {
      blockers.push(`原型/设计稿未确认: ${protoCheck.reason}`)
    }
  }

  // ── Phase 0 特殊门控：fixbugs 模式必须有 Bug 分析报告 ──
  // 文件名含动态需求标题（{标题}_bug分析报告.md），无法进 PHASE_ARTIFACTS 固定文件名表，故单独校验
  if (targetPhase >= 1 && getStoryMode(storyId) === 'fixbugs') {
    const bugCheck = checkBugAnalysisReport(storyId)
    details.bugAnalysisReport = bugCheck

    if (!bugCheck.exists) {
      blockers.push(
        'fixbugs 模式缺少 Bug 分析报告: 未在 Story 目录找到 *bug分析报告.md。\n' +
        '  需求分析师应在 Phase 0 自行 use_skill("fullstackflow:tapd-bug-analyzer") 产出该报告（记录问题复述/复现步骤/代码定位/根因）'
      )
    } else if (bugCheck.solutionHints.length > 0) {
      // 仅警告: 关键词匹配是启发式的，正常的根因描述也可能命中
      warnings.push(
        `Bug 分析报告疑似包含修复方案章节（应只记录事实，修复设计属于开发工程师）:\n` +
        bugCheck.solutionHints.map(h => `  - ${h}`).join('\n')
      )
    }
  }

  // ── 状态文件一致性检查 ──
  const consistencyCheck = checkStateConsistency(state)
  details.stateConsistency = consistencyCheck
  if (!consistencyCheck.consistent) {
    for (const w of consistencyCheck.warnings) {
      // git 变更警告不阻断 Phase 推进（可能来自其他 Story 的开发）
      if (w.includes('git 已有')) {
        warnings.push(w)
        continue
      }
      if (state.phase < targetPhase) {
        // 如果状态文件 phase 低于目标 phase，这是 blocker
        blockers.push(w)
      } else {
        warnings.push(w)
      }
    }
  }

  // ── Phase 2 完成检查：lint 错误 ──
  if (gateDef.completionChecks?.includes('noLintErrors') && targetPhase === 2) {
    const lintCheck = checkLintErrors()
    details.lintCheck = lintCheck
    if (lintCheck.hasErrors) {
      warnings.push(`ESLint 检测到错误，建议修复后再推进到 Phase 3`)
    }
  }

  // ── 需求分析文档存在性检查 ──
  if (gateDef.completionChecks?.includes('hasRequirementDoc')) {
    const doc = readRequirementDoc(storyId)
    if (!doc) {
      blockers.push('需求分析文档不存在，无法推进 Phase 0 完成')
    }
  }

  // ── 任务 DAG 存在性检查 ──
  if (gateDef.completionChecks?.includes('hasTaskDAG')) {
    const taskDAGPath = path.join(PLANS_DIR, storyId, 'task-dag.md')
    if (!fs.existsSync(taskDAGPath)) {
      blockers.push('任务 DAG 文档不存在，无法推进 Phase 1 完成')
    }
  }

  // ── CCHF: 验收标准契约检查 (Phase 0→1) ──
  if (gateDef.completionChecks?.includes('hasAcceptanceCriteriaContract')) {
    const acCheck = checkAcceptanceCriteria(storyId)
    details.acceptanceCriteria = acCheck
    if (!acCheck.valid) {
      blockers.push(...acCheck.errors.map(e => `[acceptance-criteria.json] ${e}`))
    }
  }

  // ── CCHF: 待确认项契约检查 (Phase 0→1) ──
  // 单一数据源：open-questions.json
  if (gateDef.completionChecks?.includes('noPendingConfirmations')) {
    const oqCheck = checkOpenQuestions(storyId)
    details.openQuestions = oqCheck
    if (oqCheck.exists && !oqCheck.allResolved) {
      blockers.push(...oqCheck.errors.map(e => `[open-questions.json] ${e}`))
    }
  }

  // ── CCHF: 任务 DAG 契约检查 (Phase 1→2) ──
  if (gateDef.completionChecks?.includes('hasTaskDagJson')) {
    const tdjCheck = checkTaskDagJson(storyId)
    details.taskDagJson = tdjCheck
    if (!tdjCheck.valid) {
      blockers.push(...tdjCheck.errors.map(e => `[task-dag.json] ${e}`))
    }
    if (tdjCheck.warnings.length > 0) {
      warnings.push(...tdjCheck.warnings.map(w => `[task-dag.json] ${w}`))
    }
  }

  // ── CCHF: AC↔Task 交叉引用验证 (Phase 1→2) ──
  if (gateDef.completionChecks?.includes('contractReferencesValid')) {
    const refCheck = validateContractReferences(storyId)
    details.contractReferences = refCheck
    if (!refCheck.valid) {
      blockers.push(...refCheck.errors.map(e => `[合同引用] ${e}`))
    }
  }

  // ── CCHF: 验收对账检查 (Phase 4→5) ──
  if (gateDef.completionChecks?.includes('acceptanceVerificationPassed')) {
    const avCheck = checkAcceptanceVerification(storyId)
    details.acceptanceVerification = avCheck
    if (!avCheck.allPassed) {
      blockers.push(...avCheck.errors.map(e => `[acceptance-verification.json] ${e}`))
      if (avCheck.failed.length > 0) {
        blockers.push(
          `${avCheck.failed.length} 条验收标准未通过: ` +
          avCheck.failed.map(f => `${f.id}(${f.status})`).join(', ')
        )
      }
    }
  }

  // 🌐 Figma Frame 清单检查（Phase 0→1，条件性：仅当 hasFigmaDesign=true）
  if (gateDef.conditionalChecks?.includes('hasFigmaFrameInventoryIfDesign')) {
    if (state?.hasFigmaDesign === true) {
      const ffiCheck = checkFigmaFrameInventory(storyId)
      details.figmaFrameInventory = ffiCheck
      if (!ffiCheck.valid) {
        blockers.push(...ffiCheck.errors.map(e => '[figma-frame-inventory.json] ' + e))
      }
    }
  }

  // 🌐 Task Figma nodeId 引用验证（Phase 1→2，条件性：仅当 hasFigmaDesign=true）
  if (gateDef.conditionalChecks?.includes('figmaNodeIdsValidIfDesign')) {
    if (state?.hasFigmaDesign === true) {
      const tfrCheck = validateTaskFigmaReferences(storyId)
      details.taskFigmaReferences = tfrCheck
      if (!tfrCheck.valid) {
        blockers.push(...tfrCheck.errors.map(e => '[figmaNodeId] ' + e))
      }
      if (tfrCheck.unmatched.length > 0) {
        warnings.push(tfrCheck.unmatched.length + ' 个 Vue 组件未绑定 Figma frame，建议补充 figmaNodeId')
      }
    }
  }

  return {
    pass: blockers.length === 0,
    blockers,
    warnings,
    details,
    summary: blockers.length > 0
      ? `❌ 门控验证失败: ${blockers.length} 个阻断项, ${warnings.length} 个警告`
      : warnings.length > 0
        ? `⚠️ 门控验证通过(有警告): ${warnings.length} 个警告`
        : `✅ 门控验证通过: 所有前置条件满足，可以推进到 Phase ${targetPhase}`
  }
}

// ─── CLI 入口 ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const storyId = args[0]
const targetPhase = parseInt(args[1])

if (!storyId || isNaN(targetPhase)) {
  console.error('用法: node validate-phase-gate.js <storyId> <targetPhase>')
  console.error('示例: node validate-phase-gate.js 1138260062001029063 1')
  process.exit(1)
}

console.error('⚠️  DEPRECATED: 本脚本不在生效路径上，结果仅供人工诊断参考。')
console.error('   生效门控 = services/policy.js runGateCheck（由 advance-phase.js 调用）。')
console.error('   注意 phase 语义差异: 本脚本参数是【目标】phase，policy.js 是【来源】phase。')
console.error('   仅以下检查尚未迁入 policy.js: 原型确认 / state 一致性 / Bug 分析报告。')
console.error('')

const result = validateGate(storyId, targetPhase)
console.log(JSON.stringify(result, null, 2))

// 非零退出码表示验证失败，可用于脚本串联
if (!result.pass) {
  process.exit(1)
}
