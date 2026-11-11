# 单段执行

**适用**：只做一件明确的事，不走完整流程。

## 命令形态

```
/fsflow:only <技能名> "<任务描述>" [--write]
```

不带 `--write` 时只能读、不能写；技能需要产生产物文件时会先提示再停。

## 常用组合

**只生成接口定义**

```
/fsflow:only api-generator "从 <Swagger 地址或文件路径> 生成用户模块接口定义" --write
```

会先探测项目现有的请求封装、命名、注释风格，出「模式画像」等你确认，再写入文件。

**只写测试用例**

```
/fsflow:only test-design-and-execution "为退款提交流程写用例，覆盖参数校验、重复提交和失败重试" --write
```

**只查知识库**

```
/fsflow:only kb-query "退款超时自动关闭的判定逻辑在哪个模块"
```

**只读设计清单**

```
/fsflow:only figma-to-component-map "梳理这个设计稿的页面与组件清单" <Figma 链接>
```

**只定位问题不改代码**

```
/fsflow:only systematic-debugging "订单列表偶发白屏，先定位根因，不要改代码"
```

## 可用技能

| 档位 | 技能 |
|---|---|
| 只读（默认允许） | `code-review`、`figma-to-component-map`、`tapd-bug-analyzer`、`kb-query`、`frontend-tech-spec`、`backend-tech-spec` |
| 写入（需 `--write`） | `api-generator`、`test-design-and-execution`、`systematic-debugging`、`gen-project-docs`、`kb-init`、`kb-update` |

4 个 `harness-*` 流程技能不能单段执行，会被拒绝并提示改用 `/fsflow:run`。

## 注意事项

- 单段执行**不建 Story、不产生 Phase 证据、无限域保护**，改动边界由自己确认。
- 需要门控、审计或长期跟踪时改走 `/fsflow:run`。
- 技能名写错不会自动纠正，会列出可用清单。
