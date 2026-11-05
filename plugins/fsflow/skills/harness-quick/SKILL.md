---
name: harness-quick
description: >
  quick 模式执行协议 — 需求交付后的小范围修改/Bug 修复，单 Agent 轻量流程。
  由 /fsflow:quick 创建任务后加载。覆盖定位、限域签发、修改、定向自测、
  收尾与升格的完整闭环；开发/收尾不派子 Agent、不走 Phase 门控、不做 git 提交。
---

# quick 模式执行协议

前置：`quick-task.js create` 已创建任务并输出 storyId。本 skill 按五步执行，
全部在主 Agent 上下文内完成——quick 模式**豁免**「主 Agent 不亲自编写代码」的
通用强制规则，但仅限 quick-task.json `files[]` 声明且 dev-pass 签发限域内的文件。

> **速度优先原则（2026-11-05）**：quick 的存在意义是「比不用工作流只慢一点点」。
> 每一步都选最短路径：小问题跳过知识库、定位限制阅读量、签发/收尾各一条命令、
> 自测只跑与改动直接相关的最小验证。任何一步感到在做「仪式」而非「排障」，
> 就是在过度执行本协议。

## 1. 定位（不派需求分析师）

**快路径优先，按问题规模选档，不要全量探索：**

- **指哪打哪**（用户已指明文件/行为、单点改动）：直接读目标文件相关区间，
  跳过知识库检索与一切探索，立即进入第 2 步。这是 quick 的高频形态。
- **跨文件/根因不明**：派一个**只读** `code-explorer` 子 Agent（thoroughness:
  quick/medium，问题要具体、带上已知线索），让它跨文件找根因并回报关键代码
  位置；主 Agent 只精读它指出的区间。**不要**在主上下文里逐个全文读大文件——
  这是 quick 慢的最大来源。派出的探索只读不改，回来后仍由主 Agent 签发限域并修改。
- 项目有 `llm-knowledge` 知识库且问题涉及业务域约定时才 `use_skill("kb-query")`
  检索；纯语法/局部 Bug 跳过。
- Bug 类问题按 `systematic-debugging` 的思路最小复现、追根因，不凭猜测改代码。
- 确定待修改文件（1–3 个）与 1–2 条可验证的验收标准（acceptance）。

## 2. 限域签发（一条命令，免手写 JSON）

定位完成直接签发（推荐，flags 会自动合并写入 quick-task.json，校验行为与手写完全一致）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/quick-task.js scope <storyId> \
  --file src/xxx/yyy.js --file src/aaa/bbb.js --accept "<可验证的预期>"
```

- `--file` 可重复（相对主仓库路径，最多 3 个）；`--accept` 可重复。
- 手写 `<storyDir>/quick-task.json` 的 `files[]`/`acceptance` 再 `scope <storyId>`
  仍然可用（需要 `repo:path` 跨仓库形态时用这条路）。
- `files[]` 为空、超 3 个、命中迁移/Schema/权限/接口风险特征时 scope 会拒绝——
  后者执行 `escalate` 升格，不要试图绕过。
- scope 成功后才能编辑 `src/`（dev-pass 限域，越界会被 Hook 拦截）。

## 3. 修改

- 直接编辑限域内文件；不改行为语义之外的代码，不顺手重构限域外内容。
- 涉及 UI 的修改仍需对照设计约定；缺设计依据时在 acceptance 中降级说明。

## 4. 定向自测（quick 唯一质量底线）

quick 跳过了独立代码审查与功能测试，定向自测证据必须留痕：

- 跑与改动直接相关的单测/接口/构建或最小页面验证；执行增量 lint（项目已装 ESLint 时）。
  **最小够用即停**：单文件改动不跑全量构建/全量测试套件。
- 无法运行的环境在 evidence 中标注 `unverifiable` 与原因，不得声称验证通过。
- 证据先记在脑中或消息里，收尾时用 `--evidence` 直传（见第 5 步），不必中途写 JSON。

## 5. 收尾（一条命令，免手写 JSON）

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/quick-task.js done <storyId> \
  --evidence "<命令 + 结果摘要>" --note "<本次踩坑/经验一句话，无则省略>"
```

- `--evidence` 可重复，直传即落 `evidence[]`（替代手写 quick-task.json）。
- done 会校验证据、写 `knowledge-receipt.json`、撤销 dev-pass 并清除激活记录。
- 项目有 `llm-knowledge` 时，按 kb-update 的 changelog 片段约定把本次经验追加到
  `.docs/llm-knowledge/<domain>/changelog/`（引用 storyId 与回执）；无知识库则留回执即可。
- **不做 git commit / push / MR**：用户会手动汇总提交全部变更。
- 完成后本会话的 src/ 编辑恢复受控；继续下一个 quick 任务重新 `/fsflow:quick`。

## 升格（触发即走，不犹豫）

- 修改中发现需要动接口/schema/迁移/权限，或文件数即将超限：
  `quick-task.js escalate <storyId> "<原因>"`，转完整 fixbugs 流程（dispatch 起步）。
- 已做的定位与修改保留在 Story 目录，需求分析师会读取 quick-task.json 复用。

## 中断与陈旧任务（取消回复 / 换窗口 / 隔天再来的场景）

- **中断是常态，不视为失败**：任务发出后取消 AI 回复、关闭窗口，任务会留在 `in_progress`。
  create 输出中的 `autoCancelled` / `staleActive` / `activeQuickTasks` 字段和 session-start
  恢复块会给出处理指引。
- **新任务不受旧任务阻塞**：create 遇到旧任务照常创建（激活记录按会话隔离，本会话
  PostToolUse 会认领本任务的 pending）；输出里出现旧任务信息时，按下列规则处理，
  不要自行猜测旧任务的结果，也不要停下新任务去深挖旧任务：
  - `autoCancelled`（未签发限域的陈旧任务）已**自动取消**——知会用户即可；
  - `staleActive`（已签发限域、超过 24h 无活动）列出并**询问用户**：放弃 →
    `quick-task.js cancel <storyId> [原因]`；继续 → `quick-task.js status <storyId>` 后按本协议续做；
  - `activeQuickTasks`（仍新鲜的其他进行中任务）默认是**合法并行**，不询问、不处理；
    仅当用户本次表述是「取消后重新发起 / 上次跑偏了 / 资料不足重发」时，才对照该清单
    确认旧任务并询问是否取消。
- **用户明确说不要了 / 上个任务作废**：`quick-task.js cancel <storyId> "原因"`，不写知识回执；
  取消后立即重新发起是高频场景（间隔可能只有几分钟），处理顺序：新建任务照常走，
  确认取消旧任务即可，两者互不阻塞。
- 新会话接手未完成旧任务（用户要继续）：按 status 输出判断断点——未 scope 就从第 2 步开始，
  已 scope 就直接续做修改，不要重做已完成的定位。

## 关键边界

- 不写/改 `e2e-state.json`、`dev-pass.json`（quick-task.js 独占维护）。
- 不执行 `advance-phase.js` / `dispatch.js`（无 Phase 概念；escalate 后才进入完整调度）。
- 多会话并行：其他对话框可能正跑其他任务，只处理本会话绑定的 quick storyId。
