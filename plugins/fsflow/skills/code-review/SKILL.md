---
name: code-review
description: 对明确 Git 范围执行前后端代码审查，匹配规则、查证跨文件影响并记录逐文件覆盖与版本证据。用于独立审查和工作流 Phase 3，不修改业务源码。
---

# 代码审查

## 输入与范围

读取 AC、task-dag、development-notes、repos.json 和已有审查/修复记录。独立审查没有这些文件时以用户范围和仓库约定为准，不强行创建工作流。
读取 [影响面分析](../harness-conductor/references/代码检索规范.md) 与 [验证与交付](../harness-conductor/references/verification.md)。

1. 对 repos.json 每个仓库运行本技能的 `scripts/review-scope.cjs --repo <绝对根路径> --project <仓库键>`，得到文件清单、规则提示和内容指纹。只依赖 Node.js 和 Git，无安装步骤。
2. 默认覆盖 HEAD 之后的暂存、未暂存、未跟踪文件。若任务含已提交变更，先确认比较起点，计算 merge-base 或选定父提交后用 `--base <ref>`；不可用当前 HEAD 把已提交任务变更排除。
3. 脚本仅排除 `.codebuddy/plans/` 运行产物。其他文件包括配置、删除、二进制、锁文件、子模块均进入清单，按实际情况审查或记录具体跳过原因。仓库不可读、冲突未解决时报告阻塞，不能伪造空清单。
4. 分别读取 `git diff <base> -- <file>`、`git diff --cached <base> -- <file>`，未跟踪文件直接读取。暂存删除又同名新建时两种内容都检查；符号链接不跟随至仓库外；子模块需在对应仓库另审，否则标明未覆盖。

## 查证与规则

按快照 rules 读取 [规则索引](references/rules/README.md) 中对应正文；`frontend.md` 指 [前端复核](references/frontend.md)，`config-and-data.md` 指 [配置与数据](references/config-and-data.md)。通用规则始终覆盖专项未涉及的维度。
TS/JS 先判断运行端，不能把 React 规则用于 Node 服务；Vue/小程序只取语言通用项并叠加自身框架规则。
后端调用 `use_skill("backend-tech-spec")`，前端调用 `use_skill("frontend-tech-spec")`。项目明确规范优先于默认规范，禁止把风格偏好自动升级成功能缺陷。

逐文件完成一轮审查，可按相关接口、组件和配置成组读取上下文。重点检查本次变更引入的问题，包括删除和重命名导致的调用方失效；读到的历史缺陷不能无依据归因于本次任务。
形成候选问题后查证：触发条件、真实数据流、现有防护、实际影响和可执行修复方向。上下文不足先查源码，不把猜测直接转成 WARNING。
问题定级：已证实的功能错误、安全或数据损坏为 BLOCKER；有具体依据的风险/性能/规范问题为 WARNING；低影响维护建议为 SUGGESTION。复核是否重复、是否已有防护、是否忽略项目约定，再写入报告。

## 覆盖与输出

每个快照文件追加 `status: reviewed` 与简短 `evidence`（查了哪段变更、关联入口及结论），或 `status: skipped` 与具体 `reason`。禁止只为满足门控批量标 reviewed。每个跳过项在最终报告说明其影响；理由存在不代表风险已解决。
工作流报告沿用 code-review.json，新增 `coverage: { version: 1, repositories: [各仓快照与审查记录] }`。快照的 root/head/base/fingerprint 原样保留，不能为了通过检查覆盖旧证据；内容变化后重新审查受影响文件并刷新快照。
问题 file 统一为仓库根相对路径，跨仓必须填 project。行号缺省指工作区，整个文件删除时指 base；仅暂存内容的问题填 lineVersion=index，删除片段可填 lineVersion=base，普通问题可显式填 worktree。固定问题保留旧 ID/位置，以 status 记录解决情况。
现有 issues/summary 契约不变，详细字段见 `scripts/schemas/code-review.schema.json`。规则定位写入 notes，例如 `rule: java.md / Logic Error Detection`，不在用户报告中加入外部项目介绍。
新工作流 Phase 3 门控核对仓库、文件覆盖、指纹和未关闭问题位置；旧工作流未含 coverage 时保持原行为。机械校验只保证范围与记录一致，不能证明审查判断正确。

## 修复回路

读取上一轮问题和 fix-verification，逐项确认修复与新增影响。未变文件可复用同版本证据，变更或依赖变化的文件重审。重新快照后核对所有文件的覆盖状态，不能只看原 BLOCKER 文件。
只产出审查结果，源码修复交 Phase 2；仍采用现有 fix-loop 预算与状态推进命令。
