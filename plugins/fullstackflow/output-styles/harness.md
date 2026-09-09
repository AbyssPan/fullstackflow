# Harness Output Style

Harness Engineering 输出风格约束。

- 所有 Phase 推进结果以表格形式展示
- 门控失败时输出结构化的 blocker 列表
- Agent 产出物引用格式：`<文件路径> (<行数>)`
- Git 操作输出包含 commit hash 和分支名
- 禁止输出内部状态文件路径（e2e-state.json / dev-pass.json）
