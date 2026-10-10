# Agent Prompt 单一信源（理解 prompt 来源时按需读取）

> 本文件从 `harness-conductor/SKILL.md` 外移（渐进式披露）。仅当需要理解「为什么 prompt 不能加工」时读取。

`agentPrompt` 由 `prompt-builder.js` 统一生成，**只有一个出口**: `dispatch.js` 输出的 `agentPrompt`，或开发批次中的 `batches[].agentPrompt`。
它按执行场景提供角色、契约路径、当前任务或修复范围、门控缺口与产出要求，
**无占位符，可直接原样注入**。

```
node ${HARNESS}/dispatch.js <storyId>
  ├─ batches[]        ← 有批次时逐批使用 agent + agentPrompt，顶层 agentPrompt 为空
  └─ agentPrompt      ← 原样传给 Spawn 的 prompt 参数
     nextAgent        ← 传给 Spawn 的 Agent 注册名
     expectedOutputs  ← 本 Phase 应产出的文件（用于校验子 Agent 汇报）
```

**为什么不允许主 Agent 加工 prompt**: 一旦主 Agent 参与拼接，注入哪些上下文就变成一次自由裁量，
不同轮次注入的内容会不一致，Phase 2 的 `files[]` 写入范围也可能被漏掉——这是流程不可控的直接来源。
prompt 内容需要调整时，改 `prompt-builder.js`，不改主 Agent 行为。
