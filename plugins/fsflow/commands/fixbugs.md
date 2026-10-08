---
description: 恢复已有缺陷修复，或启动限域缺陷工作流（免原型门控）
argument-hint: '[storyId] "缺陷描述或 TAPD 信息"'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:fixbugs — 缺陷修复

用户参数：`$ARGUMENTS`

同一缺陷的重试/继续执行且已有 storyId 时，先执行
`node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js resume <storyId>`，
成功后直接调用 `use_skill("harness-conductor")`。保留 P0/P1 契约、验证选择和修复轮次，
不重新摄入输入、不重建工作流；P3/P4 的失败由调度器按原因选择恢复阶段。
新缺陷或需求边界已变化时不能仅凭 storyId 复用旧验收结果，应新建 fixbugs Story。

新建时将本次请求明确判定为 `fixbugs` 模式，调用 `use_skill("harness-start")` 完成
`story-input.json` 摄入和工作流创建，然后立即调用 `use_skill("harness-conductor")`
进入调度循环。不要由主 Agent 提前分析 Bug 或直接调用 TAPD 工具。
