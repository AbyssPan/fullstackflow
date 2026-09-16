---
name: harness-start
description: >
  Harness 工作流统一入口 — 识别新功能开发 run / Bug 修复 fixbugs 意图，
  搬运用户的原始输入并启动工作流。用户说「做个需求 / 开发功能 / 修 bug」，
  或调用 /fsflow:run、/fsflow:fixbugs、/fsflow:fullstack 时使用。
---

# FullstackFlow 工作流启动

本 skill 只做：**判模式 → 写输入 → 启动 → 交棒**。Phase 推进和恢复归
`harness-conductor`。字段表、JSON 样例和命令只在新建 Story 时从 reference 读取。

## 1. 判定工作流模式

| 信号 | 模式 |
|---|---|
| TAPD 链接 + 修/bug/缺陷/报错，或明确的现有功能故障 | `fixbugs` |
| 原型/Figma 链接，或新增/开发/实现功能 | `run` |
| 两类信号并存或都没有 | 询问一次；仍无法确定则用 `run` |

`run` 和 `fixbugs` 共用同一条 8 Phase 流水线，分支由 `story-input.json` 和脚本处理。

## 2. 写输入并启动

读取 `references/启动入口.md`，按其中两步执行。只搬运用户给出的链接、参数和原始描述；
不在主 Agent 上下文中访问 TAPD / Figma，不分析 Bug 或改动文件。

## 3. 交棒

```text
use_skill("harness-conductor")
```

此后不在本 skill 判断 Phase、拼 prompt 或直接调 `advance-phase.js`。

## 关键边界

- 主 Agent 不加载 `tapd-bug-analyzer`；Bug 分析必须留在 Phase 0 需求分析师的上下文中。
- 不自行拼 Phase 0 prompt；`dispatch.js` 是 `agentPrompt` 唯一出口。
- 不直接修改 `e2e-state.json` 或 `dev-pass.json`。
- 新工作流默认 `verificationMode=ask`，代码审查通过后由 conductor 主动询问是否执行独立功能测试。用户此前已明确要求测试或跳过独立测试时，分别写 `full` / `review-only`，后续不重复询问；仅说「尽快」不能视为跳过测试。
