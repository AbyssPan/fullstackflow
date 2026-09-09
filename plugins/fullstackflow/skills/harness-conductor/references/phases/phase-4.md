# Phase 4 — 功能测试

> 门控实现：`services/policy.js` → `checkPhase4Gate()` / `crossCheckReviewVsAcceptance()` /
> `checkEvidenceQuality()` / `checkContractRegression()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`test-engineer`**（测试工程师）。逐条验证 `acceptance-criteria.json` 中的 AC
是否通过，产出 `test-report.md` + `acceptance-verification.json`。

## 产出物

| 文件 | 契约 |
|------|------|
| `test-report.md` | — |
| `acceptance-verification.json` | ✅ |

推进 Phase 4→5 时 `advance-phase.js` **兜底撤销 dev-pass**（防 fix-loop 残留，幂等操作）。

## 出门门控（Phase 4→5）

| 检查 | 级别 | failureType |
|------|------|-------------|
| 任一 AC `status=failed` | BLOCKER (2) | `ac_verification_failed` |
| `testType=ui` + `passed` + `evidenceType=static` | BLOCKER (2) | `static_evidence_for_ui_ac` |
| code-review 中 `open` 的问题自称影响某 AC，而该 AC 判 `passed` | BLOCKER (2) | `review_acceptance_conflict` |
| result 缺 `id` / 缺 `evidence` | BLOCKER (2) | `av_missing_id` `av_missing_evidence` |
| 某条 AC 完全没有对应验收结果 | BLOCKER (4) | `ac_missing_verification` |
| 缺 `results` 数组 | BLOCKER (4) | `ac_verification_failed` |
| 任一 AC `status=unverifiable` | WARNING（不阻塞） | — |
| 非 ui 型 + `passed` + `evidenceType=static` | WARNING（聚合成一条） | — |
| Spec-Anchored 契约回归异常 | WARNING | — |
| `open-questions.json` 仍有未 resolve 项 | WARNING | — |

失败（有 `failed`）时 `result._meta.fixLoopAvailable=true`、`fixLoopSource='phase4'`，
`dispatch.js` 据此输出 `status: fix_loop`。修复回路机制同 [phase-3.md](./phase-3.md)，
但预算独立计数（`state.maxTestFixRounds`，默认 2）。

## 证据强度门控的设计取舍

`evidenceType` 声明证据从哪来，门控按 AC 的 `testType` 分级严格程度：

- **交互型断言（点击 / 禁用态 / 弹窗 / 勾选）读代码读不出来，只能实跑** → `ui` 型硬阻塞。
- 集成 / 接口型 AC 若也一律阻塞，会迫使大批 AC 降级成 `unverifiable` —— 那是把门控变成墙，
  不是提高质量 → 降级为 WARNING。
- `unverifiable` **不阻塞**门控（`checkAcceptanceVerification` 已移除比例阈值）。
  给不出运行时证据时的正确做法是标 `unverifiable` + 写明环境限制，
  **而不是用 `static` 冒充 `passed`**。

## 交叉对账为什么存在

历史缺陷：`checkPhase4Gate` 从不读 `code-review.json`，`checkPhase3Gate` 只看
`severity==='BLOCKER' && status==='open'`。结果 WARNING 级问题只要不改成 BLOCKER 就能带病过关 ——
即使问题描述里明写「影响 AC-3 选品交互的正确性」，而 AC-3 同时被判 passed。
两份产出物各自自洽，合起来自相矛盾，没有任何一道门控看得见这个矛盾。
`crossCheckReviewVsAcceptance()` 就是补这个缺口，靠的是 `issues[].impact` 字段。

## 契约格式

`acceptance-verification.json`（schema: `scripts/schemas/acceptance-verification.schema.json`）
```json
{
  "results": [{
    "id": "AC-1",
    "status": "passed|failed|unverifiable",
    "evidenceType": "playwright|manual|api|static",
    "evidence": ["截图/日志路径或描述"]        // MUST: 至少 1 条
  }],
  "summary": { "total": 10, "passed": 10, "failed": 0, "unverifiable": 0 }
}
```

## 常见失败与对策

- **`static_evidence_for_ui_ac`**：不要把 `evidenceType` 改成 `manual` 糊过去。
  要么真跑一遍拿运行时证据，要么改判 `unverifiable` 并在 `evidence` 里写明环境限制。
- **`review_acceptance_conflict`**：二选一 —— 要么修那个 review 问题并把 `status` 改成 `fixed`，
  要么把对应 AC 从 `passed` 改成实际结论。不要删 `impact` 字段来消除冲突。
- **`ac_missing_verification`**：Phase 0 的 AC 与本 Phase 的 results 必须一一对应，
  新增 AC 后漏测最常触发。
