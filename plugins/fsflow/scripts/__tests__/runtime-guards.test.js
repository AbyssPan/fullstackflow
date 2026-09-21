#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const cp = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsflow-guards-'))
const pluginRoot = path.resolve(__dirname, '../..')
process.env.CLAUDE_PROJECT_DIR = root
process.env.CODEBUDDY_PROJECT_DIR = root
delete process.env.HARNESS_RUN_BUILD
const state = require('../lib/state')
const { createWorkflow } = require('../commands/create-workflow')
const policy = require('../services/policy')
const plans = path.join(root, '.codebuddy/plans')
const story = 'GUARDS'
let count = 0
function test(name, action) {
  action()
  count++
  console.log(`  OK ${name}`)
}
function write(file, value) {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value))
}
function hook(name, toolName, toolInput) {
  const result = cp.spawnSync(process.execPath, [path.join(pluginRoot, 'scripts/hooks', name)], {
    cwd: root, env: process.env, encoding: 'utf8',
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput })
  })
  assert.ifError(result.error)
  return { status: result.status, output: JSON.parse(result.stdout) }
}
function gate(runtime = policy) {
  return runtime.runGateCheck(story, 2, state.readStateFile(story))
}
function setLint(status, stderr = '') {
  write('node_modules/eslint/bin/eslint.js', `
    const fs = require('fs')
    fs.writeFileSync('lint-args.json', JSON.stringify(process.argv.slice(2)))
    process.stderr.write(${JSON.stringify(stderr)})
    process.exit(${status})
  `)
}

try {
  cp.execFileSync('git', ['init', '-q', root])
  write('.gitignore', '.codebuddy/\nnode_modules/\nlint-args.json\n')
  write('src/existing.js', 'const original = 1\n')
  write('src/delete.js', 'const deleted = 1\n')
  cp.execFileSync('git', ['add', '.'], { cwd: root })
  cp.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root })
  createWorkflow(story, 'runtime guards', false, false, 'fixbugs')
  write('.codebuddy/plans/.harness-active', { active: true, storyId: story })
  state.issueDevPass(story, 3600000, [{ repo: state.loadRepos(story).primary, path: 'src/**' }])
  const storyState = state.readStateFile(story)

  test('MultiEdit cannot edit either protected state file and is registered', () => {
    const config = require('../../hooks/hooks.json')
    const registration = config.hooks.PreToolUse.find(group => group.hooks.some(h => h.command.includes('enforce-state-file')))
    assert(new RegExp(registration.matcher).test('MultiEdit'))
    for (const name of ['e2e-state.json', 'dev-pass.json']) {
      assert.equal(hook('enforce-state-file.js', 'MultiEdit', {
        file_path: path.join(plans, story, name), edits: [{ old_string: '0', new_string: '2' }]
      }).status, 2)
    }
  })
  test('Large UTF-8 hook payloads are fully read and still denied', () => {
    const result = hook('enforce-state-file.js', 'Write', {
      content: '大文件内容'.repeat(20000), file_path: path.join(plans, story, 'e2e-state.json')
    })
    assert.equal(result.status, 2)
    assert.equal(result.output.continue, false)
  })
  test('Residual dev-pass cannot authorize Phase 0 or unreadable state', () => {
    const input = { file_path: path.join(root, 'src/existing.js') }
    assert.equal(hook('enforce-dev-pass.js', 'Edit', input).status, 2)
    write(`.codebuddy/plans/${story}/e2e-state.json`, '{invalid')
    assert.equal(hook('enforce-dev-pass.js', 'Edit', input).status, 2)
    write(`.codebuddy/plans/${story}/e2e-state.json`, { ...storyState, phase: 2 })
    assert.equal(hook('enforce-dev-pass.js', 'Edit', input).status, 0)
  })
  test('Another Story pass cannot authorize the active Story', () => {
    createWorkflow('OTHER', 'other', false, false, 'fixbugs')
    write('.codebuddy/plans/.harness-active', { active: true, storyId: 'OTHER' })
    assert.equal(hook('enforce-dev-pass.js', 'Edit', { file_path: path.join(root, 'src/existing.js') }).status, 2)
    write('.codebuddy/plans/.harness-active', { active: true, storyId: story })
  })
  test('Session recovery requests authoritative dispatch without claiming gate success', () => {
    const result = hook('session-start.js', '', {})
    assert.equal(result.status, 0)
    const context = result.output.hookSpecificOutput.additionalContext
    assert(context.includes('门控尚未重新验证'))
    assert(context.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/dispatch.js" GUARDS'))
    assert(!context.includes('门控验证通过'))
  })
  test('Hook commands support plugin paths containing spaces', () => {
    const alias = path.join(root, 'plugin with spaces')
    fs.symlinkSync(pluginRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const config = require('../../hooks/hooks.json')
    const command = config.hooks.PreToolUse[0].hooks[0].command
    const result = cp.spawnSync(command.replace('${CLAUDE_PLUGIN_ROOT}', alias), {
      shell: true, cwd: root, env: { ...process.env, CLAUDE_PLUGIN_ROOT: alias }, encoding: 'utf8', input: '{}'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).continue, true)
    fs.unlinkSync(alias)
  })

  write('src/new folder/中文.js', 'const added = 1\n')
  write('src/line\nbreak.js', 'const newline = 1\n')
  write('src/$(touch should-not-exist).js', 'const literal = 1\n')
  fs.unlinkSync(path.join(root, 'src/delete.js'))
  cp.execFileSync('git', ['mv', 'src/existing.js', 'src/renamed.js'], { cwd: root })
  test('Lint includes nested untracked files and renamed targets, preserves paths, skips deletions', () => {
    setLint(0)
    assert.equal(gate().passed, true)
    const args = JSON.parse(fs.readFileSync(path.join(root, 'lint-args.json')))
    assert(args.includes('src/new folder/中文.js'))
    assert(args.includes('src/line\nbreak.js'))
    assert(args.includes('src/renamed.js'))
    assert(!args.includes('src/delete.js'))
    assert(!args.includes('src/existing.js'))
    assert(!args.includes('--fix'))
    assert(!args.includes('compact'))
    assert(!fs.existsSync(path.join(root, 'should-not-exist')))
  })
  test('Lint errors and configuration/tool failures block instead of passing silently', () => {
    for (const status of [1, 2]) {
      setLint(status, 'ESLint failed without compact formatter output')
      const result = gate()
      assert.equal(result.passed, false)
      assert(result.blockers.some(b => b.message.includes('ESLint failed')))
    }
    setLint(0, 'warning only')
    assert.equal(gate().passed, true)
  })
  test('Build output overflow blocks the actual Phase 2 gate', () => {
    const file = path.join(pluginRoot, 'scripts/services/policy.js')
    const localRequire = createRequire(file)
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module, exports: module.exports, process, console,
      require: name => name === 'child_process' ? {
        ...cp,
        execSync: command => {
          assert.equal(command, 'npm run build')
          throw Object.assign(new Error('output overflow'), { code: 'ENOBUFS', status: null })
        }
      } : localRequire(name)
    }, { filename: file })
    write('package.json', { scripts: { build: 'example-build' } })
    process.env.HARNESS_RUN_BUILD = '1'
    const result = gate(module.exports)
    assert.equal(result.passed, false)
    assert(result.blockers.some(b => b.message.includes('maxBuffer')))
    delete process.env.HARNESS_RUN_BUILD
  })
  console.log(`Runtime guards: ${count} checks passed`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
