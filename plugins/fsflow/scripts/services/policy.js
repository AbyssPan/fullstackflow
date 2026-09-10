#!/usr/bin/env node
/**
 * policy.js — 风险门控层 (Policy Runtime)，产出物校验 + 契约一致性 + 恢复建议
 *
 * 职责:
 *   - runGateCheck: 按 Phase 执行门控（产出物存在性 → JSON Schema → Phase 特定契约 → 资源完整性）
 *   - 产出结构化 blocker（携带 failureType），供 experience.js 直接沉淀，无需从文本反推类型
 *   - matchRecoverySuggestion / attemptAutoRecovery: 为 blocker 匹配分级恢复建议并尝试自动修复
 *   - checkContractRegression: 契约回归检查（增量 lint + build）
 *
 * 用法:
 *   作为模块引用:
 *     const { runGateCheck, attemptAutoRecovery } = require('./services/policy')
 *
 * 使用场景:
 *   - commands/advance-phase.js 每次 Phase 推进前调用 runGateCheck 裁定能否推进
 *     （:893 失败时先 attemptAutoRecovery 再重跑，:928 为残余 blocker 取恢复建议）
 *   - commands/dispatch.js 调度前的门控「预检」，仅用于决定该干活还是该修复，
 *     裁定权始终在 advance-phase.js，dispatch 不写状态
 *   - 内部依赖 services/schema-validator.js 做 JSON 产出物的 Schema 校验
 *   - 未登记 failureType 会命中 RECOVERY_SUGGESTIONS.unknown 并产生 warning，提示补录独立条目
 *
 * 说明:
 *   - 三层解耦中的「门控层」——独立于编排逻辑，是推理链条之外不受污染的检查点：
 *     门控层的价值正在于它是整条 agent 推理链条之外的决策节点，不参与推理、不受推理结果影响
 *   - v2.0 结构化 blocker: 每个 blocker 携带 failureType，直接用于经验沉淀；
 *     兜底策略为无匹配类型 → unknown → 自动沉淀 + 人工补录
 *   - 设计原则 (来自腾讯云 MAS Harness 文章): 硬性规则不可绕过（数据访问边界、操作黑名单）；
 *     软性规则触发审批/降级（风险评分、低置信度二次确认）；动态规则来自经验沉淀（历史失败模式）
 *   - RECOVERY_SUGGESTIONS 分 4 级: Level 1 自动修复 / Level 2 提示修复 / Level 3 降级通过 /
 *     Level 4 阻止并人工介入
 *
 * @module policy
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  PLANS_DIR,
  checkPhaseArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  checkAcceptanceVerification,
  validateContractReferences,
  validateTaskFigmaReferences,
  checkFigmaFrameInventory,
  hasFigmaDesign,
  readJsonArtifact,
  getStoryDir,
  getPhaseName,
  loadRepos,
  getRepoRoot,
  structuredError,
  errorToString,
  errorToType
} = require('../lib/state')

const schemaValidator = require('./schema-validator')

// ─── 错误恢复建议表 ─────────────────────────────────────────────

/**
 * 已知错误模式的自动恢复建议
 * Level 1: 自动修复 (可程序化处理)
 * Level 2: 提示修复 (输出具体命令)
 * Level 3: 降级通过 (warning 化)
 * Level 4: 阻止 + 人工介入
 */
