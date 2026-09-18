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
| 变更记录 | `changelog/<内容摘要>.json`；record 自动生成独立条目，不再多人追加一个 log.md |

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
