# 中断后继续

**适用**：上次没跑完（会话断了、被打断、换了机器），要接着做同一个需求。

## 第一步：看现在在哪

```
/fsflow:status
```

输出会给出当前 Story、所处 Phase、阻塞项与下一步建议。先读它，再决定是否继续。

## 第二步：继续

按 status 的提示直接说：

```
继续 <storyId>
```

或指定从哪一阶段接：

```
继续 <storyId>，从 Phase 3 审查开始
```

不需要重新粘贴需求描述——`story-input.json`、`task-dag.json`、`acceptance-criteria.json` 都留在 `.codebuddy/plans/<storyId>/` 里。

## 常见情况

| 状态 | 含义 | 该做什么 |
|---|---|---|
| `verification_choice_required` | 等你选测试方式 | 回一句「跑完整功能测试」或「只做静态审查」 |
| `blocked` | 缺前置条件（账号、环境、设计稿） | 补齐后说「继续」 |
| `fix_loop` | 审查或测试未过，正在返工 | 看阻塞项，必要时补证据 |
| `terminal` | 已结束 | 新需求请开 `/fsflow:run` |

## 注意事项

- 换目录启动时先确认 `CODEBUDDY_PROJECT_DIR` 指向同一项目根，否则找不到 Story。
- 状态文件被手工改过会触发校验失败；不要为了跳过门控手改 `e2e-state.json`，会被 Hook 拦截并记录。
- 想放弃当前 Story 并解除编辑锁：`/fsflow:end`；想留档：`/fsflow:archive <storyId> archive`。
