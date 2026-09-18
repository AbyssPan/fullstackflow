// Shared by local hooks, CI and the AI workflow. Checks are read-only.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { KB_DIR, parseMeta, parseYaml, relativePath, matchesSource } = require('./kb.cjs')
const yaml = require('../vendor/js-yaml.cjs')

const CONFIG = KB_DIR + '/maintenance.json'
const STATES = KB_DIR + '/maintenance/'
const object = v => v && typeof v === 'object' && !Array.isArray(v)
function git (root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function safePath (file) {
  relativePath(file)
  if (!file || file.startsWith('./') || /[\x00-\x1f]/.test(file) || file.split('/').some(p => !p || p === '.')) throw new Error('Invalid path: ' + file)
  return file
}
const sourceFile = f => !f.startsWith(KB_DIR + '/') && !f.startsWith('.codebuddy/')
const documentFile = f => f.startsWith(KB_DIR + '/') && /\.md$/.test(f) && !/\/(?:tools|templates|vendor)\//.test(f)
// Receipt files stay human-readable; scope ids are controlled slugs.
const statePath = scope => STATES + scope.replace(/:/g, '-') + '.json'

// Git blob identities work across commits, rebases and machines. No timestamps
// or branch names enter the tracked knowledge receipts.
function snapshot (root, mode = 'working') {
  const files = new Map()
  if (mode === 'working') {
    const reportedFormat = git(root, ['rev-parse', '--show-object-format']).trim()
    const format = reportedFormat === 'sha256' ? 'sha256' : 'sha1'
    for (const file of new Set(git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean))) {
      safePath(file)
      const abs = path.join(root, file)
      let stat
      try { stat = fs.lstatSync(abs) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue
      const data = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs)
      const oid = crypto.createHash(format).update(Buffer.from('blob ' + data.length + '\0')).update(data).digest('hex')
      files.set(file, { oid, mode: stat.isSymbolicLink() ? '120000' : '100644',
        // Source bytes are used only for hashing, never retained in AI output.
        ...(file.startsWith(KB_DIR + '/') ? { data } : {}) })
    }
  } else {
    const staged = mode === 'staged'
    const revision = staged ? null : git(root, ['rev-parse', '--verify', mode + '^{commit}']).trim()
    const listing = git(root, staged ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-rz', '--full-tree', revision])
    for (const row of listing.split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), file = safePath(row.slice(tab + 1)), parts = row.slice(0, tab).split(' ')
      if (staged && parts[2] !== '0') throw new Error('Unresolved Git conflict: ' + file)
      if (!staged && parts[1] !== 'blob') continue
      files.set(file, { mode: parts[0], oid: parts[staged ? 1 : 2] })
    }
  }
  return {
    files,
    oid: file => files.get(file)?.oid || null,
    read: file => {
      const entry = files.get(file)
      if (!entry) return null
      if (file.startsWith(KB_DIR + '/') && entry.mode === '120000') throw new Error('KB symlink is not supported: ' + file)
      if (!entry.data) entry.data = mode === 'working' ? fs.readFileSync(path.join(root, file)) : Buffer.from(git(root, ['cat-file', 'blob', entry.oid]))
      return entry.data.toString('utf8')
    }
  }
}

function inventory (snap) {
  const text = snap.read(KB_DIR + '/meta.yaml')
  if (text === null) return null
  const meta = parseMeta(text)
  const profileText = snap.read(KB_DIR + '/.profile.yaml')
  const profile = profileText === null ? {} : parseYaml(profileText)
  const scopes = new Map([['common', { sources: new Set(), documents: new Set() }]])
  for (const domain of meta.domains) scopes.set('domain:' + domain.id, { sources: new Set(), documents: new Set(), domain })
  for (const file of snap.files.keys()) {
    if (sourceFile(file)) {
      const owners = [...scopes.values()].filter(s => s.domain?.files.some(p => matchesSource(file, p, profile.source_root || 'src')))
      for (const s of owners.length ? owners : [scopes.get('common')]) s.sources.add(file)
    } else if (documentFile(file)) {
      const owners = [...scopes.values()].filter(s => s.domain && file.startsWith(KB_DIR + '/' + s.domain.path.replace(/\/$/, '') + '/'))
      if (owners.length > 1) throw new Error('Overlapping KB document domains: ' + file)
      ;(owners[0] || scopes.get('common')).documents.add(file)
    }
  }
  for (const item of scopes.values()) {
    item.context = crypto.createHash('sha256').update(JSON.stringify({
      path: item.domain?.path || null, files: item.domain?.files || [], profile,
      backendConfig: snap.oid(KB_DIR + '/backend.config.json')
    })).digest('hex')
  }
  return { meta, scopes }
}

