#!/usr/bin/env node
/**
 * OpenSpec 规则内嵌门控回归：不生成 openspec/，仍强制规格质量与追踪语义。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPTS_DIR = path.resolve(__dirname, '..')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-spec-gate-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))

let pass = 0
const failures = []

function ok (name, condition, detail) {
  if (condition) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

function writeStory (id, overrides = {}) {
  const dir = path.join(SANDBOX, '.codebuddy', 'plans', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'story-input.json'), JSON.stringify({ mode: 'run', sources: {} }))
  fs.writeFileSync(path.join(dir, 'e2e-state.json'), JSON.stringify({
    storyId: id,
    phase: 0,
    status: 'running',
    gateChecks: { prototypeRequired: false }
  }))
  fs.writeFileSync(path.join(dir, 'requirement-analysis.md'), overrides.analysis || `
# 需求分析
## Grill 决策摘要
### 目标
建立可验证流程。
### 非目标
不额外维护镜像规格。
### 关键决策
规格语义进入现有契约。
### Capabilities 拆分
- order-submit
### 风险
字段迁移需要修复旧 Story。
`)
  fs.writeFileSync(path.join(dir, 'acceptance-criteria.json'), JSON.stringify({
    featurePoints: [{ id: 'FP-1', source: '需求 1', coverage: 'covered', acIds: ['AC-1'] }],
    criteria: [{
      id: 'AC-1',
      capability: 'order-submit',
      changeType: 'added',
      description: overrides.description || '系统必须拒绝库存不足的订单',
      testType: 'api',
      given: overrides.given === undefined ? '库存为 0' : overrides.given,
      when: '用户提交订单',
      then: '返回库存不足且不创建订单'
    }]
  }))
  fs.writeFileSync(path.join(dir, 'open-questions.json'), JSON.stringify({ questions: [] }))
  return dir
}

console.log('\n-- OpenSpec 规则内嵌门控 --')

const validDir = writeStory('SPEC-OK')
const valid = policy.runGateCheck('SPEC-OK', 0, state.readStateFile('SPEC-OK'))
ok('无 openspec/ 目录也能通过 Phase 0', valid.passed === true,
  JSON.stringify(valid.blockers))
ok('测试 Story 确实没有 openspec/ 目录', !fs.existsSync(path.join(validDir, 'openspec')))

writeStory('SPEC-NORM', { description: '系统支持库存不足提示' })
const nonNormative = policy.runGateCheck('SPEC-NORM', 0, state.readStateFile('SPEC-NORM'))
ok('非规范性 Requirement 被阻断', nonNormative.blockers.some(b => b.type === 'spec_requirement_non_normative'))

writeStory('SPEC-SCENARIO', { given: '' })
const noScenario = policy.runGateCheck('SPEC-SCENARIO', 0, state.readStateFile('SPEC-SCENARIO'))
ok('Given/When/Then 不完整被阻断', noScenario.blockers.some(b => b.type === 'spec_scenario_incomplete'))

writeStory('SPEC-CONTEXT', {
  analysis: '# 需求分析\n## Grill 决策摘要\n### 目标\n只有目标。\n'
})
const noContext = policy.runGateCheck('SPEC-CONTEXT', 0, state.readStateFile('SPEC-CONTEXT'))
ok('缺少 Non-Goals/Decisions/Capabilities/Risks 被阻断', noContext.blockers.some(b => b.type === 'spec_context_incomplete'))

fs.rmSync(SANDBOX, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} 项失败: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\nPASS: ${pass} 项断言全部通过`)
