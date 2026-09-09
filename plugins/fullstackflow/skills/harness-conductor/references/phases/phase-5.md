# Phase 5 — Git 提交

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[5].fileName` 为 `null`，产出物存在性检查亦被跳过 ——
> 本 Phase 的质量靠 Agent 自律与 git hook，不靠 policy.js。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。执行 `git add` + `commit` + `push`，并创建 MR。

🔴 **铁律：Git 提交与 MR 创建必须先取得用户确认**（`AskUserQuestion`，列出待提交文件清单、
Commit Message、目标分支 / MR 信息），未确认不得执行任何 git 写操作与 MR 创建；
MR 创建后必须等用户回复「已合并 / 审核通过」才能进入 Phase 6/7。

## 产出物

commit + push + MR（无文件型产出物）。

## 硬性约束

| 约束 | 原因 |
|------|------|
| 🔴 提交 / push / 创建 MR 前必须 `AskUserQuestion` 用户确认 | 敏感外部操作，测试通过只是可发起确认的条件，不代替用户确认 |
| 🚫 禁止 `--no-verify` | 跳过 pre-commit hook 等于绕过项目自己的质量门；本插件的 lint 门控只覆盖变更文件，项目 hook 可能还有别的检查 |
| 🚫 不直接推 main / master | 除用户明确要求外，先建分支 |
| ✅ 只 stage 本 Story 相关文件 | `git add .` 会带进无关改动；`task-dag.json` 的 `files[]` 是天然的范围参照 |

推进 Phase 5→6 前，dev-pass 已在 Phase 4→5 被兜底撤销，此时 `src/` 处于不可编辑状态 ——
若发现还需改代码，走 `--rollback` 回 Phase 2，不要设法绕过 hook。

## 常见失败与对策

- **pre-commit hook 报错**：修问题，不要 `--no-verify`。若 hook 本身坏了，
  这是需要向用户报告的事实，不是可以静默跳过的障碍。
- **push 被拒（非 fast-forward）**：先 `git pull --rebase`，不要 force push ——
  force push 属于需用户确认的破坏性操作。
- **Story 已归档却要补提交**：先 `archive-story.js <id> restore` 复档。
