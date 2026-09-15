const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { globRegex, changesSince } = require('../../scripts/lib/kb.cjs')

const ROLES = new Set('controller controllers service services impl mapper mappers dao repository repositories entity entities model models dto vo bo po domain application infrastructure job jobs task tasks scheduler schedulers event events listener listeners'.split(' '))
const COMMON = new Set('common shared util utils config configuration security exception exceptions constant constants base bootstrap support'.split(' '))
const TECHNICAL = new Set('async http cors kafka redis cache cdn cos storage mcp deepseek dify doubao gpt collectors arithmetic assert date nullable'.split(' '))
const NOISE = new Set(['action', 'data', ...ROLES, ...COMMON, ...TECHNICAL])
const SKIP = new Set(['target', 'build', 'generated', 'generated-sources', 'node_modules', 'vendor'])
const SOURCE = /\.(java|kt)$/
const RESOURCE = /\.(xml|ya?ml|properties|sql)$/
const INDEX_PATH = '.docs/llm-knowledge/backend-index.json'
const CONFIG_PATH = '.docs/llm-knowledge/backend.config.json'

function slug (s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function matches (file, patterns) {
  return patterns.some(p => globRegex(p).test(file))
}

function readConfig (root) {
  const file = path.join(root, CONFIG_PATH)
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('backend.config.json: expected a JSON object')
  const validPatterns = values => Array.isArray(values) && values.every(v => typeof v === 'string' && v.length > 0 && !path.isAbsolute(v) && !v.split('/').includes('..') && !v.includes('\\'))
  if (config.auto_discover !== undefined && typeof config.auto_discover !== 'boolean') throw new Error('backend.config.json: auto_discover must be boolean')
  if (config.common !== undefined && !validPatterns(config.common)) throw new Error('backend.config.json: common must contain project-relative globs')
  if (config.domains !== undefined && !Array.isArray(config.domains)) throw new Error('backend.config.json: domains must be an array')
  const ids = new Set()
  for (const d of config.domains || []) {
    if (!d || typeof d.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id) || ids.has(d.id) || !validPatterns(d.include) || !d.include.length) throw new Error('backend.config.json: invalid or duplicate domain / include')
    ids.add(d.id)
  }
  if (config.base_packages !== undefined && (!config.base_packages || Array.isArray(config.base_packages) || typeof config.base_packages !== 'object' || Object.values(config.base_packages).some(v => typeof v !== 'string' || !/^[\w]+(?:\.[\w]+)*$/.test(v)))) throw new Error('backend.config.json: base_packages must map source roots to Java packages')
  return config
}

function walk (root, relRoot, ext) {
  const files = []
  const visit = rel => {
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('Source root escapes project: ' + rel)
    if (!fs.existsSync(abs) || fs.lstatSync(abs).isSymbolicLink()) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const file = path.posix.join(rel, e.name)
      if (e.isDirectory()) visit(file)
      else if (e.isFile() && ext.test(e.name)) files.push(file)
    }
  }
  visit(relRoot)
  return files
}

// Lexical hints deliberately retain source locations, not a claimed Java call graph.
function sourceFacts (text, file, root) {
  const clean = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.startsWith('/') ? m.replace(/[^\n]/g, ' ') : m)
  const packageName = clean.match(/^\s*package\s+([\w.]+)/m)?.[1] || path.posix.dirname(path.posix.relative(root, file)).replace(/\//g, '.')
  const symbols = [...clean.matchAll(/\b(?:class|interface|enum|record|object)\s+(\w+)/g)].map(m => ({ name: m[1], qualified_name: packageName + '.' + m[1], line: clean.slice(0, m.index).split('\n').length }))
  const imports = [...clean.matchAll(/^\s*import\s+(?:static\s+)?([\w.*]+)/gm)].map(m => m[1])
  const entries = [...clean.matchAll(/@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|KafkaListener|RabbitListener|JmsListener|Scheduled|EventListener|Table|TableName)\b(?:\s*\([^)]*\))?/g)].map(m => ({ kind: m[1], declaration: m[0], line: clean.slice(0, m.index).split('\n').length, status: 'lexical_hint' }))
  const code = clean.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ').replace(/^\s*(?:package|import)\s+[^;\n]+;?/gm, '')
  const references = [...new Set(code.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g) || [])]
  return { package: packageName, symbols, imports, entries, references, application: /@SpringBootApplication\b/.test(clean) }
}

