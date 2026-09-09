# Phase 1 — 任务规划

> 门控实现：`services/policy.js` → `checkPhase1Gate()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`task-planner`**（任务规划师，OpenSpec tasks 驱动）。基于 Phase 0 产出物
（含 OpenSpec 规格与 Capabilities）把需求拆成可并行的任务 DAG（覆盖前端 / 后端 / DB 变更，
拆解顺序：DB → 后端 → 前端 → 集成），并同步产出 OpenSpec 规范的 `openspec/tasks.md`
（复选框按 Capability 分组，与 task id 建立映射，Phase 2 执行时逐条勾选）。
在 `task-dag.json` 的 `files[]` 中**列全所有待修改文件**（mapper XML、DB 脚本、配置文件均不可漏）——
该字段决定 Phase 2 的 dev-pass 写入范围，漏写的文件在 Phase 2 会被 hook 直接拒绝编辑。

有 Figma 链接时，本 Phase 才处理设计稿（需求分析师只标 UI 改动点、不拉稿）：
`use_skill("figma-to-component-map")` 针对要拆的组件精确拉取，产出 frame 清单并给 task 绑
`figmaRefs`。真正的「按需拉稿」，避免需求阶段猜测性全量拉取。

前置条件：Figma 桌面端需运行且已打开该文件。未运行时子 Agent 应如实告知并停止，
不得退回缓存数据 —— 这条已写进本 Phase 的 `agentPrompt`。

## 产出物

| 文件 | 契约 | 条件 |
|------|------|------|
| `task-dag.md` | — | 必需 |
| `task-dag.json` | ✅ | 必需 |
| `openspec/tasks.md` | — | run 模式建议产出（prompt 级要求，Phase 2 勾选进度，归档时同步） |
| `figma-frame-inventory.json` | ✅ | `requiredWhen: hasFigmaDesign` —— 状态位为 true 时转必需 |

推进 Phase 1→2 成功时，`advance-phase.js` **自动签发 dev-pass**，限域到 `task-dag.json` 的 `files[]`。

## 出门门控（Phase 1→2）

| 检查 | 级别 | failureType |
|------|------|-------------|
| task 缺 `id` / `id` 重复 | BLOCKER (2) | `task_missing_id` `task_duplicate_id` |
| task 写了 `name` 而非 `title` | BLOCKER (**1**，可自动修复) | `task_missing_title` |
| task 的 `acceptanceCriteria` 为空 | BLOCKER (2) | `empty_ac_ref` |
| `tasks` 数组为空 | BLOCKER (2) | `empty_ac_ref` |
| `task-dag.json` JSON 解析失败 | BLOCKER (2) | `json_parse_error` |
| 某条 AC 未被任何 task 引用（孤儿 AC） | BLOCKER (2) | `orphan_ac` |
| task 引用了不存在的 AC ID | BLOCKER (2) | `invalid_ac_ref` |
| **hasFigmaDesign** frame 缺 `id`/`name`/`link`/`type` 任一字段 | BLOCKER (2) | `figma_frame_incomplete` |
| **hasFigmaDesign** task 的 `figmaNodeId` 不在 frame 清单中 | BLOCKER (2) | `invalid_figma_ref` |
| **hasFigmaDesign** 含 `.vue` 的 task 完全没绑 `figmaNodeId`/`figmaRefs` | WARNING | — |

最后一条只给 WARNING 的取舍：含 `.vue` 但可能是纯逻辑改动，一律阻断会把修复流程卡死；
而「引用了不存在的 frame」是明确错误，必须 BLOCKER。

## Figma 的两条独立通道

| 通道 | 开关 | run | fixbugs | 作用 |
|------|------|-----|---------|------|
| **解析指引**（软） | 只看 `sources.figmaUrls` 非空 | ✅ 注入 | ✅ 注入 | prompt 里点名 `use_skill("figma-to-component-map")`，禁止凭链接猜 UI 结构 |
| **硬门控**（阻断） | `state.hasFigmaDesign` | ✅ 开启 | ❌ 关闭 | 即上表三条 hasFigmaDesign 检查 |

两者互不替代。fixbugs 不开硬门控是因为 Bug 修复只碰个别页面，要求全量 frame 清单会卡死流程；
但「有设计稿就该去解析」两种模式都成立，所以解析指引不分模式注入。

强制开启任何模式的硬门控：`node $HARNESS/create-workflow.js <storyId> --refresh-input --figma`

## 契约格式

`task-dag.json`（schema: `scripts/schemas/task-dag.schema.json`）
```json
{
  "tasks": [{
    "id": "task-1",
    "title": "...",                              // MUST: title 而非 name
    "files": ["src/store/config.js"],            // 决定 dev-pass 写入范围，必须列全
    "acceptanceCriteria": ["AC-1"],              // MUST: 非空
    "figmaLink": ["https://www.figma.com/..."],  // UI 任务必填，非 UI 任务为 null
    "figmaRefs": [{ "nodeId": "3020:83533", "link": "https://www.figma.com/..." }],
    "parallelizable": true,
    "project": "userlive",                       // 跨项目时必填
    "repoPath": "D:/workfile/userlive"           // 跨项目时必填（绝对路径）
  }]
}
```

`figma-frame-inventory.json`：每个 frame 含 `id`/`name`/`link`/`type`/`rect`，
可选 `designSpec`（设计规格摘要）。这是唯一的 Figma 产出物。

## 常见失败与对策

- **Phase 2 编辑被 hook 拒绝**：`files[]` 漏了文件。dev-pass 已按旧清单签发，
  需回到本 Phase 补全后重签，或用 `advance-phase.js <id> 2 --renew-pass`。
- **孤儿 AC**：Phase 0 写了 AC 但拆 task 时漏掉。补 task 或补引用，不要删 AC。
- **`figma_frame_incomplete`**：多因 Figma 桌面端未打开导致拉取残缺。确认桌面端状态后重拉，
  不要手工补字段糊过门控。
