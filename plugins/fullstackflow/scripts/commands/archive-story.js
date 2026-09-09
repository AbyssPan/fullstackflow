#!/usr/bin/env node
/**
 * archive-story.js — Story 归档（清空 root）与复档（复原 root）
 *
 * 职责:
 *   - archive: 把 Story 根目录所有文件移入 archive/round-{N}/，清空 root 目录
 *   - restore: 把指定轮次的归档文件恢复到 Story 根目录
 *   - list: 列出所有归档轮次（文件数、体积、当时到达的 Phase）
 *   - status: 查询当前是否处于归档状态及归档轮次信息
 *   - 归档/复档均同步维护 e2e-state.json 的 archived* / restored* 字段，并写入 trace
 *
 * 用法:
 *   node plugins/fullstackflow/scripts/commands/archive-story.js <storyId> archive [--dry-run] [--round <N>] [--force]
 *     归档: root 全部文件（含 e2e-state.json / trace.jsonl / repos.json）移入 archive/round-{N}/
 *   node plugins/fullstackflow/scripts/commands/archive-story.js <storyId> restore [--round <N>] [--force] [--keep-archive]
 *     复档: archive/round-{N}/ 全部文件恢复到 root
 *   node plugins/fullstackflow/scripts/commands/archive-story.js <storyId> list
 *     列出所有归档轮次
 *   node plugins/fullstackflow/scripts/commands/archive-story.js <storyId> status
 *     查看当前归档状态
 *   --dry-run       预览将要归档的文件清单，不实际移动
 *   --round <N>     archive 缺省自动取最大轮次 +1，restore 缺省自动取最新轮次
 *   --force         archive: 未达终态 (phase < 8) 时强制归档；restore: 覆盖 root 同名文件
 *   --keep-archive  restore 时保留归档副本（默认移动，归档目录会被清空）
 *
 * 使用场景:
 *   - 工作流走完 Phase 7、dispatch.js 输出 status=terminal 后，主 Agent 执行 archive 收尾，
 *     把 Story 目录清空以免污染下一次开发
 *   - advance-phase.js 以"Story 已归档"拒绝 --rollback / --fix-loop 时，先执行 restore 复档
 *     恢复操作能力，再继续推进
 *   - 归档前用 --dry-run 核对将要移走的文件清单；中途放弃的 Story (phase < 8) 用 --force 强制归档
 *   - 用 list / status 排查"这个 Story 归档了没、归档在第几轮"，尤其 root 已被清空、
 *     e2e-state.json 不可见时
 *
 * 说明:
 *   - 归档后 root 目录清空，所有文件（含 e2e-state.json / trace.jsonl / repos.json）都进入
 *     archive/round-{N}/；dev-pass.json 属于残留文件，不进入归档而是直接删除。
 *   - 防重复归档：root 无文件即判定为已归档，拒绝再次 archive，需先执行 restore。
 *   - 终态检查：phase < 8 时默认拒绝归档，需 --force；归档会写入 state.status='archived'
 *     以及 archivedAt / archiveRound / archiveDir。
 *   - restore 默认移动（归档目录随之清空），--keep-archive 改为复制以保留归档副本；
 *     root 存在同名文件时需 --force 覆盖，否则先报冲突清单。
 *   - 复档后 state 恢复 status='running' 并写入 restoredAt / restoredFromRound，同时清除 archived* 字段。
 *   - 本文件无 module.exports，仅作为 CLI 被主 Agent 调用（harness-archive skill）。
 *
 * @module archive-story
 */

const fs = require('fs')
const path = require('path')
const {
  getStoryDir,
  readStateFile,
  writeStateFile,
  PROJECT_ROOT
} = require('../lib/state')
const trace = require('../lib/trace')
const { validateOpenspecDir } = require('./validate-openspec')

// ─── 常量 ──────────────────────────────────────────────────────

/** 归档时需要额外删除的残留文件（这些文件不进入归档） */
const DELETE_FILES = ['dev-pass.json']

/** archive/ 目录内的子目录（不参与递归扫描的顶层目录） */
const ARCHIVE_DIR = 'archive'

/** OpenSpec 规格产物目录名（story 目录内） */
const OPENSPEC_DIR = 'openspec'

/** OpenSpec 归档根目录（项目根下，与 OpenSpec CLI 的 changes/archive 约定一致） */
const OPENSPEC_ARCHIVE_ROOT = path.join(PROJECT_ROOT, 'openspec', 'changes', 'archive')