const RECOVERY_SUGGESTIONS = {
  // Phase 6→7: 知识库分支尚未留下可审计结果
  phase6_outcome_missing: {
    level: 4,
    action: '执行 Phase 6 知识库分支，并用 trace.js phase-outcome 记录结果',
    autoFixable: false
  },
  // Phase 0→1: open-questions 有 blocking 未解决
  blocking_unresolved: {
    level: 4,
    action: '请用户逐项确认 open-questions 中的 blocking 项并更新 resolved 字段',
    autoFixable: false
  },
  // Phase 0→1: AC 格式错误
  ac_format_error: {
    level: 2,
    action: '检查 acceptance-criteria.json 格式: 顶层应为 {"criteria": [{"id":"AC-1","description":"..."}]}',
    autoFixable: false
  },
  // Phase 0→1: AC 缺少 id 字段
  ac_missing_id: {
    level: 2,
    action: '为每条验收标准添加唯一 id 字段（如 "AC-1"）',
    autoFixable: false
  },
  // Phase 0→1: AC 缺少 description 字段
  ac_missing_description: {
    level: 2,
    action: '为每条验收标准添加 description 字段',
    autoFixable: false
  },
  // Phase 0→1: AC criteria 数组为空
  ac_empty_criteria: {
    level: 2,
    action: 'acceptance-criteria.json 的 criteria 数组至少需要 1 条验收标准',
    autoFixable: false
  },
  // Phase 0→1: AC 重复 ID
  ac_duplicate_id: {
    level: 2,
    action: '验收标准 ID 必须唯一，请检查并修正重复 ID',
    autoFixable: false
  },
  // Phase 0→1: open-questions 有未解决项
  open_questions_unresolved: {
    level: 3,
    action: '逐项确认 open-questions 中的问题并更新 resolved 字段',
    autoFixable: false
  },
  // Phase 1→2: Figma frame 缺少 id/name/link/type
  figma_frame_incomplete: {
    level: 2,
    action: '每个 Figma frame 必须有 id、name、link 字段',
    autoFixable: false
  },
  // Phase 1→2: task-dag 字段名错误 (name→title)
  task_field_name: {
    level: 1,
    action: 'task-dag.json 中应使用 "title" 而非 "name"',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'task-dag.json')
      if (!data || !Array.isArray(data.tasks)) return false
      let fixed = false
      for (const t of data.tasks) {
        if (t.name && !t.title) { t.title = t.name; delete t.name; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'task-dag.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
  },
  // Phase 1→2: task 缺少 id
  task_missing_id: {
    level: 2,
    action: '为每个 task 添加唯一 id 字段',
    autoFixable: false
  },
  // Phase 1→2: task 缺少 title
  task_missing_title: {
    level: 1,
    action: '为每个 task 添加 title 字段（使用 title 而非 name）',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'task-dag.json')
      if (!data || !Array.isArray(data.tasks)) return false
      let fixed = false
      for (const t of data.tasks) {
        if (t.name && !t.title) { t.title = t.name; delete t.name; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'task-dag.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
  },
  // Phase 1→2: 跨项目 task description 缺少行号引用
  task_missing_line_ref: {
    level: 2,
    action: '跨项目 task（有 project 字段）的 description 必须包含行号引用（如 L123 或 line 45），便于定位代码改动点。请检查 task-dag.json 中跨项目 task 的 description 并补充行号。',
    autoFixable: false
  },
  // Phase 1→2: acceptanceCriteria 空数组
  empty_ac_ref: {
    level: 2,
    action: 'task-dag.json 中每个 task 的 acceptanceCriteria 不能为空数组，至少引用 1 条 AC',
    autoFixable: false
  },
  // Phase 1→2: task 重复 ID
  task_duplicate_id: {
    level: 2,
    action: 'Task ID 必须唯一，请检查并修正重复 ID',
    autoFixable: false
  },
  // Phase 1→2: AC↔Task 交叉引用 - 孤立 AC
  orphan_ac: {
    level: 2,
    action: '每条验收标准至少被 1 个 Task 引用，请检查 task-dag.json 的 acceptanceCriteria',
    autoFixable: false
  },
  // Phase 1→2: AC↔Task 交叉引用 - 引用不存在的 AC
  invalid_ac_ref: {
    level: 2,
    action: 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在',
    autoFixable: false
  },
  // Phase 0→1: PRD 功能点未全部落到 AC 上
  prd_coverage_missing: {
    level: 2,
    action: '在 acceptance-criteria.json 的 featurePoints 中逐条声明功能点覆盖情况（covered+acIds 或 deferred+deferredReason）',
    autoFixable: false
  },
  // Phase 0→1: 内嵌 OpenSpec 规格质量（不依赖 openspec/ 目录）
  spec_requirement_non_normative: {
    level: 2,
    action: '将 AC description 改写为含 SHALL/MUST/必须/不得/应当 的规范性 Requirement',
    autoFixable: false
  },
  spec_scenario_incomplete: {
    level: 2,
    action: '为每条 AC 补全非空 given/when/then 场景',
    autoFixable: false
  },
  spec_capability_missing: {
    level: 2,
    action: '为每条 AC 声明 capability，并用 changeType 标记 added/modified/removed',
    autoFixable: false
  },
  spec_context_incomplete: {
    level: 2,
    action: '在 requirement-analysis.md 的 Grill 决策摘要中补全目标、非目标、关键决策、Capabilities 和风险',
    autoFixable: false
  },
  // Phase 1→2: Task 引用的 figmaNodeId 不在 figma-frame-inventory.json 中
  invalid_figma_ref: {
    level: 2,
    action: 'Task 的 figmaNodeId 必须存在于 figma-frame-inventory.json 的 frames 中',
    autoFixable: false
  },
  // Phase 4→5: UI 交互型 AC 仅凭代码审读判 passed
  static_evidence_for_ui_ac: {
    level: 2,
    action: '交互型 AC 必须有运行时证据（Playwright 实跑或人工点验），给不出就把 status 改为 unverifiable，不允许用代码审读冒充通过',
    autoFixable: false
  },
  // Phase 4→5: code-review 未修复项与验收结论自相矛盾
  review_acceptance_conflict: {
    level: 2,
    action: '修复该审查问题（status→fixed），或把对应 AC 从 passed 改为 failed 并走修复回路 —— 不允许"问题未修 + AC 通过"并存',
    autoFixable: false
  },
  // Phase 2→3: 变更文件存在 lint error
  lint_error: {
    level: 2,
    action: '修复本次变更文件的 lint error（门控只 lint 变更文件，不含存量问题）',
    autoFixable: false
  },
  // Phase 2→3: 本地编译失败
  build_failed: {
    level: 2,
    action: '本地复现并修复编译错误（SCSS/模板/语法），不要把编译问题留给云端构建',
    autoFixable: false
  },
  // Phase 3→4: code-review 含 BLOCKER 关键词
  code_review_blocker: {
    level: 2,
    action: '执行修复回路将问题回退给全栈开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 3→4: code-review.json 不存在
  code_review_missing: {
    level: 4,
    action: '需先 spawn 代码审查师 (code-reviewer) 产出 code-review.json',
    autoFixable: false
  },
  // Phase 4→5: evidence 字符串→数组
  evidence_not_array: {
    level: 1,
    action: 'acceptance-verification.json 中 evidence 应为字符串数组',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'acceptance-verification.json')
      if (!data || !Array.isArray(data.results)) return false
      let fixed = false
      // 修复字段名: verificationResults → results, acId → id
      if (data.verificationResults && !data.results) {
        data.results = data.verificationResults; delete data.verificationResults; fixed = true
      }
      if (!Array.isArray(data.results)) return false
      for (const r of data.results) {
        if (r.acId && !r.id) { r.id = r.acId; delete r.acId; fixed = true }
        if (typeof r.evidence === 'string') { r.evidence = [r.evidence]; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'acceptance-verification.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
  },
  // Phase 4→5: AC 验收未通过
  ac_verification_failed: {
    level: 2,
    action: '验收标准未通过，执行修复回路将问题回退给全栈开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 4→5: AC 缺少验收结果
  ac_missing_verification: {
    level: 4,
    action: '每条验收标准必须有对应的验收结果',
    autoFixable: false
  },
  // Phase 4→5: AV 缺少 id 字段
  av_missing_id: {
    level: 2,
    action: 'acceptance-verification.json 每条 result 必须有 id 字段',
    autoFixable: false
  },
  // Phase 4→5: AV 缺少 evidence
  av_missing_evidence: {
    level: 2,
    action: 'acceptance-verification.json 每条 result 必须有 evidence 数组',
    autoFixable: false
  },
  // 产出物缺失
  artifact_missing: {
    level: 4,
    action: '请先完成对应 Phase 的产出物',
    autoFixable: false
  },
  // Phase 3/4 修复回路：代码审查发现 BLOCKER → 回退 Phase 2
  fix_loop_code_review: {
    level: 2,
    action: '代码审查发现 BLOCKER，执行修复回路回退到 Phase 2 由全栈开发工程师修复',
    autoFixable: false,
    resolution: 'node advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 3/4 修复回路：功能测试失败 → 回退 Phase 2
  fix_loop_test_failed: {
    level: 2,
    action: '功能测试未通过，执行修复回路回退到 Phase 2 由全栈开发工程师修复',
    autoFixable: false,
    resolution: 'node advance-phase.js <storyId> 2 --fix-loop'
  },
  // 修复回路耗尽：已达最大轮次（按失败源独立预算：code-review 与 test 各 2 次）
  fix_loop_exhausted: {
    level: 4,
    action: '已达当前失败源的最大修复轮次 (代码审查 2 次 / 功能测试 2 次，独立计数)，需人工介入：1)人工评审剩余BLOCKER 2)联系需求分析师确认AC 3)联系任务规划师重新拆解',
    autoFixable: false
  },
  // JSON 产出物解析失败（语法错误）
  json_parse_error: {
    level: 2,
    action: 'JSON 产出物语法错误，请检查括号/逗号/引号是否闭合，可用 node -e "JSON.parse(require(\'fs\').readFileSync(\'<file>\',\'utf-8\'))" 定位',
    autoFixable: false
  },
  // 兜底：未归类的失败模式
  // 注意：命中此项说明有 failureType 未登记，应分析后补充为独立条目
  unknown: {
    level: 3,
    action: '未归类的门控失败：请阅读 blocker message 手工处理，并将此错误模式补充到 policy.js 的 RECOVERY_SUGGESTIONS 中',
    autoFixable: false
  }
}

/**
 * 根据 blocker 的 failureType 匹配恢复建议
 * v2: 优先用结构化 blocker 的 type 字段精确匹配，兼容旧的纯字符串关键词匹配
 * @param {{ type: string, message: string }|string} blocker - 结构化 blocker 或纯字符串
 * @returns {{ level: number, action: string, autoFixable: boolean, autoFix?: Function }} 永不为 null，最差返回 RECOVERY_SUGGESTIONS.unknown
 */
function matchRecoverySuggestion (blocker) {
  // 结构化 blocker: 直接用 type 字段精确匹配
  const failureType = errorToType(blocker)
  if (failureType !== 'unknown' && RECOVERY_SUGGESTIONS[failureType]) {
    return RECOVERY_SUGGESTIONS[failureType]
  }

  // 兜底兼容: 纯字符串 blocker 的关键词匹配（保留旧逻辑）
  const lower = errorToString(blocker).toLowerCase()
  if (lower.includes('阻塞级待确认') || lower.includes('blocking')) return RECOVERY_SUGGESTIONS.blocking_unresolved
  if (lower.includes('acceptance-criteria') && lower.includes('缺少')) return RECOVERY_SUGGESTIONS.ac_format_error
  if (lower.includes('缺少 title') || lower.includes('"name"')) return RECOVERY_SUGGESTIONS.task_field_name
  if (lower.includes('evidence')) return RECOVERY_SUGGESTIONS.evidence_not_array
  if (lower.includes('blocker')) return RECOVERY_SUGGESTIONS.code_review_blocker
  if (lower.includes('acceptancecriteria') && lower.includes('空')) return RECOVERY_SUGGESTIONS.empty_ac_ref
  if (lower.includes('行号引用') || lower.includes('line 45') || lower.includes('l123')) return RECOVERY_SUGGESTIONS.task_missing_line_ref

  // 类型未登记且关键词未命中 → 返回显式 unknown 条目（而非 null），
  // 保证每个 blocker 都带 level-3 恢复建议，并提示将该模式补录为独立条目
  return RECOVERY_SUGGESTIONS.unknown
}

// ─── 门控校验主函数 ─────────────────────────────────────────────

/**
 * 执行指定 Phase 的门控校验
 * v2: blockers 为结构化对象数组，每个携带 failureType
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - 要检查的 Phase 编号
 * @param {Object} state - e2e-state.json 状态对象
 * @returns {{ passed: boolean, blockers: Array<{type:string,message:string,level:number,resolution:string}>, warnings: string[], recoveries: Array }}
 */
function runGateCheck (storyId, phaseNum, state) {
  const result = { passed: true, blockers: [], warnings: [], recoveries: [], _meta: {} }

  if (phaseNum < 0) return result // Phase 0 无前置

  // review-only 是用户在 story-input.json 中显式选择的快速通道。
  // 仅跳过独立功能测试 Phase，不改变代码审查、lint/编译或项目 git hook。
  if (phaseNum === 4 && state && state.verificationMode === 'review-only') {
    result.warnings.push('verificationMode=review-only：已按显式配置跳过独立功能测试 Phase')
    result._meta.skipped = true
    result._meta.skipReason = 'verification_mode_review_only'
    return result
  }

  // 1. 产出物存在性检查（传入 state 以启用条件必需产出物，如 hasFigmaDesign 时的 figma-frame-inventory.json）
  const artifact = checkPhaseArtifact(storyId, phaseNum, state)
  if (!artifact.exists) {
    for (const m of artifact.missing) {
      const blocker = structuredError(
        'artifact_missing',
        `Phase ${phaseNum}(${getPhaseName(phaseNum)}) 产出物缺失: ${m.description} (${m.fileName})`,
        4,
        `请先完成 Phase ${phaseNum} 的产出物 ${m.fileName}`
      )
      result.blockers.push(blocker)
      const suggestion = matchRecoverySuggestion(blocker)
      if (suggestion) result.recoveries.push({ blocker, suggestion })
    }
    result.passed = false
  }

  // 1.5. 🆕 JSON Schema 校验（产出物存在时，校验格式是否符合 schema）
  const jsonArtifacts = schemaValidator.getPhaseArtifacts(phaseNum)
  if (jsonArtifacts.length > 0) {
    for (const fileName of jsonArtifacts) {
      const schemaResult = schemaValidator.validateArtifact(storyId, fileName)
      if (!schemaResult.valid) {
        for (const err of schemaResult.errors) {
          result.blockers.push(structuredError(
            'schema_validation_failed',
            `Schema 校验失败: ${err}`,
            2,
            `请检查 ${fileName} 格式是否符合规范，参考 schemas/ 目录下的 schema 定义`
          ))
        }
        result.passed = false
      }
    }
  }

  // 2. Phase 特定契约检查
  if (phaseNum === 0) {
    checkPhase0Gate(storyId, state, result)
  } else if (phaseNum === 1) {
    checkPhase1Gate(storyId, state, result)
  } else if (phaseNum === 2) {
    checkPhase2Gate(storyId, state, result)
  } else if (phaseNum === 3) {
    checkPhase3Gate(storyId, result)
  } else if (phaseNum === 4) {
    checkPhase4Gate(storyId, result)
  } else if (phaseNum === 6) {
    checkPhase6Gate(storyId, result)
  }

  // 2.5. 🆕 资源完整性检查（声明了外部依赖但未有效消费）
  // 检查时机：Phase 2 开发完成后（进入 Phase 3 审查前），验证开发阶段是否真的消费了
  // 声明的 Figma 设计稿 / 知识库等资源。这是「声明-消费一致性」在门控层的落地。
  checkResourceIntegrity(storyId, phaseNum, state, result)

  // 3. 为未匹配恢复建议的 blocker 补充兜底 recoveries
  for (const blocker of result.blockers) {
    const existingRecovery = result.recoveries.find(r =>
      (typeof r.blocker === 'object' && r.blocker === blocker) ||
      (typeof r.blocker === 'string' && r.blocker === errorToString(blocker))
    )
    if (!existingRecovery) {
      // matchRecoverySuggestion 永不返回 null（未登记类型 → RECOVERY_SUGGESTIONS.unknown，level 3）
      const suggestion = matchRecoverySuggestion(blocker)
      result.recoveries.push({ blocker, suggestion })
      if (suggestion === RECOVERY_SUGGESTIONS.unknown) {
        // 显式告警：出现未登记的 failureType，应补录为独立条目
        result.warnings.push(`未归类的失败模式 (failureType: ${errorToType(blocker)})，建议补充到 policy.js 的 RECOVERY_SUGGESTIONS`)
      }
    }
  }

  return result
}

/**
 * 资源完整性检查 —— 声明了外部依赖但未有效消费
 *
 * 这是「声明-消费一致性」在门控层的落地。
 *
 * 注意：Figma MCP 消费检查已移除 —— 由于 Figma 由子 Agent 调用，
 * 其 tool_call 不会写入主流程的 trace.jsonl，无法据此判定是否真实消费，
 * 因此不再拦截（Figma 设计还原仍由 Phase 0/1 的 frame inventory 与
 * figmaNodeId 契约门控兜底）。
 *
 * 判定依据（v2 证据链）：
 *   - kb-query / graphify 调用为 0 → WARNING（放行但记 debt，Evo Score 扣分）
 *
 * 检查时机：仅在 phaseNum === 3（即 Phase 3→4 门控，代码审查完成、准备进入功能测试前）时执行。
 * 此时 Phase 2 开发阶段已全部结束，trace.jsonl 的开发 tool_call 记录最完整，判定最可靠。
 * 早期阶段（phaseNum < 3）开发尚未完成，trace 不完整；后期阶段（phaseNum > 3）已过功能测试，无需重复。
 *
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - 要推进到的 Phase 编号（来源 phase）
 * @param {Object} state - e2e-state.json 状态对象
 * @param {Object} result - 门控结果对象（会原地写入 blockers / warnings）
 * @returns {void}
 */
function checkResourceIntegrity (storyId, phaseNum, state, result) {
  // 仅在 Phase 3→4 门控时检查（此时 Phase 2 开发 trace 完整；phaseNum 是来源 phase）
  if (phaseNum !== 3) return

  // 读 trace.jsonl 里的 tool_call 事件
  const traceFile = path.join(getStoryDir(storyId), 'trace.jsonl')
  let toolCalls = []
  if (fs.existsSync(traceFile)) {
    try {
      const lines = fs.readFileSync(traceFile, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e.type === 'tool_call') toolCalls.push(e)
        } catch (_) { /* 单行损坏，跳过 */ }
      }
    } catch (_) { /* 读取失败按无记录处理 */ }
  }

  // 知识库消费检查（软性资源 → WARNING，放行但记 debt）
  const kbCalls = toolCalls.filter(e => e.skill === 'kb-query' || e.skill === 'graphify')
  if (kbCalls.length === 0) {
    result.warnings.push('本 Story 开发阶段未调用 kb-query / graphify 做知识库检索，注入的历史教训可能未被查证（记 debt，Evo Score 扣分）')
  }
}

/**
 * Phase 0→1 门控: AC + 内嵌 OpenSpec 规格质量 + open-questions + PRD 覆盖率
 * （Figma frame-inventory 不在此校验 —— frame-inventory 由 Phase 1 任务规划师拆 task 时产出，
 *   完整性与 nodeId 引用在 Phase 1→2 门控 checkPhase1Gate 校验）
 */
function checkPhase0Gate (storyId, state, result) {
  // 验收标准 — 将 errors 字符串转为结构化 blocker
  // 注意：acceptance-criteria.json 的文件存在性已由 checkPhaseArtifact 覆盖，
  //       此处 checkAcceptanceCriteria 返回 exists=false 时不重复记录，只处理内容错误
  const acCheck = checkAcceptanceCriteria(storyId)
  if (acCheck.exists && !acCheck.valid) {
    for (const e of acCheck.errors) {
      // 从 error 文本推断 failureType
      const lower = String(e).toLowerCase()
      let type = 'ac_format_error'
      let level = 2
      let resolution = '检查 acceptance-criteria.json 格式'

      if (lower.includes('缺少 id') || lower.includes('缺少id')) {
        type = 'ac_missing_id'
        resolution = '为每条验收标准添加唯一 id 字段'
      } else if (lower.includes('缺少 description') || lower.includes('缺少description')) {
        type = 'ac_missing_description'
        resolution = '为每条验收标准添加 description 字段'
      } else if (lower.includes('为空') || lower.includes('至少')) {
        type = 'ac_empty_criteria'
        resolution = 'criteria 数组至少需要 1 条验收标准'
      } else if (lower.includes('重复') && lower.includes('id')) {
        type = 'ac_duplicate_id'
        resolution = '验收标准 ID 必须唯一，请检查并修正重复 ID'
      } else if (lower.includes('不存在')) {
        type = 'ac_format_error'
        level = 4
        resolution = 'acceptance-criteria.json 文件不存在，请先产出此文件'
      } else if (lower.includes('解析失败')) {
        type = 'ac_format_error'
        resolution = 'JSON 格式错误，请检查文件内容'
      }

      const blocker = structuredError(type, String(e), level, resolution)
      result.blockers.push(blocker)
      result.passed = false
    }
  }

  // OpenSpec 的核心价值直接落在现有契约上，不要求生成 openspec/ 镜像文件：
  // capability + delta(changeType) + normative Requirement + Given/When/Then Scenario。
  checkEmbeddedSpecQuality(storyId, result)

  // 待确认项 — 单一数据源：open-questions.json
  const oqCheck = checkOpenQuestions(storyId)
  const oqUnresolved = oqCheck.exists ? oqCheck.unresolved.length : 0
  const oqBlocking = oqCheck.exists ? oqCheck.unresolved.filter(q => q.blocking).length : 0

  if (oqBlocking > 0) {
    const blocker = structuredError(
      'blocking_unresolved',
      `${oqBlocking} 项阻塞级待确认问题未解决 (open-questions: ${oqBlocking})`,
      4,
      '请用户逐项确认 open-questions 中的 blocking 项'
    )
    result.blockers.push(blocker)
    result.passed = false
  } else if (oqUnresolved > 0) {
    result.warnings.push(`${oqUnresolved} 项待确认问题未解决但无阻塞级`)
  }

  // Figma frame inventory 不在 Phase 0→1 校验 —— frame-inventory 由 Phase 1 任务规划师拆 task 时产出，
  // 完整性在 Phase 1→2 门控（checkPhase1Gate 的 validateTaskFigmaReferences + 产出物存在性）校验。

  // PRD 功能点 → AC 覆盖率校验（run 模式）
  checkPrdCoverage(storyId, result)
}

/**
 * 将 OpenSpec 的质量约束嵌入长期使用的现有产物。
 * openspec/ 目录不是输入也不是门控项，避免与 AC / task-dag 形成双份真相。
 */
function checkEmbeddedSpecQuality (storyId, result) {
  const ac = readJsonArtifact(storyId, 'acceptance-criteria.json')
  if (ac && !ac._parseError && Array.isArray(ac.criteria)) {
    for (let i = 0; i < ac.criteria.length; i++) {
      const criterion = ac.criteria[i]
      const tag = criterion.id || `AC[${i}]`
      if (!criterion.capability || !String(criterion.capability).trim() ||
          !['added', 'modified', 'removed'].includes(criterion.changeType)) {
        result.blockers.push(structuredError(
          'spec_capability_missing',
          `${tag} 缺少有效 capability/changeType（changeType 仅支持 added/modified/removed）`,
          2,
          '为 AC 声明能力域 capability 与增量类型 changeType'
        ))
        result.passed = false
      }

      const description = String(criterion.description || '')
      if (!/(?:\bSHALL\b|\bMUST\b|必须|不得|应当)/i.test(description)) {
        result.blockers.push(structuredError(
          'spec_requirement_non_normative',
          `${tag} description 不是规范性 Requirement：缺少 SHALL/MUST/必须/不得/应当`,
          2,
          '用明确的强制性措辞改写验收要求，避免“支持、优化、处理”等不可裁定表达'
        ))
        result.passed = false
      }

      const missingScenario = ['given', 'when', 'then'].filter(key =>
        !criterion[key] || !String(criterion[key]).trim()
      )
      if (missingScenario.length > 0) {
        result.blockers.push(structuredError(
          'spec_scenario_incomplete',
          `${tag} Scenario 不完整：缺少 ${missingScenario.join('/')}`,
          2,
          '每条 AC 必须给出非空 given/when/then，确保能够直接转成测试'
        ))
        result.passed = false
      }
    }
  }

  const analysisPath = path.join(getStoryDir(storyId), 'requirement-analysis.md')
  if (!fs.existsSync(analysisPath)) return
  const analysis = fs.readFileSync(analysisPath, 'utf-8')
  const requiredSections = [
    ['Grill 决策摘要', /Grill\s*决策摘要/i],
    ['目标', /#{2,6}\s*(?:目标|Goals?)/i],
    ['非目标', /#{2,6}\s*(?:非目标|Non[- ]?Goals?)/i],
    ['关键决策', /#{2,6}\s*(?:关键决策|Decisions?)/i],
    ['Capabilities', /#{2,6}\s*(?:Capabilities|能力(?:域)?拆分)/i],
    ['风险', /#{2,6}\s*(?:遗留)?风险/i]
  ]
  const missing = requiredSections.filter(([, pattern]) => !pattern.test(analysis)).map(([name]) => name)
  if (missing.length > 0) {
    result.blockers.push(structuredError(
      'spec_context_incomplete',
      `requirement-analysis.md 缺少规格决策上下文：${missing.join('、')}`,
      2,
      '在 Grill 决策摘要中补全 Why/Non-Goals/Decisions/Capabilities/Risks 对应小节'
    ))
    result.passed = false
  }
}

/**
 * Phase 0→1: PRD 功能点覆盖率校验
 *
 * 历史缺陷: 门控只能校验"已写下的 AC 是否格式合规"，无法发现"整条功能压根没进 AC"。
 *   TrainWeChatStore 有 3 个交付文档里的功能点从未变成 AC，14 条 AC 全绿而功能缺失。
 *
 * 解法: 让需求分析师在 acceptance-criteria.json 里额外枚举 featurePoints
 *   （功能点 → covered+acIds / deferred+deferredReason）。
 *   枚举是 LLM 的活，校验映射完整性是程序的活 —— 程序不去猜 PRD 里有什么，
 *   只保证"凡是被枚举出来的功能点，都必须明确落到 AC 或明确写下不做的原因"。
 *   fixbugs 模式不要求（Bug 修复没有 PRD 功能点可枚举）。
 */
function checkPrdCoverage (storyId, result) {
  const input = readJsonArtifact(storyId, 'story-input.json')
  // 读不到 input 时不阻塞（老 Story 或输入缺失，另有门控覆盖）
  if (!input || input._parseError || input.mode !== 'run') return

  const ac = readJsonArtifact(storyId, 'acceptance-criteria.json')
  if (!ac || ac._parseError) return

  const fps = ac.featurePoints
  if (!Array.isArray(fps) || fps.length === 0) {
    result.blockers.push(structuredError(
      'prd_coverage_missing',
      'acceptance-criteria.json 缺少 featurePoints：run 模式必须枚举需求文档/原型中的功能点并逐条声明 AC 覆盖情况',
      2,
      '在 acceptance-criteria.json 增加 featurePoints 数组，每项 { id: "FP-N", source, coverage: "covered"|"deferred", acIds | deferredReason }'
    ))
    result.passed = false
    return
  }

  const acIds = new Set((ac.criteria || []).map(c => c.id).filter(Boolean))
  for (const fp of fps) {
    const tag = fp.id || '(缺少 id)'
    if (fp.coverage === 'deferred') {
      if (!fp.deferredReason || !String(fp.deferredReason).trim()) {
        result.blockers.push(structuredError(
          'prd_coverage_missing',
          `功能点 ${tag} 标记为 deferred 但未写 deferredReason: ${fp.source || ''}`,
          2,
          '本次不做的功能点必须写明原因，便于后续追踪'
        ))
        result.passed = false
      }
      continue
    }
    // covered（含 coverage 字段缺失/非法，一并按 covered 严格要求）
    const refs = Array.isArray(fp.acIds) ? fp.acIds : []
    if (refs.length === 0) {
      result.blockers.push(structuredError(
        'prd_coverage_missing',
        `功能点 ${tag} 未关联任何 AC: ${fp.source || ''}`,
        2,
        '为该功能点补充 acIds，或改为 coverage:"deferred" 并写明 deferredReason'
      ))
      result.passed = false
      continue
    }
    const dangling = refs.filter(id => !acIds.has(id))
    if (dangling.length > 0) {
      result.blockers.push(structuredError(
        'prd_coverage_missing',
        `功能点 ${tag} 引用的 AC 不存在: ${dangling.join(', ')}`,
        2,
        'featurePoints[].acIds 必须引用 criteria 中真实存在的 AC ID'
      ))
      result.passed = false
    }
  }
}

/**
 * Phase 1→2 门控: task-dag + AC↔Task 交叉引用 + Figma frame-inventory 完整性 & nodeId 引用（条件性，仅 hasFigmaDesign）
 */
function checkPhase1Gate (storyId, state, result) {
  const taskCheck = checkTaskDagJson(storyId)
  if (!taskCheck.valid) {
    for (const e of taskCheck.errors) {
      const lower = String(e).toLowerCase()
      let type = 'unknown'
      let level = 2
      let resolution = '需人工分析此错误模式'

      if (lower.includes('缺少 id') && lower.includes('task')) {
        type = 'task_missing_id'
        resolution = '为每个 task 添加唯一 id 字段'
      } else if (lower.includes('缺少 title') || lower.includes('"name"')) {
        type = 'task_missing_title'
        level = 1
        resolution = '为每个 task 添加 title 字段（使用 title 而非 name）'
      } else if (lower.includes('acceptancecriteria') && lower.includes('空') || lower.includes('缺少')) {
        type = 'empty_ac_ref'
        resolution = '每个 task 的 acceptanceCriteria 至少引用 1 条 AC'
      } else if (lower.includes('重复') && lower.includes('task') && lower.includes('id')) {
        type = 'task_duplicate_id'
        resolution = 'Task ID 必须唯一'
      } else if (lower.includes('不存在')) {
        type = 'artifact_missing'
        level = 4
        resolution = 'task-dag.json 文件不存在，请先产出此文件'
      } else if (lower.includes('解析失败')) {
        type = 'json_parse_error'
        resolution = 'JSON 格式错误，请检查 task-dag.json'
      } else if (lower.includes('为空') && lower.includes('tasks')) {
        type = 'empty_ac_ref'
        resolution = 'tasks 数组不能为空'
      }

      result.blockers.push(structuredError(type, String(e), level, resolution))
      result.passed = false
    }
  }

  const refCheck = validateContractReferences(storyId)

  // 传递交叉引用校验的 warnings（格式漂移等诊断信息）
  if (refCheck.warnings && refCheck.warnings.length > 0) {
    result.warnings.push(...refCheck.warnings)
  }

  if (!refCheck.valid) {
    for (const e of refCheck.errors) {
      const lower = String(e).toLowerCase()
      let type = 'unknown'
      let level = 2
      let resolution = '需人工分析此错误模式'

      if (lower.includes('未被') && lower.includes('引用') && lower.includes('验收')) {
        type = 'orphan_ac'
        resolution = '每条验收标准至少被 1 个 Task 引用'
      } else if (lower.includes('不存在') && lower.includes('ac')) {
        type = 'invalid_ac_ref'
        resolution = 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在'
      } else if (lower.includes('均不存在')) {
        type = 'invalid_ac_ref'
        level = 4
        resolution = 'acceptance-criteria.json 和 task-dag.json 均不存在'
      }

      result.blockers.push(structuredError(type, String(e), level, resolution))
      result.passed = false
    }
  }

  // Figma nodeId 引用校验（条件性：仅当 hasFigmaDesign=true）
  // 从 validate-phase-gate.js 迁入 —— run.md 声称的"task 需带 figmaNodeId"硬门控此前从未在生效路径执行。
  // 取舍：引用了不存在的 frame → BLOCKER（明确错误）；Vue task 未绑 nodeId → WARNING（可能是纯逻辑改动）
  if (hasFigmaDesign(state)) {
    // 先校验 frame-inventory 内容完整性（id/name/link/type 等），残缺即 BLOCKER。
    // 存在性已由 checkPhaseArtifact 的 requiredWhen:'hasFigmaDesign' 覆盖，这里管内容。
    const ffiCheck = checkFigmaFrameInventory(storyId)
    if (ffiCheck.exists && !ffiCheck.valid) {
      for (const e of ffiCheck.errors) {
        result.blockers.push(structuredError(
          'figma_frame_incomplete',
          `figma-frame-inventory.json 不完整: ${e}`,
          2,
          'figma-frame-inventory.json 的每个 frame 必须包含 id/name/link/type 字段，缺一不可'
        ))
        result.passed = false
      }
    }

    const figmaRef = validateTaskFigmaReferences(storyId)
    for (const r of figmaRef.invalidRefs || []) {
      result.blockers.push(structuredError(
        'invalid_figma_ref',
        `Task ${r.taskId || ''} 引用的 figmaNodeId 无效: ${r.reason || JSON.stringify(r)}`,
        2,
        'task-dag.json 的 figmaNodeId 必须存在于 figma-frame-inventory.json 的 frames 中'
      ))
      result.passed = false
    }
    if ((figmaRef.unmatched || []).length > 0) {
      result.warnings.push(
        `${figmaRef.unmatched.length} 个含 .vue 文件的 Task 未绑定 figmaNodeId: ` +
        figmaRef.unmatched.map(u => `${u.taskId}(${u.title})`).join(', ')
      )
    }
  }
}

/**
 * Phase 2→3 门控: 增量 lint（编译校验默认关闭）
 *
 * 历史缺陷: Phase 2 此前无任何专项检查（PHASE_ARTIFACTS[2].fileName 为 null，
 *   产出物存在性检查被跳过），Phase 2→3 等价于无条件通过。结果是 SCSS
 *   `/deep/ ... ::after` 编译错误逃过全部本地门控，直到 Phase 7 云端构建才暴露。
 *
 * 设计取舍:
 *   - lint 只跑**本次变更文件**，避免仓库存量问题导致门控永久阻塞
 *   - 编译校验默认关闭: 构建无法增量，大项目/多项目单次耗时不可控（上限 900s），
 *     且 fix-loop 每轮回退 Phase 2 都会再触发一次全量构建，是流程阻塞的主因。
 *     需要时设 `HARNESS_RUN_BUILD=1` 显式启用。
 *   - 代价: 关闭后 SCSS/模板编译错误失去本地拦截，只能到 Phase 7 云端构建暴露
 *   - 未检测到变更时降级为 warning（可能代码已提交或本 Story 无代码改动），不误阻塞
 */
function checkPhase2Gate (storyId, state, result) {
  const repos = loadRepos(storyId)
  const repoNames = Object.keys(repos.repos || {})
  const targets = repoNames.length > 0 ? repoNames : [null]
  let anyChange = false

  for (const name of targets) {
    const repoRoot = getRepoRoot(name, repos)
    const label = name ? `[${name}] ` : ''
    if (!repoRoot || !fs.existsSync(repoRoot)) {
      // 不静默跳过：仓库路径配置错误会让门控失效，必须留痕
      result.warnings.push(`${label}仓库路径不存在，无法执行 lint/编译校验: ${repoRoot}（请检查 repos.json）`)
      continue
    }

    const changed = getChangedFiles(repoRoot)
    if (changed.length === 0) continue
    anyChange = true

    // 1. 增量 lint
    const lintTargets = changed.filter(f => /\.(js|jsx|ts|tsx|vue)$/i.test(f))
    if (lintTargets.length > 0) {
      const lint = runIncrementalLint(repoRoot, lintTargets)
      if (lint.skipped) {
        result.warnings.push(`${label}未找到可用的 lint 工具，已跳过增量 lint 校验`)
      } else if (lint.hasErrors) {
        result.blockers.push(structuredError(
          'lint_error',
          `${label}本次变更文件存在 lint error:\n${lint.details}`,
          2,
          `在 ${repoRoot} 修复上述 lint error 后重新执行 advance-phase.js ${storyId} 3`
        ))
        result.passed = false
      }
    }

    // 2. 编译校验: 默认关闭，仅当显式设 HARNESS_RUN_BUILD=1 时执行
    if (process.env.HARNESS_RUN_BUILD === '1') {
      const build = runBuildCheck(repoRoot)
      if (build.skipped) {
        result.warnings.push(`${label}package.json 未找到可用的 build script，已跳过编译校验`)
      } else if (!build.ok) {
        result.blockers.push(structuredError(
          'build_failed',
          `${label}本地编译失败（${build.command}）:\n${build.details}`,
          2,
          `在 ${repoRoot} 执行 ${build.command} 复现并修复编译错误后重新执行 advance-phase.js ${storyId} 3`
        ))
        result.passed = false
      }

      // 2a. 后端编译校验（全栈扩展）：Java/Gradle 仓库且本次变更含后端文件时执行
      const backendChanged = changed.some(f =>
        /\.(java|xml|sql|properties|yml|yaml|go|py)$/i.test(f) || /^pom\.xml$|^build\.gradle/i.test(f)
      )
      if (backendChanged) {
        const backendBuild = runBackendCompileCheck(repoRoot)
        if (backendBuild.skipped) {
          result.warnings.push(`${label}未识别到后端构建体系（pom.xml / build.gradle），已跳过后端编译校验`)
        } else if (!backendBuild.ok) {
          result.blockers.push(structuredError(
            'build_failed',
            `${label}后端本地编译失败（${backendBuild.command}）:\n${backendBuild.details}`,
            2,
            `在 ${repoRoot} 执行 ${backendBuild.command} 复现并修复编译错误后重新执行 advance-phase.js ${storyId} 3`
          ))
          result.passed = false
        }
      }
    }
  }

  if (!anyChange) {
    result.warnings.push('Phase 2 未检测到未提交的代码变更（可能已提交或本 Story 无代码改动），已跳过 lint 校验')
  }

  // 编译校验关闭是全局默认行为，与是否检测到变更无关，故在循环外只提示一次 ——
  // 放在循环内会随仓库数重复出现，淹没真正的 warning。
  if (process.env.HARNESS_RUN_BUILD !== '1') {
    result.warnings.push('编译校验默认关闭（设 HARNESS_RUN_BUILD=1 启用），SCSS/模板编译错误将只能在 Phase 7 云端构建暴露')
  }
}

/**
 * Phase 3→4 门控: code-review.json + 无 BLOCKER + fixLoop 提示
 * 注意：code-review.json 的文件存在性已由 runGateCheck 中的 checkPhaseArtifact 覆盖，
 *       此函数只负责内容检查（BLOCKER 数量等），避免重复采集。
 *       当检测到 BLOCKER 时，附加 fixLoopAvailable 标记供主 Agent 触发修复回路。
 */
function checkPhase3Gate (storyId, result) {
  const crJsonPath = path.join(PLANS_DIR, storyId, 'code-review.json')

  // 读取 code-review.json（唯一信源）
  if (!fs.existsSync(crJsonPath)) return

  try {
    const crData = JSON.parse(fs.readFileSync(crJsonPath, 'utf-8'))
    const openBlockers = (crData.issues || []).filter(
      i => i.severity === 'BLOCKER' && i.status === 'open'
    )
    if (openBlockers.length > 0) {
      for (const b of openBlockers) {
        result.blockers.push(structuredError(
          'code_review_blocker',
          `BLOCKER ${b.id}: ${b.title} (${b.file}${b.line ? ':' + b.line : ''})`,
          2,
          `执行修复回路: advance-phase.js ${storyId} 2 --fix-loop`
        ))
      }
      result.passed = false
    }

    // 修复回路上下文检查
    const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
    if (fs.existsSync(fixRequestPath)) {
      const fixVerificationPath = path.join(PLANS_DIR, storyId, 'fix-verification.json')
      if (!fs.existsSync(fixVerificationPath)) {
        result.warnings.push('修复回路复查: 缺少 fix-verification.json，开发者未产出修复核对报告')
      } else {
        try {
          const fv = JSON.parse(fs.readFileSync(fixVerificationPath, 'utf-8'))
          if (Array.isArray(fv.fixes)) {
            const skipped = fv.fixes.filter(f => f.status === 'skipped')
            if (skipped.length > 0) {
              result.warnings.push(`修复回路复查: ${skipped.length} 个问题被标记为 skipped，请审查师确认`)
            }
          }
        } catch (e) {
          result.warnings.push('修复回路复查: fix-verification.json 解析失败')
        }
      }
    }

    // 附加 fixLoopAvailable 标记
    if (!result.passed) {
      result._meta = result._meta || {}
      result._meta.fixLoopAvailable = true
      result._meta.fixLoopSource = 'phase3'
      result._meta.fixLoopHint = `advance-phase.js ${storyId} 2 --fix-loop`
    }
  } catch (e) {
    result.blockers.push(structuredError(
      'code_review_blocker',
      `code-review.json 解析失败: ${e.message}`,
      4,
      '请检查 code-review.json 格式是否正确'
    ))
    result.passed = false
  }
}

/**
 * Phase 4→5 门控: acceptance-verification + Spec-Anchored 契约回归检查 + fixLoop 提示
 * 注意：acceptance-verification.json 的文件存在性已由 runGateCheck 中的 checkPhaseArtifact 覆盖，
 *       此函数只负责内容检查（AC 通过率、evidence 等），避免重复采集。
 *       当检测到 failed 时，附加 fixLoopAvailable 标记供主 Agent 触发修复回路。
 */
function checkPhase4Gate (storyId, result) {
  const avCheck = checkAcceptanceVerification(storyId)
  // 文件不存在时由 checkPhaseArtifact 统一记录 artifact_missing，此处跳过避免重复
  if (!avCheck.exists) return

  let hasFailure = false

  // failed 状态 → BLOCKER (L2: 触发修复回路)
  for (const f of avCheck.failed) {
    result.blockers.push(structuredError(
      'ac_verification_failed',
      `AC ${f.id}: ${f.status}`,
      2,
      `验收标准 ${f.id} 未通过，执行修复回路: advance-phase.js ${storyId} 2 --fix-loop`
    ))
    result.passed = false
    hasFailure = true
  }

  // unverifiable 状态 → WARNING（不阻塞，降级通过）
  for (const u of avCheck.unverifiable) {
    result.warnings.push(`AC ${u.id}: unverifiable（跨项目或环境限制，代码逻辑已验证）`)
  }

  // 交叉对账: code-review 里仍 open 的问题，若自称影响某条 AC，而该 AC 已判 passed → 矛盾
  crossCheckReviewVsAcceptance(storyId, avCheck, result)

  // 证据强度: UI 交互型 AC 不允许仅凭代码审读判 passed
  checkEvidenceQuality(storyId, avCheck, result)

  // AV 内部校验错误 → 结构化
  for (const e of avCheck.errors) {
    const lower = String(e).toLowerCase()
    let type = 'unknown'
    let level = 2
    let resolution = '需人工分析'

    if (lower.includes('缺少 id') || lower.includes('缺少id')) {
      type = 'av_missing_id'
      resolution = '每条 result 必须有 id 字段（对应 AC ID）'
    } else if (lower.includes('缺少 evidence') || lower.includes('缺少evidence')) {
      type = 'av_missing_evidence'
      resolution = '每条 result 必须有 evidence 数组（至少 1 条）'
    } else if (lower.includes('缺少验收结果') || lower.includes('缺少')) {
      type = 'ac_missing_verification'
      level = 4
      resolution = '每条验收标准必须有对应的验收结果'
    } else if (lower.includes('缺少 results')) {
      type = 'ac_verification_failed'
      level = 4
      resolution = 'acceptance-verification.json 必须有 results 数组'
    }

    result.blockers.push(structuredError(type, String(e), level, resolution))
    result.passed = false
  }

  // Spec-Anchored: 契约回归检查
  const contractCheck = checkContractRegression(storyId)
  if (!contractCheck.valid) {
    for (const e of contractCheck.errors) {
      result.warnings.push(`Spec-Anchored: ${e}`)
    }
  }

  // 附加 fixLoopAvailable 标记（供主 Agent 判断是否需要修复回路）
  if (hasFailure) {
    result._meta = result._meta || {}
    result._meta.fixLoopAvailable = true
    result._meta.fixLoopSource = 'phase4'
    result._meta.fixLoopHint = `advance-phase.js ${storyId} 2 --fix-loop`
  }

  // open-questions 检查: Phase 4→5 提交前提醒未 resolve 的问题
  const oqCheck = checkOpenQuestions(storyId)
  if (oqCheck.exists && oqCheck.unresolvedCount > 0) {
    const unresolvedList = oqCheck.unresolved.map(q => `${q.id}: ${q.question}`).join('; ')
    result.warnings.push(
      `open-questions.json 中有 ${oqCheck.unresolvedCount} 个未 resolve 的问题: ${unresolvedList}。` +
      '需后端配合的问题请标记 resolved:true + resolution:"前端已预留，待后端配合"；前端可确认的问题请在开发过程中确认并标记 resolved'
    )
  }
}

/**
 * Phase 6→7 门控：知识库分支必须留下显式结果。
 *
 * Phase 6 没有文件型产物；若不做此检查，dispatch 在断点恢复时会把它
 * 误判为已就绪并直接推进。最后一条 phase_outcome 是唯一信源，允许的终态为：
 * 允许 updated / initialized / skipped_by_user / completed_with_errors。
 * @param {string} storyId - Story ID
 * @param {Object} result - runGateCheck 聚合结果
 */
function checkPhase6Gate (storyId, result) {
  const tracePath = path.join(getStoryDir(storyId), 'trace.jsonl')
  let latest = null

  if (fs.existsSync(tracePath)) {
    const lines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'phase_outcome' && String(entry.phase) === '6') latest = entry
      } catch (_) { /* 容错：坏行不影响其他 trace 证据 */ }
    }
  }

  const allowed = new Set(['updated', 'initialized', 'skipped_by_user', 'completed_with_errors'])
  if (!latest || !allowed.has(latest.result)) {
    result.blockers.push(structuredError(
      'phase6_outcome_missing',
      'Phase 6 尚无有效结果记录：需完成 kb-update，或复用 Phase 2 的用户拒绝记录',
      4,
      `执行 Phase 6 分支后运行 trace.js phase-outcome ${storyId} 6 <updated|initialized|skipped_by_user|completed_with_errors>`
    ))
    result.passed = false
  }
}

/**
 * Phase 4→5 交叉对账: code-review 未修复项 vs 验收结论
 *
 * 历史缺陷: checkPhase4Gate 从不读 code-review.json，checkPhase3Gate 只看
 *   `severity==='BLOCKER' && status==='open'`。结果 WARNING 级问题只要不改成 BLOCKER
 *   就能带病过关 —— 即使问题描述里明写"影响 AC-3 选品交互的正确性"，而 AC-3 同时被判 passed。
 *   两份产出物各自自洽，合起来自相矛盾，没有任何一道门控看得见这个矛盾。
 *
 * 判定: open 状态的问题（任意 severity）文本中出现 AC-N，而该 AC 在
 *   acceptance-verification.json 中为 passed → BLOCKER。
 *   要么修问题，要么把该 AC 从 passed 改成 failed，不允许两者并存。
 */
function crossCheckReviewVsAcceptance (storyId, avCheck, result) {
  const crJsonPath = path.join(PLANS_DIR, storyId, 'code-review.json')
  if (!fs.existsSync(crJsonPath)) return

  let crData
  try {
    crData = JSON.parse(fs.readFileSync(crJsonPath, 'utf-8'))
  } catch (e) {
    result.warnings.push(`交叉对账: code-review.json 解析失败，已跳过（${e.message}）`)
    return
  }

  const passedACIds = new Set(
    (avCheck.results || []).filter(r => r.status === 'passed').map(r => r.id).filter(Boolean)
  )
  if (passedACIds.size === 0) return

  const openIssues = (crData.issues || []).filter(i => i.status === 'open')
  for (const issue of openIssues) {
    // 在问题的全部文本字段里找 AC 引用（审查师通常写在 title/description/impact 里）
    const text = [issue.title, issue.description, issue.impact, issue.suggestion, issue.reason]
      .filter(v => typeof v === 'string').join(' ')
    const refs = text.match(/AC-\d+/gi) || []
    const conflicting = [...new Set(refs.map(r => r.toUpperCase()))].filter(id => passedACIds.has(id))
    if (conflicting.length === 0) continue

    result.blockers.push(structuredError(
      'review_acceptance_conflict',
      `审查问题 ${issue.id || ''}(${issue.severity || 'WARNING'}, status=open) 自称影响 ` +
      `${conflicting.join('/')}，但该 AC 在 acceptance-verification.json 中为 passed` +
      `${issue.title ? ': ' + issue.title : ''}`,
      2,
      `二选一: ① 修复该问题并把 status 改为 fixed；② 把 ${conflicting.join('/')} 的 status 从 passed 改为 failed 并走修复回路`
    ))
    result.passed = false
  }
}

/**
 * Phase 4→5 证据强度校验: UI 交互型 AC 不允许仅凭代码审读判 passed
 *
 * 历史缺陷: TrainWeChatStore 14 条 AC 的 evidence 全部是 `文件:行号 + 代码语义描述`，
 *   没有一条来自实际运行。AC-3「导入商品并关联课程」凭读到 `:selectable="selectable"`
 *   就判 passed，而审查师同时发现「选品弹窗取消勾选失效」—— 读代码读不出运行时行为，
 *   passed 于是变成了"我认为这段代码应该是对的"。
 *
 * 判定（按 acceptance-criteria.json 的 testType 分级，避免一刀切把门控变成墙）:
 *   - testType=ui   + passed + evidenceType=static → BLOCKER。纯交互断言（点击/禁用态/
 *     弹窗）不可能靠静态阅读证明，要么补 playwright/manual 证据，要么老实改成 unverifiable。
 *   - 其余 testType + passed + evidenceType=static → WARNING。集成/接口型 AC 的静态证据
 *     强度不足但仍有参考价值，且若一律阻塞会迫使大批 AC 降级成 unverifiable。
 *     （unverifiable 不阻塞门控 —— checkAcceptanceVerification 已移除比例阈值，
 *      unverifiable 由本函数与 checkPhase4Gate 降级为 WARNING 提示。）
 *
 * evidenceType 缺失按 static 处理（schema 已要求必填，缺失即未如实声明）。
 */
function checkEvidenceQuality (storyId, avCheck, result) {
  const ac = readJsonArtifact(storyId, 'acceptance-criteria.json')
  if (!ac || ac._parseError) return

  const testTypeById = new Map(
    (ac.criteria || []).filter(c => c.id).map(c => [c.id, c.testType])
  )
  const weakNonUi = []

  for (const r of avCheck.results || []) {
    if (r.status !== 'passed') continue
    const evidenceType = r.evidenceType || 'static'
    if (evidenceType !== 'static') continue

    if (testTypeById.get(r.id) === 'ui') {
      result.blockers.push(structuredError(
        'static_evidence_for_ui_ac',
        `AC ${r.id}(testType=ui) 判为 passed 但 evidenceType=static —— 交互型验收不能只靠读代码`,
        2,
        `二选一: ① 用 Playwright 实跑或人工点验后把 evidenceType 改为 playwright/manual 并补运行时证据；② 把 ${r.id} 的 status 改为 unverifiable 并写明环境限制`
      ))
      result.passed = false
    } else {
      weakNonUi.push(r.id)
    }
  }

  if (weakNonUi.length > 0) {
    result.warnings.push(
      `${weakNonUi.length} 条 AC 仅凭代码审读判 passed（证据强度偏弱，建议补运行时验证）: ${weakNonUi.join(', ')}`
    )
  }
}

/**
 * Spec-Anchored 契约回归检查
 * 验证 task-dag.json 声称的 files 是否都有对应的代码变更
 * @param {string} storyId
 * @returns {{ valid: boolean, errors: string[] }}
 */
function checkContractRegression (storyId) {
  const result = { valid: true, errors: [] }
  const taskData = readJsonArtifact(storyId, 'task-dag.json')
  if (!taskData || !Array.isArray(taskData.tasks)) return result
  const repos = loadRepos(storyId)

  // 检查每个 task 的 files 是否存在（优先用 task.repoPath，其次 task.repo/project 解析对应仓库根，缺省 primary）
  for (const task of taskData.tasks) {
    if (!Array.isArray(task.files)) continue
    // 跨项目 task 优先使用 repoPath（绝对路径），其次从 repos.json 解析
    const repoName = task.project || task.repo || repos.primary
    const repoRoot = task.repoPath || getRepoRoot(repoName, repos)
    for (const f of task.files) {
      const fullPath = path.join(repoRoot, f)
      if (!fs.existsSync(fullPath)) {
        result.errors.push(`Task ${task.id} 声明的文件 ${repoName}:${f} 不存在`)
        result.valid = false
      }
    }
  }

  return result
}

// ─── Phase 2 门控辅助: 变更采集 / lint / build ──────────────────

/**
 * 采集仓库内未提交的变更文件（相对仓库根的路径）
 * @param {string} repoRoot
 * @returns {string[]} 变更文件列表；非 git 仓库或异常时返回空数组
 */
function getChangedFiles (repoRoot) {
  try {
    const out = execSync('git status --porcelain', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      // maxBuffer 必须显式放大：Node 默认 1MB。正常仓库远达不到，但 .gitignore 一旦失效
      // 就会被轻易打满（本项目实测发生过两次：构建产物未忽略、.eslintrc-auto-import.json 被跟踪）。
      // 溢出抛 ENOBUFS → 旧实现静默 return [] → 门控认为「没有变更文件」从而完全跳过增量 lint，
      // 这是比误报更危险的静默放行。
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const p = l.replace(/^\S+\s+/, '')
        // 重命名 "old -> new" 取新路径
        return p.includes(' -> ') ? p.split(' -> ')[1] : p
      })
      .map(p => p.replace(/^"|"$/g, ''))
      .filter(p => !p.endsWith('/'))
  } catch (e) {
    // 「非 git 仓库」是预期情况，静默即可；其余异常必须可见 ——
    // 否则采集失败与「确实没有变更」不可区分，门控会静默退化为放行。
    const msg = String((e && e.message) || '')
    if (!/not a git repository/i.test(msg)) {
      console.error(`[policy] getChangedFiles 失败，增量 lint 将被跳过 (${repoRoot}): ${msg.split('\n')[0]}`)
    }
    return []
  }
}

/**
 * 对指定文件跑 eslint（只读，绝不带 --fix，避免门控层改动代码）
 * @param {string} repoRoot
 * @param {string[]} files - 相对仓库根的文件路径
 * @returns {{ hasErrors: boolean, details: string, skipped: boolean }}
 */
function runIncrementalLint (repoRoot, files) {
  if (!fs.existsSync(path.join(repoRoot, 'node_modules', 'eslint'))) {
    return { hasErrors: false, details: '', skipped: true }
  }
  const args = files.map(f => `"${f}"`).join(' ')
  let output = ''
  try {
    output = execSync(`npx eslint ${args} --format compact`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000,
      // maxBuffer 必须显式放大，且此处比 build 更隐蔽：eslint 有 error 时以非 0 退出，
      // 所以下方 catch 是「正常路径」，1MB 溢出不会引起任何怀疑 —— e.stdout 只剩被截断的
      // 前 1MB，超出部分的 Error 被静默丢弃，门控就会放行带 lint error 的代码。
      // compact 格式约 80~150 B/行，1MB ≈ 7000~12000 条消息。
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (e) {
    output = String(e.stdout || e.stderr || e.message || '')
    // ENOBUFS 表示输出被截断，此时「没扫到 Error」的结论不成立（缺证据，而非有反证）。
    // 与 runBuildCheck 相反，这里必须 fail-closed：build 的溢出有 exit 0 作为成功证据，
    // lint 的溢出什么证据都没有，静默放行的代价远高于让人手动复核一次。
    if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || '')))) {
      return {
        hasErrors: true,
        details: `eslint 输出超过 maxBuffer(64MB)，结果不完整，无法确认是否存在 error。\n仓库: ${repoRoot}\n请手动复核: npx eslint <变更文件> --format compact`,
        skipped: false
      }
    }
  }
  const errorLines = output.split('\n').filter(l => /:\s*line\s+\d+,\s*col\s+\d+,\s*Error\s+-/i.test(l))
  return {
    hasErrors: errorLines.length > 0,
    details: errorLines.slice(0, 10).join('\n'),
    skipped: false
  }
}

/**
 * 本地编译校验。优先使用 build:dev / build:test（比生产构建快），回退 build。
 * @param {string} repoRoot
 * @returns {{ ok: boolean, details: string, command: string, skipped: boolean }}
 */
/**
 * 后端本地编译校验（全栈扩展）。识别 Maven / Gradle 仓库并执行编译（跳过测试）。
 * 与 runBuildCheck 独立：一个仓库可能同时含前端（package.json）与后端（pom.xml），
 * 前后端编译各自校验、互不替代。
 * @param {string} repoRoot
 * @returns {{ ok: boolean, details: string, command: string, skipped: boolean }}
 */
function runBackendCompileCheck (repoRoot) {
  const hasPom = fs.existsSync(path.join(repoRoot, 'pom.xml'))
  const hasGradle = fs.existsSync(path.join(repoRoot, 'build.gradle')) ||
    fs.existsSync(path.join(repoRoot, 'build.gradle.kts'))
  if (!hasPom && !hasGradle) {
    return { ok: true, details: '', command: '', skipped: true }
  }

  // Maven 子模块场景：变更可能在子模块，根 pom 编译覆盖全部子模块，用根编译即可
  const command = hasPom
    ? 'mvn -q compile -DskipTests'
    : 'gradle compileJava -x test'
  try {
    execSync(command, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 900000,
      maxBuffer: 64 * 1024 * 1024
    })
    return { ok: true, details: '', command, skipped: false }
  } catch (e) {
    const output = String(e.stdout || e.stderr || e.message || '')
    const errorLines = output.split('\n')
      .filter(l => /\[ERROR\]|error:|FAILED|BUILD FAILURE/i.test(l))
      .slice(0, 10)
    return {
      ok: false,
      details: errorLines.length > 0 ? errorLines.join('\n') : output.split('\n').slice(-5).join('\n'),
      command,
      skipped: false
    }
  }
}

function runBuildCheck (repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: true, details: '', command: '', skipped: true }

  let scripts = {}
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts || {}
  } catch (e) {
    return { ok: true, details: '', command: '', skipped: true }
  }

  const name = ['build:dev', 'build:test', 'build'].find(s => scripts[s])
  if (!name) return { ok: true, details: '', command: '', skipped: true }

  const command = `npm run ${name}`
  try {
    execSync(command, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 900000,
      // maxBuffer 必须显式放大：Node 默认 1MB，而中大型前端项目的构建日志轻易超过它
      // （实测 userlive `vue-cli-service build --mode production` 输出 5.33MB / 35487 行，
      //   其中 7778 条是 mini-css-extract-plugin 的 chunk order 警告 —— 构建 exit 0 完全成功）。
      // 溢出时 execSync 抛 ENOBUFS 被下方 catch 捕获，会把「构建成功」误判成「编译失败」，
      // 且 details 只取末尾 25 行，呈现出的是无害警告，导致排查方向被完全带偏。
      maxBuffer: 64 * 1024 * 1024
    })
    return { ok: true, details: '', command, skipped: false }
  } catch (e) {
    // ENOBUFS 单独识别：它表示输出超限而非编译失败，不应判定为 build 失败
    if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || '')))) {
      return {
        ok: true,
        details: '',
        command,
        skipped: false,
        bufferOverflow: true
      }
    }
    const output = String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')
    const lines = output.split('\n').filter(l => l.trim())
    return { ok: false, details: lines.slice(-25).join('\n'), command, skipped: false }
  }
}

