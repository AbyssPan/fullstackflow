# Phase 3 — 代码审查

> 门控实现：`services/policy.js` → `checkPhase3Gate()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`code-reviewer`**（代码审查师）。审查本 Story 的代码变更（git diff），
产出 `code-review.json`。若 Story 目录下存在 `fix-request.json`，说明这是修复回路的复查，
需做**增量审查**而非全量重审。

## 产出物

| 文件 | 契约 | 说明 |
|------|------|------|
| `code-review.json` | ✅ | 唯一产出物（`code-review.md` 已废弃） |

## 出门门控（Phase 3→4）

| 检查 | 级别 | failureType |
|------|------|-------------|
| 存在 `severity=BLOCKER` 且 `status=open` 的 issue | BLOCKER (2) | `code_review_blocker` |
| `code-review.json` 解析失败 | BLOCKER (4) | `code_review_blocker` |
| 修复回路复查缺 `fix-verification.json` | WARNING | — |
| `fix-verification.json` 中有 `status=skipped` 的修复项 | WARNING | — |
| `fix-verification.json` 解析失败 | WARNING | — |

门控唯一信源是 `issues[].status`：只有 `BLOCKER` + `open` 组合会阻断。
把 BLOCKER 改成 `fixed` / `skipped` 即可放行 —— 因此 `status` 的诚实性由审查师负责，不由门控保证。

失败时 `result._meta` 会带 `fixLoopAvailable: true` / `fixLoopSource: 'phase3'` /
`fixLoopHint`，`dispatch.js` 据此把 `status` 输出成 `fix_loop`。

## 修复回路（fix-loop）

主 Agent 只执行 `dispatch.js` 给的 `recovery.command`，全程由 `advance-phase.js --fix-loop` 编排：

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
    "impact": "...",                   // 可选：影响到的 AC-N，供 Phase 4 交叉对账
    "reason": "...",                   // 可选：根因分析
    "project": "userlive",             // 可选：跨仓时声明问题所属仓库
    "repoPath": "D:/workfile/userlive" // 可选：跨仓时声明修复点仓库路径
  }],
  "summary": { "blockerCount": 0, "warningCount": 0, "suggestionCount": 0 }  // MUST
}
```

顶层 `additionalProperties: false`（storyId/issues/summary 之外的顶层字段会被门控拒绝）；
`issues[]` 内为 `additionalProperties: true`，可携带 `impact`/`reason`/`project`/`repoPath`
供 Phase 4 交叉对账与 fix-loop 跨仓定位消费。

## 常见失败与对策

- **WARNING 级问题带病过关**：本门控只看 BLOCKER。但如果 WARNING 的 `impact` 里写了「影响 AC-3」，
  而 Phase 4 把 AC-3 判 passed，**Phase 4→5 会以 `review_acceptance_conflict` 阻断** ——
  所以填 `impact` 不是可选的礼貌，它是下一道门控的输入。见 [phase-4.md](./phase-4.md)。
- **顶层多写字段被拒**：如加了 `reviewedAt` 之类。放进 `issues[]` 内或删掉。
