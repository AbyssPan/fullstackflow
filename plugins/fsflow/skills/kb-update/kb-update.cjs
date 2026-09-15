#!/usr/bin/env node
// Collect a bounded update plan. Only index refreshes write files; documents and
// their synchronized revision are changed by the skill after user confirmation.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { KB_DIR, readMeta, readProfile, relativePath, matchesSource, changesSince, git } = require('../../scripts/lib/kb.cjs')

function collectUpdate (root, { refresh = true, storyId = null } = {}) {
  const meta = readMeta(root)
  const profile = readProfile(root)
  const errors = []
  const currentHash = git(root, ['rev-parse', 'HEAD']).trim()
  const lastHash = meta.git.hash
  let changedFiles
  try {
    changedFiles = lastHash ? changesSince(root, lastHash)
      : git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(f => f && !f.startsWith(KB_DIR + '/') && !f.startsWith('.codebuddy/'))
  } catch (e) {
    errors.push('Cannot verify document baseline; fallback is incomplete: ' + e.message)
    try { changedFiles = changesSince(root, git(root, ['rev-parse', 'HEAD~1']).trim()) } catch (_) { changedFiles = [] }
  }
  changedFiles = [...new Set(changedFiles)]
  let affectedDomains = meta.domains.map(d => ({ id: d.id, path: d.path,
    matchedFiles: changedFiles.filter(f => d.files.some(p => matchesSource(f, p, profile.source_root || 'src')))
  })).filter(d => d.matchedFiles.length)
  let backend = null, frontend = null
  const backendFile = path.join(root, KB_DIR, 'backend-index.json')
  if (profile.project_type === 'backend' && fs.existsSync(backendFile)) {
    try {
      const { readBackendIndex, refreshBackendIndex, buildBackendIndex, backendImpact } = require('../kb-init/backend-index.cjs')
      const previous = readBackendIndex(root)
      const current = refresh ? refreshBackendIndex(root)
        : buildBackendIndex(root, previous.source_roots, previous.resource_roots, previous.modules, { previous })
      backend = backendImpact(previous, current, changedFiles)
      // Keep deleted files discoverable on retries after refreshing the scan index.
      for (const d of affectedDomains) {
        const existing = backend.affectedDomains.find(n => n.id === d.id)
        if (existing) existing.matchedFiles = [...new Set([...existing.matchedFiles, ...d.matchedFiles])]
        else backend.affectedDomains.push(d)
      }
      backend.retiredDomains = [...new Set([...backend.retiredDomains, ...meta.domains.filter(d => !current.domains.some(n => n.id === d.id)).map(d => d.id)])]
      backend.scanStats = current.scan_stats
      changedFiles = backend.changedFiles
      affectedDomains = backend.affectedDomains
    } catch (e) { errors.push('backend index refresh failed: ' + e.message) }
  } else if (profile.project_type === 'frontend') {
    try {
      frontend = require('../../scripts/lib/frontend-index.cjs').frontendImpact(root, meta, profile, changedFiles, { persist: refresh })
      affectedDomains = frontend.affectedDomains
    } catch (e) { errors.push('frontend index refresh failed: ' + e.message) }
  }
  const commonFiles = [...new Set([...(backend?.commonFiles || []), ...changedFiles.filter(f =>
    /(?:^|\/)(?:package\.json|(?:pnpm-lock|yarn\.lock|package-lock)[^/]*|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|(?:vite|webpack|tsconfig|eslint|prettier)[^/]*|\.editorconfig|\.eslintrc[^/]*|\.prettierrc[^/]*)$/.test(f))])]
  const assigned = new Set([...affectedDomains.flatMap(d => d.matchedFiles), ...commonFiles])
  const unclassifiedFiles = changedFiles.filter(f => !assigned.has(f))
  const designDocs = collectDesignDocs(root, meta, affectedDomains, storyId)
  const reviewFiles = backend?.reviewFiles || frontend?.reviewFiles || []
  return { lastHash, currentHash, projectType: profile.project_type || 'frontend', changedFiles, affectedDomains,
    commonFiles, unclassifiedFiles, reviewFiles, designDocs,
    ...(backend ? { backend } : {}), ...(frontend ? { frontend } : {}), errors,
    canAdvanceHash: errors.length === 0 && unclassifiedFiles.length === 0 && reviewFiles.length === 0 && !designDocs.some(d => !d.targetDomain) }
}

function collectDesignDocs (root, meta, affectedDomains, currentStory) {
  const dir = path.join(root, '.codebuddy/plans')
  if (!fs.existsSync(dir)) return []
  const docs = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const storyId = entry.name
    const sourcePath = path.join(dir, storyId, 'prototype-analysis.md')
    if (!fs.existsSync(sourcePath)) continue
    const content = fs.readFileSync(sourcePath, 'utf8')
    const sourceHash = crypto.createHash('sha256').update(content).digest('hex')
    const existingDomain = meta.domains.find(d => d.design_docs?.some(doc => doc.story_id === storyId))
    const existing = existingDomain?.design_docs.find(doc => doc.story_id === storyId)
    let targetDomain = existingDomain?.id || null
    if (!targetDomain) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, storyId, 'e2e-state.json'), 'utf8'))
        if (meta.domains.some(d => d.id === state.domain)) targetDomain = state.domain
      } catch (_) {}
    }
    // Only the explicitly selected Story may use this update's impact as a hint.
    if (!targetDomain && storyId === currentStory && affectedDomains.length === 1) targetDomain = affectedDomains[0].id
    const title = content.match(/^#\s+(.+)/m)?.[1]?.trim() || storyId
    const prototypeUrl = content.match(/prototype_url:\s*(.+)/)?.[1]?.trim() || ''
    const slug = title.replace(/[^\w\u4e00-\u9fff-]/g, '-').replace(/-+/g, '-').toLowerCase()
    const fileName = `${storyId}-${slug}.md`
    const targetPath = existing?.doc_path ? relativePath(existing.doc_path) : targetDomain ? `business/${targetDomain}/design/${fileName}` : null
    const target = targetPath && path.join(root, KB_DIR, targetPath)
    const exists = target && fs.existsSync(target)
    // Acknowledged source hash preserves manual edits in the destination.
    if (exists && existing?.source_hash === sourceHash) continue
    const sameContent = exists && fs.readFileSync(target, 'utf8') === content
    if (sameContent && existing) continue
    docs.push({ storyId, title, prototypeUrl, sourcePath, sourceHash, targetDomain, targetPath,
      targetDir: target && path.dirname(target), fileName: target ? path.basename(target) : fileName,
      action: sameContent ? 'index_only' : 'merge' })
  }
  return docs
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args[0] !== '--story' || !args[1] || args.length !== 2)) throw new Error('Usage: kb-update.cjs [--story STORY-ID]')
    console.log(JSON.stringify(collectUpdate(process.cwd(), { storyId: args[1] }), null, 2))
  } catch (e) {
    console.log(JSON.stringify({ errors: [e.message], canAdvanceHash: false }))
    process.exitCode = 1
  }
}
module.exports = { collectUpdate }
