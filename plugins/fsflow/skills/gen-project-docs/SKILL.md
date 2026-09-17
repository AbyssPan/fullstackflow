---
name: "gen-project-docs"
description: "自动生成项目结构化知识库文档。按项目画像（project_type）动态确定文档类型，扫描源码生成文档（通用 5 类 + 项目类型特有切面），支持增量更新、手工批注保留与新鲜度检测。触发词：生成知识库文档、更新项目文档、gen-docs、文档生成、增量更新知识库、新鲜度检测"
---

# gen-project-docs — 项目文档生成（全局 Skill）

自动扫描项目源码，按项目类型生成符合规范的结构化文档。

> 框架无关：不限定 Vue/React/Angular，也不限定前端项目。数据驱动：从 `.profile.yaml`（项目画像）确定文档类型，从 `meta.yaml` 获取每个域的扫描目标。
> 本 Skill 自包含：脚本 `./gen-docs.cjs` 收集文件路径（确定操作），AI 生成文档内容（认知操作）。
> 后端项目按业务域聚合生成文档。即使一个域包含多个 Controller/Service/Mapper/DTO/Entity，也只生成该域的 `routes.md` / `api.md` / `models.md` 等聚合文档，禁止按类生成独立 md。
> 多模块 Maven 项目使用带 module 前缀的 `entry_files`，例如 `order-service/src/main/java/com/example/order/**/*.java`。
> 后端有 `backend-index.json` 时，脚本优先使用其完整领域文件列表；独立生成文档前运行 `kb-init` 的 `--index-only` 刷新索引。`kb-update` 已刷新时无需重复。

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 执行脚本 | `./gen-docs.cjs` | 读 meta.yaml + .profile.yaml → 输出每域需扫描的文件清单 JSON |

---

## 前置条件

- 项目已通过 `kb-init` 初始化知识库骨架（含 `.profile.yaml`）
- `meta.yaml` 各域已配置文件字段（`entry_files` 等，字段名按项目类型）
- 源码根由 `.profile.yaml` 的 `source_root` 指定

---

## 输出路径（铁律）

所有知识库生成文档**必须**落在目标项目的 `.docs/llm-knowledge/` 下（脚本以 `process.cwd()` 为项目根，执行前先确认 cwd 是目标项目根）：

| 文档 | 落盘路径 |
|------|---------|
| 项目总览 | `.docs/llm-knowledge/overview.md` |
| 索引 | `.docs/llm-knowledge/meta.yaml` |
| 域文档（overview/architecture/api/…） | `.docs/llm-knowledge/business/<domain>/<doc>.md` |
| 通用切面（conventions/config/…） | `.docs/llm-knowledge/common/<doc>.md` |
| 手工批注文档 | `.docs/llm-knowledge/business/<domain>/custom/` |

- 🚫 禁止把知识库文档写到项目根、`docs/`、`.codebuddy/`、Skill 自身目录或其他任何位置
- 🚫 禁止在 `.docs/llm-knowledge/` 之外另建平行的知识库目录
- 文中后续出现的 `business/<domain>/...` 等相对路径，一律相对 `.docs/llm-knowledge/` 解析

---

## 4 种模式

| 模式 | 命令 | 用途 |
|------|------|------|
| 全量 | `./gen-docs.cjs --all` | 首次 / 重建全量知识库 |
| 单域 | `./gen-docs.cjs <domain_id>` | 只生成指定域 |
| 增量 | `./gen-docs.cjs` | 只返回受影响源码、删除文件和文档章节；Phase 5 提交前经授权使用 |
| 新鲜度 | `./gen-docs.cjs --stale` | 只检测不生成，输出 `{ stale, changedCount }`；验证失败时 `stale: null`，不得视为已同步 |

提交前增量命令可加 `--story <storyId>`，与 kb-update 使用同一 Story 归属；不会扩大源码范围。

---

## 增量读取预算

