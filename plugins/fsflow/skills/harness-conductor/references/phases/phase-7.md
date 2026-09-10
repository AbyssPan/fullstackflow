# Phase 7 — 发布收尾（终 Phase）

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[7].fileName` 为 `null`，产出物存在性检查亦被跳过。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。按项目类型分流收尾：

- **前端项目**：通过 devops MCP 触发云端构建和部署，回报部署 URL + 构建号。
- **后端项目**：🚫 跳过云端部署（不调用 devops MCP 触发构建），确认 MR 已合并后
  汇报合并分支、commit hash、变更文件清单（含 DB 脚本），提示用户后端发布走公司 CI/CD
  或运维流程，即完成收尾。
- **混合项目**：前端仓走构建、后端仓走收尾，逐仓独立执行，汇报分别列出。

## 产出物

前端项目：部署 URL + 构建号；后端项目：合并分支 + 变更清单（无构建号 / 部署 URL）。
（均无文件型产出物）

## 推进到 Phase 8 时脚本自动做的事

`advance-phase.js <storyId> 8` 成功后：

1. 触发 `audit/metrics-aggregator.js` 聚合本 Story 的度量数据
2. 把工作流标记为 `status: 'completed'` 终态
3. 此后 `dispatch.js` 输出 `status: terminal`，`recovery.command` 为归档命令

## 收尾

```bash
# 归档（清空 Story root，全部文件移入 archive/round-{N}/）
node $HARNESS/archive-story.js <storyId> archive

# 关闭 harness 模式（删 .harness-active，解除 src/ 编辑限制）
node $HARNESS/harness-workflow.js end
```

归档前可用 `--dry-run` 核对将要移走的文件清单。归档细节见 `../工作流生命周期.md`
与 `harness-archive` skill。

## 本 Phase 才暴露的一类错误

Phase 2→3 的编译校验默认关闭，因此 **SCSS / 模板编译错误会一路漂到这里**才被云端构建拦住
（该场景仅存在于前端项目——后端项目在本 Phase 不触发任何构建，Java 编译错误在
Phase 2→3 门控的 `runBackendCompileCheck` 即被拦截）。遇到这种情况：

1. 不要在本 Phase 修代码 —— `src/` 此时无 dev-pass，hook 会拒绝
2. 走 `node $HARNESS/advance-phase.js <storyId> 2 --rollback` 回退到开发
3. 修完后建议本轮启用 `HARNESS_RUN_BUILD=1` 再推进，避免二次漂移

见 [phase-2.md](./phase-2.md) 的「编译校验为什么默认关闭」。

## 常见失败与对策

- **构建成功但部署失败**（仅前端项目）：属于外部系统问题，如实回报构建号与错误，不要重试到超时。
- **已归档后发现要改**：先 `archive-story.js <id> restore` 复档，
  归档守卫会拦截归档状态下的 `--rollback` / `--fix-loop`。