function basePackage (files, configured) {
  if (configured) return configured
  const app = files.find(f => f.application)
  if (app) return app.package
  const packages = files.map(f => f.package.split('.'))
  let base = packages[0] || []
  for (const p of packages.slice(1)) base = base.slice(0, base.findIndex((v, i) => p[i] !== v) < 0 ? Math.min(base.length, p.length) : base.findIndex((v, i) => p[i] !== v))
  const role = base.findIndex(p => NOISE.has(p.toLowerCase()))
  if (role >= 0) base = base.slice(0, role)
  // Retain the common application package when it has business-package children.
  const children = packages.map(p => p[base.length]).filter(Boolean)
  if (base.length >= 3 && children.length && children.every(p => NOISE.has(p.toLowerCase())) && !['app', 'demo', 'application'].includes(base.at(-1))) base = base.slice(0, -1)
  return base.join('.')
}

function infer (f, base) {
  if (f.application) return { category: 'common', reason: 'application-entry' }
  const parts = (f.package === base ? '' : f.package.startsWith(base + '.') ? f.package.slice(base.length + 1) : '').split('.').filter(Boolean)
  const first = parts[0]?.toLowerCase()
  if (COMMON.has(first) || TECHNICAL.has(first) || first === 'infrastructure') return { category: 'common', reason: 'technical-package' }
  const business = parts.find(p => !NOISE.has(p.toLowerCase()))
  if (business && slug(business)) return { category: 'business', candidate: slug(business), reason: 'business-package' }
  const name = path.posix.basename(f.path).replace(SOURCE, '')
  // In layer-only layouts, only a recognizable business entry can seed a domain.
  const stem = name.replace(/(?:Controller|Resource|Endpoint|ServiceImpl|Service|Mapper|Repository|Entity|DTO|Dto|VO|Vo|Request|Response|Listener|Job|Task)$/, '')
  const candidate = slug(stem.match(/^[A-Z]?[a-z0-9]+|^[A-Z]+(?=[A-Z][a-z]|$)/)?.[0] || '')
  if (candidate && !NOISE.has(candidate) && stem !== name) return { category: 'unclassified', candidate, seed: /(?:Controller|Endpoint|Resource)$/.test(name), reason: 'class-name-candidate' }
  return { category: 'unclassified', reason: 'insufficient-evidence' }
}

