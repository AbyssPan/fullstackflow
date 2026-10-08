#!/usr/bin/env node
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-light-'))
process.env.CODEBUDDY_PROJECT_DIR = root
process.env.CLAUDE_PROJECT_DIR = root
const state = require('../lib/state')
const trace = require('../lib/trace')
const { createWorkflow } = require('../commands/create-workflow')
const { selectRoute } = require('../services/workflow-route')
const { dispatch } = require('../commands/dispatch')
const id = 'LIGHT'
const dir = path.join(state.PLANS_DIR, id)
const write = (file, data) => fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data))
const advance = phase => spawnSync(process.execPath, [path.join(__dirname, '../commands/advance-phase.js'), id, String(phase)], { encoding: 'utf8' })
const experienceFiles = ['failure-patterns.json', 'metrics-insights.json'].map(f => path.join(__dirname, '../experience', f))
const before = experienceFiles.map(f => fs.readFileSync(f))
try {
  fs.mkdirSync(dir, { recursive: true })
  write('story-input.json', { mode: 'run', sources: { text: '修正文案' } })
  createWorkflow(id, 'small change', false, false, 'run', { inputFile: path.join(dir, 'story-input.json') })
  const current = () => state.readStateFile(id)
  assert.equal(current().workflowProfile, 'auto')
  assert.equal(selectRoute(id, current()).profile, 'full', 'missing risk evidence stays full')
  const scope = { risk: 'low', files: ['src/page.js'], crossModule: false, publicApiChanged: false, dependenciesChanged: false, dataMigration: false, securitySensitive: false, evidence: ['已检查本地页面及调用方，无边界变化'] }
  write('change-scope.json', scope)
  assert.equal(selectRoute(id, current()).profile, 'light')
  write('task-dag.json', { tasks: [null] })
  assert.equal(selectRoute(id, current()).profile, 'full', 'malformed tasks fail closed without crashing dispatch')
  write('task-dag.json', { tasks: [{ repoPath: 42, files: scope.files }] })
  assert.equal(selectRoute(id, current()).profile, 'full')
  fs.unlinkSync(path.join(dir, 'task-dag.json'))
  const policy = require('../services/policy')
  const gateCheck = policy.runGateCheck
  try {
    policy.runGateCheck = () => { throw new Error('fixture: gate unavailable') }
    assert.equal(dispatch(id).status, 'blocked')
    assert.equal(dispatch(id).advanceCommand, null, 'a gate exception cannot advertise a successful advance')
  } finally { policy.runGateCheck = gateCheck }
  for (const key of ['crossModule', 'publicApiChanged', 'dependenciesChanged', 'dataMigration', 'securitySensitive']) {
    write('change-scope.json', { ...scope, [key]: true })
    assert.equal(selectRoute(id, current()).profile, 'full', key)
  }
  for (const files of [['src/**'], ['../a.js'], ['src/auth/a.js'], ['package.json'], ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']]) {
    write('change-scope.json', { ...scope, files })
    assert.equal(selectRoute(id, current()).profile, 'full')
  }
  write('change-scope.json', scope)
  assert.equal(selectRoute(id, { ...current(), hasFigmaDesign: true }).profile, 'full')
  write('story-input.json', { mode: 'run', workflowProfile: 'full', sources: {} })
  assert.equal(selectRoute(id, current()).profile, 'full')
  write('story-input.json', { mode: 'run', workflowProfile: 'auto', sources: {} })
  write('requirement-analysis.md', '# 需求\n## Grill 决策摘要\n### 目标\n修改文案。\n### 非目标\n不改交互。\n### 关键决策\n使用现有组件。\n### Capabilities 拆分\npage-copy\n### 风险\n低风险，已查调用方。')
  write('acceptance-criteria.json', { featurePoints: [{ id: 'FP-1', source: '页面文案', coverage: 'covered', acIds: ['AC-1'] }], criteria: [{ id: 'AC-1', capability: 'page-copy', changeType: 'modified', description: '页面必须显示更新后的文案', testType: 'ui', given: '页面打开', when: '查看标题', then: '显示新标题' }] })
  write('open-questions.json', { questions: [] })
  write('task-dag.md', '# 最小规划\n修改页面文案并验证显示。')
  const task = { id: 'task-1', title: '更新文案', files: ['src/page.js'], acceptanceCriteria: ['AC-1'], parallelizable: false }
  write('task-dag.json', { tasks: [{ ...task, files: ['src/other.js'] }] })
  assert.equal(selectRoute(id, current()).profile, 'full', 'expanded plan cannot stay light')
  write('task-dag.json', { tasks: [task] })
  assert.equal(dispatch(id).readyToAdvance, true)
  assert.equal(advance(1).status, 0)
  assert.equal(dispatch(id).workflowRoute.profile, 'light')
  assert.equal(dispatch(id).readyToAdvance, true, 'combined preparation avoids a second planner invocation')
  assert.equal(dispatch(id).nextAgent, null)
  assert.equal(advance(2).status, 0)
  assert.equal(dispatch(id).nextAgent, 'fullstack-developer', 'empty git diff cannot skip development')
  assert.equal(advance(3).status, 1)
  trace.tracePhaseOutcome(id, 2, 'completed', { evidence: ['测试夹具：已修改标题并验证'] })
  assert.equal(advance(3).status, 0)
  assert.equal(dispatch(id).nextAgent, 'code-reviewer', 'light still requires independent review')
  // Exercise delivery and terminal guards independently of the review coverage fixture.
  const s = current()
  s.phase = 5
  s.phases['5_git_submit'] = { status: 'running', startedAt: new Date().toISOString() }
  state.writeStateFile(id, s)
  assert.equal(dispatch(id).nextAgent, 'release-assistant', 'no silent submission skip')
  trace.tracePhaseOutcome(id, 5, 'skipped_by_user', { evidence: ['测试夹具：用户仅要本地改动，不提交'] })
  assert.equal(advance(6).status, 0)
  trace.tracePhaseOutcome(id, 6, 'skipped_by_user', { reason: 'not initialized' })
  assert.equal(advance(7).status, 0)
  assert.equal(dispatch(id).nextAgent, 'release-assistant', 'P7 is runnable, not terminal')
  assert.equal(advance(8).status, 1)
  trace.tracePhaseOutcome(id, 7, 'not_applicable', { evidence: ['测试夹具：后端项目，外部流程发布'] })
  const final = advance(8)
  assert.equal(final.status, 0, final.stdout + final.stderr)
  assert.equal(current().status, 'completed')
  assert.equal(current().phase, 8)
  assert.equal(current().phases['8_undefined'], undefined)
  assert.equal(dispatch(id).status, 'terminal')
  assert.ok(final.stdout.includes('phaseMetrics'))
  console.log('light route, minimum preparation, execution receipts and P7→P8 lifecycle passed')
} finally {
  experienceFiles.forEach((f, i) => fs.writeFileSync(f, before[i]))
  fs.rmSync(root, { recursive: true, force: true })
}
