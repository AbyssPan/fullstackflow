// Changelog fragments are disposable only after their receipt is superseded
// on an explicit integration baseline. Git receipt history remains authoritative.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const kb = require('./kb-maintenance.cjs')
const { KB_DIR } = require('./kb.cjs')

const CHANGELOG = KB_DIR + '/changelog/'
const digest = state => crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')
const revision = (root, ref) => kb.git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim()
const shallow = root => kb.git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true'
const eventKeys = ['version', 'scope', 'status', 'reason', 'spec_review', 'receipt_digest', 'documents']
const standardEvent = event => event && typeof event === 'object' && !Array.isArray(event) &&
  Object.keys(event).length === eventKeys.length && Object.keys(event).every(key => eventKeys.includes(key)) && event.version === 1 &&
  Array.isArray(event.documents) && event.documents.every(f => typeof f === 'string')
// Receipts intentionally retain formerly owned paths after domain remapping;
// the fragment lists only the documents owned at the time of that review.
const matchesReceipt = (event, state, ownedDocuments) => standardEvent(event) && event.receipt_digest === digest(state) &&
  event.scope === state.scope && event.status === state.status && event.reason === state.reason && event.spec_review === state.spec_review &&
  event.documents.every(f => Object.hasOwn(state.documents, f) && state.documents[f] !== null) &&
  JSON.stringify(event.documents) === JSON.stringify([...new Set(ownedDocuments || event.documents)].sort())
const receiptPath = scope => {
  if (typeof scope !== 'string' || (scope !== 'common' &&
      (!/^domain:[\p{L}\p{N}_.-]+$/u.test(scope) || ['domain:.', 'domain:..'].includes(scope)))) throw new Error('Invalid scope: ' + scope)
  return kb.STATES + scope.replace(/:/g, '-') + '.json'
}

function receiptAt (root, commit, file) {
  const row = kb.git(root, ['ls-tree', '-z', commit, '--', file]).split('\0')[0]
  if (!row) return null
  const [mode, type, oid] = row.slice(0, row.indexOf('\t')).split(' ')
  if (type !== 'blob' || mode === '120000') throw new Error('Invalid historical receipt: ' + file)
  const states = kb.readStates({ files: new Map([[file, {}]]), read: () => kb.git(root, ['cat-file', 'blob', oid]) })
  return [...states.values()][0]
}

// First-parent history describes the states actually integrated on this branch,
// including merge commits and squash merges, rather than unmerged side branches.
function receiptLog (root, ref, file, count) {
  return kb.git(root, ['log', '--first-parent', '--format=%H%x00%cI%x00%s',
    ...(count ? ['-n', String(count)] : []), ref, '--', file]).trim().split('\n').filter(Boolean)
    .map(line => { const [commit, date, subject] = line.split('\0'); return { commit, date, subject } })
}

function history (root, { scope, ref = 'HEAD', limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('history limit must be between 1 and 100')
  const file = receiptPath(scope), commit = revision(root, ref)
  const rows = receiptLog(root, commit, file, limit + 1)
  const entries = rows.slice(0, limit).map(row => {
    const state = receiptAt(root, row.commit, file)
    return { ...row, file, scope, ...(state ? { status: state.status, reason: state.reason,
      spec_review: state.spec_review, receipt_digest: digest(state), documents: Object.keys(state.documents) } : { deleted: true }) }
  })
  const warnings = shallow(root) ? ['Shallow clone: history may be incomplete; fetch full history before pruning.'] : []
  if (!rows.length) warnings.push('No committed receipts found for this scope/ref. Legacy log.md and uncommitted fragments are not included in receipt history.')
  return { ref: commit, scope, entries, truncated: rows.length > limit, warnings }
}

function assertRegularPath (root, file) {
  let cursor = root
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i])
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Refusing unsafe changelog path: ' + file)
  }
}

