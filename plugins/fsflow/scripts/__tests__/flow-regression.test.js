#!/usr/bin/env node
/**
 * 流程回归测试 —— 覆盖 2026-08 的流程改造：
 *   1. fixloop 按失败源独立预算（code-review/test 各 2 次，不共享）
 *   2. unverifiable 不阻塞门控（需求4：无法验证就跳过）
 *   3. 目录级 glob 限域（需求2：files 支持目录 glob）
 *   4. Phase 1→2 门控：figma-frame-inventory 存在性与完整性
 *   5. dispatch 是 prompt 唯一出口；advance-phase.js 只返回推进结果
 *   5b. Graphify 仓库状态与 cwd 入口注入
 *   5c. review-only 显式跳过独立功能测试，full 保留测试门控
 *   6. Phase 0 唯一知识库前置确认 + Phase 6 仅增量收尾
 *
 * 无外部依赖，用临时沙箱（同时覆盖 CODEBUDDY/CLAUDE_PROJECT_DIR），跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/flow-regression.test.js
 *   npm test            （在 plugins/fsflow 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-flow-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { createWorkflow } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))
const promptBuilder = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const contextRefresh = require(path.join(SCRIPTS_DIR, 'services/context-refresh'))
const trace = require(path.join(SCRIPTS_DIR, 'lib/trace'))
const schemaValidator = require(path.join(SCRIPTS_DIR, 'services/schema-validator'))
const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))

let pass = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

const storyDir = id => path.join(SANDBOX, '.codebuddy', 'plans', id)

// ════════════════════════════════════════════════════════════
section('1. fixloop 独立预算（review/test 各 2 次）')

const c1 = createWorkflow('FL-1', 'fixloop 预算', false, false, 'run')
ok('createWorkflow 成功', c1.success !== false)
const st1 = state.readStateFile('FL-1')
ok('state 含 maxReviewFixRounds=2', st1.maxReviewFixRounds === 2, String(st1.maxReviewFixRounds))
ok('state 含 maxTestFixRounds=2', st1.maxTestFixRounds === 2, String(st1.maxTestFixRounds))
ok('getMaxFixRounds(review)=2', state.getMaxFixRounds('FL-1', 3) === 2)
ok('getMaxFixRounds(test)=2', state.getMaxFixRounds('FL-1', 4) === 2)
ok('getMaxFixRounds(缺省 sourcePhase)=review 预算', state.getMaxFixRounds('FL-1') === 2)

// ════════════════════════════════════════════════════════════
section('2. unverifiable 不阻塞门控')

const dir2 = storyDir('UV-1')
fs.mkdirSync(dir2, { recursive: true })
// 全部 unverifiable 的验收对账（需求4：不阻塞，跳过）
fs.writeFileSync(path.join(dir2, 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'unverifiable', evidenceType: 'static', evidence: ['代码逻辑已验证，需联调环境'] },
    { id: 'AC-2', status: 'unverifiable', evidenceType: 'static', evidence: ['接口参数已适配，待联调'] }
  ],
  summary: { total: 2, passed: 0, failed: 0, unverifiable: 2 }
}))
fs.writeFileSync(path.join(dir2, 'e2e-state.json'), JSON.stringify({ storyId: 'UV-1', phase: 4, status: 'running' }))
const av = state.checkAcceptanceVerification('UV-1')
ok('100% unverifiable -> allPassed=true（不阻塞）', av.allPassed === true, JSON.stringify(av.errors))
ok('unverifiable 被正确归入 unverifiable 列表', av.unverifiable.length === 2)
ok('无 failed', av.failed.length === 0)

// 有 failed 才应阻塞
fs.writeFileSync(path.join(dir2, 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'failed', evidenceType: 'api', evidence: ['接口返回异常'] },
    { id: 'AC-2', status: 'passed', evidenceType: 'api', evidence: ['正常'] }
  ],
  summary: { total: 2, passed: 1, failed: 1, unverifiable: 0 }
}))
const av2 = state.checkAcceptanceVerification('UV-1')
ok('有 failed -> allPassed=false（阻塞）', av2.allPassed === false)

// ════════════════════════════════════════════════════════════
section('3. 目录级 glob 判定（getTasksRequiringFigma）')

const dir3 = storyDir('GL-1')
fs.mkdirSync(dir3, { recursive: true })
fs.writeFileSync(path.join(dir3, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog', link: 'x' }] }))
fs.writeFileSync(path.join(dir3, 'task-dag.json'), JSON.stringify({
  tasks: [
    // 目录 glob files → 保守视为 UI 相关（目录下可能含 .vue）
    { id: 'task-1', title: '目录组件', files: ['src/views/pc/modules/**'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' },
    // 纯逻辑 task
    { id: 'task-2', title: 'API', files: ['src/api/index.js'], acceptanceCriteria: ['AC-2'], parallelizable: false }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1', 'task-2'] }]
}))
const tasks = state.getTasksRequiringFigma('GL-1')
ok('目录 glob 的 task-1 被识别为需 Figma', tasks.some(t => t.id === 'task-1'), JSON.stringify(tasks.map(t => t.id)))
ok('纯逻辑 task-2 不被识别', !tasks.some(t => t.id === 'task-2'), JSON.stringify(tasks.map(t => t.id)))

// ════════════════════════════════════════════════════════════
section('4. Phase 1→2 门控：figma-frame-inventory 存在性 & 完整性')

// 场景 A：hasFigmaDesign=true 但 frame-inventory 缺失 → BLOCKER（存在性门控，依赖 requiredWhen:'hasFigmaDesign'）
const dir4a = storyDir('FG1-MISS')
fs.mkdirSync(dir4a, { recursive: true })
fs.writeFileSync(path.join(dir4a, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4a, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-MISS', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4a, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4a, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4a, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
// 刻意不写 figma-frame-inventory.json
const g1 = policy.runGateCheck('FG1-MISS', 1, state.readStateFile('FG1-MISS'))
const missBlocked = g1.blockers.some(b => (b.type === 'artifact_missing') && /figma-frame-inventory\.json/.test(b.message))
ok('hasFigma=true 且 frame-inventory 缺失 -> BLOCKER(artifact_missing)', missBlocked,
  JSON.stringify(g1.blockers.map(b => b.type + ':' + b.message)))

// 场景 B：frame-inventory 存在但内容残缺（缺 link/type）→ BLOCKER（完整性门控 checkFigmaFrameInventory）
const dir4b = storyDir('FG1-BAD')
fs.mkdirSync(dir4b, { recursive: true })
fs.writeFileSync(path.join(dir4b, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4b, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-BAD', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4b, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4b, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4b, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
// frame 缺 link（不完整）
fs.writeFileSync(path.join(dir4b, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog' }] }))
const g2 = policy.runGateCheck('FG1-BAD', 1, state.readStateFile('FG1-BAD'))
const incompleteBlocked = g2.blockers.some(b => b.type === 'figma_frame_incomplete')
ok('frame-inventory 内容残缺（缺 link）-> BLOCKER(figma_frame_incomplete)', incompleteBlocked,
  JSON.stringify(g2.blockers.map(b => b.type + ':' + b.message)))

// 场景 C：frame-inventory 完整（有 id/name/type/link）→ 不再因 frame 内容报 BLOCKER
const dir4c = storyDir('FG1-OK')
fs.mkdirSync(dir4c, { recursive: true })
fs.writeFileSync(path.join(dir4c, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4c, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-OK', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4c, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4c, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4c, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
fs.writeFileSync(path.join(dir4c, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog', link: 'https://figma.com/node/3020:1' }] }))
const g3 = policy.runGateCheck('FG1-OK', 1, state.readStateFile('FG1-OK'))
const hasFrameIncomplete = g3.blockers.some(b => b.type === 'figma_frame_incomplete')
ok('frame-inventory 完整（含 link）-> 无 figma_frame_incomplete BLOCKER', !hasFrameIncomplete,
  JSON.stringify(g3.blockers.map(b => b.type + ':' + b.message)))

// 场景 D：后端任务常见 schema 漂移（figmaRefs:null / estimate:"3" / mustCheck:["..."]）→ --auto-fix 可归一化
const dir4d = storyDir('TDJ-DRIFT')
fs.mkdirSync(dir4d, { recursive: true })
fs.writeFileSync(path.join(dir4d, 'e2e-state.json'), JSON.stringify({ storyId: 'TDJ-DRIFT', phase: 1, status: 'running', hasFigmaDesign: false }))
fs.writeFileSync(path.join(dir4d, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4d, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '后端接口必须返回审批任务列表', testType: 'api' }]
}))
fs.writeFileSync(path.join(dir4d, 'task-dag.json'), JSON.stringify({
  tasks: [
    {
      id: 'task-1',
      title: '后端任务列表接口',
      files: ['**/controller/TaskController.java', '**/service/TaskService.java'],
      acceptanceCriteria: ['AC-1'],
      figmaLink: null,
      figmaRefs: null,
      parallelizable: false,
      estimate: '3'
    }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }],
  mustCheck: ['避免 N+1 查询']
}))
const driftGate = policy.runGateCheck('TDJ-DRIFT', 1, state.readStateFile('TDJ-DRIFT'))
ok('task-dag schema 漂移 -> BLOCKER(task_dag_schema_drift)',
  driftGate.blockers.some(b => b.type === 'task_dag_schema_drift'),
  JSON.stringify(driftGate.blockers.map(b => b.type + ':' + b.message)))
