# Phase 6 — 合入版本知识核验

Agent：release-assistant。正文维护已前移到 Phase 5，规则见 [同仓知识维护](../../../kb-update/references/maintenance.md)。本阶段不再次询问同一更新、不调用 kb-update 写正文。

1. 取得实际合入目标分支和提交。知识随代码同仓合入，各分支上的知识分别与自身版本一致，集成分支保留各自集成状态。
2. 对实际提交运行 `kb-maintenance.js check --ref <提交> --strict`；不切换用户工作区。检查范围和未知信息如实报告，不能用本地旧 HEAD 代替服务器合入版本。
3. 复用 Phase 5 更新/延期选择并记录 `trace.js phase-outcome <storyId> 6 <result>`：

| result | 含义 |
|---|---|
| updated | 提交前知识更新已通过实际合入版本核验，details 附分支/提交/检查结果 |
| skipped_by_user | 先前明确延期或未初始化，附原因；不宣称知识同步完成 |
| completed_with_errors | 检查失败、实际版本不可得或旧任务尚未维护；交回功能分支补充 MR |

`checkPhase6Gate` 要求上述显式结果，以保证恢复可追踪。此任务门控不代替 GitLab 必过检查；不允许延期的项目不能用 skipped_by_user 绕过服务端要求。

不初始化、不全量生成，不前移全局 git.hash，不直接修改主分支知识。旧库未启用维护校验时明确报告限制，不把旧 hash 相等当作核验通过。索引是本机缓存，可在需要时重建，不作为同步依据。
