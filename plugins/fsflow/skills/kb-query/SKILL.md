---
name: "kb-query"
description: "渐进式分层知识库检索。三层检索：L1 overview关键词匹配定位域 → L2 meta.yaml精确筛选 → L3 按需加载文档。支持4种模式：需求拆解/技术方案/接口搜索/知识问答。自动触发：代码修改、需求分析、接口查找、技术方案、改bug、新增功能等场景。前后端支持精确定位；源码搜索与按需 LSP 验证调用方和影响面，graphify 可选。"
---

# kb-query — 渐进式分层知识库检索（全局 Skill）

"渐进式分层加载"检索策略。
数据驱动：域列表和关键词从 `overview.md` + `meta.yaml` 动态获取，不硬编码。

---

## 按需补充结构检索

默认采用 `kb-query → 源码验证 → 按需查引用`，无需安装 graphify。知识库负责业务定位、规范与历史经验；当前实现和依赖关系以源码为准。
修改共享组件、Store、公共服务/接口、公共工具，或修复涉及上游入口的 Bug 时，必须通过源码搜索和按需 LSP `findReferences` 确认调用方、直接消费者及相关间接入口，并据此列出回归项。精确局部改动无需扫描全仓。
证据随现有任务描述或交付说明记录：仓库/文件/符号、源码版本（提交号及相关未提交 diff 或文件摘要）、查证位置、已确认调用方、回归项和未确认范围。同版本、同范围证据跨 Phase 复用；工作区变化后重新核实受影响部分，不能只比较 HEAD。
graphify 仅作可选结构检索增强：已有图谱可用时，按需 `query/explain/path` 获取线索；不能把相关子图当作完整调用方清单，也不能把图路径当作已验证的运行时数据流。引用前复核源码；图谱存在不代表最新，无法确认新鲜度时直接查源码。普通定位不建图；未安装、缺图或查询失败时记录原因并改用源码搜索，不反复重试、不因工具缺失记 debt。
源码搜索未命中不等于没有调用方：必要时检查别名、动态注册、路由和配置；仍未确认的范围如实交接。审查按实际证据缺口和影响评估，不按工具调用次数判定质量。

实现事实冲突以源码为准，编码规范以知识库为准；疑似过期内容记录证据，交 Phase 6 经用户同意后更新。

---

## 检索流程

### 前后端精确定位

问题给出文件路径、组件名、类名、路由片段或表名时，先运行：

```bash
node "<skill_dir>/kb-query.cjs" "<查询词>" --limit 10
```

脚本按项目类型读取前端或后端索引，并合并当前 Git 文件清单补齐新增文件，只返回有限条匹配、所属域和文档入口，不把整个 JSON 索引加载进上下文。知识库未初始化或元数据/索引损坏时，返回 `warnings` 并继续查 Git 路径，不隐式初始化或刷新知识库。Git 清单只匹配路径，不分析文件里的新符号；符号未命中时需搜索源码。两种定位来源都不可用时返回错误，不把失败当作零命中。
前端索引包含页面、组件、API、Store 的 import 归属；后端索引包含类与注解位置。`sourceChangedSinceScan` 为 true、文件已删除或未命中时，直接用源码搜索补充证据。
返回结果是定位线索，不是完整调用链。组合路由、动态 SQL、前端导出符号或自定义路径别名未被覆盖时直接搜索源码，仍有歧义才询问用户。

业务概念问题继续走 L1-L3。

### L1: 全局总览匹配（业务问题及其他项目类型）

加载 `.docs/llm-knowledge/overview.md` 的「域地图」表。

- 提取用户问题关键词
- 与域地图的关键词列匹配 → 收敛到 1-2 个域
- 前后端无法匹配时，先查索引和源码补充证据，仍有歧义才询问

### L2: meta.yaml 精确筛选

通过脚本或文本搜索读取命中域的配置片段，不重复加载完整 `meta.yaml`。

- 在匹配到的域配置中获取文件字段（`entry_files / files / stores / apis / components`，按项目类型而异）
- 读取 `.docs/llm-knowledge/.profile.yaml` 的 `project_type`，根据查询模式和项目类型确定需加载的文档类型
- 后端有 `backend-index.json` 时，用其文件归属补充或纠正旧 meta 的源码列表；业务文档缺失时读取源码

### L3: 按需加载

| 模式 | 触发条件 | frontend | backend | plugin |
|------|---------|----------|---------|--------|
| **A-需求拆解** | PRD/需求分解为 Story | `overview.md` + `api.md` + `architecture.md` | `overview.md` + `routes.md` + `api.md` + `models.md` + `architecture.md` | `overview.md` + `entry-files.md` + `commands.md` + `schemas.md` |
| **B-技术方案** | 设计技术方案、评估改动 | `overview.md` + `pages.md` + `api.md` + `store.md` + `architecture.md` | `overview.md` + `routes.md` + `api.md` + `models.md` + `architecture.md` + `config.md` | `overview.md` + `entry-files.md` + `commands.md` + `schemas.md` + `architecture.md` |
| **C-接口搜索** | 查找特定 API / 后端入口 | `api.md` → 未命中则 `search_content` | `routes.md` + `api.md` → 未命中则 `search_content` | `commands.md` / `schemas.md` → 未命中则 `search_content` |
| **D-知识问答** | 业务概念、流程、字段含义 | `overview.md` → 按需 `architecture.md` / `pitfalls.md` / `custom/` | `overview.md` → 按需 `architecture.md` / `models.md` / `pitfalls.md` / `custom/` | `overview.md` → 按需 `entry-files.md` / `pitfalls.md` / `custom/` |

### L4: 深度搜索（兜底）

- `search_content` 在 `.profile.yaml` 的 `source_root/source_roots` 或 `meta.yaml` 的文件字段范围内搜索关键词
- `search_file` 文件名模式匹配

前后端的域文档均按需读取，L3 表中各文件是候选范围，不是一次加载清单。先读已有 `overview.md`，再按问题加载 `flows.md`、`routes.md`、`api.md`、`models.md` 或源码；公共架构与配置从 `common/` 获取。

---

## 检索策略

### ❌ 禁止
- 一次加载所有域文档
- 业务概念尚未定位时，一次读取整个代码库
- 精准定位域后仍全量搜索

### ✅ 必须
- 业务问题先读 overview.md；前后端精确定位按上述分支执行
- 通过检索结果确认归属后再加载相关文档；不要整段读取 backend-index.json / frontend-index.json
- 只读回答问题所需的章节；证据不足时再加载下一篇文档或源码
- 加载时说明命中了哪个域、哪种模式
- 后端查询不得套用 `pages.md/store.md`；优先加载 `routes.md/api.md/models.md`

---

## 执行示例

```
用户: "1v1会话转接功能怎么实现的？"

L1: overview.md → 关键词"会话""转接" → 命中 chat 域
L2: meta.yaml → chat 域 apis: csReception, oneToOne
L3: business/chat/architecture.md → 转接流程说明
L4: search_content "transfer" → 补充接口细节

输出: "TransferDialog → csReception.transferSession → WebSocket 通知刷新"
```

```
用户: "帮我拆解需求：工单列表增加导出功能"

L1: overview.md → 关键词"工单" → 命中 ticket 域
L2: meta.yaml → ticket 域 apis/stores
L3: business/ticket/overview.md + api.md + architecture.md
→ 分析现有结构 → 拆解 Story

输出:
- Story 1: 导出 API
- Story 2: 导出按钮组件
- Story 3: 进度提示与下载
- 涉及文件: [列表]
```