const driftRecovery = policy.attemptAutoRecovery('TDJ-DRIFT', driftGate.recoveries)
ok('task-dag schema 漂移可自动修复', driftRecovery.fixed === true, JSON.stringify(driftRecovery.details))
const driftSchema = schemaValidator.validateArtifact('TDJ-DRIFT', 'task-dag.json')
ok('自动修复后 task-dag schema 通过', driftSchema.valid === true, JSON.stringify(driftSchema.errors))
const driftGateAfter = policy.runGateCheck('TDJ-DRIFT', 1, state.readStateFile('TDJ-DRIFT'))
ok('自动修复后 Phase 1 门控通过', driftGateAfter.passed === true,
  JSON.stringify(driftGateAfter.blockers.map(b => b.type + ':' + b.message)))

// ════════════════════════════════════════════════════════════
section('5. dispatch 单一 prompt 出口 + advance 精简输出')

const beforeAdvance = dispatch('FG1-OK')
ok('dispatch 门控通过时只给推进命令', beforeAdvance.readyToAdvance === true && !!beforeAdvance.advanceCommand)
ok('dispatch 推进分支不预构造下一 Phase prompt', beforeAdvance.agentPrompt === null)

// FG1-OK 的 Phase 1 产出物齐备且门控通过，直接推到 Phase 2 验真实输出。
// 契约: 只给「推进结果」+「下一步怎么 Spawn」，不回吐 prompt 素材 ——
// 那些内容已在 agentPrompt 里展开，多一份拷贝只是让主 Agent 上下文里同一段话出现两次。
const adv = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'FG1-OK', '2'], {
  encoding: 'utf-8',
  env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
})
const advJsonAt = (adv.stdout || '').lastIndexOf('{\n  "success"')
let out = null
try { out = JSON.parse(adv.stdout.slice(advJsonAt)) } catch (e) { /* 下面断言会报 */ }
ok('advance-phase 1→2 输出可解析的 JSON', !!out, (adv.stdout || '').slice(-300) + (adv.stderr || ''))
ok('advance-phase 1→2 推进成功', out && out.success === true,
  out ? JSON.stringify(out.blockers || out.gateChecks) : '')

