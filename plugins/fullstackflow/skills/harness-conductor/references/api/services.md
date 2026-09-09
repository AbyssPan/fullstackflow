# services/ — 服务层 7 个脚本（AI 不直接调用）

> 根路径：`${CLAUDE_PLUGIN_ROOT}/scripts/services/`
> 这些脚本被 `commands/` 内部 require。**读本文件的场景是「要改行为，得知道改哪个文件」**，
> 不是为了在编排循环里调用它们。

## 改哪里影响什么（速查）

| 想改的东西 | 改这个文件 |
|-----------|-----------|
| Agent prompt 的内容 / 注入哪些上下文 | `prompt-builder.js` |
| 加一道门控、改门控级别、改恢复建议 | `policy.js` |
| Phase summary 收集哪些产出物 | `context-refresh.js` |
| 新增一个 JSON 契约的 schema 校验 | `schema-validator.js` + `schemas/` |
| 失败模式如何沉淀、教训如何注入 | `experience.js` |

**不要改主 Agent 行为来达到上述目的** —— 那会让「注入什么上下文」变成一次自由裁量，
不同轮次内容不一致，这是流程失控的直接来源。

## prompt-builder.js — Agent prompt 唯一信源

```js
{ buildAgentPrompt, buildFixLoopContext, buildStoryInputSection,
  readContractContents, readStoryContext, readFigmaDesignSpec,
  buildFigmaAlignInstruction, buildTaskPlannerFigmaInstruction, AGENT_CONSTRAINTS }
```

`buildAgentPrompt({ storyId, targetPhase, summaryPhase })` 是唯一出口，被 `dispatch.js` 与
`advance-phase.js` **共用同一信源**（避免出现两份自称权威的 prompt 来源）。
产出已含 Story ID、当前 Phase、上一 Phase 摘要、契约文件内容、历史教训、约束条款、
产出物清单、修复回路上下文 —— **无占位符**。

按 `mode` 分支注入（`prompt-builder.js:237`）：`fixbugs` 时给 Phase 0 注 Bug 分析指引、
给 Phase 2 注「修复方案自行设计」说明。
`readStoryContext()` 会自动发现并注入 Story 目录下的 `*bug分析报告.md` 全文。

## policy.js — 风险门控层

```js
{ RECOVERY_SUGGESTIONS, runGateCheck, checkPhase0Gate, checkPhase1Gate,
  checkPhase3Gate, checkPhase4Gate, checkContractRegression,
  matchRecoverySuggestion, attemptAutoRecovery }
```

`runGateCheck(storyId, phaseNum, state)` → `{ passed, blockers[], warnings[], recoveries[], _meta }`。
`phaseNum` 是**当前**（来源）Phase，判定「能否离开它」。

每个 blocker 是结构化对象 `{ type, message, level, resolution }`，`type` 即 failureType，
供 `experience.js` 直接沉淀，无需从文本反推。`level`：1=自动修复 2=提示修复 3=降级 4=人工。

未登记的 failureType 会命中 `RECOVERY_SUGGESTIONS.unknown`（level 3）并产生 warning，
提示补录为独立条目 —— 见到这个 warning 就该往 `RECOVERY_SUGGESTIONS` 加条目。

各 Phase 门控细节见 `../phases/phase-<N>.md`（N=0~7）。注意 `checkPhase2Gate` 未导出（内部调用）。

## context-refresh.js — 上下文刷新

```js
{ generatePhaseSummary, injectMustCheck, getPhaseArtifacts,
  getContractFiles, loadLatestSummary, getRuntimeEvidence, readTrace }
```

每个 Phase 完成后由 `advance-phase.js` 调用生成 `phase-N-summary.md`。生成失败不阻塞推进。

## experience.js — 经验沉淀飞轮

```js
{ EXPERIENCE_DIR, FAILURE_PATTERNS_FILE, METRICS_INSIGHTS_FILE, ROOT_CAUSE_KEY_LENGTH,
  readFailurePatterns, recordFailurePattern, getLessonsForPhase, getLessonsAsChecklist,
  archiveFailureCase, getFailureStats, confirmUnknownPattern, recordHookFailure,
  rootCauseKey, readMetricsInsights, mergeInsightsToGlobal, getMetricsInsights }
```

两个方向：门控失败时 `recordFailurePattern` 记录，构造 prompt 时 `getLessonsForPhase` 注入。
`session-stop.js` 会把 Hook 拒绝事件通过 `recordHookFailure` 沉淀。

## schema-validator.js — JSON 契约校验

```js
{ SCHEMA_MAP, validateArtifact, validateArtifacts, validateFile,
  getPhaseArtifacts, getRegisteredSchemas }
```

- `validateArtifact(storyId, fileName)` — 按 Story 目录 + 固定文件名定位。
  **文件不存在视为 valid**（存在性归 `state.js:checkPhaseArtifact`）。
- `validateFile(filePath, schemaName)` — 任意路径，返回 `{ valid, errors, data }`。
  **文件不存在即 invalid**（调用方显式指名了路径，找不到必然是参数错）。
  用于 `create-workflow.js --input`。
- `getPhaseArtifacts(phaseNum)` 是**硬编码表**，与 `SCHEMA_MAP` 解耦 ——
  往 `SCHEMA_MAP` 注册新 schema 不会自动让门控开始校验它。

fail-closed 设计：校验失败即 BLOCKER，不做「跳过/降级放行」。
Ajv 来自 `vendor/ajv.bundle.js`（6 系，错误位置字段是 `dataPath`），不依赖 node_modules。

## validate-contracts.js — 契约完整性校验

`node validate-contracts.js <storyId>` 人工诊断用，检查 AC / task-dag / verification 等
契约文件的完整性。

## validate-phase-gate.js — ⚠️ 已废弃

**不在生效路径上**，仅作人工诊断保留。生效门控是 `policy.js`。
历史遗留：曾有过「两套门控」，真正被 `advance-phase.js` 调用的一直是 `policy.js`；
读到旧文档说「`validate-phase-gate.js` 在 fixbugs 模式下额外检查 X」时，
去 `policy.js` 确认 X 是否真的还在生效。
