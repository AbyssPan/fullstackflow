# 8 Phase 流水线索引（按需读取）

> 本目录从 `harness-conductor/SKILL.md` 与已删除的 `harness-run/SKILL.md` 附录 A/B/D 外移。
> **不要整目录通读**：`advance-phase.js` 在 Phase N→N+1 报门控失败时，只读 `phase-N.md`。

## 总表

| P | 名称 | Agent 注册名 | 产出物 | 出门门控实现 |
|---|------|-------------|--------|------------|
| 0 | 需求分析 | `requirement-analyst` | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` （+`prototype-analysis.md` 条件性） | `checkPhase0Gate` |
| 1 | 任务规划 | `task-planner` | `task-dag.md` `task-dag.json` （+`figma-frame-inventory.json` 条件性） | `checkPhase1Gate` |
| 2 | 代码开发 | `fullstack-developer` | 代码变更（git diff） | `checkPhase2Gate` |
| 3 | 代码审查 | `code-reviewer` | `code-review.json` | `checkPhase3Gate` |
| 4 | 功能测试 | `test-engineer` | `test-report.md` `acceptance-verification.json` | `checkPhase4Gate` |
| 5 | Git 提交 | `release-assistant` | commit + push + MR | 仅产出物存在性 |
| 6 | 知识库更新 | `release-assistant` | meta.yaml 刷新；未初始化且用户拒绝时记录 `skipped_by_user` | `checkPhase6Gate` |
| 7 | 发布收尾 | `release-assistant` | 前端：部署 URL + 构建号；后端：合并分支 + 变更清单（跳过云端部署） | 仅产出物存在性 |
| 8 | —（终态） | — | 流程结束 | — |

产出物清单唯一信源：`lib/state.js` 的 `PHASE_ARTIFACTS`。
Phase→Agent 唯一信源：`lib/state.js` 的 `PHASE_AGENTS`，由 `dispatch.js` 以 `nextAgent` 输出。
**Spawn 必须用注册名**（表中反引号内的英文），传中文 label 无法解析到 Agent。

## 每个 Phase 都会跑的三道通用检查

`runGateCheck(storyId, phaseNum, state)` 在进入 Phase 专属检查之前固定跑：

1. **产出物存在性** `checkPhaseArtifact` — 缺失即 BLOCKER（`artifact_missing`, level 4）。
   `optional: true` 的产出物不因缺失失败；`requiredWhen: 'hasFigmaDesign'` 的按状态位转必需。
2. **JSON Schema 校验** — 按 `schema-validator.js:getPhaseArtifacts(phaseNum)` 逐项校验，
   不符即 BLOCKER（`schema_validation_failed`, level 2）。fail-closed，不降级放行。
3. **资源完整性** `checkResourceIntegrity` — 只在 phaseNum=3 时执行：
   开发阶段 kb-query / graphify 调用为 0 → WARNING（记 debt，不阻断）。

## Story 目录结构

```
<PROJECT_ROOT>/.codebuddy/plans/<storyId>/
├── e2e-state.json          # 工作流状态（phase 唯一信源，仅脚本可写）
├── story-input.json        # 原始输入（mode + sources，由入口 skill 写）
├── repos.json              # 仓库注册表（story 级独立）
├── trace.jsonl             # 全链路审计
├── dev-pass.json           # 开发通行证（仅 Phase 2 存在，脚本自动管理）
├── phase-N-summary.md      # Phase 上下文摘要（脚本自动生成）
├── fix-request.json        # 修复回路请求（--fix-loop 生成）
├── fix-context.md          # 修复回路上下文（--fix-loop 生成）
├── archive/
│   ├── round-{N}/          #   终态归档
│   └── *.archived          #   --rollback / --fix-loop 归档
└── ...                     # 各 Phase 产出物
```

## 恢复级别

blocker 的 `level` 决定恢复策略，由 `policy.js` 判定，主 Agent 不参与选择：
1 = 自动修复、2 = 提示修复、3 = 降级、4 = 人工。