if (out && out.success === true) {
  ok('下一步明确回 dispatch', out.nextAction === 'rerun_dispatch', String(out.nextAction))
  for (const dropped of ['nextAgent', 'nextAgentLabel', 'agentPrompt', 'expectedOutputs',
    'fixLoopContext', 'phaseSummaryContent', 'phaseSummaryPhase', 'contractFilesToLoad',
    'agentConstraints', 'lessonsFromHistory', 'metricsInsights']) {
    ok(`不再输出 ${dropped}`, !(dropped in out), JSON.stringify(Object.keys(out)))
  }
  // prompt 由推进后的 dispatch 构造；advance 只负责摘要落盘
  ok('摘要正文落盘为 phase-1-summary.md', fs.existsSync(path.join(dir4c, 'phase-1-summary.md')))
}

section('5b. Graphify 仓库状态注入')

const repoSearchMissing = promptBuilder.buildRepoSearchEntries('FG1-OK', 2).join('\n')
ok('检索入口含主仓绝对路径', repoSearchMissing.includes(SANDBOX), repoSearchMissing)
ok('未建图谱时直接给出降级方案', /图谱：未建/.test(repoSearchMissing) && /kb-query \+ Grep/.test(repoSearchMissing))
fs.mkdirSync(path.join(SANDBOX, 'graphify-out'), { recursive: true })
fs.writeFileSync(path.join(SANDBOX, 'graphify-out', 'graph.json'), '{}')
const repoSearchBuilt = promptBuilder.buildRepoSearchEntries('FG1-OK', 2).join('\n')
ok('已建图谱时注入客观状态', /图谱：已建/.test(repoSearchBuilt), repoSearchBuilt)
ok('非检索 Phase 不注入 Graphify 入口', promptBuilder.buildRepoSearchEntries('FG1-OK', 4).length === 0)