/** 需同步到 openspec/changes/archive/ 的规格产物（文件或目录） */
const OPENSPEC_ARTIFACTS = ['proposal.md', 'design.md', 'tasks.md', 'specs']

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 检测下一个归档轮次编号
 * 扫描 archive/ 下已有 round-{N} 目录，取最大值 +1
 * @param {string} storyDir - Story 目录绝对路径
 * @returns {number} 下一个轮次编号（无归档时返回 1）
 */
function detectRound(storyDir) {
  const archiveDir = path.join(storyDir, ARCHIVE_DIR)
  if (!fs.existsSync(archiveDir)) return 1
  const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
  let max = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = e.name.match(/^round-(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max + 1
}

/**
 * 递归删除空目录（仅删除空目录，非空则保留）
 * @param {string} dirPath - 目录路径
 */
function removeDirIfEmpty(dirPath) {
  if (!fs.existsSync(dirPath)) return
  try {
    fs.rmdirSync(dirPath)
  } catch {
    // 目录非空，保留
  }
}

/**
 * 扫描目录下所有文件（递归，排除指定的顶层目录）
 * @param {string} dir - 目录路径
 * @param {string[]} excludeTop - 排除的顶层目录名称
 * @returns {Array<{name: string, src: string, relative: string}>}
 */
function scanAllFiles(dir, excludeTop) {
  const result = []
  const excludeSet = new Set(excludeTop || [])
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory() && excludeSet.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isFile()) {
      result.push({ name: e.name, src: full, relative: e.name })
    } else if (e.isDirectory()) {
      walkDir(full, e.name, result)
    }
  }
  return result
}

/**
 * 递归遍历子目录收集文件
 * @param {string} dir - 目录路径
 * @param {string} prefix - 相对路径前缀
 * @param {Array} result - 结果数组
 */
function walkDir(dir, prefix, result) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const rel = prefix + '/' + e.name
    if (e.isFile()) {
      result.push({ name: e.name, src: full, relative: rel })
    } else if (e.isDirectory()) {
      walkDir(full, rel, result)
    }
  }
}

/**
 * 自动检测最新的归档轮次号
 * @param {string} archiveDir - archive/ 目录路径
 * @returns {number|null}
 */
