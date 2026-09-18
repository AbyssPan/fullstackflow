#!/usr/bin/env node
// Portable entry point: the installer copies this command and its dependencies
// into the target repository. Hooks never require a user's plugin cache path.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const kb = require('../lib/kb-maintenance.cjs')
const { KB_DIR } = require('../lib/kb.cjs')

const DEST = KB_DIR + '/tools/fsflow-kb'
const digest = text => crypto.createHash('sha256').update(text).digest('hex')
const preCommit = '#!/bin/sh\n# fsflow-kb managed hook\nset -e\n' +
  'if [ -x "$0.fsflow-original" ]; then "$0.fsflow-original" "$@"; fi\n' +
  'root=$(git rev-parse --show-toplevel)\n' +
  'if [ ! -f "$root/' + DEST + '/commands/kb-maintenance.js" ]; then echo "KB checks are not installed on this branch; server checks still apply." >&2; exit 0; fi\n' +
  'node "$root/' + DEST + '/commands/kb-maintenance.js" check --staged\n'

function install (root, hooks) {
  if (!fs.existsSync(path.join(root, KB_DIR, 'meta.yaml'))) throw new Error('Initialize the knowledge base before installing maintenance support')
  const bundle = ['commands/kb-maintenance.js', 'lib/kb-maintenance.cjs', 'lib/kb.cjs', 'vendor/js-yaml.cjs', 'vendor/js-yaml.LICENSE', 'templates/kb-gitlab-ci.yml']
  const origin = path.resolve(__dirname, '..')
  const manifestPath = path.join(root, DEST, 'installed.json')
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {}
  const writes = bundle.map(f => ({ file: DEST + '/' + f, data: fs.readFileSync(path.join(origin, f), 'utf8') }))
  // Preflight all collisions before modifying the package or hook.
  for (const { file, data } of writes) {
    const abs = path.join(root, file)
    if (fs.existsSync(abs)) {
      const current = fs.readFileSync(abs, 'utf8')
      if (current !== data && digest(current) !== previous[file]) throw new Error('Locally modified runtime file: ' + file)
    }
  }
  let hook
  if (hooks) {
    const configured = (() => { try { return kb.git(root, ['config', '--get', 'core.hooksPath']).trim() } catch (_) { return '' } })()
    const hookDir = configured ? path.resolve(root, configured) : path.resolve(root, kb.git(root, ['rev-parse', '--git-path', 'hooks']).trim())
    hook = path.join(hookDir, 'pre-commit')
    if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8') !== preCommit) {
      if (configured) throw new Error('Existing hook manager: add this command to its pre-commit hook: node ' + DEST + '/commands/kb-maintenance.js check --staged. Install without --hooks to copy the runtime first.')
      if (fs.lstatSync(hook).isSymbolicLink() || fs.existsSync(hook + '.fsflow-original')) throw new Error('Cannot safely wrap the existing pre-commit hook')
    }
  }
  for (const { file, data } of writes) kb.atomicWrite(root, file, data)
  kb.atomicWrite(root, DEST + '/installed.json', JSON.stringify(Object.fromEntries(writes.map(w => [w.file, digest(w.data)])), null, 2) + '\n')
  if (!fs.existsSync(path.join(root, kb.CONFIG))) kb.atomicWrite(root, kb.CONFIG, JSON.stringify({ version: 1, allow_deferred: false }, null, 2) + '\n')
  const ignoreFile = KB_DIR + '/.gitignore'
  const oldIgnore = fs.existsSync(path.join(root, ignoreFile)) ? fs.readFileSync(path.join(root, ignoreFile), 'utf8') : ''
  const ignore = ['/frontend-index.json', '/backend-index.json', '/cache/', '*.tmp-*'].filter(line => !oldIgnore.split(/\r?\n/).includes(line))
  if (ignore.length) kb.atomicWrite(root, ignoreFile, oldIgnore + (oldIgnore && !oldIgnore.endsWith('\n') ? '\n' : '') + ignore.join('\n') + '\n')
  if (hook) {
    fs.mkdirSync(path.dirname(hook), { recursive: true })
    if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8') !== preCommit) fs.renameSync(hook, hook + '.fsflow-original')
    fs.writeFileSync(hook, preCommit, { mode: 0o755 }); fs.chmodSync(hook, 0o755)
  }
  const trackedIndexes = kb.git(root, ['ls-files', '--', KB_DIR + '/frontend-index.json', KB_DIR + '/backend-index.json']).trim()
  return { installed: DEST, hooksInstalled: Boolean(hook), ciTemplate: DEST + '/templates/kb-gitlab-ci.yml',
    warnings: trackedIndexes ? ['Existing indexes are tracked; review git rm --cached for these cache files: ' + trackedIndexes] : [],
    next: 'Review and record KB scopes, commit the portable runtime, then include the CI template and configure required merged-result checks in GitLab. Each clone enables its own local hook.' }
}

