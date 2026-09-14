---
name: "kb-query"
description: "渐进式分层知识库检索。三层检索：L1 overview关键词匹配定位域 → L2 meta.yaml精确筛选 → L3 按需加载文档。支持4种模式：需求拆解/技术方案/接口搜索/知识问答。自动触发：代码修改、需求分析、接口查找、技术方案、改bug、新增功能等场景。查找代码时应与 graphify 双源交叉验证（query/explain/path）。"
---

# kb-query — 渐进式分层知识库检索（全局 Skill）

"渐进式分层加载"检索策略。
数据驱动：域列表和关键词从 `overview.md` + `meta.yaml` 动态获取，不硬编码。

---

## 双源交叉验证（kb-query ∥ graphify）— 查找代码辅助

> 全局通用：在查找/定位代码时，**kb-query 应与 graphify 同时调用，双源交叉验证收敛**，不要只依赖单一检索方式（如仅 Explore agent 或仅文本搜索）。

### 为何双源并行
- **kb-query**（本 skill）：业务语义层——按功能模块/接口名检索，拿到业务语义、候选文件、该域历史踩坑（`pitfalls.md`）。
- **graphify**：结构层——`query "<报错信息/功能关键词>"` 拿结构视图，`explain "<模块>"` 理解职责，`path "<API>" "<渲染出口>"` 追数据流与调用链。

两者互补：kb-query 的历史踩坑常直接命中同类历史 bug；graphify 的调用链常暴露「需求没提但被波及」的隐式路径。缺一路容易定位到表象而非根因。

### 交叉验证收敛规则
| 情况 | 处理 |
|------|------|
| 两者指向同一文件 | 最高置信度，优先精读该文件 |
| 仅 kb-query 命中 | graphify `query` 补调用方，bug 可能在上游 |
| 仅 graphify 命中 | 知识库缺此模块，报告末尾建议 `kb-update` |
| 两边冲突 | 当前实现事实以源码为准；编码规范以知识库为准；疑似过期时标注证据并安排 `kb-update` |

### 兜底
- `search_content` + `search_file`：仅当上述两路都没定位到文件时使用。
- **graphify 未安装**（`use_skill("graphify")` 失败）：降级为 kb-query 单源 + `search_content`
  文本检索，并在收尾汇报中提示用户安装 graphify 以恢复双源交叉验证；不要反复重试调用。

---

## 检索流程

### 后端精确定位分支

后端问题包含类名、文件路径、路由片段或表名时，优先搜索 `.docs/llm-knowledge/backend-index.json` 的 `files[].path/symbols/entries`，读取命中源码位置及所属领域文档，无需先通过业务关键词匹配。索引未覆盖的表名、组合注解或动态路由直接搜索源码；索引不存在时使用下述文档检索。

`entries` 是词法线索，不能当作已解析的完整路由或调用链。公共文件对应 `common/`，待归类文件直接查看源码，不虚构业务域。业务概念问题继续走 L1-L3。此分支仅适用于后端。

### L1: 全局总览匹配（业务问题及其他项目类型）

加载 `.docs/llm-knowledge/overview.md` 的「域地图」表。

- 提取用户问题关键词
- 与域地图的关键词列匹配 → 收敛到 1-2 个域
- 无法匹配 → 返回概述，询问补充上下文
- 后端无法匹配时，先查代码索引和源码补充证据，仍有歧义才询问

### L2: meta.yaml 精确筛选

加载 `.docs/llm-knowledge/meta.yaml`。

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

后端的域文档按需生成，L3 表中各文件不是必备文件清单。先读已有 `overview.md`，再按问题加载 `flows.md`、`routes.md`、`api.md`、`models.md` 或源码；公共架构与配置从 `common/` 获取。

---

## 检索策略

### ❌ 禁止
- 一次加载所有域文档
- 非后端精确定位场景，跳过 L1 overview 直接搜代码
- 精准定位域后仍全量搜索

### ✅ 必须
- 业务问题先读 overview.md；后端精确定位按上述分支执行
- 通过领域索引确认归属后再加载域文档（后端可使用 backend-index.json，其他项目使用 meta.yaml）
- 优先 `read_file` 读已生成文档，不命中才 `search_content`
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
