---
name: "kb-update"
description: "增量更新知识库。通过 git diff 定位变更文件，基于 meta.yaml 映射受影响业务域，更新文档并保留手工批注。Phase 6 经用户同意后执行。驱动词：更新知识库、kb-update、同步知识库"
---

# kb-update — 知识库增量更新（全局 Skill）

在 Git 提交后将待同步开发内容增量写入知识库。
Phase 6 调用前先确认用户是否更新，并说明 token 和时间成本；本次更新已明确授权则不重复询问。
拒绝时由发布助手记录 `skipped_by_user`（`knowledge_base_update_declined`），保留同步 hash；未答复则等待。
确认前不运行本 Skill 的脚本，后端分支会刷新索引。Phase 0 的初始化授权不代表本次更新授权。

> 脚本 `./kb-update.cjs` 使用同插件 `scripts/lib/kb.cjs` 与索引模块；安装时保留完整插件目录。
> "AI 负责认知，脚本负责执行" — git diff + 域匹配由脚本完成，文档更新由 AI 完成。
>
> **知识库唯一根目录为项目 `.docs/llm-knowledge/`**（脚本以 `process.cwd()` 为项目根）。
> 本文与脚本输出中出现的 `business/<domain>/...` 等相对路径，一律相对该根解析；
> 所有更新、新增的设计文档也必须落在这个根下，禁止写到项目根 / `docs/` / `.codebuddy/`。

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 执行脚本 | `./kb-update.cjs` | git diff + meta.yaml 数据驱动域匹配 + 原型文档扫描 → JSON |

---

## 前置条件

项目需有 `.docs/llm-knowledge/meta.yaml`（kb-init 或手动创建），每个 domain 配置了文件字段（字段名按项目类型，如 `entry_files` / `files`，不再是固定的 `stores/apis/components`）。

```yaml
domains:
  - id: "settings"
    path: "business/settings/"
    entry_files: ["src/views/pc/Settings.vue"]   # 前端项目示例
  - id: "scripts-core"
    path: "business/scripts-core/"
    entry_files: ["plugins/harness/scripts/lib/*.js"]   # 插件项目示例
  - id: "order"
    path: "business/order/"
    entry_files:
      - "src/main/java/com/example/order/**/*.java"
      - "src/main/resources/mapper/order/*.xml"          # 后端聚合示例
  - id: "payment"
    path: "business/payment/"
    entry_files:
      - "payment-service/src/main/java/com/example/payment/**/*.java"
      - "payment-service/src/main/resources/mapper/payment/*.xml" # 多模块 Maven 示例
```

---

## 执行流程

### Step 1: 脚本提取变更 + 匹配域 + 扫描原型文档

```bash
node "<skill_dir>/kb-update.cjs" --story <storyId>
```

输出 JSON：

```json
{
  "lastHash": "abc123",
  "currentHash": "def456",
  "changedFiles": ["src/views/pc/settings/AssignRule.vue", "..."],
  "affectedDomains": [{ "id": "settings", "path": "...", "matchedFiles": [...] }],
  "designDocs": [{
    "storyId": "STORY-002",
    "title": "1v1客服等级分配模式",
    "prototypeUrl": "https://modao.cc/...",
    "sourcePath": ".codebuddy/plans/STORY-002/prototype-analysis.md",
    "targetDomain": "settings",
    "targetPath": "business/settings/design/xxx.md",
    "targetDir": "<absolute-path>/design/",
    "fileName": "xxx.md"
  }],
  "errors": []
}
```

匹配采用共享 YAML 解析器和准确的 `*` / `**` / `?` 通配符；目录前缀需以 `/` 结尾。前后端均包含未提交、未跟踪、删除和改名变更。空同步版本代表尚未生成文档；无效版本会明确返回错误，不得当作无变化。

前端刷新轻量 `frontend-index.json`，从页面入口沿相对路径及 `@/`、`~/` import 关联 API、Store、组件，未变化文件复用缓存。其他别名或不明确的引用放入 `reviewFiles`，未归属变更放入 `unclassifiedFiles`。

后端存在 `backend-index.json` 时使用专用分支：脚本刷新索引，比较新旧文件哈希与归属并结合 Git 变更，沿导入及实际使用的同包类型反向检查受影响领域。结果 `backend` 包含 `commonFiles`、`unclassifiedFiles`、`retiredDomains`；新增文件、删除、改名和未提交改动均参与。全局配置或构建文件变化会保守列出所有相关领域，需读取源码确认。没有后端索引时保留原匹配方式。
后端 Git 变更以 `meta.yaml` 的文档同步版本到当前工作区为准，含未跟踪文件；重复刷新不会消除待同步状态。已从扫描索引删除的文件继续用 meta 的来源映射定位文档。脚本通过同插件的 `kb-init/backend-index.cjs` 刷新索引，需保留该兄弟 Skill 目录。

