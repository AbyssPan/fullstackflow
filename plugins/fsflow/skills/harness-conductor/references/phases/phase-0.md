# Phase 0 — 需求分析

> 门控实现：`services/policy.js` → `checkPhase0Gate()` / `checkPrdCoverage()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`requirement-analyst`**（需求分析师，spec-grill 深度拷问 × OpenSpec 规则内嵌门控）。
读取需求输入（`story-input.json` /
PRD / Swagger 契约 / bug 分析报告 / 用户补充说明），先走 **Grill 四阶段结构化面试**
（目标对齐 → 架构决策 → 边界与风险 → 实现细节）澄清需求，再产出需求分析文档、
内嵌 OpenSpec 语义的验收契约（Capability + Change Type + 规范性 Requirement +
Given/When/Then Scenario）和待确认问题。不生成独立 `openspec/` 目录。
Agent 内部需调用 `use_skill("kb-query")` 检索项目知识库。

## 知识库前置确认

这是全流程**唯一**的知识库初始化确认点。需求分析师启动后，先根据
`story-input.json` 和必要的仓库信息确定本 Story 明确涉及的仓库，逐仓检查
`.docs/llm-knowledge/meta.yaml`：

```text
meta.yaml 存在   → 禁止重建 → kb-query → 需求分析
meta.yaml 不存在 → 一次列出缺库仓库并询问用户
  ├─ 同意        → 按仓库串行 kb-init + gen-project-docs 全量生成 → 需求分析
  └─ 拒绝        → 记录 Phase 0 skipped_by_user → 继续需求分析
```

用户拒绝时留痕：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/trace.js" phase-outcome <storyId> 0 skipped_by_user '{"reason":"knowledge_base_initialization_declined"}'
```

初始化/全量生成失败时报告失败，询问用户是否在无知识库情况下继续，不得自行决定。
后续 Phase 不再询问、初始化或全量生成。

`mode=fixbugs` 时该 Agent 自行 `use_skill("tapd-bug-analyzer")` 拉取并分析 TAPD 缺陷 ——
主 Agent 不做这件事，也不调任何 TAPD MCP 工具。

## 产出物

| 文件 | 契约 | 条件 |
|------|------|------|
| `requirement-analysis.md` | — | 必需（含 Grill 决策摘要固定小节） |
| `acceptance-criteria.json` | ✅ | 必需 |
| `open-questions.json` | ✅ | 必需 |
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
| AC 缺 `capability` / 合法 `changeType` | BLOCKER (2) | `spec_capability_missing` |
| AC description 缺 SHALL/MUST/必须/不得/应当 | BLOCKER (2) | `spec_requirement_non_normative` |
| AC 的 `given` / `when` / `then` 任一为空 | BLOCKER (2) | `spec_scenario_incomplete` |
| Grill 决策摘要缺目标/非目标/关键决策/Capabilities/风险 | BLOCKER (2) | `spec_context_incomplete` |

⚠️ `featurePoints` 是 run 模式的硬要求，`fixbugs` 不要求（Bug 修复没有 PRD 功能点可枚举）。
它的存在理由：门控原先只能校验「已写下的 AC 是否格式合规」，发现不了「整条功能压根没进 AC」。

Figma frame-inventory **不在本门控校验** —— 由 Phase 1 任务规划师产出，在 Phase 1→2 校验。

## 契约格式

`acceptance-criteria.json`（schema: `scripts/schemas/acceptance-criteria.schema.json`）
```json
{
  "criteria": [{
    "id": "AC-1", "capability": "order-submit", "changeType": "added",
    "description": "系统必须拒绝库存不足的订单", "testType": "api",
    "given": "商品库存为 0", "when": "用户提交订单", "then": "返回库存不足且不创建订单"
  }],
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
