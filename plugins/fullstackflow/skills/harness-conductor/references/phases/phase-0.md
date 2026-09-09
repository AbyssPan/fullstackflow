# Phase 0 — 需求分析

> 门控实现：`services/policy.js` → `checkPhase0Gate()` / `checkPrdCoverage()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`requirement-analyst`**（需求分析师，spec-grill 深度拷问 × OpenSpec 规格驱动）。
读取需求输入（`story-input.json` /
PRD / Swagger 契约 / bug 分析报告 / 用户补充说明），先走 **Grill 四阶段结构化面试**
（目标对齐 → 架构决策 → 边界与风险 → 实现细节）澄清需求，再产出需求分析文档、
**OpenSpec 规格产物**（`openspec/proposal.md` + `openspec/specs/<capability>/spec.md` +
按需 `openspec/design.md`，Requirement 必须带 `#### Scenario:` WHEN/THEN 场景）、
可测试的验收标准、待确认问题。
Agent 内部需调用 `use_skill("kb-query")` 检索项目知识库。

`mode=fixbugs` 时该 Agent 自行 `use_skill("tapd-bug-analyzer")` 拉取并分析 TAPD 缺陷 ——
主 Agent 不做这件事，也不调任何 TAPD MCP 工具。

## 产出物

| 文件 | 契约 | 条件 |
|------|------|------|
| `requirement-analysis.md` | — | 必需（含 Grill 决策摘要固定小节） |
| `acceptance-criteria.json` | ✅ | 必需 |
| `open-questions.json` | ✅ | 必需 |
| `openspec/proposal.md` | — | run 模式建议产出（prompt 级要求） |
| `openspec/specs/<capability>/spec.md` | — | run 模式建议产出（同上） |
| `openspec/design.md` | — | 跨模块 / 新依赖 / 数据模型变更时建议产出 |
| `prototype-analysis.md` | — | 仅当 `gateChecks.prototypeRequired=true` |
| `{标题}_bug分析报告.md` | — | 仅 `mode=fixbugs`；**prompt 级要求，非门控项**（见下） |

`prototypeRequired` 由 `state.js:isPrototypeRequired()` 判定：fixbugs 恒 false；
run 模式看 `sources.prototypeUrls` + `sources.figmaUrls` 是否非空。

⚠️ **Bug 分析报告没有门控**。文件名含动态标题，进不了 `PHASE_ARTIFACTS` 固定文件名表；
`state.js:findBugAnalysisReports()` 虽然存在，但 `policy.js` **从不调用它**。
它只出现在两处：`prompt-builder.js` 的 `expectedOutputs`（要求 Agent 产出）和
`readStoryContext()`（Phase 1~8 自动注入报告全文）。
旧文档曾声称「缺报告则 Phase 0→1 被拦截」，那是已废弃的 `validate-phase-gate.js` 里的逻辑 ——
**不在生效路径上**。缺报告的实际后果是后续 Phase 拿不到 Bug 事实，而不是被门控挡住。

## 出门门控（Phase 0→1）

| 检查 | 级别 | failureType |
|------|------|-------------|
| `criteria` 为空 / 缺 id / 缺 description / id 重复 | BLOCKER (2) | `ac_empty_criteria` `ac_missing_id` `ac_missing_description` `ac_duplicate_id` |
| `acceptance-criteria.json` JSON 解析失败 | BLOCKER (2) | `ac_format_error` |
| `open-questions.json` 有 `blocking:true` 且未 resolved 的项 | BLOCKER (4) | `blocking_unresolved` |
| 有未 resolved 但非 blocking 的项 | WARNING | — |
| **run 模式** `acceptance-criteria.json` 缺 `featurePoints` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `coverage:"deferred"` 却没写 `deferredReason` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `covered` 却 `acIds` 为空，或引用了不存在的 AC | BLOCKER (2) | `prd_coverage_missing` |

⚠️ `featurePoints` 是 run 模式的硬要求，`fixbugs` 不要求（Bug 修复没有 PRD 功能点可枚举）。
它的存在理由：门控原先只能校验「已写下的 AC 是否格式合规」，发现不了「整条功能压根没进 AC」。

Figma frame-inventory **不在本门控校验** —— 由 Phase 1 任务规划师产出，在 Phase 1→2 校验。

## 契约格式

`acceptance-criteria.json`（schema: `scripts/schemas/acceptance-criteria.schema.json`）
```json
{
  "criteria": [{ "id": "AC-1", "description": "...", "testType": "ui|api|integration" }],
  "featurePoints": [
    { "id": "FP-1", "source": "PRD 3.2 节", "coverage": "covered", "acIds": ["AC-1"] },
    { "id": "FP-2", "source": "原型 P4", "coverage": "deferred", "deferredReason": "本期不做，依赖后端排期" }
  ]
}
```

`testType` 会在 Phase 4→5 决定证据强度门控的严格程度（`ui` 型最严）—— 见 [phase-4.md](./phase-4.md)。

`open-questions.json`（schema: `scripts/schemas/open-questions.schema.json`）：
`resolved` 只能由用户确认后标记，**AI 不得自行置 true**。

## 常见失败与对策

- **纯文字需求被卡「必须产出 prototype-analysis.md」**：`story-input.json` 缺失或写入晚于建流，
  `isPrototypeRequired()` 走保守分支恒 true。用 `create-workflow.js <id> --refresh-input` 回填；
  正向做法是建流时就带 `--input <file>`。
- **AC 全绿但功能缺失**：`featurePoints` 没枚举全。程序不猜 PRD 里有什么，只保证被枚举出来的
  功能点都落到 AC 或写明不做的原因 —— 枚举完整性靠 Agent，不靠门控。
