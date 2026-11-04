---
description: 需求交付后的小范围修改或 Bug 修复，单 Agent 轻量流程（免完整 8-Phase）
argument-hint: '[relatedStoryId] "<修改描述>"'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:quick — 轻量快速修改

用户参数：`$ARGUMENTS`

定位：**已交付需求后续的小范围调整与 Bug 修复**。免完整流水线（P0–P7 多 Agent 往返），
由主 Agent 单独执行，保留 dev-pass 编辑限域与证据留痕两条安全底线。

## 准入条件（不满足则改走 /fsflow:fixbugs）

- 待修改文件明确且 ≤ 3 个；不涉及跨模块、接口变更、数据迁移、权限体系、Figma 强制还原
- 属于已交付功能的后续调整（有历史 Story 或知识库可查上下文）

## 执行

1. 从 `$ARGUMENTS` 提取修改描述与可选的关联需求 storyId（首个参数若为已存在的 Story ID）。
2. 创建任务：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/quick-task.js create "<修改描述>" [--story <关联storyId>]
```

3. 创建成功后立即调用 `use_skill("harness-quick")`，按其中的协议完成定位、限域、修改、
   自测与收尾。不要由本命令直接分析问题或改代码。

## 边界

- 本命令不触发 TAPD / Figma / 知识库初始化等重流程；上下文检索在 harness-quick 内按需进行。
- quick 任务**不做 git commit / push / MR**——用户手动提交全部 quick 与完整流程的变更。
- 修改过程中发现超出准入条件（文件数超限、接口/迁移/权限风险），执行
  `quick-task.js escalate <storyId> "<原因>"` 升格完整 fixbugs 流程，已做工作不丢失。
