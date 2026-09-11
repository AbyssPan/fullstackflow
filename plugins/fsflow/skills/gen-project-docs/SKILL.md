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
| 增量 | `./gen-docs.cjs` | Phase 6 自动触发（配合 kb-update） |
| 新鲜度 | `./gen-docs.cjs --stale` | 只检测不生成，输出 `{ stale, changedCount }` |

---

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

**通用 5 类**（overview/architecture/config/pitfalls/log）所有项目类型都生成；**特有切面**按 project_type 选择。

后端生成约束：

- `routes.md` 聚合 HTTP Controller、RPC/消息/定时任务等入口
- `api.md` 聚合接口契约、入参、出参、错误码和外部依赖
- `models.md` 聚合 DTO/VO/Entity/Mapper/XML/Repository 和关键数据约束
- 不生成 `OrderController.md`、`OrderService.md`、`OrderMapper.md` 等类级文档
- 单域文件过多时，优先总结核心入口和契约，把完整文件列表作为索引，不把源码内容整段复制进知识库

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

## log.md 格式

```markdown
## YYYY-MM-DD HH:MM
- Git hash: abc123 | 模式: incremental
- 域: settings | 文件: 更新 overview.md
```