function detectLatestRound(archiveDir) {
  if (!fs.existsSync(archiveDir)) return null
  const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
  let max = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = e.name.match(/^round-(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max || null
}

/**
 * 确保目录存在（递归创建）
 * @param {string} dirPath - 目录路径
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

// ─── 命令: archive ─────────────────────────────────────────────

/**
 * 执行归档：将 story 根目录所有文件移动到 archive/round-{N}/
 * @param {string} storyId - Story ID
 * @param {{ dryRun: boolean, round: number|null, force: boolean }} opts - 选项
 */
function cmdArchive(storyId, opts) {
  // 1. 读取当前状态（归档前必须）
  const state = readStateFile(storyId)
  if (!state || state._parseError) {
    console.log(JSON.stringify({
      error: 'e2e-state.json 不存在或解析失败',
      storyId,
      detail: state ? state._parseError : null
    }, null, 2))
    process.exit(1)
  }

  const storyDir = getStoryDir(storyId)

  // 2. 防重复归档：root 为空即已归档
  const rootFiles = fs.readdirSync(storyDir, { withFileTypes: true })
    .filter(e => e.isFile())
  const hasArchiveDir = rootFiles.some(e => e.name === ARCHIVE_DIR)
  const actualFiles = rootFiles.filter(e => e.name !== ARCHIVE_DIR || !hasArchiveDir)
  if (actualFiles.length === 0) {
    console.log(JSON.stringify({
      error: 'Story 已归档（root 目录无文件），禁止重复归档',
      hint: '如需重新归档，请先执行 restore 复档'
    }, null, 2))
    process.exit(1)
  }

  // 3. 终态检查（phase < 8 需 --force）
  if (state.phase < 8 && !opts.force) {
    console.log(JSON.stringify({
      error: `Story 未达终态 (当前 Phase ${state.phase})，建议达到 Phase 8 后再归档`,
      hint: '如需强制归档，添加 --force'
    }, null, 2))
    process.exit(1)
  }

  const round = opts.round || detectRound(storyDir)
  const roundDir = path.join(storyDir, ARCHIVE_DIR, `round-${round}`)

  // 4. 扫描 root 所有文件（排除 archive/ 目录）
  const toArchive = scanAllFiles(storyDir, [ARCHIVE_DIR])

  // 5. dry-run 预览
  if (opts.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      storyId,
      round,
      phaseReached: state.phase,
      archiveDir: `${ARCHIVE_DIR}/round-${round}/`,
      filesToArchive: toArchive.map(f => f.relative),
      filesToDelete: DELETE_FILES.filter(d => toArchive.some(f => f.name === d)),
      summary: {
        totalFiles: toArchive.length
      }
    }, null, 2))
    process.exit(0)
  }

  // 6. 创建归档目录
  ensureDir(roundDir)

  // 7. 先更新 e2e-state.json 状态，然后一并归档
  const now = new Date().toISOString()
  state.status = 'archived'
  state.archivedAt = now
  state.archiveRound = round
  state.archiveDir = `${ARCHIVE_DIR}/round-${round}/`
  state.updatedAt = now
  writeStateFile(storyId, state)

  // 8. 追加 trace（trace.jsonl 也会被归档）
  trace.appendTrace(storyId, {
    type: 'story_archived',
    phase: String(state.phase),
    result: 'archived',
    details: {
      round,
      fileCount: toArchive.length,
      archiveDir: state.archiveDir
    }
  })

  // 9. 重新扫描（因为 e2e-state.json 和 trace.jsonl 可能被更新了）
  const finalFiles = scanAllFiles(storyDir, [ARCHIVE_DIR])

  // 10. 删除残留文件（dev-pass.json 等不进入归档）
  const deletedFiles = []
  for (const del of DELETE_FILES) {
    const p = path.join(storyDir, del)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      deletedFiles.push(del)
    }
  }

  // 11. 移动所有文件到归档目录
  let movedCount = 0
  for (const f of finalFiles) {
    // 跳过已删除的残留文件
    if (DELETE_FILES.includes(f.name)) continue
    const dest = path.join(roundDir, f.relative)
    ensureDir(path.dirname(dest))
    fs.renameSync(f.src, dest)
    movedCount++
  }

  // 12. 清理 root 下除了 archive/ 的空子目录
  const rootEntries = fs.readdirSync(storyDir, { withFileTypes: true })
  for (const e of rootEntries) {
    if (e.isDirectory() && e.name !== ARCHIVE_DIR) {
      removeDirIfEmpty(path.join(storyDir, e.name))
    }
  }

  console.log(JSON.stringify({
    success: true,
    action: 'archive',
    storyId,
    title: state.title,
    round,
    archivedAt: now,
    phaseReached: state.phase,
    archiveDir: state.archiveDir,
    archivedFiles: movedCount,
    deletedFiles,
    openspecSync: syncOpenspecArchive(roundDir, storyId, state.title),
    hint: 'root 目录已清空，所有文件（含 e2e-state.json / trace.jsonl / repos.json）均归档到 archive/round-' + round + '/'
  }, null, 2))
}

/**
 * 同步 OpenSpec 规格产物到项目级 openspec/changes/archive/{yyyy-MM-dd}-{需求名称}/
 *
 * 每个 Story（需求）在归档时，把 story 目录下的 openspec 规格产物
 * （proposal.md / design.md / tasks.md / specs/）复制一份到项目根的
 * openspec/changes/archive/ 下，目录名固定为 `yyyy-MM-dd-{需求名称}`，
 * 与 OpenSpec CLI 的归档约定保持一致。story 目录内的原件仍按 round-{N} 归档。
 *
 * @param {string} roundDir - 本轮归档目录（archive/round-{N}）绝对路径
 * @param {string} storyId - Story ID
 * @param {string} title - 需求名称（story 标题，用于目录命名）
 * @returns {{ synced: boolean, targetDir: string|null, files: string[], reason: string|null }}
 */
