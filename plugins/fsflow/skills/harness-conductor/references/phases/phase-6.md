# Phase 6 — 知识库增量更新

> Phase 专属门控函数为 `checkPhase6Gate`；它检查 trace 中的显式结果记录。
> `PHASE_ARTIFACTS[6].fileName` 为 `null`，因此不使用文件存在性作为完成信号。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。初始化确认已在 Phase 0 完成，
本 Phase 只做收尾，不再询问或初始化：

```text
meta.yaml 存在   → kb-update 增量更新 → 完成 Phase 6
meta.yaml 不存在 → 记录 Phase 6 skipped_by_user → 完成 Phase 6
```

无论新旧 Story，本 Phase 都不得询问、执行 `kb-init` 或全量生成。

## 产出物

二选一：

- 知识库文档已增量更新（`meta.yaml` hash 已刷新）；
- 项目未初始化知识库，已记录 `skipped_by_user`。

无独立文件型产出物。推进 Phase 7 前，trace 中必须有 Phase 6 的有效 `phase_outcome`：
`updated` / `skipped_by_user` / `completed_with_errors` 之一。

## 要点

| 要点 | 说明 |
|------|------|
| 增量而非重写 | `kb-update` 是增量更新；必须保留手工批注——知识库里人写的内容比机器生成的更贵 |
| 初始化时机 | 初始化确认只在 Phase 0 需求分析开始时执行 |
| 缺库处理 | 直接留痕 `skipped_by_user`，不询问、不初始化、不全量生成 |
| 结果必须留痕 | 成功增量更新记 `updated`，缺库记 `skipped_by_user`，失败记 `completed_with_errors` |
| 调用成功才算完成 | `kb-update` 返回失败时不要把本 Phase 报成完成；记录失败详情，便于后续修复 |
| 与 Phase 0 的呼应 | Phase 0 先准备知识库上下文；本 Phase 仅在已初始化时写回本次经验 |

本 Phase 只使用 `kb-update`（增量更新）。`kb-init` / `gen-project-docs` 只属于 Phase 0。

## 常见失败与对策

- **`meta.yaml` 不存在**：记录 Phase 6 `skipped_by_user` 后继续，不再发起初始化确认。
- **手工批注被覆盖**：说明用的是重写而非增量路径。回滚该文件后改用 `kb-update`。
