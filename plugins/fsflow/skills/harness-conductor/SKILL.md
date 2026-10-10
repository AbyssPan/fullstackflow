---
name: harness-conductor
description: >
  Harness 工作流编排器 — 调度 Agent、管理 Phase 推进、错误恢复决策。
  由 harness-start 交棒后加载，也可在已有工作流中途直接加载继续编排。
  骨架含三步循环与铁律；8 Phase 门控详情与脚本 API 文档在 references/ 下按需读取。
---

# Harness Conductor — 工作流编排器

> **渐进式披露**：本文档只保留每次循环必用的**骨架**（核心原则、执行流程、Spawn 前置注入、铁律）。
> 条件性内容已外移到 `references/`：8 Phase 逐相门控（`phases/phase-N.md`）、
> 脚本 API（`api/*.md`）、错误恢复、代码检索、工作流生命周期、Prompt 单一信源。
> 用到时按索引表 `read_file`，避免常驻 context 浪费。

## 核心原则

> **AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**

三层职责边界，不可越界：

```
┌─ dispatch.js      = 读状态 + 说下一步   （只读，零写权限）      ─┐
│  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）   │
└─ 主 Agent         = 触发                （无判断权，机械执行）  ─┘
```

**触发权 ≠ 决定权**：命令由主 Agent 敲，但是否合法由 `advance-phase.js` 独立裁定。
主 Agent 传错 targetPhase（越界／跨阶／倒退）会被脚本拒绝，不会写坏状态。

## 执行流程

每个循环只有三步。**主 Agent 不读状态、不做判断、不拼 prompt。**

```
Step 1: 执行 node ${HARNESS}/dispatch.js <storyId>
        → 输出纯 JSON，含 status / nextAgent / agentPrompt / advanceCommand

Step 2: 按 status 分支（四态互斥且穷尽，无「其他情况自行处理」）

  ┌ ready     → 若 readyToAdvance=true: 先执行 advanceCommand，再回 Step 1
  │             否则若有 batches: 按顺序逐批 Spawn batches[].agent，原样注入各自 agentPrompt
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入，不加工）
  ├ fix_loop  → 执行 recovery.command，成功后回 Step 1（按原因回退或在原阶段重新验证）
  ├ blocked   → verification_choice_required：询问 recovery.question，等待用户选择后执行对应 options[].command，再回 Step 1
  │             其他情况按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束（未创建／已完成／已归档），按 recovery 提示收尾

Step 3: 子 Agent 汇报产出物路径 → 回到 Step 1
```

## 开发批次与返修

`batches` 是本轮开发指令的唯一来源；此时顶层 `agentPrompt` 为空，不再另起一个全量开发 Agent。
按返回顺序完成每批，失败时停止后续批次。单批只交付任务说明与证据；全部任务实际完成后，
主 Agent 汇总证据执行 `trace.js phase-outcome <storyId> 2 completed '<detailsJSON>'`，再回 dispatch。
中断恢复时核对已有交付说明对应的源码版本与结果，不能仅凭文件存在认定完成。
没有 batches 的旧任务沿用单 Agent 流程。

返修优先读取本轮问题、受影响文件和相关契约；需要调用方或设计证据时再扩展读取。
审查与测试仍执行原有覆盖要求。`pendingBlockers` 已注入 prompt，主 Agent 不再手工改写。

## 轻量路线与阶段用量

dispatch 返回 `workflowRoute`（profile + 原因）。新任务默认 auto；单仓、至多 3 个明确文件、
低风险且无跨模块/接口/依赖/迁移/权限变化时，P0 可一次产出需求与最小规划。
仍逐步通过 P0→P1→P2 门控，P1 产物已通过就不再 Spawn 规划师。
full 或证据不足走完整路线；light 不代表跳过审查或默认跳过测试。

