# Phase 4 — 功能测试

> 新工作流默认 `verificationMode=ask`。进入本 Phase 时，`dispatch.js` 返回
> `blocked` + `recovery.type=verification_choice_required`，主 Agent 主动询问用户是否执行独立测试，
> 等待回答后执行对应 `recovery.options[].command`，再重新 dispatch。
> 选择 `full` 则执行测试；选择 `review-only` 则直接推进，本 Phase 记为 `skipped`。
> 未回答时不得测试或推进。已有明确选择、恢复会话或测试返修时不重复询问。
> 旧状态缺少该字段时保持原 full 行为。该选项不改变代码审查、项目原有 lint/编译配置和 git hook。

> 门控实现：`services/policy.js` → `checkPhase4Gate()` / `crossCheckReviewVsAcceptance()` /
> `checkEvidenceQuality()` / `checkContractRegression()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`test-engineer`**（测试工程师）。逐条验证 `acceptance-criteria.json` 中的 AC
是否通过，产出 `test-report.md` + `acceptance-verification.json`。

执行前按 [验证与交付](../verification.md) 核验开发/审查阶段原始运行证据。AC 断言、相关版本、环境和数据前提均一致时可复用并注明来源；补测未覆盖或失效项与受影响回归，高风险路径补充独立验证。独立验收仍覆盖全部 AC，静态审核通过不能替代功能测试，不机械重复所有测试层次。

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
| `testType=ui/api` + `passed` + `evidenceType=static` | BLOCKER (2) | `static_evidence_for_ui_ac` |
| code-review 中 `open` 的问题自称影响某 AC，而该 AC 判 `passed` | BLOCKER (2) | `review_acceptance_conflict` |
| result 缺 `id` / 缺 `evidence` | BLOCKER (2) | `av_missing_id` `av_missing_evidence` |
| 某条 AC 完全没有对应验收结果 | BLOCKER (4) | `ac_missing_verification` |
| 缺 `results` 数组 | BLOCKER (4) | `ac_verification_failed` |
| 任一 AC `status=unverifiable` | WARNING（不阻塞） | — |
| 非 ui/api 型 + `passed` + `evidenceType=static` | WARNING（聚合成一条） | — |
| Spec-Anchored 契约回归异常 | WARNING | — |
| `open-questions.json` 仍有未 resolve 项 | WARNING | — |

有 `failed` 时按 `failureKind` + `failureReason` 分流：需求→P0、规划→P1、实现→P2、
环境/验证方法→P4，unknown 先补证据。仅实现错误启用 `fixLoopAvailable`。
修复机制见 [phase-3.md](./phase-3.md)，测试来源预算独立计数（`state.maxTestFixRounds`，默认 2）。

## 证据强度门控的设计取舍

`evidenceType` 声明证据从哪来，门控按 AC 的 `testType` 分级严格程度：

- **交互型断言（点击 / 禁用态 / 弹窗 / 勾选）读代码读不出来，只能实跑** → `ui` 型硬阻塞。
- `api` 型断言同样要求真实接口或运行证据；仅 static 的 passed 会被阻断。其他类型的 static passed 为 WARNING。
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
    "evidence": ["截图/日志路径或描述"],       // MUST: 至少 1 条
    "failureKind": "implementation",         // failed 时填写
    "failureReason": "失败原因与证据"
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