function buildBackendIndex (root, sourceRoots, resourceRoots, modules, options = {}) {
  const config = readConfig(root)
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ version: 2, config, sourceRoots, resourceRoots, modules })).digest('hex')
  let previous = options.previous
  if (!previous) { try { previous = readBackendIndex(root) } catch (_) { /* Rebuild a damaged scan cache. */ } }
  const cached = new Map((previous?.cache_key === cacheKey ? previous.files : []).map(f => [f.path, f]))
  const scanStats = { reused: 0, read: 0, parsed: 0 }
  const factsFor = (file, sourceRoot, kind) => {
    const abs = path.join(root, file)
    const stat = fs.statSync(abs)
    const stamp = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]
    const old = cached.get(file)
    if (old?.facts && JSON.stringify(old.stamp) === JSON.stringify(stamp)) {
      scanStats.reused++
      return { sha256: old.sha256, stamp, facts: old.facts }
    }
    const text = fs.readFileSync(abs, 'utf8')
    scanStats.read++
    const sha256 = crypto.createHash('sha256').update(text).digest('hex')
    if (old?.facts && old.sha256 === sha256) {
      scanStats.reused++
      return { sha256, stamp, facts: old.facts }
    }
    scanStats.parsed++
    const facts = kind === 'source' ? sourceFacts(text, file, sourceRoot) : {
      namespace: text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/)?.[1]
    }
    return { sha256, stamp, facts }
  }
  const records = []
  const moduleFor = file => [...modules].sort((a, b) => b.length - a.length).find(m => file.startsWith(m + '/')) || '.'
  for (const sourceRoot of sourceRoots) {
    for (const file of walk(root, sourceRoot, SOURCE)) {
      const cachedFacts = factsFor(file, sourceRoot, 'source')
      records.push({ path: file, source_root: sourceRoot, module: moduleFor(file), kind: 'source', ...cachedFacts, ...cachedFacts.facts })
    }
  }
  const bases = Object.fromEntries(sourceRoots.map(r => [r, basePackage(records.filter(f => f.source_root === r), config.base_packages?.[r])]))
  const explicit = f => {
    const hits = (config.domains || []).filter(d => matches(f.path, d.include))
    if (hits.length > 1) throw new Error('Conflicting domain rules for ' + f.path)
    if (hits.length) return { category: 'business', domain: hits[0].id, reason: 'explicit-config' }
    if (matches(f.path, config.common || [])) return { category: 'common', reason: 'explicit-common' }
    return null
  }
  for (const f of records) Object.assign(f, explicit(f) || (config.auto_discover === false ? { category: 'unclassified', reason: 'auto-discovery-disabled' } : infer(f, bases[f.source_root])))
  const seeds = new Set(records.filter(f => !f.domain && (f.seed || f.category === 'business')).map(f => f.module + ':' + f.candidate))
  for (const f of records) {
    if (f.candidate && seeds.has(f.module + ':' + f.candidate) && f.reason === 'class-name-candidate') { f.category = 'business'; f.reason = 'entry-backed-name' }
  }
  const owners = new Map()
  for (const f of records.filter(f => f.category === 'business' && !f.domain)) {
    if (!owners.has(f.candidate)) owners.set(f.candidate, new Set())
    owners.get(f.candidate).add(f.module)
  }
  const usedIds = new Set((config.domains || []).map(d => d.id))
  const autoIds = new Map()
  for (const f of records.filter(f => f.category === 'business' && !f.domain)) {
    const key = f.module + ':' + f.candidate
    if (!autoIds.has(key)) {
      const preferred = owners.get(f.candidate).size > 1 || usedIds.has(f.candidate) ? `${f.module === '.' ? 'root' : slug(f.module)}-${f.candidate}` : f.candidate
      let id = preferred
      for (let n = 2; usedIds.has(id); n++) id = preferred + '-' + n
      usedIds.add(id)
      autoIds.set(key, id)
    }
    f.domain = autoIds.get(key)
  }
  for (const resourceRoot of resourceRoots) {
    for (const file of walk(root, resourceRoot, RESOURCE)) {
      const cachedFacts = factsFor(file, resourceRoot, 'resource')
      const f = { path: file, module: moduleFor(file), kind: 'resource', ...cachedFacts, symbols: [], imports: [], entries: [] }
      const namespace = cachedFacts.facts.namespace
      const segments = path.posix.relative(resourceRoot, file).split('/').slice(0, -1)
      const candidates = records.filter(s => s.domain && s.module === f.module && (namespace ? s.symbols.some(sym => sym.qualified_name === namespace) : segments.includes(s.candidate)))
      const domains = [...new Set(candidates.map(s => s.domain))]
      Object.assign(f, explicit(f) || (domains.length === 1 ? { category: 'business', domain: domains[0], reason: namespace ? 'mapper-namespace' : 'resource-directory' } : { category: /(?:^|\/)(?:application|bootstrap)(?:-[\w-]+)?\.(?:ya?ml|properties)$/.test(file) ? 'common' : 'unclassified', reason: 'resource-without-owner' }))
      records.push(f)
    }
  }
  const symbolFiles = new Map()
  const packageFiles = new Map()
  for (const f of records) {
    if (!packageFiles.has(f.package)) packageFiles.set(f.package, [])
    packageFiles.get(f.package).push(f)
  }
  for (const f of records) for (const s of f.symbols) {
    if (!symbolFiles.has(s.qualified_name)) symbolFiles.set(s.qualified_name, [])
    symbolFiles.get(s.qualified_name).push(f)
  }
  for (const f of records) {
    const dependencies = new Set()
    const refs = new Set((f.references || []).flatMap(ref => [ref, ref.split('.')[0]]))
    const uncertain = []
    for (const imp of f.imports) {
      const direct = symbolFiles.get(imp) || symbolFiles.get(imp.slice(0, imp.lastIndexOf('.')))
      const targets = direct || (imp.endsWith('.*') ? [...(packageFiles.get(imp.slice(0, -2)) || []), ...(symbolFiles.get(imp.slice(0, -2)) || [])] : [])
      for (const target of targets) {
        if (target.path !== f.path && (!imp.endsWith('.*') || target.symbols.some(s => refs.has(s.name)))) dependencies.add(target.path)
      }
      if (imp.endsWith('.*')) uncertain.push('wildcard-import:' + imp)
    }
    // Same-package types need no import. Only link identifiers used in code,
    // never all package siblings (which creates N*(N-1) edges).
    for (const ref of refs) for (const sibling of symbolFiles.get(`${f.package}.${ref}`) || []) {
      if (f.package && sibling.module === f.module && sibling.path !== f.path) dependencies.add(sibling.path)
    }
    for (const ref of f.references || []) {
      const parts = ref.split('.')
      while (parts.length > 1) {
        for (const target of symbolFiles.get(parts.join('.')) || []) if (target.path !== f.path) dependencies.add(target.path)
        parts.pop()
      }
    }
    if (f.path.endsWith('.kt')) uncertain.push('kotlin-top-level-and-extension-calls')
    f.dependencies = [...dependencies].sort()
    f.dependency_review = uncertain
    delete f.application
    delete f.seed
  }
  const domainIds = [...new Set(records.map(f => f.domain).filter(Boolean))].sort()
  let gitHash = ''
  try { gitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (e) { /* Uncommitted projects have no HEAD. */ }
  return { version: 2, cache_key: cacheKey, scan_stats: scanStats, project_type: 'backend', generated_at: new Date().toISOString(), git_hash: gitHash, source_roots: sourceRoots, resource_roots: resourceRoots, modules, base_packages: bases, analysis: 'lexical-hints; referenced same-package types and imports, not a complete call graph; dependency_review requires source verification', domains: domainIds.map(id => ({ id, path: `business/${id}/`, files: records.filter(f => f.domain === id).map(f => f.path) })), files: records, common_files: records.filter(f => f.category === 'common').map(f => f.path), unclassified_files: records.filter(f => f.category === 'unclassified').map(f => f.path) }
}

