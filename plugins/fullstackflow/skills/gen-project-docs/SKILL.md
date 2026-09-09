---
name: "gen-project-docs"
description: "自动生成项目结构化知识库文档。按项目画像（project_type）动态确定文档类型，扫描源码生成文档（通用 5 类 + 项目类型特有切面），支持增量更新、手工批注保留与新鲜度检测。触发词：生成知识库文档、更新项目文档、gen-docs、文档生成、增量更新知识库、新鲜度检测"
---

# gen-project-docs — 项目文档生成（全局 Skill）

自动扫描项目源码，按项目类型生成符合规范的结构化文档。

> 框架无关：不限定 Vue/React/Angular，也不限定前端项目。数据驱动：从 `.profile.yaml`（项目画像）确定文档类型，从 `meta.yaml` 获取每个域的扫描目标。
> 本 Skill 自包含：脚本 `./gen-docs.cjs` 收集文件路径（确定操作），AI 生成文档内容（认知操作）。

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
