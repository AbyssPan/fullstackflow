---
description: 查看 FullstackFlow 当前 Story、Phase 和门控状态
argument-hint: ''
allowed-tools: Bash
---

# /fsflow:status — 查看状态

用户参数：`$ARGUMENTS`

执行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js status
```

向用户简洁转述结果。此命令只读，不创建或推进工作流。
