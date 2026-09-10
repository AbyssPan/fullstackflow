---
name: harness-start
description: >
  Harness 工作流统一入口 — 识别意图（新功能开发 run / Bug 修复 fixbugs）、
  把用户输入梳理成 story-input.json、启动工作流，然后把编排交给 harness-conductor。
  用户说「做个需求 / 开发功能 / 实现某页面」「修 bug / 处理 TAPD 缺陷 / 某功能报错」
  或直接调用 /fullstackflow:run、/fullstackflow:fixbugs、/fullstackflow:fullstack 时使用本 skill。
---

# FullstackFlow 工作流启动入口

> 本 skill 只做三件事：**判模式 → 写输入 → 交棒**。
> Phase 推进、Agent 调度、门控恢复全部归 `harness-conductor`，本文档不复述。

两套流程（run / fixbugs）走**同一条** 8 Phase 流水线。它们的全部差异都由脚本按
`story-input.json` 自动处理（`getStoryMode` / `isPrototypeRequired` / `detectFigmaSource` /
`prompt-builder` 的 mode 分支），**你不需要为两种模式做任何额外动作** —— 只要 mode 和 sources 写对。

## Step 1：识别意图

这是本 skill 里唯一需要判断的动作。

| 信号 | 判定 |
|------|------|
| TAPD 链接 + 「修 / bug / 缺陷 / 反馈 / 报错 / 异常 / 不生效 / 白屏」 | `fixbugs` |
| 明确的故障描述（现有功能坏了、行为不对） | `fixbugs` |
| 原型链接 / Figma 链接 / 「新增 / 开发 / 实现 / 支持 / 做一个」 | `run` |
| 两类信号并存，或都没有 | 用 `AskUserQuestion` 问一次，**不要猜** |
| 用户拒答或仍无法判定 | 兜底 `run` |

**兜底为什么选 `run`**：误判成 `fixbugs` 会**静默**关掉 Figma 硬门控，UI 开发全程没有 frame 清单
校验且没人会发现；误判成 `run` 只会在 Phase 0 门控处**显性**阻塞（要求原型分析 / featurePoints），
一眼可见、一步可改。fail-loud 优于 fail-silent。

## Step 2：梳理内容并启动（两步）

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
STORY_DIR=${CLAUDE_PROJECT_DIR}/.codebuddy/plans/<storyId>
```

### 2A. 写 `${STORY_DIR}/story-input.json`

**只需写 `mode` 和 `sources` 两个键**，`storyId` / `title` / `createdAt` 由脚本回填。
把用户消息里的链接、参数、补充描述**原样**搬进去 —— 不解析、不归纳、不访问 TAPD / Figma / 原型系统。

```json
{ "mode": "run", "sources": {
  "prototypeUrls": ["https://proto.example.com/xxx"],
  "figmaUrls": ["https://www.figma.com/design/AbC123/订单中心?node-id=12-345"],
  "terminal": "H5", "text": "用户消息中除上述链接外的补充描述" } }
```

```json
{ "mode": "fixbugs", "sources": {
  "tapdUrl": "https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944999",
  "workspaceId": "10109441", "storyIdInTapd": "1010944999",
  "owner": "小明", "statusFilter": "待解决", "terminal": "H5" } }
```

`sources` 下**全部选填**，按用户实际给了什么写什么：

| 字段 | 适用 mode | 来源 | 写入后的效果 |
|------|----------|------|------------|
| `tapdUrl` | fixbugs 必填 | TAPD 链接，原样复制 | Phase 0 需求分析师据此拉缺陷 |
| `workspaceId` | fixbugs 必填 | 链接 `tapd_fe/(\d+)/` | 同上 |
| `storyIdInTapd` | fixbugs 选填 | 链接 `/story/detail/(\d+)` | 同上 |
| `owner` | fixbugs 必填 | 「处理人: XXX」 | 按此过滤缺陷 |
| `statusFilter` | fixbugs 选填 | 「状态筛选: XXX」 | 缺省不写 |
| `prototypeUrls` | run | 原型链接（墨刀 / Axure 等） | 非空 → `prototypeRequired=true`，Phase 0 需产出 `prototype-analysis.md` |
| `figmaUrls` | 两者 | Figma 链接 | run 下非空 → **自动开启 Figma 硬门控**；fixbugs 下只注入解析指引不开门控 |
| `terminal` | 两者 | H5 / PC / 小程序 | 进 Phase 0 prompt，影响检索策略 |
| `docs` | 两者 | 需求文档路径 | 进 Phase 0 prompt |
| `text` | 两者 | 剩余自由描述 | 进 Phase 0 prompt |

> Schema：`scripts/schemas/story-input.schema.json`，`additionalProperties: false` ——
> 多写字段会**直接导致 Step 2B 拒绝启动**。
> 从 URL 提正则、拆参数是**搬运**，允许做。判断需求影响哪些文件、哪些 bug 归前端还是后端、该怎么改，
> 是**分析**，归 Phase 0 需求分析师。

### 2B. 启动工作流

```bash
node $HARNESS/harness-workflow.js start <storyId> "<标题>" --input=${STORY_DIR}/story-input.json
```

`--input` 让脚本在建流前摄入并校验输入，原型 / Figma 判定一次算准 —— **不需要再执行
`--refresh-input`**。mode 以文件为准，所以也**不需要传 `--mode`**。

校验不通过时脚本 exit 1 且不写任何状态（不会留下半激活）。修好 `story-input.json` 重跑即可。

`storyId` 可省略（自动生成 `STORY-YYYYMMDD-NN`），但那样就拿不到 `STORY_DIR` 去写 2A ——
所以**先自己定 storyId**，或先跑 `start` 拿到 id 后改用 `create-workflow.js <id> --refresh-input`
的补救路径。

确认输出含 `e2eStateCreated: true` 与 `story-input.json: ✅ 已摄入`。

## Step 3：交棒

```
use_skill("fullstackflow:harness-conductor")
```

之后进入 conductor 的三步 dispatch 循环。本 skill 到此结束 —— 不要在这里判断 Phase、
不要拼 prompt、不要自己调 `advance-phase.js`。

## 铁律

| 禁止 | 原因 |
|------|------|
| 🚫 主 Agent 加载 `tapd-bug-analyzer` 或调任何 TAPD MCP 工具 | 分析必须发生在需求分析师上下文内。主 Agent 分析会让中间推理在跨 Agent 传递中丢失，且上下文被原始数据撑满，后续 8 个 Phase 全程带着无关内容 |
| 🚫 主 Agent 分析 Bug / 判断改哪些文件 | 同上，那是 Phase 0 与 Phase 2 的职责 |
| 🚫 主 Agent 自行拼 Phase 0 prompt | `agentPrompt` 是唯一出口，自行拼装会导致注入内容逐轮不一致 |
| 🚫 AI 直接写 / 改 `e2e-state.json` 或 `dev-pass.json` | 状态机唯一信源，只能由脚本维护（hook 会拦截） |