section('5c. review-only 显式跳过独立功能测试')

const quickInput = path.join(SANDBOX, 'review-only-input.json')
fs.writeFileSync(quickInput, JSON.stringify({ mode: 'run', verificationMode: 'review-only', sources: {} }))
const quickCreate = createWorkflow('REVIEW-ONLY', '快速验证', false, false, 'run', {
  inputFile: quickInput,
  modeExplicit: false
})
const quickState = state.readStateFile('REVIEW-ONLY')
ok('verificationMode 从 story-input 持久化', quickCreate.verificationMode === 'review-only' && quickState.verificationMode === 'review-only')
const quickGate = policy.runGateCheck('REVIEW-ONLY', 4, quickState)
ok('review-only 在无测试产物时放行 Phase 4', quickGate.passed === true && quickGate._meta.skipped === true)
const fullGate = policy.runGateCheck('REVIEW-ONLY', 4, { ...quickState, verificationMode: 'full' })
ok('full 模式仍要求测试产物', fullGate.passed === false)
quickState.phase = 4
quickState.phases['4_e2e_verification'] = { status: 'running' }
state.writeStateFile('REVIEW-ONLY', quickState)
const quickAdvance = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'REVIEW-ONLY', '5'], {
  encoding: 'utf-8',
  env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
})
const skippedState = state.readStateFile('REVIEW-ONLY')
ok('review-only 推进后将 Phase 4 标记为 skipped',
  quickAdvance.status === 0 && skippedState.phases['4_e2e_verification'].status === 'skipped',
  (quickAdvance.stdout || '') + (quickAdvance.stderr || ''))

const p4Prompt = promptBuilder.buildAgentPrompt({ storyId: 'FG1-OK', targetPhase: 4, summaryPhase: 3 }).agentPrompt
ok('Phase 4 prompt 要求 test-report.md 实际落盘',
  /test-report\.md/.test(p4Prompt) && /实际写入/.test(p4Prompt) && /确认文件存在/.test(p4Prompt))
ok('Phase 4 prompt 禁止只在回复里列文件名', /不要只在回复里列出文件名/.test(p4Prompt))
const conductorDoc = fs.readFileSync(path.join(SCRIPTS_DIR, '..', 'skills/harness-conductor/SKILL.md'), 'utf-8')
const sessionStartHook = fs.readFileSync(path.join(SCRIPTS_DIR, 'hooks/session-start.js'), 'utf-8')
ok('conductor 禁止子 Agent 中断后主 Agent 接管 Phase 工作',
  /子 Agent 中断/.test(conductorDoc) && /禁止主 Agent 接管/.test(conductorDoc))
ok('session-start 注入子 Agent 无产出恢复规则',
  /子 Agent 中断或未落盘产出物/.test(sessionStartHook) && /禁止主 Agent 接管/.test(sessionStartHook))

// ═══════════════════════════════════════════════════════════
section('5d. Phase 0 需求分析开始时的唯一知识库前置确认')

const p0Kb = promptBuilder.buildAgentPrompt({ storyId: 'FG1-OK', targetPhase: 0, summaryPhase: -1 })
const p2Kb = promptBuilder.buildAgentPrompt({ storyId: 'FG1-OK', targetPhase: 2, summaryPhase: 1 })
ok('Phase 0 prompt 注入唯一知识库前置确认', /知识库前置确认/.test(p0Kb.agentPrompt) && /唯一执行/.test(p0Kb.agentPrompt))
ok('Phase 0 缺库时先询问，再支持 kb-init + gen-project-docs 全量生成',
  /是否现在初始化/.test(p0Kb.agentPrompt) && /kb-init/.test(p0Kb.agentPrompt) && /gen-project-docs/.test(p0Kb.agentPrompt) && /全量模式/.test(p0Kb.agentPrompt))
