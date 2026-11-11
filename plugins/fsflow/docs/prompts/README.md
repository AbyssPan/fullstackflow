# 启动提示词模板

复制模板里的命令，替换 `<...>` 占位后发送即可。不需要先理解 `storyId`、`verificationMode` 或 `dev-pass`——这些由流程自己生成。

## 选哪个

| 模板 | 适用场景 | 对应命令 |
|---|---|---|
| [新功能开发](run-new-feature.md) | 有一个功能需求，要走完整链路 | `/fsflow:run` |
| [TAPD 缺陷修复](fixbugs-from-tapd.md) | 缺陷来自 TAPD，需要根因分析与回归 | `/fsflow:fixbugs` |
| [只审查](review-only.md) | 只想审一段改动，不要流程 | `/fsflow:only code-review` |
| [单段执行](only-single-step.md) | 只生成接口定义 / 只写用例 / 只查知识库 | `/fsflow:only <skill>` |
| [多仓库任务](multi-repo.md) | 前端与后端在不同仓库 | `/fsflow:run` |
| [中断后继续](resume-from-phase.md) | 上次没跑完，要接着做 | `/fsflow:status` |
| [审查后修复](review-then-fix.md) | 审查发现了问题，只想修这些 | `/fsflow:fixbugs` |

## 通用规则

- **一次一个目标**。两件不相关的事分两次启动，不要塞进一条需求。
- **写清边界**。期望行为要包含「为空 / 失败 / 无权限 / 超长文本」时怎么做，否则会进入集中追问。
- **不写实现方案**。方案由规划阶段产出；提前指定技术方案会让规划与审查失去判断空间。
- **有设计稿就附链接**。`run` 带 Figma 链接时会启用设计契约门控，缺链接则不启用。
- 缺信息时流程会集中提问，不会静默假设；被追问时补充事实即可，不必重新组织整段需求。

## 完整命令参考

| 命令 | 用途 |
|---|---|
| `/fsflow:run [storyId] "<需求>"` | 开发新功能或改造现有功能 |
| `/fsflow:fixbugs [storyId] "<缺陷>"` | 分析根因并修复，可附 TAPD 信息 |
| `/fsflow:only <skill> "<任务>" [--write]` | 单段执行一个技能，不建 Story |
| `/fsflow:status` | 查看当前任务、阶段和阻塞项 |
| `/fsflow:end` | 结束激活会话并解除编辑门控 |
| `/fsflow:evolve [storyId\|all] [--check-only\|--propose-only]` | 工作流体检与改进建议 |
| `/fsflow:archive <storyId> <archive\|restore\|list\|status>` | 归档、恢复或查看历史 |
