---
name: "kb-init"
description: "初始化项目知识库目录结构和规范。自动推断项目画像（project_type/source_root），按项目类型动态扫描真实业务域（不再硬编码客服域），扫描编码规范来源并生成编码规范文档，生成 llm-knowledge/ 标准化骨架（.profile.yaml/overview/meta.yaml/域/文档模板/common/含编码规范）。触发词：初始化知识库、kb-init、知识库初始化、搭建知识库目录"
---

# kb-init — 知识库初始化（全局 Skill）

为任意项目创建符合 Harness Engineering 规范的结构化知识库骨架。

> 本 Skill 自包含：模板从 `./templates/`（分套：common + 各项目类型）读取，脚本执行 `./kb-init.cjs`。
> 不依赖项目中的任何文件，可跨项目复用。

后端初始化先阅读 [后端目录结构与归属配置](references/backend-structure.md)。后端使用业务文档、公共知识和结构化代码索引；前端保持业务域文档结构，后续增量更新会建立轻量 import 索引。

**v2 核心变化**：不再硬编码客服业务域。改为「项目画像 + 动态域扫描」——根据目标项目的实际类型（前端/插件/后端/库），自动推断域列表和文档模板。**新增编码规范总结**：扫描项目规范来源，生成 `common/conventions.md`。

与 `gen-project-docs` 的关系：
- **kb-init**: 创建**目录骨架 + 项目画像 + meta.yaml 索引 + 模板 + 编码规范**（本 Skill）
- **gen-project-docs**: 填充**具体文档内容**（扫描源码生成）

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 通用文档模板 | `./templates/common/*.template.md` | 6 类通用切面（overview/architecture/config/conventions/pitfalls/log） |
| 类型特有模板 | `./templates/{frontend,plugin,backend,library}/*.template.md` | 各项目类型的特有切面 |
| 执行脚本 | `./kb-init.cjs` | 推断画像 + 扫描域 + 扫描规范来源 + 创建目录 + 复制模板 |

---

## 执行流程

### Step 0: 项目画像（dry-run 预览）

先跑 dry-run，让脚本推断项目画像并输出候选域清单：

```bash
node "<skill_dir>/kb-init.cjs" --dry-run --summary
```

输出示例（插件项目）：
```json
{
  "projectType": "plugin",
  "sourceRoot": "plugins/harness",
  "domainAxis": "feature",
  "domains": ["agents", "commands", "scripts-core", "skills", ...],
  "templates": ["overview", "architecture", "config", "pitfalls", "log", "entry-files", "schemas", "commands"]
}
```

`--summary` 只返回领域、计数和少量文件样本，完整索引留在磁盘；不把整个索引读入 AI 上下文。首次 dry-run 尚未落盘，样本不足以确认归属时可去掉 `--summary` 获取完整线索。

### Step 1: 确认域清单（AI 认知操作）

检查 dry-run 输出的域清单是否符合项目实际：
- 域是否遗漏（某功能模块没被识别）
- 域是否多余（噪音目录被误识别）
- 项目类型有误时，用 `--project-type <type>` 手动指定类型
- 后端归属有误时，依据源码编辑 `.docs/llm-knowledge/backend.config.json`，重新 dry-run。检查 `backendIndex.common_files`、`unclassified_files` 和每个文件的 `reason`；不按目录数量强行合并

### Step 2: 执行脚本（确定性操作）

```bash
node "<skill_dir>/kb-init.cjs" --summary # 正式初始化
node "<skill_dir>/kb-init.cjs" --force   # 重建（覆盖）
node "<skill_dir>/kb-init.cjs" --index-only --summary # 后端：仅刷新代码索引
```

脚本负责：创建目录、写入 `.profile.yaml`、写入 `custom/README.md`、按项目类型复制模板。
后端还写入 `backend-index.json` 和 `STRUCTURE.md`，在不存在时创建 `overview.md`、`meta.yaml` 骨架。既有后端总览、meta 和 custom 不覆盖；历史错误目录不自动删除。

后端索引根据文件状态和内容 hash 复用解析结果；归属配置、源码根和模块结构变化会重新计算。缓存不代表文档已同步。

### Step 3: 生成 overview.md（AI 认知操作）

基于 `./templates/common/overview.template.md`，填充：
- 项目定位（从 CODEBUDDY.md / package.json 提取）
- 技术栈表
- **域地图**（关键词 → 域文档入口）

### Step 4: 总结编码规范（AI 认知操作）

脚本已扫描出编码规范来源（dry-run 输出的 `conventionSources`），并生成 `common/conventions.md` 骨架。

AI 需**读取这些来源文件，总结编码规范**，填充 `common/conventions.md` 的「编码规范清单」：

- 读取 `conventionSources` 里列出的每个来源（`.editorconfig` / `.eslintrc*` / `.prettierrc*` / `CODEBUDDY.md` / `rules/*.md`）
- 提炼成结构化规范：命名规范、代码风格、注释规范、目录结构规范、其他约定
- 保留 `<!-- CUSTOM:START -->` 手工批注区，供后续人工补充
- 若来源是规则文件（如 `rules/*.mdc`），直接提炼其中的编码规范条目

