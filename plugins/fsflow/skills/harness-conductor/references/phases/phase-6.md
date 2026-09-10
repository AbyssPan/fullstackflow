# Phase 6 — 知识库更新

> Phase 专属门控函数为 `checkPhase6Gate`；它检查 trace 中的显式结果记录。
> `PHASE_ARTIFACTS[6].fileName` 为 `null`，因此不使用文件存在性作为完成信号。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。进入本 Phase 时先检查项目
`.docs/llm-knowledge/meta.yaml`，再按下图分流：

```text
meta.yaml 存在     → kb-update 增量更新 → 完成 Phase 6
meta.yaml 不存在   → 询问用户是否现在初始化
  ├─ 同意             → kb-init → gen-project-docs 全量生成 → 完成 Phase 6
  └─ 拒绝             → 记录 skipped_by_user → 允许继续 Phase 7
```

询问文案固定为：**“项目知识库尚未初始化，是否现在初始化？”**。

## 产出物

二选一：

- 知识库文档已增量更新或全量生成（`meta.yaml` hash 已刷新）；
- 用户拒绝初始化时，trace 中有 Phase 6 `skipped_by_user` 记录。

无独立文件型产出物。
推进 Phase 7 前，trace 中必须有 Phase 6 的有效 `phase_outcome`：
`updated` / `initialized` / `skipped_by_user` / `completed_with_errors` 之一。

## 要点

| 要点 | 说明 |
|------|------|
| 增量而非重写 | `kb-update` 是增量更新；**必须保留手工批注** —— 知识库里人写的内容比机器生成的更贵 |
| 首次初始化需授权 | `meta.yaml` 不存在时不能默认建库，必须先等用户明确同意 |
| 初始化后全量生成 | 同意分支必须完成 `kb-init` 和 `gen-project-docs` 全量模式，不能只留骨架 |
| 拒绝可放行 | 用户拒绝后明确记录 `skipped_by_user`，该结果不阻断 Phase 7 |
| 结果必须留痕 | 成功增量更新记 `updated`，成功初始化并全量生成记 `initialized`，失败但放行记 `completed_with_errors` |
| 调用成功才算完成 | `use_skill("fsflow:kb-update")` 返回失败时不要把本 Phase 报成完成，门控看不出来，但 Phase 7 之后没人会回来补 |
| 与 Phase 0 的呼应 | Phase 0 需求分析师用 `kb-query` 读知识库，本 Phase 写回去 —— 这条回路断了，下个 Story 的检索就查不到本次的经验 |

知识库相关 skill：`kb-init`（初始化）/ `kb-query`（检索）/ `kb-update`（增量更新）。

## 常见失败与对策

- **`meta.yaml` 不存在**：不要先调 `kb-update` 等它报错；按本页分支先询问用户。
- **用户拒绝初始化**：记录命令为
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/trace.js" phase-outcome <storyId> 6 skipped_by_user '{"reason":"knowledge_base_initialization_declined"}'`；
  记录成功后可继续 Phase 7。
- **手工批注被覆盖**：说明用的是重写而非增量路径。回滚该文件后改用 `kb-update`。
