# INSTALL.md — FullstackFlow 安装指南

> 面向 AI 代理与人类用户的完整安装 / 验证 / 排障 / 卸载指南。
> README 只保留快速安装入口，细节以本文档为准。

## 目录

- [安装前检查](#安装前检查)
- [安装步骤](#安装步骤)
- [冒烟测试](#冒烟测试)
- [更新插件](#更新插件)
- [常见问题排查](#常见问题排查)
- [卸载](#卸载)

## 安装前检查

| 检查项 | 要求 | 验证命令 |
|---|---|---|
| 宿主 | Claude Code 或 CodeBuddy Code（任一） | 启动宿主 CLI / IDE |
| Node.js | ≥ 16（推荐 18+），`node` 在 PATH 中 | `node -v` |
| Git | ≥ 2.20，`git` 在 PATH 中 | `git --version` |
| 网络 | 可访问 GitHub（市场仓库克隆） | `git ls-remote https://github.com/AbyssPan/fullstackflow.git` |

**无需准备**：openspec CLI、npm install、额外 LLM Key——插件零外部依赖
（ajv 已内置为 `vendor/ajv.bundle.js` 单文件）。

> Windows 用户：建议在 Git Bash / PowerShell 下使用，脚本已兼容 Windows 路径
> （含 Git Bash 盘符风格路径归一化）。

## 安装步骤

### 第 1 步：添加市场

在 Claude Code / CodeBuddy Code 会话中执行：

```
/plugin marketplace add AbyssPan/fullstackflow
```

> GitHub 仓库优先使用官方支持的 `owner/repo` 简写。自建 GitLab / 私有 Git 服务再使用
> 带 `.git` 后缀的完整 Git URL；不要把 `marketplace.json` 网页地址误当 Git 仓库。

双清单说明：仓库同时提供 `.claude-plugin/marketplace.json`（Claude Code）与
`.codebuddy-plugin/marketplace.json`（CodeBuddy Code），内容一致，宿主会自动识别各自的清单。

### 第 2 步：安装插件

```
/plugin install fsflow@fullstackflow-marketplace
```

### 第 3 步：重载生效

```
/plugin list
```

确认列表包含 `fsflow` 即安装成功。若未出现，重启宿主或执行 `/reload-plugins`。

## 冒烟测试

安装后按顺序做四个检查，全部通过即可放心使用：

### 1. Slash Command 可达性

在输入框输入 `/fsflow:`，应出现 `run`、`fixbugs`、`status`、`end`、`evolve`、
`archive` 和兼容入口 `fullstack`。插件命令必须带命名空间，未加命名空间的短入口不会被注册。
执行：

```
/fsflow:status
```

预期：AI 执行 `harness-workflow.js status` 并转述结果（冷启动场景返回 terminal 状态属正常）。
若报「找不到命令」，按下方「Skill 不响应触发词」排查（重载插件 / 清缓存重装）。

### 2. Skill 可达性（无副作用）

对 AI 说：

```
初始化知识库
```

预期：AI 响应 kb-init 流程（先询问或直接 dry-run 扫描项目画像），**不会**报「找不到技能」。
在空项目 / 不想真正初始化的项目里，看到 AI 开始走流程即可中止。

### 3. 零依赖运行时自检（开发者向，可选）

```
cd plugins/fsflow && npm run check
```

预期输出 `✅ 插件一致性检查通过`。该检查覆盖宿主 manifest、双市场清单、命令入口、
Skill / Agent frontmatter、Hook 脚本引用、全部 JSON 与 JavaScript 语法。

### 4. 单元测试（仅插件开发者）

```
cd plugins/fsflow && npm run verify
```

预期：插件一致性检查通过，且 `✅ 8 个测试文件全部通过`（当前 293 项断言）。

## 更新插件

```
/plugin marketplace update fullstackflow-marketplace
/plugin update fsflow@fullstackflow-marketplace
```

从 `fullstackflow` 命名空间升级时，旧插件名无法原地改名，需先执行
`/plugin uninstall fullstackflow@fullstackflow-marketplace`，再安装 `fsflow@fullstackflow-marketplace`。

或删除缓存后重装（彻底同步）：

```
rm -rf ~/.codebuddy/plugins/cache   # CodeBuddy Code
rm -rf ~/.claude/plugins/cache      # Claude Code（路径以宿主实际为准）
```

重启宿主后重新执行安装步骤。

## 常见问题排查

### `Cannot find module 'ajv'`

内置 ajv 文件缺失。检查：

```
ls plugins/fsflow/vendor/ajv.bundle.js
```

不存在则 `git pull` 同步仓库（或重新 `marketplace update`）。
**严禁**在插件目录执行 `npm install ajv`——会破坏零依赖设计且引入版本漂移。

### Skill 不响应触发词

1. `/plugin list` 确认插件已安装且启用
2. 重启宿主或 `/reload-plugins`
3. 更新市场并更新插件（见[更新插件](#更新插件)）
4. 确认说的是触发词（如「初始化知识库」「做个需求」），不是自造短语

### 报 `e2e-state.json 不存在或解析失败`

冷启动的正常路径：dispatch 返回 `terminal` 状态并给出创建命令。两种处理：

- 全新需求：对 AI 说「做个需求 / 实现 xx 功能」走 harness-start 建流
- 已归档 Story：按 terminal 恢复命令执行 restore 复档（root 文件在 `archive/round-{N}/`）

### dev-pass 拦截源码编辑

这是设计行为（Phase 2 限域保护），不是故障：

- 确认当前处于 Phase 2（其他 Phase 禁改源码）
- 确认目标文件在 `task-dag.json` 的 `files[]` 限域清单内
- 开发未完成但 pass 过期：让 AI 执行 `advance-phase.js --renew-pass` 续签

### hook 脚本静默失败

hook 超时默认 5–10 秒。若机器过慢导致偶发拦截，重启会话重试；
持续失败用 `node --check <脚本路径>` 逐个验证语法。

## 卸载

### 1. 移除插件

```
/plugin uninstall fsflow@fullstackflow-marketplace
/plugin marketplace remove fullstackflow-marketplace
```

### 2. 清理项目侧残留（按需）

| 目录 | 内容 | 是否删 |
|---|---|---|
| `.codebuddy/plans/` | Story 状态、trace、归档轮次 | 无进行中需求即可删 |
| `.docs/llm-knowledge/` | 知识库文档（域文档 / 编码规范 / 踩坑记录） | 团队共享文档，建议保留或另行归档 |
| `openspec/`（项目根或旧 Story 中，若曾创建） | 旧版重复规格产物 | 新版已将 OpenSpec 规则内嵌到门控，不再写入；按项目实际情况处理 |

### 3. 清缓存（彻底移除）

```
rm -rf ~/.codebuddy/plugins/cache   # CodeBuddy Code
rm -rf ~/.claude/plugins/cache      # Claude Code
```

重启宿主生效。
