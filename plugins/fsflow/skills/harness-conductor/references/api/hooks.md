# hooks/ — Hook 守卫 6 个脚本（自动运行，AI 无需干预）

> 根路径：`${CLAUDE_PLUGIN_ROOT}/scripts/hooks/`，注册在 `plugins/fsflow/hooks/hooks.json`。
> **读本文件的场景：某个编辑/命令被拒绝了，需要知道是谁拒的、怎么办。**

## 注册总表

| Hook | 事件 | matcher | 超时 |
|------|------|---------|------|
| `session-start.js` | SessionStart | — | 30s |
| `enforce-state-file.js` | PreToolUse | `write_to_file\|replace_in_file\|apply_patch\|Write\|Edit\|MultiEdit\|execute_command\|Bash` | 5s |
| `enforce-dev-pass.js` | PreToolUse | `write_to_file\|replace_in_file\|apply_patch\|Write\|Edit\|MultiEdit\|execute_command\|Bash` | 10s |
| `enforce-artifact.js` | PreToolUse | `write_to_file\|replace_in_file\|apply_patch\|Write\|Edit\|MultiEdit` | 10s |
| `trace-command.js` | PostToolUse | `execute_command\|Bash\|Agent\|Skill\|use_skill\|mcp__` | 5s |
| `session-stop.js` | Stop | — | 10s |

注意 `enforce-state-file.js` 的 matcher **包含 Bash/execute_command** —— 想用 shell 重定向
绕过文件写工具去改状态文件，同样会被拦。

## enforce-state-file.js — 状态文件写保护

拦截对 `e2e-state.json` 与 `dev-pass.json` 的一切写操作。

**被拦了怎么办**：这两个文件只能由脚本维护。要改 phase 用 `advance-phase.js`；
要改原型/Figma 判定用 `create-workflow.js --refresh-input`；
要签发/撤销 dev-pass 什么都不用做，`advance-phase.js` 在 Phase 1→2 / 2→3 / 4→5 自动处理。

## enforce-dev-pass.js — src/ 编辑保护

三重校验：dev-pass **有效性**（存在且未过期，TTL 2h）+ **路径限域**（目标文件必须在
`task-dag.json` 的 `files[]` 派生出的白名单内）+ **Phase 校验**（必须 Phase 2）。

总开关是 `.codebuddy/plans/.harness-active`：有标记才校验，无标记直接放行
（即 `harness-workflow.js end` 之后 `src/` 恢复自由编辑）。

**被拦了怎么办**，按提示逐项排查：

| 提示 | 处理 |
|------|------|
| 当前 Phase ≠ 2 | 不要设法绕过。走 `advance-phase.js <id> 2 --rollback` 回退到开发 |
| dev-pass 已过期 | `advance-phase.js <id> 2 --renew-pass` |
| 文件不在限域内 | `task-dag.json` 的 `files[]` 漏了它 —— 补全后重签 pass，别改 hook |

## enforce-artifact.js — 防跳 Phase

检查前置产出物是否存在（Phase 0-1 的产出物确认）。目的是防止 Agent 在没有需求分析 /
任务规划的情况下直接动代码。

**被拦了怎么办**：补齐前置 Phase 的产出物。产出物清单看 `../phases/phase-<N>.md`（N 取实际 Phase 号）。

## session-start.js — 断点恢复

对话启动时：恢复断点 + 加载最近的 `phase-N-summary.md` + 注入历史教训 + 输出契约清单。
只恢复快照，不调用旧版门控校验器，也不在启动 Hook 中运行构建；恢复后先执行 `dispatch.js` 重新判定门控。
主 Agent 无需自行读取或修改状态文件。

## session-stop.js — 收尾清理

清理过期 dev-pass + 把本次会话的 Hook 拒绝事件通过 `experience.js:recordHookFailure`
沉淀到经验库。所以被 hook 拒绝不只是当场失败，它会变成下次的注入教训。

## trace-command.js — 命令留痕

命令 / Agent / Skill / MCP 调用后自动写 `trace.jsonl`。
工具调用记录仅用于使用统计，不能据此判定缺少源码验证；影响面证据由 Phase 3 审查。

子 Agent 的调用轨迹可能不完整，因此不以 Figma MCP 或 kb-query 的调用次数判定交付质量；
是否验证源码、覆盖影响面，由实际产出物和审查证据判断。
