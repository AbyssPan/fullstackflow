#!/usr/bin/env node
/**
 * gen-docs.cjs — 文档生成扫描脚本
 *
 * 自包含于 gen-project-docs Skill。读取 meta.yaml，输出需扫描的文件清单。
 *
 * 用法:
 *   node "<skill_dir>/gen-docs.cjs" [domain_id]   # 单域
 *   node "<skill_dir>/gen-docs.cjs" --all          # 全量
 *   node "<skill_dir>/gen-docs.cjs" --stale        # 新鲜度检测
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PROJECT_ROOT = process.cwd()
// v2：去掉 frontend 硬编码层，知识库根为 .docs/llm-knowledge/
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
const META_PATH = path.join(KB_ROOT, 'meta.yaml')
// v2：源码根从 .profile.yaml 读取（不再写死 src/）
const PROFILE_PATH = path.join(KB_ROOT, '.profile.yaml')

/**
 * 从 .profile.yaml 读取源码根，兜底返回 'src'
 * @returns {string} 相对 PROJECT_ROOT 的源码根
 */
function readSourceRoot () {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      const content = fs.readFileSync(PROFILE_PATH, 'utf-8')
      const m = content.match(/source_root:\s*"([^"]+)"/)
      if (m) return m[1]
    }
  } catch (e) { /* ignore */ }
  return 'src'
}

const SRC_ROOT = path.join(PROJECT_ROOT, readSourceRoot())

function parseMetaYaml(content) {
  const result = { git: {}, domains: [] }
  const hm = content.match(/hash:\s*"([^"]+)"/)
  if (hm) result.git.hash = hm[1]

  // 逐个提取 domain 块（v2：文件字段通用化，不再假设 stores/apis/components）
  const domainRegex = /\n  - id:\s*"([^"]+)"([\s\S]*?)(?=\n  - id:\s*"|\n\S|$)/g
  let match
  while ((match = domainRegex.exec(content)) !== null) {
    const id = match[1]
    const block = match[2]
    const d = { id, path: '', files: [] }
    const pm = block.match(/path:\s*"([^"]+)"/)
    if (pm) d.path = pm[1]

    // 通用：提取所有文件类字段的值（entry_files/stores/apis/components/files/...）
    // 内联数组: field: ["a", "b"]
    const inlineRe = /(\w*(?:files|stores|apis|components|entries))\s*:\s*\[([^\]]*)\]/g
    let im
    while ((im = inlineRe.exec(block)) !== null) {
      d.files.push(...im[2].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean))
    }
    // 多行数组: field:\n  - "a"\n  - "b"
    const mlRe = /(\w*(?:files|stores|apis|components|entries))\s*:\s*\n([\s\S]*?)(?=\n\s{4}\w|\n  -|\n\s*$)/g
    let mm
    while ((mm = mlRe.exec(block)) !== null) {
      const items = mm[2].match(/- "([^"]+)"/g)
      if (items) d.files.push(...items.map(s => s.replace(/-?\s*"([^"]+)"/, '$1')))
    }
    d.files = [...new Set(d.files)]

    if (d.id && d.path) result.domains.push(d)
  }
  return result
}

const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--stale') ? 'stale' : args[0] ? 'single' : 'incremental'
const targetId = mode === 'single' ? args[0] : null

