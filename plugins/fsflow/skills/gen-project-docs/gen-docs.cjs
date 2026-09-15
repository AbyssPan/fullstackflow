#!/usr/bin/env node
// No arguments: actual incremental source/document plan. --all and <domain>
// explicitly request full source inventories; --stale is read-only.
const fs = require('fs')
const path = require('path')
const { KB_DIR, readMeta, readProfile, globRegex: globToRegex } = require('../../scripts/lib/kb.cjs')
const { documentTargets } = require('../../scripts/lib/kb-doc-plan.cjs')
const { collectUpdate } = require('../kb-update/kb-update.cjs')
const PROJECT_ROOT = process.cwd()
const KB_ROOT = path.join(PROJECT_ROOT, KB_DIR)
let SRC_ROOT
const args = process.argv.slice(2)
const storyId = args[0] === '--story' ? args[1] : null
const mode = args[0] === '--all' ? 'all' : args[0] === '--stale' ? 'stale' : args[0] === '--story' || !args.length ? 'incremental' : 'single'
try {
  if ((args[0] === '--story' ? args.length !== 2 || !storyId : args.length > 1) || (mode === 'single' && args[0].startsWith('-'))) throw new Error('Usage: gen-docs.cjs [--all|--stale|domain_id|--story STORY-ID]')
  const meta = readMeta(PROJECT_ROOT)
  const profile = readProfile(PROJECT_ROOT)
  SRC_ROOT = path.join(PROJECT_ROOT, profile.source_root || 'src')
  const type = profile.project_type || 'frontend'
  if (mode === 'stale' || mode === 'incremental') {
    const plan = collectUpdate(PROJECT_ROOT, { refresh: false, storyId })
    if (plan.errors.length) throw new Error(plan.errors.join('; '))
    if (mode === 'stale') {
      console.log(JSON.stringify({ mode, stale: !meta.git.hash || plan.changedFiles.length > 0 || plan.designDocs.length > 0 || (plan.backend?.retiredDomains.length || 0) > 0,
        changedCount: plan.changedFiles.length, reason: !meta.git.hash ? 'documents-not-generated' : undefined }))
    } else {
      const domains = plan.affectedDomains.map(d => {
        const all = d.matchedFiles.map(f => path.join(PROJECT_ROOT, f)).filter(f => fs.existsSync(f) && fs.statSync(f).isFile())
        return { id: d.id, path: d.path, files: { all: [...new Set(all)] },
          deletedFiles: d.matchedFiles.filter(f => !fs.existsSync(path.join(PROJECT_ROOT, f))),
          documents: documentTargets(PROJECT_ROOT, d, d.matchedFiles, type) }
      })
      console.log(JSON.stringify({ mode, domains, commonFiles: plan.commonFiles,
        commonDocuments: plan.commonFiles.length ? ['common/conventions.md', 'common/config.md'] : [],
        unclassifiedFiles: plan.unclassifiedFiles, reviewFiles: plan.reviewFiles,
        retiredDomains: plan.backend?.retiredDomains || [], designDocs: plan.designDocs,
        lastHash: plan.lastHash, currentHash: plan.currentHash, canAdvanceHash: plan.canAdvanceHash }, null, 2))
    }
  } else {
    const backendFile = path.join(KB_ROOT, 'backend-index.json')
    const backend = type === 'backend' && fs.existsSync(backendFile) ? JSON.parse(fs.readFileSync(backendFile, 'utf8')) : null
    if (backend) meta.domains = backend.domains
    const domains = mode === 'single' ? meta.domains.filter(d => d.id === args[0]) : meta.domains
    if (mode === 'single' && !domains.length) throw new Error('Unknown KB domain: ' + args[0])
    const result = { mode, domains: [], ...(backend ? { backendIndex: 'backend-index.json', commonFiles: backend.common_files, unclassifiedFiles: backend.unclassified_files } : {}) }
    for (const domain of domains) {
      const all = [...new Set(domain.files.flatMap(expandGlob))].filter(f => fs.statSync(f).isFile())
      const customDir = path.join(KB_ROOT, domain.path, 'custom')
      result.domains.push({ id: domain.id, path: domain.path, files: { all },
        hasCustom: fs.existsSync(customDir) && fs.readdirSync(customDir).some(f => f.endsWith('.md')),
        ...(backend ? { evidence: backend.files.filter(f => f.domain === domain.id).map(f => ({ path: f.path, sha256: f.sha256, entries: f.entries, symbols: f.symbols })) } : {}) })
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (e) {
  if (mode === 'stale') console.log(JSON.stringify({ mode, stale: null, reason: 'verification-failed', error: e.message }))
  else { console.log(JSON.stringify({ mode, errors: [e.message], canAdvanceHash: false })); process.exitCode = 1 }
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
