const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { KB_DIR, git, matchesSource } = require('./kb.cjs')
const INDEX_PATH = KB_DIR + '/frontend-index.json'
const SOURCE = /\.(?:vue|[cm]?[jt]sx?|svelte)$/
const hash = text => crypto.createHash('sha256').update(text).digest('hex')

// Lightweight import index, including shared API/store/component ownership.
// Aliases other than @/ and ~/ remain explicit review items, never guessed.
function buildFrontendIndex (root, meta, profile, { persist = false } = {}) {
  const sourceRoot = profile.source_root || 'src'
  const roots = profile.source_roots || [sourceRoot]
  const key = hash(JSON.stringify({ version: 1, roots, domains: meta.domains.map(d => [d.id, d.files]) }))
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(path.join(root, INDEX_PATH), 'utf8')) } catch (_) {}
  const cache = new Map((previous?.cache_key === key ? previous.files : []).map(f => [f.path, f]))
  const candidates = [...new Set(git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0'))]
    .filter(f => SOURCE.test(f) && !f.startsWith(KB_DIR + '/') &&
      (roots.some(r => r === '.' || f.startsWith(r.replace(/\/$/, '') + '/')) || meta.domains.some(d => d.files.some(p => matchesSource(f, p, sourceRoot)))))
  const files = []
  let packages = new Set()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    packages = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }))
  } catch (_) {}
  const stats = { read: 0, parsed: 0, reused: 0 }
  for (const file of candidates) {
    const abs = path.join(root, file)
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) continue
    const s = fs.statSync(abs)
    const stamp = [s.size, s.mtimeMs, s.ctimeMs, s.ino]
    const old = cache.get(file)
    let sha256, imports
    if (old && JSON.stringify(old.stamp) === JSON.stringify(stamp)) {
      ;({ sha256, imports } = old)
      stats.reused++
    } else {
      const text = fs.readFileSync(abs, 'utf8')
      sha256 = hash(text)
      stats.read++
      if (old?.sha256 === sha256) { imports = old.imports; stats.reused++ } else {
        const clean = text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, '')
        imports = [...new Set([...clean.matchAll(/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)["']([^"']+)["']/g)].map(m => m[1]))]
        stats.parsed++
      }
    }
    files.push({ path: file, stamp, sha256, imports, dependencies: [], domains: meta.domains.filter(d => d.files.some(p => matchesSource(file, p, sourceRoot))).map(d => d.id), unresolvedImports: [] })
  }
  const byPath = new Map(files.map(f => [f.path, f]))
  for (const f of files) for (const specifier of f.imports) {
    const spec = specifier.replace(/[?#].*$/, '')
    let base
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), spec))
    else if (/^[@~]\//.test(spec)) base = path.posix.join(sourceRoot, spec.slice(2))
    else {
      const packageName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!specifier.startsWith('node:') && !packages.has(packageName)) f.unresolvedImports.push(specifier)
      continue
    }
    const choices = [base, ...['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.mjs', '.cjs'].flatMap(ext => [base + ext, base + '/index' + ext])]
    const target = choices.find(p => byPath.has(p))
    if (target) f.dependencies.push(target)
    else if (!fs.existsSync(path.join(root, base))) f.unresolvedImports.push(specifier)
  }
  // A shared file belongs to every known business consumer, through imports.
  const queue = files.filter(f => f.domains.length).map(f => f.path)
  for (let i = 0; i < queue.length; i++) {
    const f = byPath.get(queue[i])
    for (const dep of f.dependencies) {
      const target = byPath.get(dep)
      const domains = [...new Set([...target.domains, ...f.domains])]
      if (domains.length !== target.domains.length) { target.domains = domains; queue.push(dep) }
    }
  }
  const documentFiles = previous?.document_hash === meta.git.hash
    ? previous.document_files || [] : files.map(f => ({ path: f.path, domains: f.domains }))
  const index = { version: 1, cache_key: key, scan_stats: stats, document_hash: meta.git.hash, document_files: documentFiles, files }
  if (persist) {
    fs.mkdirSync(path.join(root, KB_DIR), { recursive: true })
    fs.writeFileSync(path.join(root, INDEX_PATH), JSON.stringify(index, null, 2) + '\n')
  }
  return { previous, current: index }
}

function frontendImpact (root, meta, profile, changed, options) {
  const { previous, current } = buildFrontendIndex(root, meta, profile, options)
  const records = [...(previous?.files || []), ...current.document_files, ...current.files]
  const sourceRoot = profile.source_root || 'src'
  const affectedDomains = meta.domains.map(d => ({ id: d.id, path: d.path,
    matchedFiles: changed.filter(file => d.files.some(p => matchesSource(file, p, sourceRoot)) || records.some(f => f.path === file && f.domains.includes(d.id)))
  })).filter(d => d.matchedFiles.length)
  const assigned = new Set(affectedDomains.flatMap(d => d.matchedFiles))
  return { affectedDomains, unclassifiedFiles: changed.filter(f => !assigned.has(f)),
    reviewFiles: current.files.filter(f => changed.includes(f.path) && f.unresolvedImports.length)
      .map(f => ({ path: f.path, unresolvedImports: f.unresolvedImports })), scanStats: current.scan_stats }
}

module.exports = { buildFrontendIndex, frontendImpact, INDEX_PATH }
