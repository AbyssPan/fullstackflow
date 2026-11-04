#!/usr/bin/env node
/**
 * quick-route-lifecycle.test.js — v1.5 quick 模式生命周期回归
 *
 * 覆盖:
 *   - create: QUICK- 目录、quick-task.json、e2e-state(mode=quick, phase=2)、pending 激活记录、harnessEvent 协议
 *   - scope: files[] 空拒绝 / 超 3 个拒绝 / 风险路径拒绝 / 正常签发精确限域 dev-pass
 *   - 会话认领后编辑: 限域内放行、限域外拒绝（复用 Phase 2 dev-pass 语义，hook 零改动）
 *   - done: 证据为空拒绝；有证据置终态（completed/phase 8）、撤销 dev-pass、清除激活记录、写知识回执
 *   - escalate: 产出 schema 合法的 story-input（fixbugs），e2e-state 重置 Phase 0，dispatch 可起跑
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-quick-'))
const pluginRoot = path.resolve(__dirname, '../..')
process.env.CLAUDE_PROJECT_DIR = root
process.env.CODEBUDDY_PROJECT_DIR = root
delete process.env.HARNESS_RUN_BUILD

const state = require('../lib/state')
const plans = path.join(root, '.codebuddy', 'plans')

let count = 0
function test (name, action) {
  action()
  count++
  console.log(`  OK ${name}`)
}
function write (file, value) {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value))
}
function runQuick (args) {
  const r = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/commands/quick-task.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, CODEBUDDY_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}
function editHook (file, sessionId) {
  const r = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/hooks/enforce-dev-pass.js')], {
    cwd: root, env: process.env, encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, file) }, session_id: sessionId })
  })
  assert.ifError(r.error)
  return { status: r.status, output: (() => { try { return JSON.parse(r.stdout) } catch (_) { return null } })() }
}
function firstQuickId () {
  const ids = fs.readdirSync(plans).filter(d => d.startsWith('QUICK-'))
  assert.equal(ids.length, 1, `期望唯一 QUICK 任务，实际: ${ids.join(', ')}`)
  return ids[0]
}

try {
  cp.execFileSync('git', ['init', '-q', root])
  write('.gitignore', '.codebuddy/\n')
  write('src/a/fix.js', 'const a = 1\n')
  write('src/b/other.js', 'const b = 1\n')
  write('src/db/migrations/init.sql', '-- migration\n')
  cp.execFileSync('git', ['add', '.'], { cwd: root })
  cp.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root })

  // ─── create ─────────────────────────────────────────────────
  test('create 生成 QUICK 任务目录、契约与状态并输出 harnessEvent 协议', () => {
    const r = runQuick(['create', '修复列表页空指针', '--story', 'STORY-REF-1'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.harnessEvent, 'start')
    const id = out.data.storyId
    assert(/^QUICK-\d{8}-\d{2}$/.test(id), id)

    const task = JSON.parse(fs.readFileSync(path.join(plans, id, 'quick-task.json'), 'utf-8'))
    assert.equal(task.mode, 'quick')
    assert.equal(task.status, 'in_progress')
    assert.equal(task.relatedStoryId, 'STORY-REF-1')

    const st = state.readStateFile(id)
    assert.equal(st.mode, 'quick')
    assert.equal(st.phase, 2)
    assert.equal(st.status, 'running')
    assert.equal(st.quickStatus, 'in_progress')

    const records = state.readHarnessRecords()
    assert(records.pending.some(p => p.storyId === id), 'pending 激活记录已写入')
  })

  // ─── scope 校验 ─────────────────────────────────────────────
  test('scope: files[] 为空拒绝', () => {
    const id = firstQuickId()
    const r = runQuick(['scope', id])
    assert.equal(r.status, 1)
    assert(r.stderr.includes('files[] 为空'))
  })

  test('scope: 超过 3 个文件拒绝并提示升格', () => {
    const id = firstQuickId()
    const taskPath = path.join(plans, id, 'quick-task.json')
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    task.files = ['src/a/fix.js', 'src/b/other.js', 'src/c.js', 'src/d.js']
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    const r = runQuick(['scope', id])
    assert.equal(r.status, 1)
    assert(r.stderr.includes('超过 quick 上限'))
  })

  test('scope: 风险路径（迁移 SQL）拒绝并提示升格', () => {
    const id = firstQuickId()
    const taskPath = path.join(plans, id, 'quick-task.json')
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    task.files = ['src/db/migrations/init.sql']
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    const r = runQuick(['scope', id])
    assert.equal(r.status, 1)
    assert(r.stderr.includes('风险触发'))
  })

  test('scope: 正常签发精确限域 dev-pass，会话编辑限域内放行/限域外拒绝', () => {
    const id = firstQuickId()
    const taskPath = path.join(plans, id, 'quick-task.json')
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    task.files = ['src/a/fix.js']
    task.acceptance = ['列表页不再抛出空指针']
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))

    const r = runQuick(['scope', id])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.deepEqual(out.data.allowedPaths, [{ repo: state.loadRepos(id).primary, path: 'src/a/fix.js' }])

    // 会话认领 pending 后，dev-pass Phase 2 语义直接生效（hook 零改动）
    assert.equal(editHook('src/a/fix.js', 'sess-quick-1').status, 0, '限域内放行')
    assert.equal(editHook('src/b/other.js', 'sess-quick-1').status, 2, '限域外拒绝')
  })

  // ─── done ───────────────────────────────────────────────────
  test('dispatch 误调用: quick 任务不派 Agent，指引 quick 生命周期', () => {
    const id = firstQuickId()
    const { dispatch } = require('../commands/dispatch')
    const result = dispatch(id)
    assert.equal(result.status, 'ready')
    assert.equal(result.nextAgent, null, 'quick 不派子 Agent')
    assert(result.instruction.includes('quick'), result.instruction)
    assert.equal(result.recovery.type, 'quick_lifecycle')
    // 已结束的 quick 任务走正常 terminal
  })

  test('done: 证据为空拒绝（定向自测是 quick 唯一质量底线）', () => {
    const id = firstQuickId()
    const r = runQuick(['done', id])
    assert.equal(r.status, 1)
    assert(r.stderr.includes('evidence[] 为空'))
  })

  test('done: 有证据置终态、撤销 dev-pass、清除激活记录、写知识回执', () => {
    const id = firstQuickId()
    const taskPath = path.join(plans, id, 'quick-task.json')
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    task.evidence = ['node test/a.test.js → 3 passed', 'eslint src/a/fix.js → 0 errors']
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))

    const r = runQuick(['done', id, '--note', '该模块判空逻辑缺失，后续注意'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.harnessEvent, 'end')

    const st = state.readStateFile(id)
    assert.equal(st.status, 'completed')
    assert.equal(st.phase, 8)
    assert.equal(st.quickStatus, 'done')

    const finalTask = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    assert.equal(finalTask.status, 'done')

    const receipt = JSON.parse(fs.readFileSync(path.join(plans, id, 'knowledge-receipt.json'), 'utf-8'))
    assert.equal(receipt.storyId, id)
    assert.equal(receipt.note, '该模块判空逻辑缺失，后续注意')
    assert.equal(receipt.evidence.length, 2)

    assert.equal(state.checkDevPass(id).valid, false, 'dev-pass 已撤销')
    assert.equal(state.readHarnessRecords().pending.length, 0, '激活记录已清除')
    // 记录清空后 src/ 恢复 Normal（与 harness end 一致）
    assert.equal(editHook('src/a/fix.js', 'sess-quick-1').status, 0)
  })

  // ─── escalate ───────────────────────────────────────────────
  test('escalate: 升格为完整 fixbugs（合法 story-input + Phase 0 重置 + dispatch 起跑）', () => {
    const r = runQuick(['create', '修复支付回调签名校验'])
    assert.equal(r.status, 0, r.stderr)
    const ids = fs.readdirSync(plans).filter(d => d.startsWith('QUICK-'))
    const id = ids.find(d => state.readStateFile(d)?.quickStatus === 'in_progress')
    assert.ok(id, '新 quick 任务存在')

    const taskPath = path.join(plans, id, 'quick-task.json')
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    task.files = ['src/api/callback.js']
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    // 接口路径触发风险 → scope 拒绝 → 走 escalate
    const scopeR = runQuick(['scope', id])
    assert.equal(scopeR.status, 1)
    assert(scopeR.stderr.includes('风险触发'))

    const esc = runQuick(['escalate', id, '涉及接口层，需要完整审查'])
    assert.equal(esc.status, 0, esc.stderr)
    const escOut = JSON.parse(esc.stdout)
    assert.equal(escOut.ok, true)
    assert.equal(escOut.data.mode, 'fixbugs')

    const input = JSON.parse(fs.readFileSync(path.join(plans, id, 'story-input.json'), 'utf-8'))
    assert.equal(input.mode, 'fixbugs')
    assert.equal(input.title, '修复支付回调签名校验')
    assert(input.sources.text.includes('quick 升格'))
    // schema 白名单校验（additionalProperties:false）
    assert.deepEqual(Object.keys(input).sort(), ['mode', 'sources', 'title'])

    const st = state.readStateFile(id)
    assert.equal(st.mode, 'fixbugs')
    assert.equal(st.phase, 0)
    assert.equal(st.status, 'running')
    assert.equal(st.quickStatus, 'escalated')

    const finalTask = JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
    assert.equal(finalTask.status, 'escalated')
    assert.equal(finalTask.escalateReason, '涉及接口层，需要完整审查')

    // 完整流程调度可起跑
    const d = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/commands/dispatch.js'), id], {
      encoding: 'utf8', env: { ...process.env, CODEBUDDY_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }
    })
    assert.equal(d.status, 0, d.stderr)
    const dispatchOut = JSON.parse(d.stdout)
    assert.equal(dispatchOut.nextAgent, 'requirement-analyst')
  })

  console.log(`Quick route lifecycle: ${count} checks passed`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
