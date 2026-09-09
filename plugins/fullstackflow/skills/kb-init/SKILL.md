---
name: "kb-init"
description: "初始化项目知识库目录结构和规范。自动推断项目画像（project_type/source_root），按项目类型动态扫描真实业务域（不再硬编码客服域），扫描编码规范来源并生成编码规范文档，生成 llm-knowledge/ 标准化骨架（.profile.yaml/overview/meta.yaml/域/文档模板/common/含编码规范）。触发词：初始化知识库、kb-init、知识库初始化、搭建知识库目录"
---

# kb-init — 知识库初始化（全局 Skill）

为任意项目创建符合 Harness Engineering 规范的结构化知识库骨架。

> 本 Skill 自包含：模板从 `./templates/`（分套：common + 各项目类型）读取，脚本执行 `./kb-init.cjs`。
> 不依赖项目中的任何文件，可跨项目复用。

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
node "<skill_dir>/kb-init.cjs" --dry-run
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

### Step 1: 确认域清单（AI 认知操作）

检查 dry-run 输出的域清单是否符合项目实际：
- 域是否遗漏（某功能模块没被识别）
- 域是否多余（噪音目录被误识别）
- 若有误，用 `--project-type <type>` 手动指定类型，或直接编辑 `.profile.yaml`

### Step 2: 执行脚本（确定性操作）

```bash
node "<skill_dir>/kb-init.cjs"           # 正式初始化
node "<skill_dir>/kb-init.cjs" --force   # 重建（覆盖）
```

脚本负责：创建目录、写入 `.profile.yaml`、写入 `custom/README.md`、按项目类型复制模板。

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

基于扫描到的域，填充 `meta.yaml` 的 `domains[]`（每个域含 `id/path/entry_files/description`）和 `git.hash`。

### Step 6: 输出报告

```
知识库初始化完成 ✅
- 目录: .docs/llm-knowledge/
- 项目画像: project_type=<type>
- 业务域: N 个 | 模板: common + <type> 特有
- 编码规范: 已从 M 个来源总结 (common/conventions.md)
- meta.yaml: git.hash = <current HEAD>
- 下一步: gen-project-docs 填充内容
```

---

## 项目画像说明

`.profile.yaml` 是知识库动态化的输入，字段：

```yaml
project_type: "plugin"      # frontend | backend | plugin | library
source_root: "plugins/harness"  # 源码根目录
domain_axis: "feature"      # 域划分依据：business | feature | service | package
```

**域识别启发式（按 project_type）**：

| project_type | 域识别方式 |
|-------------|-----------|
| frontend | 扫描 `src/views/**` 或 `src/pages/**` 一级目录 → 业务域 |
| plugin | 扫描插件根的一级子目录（agents/commands/scripts/skills）→ 功能模块；scripts 下 lib+services 合并为 scripts-core |
| backend | 扫描 `service/**` 或 `src/**` 一级目录 |
| library | 扫描 `src/**` 一级目录（功能包） |

**噪音目录过滤**：vendor / node_modules / dist / output-styles / rules / assets / test 等不作为域。

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

- kb-init **不扫描源码生成内容**（由 gen-project-docs 负责）
- 已有 `custom/` 手工文档不被覆盖
- 脚本为 CommonJS（`.cjs`），兼容 ES module 项目
- 模板从 Skill 目录复制到项目 `.docs/llm-knowledge/templates/`
- **分层检索（L1/L2/L3）概念不变**：本 skill 只改「目录如何生成」，不改「知识如何检索」
