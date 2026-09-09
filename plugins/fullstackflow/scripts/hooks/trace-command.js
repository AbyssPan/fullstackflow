#!/usr/bin/env node
/**
 * trace-command.js — 命令/Skill/MCP 调用后自动追加 trace.jsonl 记录
 *
 * 职责:
 *   - 在工具调用完成后识别 harness 命令、Skill 调用、MCP 调用三类事件
 *   - 将事件以 JSONL 追加到当前 running Story 的 trace.jsonl
 *   - 全程静默失败，绝不阻塞主流程（始终 continue: true）
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: PostToolUse
 *   输入: stdin JSON（{ tool_name, tool_input: { command | skill } }，由 stdin 'end' 事件驱动）
 *   输出: stdout JSON（恒为 { continue: true }，不做任何拦截）
 *   手动调试: echo '{"tool_name":"Bash","tool_input":{"command":"node advance-phase.js S-1 2"}}' | node trace-command.js
 *
 * 使用场景:
 *   - 复盘一次 Harness 流程时缺少「谁在什么时候执行了什么」的时间线：
 *     不记录就只能靠对话历史回溯，跨会话、跨 Agent 的执行轨迹完全丢失，
 *     Phase 卡住时无法定位是命令没跑、跑错参数还是被 Hook 拦下。
 *   - session-stop.js 需要从 trace.jsonl 里捞出 hook_rejection 沉淀经验：
 *     没有 trace 就没有经验采集的输入源，门控只能重复硬拦而无法形成历史失败模式库。
 *
 * 说明:
 *   - 事件类型判定:
 *       harness 命令 — tool_input.command 命中 advance-phase / harness-workflow / archive-story
 *       Skill 调用   — tool_name 为 Skill 或 use_skill
 *       MCP 调用     — tool_name 形如 mcp__<server>__<tool>
 *     三类都不命中则直接返回，不写 trace。
 *   - 只写入扫描到的第一个 status='running' 的 Story，写完即 break。
 *   - 项目根取自 CODEBUDDY_PROJECT_DIR / CLAUDE_PROJECT_DIR / process.cwd()；
 *     Windows 下归一化 Git Bash / MSYS 风格盘符路径（"/d/xxx" → "d:/xxx"）。
 *   - harness 命令沿用 tool_executed 语义（timestamp 字段）以兼容既有消费方；Skill / MCP 用 tool_call 语义（ts 字段）。
 *   - @module trace-command-hook
 */
const fs = require('fs')
const path = require('path')

// 读取 stdin 数据
const chunks = []
process.stdin.on('readable', () => {
  let chunk
  while ((chunk = process.stdin.read()) !== null) chunks.push(chunk)
})

process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8').trim()
  if (!input) {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  let event
  try { event = JSON.parse(input) } catch {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  // 判定事件类型：harness 命令 / Skill 调用 / MCP 调用
  const toolName = event.tool_name || ''
  const cmd = event.tool_input?.command || ''

  // 1. harness 命令（advance-phase / harness-workflow / archive-story）
  const isHarnessCmd = cmd.includes('advance-phase') || cmd.includes('harness-workflow') || cmd.includes('archive-story')
  // 2. Skill 调用（CodeBuddy 中 tool_name 为 Skill，input 里带 skill 名）
  const isSkill = toolName === 'Skill' || toolName === 'use_skill'
  // 3. MCP 调用（tool_name 形如 mcp__<server>__<tool>）
  const isMcp = /^mcp__/.test(toolName)

  if (!isHarnessCmd && !isSkill && !isMcp) {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  // 记录 trace
  try {
    // 归一化 Git Bash / MSYS 风格盘符路径（"/d/xxx" → "d:/xxx"），仅 Windows
    const rawRoot = process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const winDrive = process.platform === 'win32' ? /^\/([a-zA-Z])\/(.*)$/.exec(rawRoot) : null
    const PROJECT_ROOT = winDrive ? `${winDrive[1]}:/${winDrive[2]}` : rawRoot
    const plansDir = path.join(PROJECT_ROOT, '.codebuddy', 'plans')
    const storyDirs = fs.existsSync(plansDir)
      ? fs.readdirSync(plansDir).filter(d => fs.statSync(path.join(plansDir, d)).isDirectory())
      : []

    for (const storyId of storyDirs) {
      const e2ePath = path.join(plansDir, storyId, 'e2e-state.json')
      if (!fs.existsSync(e2ePath)) continue
      const state = JSON.parse(fs.readFileSync(e2ePath, 'utf-8'))
      if (state.status === 'running') {
        const tracePath = path.join(plansDir, storyId, 'trace.jsonl')
        // 根据事件类型构造不同的事件记录
        let entry
        if (isSkill) {
          // Skill 调用：提取 skill 名
          const skillName = event.tool_input?.skill || event.tool_input?.command || ''
          entry = JSON.stringify({
            ts: new Date().toISOString(),
            type: 'tool_call',
            tool: toolName,
            skill: skillName.substring(0, 100),
            phase: state.phase != null ? String(state.phase) : null,
            result: 'success',
            storyId
          })
        } else if (isMcp) {
          // MCP 调用：tool_name = mcp__<server>__<tool>，拆出 server 与 tool
          const parts = toolName.split('__')
          entry = JSON.stringify({
            ts: new Date().toISOString(),
            type: 'tool_call',
            tool: toolName,
            mcp: parts[1] || null,
            mcpTool: parts.slice(2).join('__') || null,
            phase: state.phase != null ? String(state.phase) : null,
            result: 'success',
            storyId
          })
        } else {
          // harness 命令（保留原有 tool_executed 语义，兼容既有消费方）
          entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'tool_executed',
            tool: toolName,
            command: cmd.substring(0, 200),
            storyId
          })
        }
        fs.appendFileSync(tracePath, entry + '\n')
        break
      }
    }
  } catch {
    // 静默失败，不阻塞主流程
  }

  console.log(JSON.stringify({ continue: true }))
})
