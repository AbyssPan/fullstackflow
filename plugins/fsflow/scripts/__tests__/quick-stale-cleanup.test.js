#!/usr/bin/env node
/**
 * quick-stale-cleanup.test.js — v1.5.1 quick 中断任务清理回归
 *
 * 场景: quick 任务发出后取消 AI 回复 / 关闭窗口，任务残留 in_progress、
 * pending/绑定记录无人认领，干扰次日新会话。覆盖:
 *   - cancel: 显式取消（置终态、撤销 dev-pass、清除激活记录、恢复 Normal 编辑）
 *   - cancel 错误路径: 非 quick / 已结束 / 不存在
 *   - create 自动取消: 未签发限域的陈旧任务（>24h 无活动）随新任务创建自动取消
 *   - create 不动已签发限域的陈旧任务: 仅报告，交用户决定（cancel / 继续 / 并行）
 *   - 过期 pending 清理与判定: 不再触发 ambiguous，也不被新会话懒认领
 *   - 过期绑定判定: 异常退出的旧会话绑定不导致新会话 unbound 误拒
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-stale-'))
const pluginRoot = path.resolve(__dirname, '../..')
process.env.CLAUDE_PROJECT_DIR = root
process.env.CODEBUDDY_PROJECT_DIR = root
delete process.env.FSFLOW_QUICK_STALE_HOURS
delete process.env.FSFLOW_PENDING_TTL_HOURS
delete process.env.FSFLOW_BINDING_TTL_HOURS
delete process.env.HARNESS_RUN_BUILD

const state = require('../lib/state')
const plans = path.join(root, '.codebuddy', 'plans')
const QUICK = path.join(pluginRoot, 'scripts/commands/quick-task.js')

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
  const r = cp.spawnSync(process.execPath, [QUICK, ...args], {
    encoding: 'utf8', env: { ...process.env, CODEBUDDY_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}
function editHook (file, sessionId) {
  const payload = { tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } }
  if (sessionId !== undefined) payload.session_id = sessionId
  const r = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/hooks/enforce-dev-pass.js')], {
    cwd: root, env: process.env, encoding: 'utf8', input: JSON.stringify(payload)
  })
  assert.ifError(r.error)
  return r.status
}
/** 把 quick 任务的任务文件与状态文件回拨到 hoursBefore 小时前 */
function backdateTask (storyId, hoursBefore) {
  const past = new Date(Date.now() - hoursBefore * 3600 * 1000).toISOString()
  for (const f of ['quick-task.json', 'e2e-state.json']) {
    const p = path.join(plans, storyId, f)
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (data.createdAt !== undefined) data.createdAt = past
    if (data.updatedAt !== undefined) data.updatedAt = past
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
  }
}
function backdatePending (storyId, hoursBefore) {
  const rec = state.readHarnessRecords().pending.find(p => p.storyId === storyId)
  assert.ok(rec, 'pending 记录存在')
  const p = path.join(plans, '.harness-active', rec.file)
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
  data.pendingSince = new Date(Date.now() - hoursBefore * 3600 * 1000).toISOString()
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}
function taskOf (id) {
  return JSON.parse(fs.readFileSync(path.join(plans, id, 'quick-task.json'), 'utf-8'))
}
/** 用例间隔离: 取消前序用例遗留的 in_progress 任务（多任务并行是合法状态，需显式清场） */
function cancelAllInProgress () {
  for (const id of fs.readdirSync(plans).filter(d => d.startsWith('QUICK-'))) {
    try { if (taskOf(id).status === 'in_progress') runQuick(['cancel', id, '测试隔离']) } catch (_) { /* 忽略 */ }
  }
}

