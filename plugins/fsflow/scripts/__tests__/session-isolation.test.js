#!/usr/bin/env node
/**
 * session-isolation.test.js — v1.5 会话级 Harness 激活隔离回归
 *
 * 覆盖:
 *   - start 写 pending 待认领记录（.harness-active/ 目录）
 *   - 同一 Story 重复激活被拒绝；不同 Story 并行激活合法
 *   - PreToolUse 懒认领: 带 session_id 的首个编辑请求认领唯一 pending
 *   - 会话隔离: 两个会话各自绑定不同 Story，dev-pass 限域互不越界
 *   - unbound（其他会话激活、本会话未绑定）拒绝编辑
 *   - 无 session_id + 多条激活记录 → 拒绝（歧义）
 *   - 无 session_id + 唯一绑定 → 降级为旧单激活语义（放行判定仍走 dev-pass）
 *   - trace-command PostToolUse 认领协议: harnessEvent start/resume/end 维护会话绑定
 *   - end <storyId> 清除指定 Story 全部记录；全部清空后恢复 Normal 模式
 *   - 旧版单文件 .harness-active 兼容读取
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-session-'))
const pluginRoot = path.resolve(__dirname, '../..')
process.env.CLAUDE_PROJECT_DIR = root
process.env.CODEBUDDY_PROJECT_DIR = root
delete process.env.HARNESS_RUN_BUILD

const state = require('../lib/state')
const { createWorkflow } = require('../commands/create-workflow')

const plans = path.join(root, '.codebuddy', 'plans')
const activeDir = path.join(plans, '.harness-active')
const STORY_A = 'SESS-A'
const STORY_B = 'SESS-B'

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
function hook (name, toolName, toolInput, sessionId) {
  const payload = { tool_name: toolName, tool_input: toolInput }
  if (sessionId !== undefined) payload.session_id = sessionId
  const result = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/hooks', name)], {
    cwd: root, env: process.env, encoding: 'utf8', input: JSON.stringify(payload)
  })
  assert.ifError(result.error)
  let output = null
  try { output = JSON.parse(result.stdout) } catch (_) { /* 拒绝输出也可能是 JSON */ }
  return { status: result.status, output }
}
function runCli (args) {
  const r = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/commands/harness-workflow.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, CODEBUDDY_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}
function editHook (file, sessionId) {
  return hook('enforce-dev-pass.js', 'Edit', { file_path: path.join(root, file) }, sessionId)
}
function setPhase2 (storyId) {
  const st = state.readStateFile(storyId)
  st.phase = 2
  st.status = 'running'
  state.writeStateFile(storyId, st)
}
function postToolUse (command, sessionId, responseStdout) {
  const payload = {
    tool_name: 'Bash',
    tool_input: { command },
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(responseStdout !== undefined ? { tool_response: { stdout: responseStdout } } : {})
  }
  const r = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/hooks/trace-command.js')], {
    cwd: root, env: process.env, encoding: 'utf8', input: JSON.stringify(payload)
  })
  assert.ifError(r.error)
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

