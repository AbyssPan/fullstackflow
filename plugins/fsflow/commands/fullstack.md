---
description: FullstackFlow 全栈研发工作流统一入口 — run（新功能）/ fixbugs（缺陷修复）/ status（查状态）/ evolve（自进化）/ archive（归档）
category: workflow
argument-hint: '[run|fixbugs|status|end|evolve|archive] [参数]'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fsflow:fullstack — FullstackFlow 兼容统一入口

用户参数：`$ARGUMENTS`

> 新用法优先使用 `/fsflow:run`、`/fsflow:fixbugs`、
> `/fsflow:status`、`/fsflow:evolve`、`/fsflow:archive` 和
> `/fsflow:end`。本入口保留用于兼容原先的统一命令形式。

> **核心原则：AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**
>
> **操作手册：入口动作先调用 `use_skill("fsflow:harness-start")`（判模式 → 写输入 → 建流），
> 编排细节由 `harness-conductor` skill 承载——本命令只做路由，不复述协议。**

---

## 子命令一览

| 用法 | 说明 | 实际执行 |
|---|---|---|
| `/fsflow:fullstack run [storyId] "<需求描述>"` | 新功能 / 页面级改造（有原型 / Figma 门控） | `use_skill("fsflow:harness-start")` → mode=run |
| `/fsflow:fullstack fixbugs [storyId] "<缺陷描述>"` | 缺陷修复（免原型文档，Phase 0 自动拉 TAPD 缺陷） | `use_skill("fsflow:harness-start")` → mode=fixbugs |
| `/fsflow:fullstack status` | 查看工作流状态 | `node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js status` |
| `/fsflow:fullstack end` | 结束当前激活会话、解除编辑门控 | `node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js end` |
| `/fsflow:fullstack evolve [storyId\|all]` | 自进化体检（audit → 度量 → 诊断 → 治疗 → 验证） | `use_skill("fsflow:harness-evolve")` |
| `/fsflow:fullstack archive <storyId> <archive\|restore\|list\|status>` | 归档 / 复档 / 归档历史 | `use_skill("fsflow:harness-archive")` |

无参数直接执行 `/fsflow:fullstack` 时：视为 `run` 入口，按 harness-start 的
意图识别规则判模式（run / fixbugs），信号不足用 `AskUserQuestion` 问一次，不要猜。

`<storyId>` / `"<标题>"` 缺省时由 AI 根据用户描述生成（storyId 用 kebab-case，
如 `order-center-refund`），并向用户复述一次后再建流。

---

## AI 执行协议 (MUST FOLLOW)

你是一个 FullstackFlow 工作流的主控 Agent。你的职责是 **路由子命令 + 调度 Agent 产出物 +
执行脚本推进 Phase**，而不是自己写状态文件。

### Step 1：路由子命令

按上文「子命令一览」匹配用户意图，加载对应 skill 并完全遵循其协议：

```
run / fixbugs / (无参数)  → use_skill("fsflow:harness-start")
evolve                    → use_skill("fsflow:harness-evolve")
archive                   → use_skill("fsflow:harness-archive")
status                    → 直接执行 harness-workflow.js status，转述结果
end                       → 直接执行 harness-workflow.js end，转述结果
```

### Step 2：建流之后交棒编排器

`harness-start` 完成「判模式 → 写 story-input.json → create-workflow 建流 → --refresh-input
回填判定」后，立即调用 `use_skill("fsflow:harness-conductor")` 进入主控循环：

```
Step 1: 执行 node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/dispatch.js <storyId>
Step 2: 按 status 四态机械分支（ready / fix_loop / blocked / terminal）
Step 3: 子 Agent 汇报产出物路径 → 回 Step 1
```

`dispatch.js` 输出的 `nextAgent` / `agentPrompt` 原样注入 Spawn，主 Agent 不读 Phase、
不拼 prompt、不判断下一步该调谁。
如果子 Agent 中断、超时或未实际产出文件，主 Agent 只能重新执行 `dispatch.js` 并重派对应 Agent
（可在 prompt 前追加重试说明块），或向用户转人工；禁止主 Agent 亲自接管该 Phase 的需求分析、
任务规划、开发、审查、测试或发布职责。

### 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

所有脚本用完整路径执行：`node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/<脚本名>`。

---

## 铁律 (MUST NOT)

| 禁止行为 | 正确做法 |
|---------|---------|
| 🚫 AI 直接写/改 `e2e-state.json` / `dev-pass.json` | 状态一律由 `advance-phase.js` 脚本维护 |
| 🚫 AI 自行将 `open-questions.json` 的 `resolved` 设为 `true` | 待确认项必须由用户确认 |
| 🚫 跳过 Phase 直接进入开发 | 逐 Phase 推进，门控校验前置产出物 |
| 🚫 Phase ≠ 2 时编辑 `src/` | 先确认 Phase=2 且有有效 dev-pass（Hook 会拦截） |
| 🚫 子 Agent 失败后主 Agent 接管该 Phase 实质工作 | 重新 dispatch/重派 Agent；连续失败则转人工 |
| 🚫 归档后执行 `--rollback` / `--fix-loop` | 先执行 `archive-story.js <storyId> restore` 复档 |

---

## 常用知识库操作（非工作流，直接路由）

| 用户意图 | 路由 |
|---|---|
| 初始化项目知识库 | `use_skill("fsflow:kb-init")` |
| 检索业务域 / 接口 / 踩坑记录 | `use_skill("fsflow:kb-query")` |
| 提交后增量更新知识库 | `use_skill("fsflow:kb-update")` |
| 按 Swagger 生成接口定义 | `use_skill("fsflow:api-generator")` |
