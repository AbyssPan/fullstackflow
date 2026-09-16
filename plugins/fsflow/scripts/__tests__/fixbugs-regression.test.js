#!/usr/bin/env node
/**
 * fixbugs 模式回归测试
 *
 * 覆盖 2026-08 的 fixbugs 改造：
 *   1. 不再无条件写入空的 prototype-analysis.md（原型按需判定）
 *   2. Bug 分析下沉到 Phase 0 需求分析师，主 Agent 只搬参数
 *   3. Bug 报告只记事实，修复方案归 Phase 2 开发工程师
 *
 * 无外部依赖，用一个临时的 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/fixbugs-regression.test.js
 *   npm test            （在 plugins/fsflow 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
// 同时覆盖 CODEBUDDY_PROJECT_DIR 与 CLAUDE_PROJECT_DIR（state.js 的 PROJECT_ROOT 优先取
// CODEBUDDY_PROJECT_DIR，只覆盖后者会导致沙箱失效、读到真实项目目录）
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fixbugs-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { buildAgentPrompt } = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const { createWorkflow } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))

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

function writeInput (id, obj) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'story-input.json'), JSON.stringify(obj, null, 2))
}

function writeReport (id, body) {
  fs.writeFileSync(path.join(storyDir(id), '测试需求_bug分析报告.md'), body)
}

function readReport (id) {
  return fs.readFileSync(path.join(storyDir(id), '测试需求_bug分析报告.md'), 'utf-8')
}

/** 跑门控脚本，退出码非 0 也要拿到输出（阻断时会 exit 1） */
function gate (id, phase) {
  try {
    return execFileSync('node', [path.join(SCRIPTS_DIR, 'services/validate-phase-gate.js'), id, String(phase)],
      { encoding: 'utf-8', env: process.env })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

const COMPLIANT_REPORT = `# 测试需求 Bug 分析报告

> 本报告只记录事实，不含修复方案。修复方案由 Phase 2 开发工程师设计。

## 1. 概览
共 2 个 Bug。

## 2. Bug 明细
### Bug #1 首页崩溃
#### 现象
点击后白屏。
#### 复现步骤
1. 打开首页
2. 点击按钮
#### 代码定位
src/views/Home.vue:42
#### 根因
userInfo 在 onMounted 前被 computed 读取，此时为 undefined。

## 4. 优先级排序
Bug #1 > Bug #2
`

// ════════════════════════════════════════════════════════════
section('1. fixbugs 建流程不写原型存根')

writeInput('FIX-1', {
  mode: 'fixbugs',
  storyId: 'FIX-1',
  title: '测试需求',
  sources: {
    tapdUrl: 'https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944001',
    workspaceId: '10109441',
    owner: '小明',
    statusFilter: '待解决'
  }
})

const r1 = createWorkflow('FIX-1', '测试需求', false, false, 'fixbugs')
ok('createWorkflow 成功', r1.success !== false, JSON.stringify(r1.errors))
ok('state.mode = fixbugs', r1.mode === 'fixbugs', r1.mode)
ok('prototypeRequired = false', r1.prototypeRequired === false, String(r1.prototypeRequired))

const files1 = fs.readdirSync(storyDir('FIX-1'))
ok('无 prototype-analysis.md 存根', !files1.some(f => f.includes('prototype-analysis')), files1.join(','))
ok('getStoryMode = fixbugs', state.getStoryMode('FIX-1') === 'fixbugs')

// ════════════════════════════════════════════════════════════
section('2. fixbugs Phase 0->1 门控')

const g1 = gate('FIX-1', 1)
ok('缺 Bug 报告 -> 阻断', /bug分析报告/i.test(g1) && /阻断|BLOCK|❌/.test(g1))
ok('不再检查原型文档', !/prototype-analysis/.test(g1))

writeReport('FIX-1', COMPLIANT_REPORT)
const g2 = gate('FIX-1', 1)
ok('合规报告 -> 无 Bug 阻断', !/未在 Story 目录找到/.test(g2))
ok('合规报告 -> 无越界警告', !/修复建议|解决方案|测试验证/.test(g2))

// 越界内容必须写成标题行 —— 门控只扫标题，避免正文里的根因描述误报
writeReport('FIX-1', readReport('FIX-1') +
  '\n#### 修复建议\n把初始化移到 created。\n\n#### 测试验证\n回归首页。\n')
const g3 = gate('FIX-1', 1)
ok('越界标题 -> 出警告', /修复建议/.test(g3) && /警告|WARN|⚠/.test(g3))
ok('越界仅警告，不阻断', !/未在 Story 目录找到/.test(g3))

// ════════════════════════════════════════════════════════════
section('3. fixbugs prompt 注入')

const p0 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 0 })
ok('storyMode = fixbugs', p0.storyMode === 'fixbugs')
ok('P0 给出 story-input.json 路径（不内联原文，优化上下文）', /story-input\.json/.test(p0.agentPrompt) && /读取 .codebuddy\/plans\/.*\/story-input\.json/.test(p0.agentPrompt))
ok('P0 含自行调 skill 指引', p0.agentPrompt.includes('tapd-bug-analyzer'))
ok('P0 含「不写修复方案」', /不要写修复方案|不写修复方案|只记录事实|只记事实/.test(p0.agentPrompt))
// expectedOutputs 是主 Agent 校验子 Agent 产出物汇报的依据，
// 只进 expectedDescriptions（prompt 文字）会导致漏检 —— 见 harness-conductor/SKILL.md
ok('P0 expectedOutputs 含 bug分析报告', JSON.stringify(p0.expectedOutputs).includes('bug分析报告'))
ok('P0 产出要求文字含 bug分析报告', p0.agentPrompt.includes('bug分析报告'))

