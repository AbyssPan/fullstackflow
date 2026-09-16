---
name: tapd-bug-analyzer
description: >
  TAPD 缺陷分析器 —— 从 TAPD 拉取需求关联的 bugs，按处理人过滤，
  逐条记录问题复述、复现步骤、代码定位、根因与责任方分类，产出结构化 Bug 分析报告。
  只采集事实，不产出修复方案（修复设计属于开发工程师）。
  报告写入 Story 的 plans 目录，由需求分析师在 Harness Phase 0 内部调用产出。
  触发：需求分析师在 fixbugs 模式下自行加载；用户提供 TAPD 链接 + 处理人。
  不执行代码修改，只产出分析文档。
---

# TAPD Bug Analyzer

## Overview

通过 TAPD MCP 采集需求关联的 bugs → 按处理人过滤 → 逐条采集事实（问题理解 → 复现路径 → 代码定位 → 根因追踪 → 责任方分类）→ 输出**结构化 Bug 分析报告**到 Story 的 plans 目录。

> 本 skill **只记录事实，不设计方案**。产出文档作为 Harness Phase 0 需求分析的输入材料。

## 🚨 边界：只回答「问题在哪、为什么」，不回答「应该怎么改」

这是本 skill 最容易越界的地方，单独强调：

| ✅ 应该写 | 🚫 禁止写 |
|----------|----------|
| 问题现象是什么 | 应该改成什么 |
| 怎么复现 | 修复建议 / 解决方案 / 改造方案 |
| 代码在哪个文件哪一行 | 伪代码、diff、`将 xxx 改为 yyy` |
| 为什么会错（数据流 + 触发条件） | 测试验证步骤 |
| 该谁负责（责任方分类） | 技术选型建议 |

**为什么这样切分**：

1. **上下文成本** —— 设计修复方案需要精读完整实现，而 Bug 分析阶段只需定位到嫌疑点。在分析阶段做设计会把大量源码拉进上下文，挤掉真正该记的事实。
2. **修复方案会过期** —— 报告在 Phase 0 产出，代码在 Phase 2 才改。中间 Phase 1 拆任务、多仓库协同都可能改变前提，Phase 0 写死的方案到 Phase 2 往往已不成立。
3. **职责归属** —— 开发工程师拿到「代码定位 + 根因」后会用 `kb-query` 定位并用源码查证真实改动点（graphify 可选）再动手。上游给一个未经验证的方案，反而诱导开发跳过验证直接照抄。

> 责任方分类（前端-Bug / 后端-Bug 等）**不属于**修复方案，它是分诊事实 —— 全栈模式下前端 / 后端 Bug 均由全栈开发工程师修复，分类仅用于影响面与回归范围标注，必须保留。

## Harness 集成

```
Phase 0（需求分析师，单一上下文内完成两件事）
       │
       ├─ ① use_skill("tapd-bug-analyzer")
       │     └→ {STORY_DIR}/{storyTitle}_bug分析报告.md   ← 事实
       │
       └─ ② 基于 ① 的分析结论产出
             requirement-analysis.md（只引用 Bug 编号，不复制正文）
             acceptance-criteria.json（每个 Bug ≥ 1 条 AC）
             open-questions.json
                     │
                     ↓
       Phase 1 任务规划 → Phase 2 开发（自行设计修复）→ ...
```

- **调用方是需求分析师，不是主 Agent**。主 Agent 只把用户消息里的参数搬进 `story-input.json` 就结束职责，不加载本 skill、不做任何分析。
- 这样「分析」全程发生在需求分析师的上下文内：拉取 TAPD 原始数据、代码定位的中间推理都不会因跨 Agent 传递而丢失。
- 报告落在 Story 目录后，`prompt-builder.js` 的 `readStoryContext()` 会自动把它注入 Phase 0→8 的每个 prompt，无需任何人手动转述。

## 触发条件

- 需求分析师在 Phase 0 发现 `story-input.json` 的 `mode` 为 `fixbugs` → 自行加载本 skill
- 用户直接提供 TAPD 需求/缺陷链接 + 处理人
- 用户提到"分析 TAPD bugs"、"拉取 TAPD 缺陷"、"生成 Bug 报告"

> **所有参数（workspace_id、处理人、storyId 等）必须动态提取，禁止硬编码。**
> 参数优先从 `.codebuddy/plans/<storyId>/story-input.json` 的 `sources` 读取；该文件不存在时回退到当前用户消息。

## 核心约束

1. **只记录事实，不设计方案** — 见上文「边界」表格，产出中不得出现修复建议 / 测试验证章节
2. **只分析，不修代码** — 产出报告后即结束，不进入代码修改
3. **产出到 Story 目录** — 必须写入 `${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/` 目录
4. **真实数据** — 所有字段来自 TAPD API 返回值或代码定义，禁止编造
5. **动态参数** — 从 `story-input.json` 或用户消息提取，禁止写死默认值

