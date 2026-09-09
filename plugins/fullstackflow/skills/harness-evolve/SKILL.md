---
name: harness-evolve
description: Harness 自进化分析 — 体检(audit) → 度量(metrics) → 诊断(mining) → 治疗(proposal) → 验证(validation) 五步闭环
---

# /harness-evolve — Harness 自进化分析

> 参考: Self-Harness (上海AI Lab, 2026) + harness-audit.js + metrics-aggregator.js

## 用法

```
/harness-evolve <storyId>              # 完整五步闭环分析
/harness-evolve all                     # 分析所有已归档 Story
/harness-evolve <storyId> --check-only  # 只跑体检+度量
/harness-evolve <storyId> --propose-only # 只跑提案+验证
```

## AI 执行协议

当用户执行 `/harness-evolve` 时:

1. 调用 `use_skill("harness-evolve")` 加载自进化 Skill

2. 执行五步闭环:

   **Step 0: 体检** — 运行 harness-audit.js --json
   - 获取 settings/hooks/活跃Story/产出物完整性状态

   **Step 1: 度量** — 运行 metrics-aggregator.js --json
   - 获取 Phase耗时/门控通过率/fix-loop触发率等趋势数据

   **Step 2: 诊断** — 结合体检+度量+ trace.jsonl + fix-request.json
   - 区分新问题 vs 持续问题
   - BLOCKER根因归类 + 流程瓶颈定位

   **Step 3: 治疗** — 生成 Harness 修改提案
   - 目标文件: agents/*.md / policy.js / advance-phase.js / schemas/
   - evolutionLevel: lesson(单次) / pattern(跨Story) / instinct(自动注入)

   **Step 4: 验证** — 模拟验证修改效果
   - 对比修改前后 fix-loop/BLOCKER/耗时
   - 采纳/拒绝/inconclusive
   - 采纳后重新 audit 评分

3. 输出结构化自进化报告

4. 不自动修改文件，由用户确认后执行

## 示例

```bash
/harness-evolve STORY-20260710-01
/harness-evolve all --check-only
```
