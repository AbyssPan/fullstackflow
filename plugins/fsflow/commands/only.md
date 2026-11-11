---
description: 单段执行一个 FullstackFlow 技能，不创建 Story、不进 8 Phase 流程
argument-hint: '<skill> "<任务描述>" [--write]'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:only — 单段执行

用户参数：`$ARGUMENTS`

第一个词是技能名，其余为任务描述；带 `--write` 表示本次允许写入文件。

## 判定顺序

1. 技能名不在白名单 → 列出可用技能并退出，**不猜相近技能**。
2. 属于流程类（4 个 `harness-*`）→ 拒绝，提示改用 `/fsflow:run` 或 `/fsflow:fixbugs`。
3. 属于写入类但未带 `--write` → 说明风险后停止，不先写再问。
4. 其余直接执行。

## 白名单

| 档 | 技能 | 说明 |
|---|---|---|
| 只读 / 产物 | `code-review`、`figma-to-component-map`、`tapd-bug-analyzer`、`kb-query`、`frontend-tech-spec`、`backend-tech-spec` | 不改业务源码，默认允许 |
| 写入（需 `--write`） | `api-generator`、`test-design-and-execution`、`systematic-debugging`、`gen-project-docs`、`kb-init`、`kb-update` | 会写文件；**无 dev-pass 限域保护** |
| 拒绝 | `harness-start`、`harness-conductor`、`harness-evolve`、`harness-archive` | 流程本体，必须走 `/fsflow:run` 或 `/fsflow:fixbugs` |

## 执行

以技能名调用 `use_skill` 加载白名单中的对应技能（例如 `code-review`），把任务描述原样作为任务目标传入。技能自身的规则、脚本与输出契约全部照常生效，本命令只提供入口。

<!-- allowed-skills: code-review figma-to-component-map tapd-bug-analyzer kb-query frontend-tech-spec backend-tech-spec api-generator test-design-and-execution systematic-debugging gen-project-docs kb-init kb-update -->
<!-- denied-skills: harness-start harness-conductor harness-evolve harness-archive -->

## 边界

写入类执行前必须说明一次，只读类不重复解释：

- 不创建 Story，不写 `.harness-active`，不产生 Phase 状态与证据链。
- 不触发 dev-pass 限域校验：写入类操作**没有文件范围保护**，改动边界由用户自行确认。
- 不进入 fix-loop，不自动返工；发现问题按技能自身规则报告。
- 需要门控、审计、长期跟踪或多阶段协作时改走 `/fsflow:run`。

## 选择建议

只做一件明确的事（审一段改动、生成一份接口定义、写一组用例、查一次知识库）用本命令；需要「需求分析 → 规划 → 开发 → 审查 → 测试 → 交付」完整链路时用 `/fsflow:run`。