function readConfig (snap) {
  const text = snap.read(CONFIG)
  if (text === null) return null
  const c = JSON.parse(text)
  if (!object(c) || c.version !== 1 || typeof c.allow_deferred !== 'boolean') throw new Error('maintenance.json requires version: 1 and allow_deferred: boolean')
  return c
}

function readStates (snap) {
  const states = new Map()
  for (const file of snap.files.keys()) {
    if (!file.startsWith(STATES) || !file.endsWith('.json')) continue
    const s = JSON.parse(snap.read(file))
    if (!object(s) || s.version !== 1 || typeof s.scope !== 'string' || file !== statePath(s.scope) ||
        !['updated', 'unchanged', 'deferred'].includes(s.status) || !object(s.sources) || !object(s.documents) ||
        typeof s.reason !== 'string' || !s.reason.trim() || !/^[a-f0-9]{64}$/.test(s.context || '') || !['aligned', 'approved', 'deferred'].includes(s.spec_review)) {
      throw new Error('Invalid knowledge receipt: ' + file)
    }
    if (s.status !== 'deferred' && s.spec_review === 'deferred') throw new Error('Unresolved spec decision: ' + file)
    for (const [key, values] of [['sources', s.sources], ['documents', s.documents]]) {
      for (const [p, oid] of Object.entries(values)) {
        safePath(p)
        if ((key === 'sources' ? !sourceFile(p) : !documentFile(p)) || (oid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw new Error('Invalid receipt reference: ' + file + ': ' + p)
      }
    }
    states.set(s.scope, s)
  }
  return states
}

function check (root, { mode = 'working', base, strict = false } = {}) {
  const errors = [], warnings = [], pending = []
  try {
    const snap = snapshot(root, mode), inv = inventory(snap), config = readConfig(snap)
    if (!inv) {
      if (base && inventory(snapshot(root, base))) throw new Error('Knowledge base removed from the candidate merge')
      if (config || [...snap.files.keys()].some(f => f.startsWith(STATES))) throw new Error('Knowledge metadata is missing')
      return { passed: true, enabled: false, errors, warnings: ['Knowledge base is not initialized'], pending }
    }
    for (const file of snap.files.keys()) {
      if (!file.startsWith(KB_DIR + '/') || /\/(?:tools|templates|vendor)\//.test(file)) continue
      if (!/\.(?:md|ya?ml|json)$/.test(file)) continue
      const text = snap.read(file)
      if (/^(?:<{7}|>{7})(?:\s|$)/m.test(text)) errors.push({ code: 'conflict_marker', file })
      if (/\.json$/.test(file)) JSON.parse(text)
      if (/\.ya?ml$/.test(file)) yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA })
      if (/\.md$/.test(file)) {
        for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
          const link = m[1].replace(/^<|>$/g, '').split('#')[0]
          if (!link || /^(?:[a-z][\w+.-]*:|\/)/i.test(link)) continue
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(link)))
          if (!snap.files.has(target) && ![...snap.files.keys()].some(f => f.startsWith(target.replace(/\/$/, '') + '/'))) errors.push({ code: 'broken_link', file, target })
        }
      }
    }
    if (!config) {
      warnings.push('Legacy KB: install the maintenance checks and record reviewed scopes before enabling strict CI')
      if (strict) errors.push({ code: 'maintenance_not_enabled' })
      return { passed: !errors.length, enabled: false, errors, warnings, pending }
    }
    const states = readStates(snap)
    const changed = new Set()
    let previous = null
    if (base) {
      previous = snapshot(root, base)
      for (const file of new Set([...previous.files.keys(), ...snap.files.keys()])) if (previous.oid(file) !== snap.oid(file)) changed.add(file)
      // Removing scope/config/state must not silently remove its review obligation.
      const old = inventory(previous)
      for (const [scope, item] of old?.scopes || []) {
        if (!inv.scopes.has(scope) && [...item.sources, ...item.documents].some(f => changed.has(f))) pending.push({ scope, reason: 'retired_scope', files: [...item.sources, ...item.documents].filter(f => changed.has(f)) })
      }
    }
    for (const [scope, item] of inv.scopes) {
      const state = states.get(scope)
      const owned = [...item.sources, ...item.documents]
      const affected = !base || owned.some(f => changed.has(f)) || changed.has(statePath(scope)) || changed.has(KB_DIR + '/meta.yaml') || changed.has(KB_DIR + '/.profile.yaml')
      if (!state) {
        if (affected && owned.length) pending.push({ scope, reason: 'not_reviewed', files: owned })
        continue
      }
      const mismatched = new Set()
      if (state.context !== item.context) mismatched.add(KB_DIR + '/meta.yaml')
      for (const f of item.sources) if (state.sources[f] !== snap.oid(f)) mismatched.add(f)
      for (const f of item.documents) if (state.documents[f] !== snap.oid(f)) mismatched.add(f)
      for (const [f, oid] of [...Object.entries(state.sources), ...Object.entries(state.documents)]) if (oid !== snap.oid(f)) mismatched.add(f)
      if (mismatched.size) pending.push({ scope, reason: 'evidence_changed', files: [...mismatched] })
      if (state.status === 'deferred') {
        warnings.push(scope + ': deferred — ' + state.reason)
        if (strict && !config.allow_deferred) errors.push({ code: 'deferred_not_allowed', scope })
      }
    }
    for (const [scope] of states) if (!inv.scopes.has(scope)) pending.push({ scope, reason: 'unknown_scope', files: [statePath(scope)] })
    if (strict) errors.push(...pending.map(p => ({ code: 'knowledge_review_required', ...p })))
    else if (pending.length) warnings.push('Knowledge review required before merge; intermediate commits remain allowed')
    return { passed: !errors.length, enabled: true, errors, warnings, pending }
  } catch (e) {
    return { passed: false, enabled: false, errors: [...errors, { code: 'verification_failed', message: e.message }], warnings, pending }
  }
}

