#!/usr/bin/env node
/**
 * story-input.json 摄入回归测试（--input <file>）
 *
 * 覆盖 2026-09 的 --input 改造：
 *   1. 一步建流：--input 摄入后 prototypeRequired / hasFigmaDesign 当场算准，无需 --refresh-input
 *   2. fail-closed：schema 非法 / 文件缺失 / mode 冲突 一律拒绝，且拒绝时不留下任何状态
 *   3. CLI 解析：--input <p> 的空格形式不污染 title
 *   4. --refresh-input 旧通道仍可用
 *
 * 无外部依赖，用一个临时的 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/story-input-ingest.test.js
 *   npm test            （在 plugins/fullstackflow 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-input-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
const PLANS = path.join(SANDBOX, '.codebuddy', 'plans')
fs.mkdirSync(PLANS, { recursive: true })

const {
  createWorkflow,
  refreshStoryInput,
  precheckStoryInput,
  takeFlagValue
} = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))

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

const storyDir = id => path.join(PLANS, id)
const readState = id => JSON.parse(fs.readFileSync(path.join(storyDir(id), 'e2e-state.json'), 'utf-8'))

/** 把一份 input 写到沙箱里的独立位置（模拟「文件还在 Story 目录之外」） */
function stageInput (name, obj) {
  const p = path.join(SANDBOX, name)
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
  return p
}

/** 以子进程跑 harness-workflow.js，返回 { status, stdout, stderr } */
function runWorkflow (args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/harness-workflow.js'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
  })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const flagFile = path.join(PLANS, '.harness-active')
const clearFlag = () => { try { fs.rmSync(flagFile, { force: true }) } catch (e) { /* noop */ } }

// ════════════════════════════════════════════════════════════
section('1. takeFlagValue: 两种 flag 形式，且不吞位置参数')

{
  const a = takeFlagValue(['start', 'S-1', '标题', '--input', '/tmp/x.json'], '--input')
  ok('--input <p> 取到值', a.value === '/tmp/x.json', a.value)
  ok('--input <p> 值不留在 rest', !a.rest.includes('/tmp/x.json'), a.rest.join(' '))
  ok('--input <p> 位置参数完好', a.rest.join(' ') === 'start S-1 标题', a.rest.join(' '))

  const b = takeFlagValue(['start', 'S-1', '标题', '--input=/tmp/y.json'], '--input')
  ok('--input=<p> 取到值', b.value === '/tmp/y.json', b.value)
  ok('--input=<p> 位置参数完好', b.rest.join(' ') === 'start S-1 标题', b.rest.join(' '))

  const c = takeFlagValue(['start', 'S-1', '--input', '--figma'], '--input')
  ok('--input 后紧跟另一个 flag -> 值为 null', c.value === null, String(c.value))
  ok('--input 后的 flag 不被吞掉', c.rest.includes('--figma'), c.rest.join(' '))

  const d = takeFlagValue(['start', 'S-1', '标题'], '--input')
  ok('未给 --input -> null 且 rest 原样', d.value === null && d.rest.length === 3)
}

// ════════════════════════════════════════════════════════════
section('2. run + Figma: 一步建流，判定当场算准')

{
  const input = stageInput('in-run-figma.json', {
    mode: 'run',
    sources: { figmaUrls: ['https://www.figma.com/design/AbC/x?node-id=1-2'], terminal: 'H5' }
  })
  const r = createWorkflow('IN-RUN', '带设计稿的新需求', false, false, 'run', { inputFile: input })

  ok('建流成功', r.success === true, JSON.stringify(r.errors))
  ok('返回 storyInputFile', Boolean(r.storyInputFile), String(r.storyInputFile))

  const st = readState('IN-RUN')
  ok('hasFigmaDesign=true（未跑 --refresh-input）', st.hasFigmaDesign === true, st.hasFigmaDesignReason)
  ok('prototypeRequired=true（有 Figma 链接）', st.gateChecks.prototypeRequired === true, st.gateChecks.prototypeRequiredReason)
  ok('state.mode=run', st.mode === 'run')

  const copied = JSON.parse(fs.readFileSync(path.join(storyDir('IN-RUN'), 'story-input.json'), 'utf-8'))
  ok('input 已落到 Story 目录', copied.sources.figmaUrls.length === 1)
  ok('回填 storyId', copied.storyId === 'IN-RUN', copied.storyId)
  ok('回填 title', copied.title === '带设计稿的新需求', copied.title)
  ok('回填 createdAt', typeof copied.createdAt === 'string' && !isNaN(Date.parse(copied.createdAt)), copied.createdAt)
}