function readBackendIndex (root) {
  const file = path.join(root, INDEX_PATH)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

function refreshBackendIndex (root) {
  execFileSync(process.execPath, [path.join(__dirname, 'kb-init.cjs'), '--project-type', 'backend', '--index-only'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 })
  return readBackendIndex(root)
}

function changesSinceDocument (root, hash) {
  return changesSince(root, hash)
}

function backendImpact (previous, current, changedFiles) {
  const before = new Map(previous.files.map(f => [f.path, f]))
  const after = new Map(current.files.map(f => [f.path, f]))
  const changed = new Set(changedFiles)
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(file), b = after.get(file)
    if (a?.sha256 !== b?.sha256 || a?.domain !== b?.domain || a?.category !== b?.category) changed.add(file)
  }
  const records = [...previous.files, ...current.files]
  const reverse = new Map()
  for (const f of records) for (const dep of f.dependencies || []) {
    if (!reverse.has(dep)) reverse.set(dep, new Set())
    reverse.get(dep).add(f.path)
  }
  const impacted = new Set(changed)
  const queue = [...changed]
  for (let i = 0; i < queue.length; i++) for (const file of reverse.get(queue[i]) || []) {
    if (!impacted.has(file)) { impacted.add(file); queue.push(file) }
  }
  const common = [...changed].filter(p => [before.get(p), after.get(p)].some(f => f?.category === 'common'))
  const globalConfig = common.some(p => [before.get(p), after.get(p)].some(f => f?.kind === 'resource')) || [...changed].some(p => p === CONFIG_PATH || /(?:^|\/)pom\.xml$|(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$/.test(p))
  const ids = new Set(records.filter(f => f.domain && (globalConfig || impacted.has(f.path))).map(f => f.domain))
  return {
    changedFiles: [...changed].sort(),
    affectedDomains: [...ids].sort().map(id => ({ id, path: `business/${id}/`, matchedFiles: [...new Set(records.filter(f => f.domain === id && (globalConfig || impacted.has(f.path))).map(f => f.path))], reason: globalConfig ? 'shared-config-review' : 'source-or-dependency' })),
    commonFiles: common,
    unclassifiedFiles: current.unclassified_files.filter(p => changed.has(p)),
    reviewFiles: current.files.filter(f => f.dependency_review?.length && (impacted.has(f.path) || f.imports?.some(imp => imp.endsWith('.*') && records.some(r => changed.has(r.path) && r.package === imp.slice(0, -2)))))
      .map(f => ({ path: f.path, reasons: f.dependency_review })),
    retiredDomains: previous.domains.filter(d => !current.domains.some(n => n.id === d.id)).map(d => d.id)
  }
}

module.exports = { buildBackendIndex, readBackendIndex, refreshBackendIndex, changesSinceDocument, backendImpact, INDEX_PATH, CONFIG_PATH }