// ─── 错误恢复执行 ───────────────────────────────────────────────

/**
 * 尝试自动修复门控失败
 * @param {string} storyId
 * @param {Array} recoveries - 恢复建议列表
 * @returns {{ fixed: boolean, fixedCount: number, details: string[] }}
 */
function attemptAutoRecovery (storyId, recoveries) {
  const details = []
  let fixedCount = 0

  for (const r of recoveries) {
    if (!r.suggestion || !r.suggestion.autoFixable || !r.suggestion.autoFix) continue

    try {
      const fixed = r.suggestion.autoFix(storyId)
      if (fixed) {
        fixedCount++
        details.push(`✅ 自动修复: ${r.suggestion.action}`)
      }
    } catch (e) {
      details.push(`❌ 自动修复失败: ${r.suggestion.action} - ${e.message}`)
    }
  }

  return { fixed: fixedCount > 0, fixedCount, details }
}

module.exports = {
  RECOVERY_SUGGESTIONS,
  runGateCheck,
  checkPhase0Gate,
  checkEmbeddedSpecQuality,
  checkPhase1Gate,
  checkPhase3Gate,
  checkPhase4Gate,
  checkPhase6Gate,
  checkContractRegression,
  matchRecoverySuggestion,
  attemptAutoRecovery
}