### Step 2: AI 增量更新文档

只读取受影响域中与变更相关的文档和源码，按需补充依赖上下文，不重读整个知识库。
运行 `gen-docs.cjs --story <storyId>` 获取真实增量清单（独立更新可省略参数）：仅包含受影响文件、删除文件及建议更新的 `documents[].sections`。`<domain_id>` / `--all` 是显式扩展读取范围，只有增量证据不足时才使用单域模式。
按指定章节编辑；未改变的章节和手工批注保持原样，公共配置只更新相关 `common/` 内容。原始索引保留在磁盘，不要整段读入上下文。
没有受影响域、公共技术变更、待归类项、退役域或可迁移原型文档且无错误时，跳过文档生成；仅在 hash 确需前移时更新同步元数据，版本相同时不重复追加日志。

对每个受影响域：
1. 读取已有文档
2. 保留 `<!-- CUSTOM:START --> ... <!-- CUSTOM:END -->` 手工批注
3. 扫描变更文件，提取新增/修改的函数、组件、API
4. 按 `.profile.yaml` 的 `project_type` 更新对应文档：
   - frontend: `overview` / `pages` / `api` / `store` / `architecture`
   - backend: `overview` / `routes` / `api` / `models` / `architecture` / `config`
   - plugin: `overview` / `entry-files` / `commands` / `schemas` / `architecture`

后端增量更新仍保持**域级聚合**：变更多个 Controller/Service/Mapper 时更新该域的聚合文档，不新增类级 md。
后端先更新已有概览，复杂内容才按需拆分 `flows/routes/api/models`；公共技术更新 `common/`。对 `retiredDomains` 检查是否需要合并文档和手工内容，不直接删除旧目录。索引刷新失败时不得宣称文档已同步。

### Step 3: 检查同步条件（最后提交索引）

- 核对 `unclassifiedFiles` / `reviewFiles` / `errors`：明确归属、确认无须更新或完成源码复核，并记录处置；存在未解决项时保留原同步版本，返回 `completed_with_errors`，不能静默推进 hash
- 所有需要的文档及原型均成功处理后，`meta.yaml` `git.hash` = 脚本输出的 `currentHash`；执行期间源码变化时重新获取清单，不写入另一个 HEAD
- 更新 `doc_stats` 计数
- 追加 `log.md` 记录
- 后端从最新代码索引同步 meta 的领域及源码列表，保留人工描述和设计文档字段；仅在文档更新成功后推进 `git.hash`，索引的扫描版本不等于文档已同步版本

### Step 4: 沉淀原型设计文档 🆕

对 `designDocs` 中的每一项：
1. 检查 `targetDomain` 是否非空
2. 在 `targetDir` 创建 `design/` 目录（如不存在）
3. `action: index_only` 只补索引；`action: merge` 合并源文档到 `targetPath`，保留目标手工内容。不要覆盖复制已有人维护的目标
4. 在 `meta.yaml` 对应 domain 下追加/更新 `design_docs` 条目：

```yaml
domains:
  - id: "settings"
    design_docs:
      - id: "level-allocation"
        title: "1v1客服等级分配模式"
        prototype_url: "https://modao.cc/..."
        doc_path: "business/settings/design/level-allocation.md"
        story_id: "STORY-002"
        source_hash: "<sourceHash>"
        created_at: "2026-07-09"
```

5. 成功后保存 `source_hash`，下次相同源版本直接跳过；历史无归属 Story 不套用本次受影响域，列为待确认。`designDocs` 为空时跳过此步骤。
6. 完成文档和原型处理后才提交 Step 3 的索引、hash、计数与日志；失败时不前移全局同步版本。

---

## 追溯链

```
prototype-analysis.md (plans/)
    ↓ Step 4 自动迁移
design/<doc>.md (knowledge base)
    ↓ meta.yaml 索引
keyword search → L1 domain match → L3 load design doc
```

---

## 容错

- 更新失败不阻断后续流程
- `errors` 非空时标记 `completed_with_errors`
- 原型文档迁移失败仅记录 warning，不影响主流程
- 下次增量更新自动补齐
