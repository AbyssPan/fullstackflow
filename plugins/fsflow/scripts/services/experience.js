#!/usr/bin/env node
/**
 * experience.js — 经验沉淀飞轮：记录失败模式，并向 Agent 注入历史教训
 *
 * 职责:
 *   - 把门控/Hook 失败模式写入全局经验库 failure-patterns.json，并归档失败案例
 *   - 按 Phase 检索历史教训与度量洞察，供 prompt 与会话启动注入
 *   - 提供失败分布统计（getFailureStats），支撑 harness-evolve 的度量与诊断
 *
 * 用法:
 *   作为模块引用:
 *     const { recordFailurePattern, getLessonsForPhase } = require('./services/experience')
 *
 * 使用场景:
 *   - commands/advance-phase.js 门控失败且自动恢复无效后，recordFailurePattern 沉淀失败模式
 *   - hooks/session-start.js 会话启动注入 getLessonsForPhase 与 getMetricsInsights
 *   - services/prompt-builder.js 构造 prompt 时注入本 Phase 历史教训与度量洞察
 *   - services/context-refresh.js injectMustCheck 用 getLessonsAsChecklist(2) 生成 mustCheck 清单
 *   - hooks/session-stop.js 会话结束时 recordHookFailure 沉淀 Hook 层失败
 *   - audit/metrics-aggregator.js 读取与合并跨项目度量洞察
 *
 * 说明:
 *   - v2.0 增强采集: 去重键从 phase+failureType 改为 phase+failureType+rootCauseKey(前 50 字符)，
 *     同一 failureType 下不同根因不再被合并；unknown 类型自动沉淀并标记 needsManualReview
 *     （reviewStatus=pending），待人工用 confirmUnknownPattern 补录正确类型
 *   - getLessonsForPhase 输出时区分 unknown 类型，提醒人工补录到 policy.js 的 RECOVERY_SUGGESTIONS
 *   - v3.1 注入侧归并: 库里按根因分条留档（v2.0 的决定不变），但 getLessonsForPhase 注入前
 *     把 failureType + resolution 相同的条目合成一条。原因是模板化根因（消息里嵌绝对路径，
 *     如 dev_pass_scope_violation）每换一个文件就新开一条，occurrences 又极高，
 *     会稳定霸占 Top N 把别的教训挤出注入窗口
 *   - 实现「执行→观测→评估→提纯→知识→门控」闭环
 *   - 经验库目录由 EXPERIENCE_DIR 解析（scripts/experience），全局跨项目共享：
 *     失败模式（如「task-dag 应用 title 而非 name」）是 Harness 流程本身的规范，与具体项目无关
 *
 * @module experience
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('../lib/state')

/**
 * 经验库根目录 — 全局跨项目共享
 * 实际解析为 plugins/fsflow/scripts/experience（由 __dirname 推导，并非 ~/.codebuddy/）
 * 理由: 失败模式（如 "task-dag 应用 title 而非 name"）是 Harness 流程本身的规范，
 *       与具体项目无关，应在所有项目间共享。
 */
const EXPERIENCE_DIR = path.join(__dirname, '..', 'experience')

/** 失败模式库文件 */
const FAILURE_PATTERNS_FILE = path.join(EXPERIENCE_DIR, 'failure-patterns.json')

/** 失败案例归档目录 */
const FAILURES_ARCHIVE_DIR = path.join(EXPERIENCE_DIR, 'failures')

/** 度量洞察库文件（跨项目共享） */
const METRICS_INSIGHTS_FILE = path.join(EXPERIENCE_DIR, 'metrics-insights.json')

/** rootCause 去重摘要长度 */
const ROOT_CAUSE_KEY_LENGTH = 50

/**
 * 确保经验库目录结构存在
 */
function ensureExperienceDir () {
  if (!fs.existsSync(EXPERIENCE_DIR)) {
    fs.mkdirSync(EXPERIENCE_DIR, { recursive: true })
  }
  if (!fs.existsSync(FAILURES_ARCHIVE_DIR)) {
    fs.mkdirSync(FAILURES_ARCHIVE_DIR, { recursive: true })
  }
}

/**
 * 读取失败模式库
 * @returns {{ patterns: Array, version: string, lastUpdated: string }}
 */
function readFailurePatterns () {
  ensureExperienceDir()
  if (!fs.existsSync(FAILURE_PATTERNS_FILE)) {
    return { patterns: [], version: '2.0', lastUpdated: new Date().toISOString() }
  }
  try {
    return JSON.parse(fs.readFileSync(FAILURE_PATTERNS_FILE, 'utf-8'))
  } catch (e) {
    return { patterns: [], version: '2.0', lastUpdated: new Date().toISOString() }
  }
}

