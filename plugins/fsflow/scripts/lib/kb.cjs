// Shared KB metadata, paths and Git change collection. Vendored js-yaml 4.1.0
// (MIT, ../vendor/js-yaml.LICENSE) keeps installed plugins dependency-free.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('../vendor/js-yaml.cjs')
const KB_DIR = '.docs/llm-knowledge'

function parseYaml (text) {
  // String scalars preserve numeric-looking revisions and IDs. Merge keys/tags
  // are deliberately not enabled for metadata; duplicate keys are rejected.
  const value = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA })
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('KB YAML must be a mapping')
  return value
}

function relativePath (value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    throw new Error('Expected a project-relative KB path: ' + value)
  }
  return value.replace(/^\.\//, '')
}

function parseMeta (text) {
  const meta = parseYaml(text)
  if (!meta.git || typeof meta.git !== 'object' || Array.isArray(meta.git) ||
      (meta.git.hash != null && typeof meta.git.hash !== 'string')) throw new Error('meta.yaml requires git.hash')
  if (!Array.isArray(meta.domains)) throw new Error('meta.yaml requires domains[]')
  const ids = new Set()
  const domains = meta.domains.map(d => {
    if (!d || typeof d.id !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(d.id) || ['.', '..'].includes(d.id) || ids.has(d.id)) throw new Error('Invalid or duplicate KB domain id')
    ids.add(d.id)
    const files = []
    for (const [key, values] of Object.entries(d)) {
      if (!/^(?:\w*files|stores|apis|components|entries)$/.test(key)) continue
      if (!Array.isArray(values)) throw new Error(`${d.id}.${key} must be an array`)
      files.push(...values.map(relativePath))
    }
    if (d.design_docs != null && !Array.isArray(d.design_docs)) throw new Error(`${d.id}.design_docs must be an array`)
    return { ...d, path: relativePath(d.path), files: [...new Set(files)] }
  })
  return { ...meta, git: { ...meta.git, hash: meta.git.hash || '' }, domains }
}

function readMeta (root) { return parseMeta(fs.readFileSync(path.join(root, KB_DIR, 'meta.yaml'), 'utf8')) }
function readProfile (root) {
  const file = path.join(root, KB_DIR, '.profile.yaml')
  const profile = fs.existsSync(file) ? parseYaml(fs.readFileSync(file, 'utf8')) : {}
  if (profile.source_root) relativePath(profile.source_root)
  for (const key of ['source_roots', 'resource_roots']) {
    if (profile[key] != null) {
      if (!Array.isArray(profile[key])) throw new Error(`${key} must be an array`)
      profile[key].forEach(relativePath)
    }
  }
  return profile
}

function globRegex (pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i++ }
    } else if (pattern[i] === '*') out += '[^/]*'
    else if (pattern[i] === '?') out += '[^/]'
    else out += pattern[i].replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

function matchesSource (file, pattern, sourceRoot = 'src') {
  const patterns = [pattern]
  if (!pattern.includes('/') && !/[?*]/.test(pattern)) patterns.push(path.posix.join(sourceRoot, pattern))
  return patterns.some(p => p.endsWith('/') ? file.startsWith(p) : globRegex(p).test(file))
}

function git (root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
}
function changesSince (root, hash) {
  if (!/^[a-f0-9]{7,64}$/i.test(hash || '')) throw new Error('Invalid document revision')
  const tracked = git(root, ['diff', '--no-renames', '--name-only', '-z', hash, '--']).split('\0')
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
  return [...new Set([...tracked, ...untracked])].filter(f => f &&
    (!f.startsWith(KB_DIR + '/') || f === KB_DIR + '/backend.config.json') && !f.startsWith('.codebuddy/'))
}

module.exports = { KB_DIR, parseYaml, parseMeta, readMeta, readProfile, relativePath, globRegex, matchesSource, git, changesSince }
