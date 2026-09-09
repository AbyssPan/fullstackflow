# Phase 6 — 知识库更新

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[6].fileName` 为 `null`，产出物存在性检查亦被跳过。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。调用 `use_skill("kb-update")` 增量更新
项目知识库文档，产出体现为 `meta.yaml` 的 hash 变化。

## 产出物

知识库文档更新（`meta.yaml` hash 变化），无独立文件型产出物。

## 要点

| 要点 | 说明 |
|------|------|
| 增量而非重写 | `kb-update` 是增量更新；**必须保留手工批注** —— 知识库里人写的内容比机器生成的更贵 |
| 调用成功才算完成 | `use_skill("kb-update")` 返回失败时不要把本 Phase 报成完成，门控看不出来，但 Phase 7 之后没人会回来补 |
| 与 Phase 0 的呼应 | Phase 0 需求分析师用 `kb-query` 读知识库，本 Phase 写回去 —— 这条回路断了，下个 Story 的检索就查不到本次的经验 |

知识库相关 skill：`kb-init`（初始化）/ `kb-query`（检索）/ `kb-update`（增量更新）。

## 常见失败与对策

- **`kb-update` 报找不到知识库**：项目可能从未 `kb-init`。这是需要如实告知用户的前置缺失，
  不要静默跳过本 Phase。
- **手工批注被覆盖**：说明用的是重写而非增量路径。回滚该文件后改用 `kb-update`。
