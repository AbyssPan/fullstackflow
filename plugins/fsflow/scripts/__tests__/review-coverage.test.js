#!/usr/bin/env node
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { snapshot, validateCoverage } = require('../../skills/code-review/scripts/review-scope.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-review-'))
process.env.CLAUDE_PROJECT_DIR = root
process.env.CODEBUDDY_PROJECT_DIR = root
const state = require('../lib/state')
const policy = require('../services/policy')
const { createWorkflow } = require('../commands/create-workflow')
const { dispatch } = require('../commands/dispatch')
const schema = require('../services/schema-validator')
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' })
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
const finish = snap => ({ ...snap, files: snap.files.map(f => ({ ...f, status: 'reviewed', evidence: '核对本文件变更与测试夹具行为' })) })
const coverage = snap => ({ version: 1, repositories: [finish(snap)] })
const repos = { primary: 'app', repos: { app: root } }
try {
  git('init', '-q')
  write('新建 空格.js', 'const value = 1\n')
  const unborn = snapshot(root, 'app')
  assert.equal(unborn.head, null)
  assert.deepEqual(unborn.files.map(f => f.path), ['新建 空格.js'])
  assert.deepEqual(validateCoverage(coverage(unborn), repos), [])
  git('add', '.')
  git('commit', '-qm', 'base')
  const baseCommit = git('rev-parse', 'HEAD').trim()
  write('staged.js', 'module.exports = 1\n')
  write('deleted.js', 'module.exports = 2\n')
  write('renamed.js', 'module.exports = 3\n')
  git('add', '.')
  git('commit', '-qm', 'fixtures')
  write('staged.js', 'module.exports = 2\n')
  git('add', 'staged.js')
  write('新建 空格.js', 'const value = 2\n')
  write('untracked\nname.ts', 'export const x = 1\n')
  fs.unlinkSync(path.join(root, 'deleted.js'))
  fs.renameSync(path.join(root, 'renamed.js'), path.join(root, 'moved.js'))
  write('.codebuddy/plans/S/code-review.json', '{}')
  const snap = snapshot(root, 'app')
  assert.deepEqual(snap.files.map(f => f.path).sort(), ['staged.js', '新建 空格.js', 'untracked\nname.ts', 'deleted.js', 'renamed.js', 'moved.js'].sort())
  assert.ok(snap.excluded.some(f => f.path.endsWith('code-review.json')))
  assert.deepEqual(validateCoverage(coverage(snap), repos), [])
  const missing = coverage(snap)
  missing.repositories[0].files.pop()
  assert.ok(validateCoverage(missing, repos).some(s => s.includes('遗漏')))
  const duplicate = coverage(snap)
  duplicate.repositories[0].files.push(duplicate.repositories[0].files[0])
  assert.ok(validateCoverage(duplicate, repos).some(s => s.includes('重复')))
  const skipped = coverage(snap)
  skipped.repositories[0].files[0].status = 'skipped'
  assert.ok(validateCoverage(skipped, repos).some(s => s.includes('原因')))
  skipped.repositories[0].files[0].reason = '测试夹具明确跳过的文件，保留风险'
  assert.deepEqual(validateCoverage(skipped, repos), [])
  const pending = coverage(snap)
  delete pending.repositories[0].files[0].evidence
  assert.ok(validateCoverage(pending, repos).some(s => s.includes('依据')))
  write('staged.js', 'module.exports = 3\n')
  assert.ok(validateCoverage(coverage(snap), repos).some(s => s.includes('已变化')))
  write('staged.js', 'module.exports = 2\n')
  const fresh = snapshot(root, 'app')
  git('reset', '-q', 'HEAD', '--', 'staged.js')
  assert.ok(validateCoverage(coverage(fresh), repos).some(s => s.includes('暂存区')))
  const latest = snapshot(root, 'app')
  const issue = { id: 'B1', project: 'app', file: 'staged.js', line: 999, status: 'open' }
  assert.ok(validateCoverage(coverage(latest), repos, [issue]).some(s => s.includes('行号')))
  issue.line = 1
  assert.deepEqual(validateCoverage(coverage(latest), repos, [issue]), [])
  issue.file = 'deleted.js'
  assert.deepEqual(validateCoverage(coverage(latest), repos, [issue]), [])
  issue.file = '../outside.js'
  assert.ok(validateCoverage(coverage(latest), repos, [issue]).some(s => s.includes('范围')))
  assert.ok(validateCoverage(coverage(latest), { primary: 'app', repos: { app: root, other: root } }).length)
  // 暂存删除后同名重建，改变暂存区仍会使证据失效。
  git('rm', '--cached', '-q', 'staged.js')
  const recreated = snapshot(root, 'app')
  assert.equal(recreated.files.filter(f => f.path === 'staged.js').length, 1)
  assert.notEqual(recreated.files.find(f => f.path === 'staged.js').fingerprint, latest.files.find(f => f.path === 'staged.js').fingerprint)
  // 显式比较旧提交能包含当前 HEAD 已提交的文件。
  assert.ok(snapshot(root, 'app', baseCommit).files.some(f => f.path === 'deleted.js'))
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../../skills/code-review/scripts/review-scope.cjs'), '--repo', root, '--project', 'app'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).project, 'app')
  // 部分暂存时问题可能只存在于 index，不应按最终工作区行数误拒绝。
  write('staged.js', 'line1\nline2\nline3\n')
  git('add', 'staged.js')
  write('staged.js', 'line1\n')
  const partial = coverage(snapshot(root, 'app'))
  const indexIssue = { id: 'B2', status: 'open', file: 'staged.js', line: 3, lineVersion: 'index' }
  assert.deepEqual(validateCoverage(partial, repos, [indexIssue]), [])
  delete indexIssue.lineVersion
  assert.ok(validateCoverage(partial, repos, [indexIssue]).some(s => s.includes('行号')))

  // 真正建流与调度门控：缺记录/过期 -> 审查，语义缺陷 -> 开发修复。
  createWorkflow('COVER', 'coverage', false, false, 'fixbugs')
  const workflow = state.readStateFile('COVER')
  assert.equal(workflow.reviewCoverageRequired, true)
  workflow.phase = 3
  state.writeStateFile('COVER', workflow)
  write('.codebuddy/plans/COVER/repos.json', JSON.stringify(repos))
  const report = { storyId: 'COVER', issues: [], summary: { blockerCount: 0, warningCount: 0, suggestionCount: 0 } }
  const save = () => write('.codebuddy/plans/COVER/code-review.json', JSON.stringify(report))
  save()
  assert.equal(policy.runGateCheck('COVER', 3, workflow).passed, false)
  assert.equal(dispatch('COVER').nextAgent, 'code-reviewer')
  report.coverage = coverage(snapshot(root, 'app'))
  save()
  assert.equal(schema.validateArtifact('COVER', 'code-review.json').valid, true)
  assert.equal(policy.runGateCheck('COVER', 3, workflow).passed, true)
  assert.equal(dispatch('COVER').readyToAdvance, true)
  write('moved.js', 'module.exports = 99\n')
  assert.equal(dispatch('COVER').nextAgent, 'code-reviewer')
  assert.notEqual(dispatch('COVER').status, 'fix_loop')
  report.coverage = coverage(snapshot(root, 'app'))
  report.issues = [{ id: 'B1', severity: 'BLOCKER', status: 'open', file: 'moved.js', line: 1, project: 'app', title: '测试缺陷', description: '测试夹具中值不符合要求' }]
  report.summary.blockerCount = 1
  save()
  assert.equal(dispatch('COVER').status, 'fix_loop')
  // 旧工作流保持既有格式；新报告主动提交 coverage 则仍要验证。
  delete workflow.reviewCoverageRequired
  delete report.coverage
  report.issues = []
  report.summary.blockerCount = 0
  save()
  assert.equal(policy.runGateCheck('COVER', 3, workflow).passed, true)
  report.coverage = { version: 1, repositories: [] }
  save()
  assert.equal(policy.runGateCheck('COVER', 3, workflow).passed, false)
  write('binary.bin', Buffer.from([0, 1, 2]))
  fs.symlinkSync('/not/a/readable/target', path.join(root, 'external-link'))
  const beforeStatus = git('status', '--porcelain', '-z')
  const special = snapshot(root, 'app')
  assert.equal(special.files.find(f => f.path === 'binary.bin').afterLines, 0)
  assert.equal(special.files.find(f => f.path === 'external-link').kind, 'symlink')
  assert.equal(git('status', '--porcelain', '-z'), beforeStatus) // 快照不修改索引/工作区
  assert.deepEqual(validateCoverage(coverage(special), repos), [])
  git('add', '.')
  git('commit', '-qm', 'new head')
  assert.ok(validateCoverage(coverage(special), repos).some(s => s.includes('HEAD')))
  console.log('审查覆盖回归通过：范围、暂存/未跟踪、删除/重命名、旧基线、版本失效、问题位置、调度与兼容')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
