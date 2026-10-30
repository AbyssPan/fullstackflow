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

## 审查力度与收敛

默认只做一轮完整范围审查，先核对变更意图、AC 和影响面，再查证候选问题；不为“再找几个问题”重复全量审查。权限、支付、数据迁移、公共接口、CI/发布或跨模块变更深入核对相关调用链、失败路径及回滚条件，记录未确认风险。风险决定查证深度，不减少文件覆盖，也不改变人工授权要求。
存在项目 `REVIEW.md` 时读取适用范围的规则；没有则沿用现有约定，不强制创建。规则应聚焦具体故障与证据，不能覆盖门控或放宽 AC。
已通过的 lint/类型/构建/功能检查先按 verification.md 核验证据，不重复执行同一检查；只有证据缺失、失效或定位具体候选问题确需运行时才补查。代码审核不承担完整 AC 功能验收，静态结论不能宣称运行通过。

## 查证与规则

按快照 rules 读取 [规则索引](references/rules/README.md) 中对应正文；`frontend.md` 指 [前端复核](references/frontend.md)，`config-and-data.md` 指 [配置与数据](references/config-and-data.md)。通用规则始终覆盖专项未涉及的维度。
TS/JS 先判断运行端，不能把 React 规则用于 Node 服务；Vue/小程序只取语言通用项并叠加自身框架规则。
后端调用 `use_skill("backend-tech-spec")`，前端调用 `use_skill("frontend-tech-spec")`。项目明确规范优先于默认规范，禁止把风格偏好自动升级成功能缺陷。

逐文件完成一轮审查，可按相关接口、组件和配置成组读取上下文。重点检查本次变更引入的问题，包括删除和重命名导致的调用方失效；读到的历史缺陷不能无依据归因于本次任务。
形成候选问题后查证：触发条件、真实数据流、现有防护、实际影响和可执行修复方向。上下文不足先查源码，不把猜测直接转成 WARNING。
问题定级：已证实的功能错误、安全或数据损坏为 BLOCKER；有具体依据的风险/性能/规范问题为 WARNING；低影响维护建议为 SUGGESTION。复核是否重复、是否已有防护、是否忽略项目约定，再写入报告。每个问题给出文件/位置、触发条件、实际影响及源码或运行证据；证据写入 description/notes，影响 AC 时填写 impact。同根因问题合并说明全部受影响位置，不反复提出已解决或有证据驳回的问题；出现新证据才重新打开。纯风格、格式、顺手重构建议默认不报告，不为了凑数制造 SUGGESTION。历史问题明确标注，除非证明与本次变更有关，否则不阻断本次交付。
用户摘要先报未解决问题数量，无问题明确写“未发现需修复的问题”，并列出覆盖缺口；不能将零发现表述为功能已验证。

## 覆盖与输出

每个快照文件追加 `status: reviewed` 与简短 `evidence`（查了哪段变更、关联入口及结论），或 `status: skipped` 与具体 `reason`。禁止只为满足门控批量标 reviewed。每个跳过项在最终报告说明其影响；理由存在不代表风险已解决。
工作流报告沿用 code-review.json，新增 `coverage: { version: 1, repositories: [各仓快照与审查记录] }`。快照的 root/head/base/fingerprint 原样保留，不能为了通过检查覆盖旧证据；内容变化后重新审查受影响文件并刷新快照。
问题 file 统一为仓库根相对路径，跨仓必须填 project。行号缺省指工作区，整个文件删除时指 base；仅暂存内容的问题填 lineVersion=index，删除片段可填 lineVersion=base，普通问题可显式填 worktree。固定问题保留旧 ID/位置，以 status 记录解决情况。
现有 issues/summary 契约不变，详细字段见 `scripts/schemas/code-review.schema.json`。规则定位写入 notes，例如 `rule: java.md / Logic Error Detection`，不在用户报告中加入外部项目介绍。
新工作流 Phase 3 门控核对仓库、文件覆盖、指纹和未关闭问题位置；旧工作流未含 coverage 时保持原行为。机械校验只保证范围与记录一致，不能证明审查判断正确。

## 修复回路

读取上一轮问题和 fix-verification，逐项确认修复与新增影响。未变文件可复用同版本证据，变更或依赖变化的文件重审。重新快照后核对所有文件的覆盖状态，不能只看原 BLOCKER 文件。
只产出审查结果，源码修复交 Phase 2；仍采用现有 fix-loop 预算与状态推进命令。默认初审加最多 2 轮修复复核，不另外叠加固定轮数的全量审核；预算用尽转人工重新评估方案。复查聚焦修复、新增 diff 与受影响依赖，但完整 coverage 清单仍须核对；相关依赖变化也会使未改文件的旧结论失效。
