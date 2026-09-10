# lib/ — 基础库 2 个脚本（AI 不直接调用）

> 根路径：`${CLAUDE_PLUGIN_ROOT}/scripts/lib/`
> 被 `commands/` `services/` `hooks/` 全线 require。改这里影响面最大。

## state.js — 状态、常量、契约读取的唯一信源

`PROJECT_ROOT` / `PLANS_DIR` 是**模块加载期求值**的（读 `CODEBUDDY_PROJECT_DIR`，
回退 `CLAUDE_PROJECT_DIR`）。测试沙箱必须在 `require` 之前设好这两个环境变量，
只设其中一个会导致沙箱失效、读到真实项目目录。

### 路径与 Phase 常量

| 导出 | 说明 |
|------|------|
| `PROJECT_ROOT` `PLANS_DIR` | 项目根 / `.codebuddy/plans` |
| `DEV_PASS_TTL` | dev-pass 有效期（2h） |
| `PHASE_SLUGS` `PHASE_NAMES` | 0~8 的英文 slug / 中文名，索引 8 是终态 |
| `PHASE_ARTIFACTS` | **产出物清单唯一信源**，门控 / prompt / summary 都从此读 |
| `PHASE_AGENTS` `getPhaseAgent(phase)` | **Phase→Agent 唯一信源**，`agent` 是注册名，`label` 仅供人读 |

### 仓库注册表（repos.json，story 级独立）

`getDefaultRepoName` `getReposFilePath` `loadRepos` `ensureReposJson` `getRepoRoot` `getRepoForFile`

多仓库唯一真实信源 = story 级 `repos.json`，**不依赖任何宿主环境变量**
（`CODEBUDDY_WORKSPACES` / `CLAUDE_WORKSPACES` 均非官方变量）。

### Story 目录 / 路径判断 / stdin

`getStoryDir` `ensureStoryDir` `listStoryDirs` `cleanStoryDir` · `isSrcFile` `isStateFile` · `readStdin`

### 状态文件 CRUD

`readStateFile` `writeStateFile` `findActiveWorkflows` `hasActiveWorkflow`
`isPhaseCompleted` `getPhaseSlug` `getPhaseName`

`writeStateFile` 是 `e2e-state.json` 的唯一合法写入通道 —— `enforce-state-file.js`
会拦截 AI 对该文件的直接写操作。

### 产出物与输入判定

| 导出 | 说明 |
|------|------|
| `checkPhaseArtifact(storyId, phase, state)` | 产出物存在性；传 state 以启用条件必需项 |
| `isPrototypeRequired(storyId)` | `{ required, reason }`；fixbugs 恒 false；**无 story-input.json 时保守返回 true** |
| `detectFigmaSource(storyId)` | `{ hasFigma, urls, reason }`；信源是 `sources.figmaUrls` |
| `findBugAnalysisReports(storyId)` | 按 `*bug分析报告.md` 后缀匹配（文件名含动态标题，进不了 PHASE_ARTIFACTS） |
| `hasFigmaDesign(state)` | 读 `state.hasFigmaDesign` 硬门控开关 |
| `checkFigmaFrameInventory` `validateTaskFigmaReferences` | frame 清单完整性 / task 引用有效性 |
| `getTasksRequiringFigma` `hasTaskRequiringFigma` | 识别需要 Figma 的 task（支持目录级 glob） |
| `checkRequirementDoc` `checkTaskDAGDoc` | md 型产出物检查 |

### 契约 JSON 读取与校验

文件名常量：`ACCEPTANCE_CRITERIA_FILE` `OPEN_QUESTIONS_FILE` `TASK_DAG_JSON_FILE`
`ACCEPTANCE_VERIFICATION_FILE` `FIGMA_FRAME_INVENTORY_FILE` `STORY_INPUT_FILE`

读取与校验：`readStoryInput` `getStoryMode` `readJsonArtifact` `checkAcceptanceCriteria`
`checkOpenQuestions` `checkTaskDagJson` `validateContractReferences`
`checkAcceptanceVerification` `getDevPassAllowedPaths`

`getStoryMode(storyId)`：优先 `story-input.json` 的 `mode`，回退 `e2e-state.json` 的 `mode`，
都没有则 `'run'`。解析失败（`_parseError`）时也走回退。

### dev-pass 管理

`issueDevPass` `revokeDevPass` `checkDevPass` `renewDevPass` —— 全部由
`advance-phase.js` 自动调用，AI 无需关心时机。

### 修复回路配置与结构化错误

`DEFAULT_MAX_REVIEW_FIX_ROUNDS` `DEFAULT_MAX_TEST_FIX_ROUNDS` `getMaxFixRounds(sourcePhase)`
—— review 与 test **各 2 轮独立预算**，缺省 sourcePhase 走 review 预算。

`structuredError(type, message, level, resolution)` `errorToString` `errorToType`
—— blocker 的统一构造与解构。

## trace.js — 全链路审计（trace.jsonl）

```js
{ appendTrace, traceAgentSpawn, traceAgentResult, traceToolCall, traceAgentMessage,
  traceGitEvent, traceGateDecision, tracePhaseTransition, traceErrorRecovery, traceExperience }
```

写 `<storyDir>/trace.jsonl`，供调试 / 审计 / 经验沉淀。也有 CLI 入口供手工记录 Agent 事件。

持久化顺序约定：`writeStateFile` **先于** trace 写入，确保 trace 不会领先于 state。
trace 写入失败不阻塞任何流程。

`checkResourceIntegrity`（policy.js）就是读 trace 判断开发阶段是否调用过 kb-query / graphify。
注意子 Agent 的 tool_call 不会写进主流程的 trace.jsonl —— 这是 Figma MCP 消费检查被移除的原因。