try {
  cp.execFileSync('git', ['init', '-q', root])
  write('.gitignore', '.codebuddy/\n')
  write('src/a/one.js', 'const a = 1\n')
  write('src/b/two.js', 'const b = 1\n')
  cp.execFileSync('git', ['add', '.'], { cwd: root })
  cp.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root })

  createWorkflow(STORY_A, '会话A的需求', false, false, 'run')
  createWorkflow(STORY_B, '会话B的需求', false, false, 'fixbugs')
  setPhase2(STORY_A)
  setPhase2(STORY_B)
  state.issueDevPass(STORY_A, 3600000, [{ repo: state.loadRepos(STORY_A).primary, path: 'src/a/**' }])
  state.issueDevPass(STORY_B, 3600000, [{ repo: state.loadRepos(STORY_B).primary, path: 'src/b/**' }])

  // ─── start: pending 记录与重复激活 ──────────────────────────
  test('start 写 pending 待认领记录并输出 harnessEvent 协议', () => {
    const r = runCli(['start', STORY_A, '会话A的需求'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.harnessEvent, 'start')
    assert.equal(out.data.storyId, STORY_A)
    const records = state.readHarnessRecords()
    assert.equal(records.pending.length, 1)
    assert.equal(records.pending[0].storyId, STORY_A)
  })

  test('同一 Story 重复激活被拒绝', () => {
    const r = runCli(['start', STORY_A, '重复激活'])
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, false)
    assert.equal(state.readHarnessRecords().pending.length, 1, '仍只有 A 的 pending')
  })

  // ─── 懒认领与会话隔离 ──────────────────────────────────────
  test('带 session_id 的首个编辑请求懒认领唯一 pending 为会话绑定', () => {
    const result = editHook('src/a/one.js', 'sess-1111-AAAA')
    assert.equal(result.status, 0, JSON.stringify(result.output))
    const binding = state.readHarnessBinding('sess-1111-AAAA')
    assert.ok(binding, '会话绑定已写入')
    assert.equal(binding.storyId, STORY_A)
    assert.equal(state.readHarnessRecords().pending.length, 0, 'pending 已被认领')
  })

  test('会话 A 限域生效: 范围内放行、范围外拒绝', () => {
    assert.equal(editHook('src/a/one.js', 'sess-1111-AAAA').status, 0)
    assert.equal(editHook('src/b/two.js', 'sess-1111-AAAA').status, 2)
  })

  test('会话 B 通过 PostToolUse 认领协议绑定自己的 Story，与 A 互不越界', () => {
    // 真实链路: start 输出 JSON（含 harnessEvent）由 PostToolUse 解析认领
    const r = runCli(['start', STORY_B, '会话B的需求'])
    assert.equal(r.status, 0, r.stderr)
    const startOut = r.stdout
    const claimed = postToolUse('node harness-workflow.js start SESS-B "会话B的需求"', 'sess-2222-BBBB', startOut)
    assert.equal(claimed.status, 0, claimed.stderr)
    const binding = state.readHarnessBinding('sess-2222-BBBB')
    assert.ok(binding, 'B 会话绑定已写入')
    assert.equal(binding.storyId, STORY_B)
    // B 的 dev-pass 范围是 src/b/**
    assert.equal(editHook('src/b/two.js', 'sess-2222-BBBB').status, 0)
    // B 会话改 A 的文件被拒（隔离双向）
    assert.equal(editHook('src/a/one.js', 'sess-2222-BBBB').status, 2)
    // A 会话改 B 的文件同样被拒
    assert.equal(editHook('src/b/two.js', 'sess-1111-AAAA').status, 2)
  })

  test('多条 pending 且会话无绑定 → 歧义拒绝（懒认领不猜测）', () => {
    // 构造双 pending 场景: 启动两个新 Story 且均不认领（模拟 PostToolUse 认领失败的降级态）
    createWorkflow('SESS-C', '会话C的需求', false, false, 'run')
    createWorkflow('SESS-D', '会话D的需求', false, false, 'run')
    runCli(['start', 'SESS-C', '会话C的需求'])
    runCli(['start', 'SESS-D', '会话D的需求'])
    assert.equal(state.readHarnessRecords().pending.length, 2)
    const result = editHook('src/a/one.js', 'sess-3333-CCCC')
    assert.equal(result.status, 2)
    assert(result.output.stopReason.includes('Multiple pending') || result.output.stopReason.includes('待认领'), result.output.stopReason)
    runCli(['end', 'SESS-C'])
    runCli(['end', 'SESS-D'])
  })

  test('unbound 会话（其他会话已激活、本会话未绑定）被拒绝', () => {
    const result = editHook('src/a/one.js', 'sess-7777-GGGG')
    assert.equal(result.status, 2)
    assert(result.output.stopReason.includes('not bound') || result.output.stopReason.includes('未绑定'), result.output.stopReason)
  })

  test('无 session_id 且多条激活记录 → 歧义拒绝', () => {
    const result = editHook('src/a/one.js')
    assert.equal(result.status, 2)
  })

  test('无 session_id 且仅一条绑定 → 降级旧单激活语义（仍走 dev-pass 判定）', () => {
    runCli(['end', STORY_A])
    // 清掉 A 后剩 B 一条绑定
    const records = state.readHarnessRecords()
    assert.equal(records.bindings.length, 1)
    assert.equal(records.bindings[0].storyId, STORY_B)
    assert.equal(editHook('src/b/two.js').status, 0, '唯一绑定降级后按 B 的 dev-pass 放行')
    assert.equal(editHook('src/a/one.js').status, 2, '唯一绑定降级后 B 范围外仍拒绝')
    // 恢复 A 供后续用例
    runCli(['resume', STORY_A])
    const after = state.readHarnessRecords()
    assert.equal(after.pending.filter(p => p.storyId === STORY_A).length, 1)
  })

  // ─── trace-command PostToolUse 认领协议 ────────────────────
  test('PostToolUse 依据 harnessEvent:start 输出认领会话绑定（消费 pending）', () => {
    // 此时 A 有一条 pending（上一步 resume 产生），PostToolUse 依据 start 输出认领
    const stdout = JSON.stringify({ ok: true, harnessEvent: 'start', data: { storyId: STORY_A, title: '会话A的需求', mode: 'run' } })
    const r = postToolUse('node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js start SESS-A "会话A的需求"', 'sess-4444-DDDD', stdout)
    assert.equal(r.status, 0, r.stderr)
    const binding = state.readHarnessBinding('sess-4444-DDDD')
    assert.ok(binding, 'PostToolUse 已写会话绑定')
    assert.equal(binding.storyId, STORY_A)
    assert.equal(state.readHarnessRecords().pending.filter(p => p.storyId === STORY_A).length, 0, 'pending 已被消费')
  })

  test('PostToolUse 依据 harnessEvent:end 清除本会话绑定', () => {
    const stdout = JSON.stringify({ ok: true, harnessEvent: 'end', data: { storyIds: [] } })
    const r = postToolUse('node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js end', 'sess-4444-DDDD', stdout)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(state.readHarnessBinding('sess-4444-DDDD'), null)
  })

  // ─── end 清理与恢复 Normal ─────────────────────────────────
  test('end <storyId> 清除指定 Story 全部记录，其他 Story 记录不受影响', () => {
    // 为 A 重新产生一条 pending（sess-4444 的绑定已在上一用例清除）
    runCli(['resume', STORY_A])
    const r = runCli(['end', STORY_B])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.harnessEvent, 'end')
    // B 的绑定被清
    assert.equal(state.readHarnessBinding('sess-2222-BBBB'), null)
    // A 的记录（resume 产生的 pending）保留
    const records = state.readHarnessRecords()
    assert(records.pending.some(p => p.storyId === STORY_A), 'A 的待认领记录不受影响')
    // B 会话的编辑不再有 B 的 dev-pass 背书，被拒绝
    assert.equal(editHook('src/b/two.js', 'sess-2222-BBBB').status, 2)
  })

  test('全部记录清空后恢复 Normal 模式（任意会话放行）', () => {
    runCli(['end', STORY_A])
    assert.equal(editHook('src/a/one.js', 'sess-1111-AAAA').status, 0)
    assert.equal(editHook('src/b/two.js', 'sess-9999-ZZZZ').status, 0)
    assert.equal(editHook('src/a/one.js').status, 0)
  })

  // ─── 旧版单文件兼容 ─────────────────────────────────────────
  test('旧版单文件 .harness-active 兼容读取（无 session_id）', () => {
    // 清掉记录目录，模拟旧版本留下的单文件布局
    fs.rmSync(activeDir, { recursive: true, force: true })
    write('.codebuddy/plans/.harness-active', { active: true, storyId: STORY_A })
    assert.equal(editHook('src/a/one.js').status, 0, '旧单文件按 A 的 dev-pass 放行')
    assert.equal(editHook('src/b/two.js').status, 2, '旧单文件下 B 范围外拒绝')
    const withSid = editHook('src/a/one.js', 'sess-5555-EEEE')
    assert.equal(withSid.status, 0, '有 session_id 时旧单文件同样生效（legacy 模式）')
    fs.rmSync(path.join(plans, '.harness-active'), { force: true })
  })

  console.log(`Session isolation: ${count} checks passed`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