---

## 工作流（5 步）

### Step 1：提取参数

**优先读取 `story-input.json`**（需求分析师在 Phase 0 的 prompt 中已获得其内容）：

```bash
STORY_DIR=${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>
cat ${STORY_DIR}/story-input.json
```

| 参数 | 必填 | story-input.json 字段 | 回退提取方式（无该文件时） |
|------|------|----------------------|--------------------------|
| `workspace_id` | ✅ | `sources.workspaceId` | 正则 `tapd_fe/(\d+)/` 从 TAPD 链接提取 |
| 处理人 | ✅ | `sources.owner` | "处理人: XXX"、"负责人: XXX"、"指派给 XXX" |
| `storyId` | ✅ | 顶层 `storyId` | `/fsflow:fixbugs <storyId>` 或用户消息中指定 |
| `story_id` | 选填 | `sources.storyIdInTapd` | `/story/detail/{story_id}` 从 TAPD 链接提取 |
| 状态筛选 | 选填 | `sources.statusFilter` | 默认 "待解决"，可指定 "重新打开" 等 |
| 终端类型 | 选填 | `sources.terminal` | "H5"、"PC"、"移动端"、"小程序" |

> 如果 `${STORY_DIR}` 目录不存在，需先创建。

### Step 2：采集需求关联的 Bugs

#### 主流程：需求 → 关联 Bugs → 按处理人过滤

这是最常用的路径（`/fsflow:fixbugs` 走此路径）：

```
1. get_stories_or_tasks(workspace_id, story_id)
   → 获取需求标题（用于命名报告文件）

2. get_related_bugs(workspace_id, story_id)
   → 获取需求关联的 bug_id 列表

3. 遍历 bug_id 列表，逐个 get_bug(id)
   → 按 current_owner 过滤：仅保留处理人匹配的 bugs
   → 按状态筛选（如有指定）

4. 对保留的 bugs 执行 Step 3→4→5
```

#### 备选路径

**有缺陷链接 → 查单个 bug**：
```
get_bug → id=提取的 bug_id
```

**仅有处理人 → workspace 级别查询**：
```
get_bug_count → get_bug(current_owner + 状态筛选，分页拉取)
```

### Step 3：读取 Bug 详情

对每个过滤后的 bug 调用：

| MCP 工具 | 用途 |
|----------|------|
| `get_comments` | 读取评论（开发讨论、处理记录，常含复现条件） |
| `get_entity_attachments` | 获取附件（日志、截图文件） |
| `get_image` | 获取截图（如有图片引用） |
| `get_entity_custom_fields` | 自定义字段（如终端类型、严重级别） |

### Step 4：逐条采集事实

对每个 bug 执行：

#### 4.1 问题理解
- 1-2 句话复述 bug
- 提取操作路径、预期 vs 实际行为
- 从标题 + 描述 + 评论中还原完整上下文

#### 4.2 终端识别
- **H5**：小程序、Vant、REM、移动端、vzanlivemobile / vzanlive
- **PC**：客服工作台、Element Plus / ElementUI、PC端、userlive

#### 4.3 代码定位

**知识定位与源码查证**：

```text
kb-query 定位业务与历史经验 → 源码验证 → 按需查引用
```

1. 按功能模块/接口名检索知识库，拿到业务语义、候选文件和历史踩坑；精确路径或已有同版本证据可以直接复用。
2. 用 `search_content` / `search_file` / Grep 读取实际源码，按需 LSP 查引用，确认直接调用方与相关上游入口。未命中时检查别名、路由、动态注册等，不能把零结果当作没有依赖。
3. graphify 仅作可选关联线索：已有图谱按需 `query/explain/path`，引用前验证源码和新鲜度；未安装、缺图、失败时记录原因并继续源码查证，不主动建图、不反复重试。
4. 当前实现冲突以源码为准；规范以知识库为准。源码确认但 KB 未覆盖的模块，报告末尾建议 `kb-update`。

定位到具体文件、函数和行号。报告保留仓库、源码版本（提交号及相关工作区 diff 或文件摘要）、查证位置、已确认调用方与未确认范围，供开发复用；不以是否调用特定工具判断证据质量。

> **定位到即停**。确认问题位置和有依据的根因即可，改法由 Phase 2 开发工程师设计；同版本同范围证据可复用，源码变化后重新核实受影响部分。

#### 4.4 根因分析
- 判断：代码逻辑缺陷 / 数据异常 / 接口问题 / 环境问题
- 追踪数据流：API → Store → computed → 渲染
- 提取触发条件（什么情况下会错、什么情况下不会错）

