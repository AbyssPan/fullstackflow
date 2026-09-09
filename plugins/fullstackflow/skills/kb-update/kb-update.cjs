#!/usr/bin/env node
/**
 * kb-update.cjs — 知识库增量更新脚本
 *
 * 自包含于 kb-update Skill，从任意前端项目调用。
 * "脚本负责执行": git diff + meta.yaml 数据驱动域匹配。
 * 输出 JSON 供 kb-update Skill (AI) 消费。
 *
 * 用法: node "<skill_dir>/kb-update.cjs" [commitHash]
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PROJECT_ROOT = process.cwd()
// v2：去掉 frontend 硬编码层，知识库根为 .docs/llm-knowledge/
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
const META_PATH = path.join(KB_ROOT, 'meta.yaml')

/** 简化 YAML 解析 — 只提取 domains[] 和 git.hash（v2：文件字段通用化） */
function parseMetaYaml (content) {
  const result = { git: {}, domains: [] }
  // 只匹配 git: 块下的 hash（避免误匹配 doc_stats.git_hash_at_generation）
  const gitBlock = content.match(/git:\s*\n([\s\S]*?)(?=\n\S|$)/)
  if (gitBlock) {
    const hashMatch = gitBlock[1].match(/hash:\s*"([^"]+)"/)
    if (hashMatch) result.git.hash = hashMatch[1]
  }

  // 全局匹配 domains: 块中 2 空格缩进的 - id:"xxx"（domain 级别）
  const domainsBlock = content.match(/domains:\s*\n([\s\S]*?)(?=\n\S|$)/)
  if (!domainsBlock) return result

  const idRe = /^  - id:\s*"([^"]+)"/gm
  let m
  while ((m = idRe.exec(domainsBlock[1])) !== null) {
    result.domains.push({ id: m[1], path: '', files: [] })
  }

  // 补齐每个 domain 的 path 和文件字段（v2：不再假设前端字段名）
  // 文件字段名可能因项目类型而异：entry_files / stores / apis / components / files / ...
  for (const domain of result.domains) {
    const pathRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"[\s\S]*?path:\s*"([^"]+)"`)
    const pathMatch = domainsBlock[1].match(pathRe)
    if (pathMatch) domain.path = pathMatch[1]

    // 提取该 domain 块的所有「文件类」字段值，统一归入 files[]
    const domainBlockRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"([\s\S]*?)(?=\n  - id:\s*"|\n\S|$)`)
    const blockMatch = domainsBlock[1].match(domainBlockRe)
    if (!blockMatch) continue
    const block = blockMatch[1]

    // 匹配任意 *_files / stores / apis / components / files 等字段
    const fileFieldRe = /\b(\w*(?:files|stores|apis|components|entries))\s*:\s*(\[[\s\S]*?\]|\n\s*- "[\s\S]*?(?=\n\s{4}\w|\n  -|\n\s*$))/g
    let fm
    const collected = []
    while ((fm = fileFieldRe.exec(block)) !== null) {
      const raw = fm[2]
      // 提取所有被引号包裹的字符串
      const strs = raw.match(/"([^"]+)"/g)
      if (strs) collected.push(...strs.map(s => s.replace(/"/g, '')))
    }
    // 兜底：匹配内联数组形式的 entry_files: ["a", "b"]
    const inlineRe = /entry_files\s*:\s*\[([^\]]+)\]/g
    let im
    while ((im = inlineRe.exec(block)) !== null) {
      collected.push(...im[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean))
    }
    domain.files = [...new Set(collected)]
  }

  return result
}

/** 判断变更文件是否属于指定域（前缀匹配 meta.yaml 中的文件字段，v2：字段通用化） */
function matchFileToDomain (file, domain) {
  const sources = domain.files || []
  // 通配符支持：entry_files 里的 "plugins/harness/agents/*.md" 去掉 *.md 后做前缀匹配
  return sources.some(s => {
    const normalized = s.replace(/\*/g, '')  // 去掉通配符
    return file.startsWith(normalized) || file.includes(normalized.replace(/\/$/, ''))
  })
}

// ─── 主逻辑 ──────────────────────────────────────────────────

let changedFiles = []
const errors = []

try { var currentHash = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim() }
catch (e) { errors.push('git rev-parse failed: ' + e.message); currentHash = '' }

let lastHash = currentHash
if (fs.existsSync(META_PATH)) {
  const meta = parseMetaYaml(fs.readFileSync(META_PATH, 'utf-8'))
  lastHash = meta.git.hash || currentHash
}

try {
  const diff = execSync(`git diff --name-only ${lastHash}..${currentHash}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim()
  changedFiles = diff ? diff.split('\n').filter(Boolean) : []
  if (changedFiles.length === 0) {
    const d = execSync('git diff --name-only HEAD~1..HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim()
    changedFiles = d ? d.split('\n').filter(Boolean) : []
  }
} catch (e) { /* no diff available */ }

// 加载 meta.yaml（始终加载，后面的原型文档匹配也需要）
let meta = {}
if (fs.existsSync(META_PATH)) {
  meta = parseMetaYaml(fs.readFileSync(META_PATH, 'utf-8'))
}

// 匹配受影响域
let affectedDomains = []
if (changedFiles.length > 0) {
  for (const domain of meta.domains) {
    const matched = changedFiles.filter(f => matchFileToDomain(f, domain))
    if (matched.length > 0) affectedDomains.push({ id: domain.id, path: domain.path, matchedFiles: matched })
  }
}

// ─── 原型文档扫描 ──────────────────────────────────────────
// 扫描 plans 目录下的 prototype-analysis.md，匹配到受影响域
const PLANS_DIR = path.join(PROJECT_ROOT, '.codebuddy', 'plans')
const DESIGN_DOCS_DIR = path.join(KB_ROOT, 'business')
const designDocs = []

if (fs.existsSync(PLANS_DIR)) {
  const storyDirs = fs.readdirSync(PLANS_DIR).filter(d => {
    const stat = fs.statSync(path.join(PLANS_DIR, d))
    return stat.isDirectory()
  })

  for (const storyId of storyDirs) {
    const protoPath = path.join(PLANS_DIR, storyId, 'prototype-analysis.md')
    if (!fs.existsSync(protoPath)) continue

    // 读取原型文档，提取标题和 prototype_url
    const content = fs.readFileSync(protoPath, 'utf-8')
    const titleMatch = content.match(/#\s*(.+)/)
    const urlMatch = content.match(/prototype_url:\s*(.+)/) || content.match(/原型链接.*?(https?:\/\/[^\s)]+)/)
    const title = titleMatch ? titleMatch[1].trim() : storyId
    const prototypeUrl = urlMatch ? urlMatch[1].trim() : ''

    // 匹配域：通过 story e2e-state.json 的 domain 字段，或通过变更文件匹配
    const statePath = path.join(PLANS_DIR, storyId, 'e2e-state.json')
    let targetDomain = null
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
        if (state.domain && meta.domains?.some(d => d.id === state.domain)) {
          targetDomain = state.domain
        }
      } catch (e) {}
    }

    // 无显式 domain 时，遍历受影响域检查文件关联
    if (!targetDomain) {
      for (const ad of affectedDomains) {
        if (ad.matchedFiles.some(f => f.includes('settings') || ad.id === 'settings')) {
          targetDomain = ad.id
          break
        }
      }
      // 兜底：第一个受影响域
      if (!targetDomain && affectedDomains.length > 0) {
        targetDomain = affectedDomains[0].id
      }
    }

    const docFileName = (title || storyId).replace(/[^\w\u4e00-\u9fff-]/g, '-').replace(/-+/g, '-').toLowerCase() + '.md'

    designDocs.push({
      storyId,
      title: title || storyId,
      prototypeUrl,
      sourcePath: protoPath,
      targetDomain,
      targetPath: targetDomain ? `business/${targetDomain}/design/${docFileName}` : null,
      targetDir: targetDomain ? path.join(DESIGN_DOCS_DIR, targetDomain, 'design') : null,
      fileName: docFileName
    })
  }
}

console.log(JSON.stringify({ lastHash, currentHash, changedFiles, affectedDomains, designDocs, errors }, null, 2))