function syncOpenspecArchive(roundDir, storyId, title) {
  const result = { synced: false, targetDir: null, files: [], reason: null }

  // 1. 归档目录中必须存在 openspec/ 规格产物，否则跳过（不阻断归档）
  const srcDir = path.join(roundDir, OPENSPEC_DIR)
  if (!fs.existsSync(srcDir)) {
    result.reason = 'story 无 openspec 规格产物（requirement-analyst / task-planner 未产出或需求极简），跳过同步'
    return result
  }

  // 2. 至少存在一个规格产物才算有效
  const present = OPENSPEC_ARTIFACTS.filter(a => fs.existsSync(path.join(srcDir, a)))
  if (present.length === 0) {
    result.reason = 'openspec/ 目录存在但无有效产物（proposal/design/tasks/specs 均缺失），跳过同步'
    return result
  }

  // 3. 目录名：yyyy-MM-dd-{需求名称}；需求名称做文件系统安全化处理
  const dateStr = new Date().toISOString().slice(0, 10)
  const safeTitle = String(title || storyId)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')   // 非法字符与空白转连字符
    .replace(/^-+|-+$/g, '')            // 去首尾连字符
    .slice(0, 60)                       // 限长，避免路径过长
  const dirName = `${dateStr}-${safeTitle || storyId}`
  const targetDir = path.join(OPENSPEC_ARCHIVE_ROOT, dirName)

  // 4. 防覆盖：同名归档目录已存在时追加时间后缀
  let finalDir = targetDir
  if (fs.existsSync(finalDir)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(11, 17)
    finalDir = `${targetDir}-${stamp}`
  }

  // 4.5 内置规则校验（提炼自 OpenSpec validate，零依赖）：不阻断归档，如实报告
  let validation = null
  try {
    validation = validateOpenspecDir(srcDir)
  } catch (err) {
    validation = { valid: false, errors: [`校验执行异常: ${err.message}`], warnings: [], stats: {} }
  }

  // 5. 递归复制规格产物
  const copied = []
  const copyRecursive = (src, dest) => {
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      for (const e of fs.readdirSync(src)) {
        copyRecursive(path.join(src, e), path.join(dest, e))
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      copied.push(path.relative(OPENSPEC_ARCHIVE_ROOT, dest))
    }
  }
  try {
    for (const artifact of present) {
      copyRecursive(path.join(srcDir, artifact), path.join(finalDir, artifact))
    }
    result.synced = true
    result.targetDir = path.relative(PROJECT_ROOT, finalDir)
    result.files = copied
    result.validation = validation
    if (validation && !validation.valid) {
      result.warning = `openspec 规格存在结构问题（error ${validation.errors.length} / warning ${validation.warnings.length}），已照实归档供追溯`
    }
  } catch (err) {
    result.reason = `openspec 同步失败（不阻断归档）: ${err.message}`
  }
  return result
}

// ─── 命令: restore ────────────────────────────────────────────

/**
 * 执行复档：将 archive/round-{N}/ 所有文件恢复到 story 根目录
 * 默认移动（归档目录清空），--keep-archive 保留归档副本
 * @param {string} storyId - Story ID
 * @param {{ round: number|null, force: boolean, keepArchive: boolean }} opts - 选项
 */