// ════════════════════════════════════════════════════════════
section('3. fixbugs: mode 从文件读出，原型豁免')

{
  const input = stageInput('in-fixbugs.json', {
    mode: 'fixbugs',
    sources: {
      tapdUrl: 'https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944999',
      workspaceId: '10109441',
      owner: '小明',
      figmaUrls: ['https://www.figma.com/design/Zz/y']
    }
  })
  // 注意: 不传 --mode，模式完全由文件决定
  const r = createWorkflow('IN-FIX', '管家反馈合集', false, false, 'run', { inputFile: input })

  ok('建流成功', r.success === true, JSON.stringify(r.errors))
  const st = readState('IN-FIX')
  ok('state.mode=fixbugs（来自文件）', st.mode === 'fixbugs', st.mode)
  ok('prototypeRequired=false', st.gateChecks.prototypeRequired === false, st.gateChecks.prototypeRequiredReason)
  ok('fixbugs 不开 Figma 硬门控（即便给了 figmaUrls）', st.hasFigmaDesign === false, st.hasFigmaDesignReason)
}

// ════════════════════════════════════════════════════════════
section('4. fail-closed: 非法输入拒绝建流，不留残骸')

{
  const bad = stageInput('in-bad-schema.json', { mode: 'nope', sources: {}, 越界字段: 1 })
  const r = createWorkflow('IN-BAD', 'x', false, false, 'run', { inputFile: bad })
  ok('schema 非法 -> success=false', r.success === false)
  ok('错误信息指名 --input', r.errors.some(e => e.includes('--input')), JSON.stringify(r.errors))
  ok('未生成 e2e-state.json', !fs.existsSync(path.join(storyDir('IN-BAD'), 'e2e-state.json')))

  const broken = stageInput('in-broken.json', '{ 这不是 JSON')
  const r2 = createWorkflow('IN-BROKEN', 'x', false, false, 'run', { inputFile: broken })
  ok('JSON 非法 -> success=false', r2.success === false)
  ok('未生成 e2e-state.json', !fs.existsSync(path.join(storyDir('IN-BROKEN'), 'e2e-state.json')))

  const r3 = createWorkflow('IN-MISSING', 'x', false, false, 'run', {
    inputFile: path.join(SANDBOX, '压根不存在.json')
  })
  ok('文件缺失 -> success=false', r3.success === false)
  ok('错误信息说明文件不存在', r3.errors.some(e => e.includes('不存在')), JSON.stringify(r3.errors))
  ok('未生成 e2e-state.json', !fs.existsSync(path.join(storyDir('IN-MISSING'), 'e2e-state.json')))
}

// ════════════════════════════════════════════════════════════
section('5. mode 仲裁：显式 --mode 与文件冲突则拒绝')

{
  const input = stageInput('in-mode-conflict.json', { mode: 'fixbugs', sources: { owner: '小明' } })

  const conflict = precheckStoryInput(input, 'run', true)
  ok('冲突 -> ok=false', conflict.ok === false)
  ok('错误信息点明两处值', conflict.errors.some(e => e.includes('--mode=run') && e.includes('fixbugs')), JSON.stringify(conflict.errors))

  const noFlag = precheckStoryInput(input, 'run', false)
  ok('未显式给 --mode -> 以文件为准，通过', noFlag.ok === true && noFlag.mode === 'fixbugs', JSON.stringify(noFlag))

  const same = precheckStoryInput(input, 'fixbugs', true)
  ok('两处一致 -> 通过', same.ok === true && same.mode === 'fixbugs')

  const r = createWorkflow('IN-CONFLICT', 'x', false, false, 'run', { inputFile: input, modeExplicit: true })
  ok('createWorkflow 同样拒绝', r.success === false)
  ok('未生成 e2e-state.json', !fs.existsSync(path.join(storyDir('IN-CONFLICT'), 'e2e-state.json')))
}