if (!fs.existsSync(META_PATH)) { console.error(JSON.stringify({ error: 'meta.yaml 不存在，请先运行 kb-init' })); process.exit(1) }
const meta = parseMetaYaml(fs.readFileSync(META_PATH, 'utf-8'))
const profileText = fs.existsSync(PROFILE_PATH) ? fs.readFileSync(PROFILE_PATH, 'utf8') : ''
const isBackend = /project_type:\s*["']?backend\b/.test(profileText)
const backend = isBackend && fs.existsSync(path.join(KB_ROOT, 'backend-index.json'))
  ? JSON.parse(fs.readFileSync(path.join(KB_ROOT, 'backend-index.json'), 'utf8')) : null
if (backend) meta.domains = backend.domains

if (mode === 'stale') {
  if (backend) {
    try {
      if (!meta.git.hash) {
        console.log(JSON.stringify({ mode: 'stale', stale: true, changedCount: backend.files.length, reason: 'documents-not-generated' }))
      } else {
        const { buildBackendIndex, changesSinceDocument, backendImpact } = require('../kb-init/backend-index.cjs')
        const current = buildBackendIndex(PROJECT_ROOT, backend.source_roots, backend.resource_roots, backend.modules)
        const pending = changesSinceDocument(PROJECT_ROOT, meta.git.hash)
        const changed = backendImpact(backend, current, pending).changedFiles
        console.log(JSON.stringify({ mode: 'stale', stale: changed.length > 0, changedCount: changed.length }))
      }
    } catch (e) {
      console.log(JSON.stringify({ mode: 'stale', stale: true, reason: 'verification-failed', error: e.message }))
    }
    process.exit(0)
  }
  try {
    const cur = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 }).trim()
    const diff = execSync(`git diff --name-only ${meta.git.hash || cur}..${cur}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim()
    const changed = diff ? diff.split('\n').filter(Boolean).length : 0
    console.log(JSON.stringify({ mode: 'stale', stale: changed > 0, changedCount: changed }))
  } catch (e) { console.log(JSON.stringify({ mode: 'stale', stale: false })) }
  process.exit(0)
}

const domains = mode === 'single' ? meta.domains.filter(d => d.id === targetId) : meta.domains
const result = { mode, domains: [], ...(backend ? { backendIndex: 'backend-index.json', commonFiles: backend.common_files, unclassifiedFiles: backend.unclassified_files, documentation: 'overview-first; expand routes/api/models/flows only when needed' } : {}) }

for (const domain of domains) {
  // v2：文件路径统一解析。meta.yaml 里的文件字段可能是：
  //   - 绝对相对路径（相对 PROJECT_ROOT），如 "plugins/harness/agents/*.md"
  //   - 相对 src 的文件名，如 "pc.request.js"（旧前端约定，靠 src 前缀兜底）
  const files = { all: [] }
  for (const f of (domain.files || [])) {
    // 展开通配符
    const expanded = expandGlob(f)
    for (const fp of expanded) {
      if (fs.existsSync(fp)) files.all.push(fp)
    }
  }
  const customDir = path.join(KB_ROOT, domain.path, 'custom')
  const hasCustom = fs.existsSync(customDir) && fs.readdirSync(customDir).filter(f => f.endsWith('.md')).length > 0
  result.domains.push({ id: domain.id, path: domain.path, files, hasCustom, ...(backend ? { evidence: backend.files.filter(f => f.domain === domain.id).map(f => ({ path: f.path, sha256: f.sha256, entries: f.entries, symbols: f.symbols })) } : {}) })
}

/**
 * 展开文件路径（支持通配符 *）
 * @param {string} pattern - 文件路径模式（可含 * 通配符）
 * @returns {string[]} 匹配到的绝对路径列表
 */
function expandGlob (pattern) {
  // 候选根：先按相对 PROJECT_ROOT 解析；未命中且为裸文件名时，回退到源码根（旧前端约定，如 "pc.request.js" → src/pc.request.js）
  const candidates = []
  const abs = path.isAbsolute(pattern) ? pattern : path.join(PROJECT_ROOT, pattern)
  candidates.push(abs)
  if (!path.isAbsolute(pattern) && !pattern.includes('/') && !pattern.includes('*')) {
    candidates.push(path.join(SRC_ROOT, pattern))
  }
  if (!pattern.includes('*')) {
    return candidates.filter(p => fs.existsSync(p))
  }
  if (pattern.includes('**')) {
    return expandRecursiveGlob(pattern)
  }
  // 含通配符：对每个候选根拆目录 + 文件名模式，扫描匹配
  const results = []
  for (const base of candidates) {
    const dir = path.dirname(base)
    const name = path.basename(base)
    const regex = new RegExp('^' + name.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
    if (!fs.existsSync(dir)) continue
    try {
      results.push(...fs.readdirSync(dir).filter(f => regex.test(f)).map(f => path.join(dir, f)))
    } catch (e) { /* ignore */ }
  }
  return results
}

function expandRecursiveGlob (pattern) {
  const relPattern = path.isAbsolute(pattern)
    ? path.relative(PROJECT_ROOT, pattern).replace(/\\/g, '/')
    : pattern.replace(/\\/g, '/')
  const firstStar = relPattern.indexOf('*')
  const slashBeforeStar = relPattern.lastIndexOf('/', firstStar)
  const baseRel = slashBeforeStar >= 0 ? relPattern.slice(0, slashBeforeStar) : '.'
  const baseAbs = path.join(PROJECT_ROOT, baseRel)
  if (!fs.existsSync(baseAbs)) return []

  const regex = globToRegex(relPattern)
  const results = []
  const visit = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile()) {
        const rel = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/')
        if (regex.test(rel)) results.push(abs)
      }
    }
  }
  visit(baseAbs)
  return results
}

function globToRegex (pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    const next = pattern[i + 1]
    if (ch === '*' && next === '*') {
      const after = pattern[i + 2]
      if (after === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (ch === '*') {
      out += '[^/]*'
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  out += '$'
  return new RegExp(out)
}

console.log(JSON.stringify(result, null, 2))
