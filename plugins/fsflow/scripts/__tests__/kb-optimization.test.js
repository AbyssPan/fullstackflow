#!/usr/bin/env node
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync, execFileSync } = require('child_process')
const { parseMeta, matchesSource } = require('../lib/kb.cjs')
const { collectUpdate } = require('../../skills/kb-update/kb-update.cjs')
const { buildBackendIndex, backendImpact } = require('../../skills/kb-init/backend-index.cjs')
const PLUGIN = path.resolve(__dirname, '../..')
let count = 0
function check (name, fn) { fn(); count++; console.log('  OK ' + name) }
function sandbox (fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-optimization-')))
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const run = (skill, args = []) => {
    const entry = skill === 'gen-project-docs' ? 'gen-docs' : skill
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'skills', skill, entry + '.cjs'), ...args], { cwd: root, encoding: 'utf8' })
    return { status: r.status, ...JSON.parse(r.stdout) }
  }
  const meta = (hash, domains) => put('.docs/llm-knowledge/meta.yaml', JSON.stringify({ git: { hash }, domains }))
  try {
    git('init', '-q'); git('config', 'user.name', 'KB Test'); git('config', 'user.email', 'kb@example.invalid')
    fn({ root, put, git, run, meta })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

check('YAML plain/single/double quotes, block lists, comments and scoped hash', () => {
  const m = parseMeta(`doc_stats:\n  hash: wrong\ngit:\n  hash: '0123456' # revision\ndomains:\n  - id: order\n    path: business/order/\n    entry_files:\n      - src/views/order/*.vue\n      - 'src/api/order.ts'\n    description: |\n      Business rules\n`)
  assert.equal(m.git.hash, '0123456'); assert.equal(m.domains[0].files.length, 2)
  assert.equal(parseMeta('git: {}\ndomains:\n  - id: userSettings\n    path: business/userSettings/\n    files: []\n').domains[0].id, 'userSettings')
  assert.throws(() => parseMeta('git: {}\ndomains: [broken'), /./)
  assert.throws(() => parseMeta('git: {}\ndomains: wrong'), /domains/)
  assert.throws(() => parseMeta('git: {}\ngit: {}\ndomains: []'), /duplicated/)
})
check('Exact files, segment-aware globs, directory and legacy bare file paths', () => {
  assert.equal(matchesSource('src/order/Page.vue.bak', 'src/order/Page.vue'), false)
  assert.equal(matchesSource('src/order/notes.txt', 'src/order/*.vue'), false)
  assert.equal(matchesSource('src/order/nested/Page.vue', 'src/order/*.vue'), false)
  assert.equal(matchesSource('src/order/Page.vue', 'src/order/**/*.vue'), true)
  assert.equal(matchesSource('src/order/nested/Page.vue', 'src/order/**/*.vue'), true)
  assert.equal(matchesSource('src/orders/Page.vue', 'src/order/'), false)
  assert.equal(matchesSource('src/api.js', 'api.js'), true)
})

sandbox(({ root, put, git, run, meta }) => {
  put('src/OrderStore.ts', 'export const OrderStore = {}')
  git('add', 'src'); git('commit', '-qm', 'base')
  check('Missing KB falls back to Git paths without initializing metadata', () => {
    const r = run('kb-query', ['OrderStore'])
    assert.equal(r.status, 0); assert.equal(r.matches[0].path, 'src/OrderStore.ts')
    assert.equal(fs.existsSync(path.join(root, '.docs')), false)
    assert(r.warnings.length > 0)
  })
  meta('', [])
  put('.docs/llm-knowledge/frontend-index.json', JSON.stringify({ files: [{ path: 'src/OrderStore.ts' }] }))
  put('src/NewPage.ts', 'export const NewPage = {}')
  check('Existing index does not hide newly added files, and lookup stays read-only', () => {
    const index = path.join(root, '.docs/llm-knowledge/frontend-index.json')
    const before = fs.readFileSync(index, 'utf8')
    const r = run('kb-query', ['NewPage'])
    assert.equal(r.status, 0); assert.equal(r.matches[0].path, 'src/NewPage.ts')
    assert.equal(r.matches[0].sourceChangedSinceScan, null)
    assert.equal(fs.readFileSync(index, 'utf8'), before)
  })
  put('.docs/llm-knowledge/frontend-index.json', '{broken')
  put('.docs/llm-knowledge/meta.yaml', 'domains: [broken')
  check('Corrupt optional metadata is reported while source paths remain searchable', () => {
    const r = run('kb-query', ['OrderStore'])
    assert.equal(r.status, 0); assert.equal(r.matches[0].path, 'src/OrderStore.ts')
    assert(r.warnings.length >= 2)
  })
  meta('', [])
  put('.docs/llm-knowledge/.profile.yaml', 'project_type: backend\n')
  put('.docs/llm-knowledge/backend-index.json', JSON.stringify({ files: [{ path: 'src/OrderStore.ts',
    symbols: [{ name: 'OrderStore', qualified_name: 'example.OrderStore', line: 1 }] }] }))
  check('Qualified symbol lookup returns the symbol that matched', () => {
    const r = run('kb-query', ['example.OrderStore'])
    assert.equal(r.matches[0].symbols[0].qualified_name, 'example.OrderStore')
  })
})

sandbox(({ root, put, git, run, meta }) => {
  put('src/views/order/Page.vue', '<script>import { get } from "../../api/shared"</script>')
  put('src/views/user/Page.vue', '<script>import { get } from "../../api/shared"</script>')
  put('src/api/shared.ts', 'export const get = () => 1')
  put('src/views/order/Other.vue', '<template>unchanged</template>')
  put('.docs/llm-knowledge/.profile.yaml', 'project_type: frontend\nsource_root: src\n')
  const domains = ['order', 'user'].map(id => ({ id, path: `business/${id}/`, entry_files: [`src/views/${id}/*.vue`] }))
  git('add', 'src'); git('commit', '-qm', 'baseline'); const baseline = git('rev-parse', 'HEAD'); meta(baseline, domains)
  collectUpdate(root)
  check('Frontend synchronized scan is a no-op and cached', () => {
    const r = collectUpdate(root); assert.equal(r.affectedDomains.length, 0); assert.equal(r.frontend.scanStats.read, 0)
  })
  check('Read-only freshness and incremental queries do not rewrite indexes', () => {
    const file = path.join(root, '.docs/llm-knowledge/frontend-index.json')
    const before = fs.readFileSync(file, 'utf8')
    assert.equal(run('gen-project-docs', ['--stale']).stale, false)
    assert.equal(run('gen-project-docs').domains.length, 0)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
  put('src/api/shared.ts', 'export const get = () => 2')
  check('Shared API import maps a working-tree change to both domains', () => {
    const r = collectUpdate(root)
    assert.deepEqual(r.affectedDomains.map(d => d.id).sort(), ['order', 'user'])
    assert.equal(r.frontend.scanStats.parsed, 1); assert.equal(r.unclassifiedFiles.length, 0)
  })
  check('Incremental generation bounds files and preserves explicit full mode', () => {
    const r = run('gen-project-docs')
    assert.equal(r.status, 0)
    assert.equal(r.domains.length, 2)
    assert(r.domains.every(d => d.files.all.length === 1 && d.files.all[0].endsWith('shared.ts')))
    assert(r.domains.every(d => d.documents.length === 1 && d.documents[0].sections.length))
    assert(run('gen-project-docs', ['order']).domains[0].files.all.some(f => f.endsWith('Other.vue')))
  })
  put('src/new-module.ts', 'export const unknown = 1')
  check('New unmapped module is explicit and cannot silently advance sync hash', () => {
    const r = collectUpdate(root); assert(r.unclassifiedFiles.includes('src/new-module.ts')); assert.equal(r.canAdvanceHash, false)
  })
  fs.unlinkSync(path.join(root, 'src/api/shared.ts')); collectUpdate(root)
  check('Deleted shared file remains mapped on a second update attempt', () => {
    const r = collectUpdate(root); assert.equal(r.affectedDomains.length, 2)
    assert(r.affectedDomains.every(d => d.matchedFiles.includes('src/api/shared.ts')))
    const plan = run('gen-project-docs'); assert(plan.domains.every(d => d.deletedFiles.includes('src/api/shared.ts')))
  })
  check('Query output is bounded and does not embed the full index', () => {
    const r = run('kb-query', ['Page', '--limit', '1']); assert.equal(r.matches.length, 1); assert.equal(r.truncated, true)
    assert(r.matches[0].documents.length); assert(!('dependencies' in r.matches[0]))
  })
  check('Invalid baseline and malformed metadata are unknown, never fresh', () => {
    meta('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', domains)
    assert.equal(run('gen-project-docs', ['--stale']).stale, null)
    assert.equal(run('gen-project-docs').status, 1)
    put('.docs/llm-knowledge/meta.yaml', 'git: [bad\n')
    assert.equal(run('gen-project-docs', ['--stale']).stale, null)
    assert.equal(run('kb-update').canAdvanceHash, false)
  })
})

sandbox(({ root, put, git, meta, run }) => {
  put('src/order.js', 'order'); git('add', 'src'); git('commit', '-qm', 'base')
  const baseline = git('rev-parse', 'HEAD')
  const domain = { id: 'order', path: 'business/order/', entry_files: ['src/order.js'] }
  meta(baseline, [domain])
  put('.codebuddy/plans/OLD/prototype-analysis.md', '# Same title\nold content')
  check('Unassigned history never inherits the current affected domain', () => {
    put('src/order.js', 'changed')
    assert.equal(collectUpdate(root).designDocs[0].targetDomain, null)
  })
  check('Explicit Story attribution agrees between update and generation', () => {
    assert.equal(collectUpdate(root, { storyId: 'OLD' }).designDocs[0].targetDomain, 'order')
    assert.equal(run('gen-project-docs', ['--story', 'OLD']).designDocs[0].targetDomain, 'order')
  })
  put('.codebuddy/plans/OLD/e2e-state.json', '{"domain":"order"}')
  const doc = collectUpdate(root).designDocs[0]
  put('.docs/llm-knowledge/' + doc.targetPath, '# Same title\nold content\n<!-- CUSTOM:START -->manual<!-- CUSTOM:END -->')
  domain.design_docs = [{ story_id: 'OLD', doc_path: doc.targetPath, source_hash: doc.sourceHash }]
  meta(baseline, [domain])
  check('Acknowledged source hash skips unchanged prototypes with manual target edits', () => {
    assert.equal(collectUpdate(root).designDocs.length, 0)
  })
  put('.codebuddy/plans/OLD/prototype-analysis.md', '# Same title\nnew content')
  check('Changed prototype keeps stable target and requests a merge', () => {
    const next = collectUpdate(root).designDocs[0]
    assert.equal(next.targetPath, doc.targetPath); assert.equal(next.action, 'merge'); assert.notEqual(next.sourceHash, doc.sourceHash)
  })
})

sandbox(({ root, put }) => {
  const prefix = 'src/main/java/com/example/order/'
  const config = { domains: [{ id: 'order', include: ['src/main/java/**/*.java'] }] }
  put('.docs/llm-knowledge/backend.config.json', JSON.stringify(config))
  for (let i = 0; i < 100; i++) put(prefix + `C${i}.java`, `package com.example.order; public class C${i} {}`)
  const build = previous => buildBackendIndex(root, ['src/main/java'], [], [], { previous })
  const first = build()
  check('100 unrelated same-package classes produce no pairwise dependencies', () => {
    assert.equal(first.files.reduce((n, f) => n + f.dependencies.length, 0), 0)
    assert.equal(backendImpact(first, first, [prefix + 'C0.java']).affectedDomains[0].matchedFiles.length, 1)
  })
  const second = build(first)
  check('Unchanged backend scan reuses all source parses without reading source text', () => {
    assert.equal(second.scan_stats.read, 0); assert.equal(second.scan_stats.parsed, 0); assert.equal(second.scan_stats.reused, 100)
  })
  put(prefix + 'C0.java', 'package com.example.order; public class C0 { C1 value; }')
  const third = build(second)
  check('One edited file is reparsed; actual same-package use propagates impact', () => {
    assert.equal(third.scan_stats.parsed, 1)
    assert.deepEqual(third.files.find(f => f.path.endsWith('/C0.java')).dependencies, [prefix + 'C1.java'])
    assert.deepEqual(backendImpact(third, third, [prefix + 'C1.java']).affectedDomains[0].matchedFiles.sort(), [prefix + 'C0.java', prefix + 'C1.java'])
  })
  put(prefix + 'C2.java', 'package com.example.order; public class C2 { /* C1 ignored; */ String s = "C1"; }')
  const fourth = build(third)
  check('Comments and strings do not create false same-package dependencies', () => {
    assert.deepEqual(fourth.files.find(f => f.path.endsWith('/C2.java')).dependencies, [])
  })
  config.domains[0].id = 'orders'; put('.docs/llm-knowledge/backend.config.json', JSON.stringify(config))
  const fifth = build(fourth)
  check('Ownership configuration change invalidates cache and recalculates domains', () => {
    assert.equal(fifth.scan_stats.parsed, 100); assert.equal(fifth.domains[0].id, 'orders')
  })
  console.log(`  Backend fixture: ${first.files.length} files, ${first.files.reduce((n, f) => n + f.dependencies.length, 0)} edges, cached reads ${second.scan_stats.read}`)
})
console.log(`KB optimization: ${count} checks passed`)