const p1 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 1 })
ok('P1 不重复注入 story-input 原文', !p1.agentPrompt.includes('"tapdUrl"'))
ok('P1 给出 Bug 报告文件路径', /测试需求_bug分析报告\.md/.test(p1.agentPrompt) && /请读取/.test(p1.agentPrompt))
// 路径化而非内联：报告正文的特征串（根因描述）不应出现在 prompt 里
ok('P1 不内联报告正文', !p1.agentPrompt.includes('userInfo 在 onMounted 前被 computed 读取'))

// v3 token 优化：报告只在 Phase 0-1 注入。Phase 2+ 靠 task-dag.json / AC 等契约产出物，
// 不再被要求回头读 10~27KB 的原始报告（实测真实项目体积）。
for (const ph of [2, 3, 4, 5, 6, 7]) {
  const pn = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: ph })
  ok(`P${ph} 不再注入 Bug 报告路径`, !/bug分析报告/i.test(pn.agentPrompt))
}

const p2 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 2 })
ok('P2 含「Bug 修复说明」', p2.agentPrompt.includes('Bug 修复说明'))
ok('P2 以源码查证为默认、graphify 可选', /kb-query/.test(p2.agentPrompt) && /源码搜索/.test(p2.agentPrompt) && /graphify 可选/.test(p2.agentPrompt))
ok('P2 修复说明指向契约文件而非原始报告', /task-dag\.json/.test(p2.agentPrompt))

// 可选图谱不可用时继续源码查证，不再因工具失败阻断任务。
ok('约束要求查证调用方并允许 graphify 缺失',
  p2.agentConstraints.length === 3 &&
  p2.agentConstraints.some(c => /调用方与回归项/.test(c)) &&
  p2.agentConstraints.some(c => /缺失或失败.*源码搜索/.test(c)),
  JSON.stringify(p2.agentConstraints))
ok('不再重复 agent .md 已有的 advance-phase 约束', !/- 🚫 由主 Agent 调用 advance-phase/.test(p2.agentPrompt))

// ════════════════════════════════════════════════════════════
section('4. run 模式回归（不受 fixbugs 改造影响）')

const r2 = createWorkflow('RUN-1', '新功能', false, false)
ok('mode = run', r2.mode === 'run', r2.mode)
ok('无 story-input -> 保守要求原型', r2.prototypeRequired === true)

const files2 = fs.readdirSync(storyDir('RUN-1'))
ok('run 模式也不写存根', !files2.some(f => f.includes('prototype-analysis')), files2.join(','))

const rp0 = buildAgentPrompt({ storyId: 'RUN-1', targetPhase: 0 })
ok('run P0 不含 tapd-bug-analyzer', !rp0.agentPrompt.includes('tapd-bug-analyzer'))
const rp2 = buildAgentPrompt({ storyId: 'RUN-1', targetPhase: 2 })
ok('run P2 不含 Bug 修复说明', !rp2.agentPrompt.includes('Bug 修复说明'))
ok('run 门控无 Bug 报告检查', !/bug分析报告/i.test(gate('RUN-1', 1)))

// ════════════════════════════════════════════════════════════
section('5. 原型按需判定')

writeInput('RUN-2', { mode: 'run', sources: { prototypeUrls: ['https://proto.example.com/a'] } })
ok('有原型链接 -> required=true',
  createWorkflow('RUN-2', '带原型', false, false, 'run').prototypeRequired === true)

writeInput('RUN-3', { mode: 'run', sources: { figmaUrls: ['https://figma.com/design/abc/x'] } })
ok('有 Figma 链接 -> required=true',
  createWorkflow('RUN-3', '带 Figma', false, false, 'run').prototypeRequired === true)

writeInput('RUN-4', { mode: 'run', sources: { text: '纯文字需求' } })
ok('无原型/Figma -> required=false',
  createWorkflow('RUN-4', '无原型', false, false, 'run').prototypeRequired === false)

// ════════════════════════════════════════════════════════════
section('6. bypass 模式')

const r5 = createWorkflow('BY-1', 'hotfix', true, false)
ok('bypass -> required=false', r5.prototypeRequired === false)
ok('bypass -> 直接 Phase 2', r5.phase === 2, String(r5.phase))

// ════════════════════════════════════════════════════════════
section('7. story-input.schema.json 契约')

const schema = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'schemas/story-input.schema.json'), 'utf-8'))
ok('required 含 mode + sources', ['mode', 'sources'].every(k => (schema.required || []).includes(k)))
ok('mode enum = [run, fixbugs]', JSON.stringify(schema.properties.mode.enum) === '["run","fixbugs"]')
ok('顶层 additionalProperties=false', schema.additionalProperties === false)
ok('sources additionalProperties=false', schema.properties.sources.additionalProperties === false)

// ════════════════════════════════════════════════════════════
section('8. 边界与容错')

fs.mkdirSync(storyDir('BAD-1'), { recursive: true })
fs.writeFileSync(path.join(storyDir('BAD-1'), 'story-input.json'), '{ 坏 JSON')
const bad = state.isPrototypeRequired('BAD-1')
ok('坏 JSON -> 保守 required=true', bad.required === true, bad.reason)
ok('坏 JSON -> getStoryMode 回退 run', state.getStoryMode('BAD-1') === 'run')
ok('findBugAnalysisReports 命中已有报告', state.findBugAnalysisReports('FIX-1').exists)
ok('findBugAnalysisReports 目录不存在时安全', state.findBugAnalysisReports('NOT-EXIST').exists === false)

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