// ════════════════════════════════════════════════════════════
section('6. --refresh-input 旧通道仍可用（回归）')

{
  // 不带 --input 建流 —— 此刻没有 story-input.json，走保守判定
  const r = createWorkflow('IN-LEGACY', '老路径', false, false, 'run')
  ok('建流成功', r.success === true, JSON.stringify(r.errors))
  const before = readState('IN-LEGACY')
  ok('建流时 hasFigmaDesign=false', before.hasFigmaDesign === false)
  ok('建流时 prototypeRequired=true（保守）', before.gateChecks.prototypeRequired === true)

  // 事后补写 story-input.json 再回填
  fs.writeFileSync(
    path.join(storyDir('IN-LEGACY'), 'story-input.json'),
    JSON.stringify({ mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/Q/z'] } }, null, 2)
  )
  const rr = refreshStoryInput('IN-LEGACY', false)
  ok('refresh 成功', rr.success === true, JSON.stringify(rr.errors))
  const after = readState('IN-LEGACY')
  ok('refresh 后 hasFigmaDesign=true', after.hasFigmaDesign === true, after.hasFigmaDesignReason)
}

// ════════════════════════════════════════════════════════════
section('7. CLI 端到端: harness-workflow.js start --input')

{
  clearFlag()
  const input = stageInput('cli-ok.json', {
    mode: 'run',
    sources: { figmaUrls: ['https://www.figma.com/design/Cli/ok'] }
  })
  // 空格形式，且标题带空格 —— 验证路径不会被并进标题
  const r = runWorkflow(['start', 'CLI-OK', '一个 带空格 的标题', '--input', input])
  ok('exit 0', r.status === 0, r.stderr || r.stdout)

  const out = JSON.parse(r.stdout)
  ok('ok=true', out.ok === true)
  ok('title 未被输入路径污染', out.data.title === '一个 带空格 的标题', out.data.title)
  ok('e2eStateCreated', out.data.e2eStateCreated === true, JSON.stringify(out.data))

  const st = readState('CLI-OK')
  ok('hasFigmaDesign=true（一步到位）', st.hasFigmaDesign === true, st.hasFigmaDesignReason)
  ok('标记文件已写', fs.existsSync(flagFile))
}

{
  clearFlag()
  const bad = stageInput('cli-bad.json', { mode: 'run', sources: { 未知字段: 1 } })
  const r = runWorkflow(['start', 'CLI-BAD', '标题', '--input', bad])
  ok('非法 input -> exit 1', r.status === 1, String(r.status))
  ok('未写标记文件（无半激活状态）', !fs.existsSync(flagFile))
  ok('未建 e2e-state.json', !fs.existsSync(path.join(storyDir('CLI-BAD'), 'e2e-state.json')))
}

{
  clearFlag()
  const input = stageInput('cli-conflict.json', { mode: 'fixbugs', sources: { owner: '小明' } })
  const r = runWorkflow(['start', 'CLI-CONFLICT', '标题', '--mode=run', '--input=' + input])
  ok('mode 冲突 -> exit 1', r.status === 1, String(r.status))
  ok('未写标记文件', !fs.existsSync(flagFile))
}

// ════════════════════════════════════════════════════════════
section('8. dispatch: 摄入后能正常起跑')

{
  const d = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/dispatch.js'), 'IN-RUN'], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
  })
  ok('dispatch exit 0', d.status === 0, d.stderr)
  const out = JSON.parse(d.stdout)
  ok('status=ready', out.status === 'ready', out.status)
  ok('nextAgent=requirement-analyst', out.nextAgent === 'requirement-analyst', String(out.nextAgent))
  ok('agentPrompt 非空', typeof out.agentPrompt === 'string' && out.agentPrompt.length > 0)
}

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


