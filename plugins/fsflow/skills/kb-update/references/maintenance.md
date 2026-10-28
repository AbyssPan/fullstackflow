# 同仓知识维护

适用于初始化、提交前更新、MR 审查与合并后的核验。知识与源码同仓，所有分支使用 `.docs/llm-knowledge/`，随 Git 分支自然切换：每个分支上的知识只与该分支的代码对应，集成分支上的知识表示各自的集成状态。目标分支以本次任务和项目规则为准，不从名称推测合并方向，不建立按分支命名的知识目录。

## 知识职责与唯一信源

保留既有域级布局，按内容需要增加文件，避免一次生成空目录或多份事实副本：

| 内容 | 位置与维护者 |
|---|---|
| 入口导航 | 根 `overview.md` 与 `meta.yaml`；只有领域结构变化才改，已有项目 AGENTS.md 只补入口链接、不覆盖规则 |
| 业务意图 | `business/<domain>/specs/`；开发者整理确认后的规则、验收条件及 Story 来源 |
| 设计与实现 | 既有 `architecture/api/models/flows/...`；源码验证后增量修改相关章节 |
| 经验与决策 | 域级 `pitfalls.md`、`decisions/`，公共约定进入 `common/`；提炼结论和适用条件，不复制全部聊天 |
| 调研与参考 | `wiki/` 人工调研，`vendor/` 按需保存外部参考的来源与版本；未确认设想不能当作生效规格 |
| 变更记录 | `changelog/<内容摘要>.json`；record 自动生成独立审查片段，已合并且被替代后可清理；历史由 Git 保存 |

一个业务规则应有稳定 ID 和权威位置，其他文档用相对链接引用。主规格的修改可拆为域内 `specs/<feature>/patches/<唯一ID>.md`，Patch 写清覆盖范围，并与被替代章节双向链接。内容稳定后收敛主规格。退役规格标明状态、后继方案与适用历史版本，保留相关域元数据作为历史入口，不直接丢弃人工知识。

实现事实以当前分支源码为准；规格描述已确认的意图。偏差列出双方位置、原因与影响，明确选择修代码、批准规格变化或延期。只有明确批准的规格变化才能写 `spec-review approved`。动态配置、DB 规则、远端 Prompt 在文档保存环境和查询锚点，按需使用已有只读工具核实生效版本；取不到时保留未知范围，不猜测。

## 项目一次接入

