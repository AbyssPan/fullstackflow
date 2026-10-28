const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync, spawnSync } = require('child_process')
const kb = require('../lib/kb-maintenance.cjs')
const lifecycle = require('../lib/kb-history.cjs')
const cli = require('../commands/kb-maintenance.js')
const crypto = require('crypto')
const dir = '.docs/llm-knowledge/'
const stateFile = dir + 'maintenance/domain-order.json'
const runtime = dir + 'tools/fsflow-kb/'
// Frozen pre-lifecycle entry point; existing v1 reader/writer libraries and
// schema are unchanged by this feature. Exercise the real old CLI and manifest.
function installV1Fixture ({ root, put }) {
  const file = runtime + 'commands/kb-maintenance.js'
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/kb-maintenance-v1.js.txt'), 'utf8')
  put(file, source)
  const manifestFile = runtime + 'installed.json'
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile), 'utf8'))
  manifest[file] = crypto.createHash('sha256').update(source).digest('hex')
  delete manifest[runtime + 'lib/kb-history.cjs']
  put(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  fs.unlinkSync(path.join(root, runtime + 'lib/kb-history.cjs'))
  return (...args) => {
    const result = spawnSync(process.execPath, [path.join(root, file), ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout)
  }
}
let count = 0

function test (name, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-history-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
  const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  const record = (reason, status = 'updated') => {
    kb.record(root, { scope: 'domain:order', status, reason, specReview: status === 'deferred' ? 'deferred' : 'aligned' })
    const state = JSON.parse(fs.readFileSync(path.join(root, stateFile), 'utf8'))
    return dir + 'changelog/' + crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex') + '.json'
  }
  try {
    git('init', '-q'); git('config', 'user.name', 'KB Test'); git('config', 'user.email', 'kb@example.invalid')
    git('config', 'core.hooksPath', path.join(root, '.git/hooks'))
    put('src/order.js', 'export const enabled = true\n')
    put(dir + 'meta.yaml', 'git: {}\ndomains:\n  - id: order\n    path: business/order/\n    entry_files: [src/order.js]\n')
    put(dir + 'business/order/overview.md', '# Order\n')
    cli.install(root, false)
    kb.record(root, { scope: 'common', status: 'unchanged', reason: 'Reviewed common', specReview: 'aligned' })
    const old = record('Initial review'), first = commit('Initial knowledge')
    const current = record('Reviewed new requirements'), base = commit('Updated knowledge')
    git('branch', 'integration', base)
    fn({ root, git, put, commit, record, old, current, first, base })
    count++; console.log('✓ ' + name)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('Default preview is read-only; apply preserves receipts, strict checks and Git history', ({ root, git, old, current }) => {
  const before = fs.readFileSync(path.join(root, stateFile), 'utf8')
  const preview = cli.main(['prune', '--base', 'integration'], root)
  assert.equal(preview.dryRun, true)
  assert.deepEqual(preview.candidates.map(x => x.file), [old])
  assert(preview.retained.some(x => x.file === current && x.reason === 'current_receipt'))
  assert.equal(git('status', '--porcelain'), '')
  const history = lifecycle.history(root, { scope: 'domain:order' })
  assert.deepEqual(history.entries.map(x => x.reason), ['Reviewed new requirements', 'Initial review'])
  const result = cli.main(['prune', '--base', 'integration', '--apply'], root)
  assert.deepEqual(result.deleted, [old])
  assert.equal(fs.readFileSync(path.join(root, stateFile), 'utf8'), before)
  assert.equal(git('diff', '--cached', '--name-only'), '')
  assert(kb.check(root, { strict: true }).passed)
  git('add', '-u'); assert(kb.check(root, { mode: 'staged', strict: true }).passed)
  git('commit', '-qm', 'Prune old fragments')
  assert.deepEqual(lifecycle.history(root, { scope: 'domain:order' }).entries, history.entries)
  assert.equal(lifecycle.prune(root, { base: 'HEAD', apply: true }).deleted.length, 0)
})

test('Modified and partially staged fragments are retained', ({ root, git, old }) => {
  fs.appendFileSync(path.join(root, old), ' ')
  assert.equal(lifecycle.prune(root, { base: 'integration' }).candidates.length, 0)
  git('add', old); git('restore', '--worktree', '--source=HEAD', old)
  assert.equal(lifecycle.prune(root, { base: 'integration', apply: true }).deleted.length, 0)
})

test('Untracked fragments and receipts changed after the baseline are retained', ({ root, record, commit }) => {
  record('Local review')
  assert.equal(lifecycle.prune(root, { base: 'integration' }).candidates.length, 0)
  commit('Not integrated')
  const result = lifecycle.prune(root, { base: 'integration', apply: true })
  assert.equal(result.deleted.length, 0)
  assert(result.retained.some(x => x.reason === 'uncommitted_or_not_on_base'))
})

test('Missing or modified current fragment prevents pruning the domain', ({ root, git, current }) => {
  fs.unlinkSync(path.join(root, current))
  assert.equal(lifecycle.prune(root, { base: 'integration' }).candidates.length, 0)
  git('restore', current)
  fs.appendFileSync(path.join(root, current), ' ')
  assert.equal(lifecycle.prune(root, { base: 'integration' }).candidates.length, 0)
})

test('Deferred records survive later reviews; a deferred current scope keeps all fragments', ({ root, record, commit }) => {
  const deferred = record('Pending owner decision', 'deferred')
  commit('Defer')
  assert.equal(lifecycle.prune(root, { base: 'HEAD' }).candidates.length, 0)
  record('Reviewed again'); commit('Review')
  const result = lifecycle.prune(root, { base: 'HEAD', apply: true })
  assert(result.retained.some(x => x.file === deferred && x.reason === 'deferred_requires_explicit_resolution'))
  assert(fs.existsSync(path.join(root, deferred)))
})

test('Squashed intermediate receipts have no proven history and are retained', ({ root, record, commit }) => {
  const intermediate = record('Uncommitted intermediate review')
  record('Final MR review'); commit('Squashed MR')
  const result = lifecycle.prune(root, { base: 'HEAD' })
  assert(result.retained.some(x => x.file === intermediate && x.reason === 'supersession_not_proven'))
})

test('Diverged baselines and missing baseline are rejected before deleting', ({ root, git, record, commit, first, old }) => {
  assert.throws(() => lifecycle.prune(root, { apply: true }), /requires --base/)
  git('checkout', '-qb', 'other', first); record('Other branch'); commit('Divergence')
  assert.throws(() => lifecycle.prune(root, { base: 'integration', apply: true }), /ancestor/)
  assert(fs.existsSync(path.join(root, old)))
})

test('Merge commits expose integrated receipt history and allow superseded cleanup', ({ root, git, record, commit }) => {
  git('checkout', '-qb', 'feature'); record('Feature review'); commit('Feature')
  git('checkout', 'integration'); git('merge', '--no-ff', '-qm', 'Integrate feature', 'feature')
  const result = lifecycle.history(root, { scope: 'domain:order' })
  assert.equal(result.entries[0].subject, 'Integrate feature')
  assert.equal(result.entries[0].reason, 'Feature review')
  assert.equal(lifecycle.prune(root, { base: 'integration' }).candidates.length, 2)
})

test('Invalid JSON and forged event metadata are retained', ({ root, git, put, commit, old }) => {
  const malformed = dir + 'changelog/' + 'a'.repeat(64) + '.json'
  put(malformed, '{broken')
  assert(lifecycle.prune(root, { base: 'integration' }).retained.some(x => x.file === malformed && x.reason === 'unverified_record'))
  fs.unlinkSync(path.join(root, malformed))
  const event = JSON.parse(fs.readFileSync(path.join(root, old), 'utf8'))
  event.reason = 'Forged reason'; put(old, JSON.stringify(event)); commit('Changed event')
  assert(lifecycle.prune(root, { base: 'HEAD' }).retained.some(x => x.file === old && x.reason === 'event_receipt_mismatch'))
  git('restore', old)
})

test('A symlinked changelog directory cannot delete its target files', ({ root, old }) => {
  const original = path.join(root, dir, 'changelog'), moved = path.join(root, 'saved-changelog')
  fs.renameSync(original, moved); fs.symlinkSync(moved, original, 'dir')
  assert.equal(lifecycle.prune(root, { base: 'integration', apply: true }).deleted.length, 0)
  assert(fs.existsSync(path.join(root, old)))
})

test('Referenced fragments and custom event fields are preserved', ({ root, old, put, record, commit }) => {
  put(dir + 'business/order/overview.md', '# Order\n[Review](../../changelog/' + path.basename(old) + ')\n')
  record('Document links to review'); commit('Keep referenced evidence')
  assert(lifecycle.prune(root, { base: 'HEAD' }).retained.some(x => x.file === old && x.reason === 'referenced_by_document'))
  put(dir + 'business/order/overview.md', '# Order\n')
  const event = JSON.parse(fs.readFileSync(path.join(root, old), 'utf8'))
  event.notes = 'Extra manual knowledge'; put(old, JSON.stringify(event))
  record('Reviewed without link'); commit('Custom metadata')
  assert(lifecycle.prune(root, { base: 'HEAD', apply: true }).retained.some(x => x.file === old && x.reason === 'unverified_record'))
  assert(fs.existsSync(path.join(root, old)))
})

test('Reference-style links, HTML, encoded paths and malformed unrelated URLs remain safe', ({ root, old, put }) => {
  for (const link of [
    '[Review][old]\n[old]: ../../changelog/' + path.basename(old),
    '<a href="../../changelog/' + path.basename(old) + '">Review</a>',
    '[Review](../../changelog/' + path.basename(old).replace(/./g, c => '%' + c.charCodeAt(0).toString(16)) + ')'
  ]) {
    put(dir + 'business/order/overview.md', '# Order\n' + link + '\n[Other](bad%url)\n')
    const result = lifecycle.prune(root, { base: 'integration', apply: true })
    assert(result.retained.some(x => x.file === old && x.reason === 'referenced_by_document'))
    assert(fs.existsSync(path.join(root, old)))
  }
})

test('Domain remapping preserves legacy document evidence without blocking valid cleanup', ({ root, old, current, put, record, commit }) => {
  put(dir + 'meta.yaml', 'git: {}\ndomains:\n  - id: order\n    path: business/new-order/\n    entry_files: [src/order.js]\n')
  put(dir + 'business/new-order/overview.md', '# Moved order domain\n')
  const moved = record('New document ownership')
  commit('Remap domain')
  assert(lifecycle.prune(root, { base: 'HEAD' }).candidates.some(x => x.file === old))
  record('Review remapped domain'); commit('Recheck')
  const result = lifecycle.prune(root, { base: 'HEAD', apply: true })
  assert.deepEqual(new Set(result.deleted), new Set([old, current, moved]))
  assert(fs.existsSync(path.join(root, dir + 'business/order/overview.md')))
})

test('Retired scopes remain protected and deleted receipts stay visible in history', ({ root, put, git, commit, old }) => {
  put(dir + 'meta.yaml', 'git: {}\ndomains: []\n')
  git('rm', stateFile); commit('Retire scope')
  assert(lifecycle.prune(root, { base: 'HEAD' }).retained.some(x => x.file === old && x.reason === 'unknown_scope'))
  assert.equal(lifecycle.history(root, { scope: 'domain:order' }).entries[0].deleted, true)
})

test('History supports the same Unicode and dotted domain IDs as metadata', ({ root, put, commit }) => {
  const scope = 'domain:订单.v2'
  put(dir + 'meta.yaml', 'git: {}\ndomains:\n  - id: 订单.v2\n    path: business/order/\n    entry_files: [src/order.js]\n')
  kb.record(root, { scope, status: 'updated', reason: '已核实', specReview: 'aligned' })
  commit('Unicode domain')
  assert.equal(lifecycle.history(root, { scope }).entries[0].reason, '已核实')
})

test('Pruning respects the record lock', ({ root, put, old }) => {
  put('.git/fsflow-kb-maintenance.lock', 'other writer')
  assert.throws(() => lifecycle.prune(root, { base: 'integration', apply: true }), /EEXIST/)
  assert(fs.existsSync(path.join(root, old)))
})

test('History is bounded, filters scopes, supports historical refs and validates inputs', ({ root, first }) => {
  const result = cli.main(['history', '--scope', 'domain:order', '--limit', '1'], root)
  assert.equal(result.entries.length, 1); assert.equal(result.truncated, true)
  assert.equal(lifecycle.history(root, { scope: 'common' }).entries.length, 1)
  assert.equal(lifecycle.history(root, { scope: 'domain:order', ref: first }).entries[0].reason, 'Initial review')
  assert.throws(() => cli.main(['history'], root), /Invalid scope/)
  assert.throws(() => cli.main(['history', '--scope', 'domain:order', '--limit', '0'], root), /limit/)
  assert.throws(() => cli.main(['prune', '--base', 'HEAD', '--apply', '--dry-run'], root), /Choose/)
})

test('Unknown commands cannot fall through to uninstalling hooks', ({ root }) => {
  cli.install(root, true)
  const file = path.join(root, '.git/hooks/pre-commit'), before = fs.readFileSync(file, 'utf8')
  for (const command of ['constructor', 'toString', '__proto__', 'unknown']) {
    assert.throws(() => cli.main([command], root), /Usage:/)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
})

test('Shallow clones warn on history and refuse pruning', ({ root }) => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shallow-'))
  try {
    execFileSync('git', ['clone', '-q', '--depth=1', 'file://' + root, clone])
    assert.equal(lifecycle.history(clone, { scope: 'domain:order' }).warnings.length, 1)
    assert.throws(() => lifecycle.prune(clone, { base: 'HEAD', apply: true }), /shallow/)
  } finally { fs.rmSync(clone, { recursive: true, force: true }) }
})

test('Installed runtime includes lifecycle commands in ESM projects', ({ root, put }) => {
  put('package.json', '{"type":"module"}\n')
  const command = path.join(root, dir, 'tools/fsflow-kb/commands/kb-maintenance.js')
  for (const args of [['history', '--scope', 'domain:order'], ['prune', '--base', 'integration', '--dry-run']]) {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.doesNotThrow(() => JSON.parse(result.stdout))
  }
})

test('Real v1 runtime upgrades in place without rewriting generated knowledge or requiring rerecord', fixture => {
  const { root, put, git, commit } = fixture
  const run = installV1Fixture(fixture)
  put(dir + 'maintenance.json', '{"version":1,"allow_deferred":true}\n')
  assert(run('check', '--strict').passed)
  run('record', '--scope', 'domain:order', '--status', 'updated', '--reason', 'Generated by old CLI', '--spec-review', 'aligned')
  commit('Old runtime and generated v1 knowledge')
  const before = new Map(git('ls-files', dir).split('\n').filter(f => !f.startsWith(runtime)).map(f => [f, fs.readFileSync(path.join(root, f))]))
  cli.install(root, false)
  for (const [file, data] of before) assert.deepEqual(fs.readFileSync(path.join(root, file)), data, file)
  assert(run('check', '--strict').passed)
  assert.equal(run('history', '--scope', 'domain:order').entries[0].reason, 'Generated by old CLI')
  assert.equal(run('prune', '--base', 'HEAD').candidates.length, 2)
  const manifest = fs.readFileSync(path.join(root, runtime + 'installed.json'), 'utf8')
  cli.install(root, false)
  assert.equal(fs.readFileSync(path.join(root, runtime + 'installed.json'), 'utf8'), manifest)
})

test('Upgrade collision leaves old runtime usable and all files unchanged', fixture => {
  const { root, put } = fixture
  const run = installV1Fixture(fixture)
  const custom = path.join(root, runtime + 'lib/kb-maintenance.cjs')
  fs.appendFileSync(custom, '\n// local customization\n')
  const oldEntry = fs.readFileSync(path.join(root, runtime + 'commands/kb-maintenance.js'), 'utf8')
  const oldManifest = fs.readFileSync(path.join(root, runtime + 'installed.json'), 'utf8')
  assert.throws(() => cli.install(root, false), /Locally modified runtime/)
  assert.equal(fs.readFileSync(path.join(root, runtime + 'commands/kb-maintenance.js'), 'utf8'), oldEntry)
  assert.equal(fs.readFileSync(path.join(root, runtime + 'installed.json'), 'utf8'), oldManifest)
  assert(!fs.existsSync(path.join(root, runtime + 'lib/kb-history.cjs')))
  assert(run('check', '--strict').passed)
  // An entry point copied alone must not break legacy check/record commands.
  put(runtime + 'commands/kb-maintenance.js', fs.readFileSync(path.join(__dirname, '../commands/kb-maintenance.js'), 'utf8'))
  assert(run('check', '--strict').passed)
})

test('Legacy log.md-only KB remains readable and installation does not invent review history', ({ root, git, put, commit }) => {
  git('rm', '-qr', dir + 'maintenance', dir + 'changelog', dir + 'tools', dir + 'maintenance.json')
  const legacy = '# Historical knowledge\nManual decisions and CUSTOM content must survive.\n'
  put(dir + 'log.md', legacy); commit('Legacy KB without receipts')
  const check = kb.check(root)
  assert(check.passed); assert.equal(check.enabled, false)
  assert.equal(kb.check(root, { strict: true }).passed, false)
  const history = lifecycle.history(root, { scope: 'domain:missing' })
  assert.equal(history.entries.length, 0); assert(history.warnings.some(w => w.includes('Legacy log.md')))
  assert.throws(() => lifecycle.prune(root, { base: 'HEAD', apply: true }), /Initialize and commit/)
  cli.install(root, false)
  assert.equal(fs.readFileSync(path.join(root, dir + 'log.md'), 'utf8'), legacy)
  assert(!fs.existsSync(path.join(root, dir + 'maintenance')))
  assert(!fs.existsSync(path.join(root, dir + 'changelog')))
  assert(kb.check(root, { strict: true }).pending.some(x => x.reason === 'not_reviewed'))
})

console.log(`Passed ${count} knowledge lifecycle tests`)