默认只读 `domains[].files.all` 和 `documents[].sections` 指向的章节，删除文件按 `deletedFiles` 清理过期描述。API 变化更新接口条目，Store 变化更新状态和数据流；不因一个文件变化重写整域所有文档。
`commonFiles`、`unclassifiedFiles`、`reviewFiles` 和 `retiredDomains` 分别处理，不把整个代码索引当生成输入；证据不足才扩展读取相邻源码或单域清单。源码和文档原文不要复制进日志。

## 文档类型（按项目画像动态确定）

文档类型**不再固定 8 类**，而是由 `.profile.yaml` 的 `project_type` 决定：

| 切面 | 通用 | frontend | plugin | backend | library |
|------|------|----------|--------|---------|---------|
| 总览 | overview.md | ✓ | ✓ | ✓ | ✓ |
| 架构 | architecture.md | ✓ | ✓ | ✓ | ✓ |
| 配置 | config.md | ✓ | ✓ | ✓ | ✓ |
| 踩坑 | pitfalls.md | ✓ | ✓ | ✓ | ✓ |
| 变更日志 | log.md | ✓ | ✓ | ✓ | ✓ |
| 页面/结构 | — | pages.md | entry-files.md | routes.md | public-api.md |
| 接口/能力 | — | api.md | commands.md | api.md | usage.md |
| 数据/契约 | — | store.md | schemas.md | models.md | — |

前端、插件和库保持原模板生成方式。后端将这些类型视为可选切面：每域首先生成 `overview.md`，内容足够复杂时才拆分文档，不生成空白占位文档。

后端生成约束：

- 全局模块、依赖及部署边界写入 `common/architecture.md`，公共技术约定按需写入 `common/`；领域内只补充业务特有差异
- `overview.md` 包含职责、业务规则、核心流程、数据变化和可追溯源码入口；复杂流程按需拆为 `flows.md`，说明事务、幂等、重试和失败处理
- `routes.md` 聚合 HTTP Controller、RPC/消息/定时任务等入口
- `api.md` 聚合接口契约、入参、出参、错误码和外部依赖
- `models.md` 聚合 DTO/VO/Entity/Mapper/XML/Repository 和关键数据约束
- 不生成 `OrderController.md`、`OrderService.md`、`OrderMapper.md` 等类级文档
- 单域文件过多时，优先总结核心入口和契约，把完整文件列表作为索引，不把源码内容整段复制进知识库
- 读取脚本输出的 `commonFiles` 和 `unclassifiedFiles`：公共内容聚合说明，待归类项核实源码后通过 `backend.config.json` 明确归属，不能自行把每个文件变成领域
- `evidence` 中的注解与符号是定位线索，组合路由、动态 SQL 和实际调用关系仍以源码为准；文档记录来源文件和生成版本
- 生成成功后按 kb-update 的同仓维护流程记录各受影响 scope；维护模式不前移全局 git.hash，只在域映射改变时更新 meta.yaml，保留人工描述和批注

---

## 手工批注保留

增量更新时，以下区域不覆盖：
```markdown
<!-- CUSTOM:START -->
[人工编写的业务说明]
<!-- CUSTOM:END -->
```

## 配合其他 Skill

| Skill | 关系 |
|-------|------|
| `kb-init` | 先驱—创建骨架 + 项目画像 |
| `kb-update` | 触发方—定位变更域后调用 |
| `kb-query` | 消费方—开发时检索 |

## 旧库日志格式（仅兼容）

```markdown
## YYYY-MM-DD HH:MM
- Git hash: abc123 | 模式: incremental
- 域: settings | 文件: 更新 overview.md
```

维护模式使用 [同仓知识维护](../kb-update/references/maintenance.md) 中的按域回执与独立 changelog 条目，提交前更新正文，Phase 6 只核验。首次全量生成后逐域及 common 记录审查结果；初始骨架不能标为 updated。