在目标项目根运行（初始化并完成 meta.yaml 后）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/kb-maintenance.js" install
```

它把独立运行时、配置和 CI 模板写到当前项目。团队无须安装插件即可执行检查，运行时版本随仓库一起审查。`maintenance.json` 默认 `allow_deferred: false`；只有项目明确允许延期时才改为 true。运行时升级可重跑 install；检测到本地修改则保留并报告。

需要启用本地 hook 时执行 `install --hooks`。每个 clone 单独启用，不自动改 GitLab 配置。普通已有 hook 会被备份并先执行；Husky 等管理的已有 hook 保持原样，按脚本提示接入以下命令：

```bash
node .docs/llm-knowledge/tools/fsflow-kb/commands/kb-maintenance.js check --staged
```

`uninstall-hooks` 恢复由本工具包装的原 hook；被用户修改过的 hook 不覆盖。切到尚未接入的历史分支时，本地包装器提示并跳过缺失的运行时，服务端必过检查仍是合并约束。Git 安装与配置动作沿用当前会话授权，不因为接入知识维护而重复申请已批准的操作。

索引是可重建的本机缓存，安装器添加忽略规则；已被 Git 跟踪的旧索引不会自动取消跟踪，需明确审查 `git rm --cached` 的迁移。它们不承担知识同步状态。旧 `meta.yaml.git.hash` 保留兼容字段，维护模式使用按域回执，不再每次前移全局 hash 或刷新全局计数。领域文件映射改变时才更新 meta，并在 Git 冲突中显式协调。

## 提交前闭环（Phase 5 或独立更新）

1. 先确认本次知识更新已授权。运行 `gen-docs.cjs --story <storyId>` 获取只读计划及 `maintenance.pending`，检查实际 diff、关联规格及已记录的依赖。未授权不运行会刷新索引的 kb-update 脚本。
2. 用 kb-update 更新受影响正文；把“做了什么、学到什么、规格是否偏离”分别写到上述权威位置。保留手工批注；不全量重写。原型和必要的需求/验收结论提炼后关联 Story，历史探索留在原任务。
3. 对每个已核实的 scope 记录结果。`domain:<id>` 表示业务域，`common` 表示公共知识和未归属文件。源代码归属由 meta 映射提供；跨域共享依赖把已验证的来源用重复 `--source` 显式加入消费者回执，不能把 import 线索直接当成完整调用链。

```bash
KB=.docs/llm-knowledge/tools/fsflow-kb/commands/kb-maintenance.js
node "$KB" record --scope domain:order --status updated --reason "更新取消规则及验收条件，源码与规格已核实" --spec-review aligned --source src/api/shared.ts
node "$KB" check --strict
```

`record` 只是保存本次人工/Agent 审查声明及当前源码/文档 Git blob 摘要，不能自动证明语义正确。必须先读证据、改文档，再执行；不能为消除报错而盲目重签。没有文档变化时使用 `status unchanged` 并写明原因。延期使用 `status deferred`、具体原因和 `spec-review deferred`，由项目 allow_deferred 控制是否允许合并。延期回执记录现状以识别后续变化，查询仍展示延期状态。

4. 只暂存本次任务的代码、知识、回执和变更条目。暂存后再运行 `check --staged --strict`；这会发现“工作区已更新但未提交对应源码/文档”的部分暂存问题。正常开发的 pre-commit 只拦结构错误，待核实项提示而不妨碍中间提交。
5. 在同一个 MR 中审查代码和知识，按已批准的提交、push 与 MR 操作交付。若相关文件又变化，重新核实受影响 scope。cherry-pick 必须带上对应知识与回执，并在目标分支复核；不要复制整个环境分支的知识覆盖目标分支。

## 合并检查与 Phase 6

项目 `.gitlab-ci.yml` 引用安装后的 `tools/fsflow-kb/templates/kb-gitlab-ci.yml`。维护者启用 merged results pipelines / merge trains，并将此 job 设为合并必过项；这些服务端配置不会由安装脚本自动修改。GitLab 功能可用性由所在实例/套餐决定。模板在普通 source-only MR 流水线上明确失败，避免把单分支成功当作候选合并成功。

```yaml
include:
  - local: .docs/llm-knowledge/tools/fsflow-kb/templates/kb-gitlab-ci.yml
