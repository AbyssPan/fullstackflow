# Phase 2 — 代码开发

> 门控实现：`services/policy.js` → `checkPhase2Gate()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`fullstack-developer`**（全栈开发工程师）。按 `task-dag.json` 的批次执行开发任务（前端 / 后端 / DB 均可）——
同一 batch 内的任务可并行 Spawn 多个开发 Agent，batch 之间串行。

`mode=fixbugs` 时 prompt 会额外注入「修复方案自行设计」说明：bug 分析报告只给事实，
怎么改由开发工程师用 `kb-query ∥ graphify` 双源验证后自行决定。

## 产出物

代码变更（git diff）。`PHASE_ARTIFACTS[2].fileName` 为 `null`，因此**产出物存在性检查被跳过** ——
这正是历史上 Phase 2→3 等价于无条件通过的原因，现由 `checkPhase2Gate` 的增量 lint 补上。

## dev-pass 生命周期（AI 无需手动管理）

```
Phase 1→2: 脚本自动签发（限域到 task-dag.json 的 files[]）
Phase 2→3: 脚本自动撤销（主撤销点）
Phase 4→5: 脚本自动兜底撤销（防 fix-loop 残留，幂等）
```

| 操作 | 命令 | 场景 |
|------|------|------|
| 手动续签 | `node $HARNESS/advance-phase.js <storyId> 2 --renew-pass` | 开发超过 2h，dev-pass 过期 |
| fix-loop 重签 | 自动（`--fix-loop` 内部处理，限域到 `affectedFiles`） | 审查/测试失败回退开发 |

## 出门门控（Phase 2→3）

| 检查 | 级别 | failureType |
|------|------|-------------|
| 变更文件（`.js/.jsx/.ts/.tsx/.vue`）存在 lint error | BLOCKER (2) | `lint_error` |
| 前端本地编译失败（**仅当 `HARNESS_RUN_BUILD=1`**） | BLOCKER (2) | `build_failed` |
| 后端本地编译失败（变更含 `.java/.xml/.sql` 等后端文件且 `HARNESS_RUN_BUILD=1`；Maven 走 `mvn -q compile -DskipTests`，Gradle 走 `gradle compileJava -x test`） | BLOCKER (2) | `build_failed` |
| `repos.json` 里的仓库路径不存在 | WARNING | — |
| 找不到可用的 eslint | WARNING | — |
| 未识别到后端构建体系（无 pom.xml / build.gradle） | WARNING | — |
| 未检测到未提交变更 | WARNING | — |
| 编译校验处于关闭状态 | WARNING（每次都提示一次） | — |

**增量 lint**：只 lint `git status --porcelain` 列出的变更文件，用 `npx eslint --format compact`。
只 lint 变更是为了不让仓库存量 lint 债永久卡住门控；用 `npx` 而非 `npm run lint` 是为了保证
门控绝不会 `--fix` 改动代码。多仓库时按 `repos.json` 逐仓执行。
**后端仓库**（Java 等）无 eslint 可跑，质量由后端编译校验 + Phase 3 的 ocr 工具审查兜底。

自动修复通道：`node $HARNESS/advance-phase.js <storyId> 3 --lint-fix`
会按 `task-dag.json` 涉及的仓库逐个执行 `eslint --fix`。

### 编译校验为什么默认关闭

构建无法增量，大项目/多项目单次耗时不可控（上限 900s），且 fix-loop 每轮回退 Phase 2 都会
再触发一次全量构建 —— 这是流程阻塞的主因。因此默认只跑 lint（增量的、快的）。

**代价**：SCSS/模板编译错误失去本地拦截，只能到 Phase 7 云端构建才暴露。历史案例：
SCSS `/deep/ ... ::after` 编译错误逃过全部本地门控。

```bash
# 需要本地编译校验时显式启用（按 build:dev → build:test → build 取第一个存在的 script）
HARNESS_RUN_BUILD=1 node $HARNESS/advance-phase.js <storyId> 3
```

> 建议：只在明确需要时才在项目 `package.json` 补一个更快的 `build:dev`，门控会自动优先选它，
> 避免一开就退化成生产构建。

## 常见失败与对策

- **编辑 `src/` 被 hook 拒绝**：检查三件事 —— 当前是否 Phase 2、dev-pass 是否存在且未过期（2h）、
  目标文件是否在 `files[]` 限域内。详见 `../api/hooks.md`。
- **lint error 卡住但问题在存量代码**：门控只 lint 变更文件；若确实是变更文件的存量问题，
  先 `--lint-fix`，剩余的手工修 —— 不要绕过门控。
- **fix-loop 反复回到本 Phase**：默认每个失败源各 2 轮预算（review / test 独立计数），
  用尽后 `dispatch.js` 输出 `status: blocked` 且 `recovery.command` 为 null → 转人工。
