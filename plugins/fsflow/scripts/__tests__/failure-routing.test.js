#!/usr/bin/env node
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-recovery-'))
process.env.CODEBUDDY_PROJECT_DIR = sandbox
process.env.CLAUDE_PROJECT_DIR = sandbox
const state = require('../lib/state')
const { dispatch } = require('../commands/dispatch')
const { buildAgentPrompt } = require('../services/prompt-builder')
const { planRecovery } = require('../services/failure-routing')
const dir = id => path.join(state.PLANS_DIR, id)
const write = (id, file, data) => fs.writeFileSync(path.join(dir(id), file), typeof data === 'string' ? data : JSON.stringify(data))
const run = (cmd, args) => spawnSync(process.execPath, [path.join(__dirname, '../commands', cmd), ...args], { encoding: 'utf8' })
function fixture(id, kind, phase = 4) {
  fs.mkdirSync(dir(id), { recursive: true })
  state.writeStateFile(id, { storyId: id, phase, status: 'running', mode: 'fixbugs', verificationMode: 'full', phases: {} })
  state.ensureReposJson(id)
  write(id, 'requirement-analysis.md', 'original requirements')
  write(id, 'task-dag.json', { tasks: [] })
  write(id, 'task-dag.md', 'original plan')
  write(id, 'acceptance-criteria.json', { criteria: [{ id: 'AC-1', description: '必须返回成功', testType: 'api', given: '服务运行', when: '请求接口', then: '返回成功' }] })
  const cause = kind ? { failureKind: kind, failureReason: '可复现证据：原因已定位' } : {}
  write(id, 'code-review.json', { storyId: id, issues: phase === 3 ? [{ id: 'B1', file: 'src/a.js', title: '失败', description: '证据', severity: 'BLOCKER', status: 'open', ...cause }] : [], summary: { blockerCount: phase === 3 ? 1 : 0, warningCount: 0, suggestionCount: 0 } })
  write(id, 'test-report.md', 'failure evidence')
  write(id, 'acceptance-verification.json', { results: [{ id: 'AC-1', status: 'failed', evidence: ['接口返回 500'], evidenceType: 'api', ...cause }], summary: { total: 1, passed: 0, failed: 1, unverifiable: 0 } })
}
try {
  for (const phase of [3, 4]) {
    for (const [kind, target] of [['requirement', 0], ['planning', 1], ['implementation', 2], ['environment', phase], ['verification', phase]]) {
      const id = `${kind}-${phase}`
      fixture(id, kind, phase)
      const before = fs.readFileSync(path.join(dir(id), 'e2e-state.json'), 'utf8')
      const result = dispatch(id)
      assert.equal(result.status, 'fix_loop', JSON.stringify(result))
      assert.equal(result.recovery.targetPhase, target)
      assert.equal(fs.readFileSync(path.join(dir(id), 'e2e-state.json'), 'utf8'), before, 'dispatch must be read-only')
      const flag = target === 2 ? '--fix-loop' : '--recover-failure'
      const wrong = run('advance-phase.js', [id, String(target === 0 ? 1 : 0), flag])
      assert.equal(wrong.status, 1)
      assert.equal(fs.readFileSync(path.join(dir(id), 'e2e-state.json'), 'utf8'), before)
      const recovered = run('advance-phase.js', [id, String(target), flag])
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
      assert.equal(state.readStateFile(id).phase, target)
      assert.equal(state.readStateFile(id).verificationMode, 'full')
      assert.equal(fs.existsSync(path.join(dir(id), 'acceptance-verification.json')), false, 'stale verification invalidated')
      if (target > 0) assert.equal(fs.readFileSync(path.join(dir(id), 'requirement-analysis.md'), 'utf8'), 'original requirements')
      if (target > 1) assert.equal(fs.readFileSync(path.join(dir(id), 'task-dag.md'), 'utf8'), 'original plan')
      if (target !== 2) {
        assert.equal(fs.existsSync(path.join(dir(id), 'dev-pass.json')), false)
        assert.ok(buildAgentPrompt({ storyId: id, targetPhase: target }).agentPrompt.includes('failure-recovery.json'))
      } else {
        assert.equal(dispatch(id).nextAgent, 'fullstack-developer', 'must actually execute fix before advancing')
        assert.ok(dispatch(id).agentPrompt.includes('不重跑整个 task-dag'))
        const fr = JSON.parse(fs.readFileSync(path.join(dir(id), 'fix-request.json')))
        assert.ok(fs.existsSync(path.join(sandbox, fr.previousArtifacts, 'code-review.json')))
        write(id, 'fix-verification.json', { round: 99, source: fr.source, fixes: fr.issues.map(i => ({ id: i.id, status: 'fixed', actualChange: '修复' })) })
        assert.equal(dispatch(id).nextAgent, 'fullstack-developer', 'wrong round does not pass')
        write(id, 'fix-verification.json', { round: fr.round, source: fr.source, fixes: fr.issues.map(i => ({ id: i.id, status: 'fixed', actualChange: '修复' })) })
        assert.equal(dispatch(id).readyToAdvance, true)
      }
    }
  }
  fixture('unknown', 'unknown')
  assert.equal(dispatch('unknown').nextAgent, 'test-engineer')
  assert.equal(run('advance-phase.js', ['unknown', '2', '--fix-loop']).status, 1)
  fixture('legacy')
  assert.equal(dispatch('legacy').recovery.targetPhase, 2)
  // Current phase owns the failure: a stale review must not hijack P4's source or budget.
  write('legacy', 'code-review.json', { issues: [{ id: 'B9', severity: 'BLOCKER', status: 'open', failureKind: 'requirement', failureReason: 'old' }] })
  assert.equal(planRecovery('legacy', 4).targetPhase, 2)
  assert.equal(run('advance-phase.js', ['legacy', '2', '--fix-loop']).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir('legacy'), 'fix-request.json'))).sourcePhase, 4)
  fixture('mixed', 'implementation')
  const mixed = JSON.parse(fs.readFileSync(path.join(dir('mixed'), 'acceptance-verification.json')))
  mixed.results.push({ ...mixed.results[0], id: 'AC-2', failureKind: 'planning' })
  write('mixed', 'acceptance-verification.json', mixed)
  assert.equal(planRecovery('mixed', 4).targetPhase, 1)
  fixture('budget', 'environment')
  const budget = state.readStateFile('budget')
  budget.recoveryRounds = { 4: 2 }
  state.writeStateFile('budget', budget)
  assert.equal(dispatch('budget').status, 'blocked')
  assert.equal(dispatch('budget').recovery.command, null)
  assert.equal(run('advance-phase.js', ['budget', '4', '--recover-failure']).status, 1)
  assert.ok(fs.existsSync(path.join(dir('budget'), 'acceptance-verification.json')))
  fixture('alternating', 'implementation', 3)
  const alternating = state.readStateFile('alternating')
  alternating.fixRounds = { 3: 2, 4: 1 }
  state.writeStateFile('alternating', alternating)
  write('alternating', 'fix-request.json', { sourcePhase: 4, round: 1 })
  assert.equal(dispatch('alternating').recovery.type, 'fix_loop_exhausted', 'switching failure sources cannot reset the review budget')
  assert.equal(run('advance-phase.js', ['alternating', '2', '--fix-loop']).status, 1)
  fixture('malformed', 'implementation')
  write('malformed', 'acceptance-verification.json', { results: [{ id: 'AC-1', status: 'failed' }] })
  assert.equal(dispatch('malformed').nextAgent, 'test-engineer', 'repair report format before routing')
  assert.equal(run('advance-phase.js', ['malformed', '2', '--fix-loop']).status, 1)
  fixture('resume', 'implementation')
  const resumeBefore = fs.readFileSync(path.join(dir('resume'), 'e2e-state.json'), 'utf8')
  assert.equal(run('harness-workflow.js', ['resume', 'resume']).status, 0)
  assert.equal(run('harness-workflow.js', ['resume', 'resume']).status, 0, 'idempotent while active')
  assert.equal(fs.readFileSync(path.join(dir('resume'), 'e2e-state.json'), 'utf8'), resumeBefore)
  assert.equal(run('harness-workflow.js', ['resume', 'resume', '--input=new.json']).status, 1)
  assert.equal(run('harness-workflow.js', ['resume', 'legacy']).status, 1, 'cannot switch another active story')
  const completed = state.readStateFile('resume')
  completed.status = 'completed'
  state.writeStateFile('resume', completed)
  assert.equal(run('harness-workflow.js', ['resume', 'resume']).status, 1)
  console.log('failure routing, invalidation, scoped repair and resume checks passed')
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
