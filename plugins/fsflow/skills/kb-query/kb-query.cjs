#!/usr/bin/env node
// Bounded lookup output; the full index stays on disk, outside the AI context.
const fs = require('fs')
const path = require('path')
const { KB_DIR, readMeta, readProfile, git, matchesSource } = require('../../scripts/lib/kb.cjs')
try {
  const args = process.argv.slice(2)
  const query = args[0]
  const limit = args.length === 1 ? 10 : args[1] === '--limit' && args.length === 3 ? Number(args[2]) : NaN
  if (!query || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Usage: kb-query.cjs <query> [--limit 1..50]')
  const root = process.cwd()
  const meta = readMeta(root), profile = readProfile(root)
  const backend = profile.project_type === 'backend'
  const indexPath = path.join(root, KB_DIR, backend ? 'backend-index.json' : 'frontend-index.json')
  let files
  if (fs.existsSync(indexPath)) files = JSON.parse(fs.readFileSync(indexPath, 'utf8')).files
  else files = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(f => f && !f.startsWith(KB_DIR + '/')).map(file => ({ path: file }))
  const needle = query.toLowerCase()
  const hits = files.filter(f => [f.path, ...(f.symbols || []).flatMap(s => [s.name, s.qualified_name]), ...(f.entries || []).map(e => e.declaration)].some(s => s?.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.path === query) - Number(a.path === query) || a.path.localeCompare(b.path))
  console.log(JSON.stringify({ query, total: hits.length, truncated: hits.length > limit,
    matches: hits.slice(0, limit).map(f => {
      const domains = f.domains || (f.domain ? [f.domain] : meta.domains.filter(d => d.files.some(p => matchesSource(f.path, p, profile.source_root || 'src'))).map(d => d.id))
      const abs = path.join(root, f.path), exists = fs.existsSync(abs)
      const stat = exists ? fs.statSync(abs) : null
      const changed = f.stamp ? !stat || JSON.stringify(f.stamp) !== JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]) : null
      return { path: f.path, domains, exists, sourceChangedSinceScan: changed,
        documents: domains.map(id => path.posix.join(meta.domains.find(d => d.id === id)?.path || `business/${id}/`, 'overview.md')),
        entries: (f.entries || []).filter(e => e.declaration?.toLowerCase().includes(needle)).slice(0, 5),
        symbols: (f.symbols || []).filter(s => s.name.toLowerCase().includes(needle)).slice(0, 5) }
    }) }, null, 2))
} catch (e) { console.log(JSON.stringify({ errors: [e.message] })); process.exitCode = 1 }
