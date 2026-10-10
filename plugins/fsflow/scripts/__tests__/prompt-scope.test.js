#!/usr/bin/env node
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-prompt-scope-'))
process.env.CODEBUDDY_PROJECT_DIR = sandbox
process.env.CLAUDE_PROJECT_DIR = sandbox
const state = require('../lib/state')
const { buildAgentPrompt, buildBatchSequence } = require('../services/prompt-builder')
const { dispatch } = require('../commands/dispatch')
const id = 'SCOPED'
const dir = path.join(state.PLANS_DIR, id)
const write = (name, data) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data))
const task = (n, project) => ({ id: `task-${n}`, title: `任务${n}`, files: [`src/file${n}.ts`], acceptanceCriteria: [`AC-${n}`], parallelizable: false, ...(project ? { project } : {}) })
const dag = { tasks: [task(1), task(2, 'backend')], batches: [{ batchId: 2, taskIds: ['task-2'] }, { batchId: 1, taskIds: ['task-1'] }] }
try {
  fs.mkdirSync(path.join(dir, 'development-notes'), { recursive: true })
  fs.mkdirSync(path.join(sandbox, 'backend'), { recursive: true })
  state.writeStateFile(id, { storyId: id, phase: 2, status: 'running', mode: 'run', phases: {}, executionEvidenceRequired: true })
  state.ensureReposJson(id)
  const repos = JSON.parse(fs.readFileSync(path.join(dir, 'repos.json'), 'utf8'))
  repos.repos.backend = path.join(sandbox, 'backend')
  write('repos.json', repos)
  write('task-dag.json', dag)
  write('acceptance-criteria.json', { criteria: [{ id: 'AC-1' }, { id: 'AC-2' }] })
  write('development-notes/task-1.md', 'old evidence')
  write('development-notes/task-2.md', 'other task evidence')
  write('phase-1-summary.md', 'planning summary')
  write('figma-frame-inventory.json', { frames: [{ id: '1:1', name: '页面', designSpec: 'FULL_DESIGN_MARKER' }] })

  const before = fs.readFileSync(path.join(dir, 'e2e-state.json'), 'utf8')
  const batches = buildBatchSequence({ storyId: id })
  assert.deepEqual(batches.map(b => b.batchId), [1, 2])
  assert.match(batches[0].agentPrompt, /src\/file1.ts/)
  assert.doesNotMatch(batches[0].agentPrompt, /src\/file2.ts|FULL_DESIGN_MARKER|development-notes\/task-2.md/)
  assert.ok(batches[1].agentPrompt.includes(path.join(sandbox, 'backend')))
  for (const batch of batches) {
    assert.doesNotMatch(batch.agentPrompt, /phase-outcome SCOPED 2/)
    assert.match(batch.agentPrompt, /不要记录整个 Phase 2 completed/)
  }
  // Scoped UI work retains the legacy design binding path without loading all specs.
  write('story-input.json', { mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/example/UI?node-id=1-1'] } })
  write('task-dag.json', { ...dag, tasks: [{ ...dag.tasks[0], figmaNodeId: '1:1', figmaLink: ['https://www.figma.com/design/example/UI?node-id=1-1'] }, dag.tasks[1]] })
  const legacyDesignBatch = buildBatchSequence({ storyId: id })[0]
  assert.match(legacyDesignBatch.agentPrompt, /figmaNodeId \/ figmaLink/)
  assert.doesNotMatch(legacyDesignBatch.agentPrompt, /FULL_DESIGN_MARKER/)
  write('task-dag.json', dag)
  fs.unlinkSync(path.join(dir, 'story-input.json'))

  const result = dispatch(id)
  assert.equal(result.status, 'ready', JSON.stringify(result))
  assert.equal(result.agentPrompt, null)
  assert.equal(result.batches.length, 2)
  assert.equal(fs.readFileSync(path.join(dir, 'e2e-state.json'), 'utf8'), before)

  // Invalid assignments must not silently omit or repeat work.
  for (const batches of [
    [{ batchId: 1, taskIds: ['task-1'] }],
    [{ batchId: 1, taskIds: ['task-1', 'task-1', 'task-2'] }],
    [{ batchId: 1, taskIds: ['task-9', 'task-2'] }],
    [{ batchId: 1, taskIds: ['task-1'] }, { batchId: 1, taskIds: ['task-2'] }]
  ]) {
    write('task-dag.json', { ...dag, batches })
    assert.equal(dispatch(id).status, 'blocked')
  }
  write('task-dag.json', { ...dag, tasks: [task(1), task(2, 'missing')] })
  assert.equal(dispatch(id).recovery.type, 'prompt_context_invalid')
  write('task-dag.json', { tasks: dag.tasks })
  assert.deepEqual(buildBatchSequence({ storyId: id }), [])
  assert.equal(typeof dispatch(id).agentPrompt, 'string', 'legacy tasks keep a single prompt')

  write('task-dag.json', dag)
  write('fix-request.json', { source: 'code-review', sourcePhase: 3, round: 1, maxRounds: 2,
    issues: [{ id: 'B1', severity: 'BLOCKER', description: '修复当前问题', file: 'src/file1.ts' }], affectedFiles: ['src/file1.ts'] })
  write('fix-context.md', '本轮修复证据')
  const repair = buildAgentPrompt({ storyId: id, targetPhase: 2 })
  assert.equal(repair.contextMode, 'repair')
  assert.deepEqual(repair.contractFilesToLoad.map(f => path.basename(f)), ['fix-request.json', 'fix-context.md'])
  assert.doesNotMatch(repair.agentPrompt, /FULL_DESIGN_MARKER|phase-1-summary.md|development-notes\/task-2.md/)
  assert.match(repair.agentPrompt, /调用方|关联 AC/)
  assert.match(repair.agentPrompt, /不重跑整个 task-dag/)
  assert.deepEqual(buildBatchSequence({ storyId: id }), [])
  assert.equal(dispatch(id).contextMode, 'repair')
  for (const phase of [3, 4]) {
    const review = buildAgentPrompt({ storyId: id, targetPhase: phase })
    assert.ok(review.contractFilesToLoad.some(f => f.endsWith('acceptance-criteria.json')))
    assert.match(review.agentPrompt, /仍覆盖全部 AC/)
    assert.doesNotMatch(review.agentPrompt, /FULL_DESIGN_MARKER/)
  }
  write('fix-request.json', '{broken')
  assert.equal(dispatch(id).status, 'blocked', 'corrupt repair input cannot become full development')
  fs.unlinkSync(path.join(dir, 'fix-request.json'))
  write('task-dag.md', 'existing plan')
  const rework = buildAgentPrompt({ storyId: id, targetPhase: 1, pendingBlockers: [{ message: '补齐 AC-2 对应任务' }] })
  assert.equal(rework.contextMode, 'rework')
  assert.match(rework.agentPrompt, /补齐 AC-2 对应任务/)
  assert.match(rework.agentPrompt, /保留仍有效内容/)
  console.log('prompt scope: batch isolation, invalid plans, read-only dispatch, repair and legacy compatibility passed')
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
