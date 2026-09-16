---
description: 启动 FullstackFlow 新功能开发工作流（8 Phase）
argument-hint: '[storyId] "需求描述"'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:run — 新功能开发

用户参数：`$ARGUMENTS`

将本次请求明确判定为 `run` 模式，调用 `use_skill("harness-start")` 完成
`story-input.json` 摄入和工作流创建，然后立即调用 `use_skill("harness-conductor")`
进入调度循环。`storyId` 未提供时按 harness-start 规范生成，不要求用户补齐。
