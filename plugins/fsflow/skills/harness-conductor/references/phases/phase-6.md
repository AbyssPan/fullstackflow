# Phase 6 — 知识库增量更新

> Phase 专属门控函数为 `checkPhase6Gate`；它检查 trace 中的显式结果记录。
> `PHASE_ARTIFACTS[6].fileName` 为 `null`，因此不使用文件存在性作为完成信号。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。知识库是否初始化已在 Phase 2 编码前由用户决定；
本 Phase 复用该决定：

```text
meta.yaml 存在                         → kb-update 增量更新 → 完成 Phase 6
meta.yaml 不存在 + Phase 2 已拒绝记录 → 同步记录 Phase 6 skipped_by_user → 完成 Phase 6
meta.yaml 不存在 + 无 Phase 2 记录     → 旧 Story 兼容：询问用户后初始化，或记录拒绝
```

正常流程不得重复询问用户；只有旧 Story 缺少 Phase 2 决定记录时才走兼容询问。

## 产出物

二选一：

- 知识库文档已增量更新（`meta.yaml` hash 已刷新）；
- 用户已在 Phase 2 拒绝初始化，并已同步记录 `skipped_by_user`。

无独立文件型产出物。推进 Phase 7 前，trace 中必须有 Phase 6 的有效 `phase_outcome`：
`updated` / `initialized` / `skipped_by_user` / `completed_with_errors` 之一。

## 要点

| 要点 | 说明 |
|------|------|
| 增量而非重写 | `kb-update` 是增量更新；必须保留手工批注——知识库里人写的内容比机器生成的更贵 |
| 初始化时机 | 首次初始化确认前移到 Phase 2 编码前；用户可以拒绝，拒绝不阻断开发 |
| 决定复用 | Phase 2 已记录拒绝时，本 Phase 不重复询问，直接同步记录 `skipped_by_user` |
| 旧 Story 兼容 | 缺库且没有 Phase 2 决定记录时，才询问用户；同意后执行 `kb-init` + `gen-project-docs` 全量模式 |
| 结果必须留痕 | 成功增量更新记 `updated`，兼容性全量生成记 `initialized`，拒绝记 `skipped_by_user`，失败记 `completed_with_errors` |
| 调用成功才算完成 | `kb-update` 返回失败时不要把本 Phase 报成完成；记录失败详情，便于后续修复 |
| 与 Phase 2 的呼应 | Phase 2 编码前先争取获得知识库上下文；本 Phase 在已初始化时写回本次经验 |

知识库相关 skill：`kb-init`（前置初始化/旧 Story 兼容）/ `gen-project-docs`（全量生成）/
`kb-query`（编码前检索）/ `kb-update`（本 Phase 增量更新）。

## 常见失败与对策

- **`meta.yaml` 不存在**：先查 Phase 2 `skipped_by_user` 记录；存在则复用，不存在才按旧 Story 兼容流程询问。
- **手工批注被覆盖**：说明用的是重写而非增量路径。回滚该文件后改用 `kb-update`。