### Step 5: 生成 meta.yaml（AI 认知操作）

写入 **`.docs/llm-knowledge/meta.yaml`**。基于扫描到的域，填充 `meta.yaml` 的 `domains[]`（每个域含 `id/path/entry_files/description`）和 `git.hash`。

后端项目必须按**业务域聚合**写入 `entry_files`，禁止按 Java/Kotlin 类生成独立知识库文档。标准 Maven/Spring Boot 项目中，`kb-init.cjs` 会输出 `domainFileHints`，AI 应优先使用这些线索把同一业务域的 Controller/Service/Mapper/Entity/DTO/XML 聚合到同一个 domain。
后端的完整代码归属以 `backend-index.json` 为准，`meta.yaml` 保存文档导航、业务描述和已完成文档同步的版本。初始化骨架不代表文档已生成，完成源码阅读和文档生成后才推进 `git.hash`。

### Step 6: 输出报告

```
知识库初始化完成 ✅
- 目录: .docs/llm-knowledge/
- 项目画像: project_type=<type>
- 业务域: N 个 | 模板: common + <type> 特有
- 编码规范: 已从 M 个来源总结 (common/conventions.md)
- meta.yaml: 后端骨架 git.hash 留空，具体文档生成成功后写入 current HEAD
- 下一步: gen-project-docs 填充内容
```

---

## 项目画像说明

`.profile.yaml` 是知识库动态化的输入，字段：

```yaml
project_type: "plugin"          # frontend | backend | plugin | library
source_root: "plugins/harness"  # 源码根目录；单模块 Maven 后端通常为 src/main/java，多模块 Maven reactor 为 "."
maven_modules: ["order-service", "user-service"] # 可选；多模块 Maven reactor 的 module 清单
source_roots: ["order-service/src/main/java", "user-service/src/main/java"] # 可选；多模块后端源码根
resource_root: "src/main/resources" # 可选；后端资源目录
resource_roots: ["order-service/src/main/resources"] # 可选；多模块后端资源目录
test_root: "src/test/java"      # 可选；后端测试目录
domain_axis: "feature"          # 域划分依据：business | feature | service | package
```

**域识别启发式（按 project_type）**：

| project_type | 域识别方式 |
|-------------|-----------|
| frontend | 扫描 `src/views/**` 或 `src/pages/**` 一级目录 → 业务域 |
| plugin | 扫描插件根的一级子目录（agents/commands/scripts/skills）→ 功能模块；scripts 下 lib+services 合并为 scripts-core |
| backend | JVM：显式配置优先、业务包次之、业务入口类名辅助；公共技术和待归类文件留在代码索引。非 JVM 后端保留目录扫描兜底 |
| library | 扫描 `src/**` 一级目录（功能包） |

**噪音目录过滤**：vendor / node_modules / dist / output-styles / rules / assets / test 等不作为域。

**后端聚合规则**：

- `pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)` / `gradlew` 是后端构建体系信号
- 多模块 Maven reactor 中，根 `pom.xml` 的 `<module>` 会写入 `.profile.yaml` 的 `maven_modules/source_roots/resource_roots`
- `com.example.order.controller.OrderController`、`order.service.OrderService`、`order.mapper.OrderMapper` 会聚合为 `order` 域
- 分层包缺少业务包时，仅以 Controller/Endpoint/Resource 等入口类名建立候选域，聚合同模块匹配前缀的代码；孤立工具类不创建领域
- 同名领域跨模块默认分开，显式配置可将同一业务的 api/core/infra 文件合并
- XML 通过 Mapper namespace 或资源业务目录关联；全局配置归公共，未明确归属的资源留在待归类索引
- 知识库输出保持域级文档：`business/order/api.md`、`business/order/models.md` 等；不得生成 `OrderController.md`、`OrderService.md` 这类类级文档

---

## 使用示例

```
# 任意项目中首次使用
用户: "初始化知识库"
→ dry-run 预览 → 确认域 → 正式初始化 → AI 生成 overview/meta.yaml

# 插件项目
用户: "初始化知识库"
→ 自动推断 project_type=plugin，扫描功能模块为域

# 手动指定类型
用户: "按 library 类型初始化知识库"
→ node kb-init.cjs --project-type library
```

## 注意事项

- **所有知识库生成物（骨架、overview.md、meta.yaml、编码规范、后续域文档）一律落在项目 `.docs/llm-knowledge/` 下**——这是知识库唯一根目录，禁止在 `.docs/` 之外另建知识库目录
- kb-init **不扫描源码生成内容**（由 gen-project-docs 负责）
- 后端已有 `custom/` 手工文档不被覆盖；迁移旧知识库时先合并手工内容并更新文档链接，再处理旧目录
- 脚本为 CommonJS（`.cjs`），兼容 ES module 项目
- 模板从 Skill 目录复制到项目 `.docs/llm-knowledge/templates/`
- 后端支持精确标识直接查询代码索引，业务问题仍按总览、索引、按需加载文档检索；前端也支持路径和组件名精确定位