function plan (root, base) {
  if (!base) throw new Error('prune requires --base with the integration branch or commit')
  if (shallow(root)) throw new Error('Cannot prune a shallow clone; fetch full history first')
  const baseCommit = revision(root, base), head = revision(root, 'HEAD')
  try { kb.git(root, ['merge-base', '--is-ancestor', baseCommit, head]) } catch (_) { throw new Error('Prune baseline must be an ancestor of HEAD; update the maintenance branch first') }
  const snaps = [kb.snapshot(root), kb.snapshot(root, 'staged'), kb.snapshot(root, head), kb.snapshot(root, baseCommit)]
  const states = snaps.map(kb.readStates), inv = kb.inventory(snaps[3])
  if (!inv || !kb.readConfig(snaps[3])) throw new Error('Initialize and commit knowledge maintenance before pruning')
  const referenced = new Set()
  for (const snap of snaps) {
    for (const file of snap.files.keys()) {
      if (!kb.documentFile(file)) continue
      // Conservatively protect mentions by content ID, including reference-style
      // Markdown, HTML, code examples and URL-encoded paths, without resolving links.
      const text = snap.read(file).replace(/(?:%[a-f0-9]{2})+/gi, value => {
        try { return decodeURIComponent(value) } catch (_) { return value }
      })
      for (const match of text.matchAll(/\b([a-f0-9]{64})\b/g)) referenced.add(CHANGELOG + match[1] + '.json')
    }
  }
  const candidates = [], retained = [], histories = new Map()
  for (const file of [...snaps[0].files.keys()].filter(f => f.startsWith(CHANGELOG)).sort()) {
    let event, reason
    try {
      assertRegularPath(root, file)
      const id = file.slice(CHANGELOG.length).match(/^([a-f0-9]{64})\.json$/)?.[1]
      event = JSON.parse(snaps[0].read(file))
      if (!id || !standardEvent(event) || event.receipt_digest !== id ||
          !['updated', 'unchanged', 'deferred'].includes(event.status) || typeof event.reason !== 'string' || !event.reason.trim() ||
          !['aligned', 'approved', 'deferred'].includes(event.spec_review)) throw new Error('Invalid event')
      const stateFile = receiptPath(event.scope)
      const current = states[3].get(event.scope)
      if (snaps.slice(1).some(s => s.oid(file) !== snaps[0].oid(file) || s.files.get(file)?.mode !== snaps[0].files.get(file)?.mode)) reason = 'uncommitted_or_not_on_base'
      else if (referenced.has(file)) reason = 'referenced_by_document'
      else if (!current || !inv.scopes.has(event.scope)) reason = 'unknown_scope'
      else if (states.some(s => !s.has(event.scope) || digest(s.get(event.scope)) !== digest(current)) ||
          snaps.some(s => s.oid(stateFile) !== snaps[3].oid(stateFile))) reason = 'receipt_changed_since_base'
      else if (event.receipt_digest === digest(current)) reason = 'current_receipt'
      else if (event.status === 'deferred' || event.spec_review === 'deferred') reason = 'deferred_requires_explicit_resolution'
      else if (current.status === 'deferred' || current.spec_review === 'deferred') reason = 'current_scope_deferred'
      else {
        const currentFile = CHANGELOG + digest(current) + '.json'
        // Keep an intact current fragment as well as the latest receipt.
        const currentText = snaps[3].read(currentFile)
        if (!currentText || snaps.some(s => s.oid(currentFile) !== snaps[3].oid(currentFile))) reason = 'current_fragment_missing_or_changed'
        else {
          const latest = JSON.parse(currentText)
          if (!matchesReceipt(latest, current, [...inv.scopes.get(event.scope).documents])) throw new Error('Invalid current event')
          if (!histories.has(event.scope)) {
            // Cache failures too: one damaged historical receipt must not trigger
            // a full Git rescan for every fragment in a large directory.
            histories.set(event.scope, null)
            const past = receiptLog(root, baseCommit, stateFile).map(row => receiptAt(root, row.commit, stateFile))
            histories.set(event.scope, { current: past[0] && digest(past[0]),
              previous: new Map(past.slice(1).filter(Boolean).map(state => [digest(state), state])) })
          }
          const past = histories.get(event.scope)
          const previous = past?.previous.get(event.receipt_digest)
          if (!past) reason = 'unverified_history'
          else if (past.current !== digest(current) || !previous) reason = 'supersession_not_proven'
          else if (!matchesReceipt(event, previous)) reason = 'event_receipt_mismatch'
        }
      }
    } catch (_) { reason = 'unverified_record' }
    const item = { file, ...(typeof event?.scope === 'string' ? { scope: event.scope } : {}), reason: reason || 'merged_and_superseded' }
    ;(reason ? retained : candidates).push(item)
  }
  return { base: baseCommit, head, candidates, retained }
}

function prune (root, { base, apply = false } = {}) {
  if (!apply) return { ...plan(root, base), dryRun: true, deleted: [] }
  // Share the record writer lock. Never stage, commit, or modify a receipt.
  const lock = path.resolve(root, kb.git(root, ['rev-parse', '--git-path', 'fsflow-kb-maintenance.lock']).trim())
  const fd = fs.openSync(lock, 'wx')
  try {
    const result = plan(root, base)
    // Recheck the full plan before any deletion, including index, baseline and receipts.
    if (JSON.stringify(plan(root, base)) !== JSON.stringify(result)) throw new Error('Knowledge or Git state changed during pruning; retry')
    for (const { file } of result.candidates) assertRegularPath(root, file)
    const deleted = []
    for (const { file } of result.candidates) { fs.unlinkSync(path.join(root, file)); deleted.push(file) }
    return { ...result, dryRun: false, deleted }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

module.exports = { history, prune }