ok('Phase 0 用户拒绝后留痕并继续需求分析', /phase-outcome <storyId> 0 skipped_by_user/.test(p0Kb.agentPrompt) && /继续需求分析/.test(p0Kb.agentPrompt))
ok('Phase 2 不再注入初始化确认逻辑', !/知识库前置确认/.test(p2Kb.agentPrompt) && !/fsflow:kb-init/.test(p2Kb.agentPrompt) && !/gen-project-docs/.test(p2Kb.agentPrompt))

// ═══════════════════════════════════════════════════════════
section('6. Phase 6 经用户确认后增量更新，或拒绝 / 缺库留痕')

const dir6 = storyDir('KB6-SKIP')
fs.mkdirSync(dir6, { recursive: true })
fs.writeFileSync(path.join(dir6, 'e2e-state.json'), JSON.stringify({
  storyId: 'KB6-SKIP', phase: 6, status: 'running'
}))

const p6 = promptBuilder.buildAgentPrompt({ storyId: 'KB6-SKIP', targetPhase: 6, summaryPhase: 5 })
ok('Phase 6 prompt 先检查 meta.yaml', /meta\.yaml/.test(p6.agentPrompt))
ok('Phase 6 正常职责是 kb-update 增量更新', /kb-update/.test(p6.agentPrompt) && /增量更新/.test(p6.agentPrompt))
ok('Phase 6 缺库时直接留痕跳过', /meta\.yaml/.test(p6.agentPrompt) && /不存在时直接留痕跳过/.test(p6.agentPrompt))
ok('Phase 6 不再询问或执行初始化', /不询问初始化/.test(p6.agentPrompt) && /不初始化、不全量生成/.test(p6.agentPrompt))

const missingOutcomeGate = policy.runGateCheck('KB6-SKIP', 6, state.readStateFile('KB6-SKIP'))
ok('Phase 6 无结果证据时禁止直接进 Phase 7', missingOutcomeGate.blockers.some(b =>
  b.type === 'phase6_outcome_missing'))

trace.tracePhaseOutcome('KB6-SKIP', 6, 'skipped_by_user', {
  reason: 'knowledge_base_not_initialized'
})
const kbEvidence = contextRefresh.getRuntimeEvidence('KB6-SKIP', 6)
ok('缺库 skipped_by_user 结果可读取', contextRefresh.readTrace('KB6-SKIP').some(e =>
  e.type === 'phase_outcome' && e.phase === '6' && e.result === 'skipped_by_user'))
ok('summary 能呈现 skipped_by_user', kbEvidence.some(line => /skipped_by_user/.test(line)),
  JSON.stringify(kbEvidence))
ok('skipped_by_user 证据不阻断 Phase 7', kbEvidence.some(line => /不阻断 Phase 7/.test(line)),
  JSON.stringify(kbEvidence))
const skippedOutcomeGate = policy.runGateCheck('KB6-SKIP', 6, state.readStateFile('KB6-SKIP'))
ok('skipped_by_user 记录可恢复放行', skippedOutcomeGate.passed,
  JSON.stringify(skippedOutcomeGate.blockers))
ok('缺库证据不误报用户拒绝初始化', kbEvidence.some(line => /项目未初始化知识库/.test(line)) &&
  !kbEvidence.some(line => /用户拒绝初始化/.test(line)))

trace.tracePhaseOutcome('KB6-SKIP', 6, 'skipped_by_user', {
  reason: 'knowledge_base_update_declined'
})
const declinedEvidence = contextRefresh.getRuntimeEvidence('KB6-SKIP', 6)
ok('拒绝增量更新可恢复放行', policy.runGateCheck('KB6-SKIP', 6, state.readStateFile('KB6-SKIP')).passed)
ok('拒绝更新的摘要与缺库区分', declinedEvidence.some(line => /用户跳过本次知识库增量更新/.test(line)) &&
  !declinedEvidence.some(line => /未初始化|拒绝初始化/.test(line)), JSON.stringify(declinedEvidence))

// ════════════════════════════════════════════════════════════
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
} catch (e) { /* 清理失败不影响结论 */ }

const total = pass + failures.length
console.log(`\n${'='.repeat(48)}`)
if (failures.length === 0) {
  console.log(`通过 ${pass} / ${total}   [全绿]`)
  process.exit(0)
} else {
  console.log(`通过 ${pass} / ${total}\n失败项:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