function atomicWrite (root, file, data) {
  safePath(file)
  const abs = path.join(root, file)
  // Reject symlinked parents before creating or replacing tracked knowledge.
  let cursor = root
  for (const part of file.split('/')) {
    cursor = path.join(cursor, part)
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing symlink: ' + cursor)
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = abs + '.tmp-' + crypto.randomBytes(6).toString('hex')
  try { fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, abs) } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}

// This records a human/agent review decision; it does not infer semantic truth.
// Caller reviews the returned diff/plan BEFORE invoking record.
function record (root, options) {
  const lock = path.resolve(root, git(root, ['rev-parse', '--git-path', 'fsflow-kb-maintenance.lock']).trim())
  const fd = fs.openSync(lock, 'wx')
  try { return recordUnlocked(root, options) } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

function recordUnlocked (root, { scope, status, reason, specReview, sources = [] }) {
  if (!scope || !['updated', 'unchanged', 'deferred'].includes(status) || !reason?.trim() || !['aligned', 'approved', 'deferred'].includes(specReview)) throw new Error('record requires scope, status, reason and spec-review')
  if (status !== 'deferred' && specReview === 'deferred') throw new Error('Unresolved spec decisions must remain deferred')
  const snap = snapshot(root), inv = inventory(snap), config = readConfig(snap)
  if (!inv || !config) throw new Error('Initialize the KB and install maintenance support first')
  const item = inv.scopes.get(scope)
  if (!item) throw new Error('Unknown scope: ' + scope)
  const old = readStates(snap).get(scope)
  const sourcePaths = new Set([...item.sources, ...Object.keys(old?.sources || {}), ...sources.map(safePath)])
  for (const f of sources) if (!sourceFile(f) || !snap.files.has(f)) throw new Error('Extra source must be an existing repository file: ' + f)
  const documentPaths = new Set([...item.documents, ...Object.keys(old?.documents || {})])
  if (status === 'updated' && !item.documents.size) throw new Error('updated requires a knowledge document; use unchanged with an explanation if no document is needed')
  const values = paths => Object.fromEntries([...paths].sort().map(f => [f, snap.oid(f)]))
  const state = { version: 1, scope, status, reason: reason.trim(), spec_review: specReview, context: item.context, sources: values(sourcePaths), documents: values(documentPaths) }
  const latest = snapshot(root)
  if (inventory(latest)?.scopes.get(scope)?.context !== item.context || [...sourcePaths, ...documentPaths].some(f => snap.oid(f) !== latest.oid(f))) throw new Error('Source or knowledge changed during review recording; retry after verification')
  const file = statePath(scope)
  const eventId = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')
  const event = { version: 1, scope, status, reason: state.reason, spec_review: specReview, receipt_digest: eventId, documents: [...item.documents].sort() }
  atomicWrite(root, KB_DIR + '/changelog/' + eventId + '.json', JSON.stringify(event, null, 2) + '\n')
  atomicWrite(root, file, JSON.stringify(state, null, 2) + '\n')
  return { file, state }
}

module.exports = { CONFIG, STATES, git, snapshot, inventory, readStates, readConfig, check, record, atomicWrite, sourceFile, documentFile }
