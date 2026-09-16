---
description: 启动 FullstackFlow 缺陷修复工作流（免原型门控）
argument-hint: '[storyId] "缺陷描述或 TAPD 信息"'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:fixbugs — 缺陷修复

用户参数：`$ARGUMENTS`

将本次请求明确判定为 `fixbugs` 模式，调用 `use_skill("harness-start")` 完成
`story-input.json` 摄入和工作流创建，然后立即调用 `use_skill("harness-conductor")`
进入调度循环。不要由主 Agent 提前分析 Bug 或直接调用 TAPD 工具。
