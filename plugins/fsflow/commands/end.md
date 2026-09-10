---
description: 结束当前 FullstackFlow 会话并解除源码编辑门控
argument-hint: ''
allowed-tools: Bash
---

# /fsflow:end — 结束工作流会话

用户参数：`$ARGUMENTS`

执行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js end
```

转述脚本结果。此命令只清理当前激活标记，不替代 Story 归档。