function uninstallHook (root) {
  let configured = ''
  try { configured = kb.git(root, ['config', '--get', 'core.hooksPath']).trim() } catch (_) {}
  const dir = configured ? path.resolve(root, configured) : path.resolve(root, kb.git(root, ['rev-parse', '--git-path', 'hooks']).trim())
  const file = path.join(dir, 'pre-commit')
  if (!fs.existsSync(file)) return { removed: false }
  if (fs.readFileSync(file, 'utf8') !== preCommit) throw new Error('Hook was modified or belongs to another manager; leave it unchanged')
  fs.unlinkSync(file)
  if (fs.existsSync(file + '.fsflow-original')) fs.renameSync(file + '.fsflow-original', file)
  return { removed: true, runtimePreserved: true }
}

function main (args, root = process.cwd()) {
  if (fs.realpathSync(root) !== fs.realpathSync(kb.git(root, ['rev-parse', '--show-toplevel']).trim())) throw new Error('Run this command at the target repository root')
  const command = args.shift()
  const options = {}, sources = []
  const flags = new Set(['staged', 'strict', 'hooks'])
  const values = new Set(['ref', 'base', 'scope', 'status', 'reason', 'spec-review', 'source'])
  while (args.length) {
    const key = args.shift().replace(/^--/, '')
    if (flags.has(key)) options[key] = true
    else if (values.has(key) && args.length) {
      const value = args.shift()
      if (key === 'source') sources.push(value)
      else if (key in options) throw new Error('Duplicate option: ' + key)
      else options[key] = value
    } else throw new Error('Unknown or incomplete option: ' + key)
  }
  const permitted = { check: ['staged', 'strict', 'ref', 'base'], record: ['scope', 'status', 'reason', 'spec-review'], install: ['hooks'], 'uninstall-hooks': [] }
  if (!permitted[command] || Object.keys(options).some(k => !permitted[command].includes(k)) || (sources.length && command !== 'record')) throw new Error('Usage: kb-maintenance.js check [--staged|--ref REF] [--base REF] [--strict] | record --scope common|domain:ID --status updated|unchanged|deferred --reason TEXT --spec-review aligned|approved|deferred [--source PATH] | install [--hooks] | uninstall-hooks')
  if (options.staged && options.ref) throw new Error('Choose staged or ref, not both')
  if (command === 'check') {
    const result = kb.check(root, { mode: options.staged ? 'staged' : options.ref || 'working', base: options.base, strict: options.strict })
    const bounded = item => item.files ? { ...item, fileCount: item.files.length, files: item.files.slice(0, 50), truncated: item.files.length > 50 } : item
    return { ...result, errorCount: result.errors.length, pendingCount: result.pending.length,
      errors: result.errors.slice(0, 50).map(bounded), pending: result.pending.slice(0, 50).map(bounded),
      truncated: result.errors.length > 50 || result.pending.length > 50 }
  }
  if (command === 'record') {
    const { file, state } = kb.record(root, { scope: options.scope, status: options.status, reason: options.reason, specReview: options['spec-review'], sources })
    return { file, scope: state.scope, status: state.status, sourceCount: Object.keys(state.sources).length, documentCount: Object.keys(state.documents).length }
  }
  if (command === 'install') return install(root, options.hooks)
  return uninstallHook(root)
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2))
    console.log(JSON.stringify(result, null, 2))
    if (result.passed === false) process.exitCode = 1
  } catch (e) { console.log(JSON.stringify({ passed: false, errors: [e.message] })); process.exitCode = 1 }
}
module.exports = { main, install, uninstallHook }