function cmdRestore(storyId, opts) {
  const storyDir = getStoryDir(storyId)
  const archiveDir = path.join(storyDir, ARCHIVE_DIR)

  // 1. 确定目标轮次
  let round = opts.round
  if (!round) {
    round = detectLatestRound(archiveDir)
    if (!round) {
      console.log(JSON.stringify({
        error: '无可用归档，请先执行 archive 归档',
        storyId
      }, null, 2))
      process.exit(1)
    }
  }

  const roundDir = path.join(archiveDir, `round-${round}`)
  if (!fs.existsSync(roundDir)) {
    console.log(JSON.stringify({
      error: `归档目录不存在: archive/round-${round}/`,
      hint: '请检查归档轮次是否正确，或用 list 命令查看可用归档'
    }, null, 2))
    process.exit(1)
  }

  // 2. 扫描归档目录所有文件
  const archiveFiles = scanAllFiles(roundDir, [])

  if (archiveFiles.length === 0) {
    console.log(JSON.stringify({
      error: `归档目录为空: archive/round-${round}/`,
      storyId
    }, null, 2))
    process.exit(1)
  }

  // 3. 检查目标文件冲突
  const conflicts = []
  for (const f of archiveFiles) {
    const dest = path.join(storyDir, f.relative)
    if (fs.existsSync(dest) && !opts.force) {
      conflicts.push(f.relative)
    }
  }
  if (conflicts.length > 0) {
    console.log(JSON.stringify({
      error: `根目录存在 ${conflicts.length} 个同名文件，复档将覆盖`,
      conflicts,
      hint: '添加 --force 覆盖，或先手动处理冲突文件'
    }, null, 2))
    process.exit(1)
  }

  // 4. 恢复文件到 root
  const restored = []
  for (const f of archiveFiles) {
    const dest = path.join(storyDir, f.relative)
    ensureDir(path.dirname(dest))
    if (opts.keepArchive) {
      fs.copyFileSync(f.src, dest)
    } else {
      fs.renameSync(f.src, dest)
    }
    restored.push(f.relative)
  }

  // 5. 清理归档目录（非 keepArchive 模式）
  let archiveCleaned = false
  if (!opts.keepArchive) {
    // 递归删除 round 目录下所有空目录
    function cleanEmptyDirs(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory()) {
          cleanEmptyDirs(path.join(dir, e.name))
        }
      }
      removeDirIfEmpty(dir)
    }
    cleanEmptyDirs(roundDir)
    archiveCleaned = !fs.existsSync(roundDir)
  }

  // 6. 读取恢复后的 e2e-state.json，更新状态
  const now = new Date().toISOString()
  const state = readStateFile(storyId)
  if (state) {
    state.status = 'running'
    state.restoredAt = now
    state.restoredFromRound = round
    delete state.archivedAt
    delete state.archiveRound
    delete state.archiveDir
    state.updatedAt = now
    writeStateFile(storyId, state)

    // 7. 记录 trace
    trace.appendTrace(storyId, {
      type: 'story_restored',
      phase: String(state.phase),
      result: 'restored',
      details: {
        round,
        fileCount: restored.length,
        keepArchive: opts.keepArchive,
        archiveCleaned
      }
    })
  }

  console.log(JSON.stringify({
    success: true,
    action: 'restore',
    storyId,
    round,
    restoredAt: now,
    restoredFiles: restored.length,
    keepArchive: opts.keepArchive,
    archiveCleaned,
    hint: opts.keepArchive
      ? '归档副本已保留，可再次 restore'
      : '归档目录已清理，root 目录已完全复原'
  }, null, 2))
}

// ─── 命令: list ───────────────────────────────────────────────

/**
 * 列出 story 的所有归档轮次
 * @param {string} storyId - Story ID
 */
function cmdList(storyId) {
  const storyDir = getStoryDir(storyId)
  const archiveDir = path.join(storyDir, ARCHIVE_DIR)
  if (!fs.existsSync(archiveDir)) {
    console.log(JSON.stringify({
      storyId,
      archives: [],
      message: '无归档目录'
    }, null, 2))
    return
  }

  const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
  /** @type {Array} */
  const rounds = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = e.name.match(/^round-(\d+)$/)
    if (!m) continue
    const rNum = parseInt(m[1], 10)
    const rDir = path.join(archiveDir, e.name)

    // 扫描文件数
    let fileCount = 0
    let totalSize = 0
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) {
          walk(path.join(dir, item.name))
        } else {
          fileCount++
          try {
            totalSize += fs.statSync(path.join(dir, item.name)).size
          } catch {}
        }
      }
    }
    try { walk(rDir) } catch {}

    // 尝试读取 e2e-state.json 获取元信息
    let phaseReached = null
    let title = null
    let archivedAt = null
    const e2ePath = path.join(rDir, 'e2e-state.json')
    if (fs.existsSync(e2ePath)) {
      try {
        const e2e = JSON.parse(fs.readFileSync(e2ePath, 'utf-8'))
        phaseReached = e2e.phase || null
        title = e2e.title || null
        archivedAt = e2e.archivedAt || null
      } catch {}
    }

    rounds.push({
      round: rNum,
      name: e.name,
      archivedAt,
      phaseReached,
      title,
      fileCount,
      totalSize
    })
  }
  rounds.sort((a, b) => a.round - b.round)

  // 判断当前是否归档状态（root 无文件）
  let rootHasFiles = false
  try {
    const rootEntries = fs.readdirSync(storyDir, { withFileTypes: true })
    rootHasFiles = rootEntries.some(e => e.isFile())
  } catch {}

  console.log(JSON.stringify({
    storyId,
    archived: !rootHasFiles,
    totalArchives: rounds.length,
    archives: rounds
  }, null, 2))
}

// ─── 命令: status ─────────────────────────────────────────────

/**
 * 查看归档状态
 * @param {string} storyId - Story ID
 */
