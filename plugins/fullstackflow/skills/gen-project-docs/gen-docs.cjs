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

if (mode === 'stale') {
  try {
    const cur = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 }).trim()
    const diff = execSync(`git diff --name-only ${meta.git.hash || cur}..${cur}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim()
    const changed = diff ? diff.split('\n').filter(Boolean).length : 0
    console.log(JSON.stringify({ mode: 'stale', stale: changed > 0, changedCount: changed }))
  } catch (e) { console.log(JSON.stringify({ mode: 'stale', stale: false })) }
  process.exit(0)
}

const domains = mode === 'single' ? meta.domains.filter(d => d.id === targetId) : meta.domains
const result = { mode, domains: [] }

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
  result.domains.push({ id: domain.id, path: domain.path, files, hasCustom })
}

/**
 * 展开文件路径（支持通配符 *）
 * @param {string} pattern - 文件路径模式（可含 * 通配符）
 * @returns {string[]} 匹配到的绝对路径列表
 */
function expandGlob (pattern) {
  // 先尝试相对 PROJECT_ROOT 的绝对路径
  const abs = path.isAbsolute(pattern) ? pattern : path.join(PROJECT_ROOT, pattern)
  if (!pattern.includes('*')) {
    return fs.existsSync(abs) ? [abs] : []
  }
  // 含通配符：拆目录 + 文件名模式，扫描匹配
  const dir = path.dirname(abs)
  const base = path.basename(abs)
  const regex = new RegExp('^' + base.replace(/\*/g, '.*') + '$')
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(f => regex.test(f))
      .map(f => path.join(dir, f))
  } catch (e) { return [] }
}

console.log(JSON.stringify(result, null, 2))