每个 Agent 返回及阶段完成后，展示该阶段的 `phaseMetrics` / `progress`：
阶段总耗时（含等待）、Agent 累计耗时、实际/配置模型、已采集 Token、覆盖率、调用/失败/返修次数。
缺失显示「未采集」，部分覆盖明确标「部分」，不得从字数或账户额度变化推算 Token。
如需完整对照，运行 `workflow-metrics.js <storyId>`；最终汇报链接到 Story 目录内的
`workflow-metrics.md` 和 `workflow-metrics.json`，与 `task-dag.json` 同目录。
报告在 Agent 事件、阶段转换和结果记录后自动更新；可用 `--write` 手动刷新。
指出主要耗时、Token 和返修点供使用者判断，不为每一行统计新增确认等待。

宿主支持 Agent/Task Pre/Post Hook 且提供 tool_use_id 时自动记调用；usage/model 只取宿主真实返回值。
无 Hook 或后台任务缺少完成回调时，用 `trace.js agent-spawn <storyId> <agent> <taskId> <phase>`
记录开始并保存 invocationId。结束时用 `agent-result` 的 detailsJSON 传同一 invocationId、phase，
以及宿主实际返回的 model、usage（inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheWriteTokens）
和可用的 durationMs；未知字段省略。自动记录已有该调用时不另建一份手工调用。
失败也记录；后台任务还在运行不能记 completed。配置模型不代表实际模型。
阶段耗时含离线间隔，不能直接当成模型执行时间；并行 Agent 时长可超过墙钟时长。
缓存 Token 单列不重复相加；主控和未上报调用不在 Token 总量中，不自动估算费用。

失败报告用 `failureKind` + `failureReason` 分类：requirement→P0、planning→P1、
implementation→P2、environment/verification→原阶段。unknown 留在原审查/测试 Agent
补充分类证据；禁止统一回 P2。恢复命令由脚本重新核验，归档失效产物后重新 dispatch，
不要使用回退前生成的 prompt。恢复达到轮次上限时按命令输出转人工，不反复执行失败命令。

如有 `warnings` → 转述给用户确认，但不因此改变分支。

`recovery.type=verification_choice_required` 是测试选择等待态。主动询问是否执行独立功能测试，
收到明确回答后才执行对应命令；用户未回答时暂停，不启动测试、不推进，也不把预选项或超时当作回答。
用户已在本次 Story 明确选择过时，直接记录已有选择；选择由脚本持久化，恢复会话和修复回路不重复询问。

**主 Agent 禁止的行为**:
- 🚫 禁止直接读取 e2e-state.json（由 dispatch.js 读取）
- 🚫 禁止自行判断当前 Phase 和下一步该调谁（由 dispatch.js 查表）
- 🚫 禁止自行处理异常恢复（由 dispatch.js 输出 recovery）
- 🚫 禁止改写 `agentPrompt` 正文或替换其内容（它已完整，无占位符）
- 🚫 子 Agent 中断、无产出或产出缺失时，禁止主 Agent 接管该 Phase 的实质工作（读契约、读业务代码、跑测试/编译、手写产出物）；只能重新 dispatch/重派对应 Agent，或按 `dispatch.js` / `advance-phase.js` 给出的 recovery 转人工
- ✅ 主 Agent 按调度结果 Spawn 指定的 Agent、执行给定命令，或转述脚本给出的测试选择并等待回答

## Spawn 前置注入（唯一允许的 prompt 加工）

`agentPrompt` 正文原样注入，但**允许在正文之前 prepend** 以下三类信息块（实测可消除大量子 Agent 空转与返工）：

1. **已验证环境事实块**（instinct 级，必须做）——主 Agent 此前实测过的环境结论，放 prompt 首部，标注
   「⚠️ 环境探测结论（已由主 Agent 实测验证，禁止重复探测，直接进入开发）」，典型条目：
   - 本次所需 CLI 与源码检索工具的可用性，不为已确认的环境限制反复探测
   - 本地限制（用户禁止启动开发服务器 / npm 命令执行前须先询问 / 无法连接 test 环境）
   - 已核实的文件状态（哪些文件的未提交改动属上轮遗留，不属于本轮开发/审查范围）
   - 工具不可用时的降级路径（如 Bash 类工具不可用 → 用 Grep/Read 完成第二源验证，不要耗轮次探测）
   - 探测预算兜底：即使有此块，仍写明「环境探测最多允许 2 次工具调用」
   > 子 Agent 看不到主 Agent 的执行历史，已核实的环境事实应随交接传递，减少重复探测。
