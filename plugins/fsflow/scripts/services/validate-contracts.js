#!/usr/bin/env node
/**
 * validate-contracts.js — 契约文件完整性校验（命令行工具，无导出）
 *
 * 职责:
 *   - 按目标 Phase 逐级校验契约文件：Phase 0→1 验收标准与待确认项、Phase 1→2 任务契约与
 *     AC↔Task 交叉引用、Phase 4→5 验收对账
 *   - 汇总 blockers / warnings / details，输出 JSON 结果并以退出码表达成败
 *
 * 用法:
 *   独立执行:
 *     node plugins/fsflow/scripts/services/validate-contracts.js <storyId> <targetPhase>
 *     退出码 0 = pass，1 = 存在 blocker 或状态文件不存在
 *
 * 使用场景:
 *   - 人工诊断：想在不触发 Phase 推进的前提下，单独看某个 Story 的契约是否自洽
 *   - 与生效门控对照：日常推进的门控走 commands/advance-phase.js → policy.runGateCheck，
 *     本脚本不参与生效路径，结果仅作人工参考
 *
 * 说明:
 *   - 本文件无 module.exports，require 会立即执行 CLI 逻辑，只能独立执行、不能被引用
 *   - 参数 targetPhase 是「目标」phase，与 policy.runGateCheck 的「来源」phase 语义不同，切勿混用
 *   - 校验能力全部委托 lib/state.js（checkAcceptanceCriteria / checkOpenQuestions /
 *     checkTaskDagJson / validateContractReferences / checkAcceptanceVerification）
 *
 * @module validate-contracts
 */

const { PROJECT_ROOT, PLANS_DIR, getStoryDir, readStateFile, checkAcceptanceCriteria, checkOpenQuestions, checkTaskDagJson, validateContractReferences, checkAcceptanceVerification, getPhaseName } = require("../lib/state")
const args = process.argv.slice(2)
const storyId = args[0]
const targetPhase = parseInt(args[1])
if (!storyId || isNaN(targetPhase)) { console.error("Usage: node validate-contracts.js <storyId> <targetPhase>"); process.exit(1) }

const blockers = [], warnings = [], details = {}
const state = readStateFile(storyId)
if (!state) { console.log(JSON.stringify({ pass: false, blockers: ["状态文件不存在"] })); process.exit(1) }

function logPhaseCheck(phase, desc, result) {
  details["phase" + phase + "_" + desc] = result
  if (result.errors) for (const e of result.errors) blockers.push("[Phase " + phase + " " + desc + "] " + e)
  if (result.warnings) for (const w of result.warnings) warnings.push("[Phase " + phase + " " + desc + "] " + w)
}

// Phase 0->1: 验收标准 + 待确认项
if (targetPhase >= 1) {
  logPhaseCheck(0, "acceptance-criteria", checkAcceptanceCriteria(storyId))
  logPhaseCheck(0, "open-questions", checkOpenQuestions(storyId))
}

// Phase 1->2: 任务契约 + 交叉引用
if (targetPhase >= 2) {
  logPhaseCheck(1, "task-dag-json", checkTaskDagJson(storyId))
  logPhaseCheck(1, "contract-references", validateContractReferences(storyId))
}

// Phase 4->5: 验收对账
if (targetPhase >= 5) {
  logPhaseCheck(4, "acceptance-verification", checkAcceptanceVerification(storyId))
}

const result = {
  pass: blockers.length === 0,
  storyId,
  targetPhase,
  phaseName: getPhaseName(targetPhase),
  blockers,
  warnings,
  details,
  summary: blockers.length > 0
    ? "FAIL: " + blockers.length + " blockers, " + warnings.length + " warnings"
    : warnings.length > 0
      ? "PASS (with warnings): " + warnings.length + " warnings"
      : "PASS: All contracts valid"
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.pass ? 0 : 1)