```

CI 对候选合并提交运行 `check --ref <候选提交> --base <目标提交> --strict`。同时保护运行时、校验配置与 CI 文件的审查权限，防止修改检查本身被当作通过业务审查。不具备合并列车能力的实例可在串行合并入口运行同一命令：明确固定源/目标 SHA、构造候选合并提交、检查后原子确认目标未变再合入；普通流水线模板不能代替这一控制。

结果包含结构错误、各 scope 的 evidence_changed / not_reviewed、延期及其原因。来源摘要变化只表示需要复核；自然语言矛盾、动态配置和跨仓运行行为仍需契约测试与领域审查。未登记的语义依赖不可能仅靠摘要发现。冲突返回功能分支处理，再检查最新候选版本；不在主分支由 AI 重写知识来掩盖冲突。

Phase 6 只核验实际合入版本和提交前的更新/延期结果，不再次询问同一项更新、不生成正文。无法取得实际合入版本时明确未验证，不能拿本地旧 HEAD 代替。独立源码索引可在需要时重建；查询检测扫描版本不符会降级到当前 Git 文件及源码查证。

## Changelog 生命周期与历史查询

知识正文保存当前规则；decisions/pitfalls 保存有长期价值的原因、取舍和经验。重要决策被替代时标明后继决策，保留原文，不能只把原因放在审查片段里。`maintenance/` 每域一份最新回执是当前校验依据；`changelog/` 是随 MR 提交的审查片段，不承担长期知识正文职责。清理不会改正文、回执、配置或 Git 历史，也不会缩小已有 Git 对象库。

在发布或例行维护时，从已更新的目标分支建立维护分支，显式指定目标分支作为基线。以下 `origin/main` 是示例，请替换为实际目标分支；命令不 fetch、不自动选择主分支。基线必须是当前 HEAD 的祖先，输出包含解析后的基线 SHA。清理不能判断远端分支是否已更新，运行前应按项目流程更新远端引用。

```bash
KB=.docs/llm-knowledge/tools/fsflow-kb/commands/kb-maintenance.js
node "$KB" prune --base origin/main
node "$KB" prune --base origin/main --dry-run
# 审查 candidates / retained 后显式执行；不自动暂存或提交
node "$KB" prune --base origin/main --apply
```

前两条等价且只读。`candidates` 列出待删文件及原因，`retained` 列出保留文件及原因，`deleted` 列出实际删除文件。执行时重新计算并复核计划，与 record 共用写锁。删除后审查 diff，将指定文件的删除纳入普通维护 MR，并执行 `check --staged --strict`；不要为了清理无关日志盲目重签回执。不在 record、pre-commit 或 Phase 6 中自动清空目录。

仅在以下条件全部满足时删除：

- 片段是合法常规文件，工作区、暂存区、HEAD、指定基线中的内容和模式一致。
- 所属域仍存在，四个位置的最新回执一致，当前回执对应片段完整且未变。
- 目标分支第一父链的回执历史能确认该片段对应旧回执，且已由当前回执替代。
- 片段和当前回执都不是延期状态。

当前片段、未提交/部分暂存/未合入基线的变化、未知域、非法或无法核实的记录均保留。包含额外自定义字段的片段和知识正文仍提及其完整内容摘要的片段也保留，覆盖内联链接、引用式链接、HTML、URL 编码路径及代码示例；这是保守的引用保护，可能多保留记录。没有明确关闭关联的旧 deferred 片段，即使出现后续正常回执也保留，避免把后续审查误判为延期事项已解决。第一版不会自动推断关闭关系。被 squash 掉、从未作为回执进入目标分支第一父链的中间片段，因无法证明替代关系而保留，输出 `supersession_not_proven`。浅克隆拒绝清理，需先补全历史。

按域读取已提交回执历史，不依赖当前 changelog 片段是否还存在：

```bash
node "$KB" history --scope domain:order
node "$KB" history --scope common --ref origin/main --limit 10
```

输出提交 SHA、提交时间、提交说明、域状态、审查原因、规格审查结果和回执摘要。默认 20 条，最多 100 条，`truncated` 表示还有更早记录；可把最早一条提交的父提交作为下一次 `--ref` 继续查看。使用第一父链展示实际集成的状态变化（合并提交包含最终回执），不展开侧分支试验过程或未提交片段。域回执删除会显示 `deleted: true`。浅克隆仍可查询，但会提示历史不完整。

已有项目需从更新后的插件重新执行 `install`，以复制新增的生命周期模块和 CLI；已有运行时若被本地修改，安装器仍会保留并报错。升级不会立即清理任何片段。

### 已生成知识库的兼容边界

| 现有知识库 | 升级行为 |
|---|---|
| 已有 v1 maintenance.json、按域回执和哈希 changelog | 原格式直接兼容，不转换正文、不重命名记录、不修改摘要；从新插件重跑 install 即可使用新命令 |
| 仅有 meta.yaml、正文、旧 git.hash / log.md | 原内容保留，未安装维护模式时普通 check 仍按 legacy 模式提示；首次 install 会启用维护配置，之后要按实际证据审查并记录各域，严格检查不会自动通过 |
| 运行时存在本地修改或无法核对原安装摘要 | 升级预检报错并保留文件，不强制覆盖；先审查本地定制，再决定如何合并新运行时 |
| 缺少历史提交、只复制了当前目录或采用 squash 丢失中间回执 | 继续使用当前正文和回执；不能恢复不存在的历史，也不会为了减少文件数而推断旧片段可删除 |

升级命令必须来自**更新后的插件目录**。在项目中运行旧的 `tools/fsflow-kb/commands/kb-maintenance.js install` 只会重装旧版本，不会下载或发现插件更新。升级仅替换受管理的运行时文件、更新安装清单，并按安装器原有规则补充缺失配置/忽略项；已有配置（包括 allow_deferred）、正文、回执、changelog 和 log.md 均保留。无需仅因本次运行时升级重新生成知识或重新签署已有有效回执。`history` 只查询已提交回执，找不到时明确提示，不把旧 log.md 自动转换为审查结果。