> 根因回答的是「**为什么会错**」，不是「**应该怎么改**」。
> ✅「`userInfo` 在 onMounted 前被 computed 读取，此时为 undefined」
> 🚫「应把初始化移到 created 中」

#### 4.5 复现步骤

这是本次分析要交付给开发工程师的关键事实之一 —— 开发无法复现就无法验证修复是否生效。

按以下结构记录，信息来自 TAPD 描述 + 评论 + 截图：

```
前置条件: 账号类型 / 数据状态 / 环境（测试环境、特定商户）
复现步骤: 1. ... 2. ... 3. ...（可点击可操作的具体动作）
预期结果: ...
实际结果: ...
复现概率: 必现 / 偶现（附触发条件）
```

> TAPD 信息不足以还原复现路径时，**如实标注「TAPD 未提供，需向报告人确认」**，不要凭代码推测编造步骤 —— 编造的复现路径会让开发按错误场景验证。此类缺口应由需求分析师写进 `open-questions.json`。

### Step 5：分类 + 产出报告到 Story 目录

#### 5.1 问题分类（责任方分诊）

| 类别 | 负责方 | 说明 |
|------|--------|------|
| 前端-Bug | 前端修改 | 逻辑错误、渲染异常 |
| 前端-体验 | 前端优化 | UI 不美观、交互不便 |
| 后端-Bug | 后端修复 | 接口报错、数据错误 |
| 后端-缺失 | 后端补充 | 缺少字段、接口未实现 |
| 协作-联调 | 双方协作 | 接口定义不一致 |

> 分类只判断「影响哪端、要跨哪些模块」，不判断「怎么改」。全栈模式下所有分类的 Bug 都进入修复范围；确属其他团队 / 其他仓库维护的，才转成 `open-questions.json` 的待确认项。

#### 5.2 输出路径

```
${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/{storyTitle}_bug分析报告.md
```

> 文件名使用 `get_stories_or_tasks` 返回的需求标题，非法字符替换为 `_`。
> 后缀必须是 `_bug分析报告.md` —— `prompt-builder.js` 与门控校验都按此后缀自动发现该文件。

#### 5.3 报告文件结构

```markdown
# {storyTitle}_bug分析报告

> 本报告只记录事实（问题 / 复现 / 定位 / 根因），不含修复方案。
> 修复实现由 Phase 2 全栈开发工程师基于「代码定位」自行设计。

## 1. 总览

| # | Bug ID | 标题 | 终端 | 分类 | 优先级 | 文件 |
|---|--------|------|------|------|--------|------|

## 2. 按项目分组的 Bug 清单

### 项目 A (路径)
| Bug # | 标题 | 文件 |

### 项目 B (路径)
| Bug # | 标题 | 文件 |

## 3. 逐条详细分析

### Bug #1: {标题}

#### 缺陷复述
#### 复现步骤
（前置条件 / 步骤 / 预期结果 / 实际结果 / 复现概率）
#### 根因分析
##### 数据流追踪
##### 触发条件
##### 代码定位
（仓库 + 文件 + 函数 + 行号；标注源码版本、查证位置、已确认调用方及未确认范围）

### Bug #2: {标题}
...

## 4. 优先级排序

| 优先级 | Bug | 原因 |
|--------|-----|------|
| P0 | #3 | 阻塞核心流程 |
| P1 | #1, #5 | 影响用户体验 |
...
```

> 🚫 报告中不得出现 `#### 修复建议`、`#### 解决方案`、`#### 测试验证` 等章节。
> `validate-phase-gate.js` 会扫描标题行，命中时输出警告。

---

## 工具参考

### TAPD MCP 工具

| 工具 | 用途 |
|------|------|
| `get_bug` | 按 ID 查询单个缺陷详情 |
| `get_bug_count` | 统计缺陷数量 |
| `get_related_bugs` | 查询需求关联的 bug_id 列表 |
| `get_stories_or_tasks` | 查询需求详情（获取标题） |
| `get_comments` | 读取缺陷评论 |
| `get_entity_attachments` | 获取附件列表 |
| `get_image` | 获取截图/图片 |
| `get_entity_custom_fields` | 自定义字段配置 |

### 代码定位工具

| 层级 | 工具 | 用途 |
|------|------|------|
| 业务定位 | `kb-query` skill | 按功能模块/接口名查结构化文档、历史踩坑 |
| 源码查证 | `search_content` / `search_file` / Grep，按需 LSP | 确认实现、引用、上游入口和间接依赖 |
| 可选增强 | `graphify query/explain/path` | 提供结构关系线索，引用前仍需源码验证 |

同版本同范围证据可以复用，无需为了调用工具而重复检索。