function cmdStatus(storyId) {
  const storyDir = getStoryDir(storyId)

  // 检查 root 是否有文件（含 e2e-state.json）
  let rootHasFiles = false
  let e2eExists = false
  try {
    const rootEntries = fs.readdirSync(storyDir, { withFileTypes: true })
    rootHasFiles = rootEntries.some(e => e.isFile())
    e2eExists = rootEntries.some(e => e.name === 'e2e-state.json' && e.isFile())
  } catch {}

  // 尝试读取 e2e-state.json
  const state = readStateFile(storyId)
  const archivedByState = state && (state.status === 'archived' || state._parseError === undefined)

  // 判断是否归档：root 无文件 或 状态标记为 archived
  const archived = !rootHasFiles || archivedByState

  // 获取归档轮次信息
  let archiveRound = state ? state.archiveRound : null
  let archiveDir = state ? state.archiveDir : null
  let archivedAt = state ? state.archivedAt : null

  // 如果 root 没有 e2e-state，尝试从 archive 中找到
  if (!e2eExists && !archiveRound) {
    const arcDir = path.join(storyDir, ARCHIVE_DIR)
    const latest = detectLatestRound(arcDir)
    if (latest) {
      archiveRound = latest
      archiveDir = `${ARCHIVE_DIR}/round-${latest}/`
      // 读取归档中的 e2e-state 获取时间
      const e2eArcPath = path.join(arcDir, `round-${latest}`, 'e2e-state.json')
      if (fs.existsSync(e2eArcPath)) {
        try {
          const e2e = JSON.parse(fs.readFileSync(e2eArcPath, 'utf-8'))
          archivedAt = e2e.archivedAt || null
        } catch {}
      }
    }
  }

  console.log(JSON.stringify({
    storyId,
    title: state ? state.title : null,
    phase: state ? state.phase : null,
    archived,
    rootHasFiles,
    e2eExists,
    archiveRound: archiveRound || null,
    archiveDir: archiveDir || null,
    archivedAt: archivedAt || null,
    restoredAt: state ? (state.restoredAt || null) : null,
    restoredFromRound: state ? (state.restoredFromRound || null) : null,
    hint: archived
      ? '已归档（root 目录无文件）。执行 restore 复档可恢复操作能力'
      : '未归档。执行 archive 可归档全部文件'
  }, null, 2))
}

// ─── CLI 入口 ─────────────────────────────────────────────────

const args = process.argv.slice(2)
const storyId = args[0]
const command = args[1]

if (!storyId || !command) {
  console.log([
    'archive-story.js — Story 归档与复档',
    '',
    '用法:',
    '  node archive-story.js <storyId> archive [--dry-run] [--round <N>] [--force]',
    '    归档: 将 root 目录全部文件移入 archive/round-{N}/（含 e2e-state / trace / repos）',
    '    --dry-run    预览归档清单，不实际移动',
    '    --round <N>  指定轮次编号（缺省自动检测）',
    '    --force      非终态 (phase<8) 强制归档',
    '',
    '  node archive-story.js <storyId> restore [--round <N>] [--force] [--keep-archive]',
    '    复档: 将 archive/round-{N}/ 全部文件恢复到 root（完全复原）',
    '    --round <N>     指定轮次（缺省自动取最新 round）',
    '    --force         覆盖根目录同名文件',
    '    --keep-archive  保留归档副本（默认移动清空归档）',
    '',
    '  node archive-story.js <storyId> list',
    '    列出所有归档轮次',
    '',
    '  node archive-story.js <storyId> status',
    '    查看归档状态（root 目录是否已清空）',
    ''
  ].join('\n'))
  process.exit(1)
}

const flags = args.slice(2)
const opts = {
  dryRun: flags.includes('--dry-run'),
  force: flags.includes('--force'),
  keepArchive: flags.includes('--keep-archive'),
  round: null
}
const roundIdx = flags.indexOf('--round')
if (roundIdx !== -1 && flags[roundIdx + 1]) {
  opts.round = parseInt(flags[roundIdx + 1], 10)
  if (isNaN(opts.round) || opts.round < 1) {
    console.log(JSON.stringify({ error: '--round 必须为正整数' }, null, 2))
    process.exit(1)
  }
}

switch (command) {
  case 'archive':
    cmdArchive(storyId, opts)
    break
  case 'restore':
    cmdRestore(storyId, opts)
    break
  case 'list':
    cmdList(storyId)
    break
  case 'status':
    cmdStatus(storyId)
    break
  default:
    console.log(JSON.stringify({
      error: `未知命令: ${command}`,
      validCommands: ['archive', 'restore', 'list', 'status']
    }, null, 2))
    process.exit(1)
}
