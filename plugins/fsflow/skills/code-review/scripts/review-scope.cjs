#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

function git (root, args, options = {}) {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options
  })
}

function rulesFor (file) {
  if (/\.java$/i.test(file)) return ['java.md']
  if (/(mapper|dao).*\.xml$/i.test(file)) return ['mapper_dao_xml.md']
  if (/\.(?:[cm]?[jt]sx?|vue|wxml|wxss|css|scss|less)$/i.test(file)) return ['ts_js_tsx_jsx.md', 'frontend.md']
  if (/\.(?:sql|xml|json|ya?ml|properties|gradle|toml)$/i.test(file)) return ['default.md', 'config-and-data.md']
  return ['default.md']
}

function safeFile (root, file) {
  if (!file || path.isAbsolute(file) || file.split('/').includes('..') || file.includes('\0')) throw new Error('非法仓库相对路径')
  const absolute = path.resolve(root, file)
  // 不穿过指向仓库外的父级符号链接；末级符号链接只读取链接目标文本。
  const parent = path.dirname(absolute)
  if (fs.existsSync(parent)) {
    const relative = path.relative(root, fs.realpathSync(parent))
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('路径父目录越出仓库')
  }
  return absolute
}

function lineCount (buffer) {
  if (!buffer.length || buffer.includes(0)) return 0
  const value = buffer.toString('utf8')
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}

function snapshot (repo, project, baseRef) {
  const root = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim())
  if (fs.realpathSync(repo) !== root) throw new Error('repo 必须是 Git 仓库根目录')
  const conflicted = git(root, ['ls-files', '-u', '-z'])
  if (conflicted) throw new Error('仓库含未解决冲突，不能生成完整审查范围')
  let head = null
  try { head = git(root, ['rev-parse', '--verify', 'HEAD'], { stdio: ['pipe', 'pipe', 'ignore'] }).trim() } catch (_) {}
  const base = baseRef
    ? git(root, ['rev-parse', '--verify', '--end-of-options', baseRef + '^{tree}']).trim()
    : (head || git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim())
  // HEAD -> 最终工作区、HEAD -> 暂存区分别保留；暂存删除后同名新建不能丢失。
  const changed = git(root, ['diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'])
  const staged = git(root, ['diff', '--cached', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'])
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const names = [...new Set((changed + staged + untracked).split('\0').filter(Boolean))].sort()
  const excluded = []
  const files = []
  for (const file of names) {
    if (file.startsWith('.codebuddy/plans/')) {
      excluded.push({ path: file, reason: '工作流运行产物，避免审查报告与状态自引用' })
      continue
    }
    const absolute = safeFile(root, file)
    let content = Buffer.alloc(0)
    let kind = 'deleted'
    try {
      const stat = fs.lstatSync(absolute)
      kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'directory'
      if (kind === 'symlink') content = Buffer.from(fs.readlinkSync(absolute))
      if (kind === 'file') content = fs.readFileSync(absolute)
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    let before = Buffer.alloc(0)
    let index = Buffer.alloc(0)
    try { before = git(root, ['show', base + ':' + file], { encoding: null, stdio: ['pipe', 'pipe', 'ignore'] }) } catch (_) {}
    try { index = git(root, ['show', ':' + file], { encoding: null, stdio: ['pipe', 'pipe', 'ignore'] }) } catch (_) {}
    const diffArgs = ['--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', base, '--', file]
    const workDiff = git(root, ['diff', ...diffArgs])
    const indexDiff = git(root, ['diff', '--cached', ...diffArgs])
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([file, kind, workDiff, indexDiff])).update(content).digest('hex')
    files.push({ path: file, kind, fingerprint, beforeLines: lineCount(before), indexLines: lineCount(index), afterLines: kind === 'file' ? lineCount(content) : 0, rules: rulesFor(file) })
  }
  return { project, root, head, base, files, excluded }
}

function validateCoverage (coverage, repos, issues = []) {
  const errors = []
  if (!coverage || coverage.version !== 1 || !Array.isArray(coverage.repositories)) return ['缺少有效 coverage(version=1)']
  const expected = Object.keys(repos.repos).sort()
  const actual = coverage.repositories.map(r => r.project).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return ['coverage 仓库清单与 repos.json 不一致（含重复或遗漏）']
  const currentByProject = new Map()
  for (const saved of coverage.repositories) {
    try {
      if (!saved.base || !Array.isArray(saved.files)) throw new Error('缺少 base 或 files')
      const current = snapshot(repos.repos[saved.project], saved.project, saved.base)
      currentByProject.set(saved.project, current)
      if (saved.root !== current.root || saved.head !== current.head) errors.push(saved.project + ': 仓库位置或 HEAD 已变化')
      const paths = saved.files.map(f => f.path).sort()
      if (JSON.stringify(paths) !== JSON.stringify(current.files.map(f => f.path).sort())) errors.push(saved.project + ': 审查文件清单遗漏、重复或过期')
      const savedMap = new Map(saved.files.map(f => [f.path, f]))
      for (const file of current.files) {
        const record = savedMap.get(file.path)
        if (!record) continue
        if (record.fingerprint !== file.fingerprint) errors.push(file.path + ': 审查后内容或暂存区已变化')
        if (!['reviewed', 'skipped'].includes(record.status)) errors.push(file.path + ': 未记录审查结果')
        if (record.status === 'skipped' && !(typeof record.reason === 'string' && record.reason.trim())) errors.push(file.path + ': 跳过缺少具体原因')
        if (record.status === 'reviewed' && !(typeof record.evidence === 'string' && record.evidence.trim())) errors.push(file.path + ': 缺少审查依据')
      }
    } catch (e) { errors.push(saved.project + ': ' + e.message) }
  }
  for (const issue of issues) {
    // 旧轮次已关闭的问题可保留原位置；只校验本轮仍需处理的发现。
    if (issue.status !== 'open') continue
    const project = issue.project || repos.primary
    const repo = currentByProject.get(project)
    const file = repo && repo.files.find(f => f.path === issue.file)
    if (!file) { errors.push(issue.id + ': 问题文件不在本轮审查范围'); continue }
    if (issue.line == null) continue
    const match = /^(\d+)(?:-(\d+))?$/.exec(String(issue.line))
    const start = match && Number(match[1])
    const end = match && Number(match[2] || match[1])
    const version = issue.lineVersion || (file.kind === 'deleted' ? 'base' : 'worktree')
    const count = { base: file.beforeLines, index: file.indexLines, worktree: file.afterLines }[version]
    if (!Number.isInteger(count) || !match || start < 1 || end < start || end > count) errors.push(issue.id + ': 行号不在对应版本文件范围')
  }
  return errors
}

function main (argv) {
  if (argv.includes('--help') || !argv.length) {
    console.log('node review-scope.cjs --repo <仓库根> [--project <repos.json 键>] [--base <Git ref>]\n只读输出单仓快照 JSON；缺省比较 HEAD、暂存区、工作区和未跟踪文件。跨分支可先确定 merge-base，再传 --base。')
    return
  }
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--project', '--base'].includes(argv[i]) || !argv[i + 1]) throw new Error('未知参数或缺少参数值')
    options[argv[i].slice(2)] = argv[i + 1]
  }
  if (!options.repo) throw new Error('必须提供 --repo')
  console.log(JSON.stringify(snapshot(options.repo, options.project || path.basename(options.repo), options.base), null, 2))
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 1 }
}
module.exports = { snapshot, validateCoverage, rulesFor }
