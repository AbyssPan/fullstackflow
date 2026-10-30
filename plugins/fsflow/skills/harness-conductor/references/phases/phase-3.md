# Phase 3 — 代码审查

> 门控实现：`services/policy.js` → `checkPhase3Gate()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`code-reviewer`**（代码审查师）。审查本 Story 的代码变更（git diff），
产出 `code-review.json`。若 Story 目录下存在 `fix-request.json`，说明这是修复回路的复查，
需调用 `use_skill("code-review")` 做增量审查，复用未变化证据并重新核对完整文件清单。

普通变更默认一轮完整范围审核；权限、支付、迁移、公共接口、CI/发布和跨模块变更深入相关路径。已有检查先核验证据，不重复完整功能验收；候选问题必须有位置、触发条件和影响证据，纯风格建议默认不报。返修仅补审变化及影响范围，仍核对完整 coverage，沿用默认 2 轮修复预算。具体规则以 code-review 技能为准。

## 产出物

| 文件 | 契约 | 说明 |
|------|------|------|
| `code-review.json` | ✅ | 唯一产出物（`code-review.md` 已废弃） |

## 出门门控（Phase 3→4）

| 检查 | 级别 | failureType |
|------|------|-------------|
| 新工作流缺少 coverage，或仓库/文件清单/指纹/问题位置不一致 | BLOCKER (2)，留在 Phase 3 补审 | `review_coverage_invalid` |
| 存在 `severity=BLOCKER` 且 `status=open` 的 issue | BLOCKER (2) | `code_review_blocker` |
| `code-review.json` 解析失败 | BLOCKER (4) | `code_review_blocker` |
| 修复回路复查缺 `fix-verification.json` | WARNING | — |
| `fix-verification.json` 中有 `status=skipped` 的修复项 | WARNING | — |
| `fix-verification.json` 解析失败 | WARNING | — |

语义问题以 `issues[].status` 为准：`BLOCKER` + `open` 会阻断。审查覆盖校验独立执行。
把 BLOCKER 改成 `fixed` / `skipped` 即可放行 —— 因此 `status` 的诚实性由审查师负责，不由门控保证。

覆盖或格式不完整时留在 P3 补齐报告。语义失败依据 `failureKind` + `failureReason` 分流：
需求→P0，规划→P1，实现→P2，环境/验证方法→P3。原因未知先补证据。
`failureRecovery` 给出脚本判定；仅实现错误设置 `fixLoopAvailable=true`。旧报告未分类时兼容实现修复路径。

## 修复回路（fix-loop）

主 Agent 只执行 `dispatch.js` 给的 `recovery.command`。以下仅适用于实现错误，由 `advance-phase.js --fix-loop` 编排；其他分类使用脚本给出的 `--recover-failure`：

```
提取 BLOCKER → 回退 Phase 2 → 重签限域 dev-pass（仅 affectedFiles）
→ 生成 fix-request.json + fix-context.md
```

执行完回 Step 1，`dispatch.js` 会输出带 `fixLoopContext` 的 `agentPrompt`。
默认 2 轮预算（review 与 test 各自独立计数，见 `state.maxReviewFixRounds`），
用尽后 `status: blocked` 且 `recovery.command` 为 null → 转人工。

⚠️ Story 已归档时禁止 `--fix-loop`，需先 `archive-story.js <id> restore` 复档。

## 契约格式

`code-review.json`（schema: `scripts/schemas/code-review.schema.json`）
```json
{
  "storyId": "STORY-001",              // MUST
  "issues": [{
    "id": "B1",                        // MUST: 匹配 ^(B|W|S)\d+$
    "severity": "BLOCKER|WARNING|SUGGESTION",
    "status": "open|fixed|skipped",    // MUST: 门控唯一信源
    "file": "src/views/xxx.vue",       // MUST
    "line": 42,
    "title": "...",                    // MUST
    "description": "...",              // MUST
    "suggestion": "...",
    "failureKind": "implementation", // 新失败报告填写原因分类
    "failureReason": "源码与调用方证据",
    "impact": "...",                   // 可选：影响到的 AC-N，供 Phase 4 交叉对账
    "reason": "...",                   // 可选：根因分析
    "project": "userlive",             // 可选：跨仓时声明问题所属仓库
    "repoPath": "D:/workfile/userlive" // 可选：跨仓时声明修复点仓库路径
  }],
  "summary": { "blockerCount": 0, "warningCount": 0, "suggestionCount": 0 }  // MUST
}
```

顶层仅接受 schema 声明的字段（含 phase/reviewedAt/fixRound/coverage）；
`issues[]` 内为 `additionalProperties: true`，可携带 `impact`/`reason`/`project`/`repoPath`
供 Phase 4 交叉对账与 fix-loop 跨仓定位消费。

## 常见失败与对策

- **WARNING 级问题带病过关**：本门控只看 BLOCKER。但如果 WARNING 的 `impact` 里写了「影响 AC-3」，
  而 Phase 4 把 AC-3 判 passed，**Phase 4→5 会以 `review_acceptance_conflict` 阻断** ——
  所以填 `impact` 不是可选的礼貌，它是下一道门控的输入。见 [phase-4.md](./phase-4.md)。
- **顶层多写字段被拒**：字段以实际 Schema 为准，reviewedAt 和 coverage 已声明，不能另加 findings 等别名。

## 覆盖契约

新建流程的 reviewCoverageRequired=true，由建流脚本设置。报告 coverage.version=1，repositories 按 Story 的 repos.json 全量登记。
每仓保留范围脚本输出的 root/head/base/files，每文件填写 reviewed+evidence 或 skipped+reason；跳过项会转述为 warning。
报告生成后源码或暂存区变化必须补审。未关闭问题使用仓库根相对路径和有效行号，跨仓填 project；lineVersion 可指定 worktree/index/base，避免部分暂存时错用版本行号。
旧流程缺少该状态开关且报告未携带 coverage 时沿用旧门控；一旦提交 coverage 即校验，不把无记录的历史审查当作已完成覆盖核验。
门控只能检查覆盖记录与当前文件一致，判断与跳过理由的真实性仍需审查师负责。
