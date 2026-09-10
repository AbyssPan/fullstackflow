---
description: 归档、复档或查看 FullstackFlow Story 的归档状态
argument-hint: '<storyId> <archive|restore|list|status> [options]'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fullstackflow:archive — Story 归档管理

用户参数：`$ARGUMENTS`

调用 `use_skill("fullstackflow:harness-archive")` 并按该 skill 的安全约束执行。必须保留明确的
`archive`、`restore`、`list` 或 `status` 动作；缺少动作时先展示可用动作，不要默认归档。
