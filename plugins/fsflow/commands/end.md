---
description: 结束当前 FullstackFlow 会话并解除源码编辑门控
argument-hint: ''
allowed-tools: Bash
---

# /fsflow:end — 结束工作流会话

用户参数：`$ARGUMENTS`

执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js" end
```

转述脚本结果。此命令只清理当前激活标记，不替代 Story 归档。
多会话激活时脚本不会清除其他会话的记录；需要强制清理指定 Story 时加 storyId 参数。

**manual 交付模式**（`deliveryMode=manual` 的 Story，P4 后已进入待人工检查终态）：结束前确认用户已完成
人工代码检查，并提示：若尚未做知识维护，建议先执行一次 kb-update 域维护（P5 的知识职责前移到此时），
随后用户手动提交代码——`kb-maintenance` Git hook 会在提交时兜底检查知识回执，quick 任务的
`knowledge-receipt.json` 已随每次收尾落盘。
