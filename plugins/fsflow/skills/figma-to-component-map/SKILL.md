---
name: figma-to-component-map
description: >
  Produce a complete Figma frame inventory (figma-frame-inventory.json) with precise full node links
  for the pages/dialogs/drawers/components a task touches, then bind each UI task to precise
  figmaRefs (nodeId+link). Used by the Phase 1 task planner when a Story has Figma design URLs.
---

# Figma Design → Component Map (v3 — 单一产出物 + 精确 Node 绑定)

## Prerequisites

- **Figma desktop app MUST be running** and have the design file open.
- If not running, tell the user and stop. Do NOT fall back to cached data.

### Figma MCP 通用执行策略（从 figma skill 合并而来）

> 本 skill 统一承载「读 Figma 设计稿」的全部策略，替代独立的 `figma` skill。

1. **立即调用**：检测到设计稿意图立即调用 Figma MCP 工具，100% 还原设计稿。
2. **重试机制**：第一次调用失败自动重试，最多重试 2 次（总共尝试 3 次）。
3. **失败处理**：3 次都失败 → **停止当前任务**，如实汇报失败，避免瞎猜乱做。
4. **工具选择**：
   - `get_design_context` — 获取完整设计上下文（首选）
   - `get_variable_defs` — 需要变量定义时
   - `get_screenshot` — 需要截图作为视觉基准
   - `get_metadata` — 遍历页面/帧结构
5. 确保在尝试失败后不要继续执行依赖于设计稿的任务。

## 步骤 A（任务规划师专用）: Produce Frame Inventory (`figma-frame-inventory.json`)

> **按需分析（任务规划阶段）**：本步骤由 **Phase 1 任务规划师**在拆 task 时执行（需求分析阶段不处理 Figma）。
> 只针对**要拆分的 task 涉及的文件/组件**生成 frame 清单，**不要全量扫描设计稿的所有页面**——
> 拆到哪些组件就拉哪些，避免重复分析浪费 token。
>
> ⚠️ **本步骤只用 `get_metadata`（轻量结构扫描）**，**禁止调用 `get_design_context` / `get_screenshot`**——那是开发工程师 Phase 2 的职责。设计稿完整内容（布局/样式/文案/交互细节）由开发 Agent 自行拉取，任务规划师不拉，避免重复调用。

### Step 1: List all pages

Call `get_metadata` **without a nodeId** to get the top-level page list:

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{}")
```

This returns GUID + name for every top-level page (e.g. `0:1` / "设置页", `1:2` / "会话页").

### Step 2: Scan pages for frames RELEVANT to the tasks

For each page ID that contains frames the tasks will touch, call `get_metadata` to dump the node tree, and focus on frames that correspond to the components the tasks actually modify:

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{"nodeId":"0:1"}")
```

### Step 3: Extract and classify frames

From the XML tree, extract every `<frame>` with these classification rules:

| Type | Criteria |
|------|----------|
| **page** | 1920×1080, contains table headers / filter fields / tab bars |
| **dialog** | 400-800px wide, contains `.标题样式` + `底部操作` |
| **drawer** | 900-1000px wide, contains `抽屉标题栏` |
| **component** | Smaller reusable segment, checkboxes / inputs / buttons cluster |

### Step 4: Construct complete Figma node links

For EVERY extracted frame, build the full URL:

```
https://www.figma.com/design/{fileKey}/{fileName}?node-id={dashNodeId}&m=dev
```

- `{fileKey}` — from the original Figma URL (e.g. `qim2RjyYi833JXyFeIJd88`)
- `{fileName}` — URL-encoded file name from the original URL
- `{dashNodeId}` — node ID with `:` → `-` conversion (e.g. `3020:83533` → `3020-83533`)

### Step 5: Output `figma-frame-inventory.json`（唯一产出物）

**Every frame MUST have a complete `link`.** `designSpec` **不填**——因为本步骤只用 `get_metadata`，拿不到色值/间距/字体（那是 `get_design_context` 的职责，由开发工程师 Phase 2 拉取）。每个 frame 只记录 `id`/`name`/`type`/`link`（及 `get_metadata` 能返回的 `rect` 尺寸）。Format:

```json
{
  "fileKey": "qim2RjyYi833JXyFeIJd88",
  "fileName": "客服系统",
  "frames": [
    {
      "id": "3020:83533",
      "name": "编辑分组弹窗",
      "type": "dialog",
      "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-83533&m=dev",
      "rect": { "w": 634, "h": 520 }
    },
    {
      "id": "3020:78242",
      "name": "会话分配规则-高级设置",
      "type": "page",
      "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-78242&m=dev",
      "rect": { "w": 1920, "h": 1080 }
    }
  ]
}
```

Write to: `.codebuddy/plans/<storyId>/figma-frame-inventory.json`

> **注意**：本 skill 只产出这一个文件。不再产出 `figma-component-map.md`（已废弃）。设计稿完整内容由开发 Agent（Phase 2）通过 `get_design_context` 自行拉取，任务规划师不拉设计细节。

---

## 设计稿内容拉取（开发工程师 Phase 2 专属，任务规划师不执行）

> 任务规划师完成 inventory 后，**不要**对任何 node 调用 `get_design_context` / `get_screenshot`。
> 开发工程师在 Phase 2 实现 UI 时，通过 Figma MCP `get_design_context`（每个 nodeId）拉取完整设计规格并 100% 还原。
> 这样设计稿内容只被拉取一次（开发阶段），避免任务规划师与开发重复调用。

---

## Fallback: Heuristic Matching (only when figmaNodeId not available)

When `task-dag.json` does NOT have `figmaNodeId` fields, fall back to the old heuristic approach:

1. Read `task-dag.json` task titles → extract component names
2. Match against frame names from the inventory:
   - "分配规则" → frames containing "分配"
   - "分组" → frames containing "分组"
   - "标签" → frames containing "标签"
3. UI pattern matching: dialog with shuttle → AgentGroupDialog; steps form → CreateDialog
4. Output the matched links, but **mark as "⚠️ heuristic match"** for human review

---

## Output Template

### When figmaNodeId available (precise):

```markdown
## Figma → Component Inventory (Precise, N frames)

| 组件/页面 | Figma Node ID | 完整 Figma 链接 | 类型 |
|---------|--------------|----------------|------|
| `编辑分组弹窗` | `3020:83533` | [链接](https://...) | dialog |
| `会话分配规则-高级设置` | `3020:78242` | [链接](https://...) | page |

（设计规格不在此列出——由开发工程师 Phase 2 通过 get_design_context 拉取）
```

### When heuristic (mark as fallback):

```markdown
## Figma → Component Inventory (Heuristic, N frames)

| 组件/页面 | Figma Node ID | 完整 Figma 链接 | 匹配方式 |
|---------|--------------|----------------|---------| 
| `AssignRule.vue` | `3020:78242` | [链接](https://...) | ⚠️ heuristics (名称+UI) |
```

## Important Notes

- **Every link must be a complete URL** with `?node-id=...&m=dev` — never just the node ID.
- `node-id` in URLs uses `-` separator (e.g. `3020-83533`). API calls use `:` (e.g. `3020:83533`).
- 产出物唯一：只产出 `figma-frame-inventory.json`（每个 frame 含 `id`/`name`/`type`/`link`，不含 designSpec）。`figma-component-map.md` 已废弃。
- **设计稿内容只由开发工程师 Phase 2 通过 `get_design_context` 拉取**，任务规划师只用 `get_metadata` 扫结构，不拉设计细节（避免重复调用）。
- 任务规划师在 task-dag 中应为每个 UI task 写 `figmaRefs: [{nodeId, link}]`（精确配对），开发 agent 据此一次精准拉取，不做全量探索。
- If a task in `task-dag.json` has `figmaRefs`/`figmaNodeId`, skip heuristics entirely — go straight to direct extraction.
- For pages (>10 child frames), prefer `get_metadata` over `get_design_context` to avoid truncation.
- `.`-prefixed instances (e.g. `.标题样式`) are Figma library components — treat their parent frame dimensions as the spec.
