---
name: "kb-update"
description: "提交前增量维护同仓知识库：定位源码与文档变化，沉淀业务规格、实现、经验及设计来源，核对规格偏差，记录域级审查回执。用于更新知识库、同步知识库和 Phase 5 交付前准备。Phase 6 只核验合入版本。"
---

# kb-update — 提交前知识维护

知识库固定为目标项目 `.docs/llm-knowledge/`，与代码同仓、随分支切换；不建立按分支命名的知识目录。脚本以 cwd 为项目根。

首次接入、多人协作、回执记录和 hook/CI 安装时，读取 [同仓知识维护](references/maintenance.md)。它是知识职责、规格生命周期、分支规则和提交时机的唯一说明。

## 授权与时机

Phase 5 在 git add/commit/MR 之前执行；独立请求“更新知识库”同样适用。本次已授权就直接执行；否则先说明读取/生成成本，询问更新或延期，未答复等待。Phase 0 初始化不代表后续所有更新都获授权。Git 提交、push、MR 和服务端配置继续遵循当前会话已有授权，不把知识生成当作外部写入授权。

缺库时不在提交阶段重新初始化，记录缺库状态。用户拒绝正文更新时，明确受影响知识尚未同步；若同意登记延期，用 `deferred` 回执记录原因并遵守项目策略。未获得延期写入授权时仅留任务记录，不能宣称严格合并检查通过。

Phase 6 不再生成正文；发现遗漏时回到功能分支补充 MR，不能直接改主分支掩盖差异。

## 1. 获取增量计划

```bash
node "<skill_dir>/kb-update.cjs" --story <storyId>
node "<plugin_root>/skills/gen-project-docs/gen-docs.cjs" --story <storyId>
```

独立更新可省略 --story。前者可能刷新源码索引，确认本次更新授权后才运行。后者只读。

- `affectedDomains` / `commonFiles`：相关业务域与公共变更。
- `maintenance.pending`：按域回执检测的来源变化、文档变化或未核实范围；新增和删除文件均参与。
- `unclassifiedFiles` / `reviewFiles` / `errors`：未归属、依赖不明确与失败信息，必须明确处置，不能当作无变化。
- `designDocs`：待合并的原型来源。优先明确域归属，保留目标人工内容；处理成功后才更新 design_docs 的 source_hash。

前端沿 import、后端沿实际类型引用查找影响面；索引仅作线索，源码验证后将共享依赖通过 record 的 --source 登记到消费者 scope。原始索引留在磁盘，读取有限匹配，不整段注入上下文。

## 2. 更新正文与规格

只读受影响文件、相关文档章节及必要依赖。优先更新已有域 overview，复杂内容才拆到 api/models/flows/pages/store 等；保留 `CUSTOM` 手工块和 custom/ 文档，不为每个类生成单独文档。

- 实现事实：根据当前分支源码更新。
- 业务意图：提炼已确认需求和验收条件，写入域级 specs 并引用 Story；不把未确认讨论当作规格。
- 决策与经验：记录原因、适用范围和证据，更新 decisions/pitfalls 或 common 的权威位置。
- 规格偏差：列出规格/实现位置和影响，明确修代码、批准更新规格或延期。不得自动用代码覆盖业务意图。
- Patch：写明替代范围，与主规格双向引用；退役文档保留历史入口和后继方案。

`designDocs.action=index_only` 只补设计索引，`merge` 合并内容并保留手工修改。来源不明的历史 Story 不套用本次业务域。需求和验收结论按长期价值提炼，不复制整个任务目录。

## 3. 记录核实结果

新接入项目使用 maintenance.json 和按域回执；按 [同仓知识维护](references/maintenance.md) 调用独立 record 命令，状态为 updated / unchanged / deferred，必须写原因与规格审查结果。每个实际受影响 scope 都要处置；--source 补充经源码验证的共享依赖。回执只记录审查声明和文件摘要，不代替审查。

维护模式不再每次改全局 git.hash/doc_stats/log.md。meta.yaml 只在域映射、导航、设计来源确有变化时更新；变更记录由脚本独立写入 changelog/。记录后只暂存任务相关文件，再运行 `check --staged --strict`。

已有旧库尚未接入时保留原 git.hash 增量基线和 CUSTOM 内容，明确其未具备合并一致性校验。可迁移安装运行时、逐域核实并记录回执；不把旧 hash 相等当作新检查通过。更新失败不前移旧 hash，也不能生成通过回执。

## 4. 交付

代码、知识、域回执和本次 changelog 一起进入 MR。汇报受影响域、正文变化、规格决策、延期/未知范围以及检查结果。索引刷新不是文档同步，生成命令成功不是语义正确。目标分支变化或返修后重新检查受影响证据。
