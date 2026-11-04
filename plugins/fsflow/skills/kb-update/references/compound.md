# 经验片段（compound）— 按次修改的经验沉淀

> 源自 Compound Engineering ce-compound 思路：把「本次修改学到的东西」写下来，供下一次修改读取。
> 与按业务域维护的规格不同，经验片段关注「踩过的坑与适用条件」，粒度是一次变更、一个教训。

## 片段的两个来源

| 来源 | 产生时机 | 载体 |
|---|---|---|
| quick 任务 | 每次 `quick-task.js done` | Story 目录 `knowledge-receipt.json`（脚本自动落盘） |
| 完整流程 | P2 开发完成 / P5 知识维护时 | 开发者/发布助手在维护过程中直接判断 |

## 收敛规则（kb-update 时执行）

quick 的 `knowledge-receipt.json` **不会自动进入知识库**。P5 维护（或 manual 模式下用户确认后的
补充维护）时，对本次涉及的每个域，把回执按长期价值分拣：

1. **有长期价值**（适用范围超出本次 Story 的坑/约定）→ 提炼进域级 `pitfalls.md`（经验教训）
   或 `decisions/`（技术决策），带稳定 ID、适用条件与 storyId 来源；公共约定进 `common/`。
2. **无长期价值**（纯一次性定位过程）→ 保留在回执/changelog 片段中即可，不进正文。
3. `note` 字段为空或纯过程描述时跳过，不强行生成正文。

## 片段结构（写入 pitfalls.md / decisions/ 时）

```markdown
### PIT-<域>-<序号>: <一句话教训>
- 适用条件: <什么场景下会遇到>
- 根因: <当时的实际问题>
- 正确做法: <结论>
- 来源: <storyId / QUICK storyId，含 knowledge-receipt 路径>
```

## 与既有生命周期的关系

- `changelog/` 仍由 `record` 命令自动生成审查片段，经验片段**不手写进 changelog/**。
- `prune --base` 的清理规则不受影响：经验正文在 `pitfalls.md`/`decisions/`，属于被保护的知识正文。
- `history --scope domain:<id>` 可追溯回执来源；被引用的经验片段随 Git 历史保留。

## 禁止事项

- 不复制整段对话或整个回执进正文——只提炼结论与适用条件。
- 不把未经源码验证的猜测写成 pitfalls（先验证再沉淀）。
- 不为「写而写」：无新经验时明确记录「无新增经验」，跳过正文更新。
