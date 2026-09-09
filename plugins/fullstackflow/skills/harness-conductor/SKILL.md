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
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入，不加工）
  ├ fix_loop  → 执行 recovery.command
  ├ blocked   → 按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束（未创建／已完成／已归档），按 recovery 提示收尾

Step 3: 子 Agent 汇报产出物路径 → 回到 Step 1
```

如有 `warnings` → 转述给用户确认，但不因此改变分支。

**主 Agent 禁止的行为**:
- 🚫 禁止直接读取 e2e-state.json（由 dispatch.js 读取）
- 🚫 禁止自行判断当前 Phase 和下一步该调谁（由 dispatch.js 查表）
- 🚫 禁止自行处理异常恢复（由 dispatch.js 输出 recovery）
- 🚫 禁止改写 `agentPrompt` 正文或替换其内容（它已完整，无占位符）
- ✅ 主 Agent 只做两件机械动作: Spawn 指定的 Agent、执行给定的命令

## Spawn 前置注入（唯一允许的 prompt 加工）

`agentPrompt` 正文原样注入，但**允许在正文之前 prepend** 以下三类信息块（实测可消除大量子 Agent 空转与返工）：

1. **已验证环境事实块**（instinct 级，必须做）——主 Agent 此前实测过的环境结论，放 prompt 首部，标注
   「⚠️ 环境探测结论（已由主 Agent 实测验证，禁止重复探测，直接进入开发）」，典型条目：
   - CLI 可用性（如 `graphify.exe` 安装路径、Python 版本）与各仓 `graphify-out/graph.json` 存在性
   - 本地限制（用户禁止启动开发服务器 / npm 命令执行前须先询问 / 无法连接 test 环境）
   - 已核实的文件状态（哪些文件的未提交改动属上轮遗留，不属于本轮开发/审查范围）
   - 工具不可用时的降级路径（如 Bash 类工具不可用 → 用 Grep/Read 完成第二源验证，不要耗轮次探测）
   - 探测预算兜底：即使有此块，仍写明「环境探测最多允许 2 次工具调用」
   > 为什么必须做：子 Agent 看不到主 Agent 的执行历史，会从零开始探测环境。实测案例：3 个开发 Agent
   > 因误判 graphify 不可用全部耗尽轮次空转；重试时注入环境事实块后一次通过。
2. **用户裁决块**——主 Agent 已向用户确认的决议（如「某遗留项本轮不修，登记为开放风险」「某改动保留并随本轮提交」），防止子 Agent 把已裁决项重新当问题上报或擅自改动。
3. **重试说明块**——重试场景注明上轮失败原因与硬性要求（如「上一轮未落盘任何产出物，必须用 write_to_file 实际落盘，不要只在对话里输出内容」）。

> 除上述三类前置块外，禁止任何其它加工；三类块都只能**追加在正文之前**，不得插入或删改进正文。

## 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

## Phase → Agent（不作为执行依据）

运行时的权威来源是 `scripts/lib/state.js` 的 `PHASE_AGENTS`，由 `dispatch.js` 查表后以
`nextAgent` 字段输出。**主 Agent 用 `nextAgent`，不查任何表。**
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
