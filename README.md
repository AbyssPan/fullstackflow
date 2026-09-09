# FullstackFlow Marketplace

**全栈研发自动化工作流插件市场。** 整合规格驱动方法论与
[open-code-review](https://github.com/alibaba/open-code-review) 审查规则集（Apache-2.0）、
[OpenSpec](https://github.com/Fission-AI/OpenSpec) 规格规范（MIT）。

通过安装 **FullstackFlow** 插件，为你的 AI 编程助手（Claude Code / CodeBuddy Code）接入一条覆盖
「需求分析（Grill 拷问 × OpenSpec 规格）→ 任务规划 → 全栈代码开发（前端 + 后端 + DB）→
代码审查（前端人工 + 后端内置规则库）→ 功能测试（前端实跑 + 后端三层验证）→ Git 提交 + MR（用户确认）
→ 知识库更新 → 发布收尾（前端云端部署 / 后端跳过部署）」全流程的自动化开发流水线。

> 兼容 Claude Code 与 CodeBuddy Code，安装步骤完全一致。
> 市场清单分别位于 `.claude-plugin/marketplace.json` 与 `.codebuddy-plugin/marketplace.json`，内容一致。

## 核心特性

- **全栈覆盖**：Phase 2 全栈开发工程师（GLM-5.3）贯通前端 / 后端 / DB——分层架构、类型化 VO、DTO 校验、事务并发、SQL 规范
- **规格驱动**：Phase 0 先做 Grill 四阶段结构化面试（目标对齐→架构决策→边界与风险→实现细节），产出 OpenSpec 规范规格（proposal / specs / design / tasks）
- **需求归档**：每个需求一个目录 `openspec/changes/archive/yyyy-MM-dd-{需求名称}/`
- **双重审查**：前端人工审查 + 后端内置规则库审查（源自 open-code-review，零依赖）+ 项目规范复核（分层 / 事务 / SQL / 前后端契约一致性）
- **三层后端测试**：接口契约（真实请求）/ 业务逻辑（mvn test）/ 数据落库（只读 SELECT）
- **发布安全**：铁律——Git 提交 / push / 创建 MR 三点均强制用户确认；后端项目跳过云端部署
- **全栈门控**：Phase 2→3 按仓库类型自动选择 eslint（前端）或 mvn compile / gradle compileJava（后端）

## 6 个角色 Agent

| Agent | 注册名 | Phase | 职责 |
|---|---|---|---|
| 需求分析师 | `requirement-analyst` | 0 | Grill 四阶段面试 + OpenSpec 规格 + 验收标准 |
| 任务规划师 | `task-planner` | 1 | 任务 DAG（DB→后端→前端→集成）+ openspec/tasks.md |
| 全栈开发工程师 | `fullstack-developer` | 2 | 前端 / 后端 / DB 代码实现，模型 GLM-5.3 |
| 代码审查师 | `code-reviewer` | 3 | 前端人工审查 + 后端内置规则库审查（零外部依赖） |
| 测试工程师 | `test-engineer` | 4 | 前端 Playwright 实跑 + 后端三层验证 |
| 发布助手 | `release-assistant` | 5/6/7 | Git/MR（用户确认）+ KB 更新 + 发布收尾（前端云端部署，后端跳过） |

## 安装

```
/plugin marketplace add https://github.com/<you>/fullstackflow.git
```

## 零外部依赖设计

插件**无需安装任何 CLI、无需配置额外 LLM Key**，安装即用：

| 能力 | 实现方式 |
|---|---|
| OpenSpec 规格校验 | 内置 `scripts/commands/validate-openspec.js`（规则提炼自 OpenSpec validate：Requirement 含 SHALL/MUST、`#### Scenario:` 结构、Why ≥50 字符等硬阈值） |
| OpenSpec 归档 | `archive-story.js` 同步规格产物到项目根 `openspec/changes/archive/yyyy-MM-dd-{需求名称}/`，同步前自动校验 |
| 后端代码审查 | 内置规则库 `skills/harness-conductor/references/review-rules/`（default 五维度 / Java / TS·JS / Mapper XML，均含「不报告」防误报护栏），由审查师模型逐文件执行 |
| JSON Schema 校验 | 内置 `vendor/ajv.bundle.js`（免 npm install） |

可选增强（按需配置，不配置时各 agent 自动降级）：Figma MCP（设计稿拉取）、devops MCP（前端云端构建）、
GitLab MCP（MR 管理）、TAPD（需求/缺陷导入）、Playwright MCP（前端实跑测试）。

## 仓库结构

```
fullstackflow/
├── .codebuddy-plugin/marketplace.json   # CodeBuddy Code 市场清单
├── .claude-plugin/marketplace.json      # Claude Code 市场清单（内容一致）
└── plugins/
    └── fullstackflow/                   # 插件本体
        ├── plugin.json                  # 插件元信息
        ├── agents/                      # 6 个角色代理
        ├── skills/                      # 工作流 / 知识库 / 审查规则库等技能
        ├── hooks/                       # 阶段钩子（dev-pass / 状态文件守卫）
        ├── rules/                       # 知识库自动检索规则
        ├── scripts/                     # dispatch / advance-phase / archive / validate-openspec
        └── vendor/ajv.bundle.js         # 内置 ajv（免 npm install）
```

## License

MIT
