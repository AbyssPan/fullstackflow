# commands/ — AI 直接调用的 5 个命令脚本

> 根路径：`HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands`
> 所有脚本输出 JSON 到 stdout（失败时到 stderr），退出码 0=成功 / 1=失败。
> `storyId` 可带 `plans/` 或 `.codebuddy/plans/` 前缀，脚本自动剥离。

## dispatch.js — 调度器（只读，零写权限）

```bash
node $HARNESS/dispatch.js <storyId>
```

**输出字段**（主 Agent 只消费这些，不读 `e2e-state.json`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `storyId` | string | 回显 |
| `phase` | number\|null | 当前 Phase；状态不可读时为 null |
| `phaseName` | string\|null | 中文名，如「代码开发」 |
| `status` | `ready`\|`fix_loop`\|`blocked`\|`terminal` | **四态互斥且穷尽**，主 Agent 按此机械分支 |
| `nextAgent` | string\|null | Agent **注册名**（英文），原样传给 Spawn 的 name |
| `agentLabel` | string\|null | 中文名，仅供展示，**禁止用于 Spawn** |
| `agentPrompt` | string\|null | 完整 prompt，无占位符，原样注入 |
| `advanceCommand` | string\|null | 已算好 targetPhase 的推进命令，不要手写 |
| `readyToAdvance` | boolean | true 表示应先执行 `advanceCommand` 再回 Step 1 |
| `instruction` | string\|null | 人类可读的下一步说明 |
| `warnings` | string[] | 不阻塞的告警，转述给用户但不改变分支 |
| `recovery` | object\|null | `{ type, command, description }`；`command` 为 null 表示转人工 |

**四态含义**：`ready` 干活或推进 / `fix_loop` Phase 3-4 有 BLOCKER，执行 `recovery.command`
回退修复 / `blocked` 状态异常 / `terminal` 未建流、已归档、已完成。

门控预检只是「预读」，裁定权在 `advance-phase.js` —— dispatch 绝不写状态。

## advance-phase.js — 相位跃迁唯一执行者

```bash
node $HARNESS/advance-phase.js <storyId> <phase>              # 推进（必须等于 currentPhase+1）
node $HARNESS/advance-phase.js <storyId> 2 --renew-pass       # 续签 dev-pass，不推进
node $HARNESS/advance-phase.js <storyId> 3 --lint-fix         # 按 task-dag 仓库逐个 eslint --fix
node $HARNESS/advance-phase.js <storyId> <phase> --auto-fix   # 门控失败先尝试自动恢复再重跑
node $HARNESS/advance-phase.js <storyId> <phase> --rollback   # 回退：归档中间产出物
node $HARNESS/advance-phase.js <storyId> 2 --fix-loop         # 修复回路
HARNESS_RUN_BUILD=1 node $HARNESS/advance-phase.js <id> 3     # 启用本地编译校验
```

**输出只看 `success` 一个字段**：
- `true` → 回 Step 1 重新 dispatch
- `false` → `recovery.command` 存在则原样执行后回 Step 1；为 null 则转人工

输出契约只有两类字段：**推进结果**（`success` / `fromPhase` / `toPhase` / `gateChecks` /
`devPass` / `recovery`）与**下一步怎么 Spawn**（`nextAgent` / `nextAgentLabel` /
`expectedOutputs` / `agentPrompt`，修复回路时另有 `fixLoopContext`）。
主 Agent 拿 `nextAgent` + `agentPrompt` 就够 Spawn，不需要自己拼装任何东西。

独立校验的入参约束：targetPhase 范围 0~7、步长必须 +1。越界会写出 `phase: 99` 这类污染状态；
跨阶会跳过中间门控与 summary 生成；倒退是 `--rollback` 的职责。
参数解析：第一个纯数字视为 storyId，最后一个纯数字视为 targetPhase。

## harness-workflow.js — 模式激活总开关

```bash
node $HARNESS/harness-workflow.js start <storyId> "<标题>" [--mode=run|fixbugs] [--input <file>]
node $HARNESS/harness-workflow.js end
node $HARNESS/harness-workflow.js status
```

`start` 写 `.codebuddy/plans/.harness-active` 标记文件 —— 这是 dev-pass 门控的**总开关**，
`enforce-dev-pass.js` 有标记才校验，无标记直接放行。因此 `end` 只在确认工作流收尾后执行。

`--input <file>`（也支持 `--input=<file>`）：建流前摄入并校验 `story-input.json`，
使原型/Figma 判定一次算准，免去 `--refresh-input`。校验不通过则 **exit 1 且不写标记文件**。
文件内 `mode` 为准，与 `--mode` 冲突则拒绝启动。

`storyId` 可省略，缺省自动生成 `STORY-YYYYMMDD-NN`。

## create-workflow.js — 建流 + 原型/Figma 判定

```bash
node $HARNESS/create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs] [--input <file>]
node $HARNESS/create-workflow.js <storyId> --refresh-input [--figma]
```

| flag | 作用 |
|------|------|
| `--input <file>` | **正向路径**：先有输入再建流，判定一次算准。fail-closed，非法即拒绝建流 |
| `--refresh-input` | **补救路径**：建流后才拿到/改动输入时回填。只改原型/Figma 两项，不碰 phase |
| `--figma` | 手工强制开启 Figma 硬门控，覆盖自动推导（任何模式生效） |
| `--bypass` | 跳过 Phase 0-1 直接进 Phase 2 并立即签发 dev-pass（hotfix） |
| `--mode=<m>` | `run`（默认）/ `fixbugs` |

被 `harness-workflow.js start` 内部调用。工作流已存在时直接返回错误，不覆盖既有状态。

导出：`{ createWorkflow, refreshStoryInput, precheckStoryInput, takeFlagValue }`。

## archive-story.js — 归档 / 复档

```bash
node $HARNESS/archive-story.js <storyId> archive [--dry-run] [--round N] [--force]
node $HARNESS/archive-story.js <storyId> restore [--round N] [--force] [--keep-archive]
node $HARNESS/archive-story.js <storyId> list
node $HARNESS/archive-story.js <storyId> status
```

归档后 root 清空，全部文件（含 `e2e-state.json` / `trace.jsonl` / `repos.json`）进
`archive/round-{N}/`；`dev-pass.json` 属残留，直接删除不归档。
`phase < 8` 时默认拒绝归档，需 `--force`。root 无文件即判定已归档，拒绝重复归档。
`restore` 默认**移动**（归档目录随之清空），`--keep-archive` 改为复制。

⚠️ Story 处于归档状态时，`advance-phase.js` 的 `--rollback` / `--fix-loop` 会被守卫拦截，
需先 `restore`。

---

## 附：audit/ — 按需手动执行的审计工具

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit/harness-audit.js        # 工作流健康审计
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit/metrics-aggregator.js   # 指标聚合
```

`harness-audit.js` 检查 `settings.json` / `e2e-state` / 产出物完整性 —— 排查「流程行为不符预期」
时先跑它。`metrics-aggregator.js` 在 Phase 7 完成时由 `advance-phase.js` 自动触发一次，
也可手动执行做跨 Story 统计。
