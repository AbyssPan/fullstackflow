# 更新日志

## 1.5.0（2026-11-04）

围绕「需求交付后的人工审查 + 多会话小范围修改 + 手动提交」工作模式的一次大版本更新。
定位：新需求走完整工作流，P3 审查通过后进入待人工检查终态即结束；后续小改动 / Bug 修复走
quick 轻量流程，全部变更由用户手动汇总提交。

### 1. 会话级 Harness 激活隔离（支撑多对话框并行）

- `.harness-active` 由全局单文件改为目录式记录：`<sessionId>.json`（会话绑定）+
  `pending-*.json`（待认领）。
- `start` / `resume` 写 pending 记录并输出 `harnessEvent` 协议（`{ok, harnessEvent, data.storyId}`），
  PostToolUse 钩子按 `session_id` 认领为本会话绑定；PreToolUse 懒认领唯一 pending。
- 不同对话框可各持一个任务并行推进，dev-pass 限域互不越界、互不覆盖。
- `start` 仅拒绝同一 Story 重复激活；`resume` 不再拒绝「其他 Story 激活中」。
- `end [storyId]`：无参清除唯一记录，多会话时清本会话绑定，指定 storyId 强制清除该 Story 全部记录。
- 兼容：旧版全局单文件仍可读取；宿主未提供 `session_id` 时降级为旧单激活语义（唯一记录时生效，
  多记录歧义拒绝）。
- Stop 钩子自动收尾改为遍历全部激活记录，按 Story 终态逐一清除，其他会话记录不受影响。

### 2. quick 轻量修改模式（`/fsflow:quick`）

- 新增 `quick-task.js`：`create` / `scope` / `done` / `escalate` / `status` 生命周期管理。
- 新增命令 `/fsflow:quick [relatedStoryId] "<修改描述>"` 与 `harness-quick` skill。
- 单 Agent（主 Agent）执行：定位 → 限域签发 → 修改 → 定向自测 → 收尾，免完整 8-Phase 往返。
- 安全底线不降：dev-pass 按 `quick-task.json` 的 `files[]` 精确限域（≤3 个文件；迁移 / Schema /
  权限 / 接口风险路径触发即拒绝并引导升格）；定向自测证据必须落 `evidence[]`，否则 `done` 拒绝。
- `done` 写轻量知识回执 `knowledge-receipt.json`（每次必写），撤销 dev-pass、清除激活记录。
- `escalate` 升格完整 fixbugs：产出 schema 合法的 `story-input.json`，e2e-state 重置 Phase 0，
  已做工作保留在 Story 目录。
- 状态保护：`quick-task.js` 列入 `enforce-state-file.js` 授权白名单；`quick-task.json` 由 Agent
  直接填写；dispatch 对 quick 任务不派 Agent，返回 quick 生命周期指引；session-start 注入
  quick 专用恢复块，强制规则 2 为 quick 加例外。

### 3. manual 交付模式（完整流程止于人工检查）

- `story-input` 新增 `deliveryMode` 字段（`auto` | `manual`），取值链：
  story-input > 环境变量 `FSFLOW_DELIVERY_MODE` > 默认 `auto`。
- `advance-phase` 在 Phase 4→5 且 manual 时：Phase 4 门控照常执行（质量底线不降），通过后
  重定向为待人工检查终态（phase=8 completed），P5–P7 标记 `skipped`（skipReason=
  `delivery_mode_manual` 留痕），dev-pass 兜底撤销。
- manual 下不派发布助手：Git 提交、MR、合入核验、云端发布均由用户人工完成；知识维护前移到
  人工检查确认后执行（建议一次 kb-update 域维护），`kb-maintenance` Git hook 在手动提交时兜底。
- 工作流语义定稿：工作流终点 = P3 审查通过后的待人工检查终态；后续人工审查 / 优化 / quick
  修复不计算进原工作流，quick 为独立单完结任务（`relatedStoryId` 仅追溯关联）。
- `verificationMode` 维持默认 `ask`（每新 Story 询问一次是否执行独立测试，选跳过后不再询问）；
  P3 AI 代码审查保留、不可跳过。

### 4. Compound Engineering 三件套移植

- `simplify-code` skill：P2 完成后 / quick 完成前，对限域内新代码做不改行为语义的精炼
  （删无用代码 / 测试 / 冗余注释），留痕进 `development-notes` / `evidence`。
- `kb-update/references/compound.md`：经验片段分拣规则——quick 回执与按次经验按长期价值
  收敛到域级 `pitfalls.md` / `decisions/`，无长期价值保留回执；`changelog/` 保持脚本独占。
- `oracle-reviewer` 独立评审员 Agent：两个按需触发点——P1 方案分歧打平时的候选方案 bakeoff、
  P3 BLOCKER 高风险问题独立复核；只输出确认 / 否决 + 证据，最终裁决留给用户。

### 5. 文档与版本

- README：命令表 / 技能表（18）/ Agent 表（7）/ quick 与多会话 / manual 交付说明。
- INSTALL：冒烟测试命令清单补 `quick`；`fullstack` 兼容入口补 `quick` 子命令。
- conductor 参考文档（phase-1/2/3/5/7、commands、hooks）同步新语义。
- 版本号 1.4.0 → 1.5.0，同步 `plugin.json` / `package.json` / 双 marketplace 清单。

### 测试

新增 3 个测试文件共 29 项断言，全套 21 个测试文件全绿：

- `session-isolation.test.js`（14 项）：pending / 懒认领 / 双向限域隔离 / unbound / 歧义 /
  PostToolUse 认领协议 / end 清理 / 旧单文件兼容。
- `quick-route-lifecycle.test.js`（9 项）：create / scope 校验 / 限域编辑 / dispatch 守卫 /
  done 收尾 / escalate 升格。
- `delivery-mode-manual.test.js`（6 项）：deliveryMode 取值链 / 4→5 重定向 / auto 行为不变 /
  门控不降级。

### 已知边界

- 会话认领依赖宿主 hook stdin 携带 `session_id`（Claude Code / CodeBuddy 均提供），
  已设计无字段降级路径，建议双对话框实测一次。
- quick 免独立审查与测试，质量兜底 = lint + 定向自测 + 用户人工检查；团队共用环境建议
  保持 `deliveryMode: auto`。

### 升级注意

- 旧项目的全局单文件 `.harness-active` 无需手工迁移，新版直接兼容读取；新写入自动使用目录布局。
- 无破坏性变更：`deliveryMode` 默认 `auto`、`verificationMode` 默认 `ask`，既有流程行为不变。