/**
 * 生成 rootCause 的去重摘要键（前 N 字符，忽略大小写和微小的文本差异）
 * @param {string} rootCause - 原始根因文本
 * @returns {string} 去重摘要键
 */
function rootCauseKey (rootCause) {
  if (!rootCause) return ''
  return rootCause.slice(0, ROOT_CAUSE_KEY_LENGTH).toLowerCase().trim()
}

/**
 * 记录一条失败模式
 * v2: 去重键从 phase+failureType 改为 phase+failureType+rootCauseKey，
 *     同一类型不同根因不再被合并。unknown 类型标记 needsManualReview。
 * @param {Object} pattern - 失败模式
 * @param {number} pattern.phase - Phase 编号
 * @param {string} pattern.failureType - 失败类型标识（如 'task_missing_title', 'unknown'）
 * @param {string} pattern.rootCause - 根因描述
 * @param {string} pattern.resolution - 解决方案
 * @param {string} pattern.storyId - Story ID
 * @param {string[]} [pattern.blockers] - 门控阻塞项
 */
function recordFailurePattern (pattern) {
  ensureExperienceDir()
  const data = readFailurePatterns()

  // 去重: phase + failureType + rootCauseKey 三维去重
  const rck = rootCauseKey(pattern.rootCause)
  const existingIdx = data.patterns.findIndex(
    p => p.phase === pattern.phase
      && p.failureType === pattern.failureType
      && rootCauseKey(p.rootCause) === rck
  )

  if (existingIdx >= 0) {
    // 已存在 → 累计次数 + 更新方案
    data.patterns[existingIdx].occurrences = (data.patterns[existingIdx].occurrences || 1) + 1
    data.patterns[existingIdx].lastSeen = new Date().toISOString()
    data.patterns[existingIdx].resolution = pattern.resolution // 更新为最新解决方案
  } else {
    // 新模式 → 首次记录
    const isUnknown = pattern.failureType === 'unknown'
    data.patterns.push({
      ...pattern,
      occurrences: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      // unknown 类型标记需人工补录
      needsManualReview: isUnknown || false,
      reviewStatus: isUnknown ? 'pending' : 'confirmed'
    })
  }

  data.lastUpdated = new Date().toISOString()
  fs.writeFileSync(FAILURE_PATTERNS_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 获取针对指定 Phase 的历史教训（用于注入 Agent prompt）
 * v2: 区分 unknown 类型，提醒需人工补录到 RECOVERY_SUGGESTIONS
 * v3: 只取当前阶段（phase 精确匹配）的教训，并按出现次数取 Top N，
 *     避免经验库增长导致 prompt 膨胀（对照腾讯 Multi-Agent 成本优化：
 *     只给 AI 当前需要的上下文，不把整个经验库灌进去）。
 * v3.1: 注入前按 failureType + resolution 归并同类项。
 *     写入侧的去重键是 phase+failureType+rootCause 前 50 字符（见文件头 v2.0 说明），
 *     这对「不同根因」是对的，但对 rootCause 里嵌了变量的模板化消息失效 ——
 *     如 dev_pass_scope_violation 的根因是「Agent 试图编辑 dev-pass 限域外的文件: <绝对路径>」，
 *     每个新文件路径都会新开一条 pattern，对策却完全相同。它们 occurrences 极高、
 *     恒排 Top N 之首，会把真正不同的教训挤出注入窗口。
 *     归并只在**读取/注入**这一侧做: 不改库里的数据（不同根因仍各自留档），
 *     只在同 failureType + 同 resolution 时合成一条、occurrences 相加、
 *     根因取代表值并标注「另 N 个」。
 * @param {number} phase - Phase 编号
 * @param {number} [maxItems=5] - 最多注入几条教训，超出按 occurrences 取 Top N
 * @returns {string} 注入到 prompt 的教训文本，无则返回空字符串
 */
function getLessonsForPhase (phase, maxItems = 5) {
  const data = readFailurePatterns()
  const relevant = data.patterns.filter(p => p.phase === phase)

  if (relevant.length === 0) return ''

  // 分为已确认和待审查两组
  const confirmedRaw = relevant.filter(p => !p.needsManualReview || p.reviewStatus === 'confirmed')
  const pending = relevant.filter(p => p.needsManualReview && p.reviewStatus === 'pending')

  // 同 failureType + 同 resolution 视为同一条教训（根因只是主语不同）
  const merged = []
  const byKey = new Map()
  for (const p of confirmedRaw) {
    const key = `${p.failureType} ${p.resolution}`
    const hit = byKey.get(key)
    if (hit) {
      hit.occurrences += (p.occurrences || 1)
      hit.variants += 1
      continue
    }
    const entry = {
      failureType: p.failureType,
      resolution: p.resolution,
      rootCause: p.rootCause,
      occurrences: p.occurrences || 1,
      variants: 1
    }
    byKey.set(key, entry)
    merged.push(entry)
  }

  const confirmed = merged
    .sort((a, b) => b.occurrences - a.occurrences) // 按出现次数降序，取最常踩的坑
    .slice(0, maxItems)

  const lines = confirmed.map(p => {
    const rootCause = p.variants > 1
      ? `${p.rootCause}（另有 ${p.variants - 1} 个同类根因，对策相同）`
      : p.rootCause
    return `  ⚠️ 历史教训 (${p.occurrences}次): ${p.failureType}\n     根因: ${rootCause}\n     对策: ${p.resolution}`
  })

  // unknown 类型提醒人工补录
  if (pending.length > 0) {
    lines.push('')
    lines.push(`  📋 待人工补录 (${pending.length} 条 unknown 模式):`)
    for (const p of pending) {
      lines.push(`     - failureType: unknown | 根因: ${p.rootCause.slice(0, 80)} | 出现 ${p.occurrences} 次`)
    }
    lines.push(`     → 请分析后补充到 policy.js RECOVERY_SUGGESTIONS 并设置 reviewStatus=confirmed`)
  }

  return `\n\n## 📚 历史经验教训 (Phase ${phase})\n以下问题曾在历史 Story 中出现，请注意避免:\n${lines.join('\n')}\n`
}

/**
 * 获取针对指定 Phase 的历史教训，转为结构化 Check List（供 task-dag.json 的 mustCheck 使用）
 *
 * 与 getLessonsForPhase 的区别：
 *   - getLessonsForPhase 返回 markdown 文本，注入 prompt 供 Agent 阅读
 *   - getLessonsAsChecklist 返回结构化数组，写进 task-dag.json 的 mustCheck，
 *     供检查层做「确定性验证」——教训是否真的在产物中体现了（而非靠 LLM 自我诊断）
 *
 * 指纹 fingerprint 由 phase + failureType 生成稳定 hash，供产物侧 AST 扫描比对。
 * check 字段是对策的可验证表述（如「组件中存在 onBeforeUnmount 清理逻辑」），
 * 由检查层遍历验证，而非解析 prompt 语义。
 *
 * @param {number} phase - Phase 编号（取该 phase 及其后置 phase 的教训，覆盖开发+审查阶段）
 * @returns {Array<{fingerprint: string, lesson: string, check: string, failureType: string, occurrences: number}>}
 */
function getLessonsAsChecklist (phase) {
  const data = readFailurePatterns()
  // 覆盖当前 phase 与后置 phase（开发 2 + 审查 3 的教训都应在开发前注入）
  const relevant = data.patterns.filter(p => {
    // 只取已确认的教训，pending（unknown 待补录）不转 check
    const confirmed = !p.needsManualReview || p.reviewStatus === 'confirmed'
    return confirmed && p.phase >= phase && p.phase <= phase + 1
  })

  return relevant.map(p => {
    // 稳定指纹：phase + failureType + rootCause 前 32 字符
    const key = `${p.phase}:${p.failureType}:${(p.rootCause || '').slice(0, 32)}`
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
    }
    const fingerprint = 'fp-' + Math.abs(hash).toString(36)

    return {
      fingerprint,
      failureType: p.failureType,
      lesson: p.rootCause || p.failureType,
      check: p.resolution || '',
      occurrences: p.occurrences || 1
    }
  })
}

/**
 * 归档失败案例（工作流失败时调用）
 * @param {string} storyId - Story ID
 * @param {Object} state - 最终状态快照
 * @param {string} failureAnalysis - 根因分析文本
 */
function archiveFailureCase (storyId, state, failureAnalysis) {
  ensureExperienceDir()
  const archiveDir = path.join(FAILURES_ARCHIVE_DIR, storyId)
  fs.mkdirSync(archiveDir, { recursive: true })

  // 归档状态快照
  fs.writeFileSync(
    path.join(archiveDir, 'e2e-state.snapshot.json'),
    JSON.stringify(state, null, 2),
    'utf-8'
  )

  // 归档失败分析
  fs.writeFileSync(
    path.join(archiveDir, 'failure-analysis.md'),
    failureAnalysis,
    'utf-8'
  )

  // 归档 trace（如果存在）
  const traceFile = path.join(getStoryDir(storyId), 'trace.jsonl')
  if (fs.existsSync(traceFile)) {
    fs.copyFileSync(traceFile, path.join(archiveDir, 'trace.jsonl'))
  }

  // 归档时间戳
  fs.writeFileSync(
    path.join(archiveDir, 'archived-at.txt'),
    new Date().toISOString(),
    'utf-8'
  )
}

/**
 * 获取失败模式统计摘要
 * v2: 增加 unknown 类型的统计
 * @returns {{ total: number, byPhase: Object, topFailures: Array, unknownCount: number }}
 */
function getFailureStats () {
  const data = readFailurePatterns()
  const byPhase = {}
  for (const p of data.patterns) {
    byPhase[p.phase] = (byPhase[p.phase] || 0) + p.occurrences
  }
  const topFailures = [...data.patterns]
    .sort((a, b) => (b.occurrences || 1) - (a.occurrences || 1))
    .slice(0, 5)
    .map(p => ({ phase: p.phase, type: p.failureType, occurrences: p.occurrences, needsManualReview: p.needsManualReview || false }))

  const unknownCount = data.patterns.filter(p => p.failureType === 'unknown').length

  return { total: data.patterns.length, byPhase, topFailures, unknownCount }
}

/**
 * 标记 unknown 类型为已确认（人工补录后调用）
 * @param {number} phase - Phase 编号
 * @param {string} rootCauseKeyStr - 去重摘要键（前50字符）
 * @param {string} confirmedType - 确认后的 failureType
 * @param {string} resolution - 确认后的解决方案
 * @returns {boolean} 是否成功标记
 */
function confirmUnknownPattern (phase, rootCauseKeyStr, confirmedType, resolution) {
  ensureExperienceDir()
  const data = readFailurePatterns()
  const rck = rootCauseKeyStr.toLowerCase().trim()

  const idx = data.patterns.findIndex(
    p => p.phase === phase
      && p.failureType === 'unknown'
      && rootCauseKey(p.rootCause) === rck
  )

  if (idx < 0) return false

  data.patterns[idx].failureType = confirmedType
  data.patterns[idx].resolution = resolution
  data.patterns[idx].needsManualReview = false
  data.patterns[idx].reviewStatus = 'confirmed'
  data.patterns[idx].lastReviewed = new Date().toISOString()
  data.lastUpdated = new Date().toISOString()

  fs.writeFileSync(FAILURE_PATTERNS_FILE, JSON.stringify(data, null, 2), 'utf-8')
  return true
}

/**
 * 从 Hook 拒绝事件中记录失败模式（供 session-stop.js 或主 Agent 调用）
 * @param {Object} recordFailure - Hook 输出的 recordFailure 字段
 * @param {string} recordFailure.failureType - 失败类型
 * @param {string} recordFailure.rootCause - 根因
 * @param {string} recordFailure.resolution - 解决方案
 * @param {number} phase - Phase 编号（Hook 场景中可能未知，用 -1 表示）
 * @param {string} [storyId] - Story ID
 */
function recordHookFailure (recordFailure, phase = -1, storyId = '') {
  if (!recordFailure || !recordFailure.failureType) return
  recordFailurePattern({
    phase: phase,
    failureType: recordFailure.failureType,
    rootCause: recordFailure.rootCause || '',
    resolution: recordFailure.resolution || '',
    storyId: storyId,
    blockers: []
  })
}

// ─── 度量洞察（跨项目通用经验） ──────────────────────────────

/**
 * 读取全局度量洞察库
 * @returns {{ version: string, totalProjects: number, totalStories: number, insights: Array, lastUpdated: string, _knownProjects?: string[] }}
 */
function readMetricsInsights () {
  ensureExperienceDir()
  if (!fs.existsSync(METRICS_INSIGHTS_FILE)) {
    return { version: '1.0', totalProjects: 0, totalStories: 0, insights: [], lastUpdated: new Date().toISOString() }
  }
  try {
    return JSON.parse(fs.readFileSync(METRICS_INSIGHTS_FILE, 'utf-8'))
  } catch (e) {
    return { version: '1.0', totalProjects: 0, totalStories: 0, insights: [], lastUpdated: new Date().toISOString() }
  }
}

/**
 * 将当前项目的度量洞察合并到全局经验库
 * 去重键: targetPhase + type（同一 Phase 同一类型视为同一洞察）
 * 合并策略: 累加 occurrences、合并 sourceProjects、更新 evidence
 * @param {Array<Object>} projectInsights - 当前项目新生成的洞察列表
 * @param {string} projectName - 当前项目名
 */
function mergeInsightsToGlobal (projectInsights, projectName) {
  ensureExperienceDir()
  const globalData = readMetricsInsights()

  if (!Array.isArray(globalData.insights)) {
    globalData.insights = []
  }
  if (!Array.isArray(globalData._knownProjects)) {
    globalData._knownProjects = []
  }

  for (const insight of projectInsights) {
    // 查找是否已有同类洞察（targetPhase + type 匹配）
    const existingIdx = globalData.insights.findIndex(
      i => i.targetPhase === insight.targetPhase && i.type === insight.type
    )

    if (existingIdx >= 0) {
      // 已存在 → 合并
      const existing = globalData.insights[existingIdx]
      existing.occurrences = (existing.occurrences || 1) + 1
      existing.lastSeen = new Date().toISOString()
      // 合并来源项目（去重）
      if (!Array.isArray(existing.sourceProjects)) {
        existing.sourceProjects = []
      }
      if (!existing.sourceProjects.includes(projectName)) {
        existing.sourceProjects.push(projectName)
      }
      // 更新证据和建议为最新数据
      existing.evidence = insight.evidence
      existing.recommendation = insight.recommendation
      existing.title = insight.title
      existing.description = insight.description
    } else {
      // 新洞察 → 首次记录
      globalData.insights.push({
        ...insight,
        sourceProjects: [projectName],
        occurrences: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      })
    }
  }

  // 更新全局统计
  globalData.totalStories = (globalData.totalStories || 0) + 1
  if (!globalData._knownProjects.includes(projectName)) {
    globalData._knownProjects.push(projectName)
  }
  globalData.totalProjects = globalData._knownProjects.length
  globalData.lastUpdated = new Date().toISOString()

  fs.writeFileSync(METRICS_INSIGHTS_FILE, JSON.stringify(globalData, null, 2), 'utf-8')
}

/**
 * 获取指定 Phase 的度量洞察（用于注入到 Agent prompt）
 * 从全局 metrics-insights.json 读取，按 targetPhase 过滤
 * v2: 只取当前 targetPhase 的洞察，并按 occurrences 取 Top N，避免随洞察库增长膨胀 prompt
 * @param {number} targetPhase - 目标 Phase（即将开始的 Phase）
 * @param {number} [maxItems=3] - 最多注入几条洞察
 * @returns {string} 注入到 prompt 的洞察文本，无则返回空字符串
 */
function getMetricsInsights (targetPhase, maxItems = 3) {
  const data = readMetricsInsights()
  if (!data.insights || data.insights.length === 0) return ''

  // 过滤目标 Phase 的洞察，按出现次数取 Top N
  const relevant = data.insights
    .filter(i => i.targetPhase === targetPhase)
    .sort((a, b) => (b.occurrences || 1) - (a.occurrences || 1))
    .slice(0, maxItems)
  if (relevant.length === 0) return ''

  const lines = relevant.map(i => {
    const icon = i.severity === 'warning' ? '⚠️' : '📊'
    const projects = Array.isArray(i.sourceProjects) ? i.sourceProjects.join(', ') : '未知'
    return `${icon} ${i.title}\n   分析: ${i.description}\n   建议: ${i.recommendation}\n   依据: ${i.evidence} (来源: ${projects}, ${i.occurrences || 1}次)`
  })

  return `\n## 📊 度量洞察 (跨 ${data.totalProjects} 个项目 ${data.totalStories} 个 Story)\n以下洞察来自跨项目历史度量聚合，请在当前 Phase 参考:\n${lines.join('\n')}\n`
}

module.exports = {
  EXPERIENCE_DIR,
  FAILURE_PATTERNS_FILE,
  METRICS_INSIGHTS_FILE,
  ROOT_CAUSE_KEY_LENGTH,
  readFailurePatterns,
  recordFailurePattern,
  getLessonsForPhase,
  getLessonsAsChecklist,
  archiveFailureCase,
  getFailureStats,
  confirmUnknownPattern,
  recordHookFailure,
  rootCauseKey,
  // 度量洞察
  readMetricsInsights,
  mergeInsightsToGlobal,
  getMetricsInsights
}
