#!/usr/bin/env node
/**
 * manual-commit-e2e.test.js — 人工提交端到端回归
 *
 * 覆盖（2026-11-12 流程终点改造）：
 *   - Phase 5 无 trace 凭证但用户已人工提交（涉及仓库已跟踪文件全部干净）时：
 *     dispatch 门控兜底放行（ready + readyToAdvance，无需再派 Agent）
 *   - advance 5→6 可直接进入终态（phase=6 completed，5_git_submit completed）
 *   - 终态后 dispatch 输出 terminal + 归档命令
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { spawnSync } = require('child_process')

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-manual-e2e-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX

const state = require('../lib/state')
const { dispatch } = require('../commands/dispatch')

const id = 'E2E-MANUAL'
const dir = path.join(state.PLANS_DIR, id)
try {
  fs.mkdirSync(dir, { recursive: true })

  // 仓库：git init + 提交本 Story 变更（模拟用户人工提交，工作区干净）
  const repo = path.join(SANDBOX, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  for (const args of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) {
    spawnSync('git', args, { cwd: repo })
  }
  fs.writeFileSync(path.join(repo, 'a.js'), 'fix applied')
  spawnSync('git', ['add', '.'], { cwd: repo })
  spawnSync('git', ['commit', '-q', '-m', 'fix: manual commit by user'], { cwd: repo })
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ primary: 'main', repos: { main: repo } }))

  // Phase 4 已过 + phase=5 运行中（无任何 trace 提交凭证）
  fs.writeFileSync(path.join(dir, 'requirement-analysis.md'), '需求')
  fs.writeFileSync(path.join(dir, 'task-dag.md'), '计划')
  fs.writeFileSync(path.join(dir, 'task-dag.json'), JSON.stringify({ tasks: [{ id: 'T1', title: '改动', acceptanceCriteria: ['AC-1'], files: ['src/a.js'] }] }))
  fs.writeFileSync(path.join(dir, 'acceptance-criteria.json'), JSON.stringify({ criteria: [{ id: 'AC-1', description: '接口返回成功', testType: 'api' }] }))
  fs.writeFileSync(path.join(dir, 'code-review.json'), JSON.stringify({ storyId: id, issues: [], summary: { blockerCount: 0, warningCount: 0, suggestionCount: 0 } }))
  fs.writeFileSync(path.join(dir, 'test-report.md'), '全部通过')
  fs.writeFileSync(path.join(dir, 'acceptance-verification.json'), JSON.stringify({
    results: [{ id: 'AC-1', status: 'passed', evidence: ['接口 200'], evidenceType: 'api' }],
    summary: { total: 1, passed: 1, failed: 0, unverifiable: 0 }
  }))
  state.writeStateFile(id, {
    storyId: id, phase: 5, status: 'running', mode: 'run', verificationMode: 'full',
    deliveryMode: 'auto', executionEvidenceRequired: true,
    phases: {
      '0_requirement_analysis': { status: 'completed' },
      '1_task_planning': { status: 'completed' },
      '2_development': { status: 'completed' },
      '3_code_review': { status: 'completed' },
      '4_e2e_verification': { status: 'completed' },
      '5_git_submit': { status: 'running', startedAt: new Date().toISOString() }
    }
  })

  const before = dispatch(id)
  assert.equal(before.status, 'ready')
  assert.equal(before.nextAgent, null, '门控已兜底放行，无需再派 Agent')
  assert.equal(before.readyToAdvance, true, '人工提交兜底应给出可推进信号')
  assert.ok(String(before.advanceCommand || '').includes('advance-phase.js'), 'advanceCommand 应指向 advance-phase.js')

  const adv = spawnSync(process.execPath, [path.join(__dirname, '../commands/advance-phase.js'), id, '6'], { encoding: 'utf8' })
  assert.equal(adv.status, 0, adv.stdout + adv.stderr)

  const st = state.readStateFile(id)
  assert.equal(st.phase, 6)
  assert.equal(st.status, 'completed')
  assert.equal(st.phases['5_git_submit'].status, 'completed')

  const after = dispatch(id)
  assert.equal(after.status, 'terminal')
  assert.ok(String(after.recovery && after.recovery.command || '').includes('archive-story.js'), '终态 recovery 应为归档命令')

  console.log('manual commit e2e: dispatch 兜底放行 → advance 终态 → terminal 归档指引 passed')
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
}
