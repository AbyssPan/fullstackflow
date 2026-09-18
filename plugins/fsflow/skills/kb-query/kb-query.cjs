#!/usr/bin/env node
// Bounded lookup output; the full index stays on disk, outside the AI context.
const fs = require('fs')
const path = require('path')
const { KB_DIR, readMeta, readProfile, git, matchesSource } = require('../../scripts/lib/kb.cjs')
try {
  const args = process.argv.slice(2)
  const query = args[0]?.trim()
  const limit = args.length === 1 ? 10 : args[1] === '--limit' && args.length === 3 ? Number(args[2]) : NaN
  if (!query || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Usage: kb-query.cjs <query> [--limit 1..50]')
  const root = process.cwd()
  const warnings = []
  // Metadata improves ownership lookup but must not prevent read-only source discovery.
  let meta = { domains: [] }, profile = {}
  try { meta = readMeta(root) } catch (e) { warnings.push('KB metadata unavailable: ' + e.message) }
  try { profile = readProfile(root) } catch (e) { warnings.push('KB profile unavailable: ' + e.message) }
  const backend = profile.project_type === 'backend'
  const indexPath = path.join(root, KB_DIR, backend ? 'backend-index.json' : 'frontend-index.json')
  let files = [], hasIndex = false
  if (fs.existsSync(indexPath)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (!Array.isArray(index.files) || index.files.some(f => !f || typeof f.path !== 'string')) throw new Error('Expected files[] with paths')
      if (fs.existsSync(path.join(root, KB_DIR, 'maintenance.json')) && index.git_hash !== git(root, ['rev-parse', 'HEAD']).trim()) {
        throw new Error('Index belongs to an unverified revision; use current Git paths and source search')
      }
      files = index.files
      hasIndex = true
    } catch (e) { warnings.push('KB index unavailable: ' + e.message) }
  }
  // Union with Git paths on every lookup: a cached index omits files added after its scan.
  // This only lists files; it neither parses source nor refreshes the persisted index.
  try {
    const known = new Set(files.map(f => f.path))
    for (const file of git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0')) {
      if (file && !file.startsWith(KB_DIR + '/') && !known.has(file)) {
        files.push({ path: file }); known.add(file)
      }
    }
  } catch (e) {
    if (!hasIndex) throw new Error('No usable KB index or Git file list: ' + e.message)
    warnings.push('Git file list unavailable; new files may be missing: ' + e.message)
  }
  const needle = query.toLowerCase()
  const matches = value => typeof value === 'string' && value.toLowerCase().includes(needle)
  const symbolMatches = s => s && (matches(s.name) || matches(s.qualified_name))
  const symbols = f => Array.isArray(f.symbols) ? f.symbols : []
  const entries = f => Array.isArray(f.entries) ? f.entries : []
  const hits = files.filter(f => matches(f.path) || symbols(f).some(symbolMatches) || entries(f).some(e => matches(e?.declaration)))
    .sort((a, b) => Number(b.path === query) - Number(a.path === query) || a.path.localeCompare(b.path))
  console.log(JSON.stringify({ query, total: hits.length, truncated: hits.length > limit, warnings,
    matches: hits.slice(0, limit).map(f => {
      const domains = f.domains || (f.domain ? [f.domain] : meta.domains.filter(d => d.files.some(p => matchesSource(f.path, p, profile.source_root || 'src'))).map(d => d.id))
      const abs = path.join(root, f.path), exists = fs.existsSync(abs)
      const stat = exists ? fs.statSync(abs) : null
      const changed = f.stamp ? !stat || JSON.stringify(f.stamp) !== JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]) : null
      return { path: f.path, domains, exists, sourceChangedSinceScan: changed,
        knowledgeStatus: domains.map(id => {
          const receipt = path.join(root, KB_DIR, 'maintenance', 'domain-' + id + '.json')
          try { const s = JSON.parse(fs.readFileSync(receipt, 'utf8')); return { domain: id, status: s.status, reason: s.reason, freshness: 'verify-sources-before-use' } }
          catch (_) { return { domain: id, status: 'unverified' } }
        }),
        documents: domains.map(id => path.posix.join(meta.domains.find(d => d.id === id)?.path || `business/${id}/`, 'overview.md')),
        entries: entries(f).filter(e => matches(e?.declaration)).slice(0, 5),
        symbols: symbols(f).filter(symbolMatches).slice(0, 5) }
    }) }, null, 2))
} catch (e) { console.log(JSON.stringify({ errors: [e.message] })); process.exitCode = 1 }