2. **用户裁决块**——主 Agent 已向用户确认的决议（如「某遗留项本轮不修，登记为开放风险」「某改动保留并随本轮提交」），防止子 Agent 把已裁决项重新当问题上报或擅自改动。
3. **重试说明块**——重试场景注明上轮失败原因与硬性要求（如「上一轮未落盘任何产出物，必须用 write_to_file 实际落盘，不要只在对话里输出内容」）。
   若同一 Agent 连续中断或仍未落盘，重试说明只用于重派子 Agent；主 Agent 不得把自己变成该 Phase 的执行者。

> 除上述三类前置块外，禁止任何其它加工；三类块都只能**追加在正文之前**，不得插入或删改进正文。

## 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

## Phase → Agent（不作为执行依据）

运行时的权威来源是 `scripts/lib/state.js` 的 `PHASE_AGENTS`，由 `dispatch.js` 查表后以
`nextAgent` 或 `batches[].agent` 字段输出。**主 Agent 使用对应注册名，不查任何表。**
需要人读的 8 Phase 总表（名称 / 注册名 / 产出物 / 门控实现）见 `references/phases/README.md`。

两条必守：

- **Spawn 必须用注册名**（英文，agent frontmatter 的 `name`）。Agent 文件名和正文标题是中文，
  但注册键是英文 `name` —— 传中文名无法解析到 Agent。`dispatch.js` 的 `nextAgent` 已是注册名。
- **推进命令不要手写**：从 `dispatch.js` 的 `advanceCommand` 取，它已算好 `targetPhase`。

## 铁律

- 🚫 AI 不直接写/改 `e2e-state.json`
- 🚫 AI 不直接写/改 `dev-pass.json`
- 🚫 AI 不跳过 Phase
- 🚫 AI 不自标记 `open-questions.json` resolved

---

## 按需读取的资源（渐进式披露）

> 下面三张表的触发条件都是**动作**，不是「想了解就读」。没发生对应动作就不要读，
> 常驻 context 只需要上面的骨架。

### 编排通用

| 场景 | 读取文件 |
|------|---------|
| advance-phase 推进失败 | `references/错误恢复.md` |
| 需要查找/定位代码 | `references/代码检索规范.md` |
| 激活/查看/归档/复档工作流 | `references/工作流生命周期.md` |
| 理解为何不能加工 prompt | `references/Agent-Prompt-单一信源.md` |

### 8 Phase 详情

| 场景 | 读取文件 |
|------|---------|
| `advance-phase.js` 在 Phase N→N+1 报门控失败 | `references/phases/phase-N.md`（N=0~7，只读当前那一个） |
| 需要核对某 Phase 该产出什么 / Story 目录结构 / 通用门控 | `references/phases/README.md` |

`phase-N.md` 统一 5 段：职责与 Agent 注册名 → 产出物清单 → 出门门控（级别 + failureType）
→ 契约格式 → 常见失败与对策。

### 脚本 API（按意图查，不按目录查）

| 我要… | 读取文件 |
|-------|---------|
| 查 `dispatch.js` 输出字段 / 某个 CLI flag 怎么写 | `references/api/commands.md` |
| 改 Agent prompt 内容、加一道门控、改恢复建议 | `references/api/services.md` |
| 查 Phase 常量 / 产出物表 / dev-pass 与契约读取函数 | `references/api/lib.md` |
| 编辑或命令被 hook 拒绝了，要知道是谁拒的、怎么办 | `references/api/hooks.md` |
