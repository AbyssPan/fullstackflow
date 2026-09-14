#!/usr/bin/env node
// 在临时项目验证询问、持久化、恢复与推进行为。
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-verification-'))
process.env.CODEBUDDY_PROJECT_DIR = sandbox
process.env.CLAUDE_PROJECT_DIR = sandbox
const state = require('../lib/state')
const { createWorkflow, refreshStoryInput, setVerificationMode } = require('../commands/create-workflow')
const { dispatch } = require('../commands/dispatch')
const policy = require('../services/policy')
const { buildAgentPrompt } = require('../services/prompt-builder')
const contextRefresh = require('../services/context-refresh')
const resumeHook = () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '../hooks/session-start.js')], { input: '{}', encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext
}
const script = name => path.join(__dirname, '../commands', name)
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf-8' })
const experienceFile = path.join(__dirname, '../experience/failure-patterns.json')
const experienceBefore = fs.readFileSync(experienceFile, 'utf-8')

try {
  for (const mode of ['run', 'fixbugs']) {
    const id = `ASK-${mode}`
    const inputPath = path.join(sandbox, `${id}.json`)
    fs.writeFileSync(inputPath, JSON.stringify({ mode, sources: {} }))
    assert.equal(createWorkflow(id, '测试选择', false, false, mode, { inputFile: inputPath }).verificationMode, 'ask')
    const initial = state.readStateFile(id)
    assert.equal(setVerificationMode(id, 'full').success, false) // Phase 0 不允许记录测试阶段选择
    assert.notEqual(dispatch(id).recovery?.type, 'verification_choice_required')
    initial.phase = 4
    initial.phases['4_e2e_verification'] = { status: 'running' }
    state.writeStateFile(id, initial)

    const waiting = dispatch(id)
    assert.equal(waiting.status, 'blocked')
    assert.equal(waiting.recovery.type, 'verification_choice_required')
    assert.equal(waiting.nextAgent, null)
    assert.equal(waiting.advanceCommand, null)
    assert.equal(waiting.recovery.options.length, 2)
    assert.deepEqual(contextRefresh.getContractFiles(id, 3), [])
    assert.ok(resumeHook().includes('测试选择待确认'))
    assert.equal(dispatch(id).recovery.type, 'verification_choice_required') // 重试仍等待
    assert.equal(run('advance-phase.js', [id, '5']).status, 1) // 直接推进也不能绕过选择
    assert.equal(state.readStateFile(id).phase, 4)
    assert.equal(setVerificationMode(id, 'invalid').success, false)
    assert.equal(state.readStateFile(id).verificationMode, 'ask')

    const chosen = mode === 'run' ? 'full' : 'review-only'
    // 执行调度器实际给出的命令参数，模拟用户已回答。
    const option = waiting.recovery.options.find(o => o.value === chosen)
    const args = option.command.split(' ').slice(2)
    assert.equal(run('create-workflow.js', args).status, 0)
    assert.equal(state.readStateFile(id).verificationMode, chosen)
    const savedInput = JSON.parse(fs.readFileSync(path.join(state.PLANS_DIR, id, 'story-input.json'), 'utf-8'))
    assert.equal(savedInput.verificationMode, chosen)
    assert.equal(refreshStoryInput(id).verificationMode, chosen)
    // 新进程模拟恢复会话，必须沿用选择。
    const resumed = JSON.parse(run('dispatch.js', [id]).stdout)
    if (chosen === 'full') {
      assert.equal(resumed.nextAgent, 'test-engineer')
      assert.equal(resumed.recovery, null)
      assert.equal(policy.runGateCheck(id, 4, state.readStateFile(id)).passed, false) // 仍需测试产物
      const writeArtifact = (file, data) => fs.writeFileSync(path.join(state.PLANS_DIR, id, file), JSON.stringify(data))
      writeArtifact('code-review.json', { storyId: id, issues: [], summary: { blockerCount: 0, warningCount: 0, suggestionCount: 0 } })
      writeArtifact('acceptance-criteria.json', { criteria: [{ id: 'AC-1', capability: 'flow', changeType: 'modified', description: '必须正常返回', testType: 'api', given: '服务运行', when: '请求接口', then: '返回成功' }] })
      fs.writeFileSync(path.join(state.PLANS_DIR, id, 'test-report.md'), '接口返回错误，需修复')
      const verification = {
        results: [{ id: 'AC-1', status: 'failed', evidenceType: 'api', evidence: ['测试夹具：接口返回 500'] }],
        summary: { total: 1, passed: 0, failed: 1, unverifiable: 0 }
      }
      writeArtifact('acceptance-verification.json', verification)
      assert.equal(dispatch(id).status, 'fix_loop')
      assert.equal(run('advance-phase.js', [id, '2', '--fix-loop']).status, 0)
      assert.equal(state.readStateFile(id).verificationMode, 'full')
      assert.equal(run('advance-phase.js', [id, '3']).status, 0)
      assert.equal(run('advance-phase.js', [id, '4']).status, 0)
      assert.equal(dispatch(id).status, 'fix_loop') // 返修后失败记录仍生效，不再询问
      verification.results[0].status = 'passed'
      verification.results[0].evidence = ['测试夹具：接口返回 200']
      verification.summary.passed = 1
      verification.summary.failed = 0
      writeArtifact('acceptance-verification.json', verification)
      assert.equal(dispatch(id).readyToAdvance, true)
      assert.equal(run('advance-phase.js', [id, '5']).status, 0)
      assert.equal(state.readStateFile(id).phases['4_e2e_verification'].status, 'completed')
    } else {
      assert.equal(resumed.nextAgent, null)
      assert.equal(resumed.readyToAdvance, true)
      assert.equal(run('advance-phase.js', [id, '5']).status, 0)
      assert.equal(state.readStateFile(id).phases['4_e2e_verification'].status, 'skipped')
      const handoff = buildAgentPrompt({ storyId: id, targetPhase: 5 })
      assert.ok(handoff.agentPrompt.includes('verificationMode=review-only'))
      assert.ok(!handoff.contractFilesToLoad.some(f => f.endsWith('acceptance-verification.json')))
      const summaryPath = path.join(state.PLANS_DIR, id, 'phase-4-summary.md')
      assert.ok(fs.readFileSync(summaryPath, 'utf-8').includes('跳过摘要'))
      const tracePath = path.join(state.PLANS_DIR, id, 'trace.jsonl')
      const events = fs.readFileSync(tracePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(!events.some(e => e.type === 'phase_noop' && e.phase === '4'))
      // 遗留旧报告不能被交付摘要或恢复 Hook 误当成本轮测试证据。
      fs.writeFileSync(path.join(state.PLANS_DIR, id, 'acceptance-verification.json'), JSON.stringify({ results: [{ status: 'passed' }] }))
      contextRefresh.generatePhaseSummary(id, 4)
      assert.ok(!fs.readFileSync(summaryPath, 'utf-8').includes('passed'))
      assert.ok(!resumeHook().includes(`${id}/acceptance-verification.json`))
      assert.equal(setVerificationMode(id, 'full').success, false) // 已离开测试阶段不能重写
    }
  }

  assert.equal(createWorkflow('NO-INPUT', '无输入', false, false, 'run').verificationMode, 'ask')
  for (const choice of ['ask', 'full', 'review-only']) {
    const input = path.join(sandbox, `explicit-${choice}.json`)
    fs.writeFileSync(input, JSON.stringify({ mode: 'run', verificationMode: choice, sources: {} }))
    assert.equal(createWorkflow(`EXPLICIT-${choice}`, '已有选择', false, false, 'run', { inputFile: input }).verificationMode, choice)
  }
  const legacy = state.readStateFile('NO-INPUT')
  delete legacy.verificationMode
  legacy.phase = 4
  state.writeStateFile('NO-INPUT', legacy)
  assert.equal(dispatch('NO-INPUT').nextAgent, 'test-engineer') // 旧工作流保持 full
  assert.equal(fs.readFileSync(experienceFile, 'utf-8'), experienceBefore) // 等待选择不污染失败经验库
  console.log('测试选择回归通过：默认询问、等待、双分支、持久化恢复、旧流程兼容')
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
