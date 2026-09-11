---
name: "kb-update"
description: "任务完成后自动增量更新知识库。接收 git commit hash，通过 git diff 定位变更文件，基于 meta.yaml 数据驱动受影映射到响业务域，调用 gen-project-docs 增量模式更新文档，保留手工批注。驱动词：更新知识库、kb-update、同步知识库"
---

# kb-update — 任务完成后自动更新知识库（全局 Skill）

在 Git 提交后自动将本次开发内容同步到知识库。

> 本 Skill 自包含：脚本 `./kb-update.cjs` → 数据驱动域匹配（基于 meta.yaml），不硬编码任何路径规则。
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
node "<skill_dir>/kb-update.cjs"
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

匹配算法（脚本内）：对每个变更文件，遍历 meta.yaml 所有域，检查是否命中该域的文件字段（`entry_files` / `files` 等，支持通配符 `*`）前缀。

### Step 2: AI 增量更新文档

对每个受影响域：
1. 读取已有文档
2. 保留 `<!-- CUSTOM:START --> ... <!-- CUSTOM:END -->` 手工批注
3. 扫描变更文件，提取新增/修改的函数、组件、API
4. 按 `.profile.yaml` 的 `project_type` 更新对应文档：
   - frontend: `overview` / `pages` / `api` / `store` / `architecture`
   - backend: `overview` / `routes` / `api` / `models` / `architecture` / `config`
   - plugin: `overview` / `entry-files` / `commands` / `schemas` / `architecture`

后端增量更新仍保持**域级聚合**：变更多个 Controller/Service/Mapper 时更新该域的聚合文档，不新增类级 md。

### Step 3: 更新索引

- `meta.yaml` `git.hash` = 当前 HEAD
- 更新 `doc_stats` 计数
- 追加 `log.md` 记录

### Step 4: 沉淀原型设计文档 🆕

对 `designDocs` 中的每一项：
1. 检查 `targetDomain` 是否非空
2. 在 `targetDir` 创建 `design/` 目录（如不存在）
3. 将 `sourcePath` 的原型文档复制到 `targetPath`
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
        created_at: "2026-07-09"
```

5. 如 `designDocs` 为空或无 `targetDomain`，跳过此步骤

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
