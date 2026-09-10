---
description: 运行 FullstackFlow 自进化体检、度量、诊断和验证
argument-hint: '[storyId|all] [--check-only|--propose-only]'
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /fullstackflow:evolve — 工作流自进化

用户参数：`$ARGUMENTS`

调用 `use_skill("fullstackflow:harness-evolve")`，将用户参数原样作为分析范围与选项。
默认只产出诊断和修改提案；未经用户确认，不自动修改插件文件。
