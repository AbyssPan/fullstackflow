---
description: 
alwaysApply: true
enabled: true
updatedAt: 2026-07-10T08:08:13.482Z
provider: 
---

# 知识库自动检索规则

## 总则

在处理任何与项目业务相关的开发任务时，**必须先查阅知识库，再操作代码**。

## 自动触发场景

下列场景出现时，**无需等待用户说触发词**，直接按 L1→L2→L3 流程检索知识库：

1. **涉及功能模块** — 用户提到任意功能名称（如"会话""设置""工单"），先读 `overview.md` 业务域地图匹配域
2. **修改/新增代码** — "帮我改一下"、"新增一个功能"、"修复这个bug"
3. **询问实现** — "怎么实现的"、"在哪里"、"是什么逻辑"
4. **需求相关** — 包含 PRD、需求、方案、设计等关键词
5. **不确定入口** — 用户没有明确说文件路径，AI 需要自己定位时

## 执行流程

```
Step 1: read_file .docs/llm-knowledge/overview.md (定位域)
Step 2: read_file .docs/llm-knowledge/meta.yaml   (获取文件配置)
Step 3: load business/<domain>/overview.md        (加载域文档)
Step 4: 按需加载域文档（文档类型由项目画像决定：前端 pages/api/store，后端 controller/service/mapper，插件 entry-files/schemas/commands 等）
```

## 只加载必要的

- ❌ 禁止一次性加载所有域的文档
- ✅ 定位到 1-2 个域后，只加载该域的文档

## 与 graphify 的关系：并行互补，不是降级

> **kb-query 与 graphify 同时用**。知识库命中了也要用 graphify，两者查的不是同一类信息。

| 层 | 工具 | 擅长 | 产出 |
|----|------|------|------|
| 语义层 | `kb-query` | 业务域、模块职责、接口契约、踩坑记录 | 候选文件清单 |
| 结构层 | `graphify` | import/调用关系、依赖链、变更影响面 | 精确依赖图 |

### 并行检索流程

1. **同时发起** — kb-query 定位业务域，graphify `query "<关键词>"` 建立结构视图
   - `graphify-out/graph.json` 已存在时，graphify 走 query 快速路径，不重建图
2. **交叉验证** — 对比两边给出的文件清单
   - 双方都命中 → 高置信度，直接 `read_file` 精读
   - 仅知识库命中 → `graphify explain "<模块>"` 补齐结构关系
   - 仅 graphify 命中 → 知识库缺该模块，任务收尾时提醒 `kb-update` 补录
   - 结论冲突 → 以源码为准，并标注知识库可能过期
3. **追链** — 跨模块数据流用 `graphify path "<起点>" "<终点>"`