try {
  cp.execFileSync('git', ['init', '-q', root])
  write('.gitignore', '.codebuddy/\n')
  write('src/a/fix.js', 'const a = 1\n')
  cp.execFileSync('git', ['add', '.'], { cwd: root })
  cp.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root })

  // ─── cancel ─────────────────────────────────────────────────
  test('cancel: 取消已签发限域的任务，清理全部记录并恢复 Normal 编辑', () => {
    const r = runQuick(['create', '被中断的任务'])
    assert.equal(r.status, 0, r.stderr)
    const id = JSON.parse(r.stdout).data.storyId
    // 签发限域 + 会话认领（模拟做到一半）
    write(`.codebuddy/plans/${id}/quick-task.json`, {
      ...taskOf(id), files: ['src/a/fix.js'], acceptance: ['AC-1']
    })
    assert.equal(runQuick(['scope', id]).status, 0)
    assert.equal(editHook('src/a/fix.js', 'sess-cancel-1'), 0, '限域内放行')

    const c = runQuick(['cancel', id, '用户不要了'])
    assert.equal(c.status, 0, c.stderr)
    const out = JSON.parse(c.stdout)
    assert.equal(out.data.status, 'cancelled')
    assert.equal(taskOf(id).status, 'cancelled')
    assert.equal(taskOf(id).cancelReason, '用户不要了')
    assert.equal(state.readStateFile(id).status, 'cancelled')
    assert.equal(state.checkDevPass(id).valid, false, 'dev-pass 已撤销')
    assert.equal(state.readHarnessRecords().bindings.length, 0, '激活记录已清除')
    assert.equal(editHook('src/a/fix.js', 'sess-cancel-1'), 0, '恢复 Normal（放行）')
  })

  test('cancel 错误路径: 不存在 / 非 quick / 已结束', () => {
    assert.equal(runQuick(['cancel', 'NO-SUCH']).status, 1)
    state.ensureStoryDir('FULL-1')
    state.writeStateFile('FULL-1', { storyId: 'FULL-1', phase: 0, status: 'running', mode: 'run' })
    assert.equal(runQuick(['cancel', 'FULL-1']).status, 1, '非 quick 模式拒绝')
    const r = runQuick(['create', '已完成的任务'])
    const id = JSON.parse(r.stdout).data.storyId
    write(`.codebuddy/plans/${id}/quick-task.json`, { ...taskOf(id), evidence: ['x'] })
    assert.equal(runQuick(['done', id]).status, 0)
    assert.equal(runQuick(['cancel', id]).status, 1, '已结束任务无需取消')
  })

  // ─── create 自动取消未签发限域的陈旧任务 ────────────────────
  test('create: 未签发限域的陈旧任务（>24h）被自动取消并知会', () => {
    const r = runQuick(['create', '昨天发出后取消回复的任务'])
    const old = JSON.parse(r.stdout).data.storyId
    backdateTask(old, 25) // 从未 scope → files[] 为空

    const r2 = runQuick(['create', '今天的新任务'])
    assert.equal(r2.status, 0, r2.stderr)
    const out = JSON.parse(r2.stdout)
    assert.deepEqual(out.data.autoCancelled.map(t => t.storyId), [old], '旧任务已自动取消')
    assert.equal(taskOf(old).status, 'cancelled')
    assert.ok(out.message.includes('自动取消'), '输出知会自动取消')

    const records = state.readHarnessRecords()
    assert.equal(records.pending.length, 1, '仅剩新任务 pending')
    assert.equal(records.pending[0].storyId, out.data.storyId)
  })

  test('create: 已签发限域的陈旧任务不自动取消，报告交用户决定', () => {
    const r = runQuick(['create', '做到一半隔天的任务'])
    const old = JSON.parse(r.stdout).data.storyId
    write(`.codebuddy/plans/${old}/quick-task.json`, {
      ...taskOf(old), files: ['src/a/fix.js'], acceptance: ['AC-1']
    })
    assert.equal(runQuick(['scope', old]).status, 0)
    backdateTask(old, 30)

    const r2 = runQuick(['create', '另一个新任务'])
    assert.equal(r2.status, 0, r2.stderr)
    const out = JSON.parse(r2.stdout)
    assert.equal(out.data.autoCancelled.length, 0, '不自动取消')
    assert.equal(out.data.staleActive.length, 1)
    assert.equal(out.data.staleActive[0].storyId, old)
    assert.ok(out.message.includes('询问用户'), '输出要求询问用户')
    assert.equal(taskOf(old).status, 'in_progress', '旧任务保持原状')

    assert.equal(runQuick(['cancel', old, '不要了']).status, 0, '用户决定放弃后显式取消')
    assert.equal(taskOf(old).status, 'cancelled')
  })

  // ─── 过期 pending / 绑定 ────────────────────────────────────
  test('过期 pending: 不阻塞新会话、不被懒认领，create 时被物理清理', () => {
    cancelAllInProgress()
    const r = runQuick(['create', '残留 pending 的任务'])
    const old = JSON.parse(r.stdout).data.storyId
    backdatePending(old, 25)

    assert.equal(editHook('src/a/fix.js', 'sess-fresh-1'), 0, '过期 pending 不阻塞新会话（Normal 放行）')
    assert.equal(state.readHarnessRecords().pending.filter(p => p.storyId === old).length, 1,
      '判定阶段不物理删除')

    const r2 = runQuick(['create', '触发清理的任务'])
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(state.readHarnessRecords().pending.filter(p => p.storyId === old).length, 0,
      '过期 pending 已被清理')
  })

  test('过期绑定: 异常退出会话的残留不导致新会话 unbound 误拒', () => {
    cancelAllInProgress()
    const r = runQuick(['create', '绑定残留的任务'])
    const id = JSON.parse(r.stdout).data.storyId
    // 模拟会话认领后异常退出（无 Stop 清理）
    assert.ok(state.claimHarnessRecord('sess-dead-9999', id), '绑定已写入')
    const rec = state.readHarnessRecords().bindings.find(b => b.sessionId === 'sess-dead-9999')
    const p = path.join(plans, '.harness-active', rec.file)
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    data.claimedAt = new Date(Date.now() - 49 * 3600 * 1000).toISOString()
    fs.writeFileSync(p, JSON.stringify(data, null, 2))

    // 新会话（绑定其他会话的过期记录）编辑 → Normal 放行而非 unbound 拒绝
    assert.equal(editHook('src/a/fix.js', 'sess-new-1'), 0, '过期绑定不阻塞新会话')
    // 清理验证
    const purged = state.purgeStaleHarnessRecords()
    assert.ok(purged.bindings.includes(id), '过期绑定被 purge 清除')
    assert.equal(editHook('src/a/fix.js', 'sess-new-1'), 0)
  })

  test('TTL 环境变量生效: FSFLOW_QUICK_STALE_HOURS=1 时 2h 前的任务即判陈旧', () => {
    cancelAllInProgress()
    const r = runQuick(['create', '短 TTL 任务'])
    const old = JSON.parse(r.stdout).data.storyId
    backdateTask(old, 2)
    const r2 = cp.spawnSync(process.execPath, [QUICK, 'create', '短 TTL 触发任务'], {
      encoding: 'utf8',
      env: { ...process.env, CODEBUDDY_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, FSFLOW_QUICK_STALE_HOURS: '1' }
    })
    assert.equal(r2.status, 0, r2.stderr)
    const out = JSON.parse(r2.stdout)
    assert.deepEqual(out.data.autoCancelled.map(t => t.storyId), [old], '1h TTL 下 2h 前的任务被自动取消')
  })

  console.log(`Quick stale cleanup: ${count} checks passed`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
