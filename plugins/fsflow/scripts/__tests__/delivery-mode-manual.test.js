#!/usr/bin/env node
/**
 * delivery-mode-manual.test.js — v1.5 manual 交付模式回归
 *
 * 覆盖:
 *   - createWorkflow: story-input.deliveryMode / 环境变量 FSFLOW_DELIVERY_MODE / 默认 auto 三级取值
 *   - advance-phase 4→5 (manual): 门控正常执行后重定向为待人工检查终态
 *     （phase=8 completed，P5-P7 skipped 留痕，dev-pass 兜底撤销，输出 manual_check 指引）
 *   - advance-phase 4→5 (auto): 行为不变（phase=5 running），确认 manual 分支不影响默认路径
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-manual-'))
process.env.CODEBUDDY_PROJECT_DIR = sandbox
process.env.CLAUDE_PROJECT_DIR = sandbox
delete process.env.FSFLOW_DELIVERY_MODE
delete process.env.HARNESS_RUN_BUILD

const state = require('../lib/state')
const { createWorkflow } = require('../commands/create-workflow')
const dir = id => path.join(state.PLANS_DIR, id)
const write = (id, file, data) => fs.writeFileSync(path.join(dir(id), file), typeof data === 'string' ? data : JSON.stringify(data))
const run = (args) => spawnSync(process.execPath, [path.join(__dirname, '../commands/advance-phase.js'), ...args], {
  encoding: 'utf8', env: { ...process.env, CODEBUDDY_PROJECT_DIR: sandbox, CLAUDE_PROJECT_DIR: sandbox }
})
/** 从含门控日志的 stdout 中提取最后的 JSON 对象 */
const parseOut = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))

let count = 0
function test (name, action) {
  action()
  count++
  console.log(`  OK ${name}`)
}

/** 搭建一个 Phase 4、门控可通过（测试全过、审查无 blocker）的 Story */
function fixturePhase4 (id, deliveryMode) {
  fs.mkdirSync(dir(id), { recursive: true })
  state.ensureReposJson(id)
  state.writeStateFile(id, {
    storyId: id, phase: 4, status: 'running', mode: 'run',
    verificationMode: 'full', deliveryMode,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phases: {
      '0_requirement_analysis': { status: 'completed' },
      '1_task_planning': { status: 'completed' },
      '2_development': { status: 'completed' },
      '3_code_review': { status: 'completed' },
      '4_e2e_verification': { status: 'running' }
    }
  })
  write(id, 'requirement-analysis.md', '需求')
  write(id, 'task-dag.md', '计划')
  write(id, 'task-dag.json', { tasks: [{ id: 'T1', title: '改动', acceptanceCriteria: ['AC-1'], files: ['src/a.js'] }] })
  write(id, 'acceptance-criteria.json', { criteria: [{ id: 'AC-1', description: '接口返回成功', testType: 'api' }] })
  write(id, 'code-review.json', { storyId: id, issues: [], summary: { blockerCount: 0, warningCount: 0, suggestionCount: 0 } })
  write(id, 'test-report.md', '全部通过')
  write(id, 'acceptance-verification.json', {
    results: [{ id: 'AC-1', status: 'passed', evidence: ['接口 200'], evidenceType: 'api' }],
    summary: { total: 1, passed: 1, failed: 0, unverifiable: 0 }
  })
}

try {
  // ─── deliveryMode 取值链 ────────────────────────────────────
  test('story-input.deliveryMode=manual → 状态文件为 manual', () => {
    fs.mkdirSync(dir('DM-INPUT'), { recursive: true })
    write('DM-INPUT', 'story-input.json', { mode: 'run', deliveryMode: 'manual', sources: {} })
    const r = createWorkflow('DM-INPUT', '手动交付', false, false, 'run')
    assert.equal(r.success, true, JSON.stringify(r.errors))
    assert.equal(state.readStateFile('DM-INPUT').deliveryMode, 'manual')
  })

  test('环境变量 FSFLOW_DELIVERY_MODE=manual → 缺省输入时生效', () => {
    process.env.FSFLOW_DELIVERY_MODE = 'manual'
    const r = createWorkflow('DM-ENV', '环境变量', false, false, 'run')
    assert.equal(r.success, true)
    assert.equal(state.readStateFile('DM-ENV').deliveryMode, 'manual')
    delete process.env.FSFLOW_DELIVERY_MODE
  })

  test('默认（无输入无环境变量）→ auto', () => {
    const r = createWorkflow('DM-AUTO', '默认', false, false, 'run')
    assert.equal(r.success, true)
    assert.equal(state.readStateFile('DM-AUTO').deliveryMode, 'auto')
  })

  // ─── advance-phase 4→5 重定向 ───────────────────────────────
  test('manual: Phase 4→5 重定向为待人工检查终态（P5-P7 跳过留痕、dev-pass 撤销）', () => {
    fixturePhase4('DM-P4', 'manual')
    // 构造残留 dev-pass 验证兜底撤销
    state.issueDevPass('DM-P4', 3600000, [{ repo: state.loadRepos('DM-P4').primary, path: 'src/**' }])
    const r = run(['DM-P4', '5'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const out = parseOut(r.stdout)
    assert.equal(out.success, true)
    assert.equal(out.deliveryMode, 'manual')
    assert.equal(out.toPhase, 8)
    assert.deepEqual(out.skippedPhases, [5, 6, 7])
    assert.equal(out.nextAction.action, 'manual_check')

    const st = state.readStateFile('DM-P4')
    assert.equal(st.phase, 8)
    assert.equal(st.status, 'completed')
    assert.equal(st.phases['4_e2e_verification'].status, 'completed')
    assert.equal(st.phases['5_git_submit'].status, 'skipped')
    assert.equal(st.phases['5_git_submit'].skipReason, 'delivery_mode_manual')
    assert.equal(st.phases['6_knowledge_base_update'].status, 'skipped')
    assert.equal(st.phases['7_deployment'].status, 'skipped')
    assert.equal(state.checkDevPass('DM-P4').valid, false, 'dev-pass 已兜底撤销')
  })

  test('auto: Phase 4→5 行为不变（不受 manual 分支影响）', () => {
    fixturePhase4('DM-AUTO-P4', 'auto')
    const r = run(['DM-AUTO-P4', '5'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const st = state.readStateFile('DM-AUTO-P4')
    assert.equal(st.phase, 5)
    assert.equal(st.status, 'running')
    assert.equal(st.phases['5_git_submit'].status, 'running')
    assert.equal(st.phases['5_git_submit'].skipReason, undefined)
  })

  test('manual: 门控不达标时不重定向（质量底线不降）', () => {
    fixturePhase4('DM-FAIL', 'manual')
    // 破坏验收结果：AC-1 failed
    write('DM-FAIL', 'acceptance-verification.json', {
      results: [{ id: 'AC-1', status: 'failed', evidence: ['接口 500'], evidenceType: 'api' }],
      summary: { total: 1, passed: 0, failed: 1, unverifiable: 0 }
    })
    const r = run(['DM-FAIL', '5'])
    assert.equal(r.status, 1)
    const out = parseOut(r.stdout)
    assert.equal(out.success, false)
    assert.equal(out.gatePassed, false)
    const st = state.readStateFile('DM-FAIL')
    assert.equal(st.phase, 4, '门控失败不推进、不重定向')
  })

  console.log(`Delivery mode manual: ${count} checks passed`)
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
