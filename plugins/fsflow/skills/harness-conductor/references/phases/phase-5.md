# Phase 5 — Git 提交（终 Phase）

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[5].fileName` 为 `null`，产出物存在性检查亦被跳过 ——
> 本 Phase 的质量靠 Agent 自律与 git hook，不靠 policy.js。

> **manual 交付模式（v1.5）**：`deliveryMode=manual` 的 Story 不会进入本 Phase——
> advance-phase.js 在 Phase 4 门控通过后将 P5 标记 skipped 并直接置为待人工检查终态，
> 由用户人工检查后手动提交；知识维护与 kb-update 建议在用户检查确认后执行。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。（可选）先按 [同仓知识维护](../../../kb-update/references/maintenance.md) 完成已授权的 kb-update 和域回执，再将代码与知识一起提交并推送到用户指定分支；暂存后运行 `kb-maintenance.js check --staged --strict`。缺库不初始化；知识更新未授权或用户拒绝时如实留痕跳过，不阻塞提交。目标分支使用用户指定，不硬编码 dev。

🔴 **Git 提交与 push 遵循当前会话授权，尚未授权时先确认**（`AskUserQuestion`，列出待提交文件清单、
Commit Message、目标分支），未确认不得执行任何 git 写操作；**MR 仅在用户明确要求时创建**，不强制，
创建后合并与发布由用户及公司 CI/CD 流程承接，不再进入后续 Phase。

## 推进到 Phase 6（终态）时脚本自动做的事

`advance-phase.js <storyId> 6` 成功后：

1. 触发 `audit/metrics-aggregator.js` 聚合本 Story 的度量数据
2. 把工作流标记为 `status: 'completed'` 终态
3. 此后 `dispatch.js` 输出 `status: terminal`，`recovery.command` 为归档命令

## 产出物

（可选）知识正文、域回执、本次 changelog + commit/push（+ MR，仅用户要求时）。

## 硬性约束

| 约束 | 原因 |
|------|------|
| 🔴 提交 / push（及可选 MR 创建）前必须 `AskUserQuestion` 用户确认 | 敏感外部操作，测试通过只是可发起确认的条件，不代替用户确认 |
| 🚫 禁止 `--no-verify` | 跳过 pre-commit hook 等于绕过项目自己的质量门；本插件的 lint 门控只覆盖变更文件，项目 hook 可能还有别的检查 |
| 🚫 不直接推 main / master | 除用户明确要求外，先建分支 |
| 🚫 不触发云端部署 / 本地构建 | 合并、构建与发布由用户和公司 CI/CD 流程承接 |
| ✅ 只 stage 本 Story 相关文件 | `git add .` 会带进无关改动；`task-dag.json` 的 `files[]` 是天然的范围参照 |

进入 Phase 5 前，dev-pass 已在 Phase 4→5 被兜底撤销，此时 `src/` 处于不可编辑状态 ——
若发现还需改代码，走 `--rollback` 回 Phase 2，不要设法绕过 hook。

## 收尾

```bash
# 归档（清空 Story root，全部文件移入 archive/round-{N}/）
node $HARNESS/archive-story.js <storyId> archive

# 关闭 harness 模式（清除 .harness-active/ 激活记录，解除 src/ 编辑限制）
node $HARNESS/harness-workflow.js end
# 多会话激活时清除指定 Story: node $HARNESS/harness-workflow.js end <storyId>
```

归档前可用 `--dry-run` 核对将要移走的文件清单。归档细节见 [../工作流生命周期.md](../工作流生命周期.md)
与 `harness-archive` skill。

## 常见失败与对策

- **pre-commit hook 报错**：修问题，不要 `--no-verify`。若 hook 本身坏了，
  这是需要向用户报告的事实，不是可以静默跳过的障碍。
- **push 被拒（非 fast-forward）**：先 `git pull --rebase`，不要 force push ——
  force push 属于需用户确认的破坏性操作。
- **Story 已归档却要补提交**：先 `archive-story.js <id> restore` 复档。
