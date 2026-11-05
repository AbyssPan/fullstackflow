#!/usr/bin/env node
/**
 * quick-task.js — 轻量快速修改任务（quick 模式）生命周期管理
 *
 * v1.5 定位: 需求交付后的小范围代码修改 / Bug 修复不走完整 8-Phase 流水线。
 * 单 Agent（主 Agent）执行，保留 dev-pass 编辑限域与证据留痕两条安全底线。
 *
 * 职责:
 *   - create: 生成 QUICK-YYYYMMDD-NN 任务目录，写 quick-task.json + e2e-state.json（mode=quick, phase=2）
 *             + pending 激活记录（输出 harnessEvent:'start' 供 PostToolUse 会话认领）
 *   - scope:  校验 quick-task.json 的 files[]（1-3 个文件、风险路径触发升格建议）并签发
 *             精确限域 dev-pass（Phase 2 语义复用，enforce-dev-pass 无需改动）
 *   - done:   校验证据非空，置终态（status=completed, phase=8），撤销 dev-pass，
 *             清除激活记录（含本会话绑定），写轻量知识回执 knowledge-receipt.json
 *   - escalate: 升格为完整 fixbugs 工作流（写 story-input.json + 重置 e2e-state 至 Phase 0），
 *             已完成的定位与修改保留在 Story 目录供需求分析师复用
 *   - status: 查看任务状态
 *
 * 用法:
 *   node quick-task.js create "<描述>" [--story <关联需求StoryId>]
 *   node quick-task.js scope <storyId>
 *   node quick-task.js done <storyId> [--note "<经验/教训一句话>"]
 *   node quick-task.js escalate <storyId> "<原因>"
 *   node quick-task.js status <storyId>
 *
 * 说明:
 *   - quick-task.json 不在状态文件保护清单内，Agent 可直接用文件工具填写
 *     files[] / acceptance / evidence；e2e-state.json 与 dev-pass.json 仍由本脚本独占维护。
 *   - 风险触发器: files[] 命中迁移/Schema/权限/接口契约等路径特征时拒绝签发 scope，
 *     要求走 escalate 升格完整流程（多 Agent 审查与测试兜底）。
 *   - done 的知识回执落 Story 目录；是否同步写 llm-knowledge changelog 片段由
 *     harness-quick skill 指引 Agent 判断（有知识库时追加，无则留回执即可）。
 *   - 状态文件保护: 本脚本已列入 enforce-state-file.js 的 AUTHORIZED_SCRIPTS。
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  assertValidStoryId,
  ensureStoryDir,
  readStateFile,
  writeStateFile,
  loadRepos,
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  writePendingHarnessRecord,
  clearHarnessRecordsForStory,
  purgeStaleHarnessRecords,
  getStoryDir
} = require('../lib/state')

/** quick 任务文件名 */
const QUICK_TASK_FILE = 'quick-task.json'

/** 知识回执文件名 */
const KNOWLEDGE_RECEIPT_FILE = 'knowledge-receipt.json'

/** scope 允许的最大文件数 */
const MAX_QUICK_FILES = 3

/**
 * quick 任务陈旧判定 TTL（小时）：最后一次脚本活动（create/scope/done）超过该时长
 * 视为疑似中断。可用环境变量 FSFLOW_QUICK_STALE_HOURS 覆盖，默认 24h。
 */
const QUICK_STALE_TTL_MS = (function () {
  const h = parseInt(process.env.FSFLOW_QUICK_STALE_HOURS, 10)
  return (isNaN(h) || h <= 0 ? 24 : h) * 3600 * 1000
})()

/** 风险路径特征：命中即拒绝 scope，建议升格完整流程 */
const RISK_PATH_PATTERNS = [
  /(?:^|\/)(?:migrations?|sql|ddl)\//i,          // 数据库迁移/DDL
  /(?:^|\/)schema[.\-/]/i,                        // Schema 定义
  /(?:permission|auth|acl|rbac)[.\-/]/i,          // 权限体系
  /(?:^|\/)(?:api|controller|router|routes?)[.\-/]/i, // 接口/路由层（跨模块影响面）
  /\.(?:sql|ddl|proto|graphql)$/i                 // 契约类文件后缀
]

/** 风险描述关键词（与路径特征同权重） */
const RISK_DESC_KEYWORDS = [/迁移|数据结构|表结构|权限|接口变更|联调|跨模块|schema/i]

// ─── 工具函数 ──────────────────────────────────────────────────

function fail (message, code = 1) {
  console.error(JSON.stringify({ ok: false, message }, null, 2))
  process.exit(code)
}

function ok (payload) {
  console.log(JSON.stringify(payload, null, 2))
}

/** 读取 quick-task.json */
function readQuickTask (storyId) {
  const filePath = path.join(getStoryDir(storyId), QUICK_TASK_FILE)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/** 写入 quick-task.json */
function writeQuickTask (storyId, task) {
  const filePath = path.join(getStoryDir(storyId), QUICK_TASK_FILE)
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8')
}

/** 生成 QUICK-YYYYMMDD-NN 任务 ID（扫描当日已有目录取最大序号 +1） */
function generateQuickId () {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `QUICK-${today}`
  let maxSeq = 0
  if (fs.existsSync(PLANS_DIR)) {
    const dirs = fs.readdirSync(PLANS_DIR, { withFileTypes: true })
    for (const d of dirs) {
      if (d.isDirectory() && d.name.startsWith(prefix)) {
        const seq = parseInt(d.name.split('-').pop(), 10)
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
      }
    }
  }
  return `${prefix}-${String(maxSeq + 1).padStart(2, '0')}`
}

/** 校验 quick 状态为进行中 */
function requireInProgress (storyId) {
  const state = readStateFile(storyId)
  if (!state || state._parseError) fail(`任务 ${storyId} 不存在或状态损坏`)
  if (state.mode !== 'quick') fail(`任务 ${storyId} 不是 quick 模式 (mode=${state.mode})`)
  if (state.quickStatus !== 'in_progress') fail(`任务 ${storyId} 已结束 (quickStatus=${state.quickStatus})`)
  return state
}

/** files[] 风险判定 */
function assessRisk (files, description) {
  const hits = []
  for (const f of files) {
    const p = typeof f === 'string' ? f : (f && f.path) || ''
    for (const pat of RISK_PATH_PATTERNS) {
      if (pat.test(p)) { hits.push(`路径命中风险特征: ${p}`); break }
    }
  }
  const desc = description || ''
  for (const kw of RISK_DESC_KEYWORDS) {
    if (kw.test(desc)) { hits.push(`描述命中风险关键词: ${desc}`); break }
  }
  return hits
}

/**
 * 取消 quick 任务（中断/放弃的收尾）：置 cancelled 终态、撤销 dev-pass、清除激活记录。
 * 与 done 的区别：不要求 evidence，不写知识回执。
 * @returns {{ ok: boolean, message: string }} 供 cmdCancel 与 create 自动清理复用
 */
function cancelQuickTask (storyId, reason) {
  const state = readStateFile(storyId)
  if (!state || state._parseError) return { ok: false, message: `任务 ${storyId} 不存在或状态损坏` }
  if (state.mode !== 'quick') return { ok: false, message: `任务 ${storyId} 不是 quick 模式` }
  if (state.quickStatus !== 'in_progress') return { ok: false, message: `任务 ${storyId} 已结束 (${state.quickStatus})，无需取消` }

  const now = new Date().toISOString()
  const task = readQuickTask(storyId)
  if (task && !task._parseError) {
    task.status = 'cancelled'
    task.cancelReason = (reason || '').trim() || '用户取消'
    task.updatedAt = now
    writeQuickTask(storyId, task)
  }

  state.status = 'cancelled'
  state.quickStatus = 'cancelled'
  state.phase = 8
  state.updatedAt = now
  writeStateFile(storyId, state)

  revokeDevPass(storyId)
  clearHarnessRecordsForStory(storyId)
  return { ok: true, message: `已取消 ${storyId}${reason ? `（${reason}）` : ''}` }
}

/**
 * 扫描所有 in_progress quick 任务，按陈旧度分流。
 * 未签发限域（files[] 为空且无有效 dev-pass）的陈旧任务可直接自动取消——
 * 它从未获得编辑权限，不存在需要保留的半成品；已签发限域的交由用户决定。
 * 非陈旧的 in_progress 任务一并列出（可能是其他窗口正在并行，也可能是用户
 * 取消回复后马上重新发起的旧任务——由 Agent 结合用户表述判断是否询问取消）。
 * @returns {{ autoCancelled: Array, staleActive: Array, activeQuickTasks: Array }}
 */
function collectStaleQuickTasks () {
  const autoCancelled = []
  const staleActive = []
  const activeQuickTasks = []
  if (!fs.existsSync(PLANS_DIR)) return { autoCancelled, staleActive, activeQuickTasks }
  for (const dir of fs.readdirSync(PLANS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('QUICK-')) continue
    const task = readQuickTask(dir.name)
    const state = readStateFile(dir.name)
    if (!task || task._parseError || task.status !== 'in_progress') continue
    if (!state || state._parseError || state.quickStatus !== 'in_progress') continue
    const times = [task.updatedAt, task.createdAt, state.updatedAt, state.createdAt]
      .map(t => Date.parse(t)).filter(t => !isNaN(t))
    const lastActivity = times.length > 0 ? Math.max(...times) : NaN
    const scoped = (Array.isArray(task.files) && task.files.length > 0) || checkDevPass(dir.name).valid
    if (isNaN(lastActivity) || (Date.now() - lastActivity) <= QUICK_STALE_TTL_MS) {
      // 非陈旧: 列为「其他进行中任务」，并行合法；若用户本次是取消后重新发起，
      // Agent 应结合该清单询问是否取消旧任务
      activeQuickTasks.push({
        storyId: dir.name,
        description: task.description,
        lastActivity: isNaN(lastActivity) ? '未知' : new Date(lastActivity).toISOString(),
        scoped
      })
      continue
    }
    if (!scoped) {
      const r = cancelQuickTask(dir.name, `超过 ${QUICK_STALE_TTL_MS / 3600000}h 无活动且从未签发限域，创建新任务时自动取消`)
      if (r.ok) autoCancelled.push({ storyId: dir.name, description: task.description })
    } else {
      staleActive.push({
        storyId: dir.name,
        description: task.description,
        lastActivity: new Date(lastActivity).toISOString(),
        scoped: true
      })
    }
  }
  return { autoCancelled, staleActive, activeQuickTasks }
}

// ─── 命令处理 ──────────────────────────────────────────────────

/**
 * 创建 quick 任务
 */
function cmdCreate (description, relatedStoryId) {
  const desc = (description || '').trim() || '快速修改'
  if (relatedStoryId) assertValidStoryId(relatedStoryId)

  // 清理过期激活残留 + 处理陈旧的 in_progress 任务（见 collectStaleQuickTasks）
  const purged = purgeStaleHarnessRecords()
  const stale = collectStaleQuickTasks()

  const id = generateQuickId()
  ensureStoryDir(id)
  const now = new Date().toISOString()

  const task = {
    storyId: id,
    mode: 'quick',
    description: desc,
    relatedStoryId: relatedStoryId || null,
    status: 'in_progress',
    files: [],
    acceptance: [],
    riskFlags: [],
    evidence: [],
    createdAt: now,
    updatedAt: now
  }
  writeQuickTask(id, task)

  // e2e-state: phase=2 复用 dev-pass 的 Phase 2 语义（enforce-dev-pass 无需特判）
  writeStateFile(id, {
    storyId: id,
    title: desc,
    phase: 2,
    status: 'running',
    mode: 'quick',
    quickStatus: 'in_progress',
    verificationMode: 'review-only',
    createdAt: now,
    updatedAt: now,
    phases: {
      '2_development': { status: 'running', startedAt: now }
    }
  })

  // pending 激活记录 + harnessEvent 协议（PostToolUse 认领为本会话绑定）
  writePendingHarnessRecord({
    active: true,
    storyId: id,
    title: desc,
    mode: 'quick',
    activatedAt: now
  })

  // 陈旧任务提示：自动取消的知会即可；已签发限域的需要用户决定（取消/继续/并行）
  let staleNote = ''
  if (stale.autoCancelled.length > 0) {
    staleNote += `\n   🧹 已自动取消中断的旧任务: ${stale.autoCancelled.map(t => `${t.storyId}("${t.description}")`).join(', ')}`
  }
  if (stale.staleActive.length > 0) {
    staleNote += `\n   ⚠ 以下旧 quick 任务超过 ${QUICK_STALE_TTL_MS / 3600000}h 无活动且已签发限域，请询问用户处理:\n${stale.staleActive.map(t => `      - ${t.storyId} "${t.description}" (最后活动 ${t.lastActivity})`).join('\n')}\n      用户放弃 → quick-task.js cancel <storyId>；要继续 → 在本会话 quick-task.js status <storyId> 后按 harness-quick 协议续做；两者都要 → 并行合法，无需处理`
  }
  if (stale.activeQuickTasks.length > 0) {
    staleNote += `\n   ⓘ 其他进行中的 quick 任务（并行合法，无需阻塞本次创建）:\n${stale.activeQuickTasks.map(t => `      - ${t.storyId} "${t.description}" (最后活动 ${t.lastActivity})`).join('\n')}\n      仅当用户表明本次是「取消后重新发起」时，才询问是否取消旧任务: quick-task.js cancel <storyId>`
  }
  if (purged.pendings.length + purged.bindings.length > 0) {
    staleNote += `\n   🧹 已清理 ${purged.pendings.length + purged.bindings.length} 条过期激活记录`
  }

  ok({
    ok: true,
    harnessEvent: 'start',
    message: `✅ quick 任务已创建\n   Story: ${id} "${desc}"\n   步骤: 1) 定位问题并填写 quick-task.json 的 files[]/acceptance  2) quick-task.js scope ${id} 签发限域  3) 修改与定向自测  4) 填写 evidence  5) quick-task.js done ${id}${staleNote}`,
    data: {
      storyId: id,
      title: desc,
      mode: 'quick',
      autoCancelled: stale.autoCancelled,
      staleActive: stale.staleActive,
      activeQuickTasks: stale.activeQuickTasks
    }
  })
}

/**
 * 签发限域: 校验 files[] 并签发精确 dev-pass
 */
function cmdScope (storyId) {
  const state = requireInProgress(storyId)
  const task = readQuickTask(storyId)
  if (!task || task._parseError) fail(`quick-task.json 不存在或损坏，请先填写`)

  const files = Array.isArray(task.files) ? task.files : []
  if (files.length === 0) fail('files[] 为空：请先定位问题，把待修改文件写入 quick-task.json 的 files[]')
  if (files.length > MAX_QUICK_FILES) {
    fail(`files[] 共 ${files.length} 个文件，超过 quick 上限 ${MAX_QUICK_FILES}。请执行 escalate 升格完整 fixbugs 流程`)
  }

  const riskHits = assessRisk(files, task.description)
  if (riskHits.length > 0) {
    fail(`风险触发，quick 模式不适合本任务:\n   ${riskHits.join('\n   ')}\n   请执行 quick-task.js escalate ${storyId} "<原因>" 升格完整流程`)
  }

  // 归一化为 { repo, path } 对象数组
  const repos = loadRepos(storyId)
  const allowedPaths = files.map(f => {
    if (typeof f === 'string') return { repo: repos.primary, path: f }
    return { repo: (f && f.repo) || repos.primary, path: (f && f.path) || '' }
  }).filter(p => p.path)

  const devPass = issueDevPass(storyId, 2 * 60 * 60 * 1000, allowedPaths)

  // 记录脚本侧活动时间（陈旧判定的依据之一：Agent 手改 quick-task.json 不更新时间戳）
  task.updatedAt = new Date().toISOString()
  writeQuickTask(storyId, task)

  ok({
    ok: true,
    message: `✅ 限域已签发 (${storyId})\n   允许编辑: ${allowedPaths.map(p => `${p.repo}:${p.path}`).join(', ')}\n   dev-pass 有效期 2 小时；完成后执行 quick-task.js done ${storyId}`,
    data: { storyId, allowedPaths, expiresAt: devPass.expiresAt }
  })
}

/**
 * 完成 quick 任务: 校验证据、置终态、撤销 dev-pass、清除激活记录、写知识回执
 */
function cmdDone (storyId, note) {
  requireInProgress(storyId)
  const task = readQuickTask(storyId)
  if (!task || task._parseError) fail('quick-task.json 不存在或损坏')

  const evidence = Array.isArray(task.evidence) ? task.evidence : []
  if (evidence.length === 0) {
    fail('evidence[] 为空：quick 跳过了独立审查与测试，定向自测证据是唯一质量底线，必须留痕')
  }

  const now = new Date().toISOString()
  task.status = 'done'
  task.updatedAt = now
  if (note) task.note = note
  writeQuickTask(storyId, task)

  // 知识回执（落 Story 目录；llm-knowledge changelog 片段由 Agent 按 skill 指引判断追加）
  const receipt = {
    storyId,
    relatedStoryId: task.relatedStoryId || null,
    description: task.description,
    files: task.files,
    evidence,
    note: note || '',
    completedAt: now
  }
  fs.writeFileSync(path.join(getStoryDir(storyId), KNOWLEDGE_RECEIPT_FILE), JSON.stringify(receipt, null, 2), 'utf-8')

  // 终态: status=completed + phase=8（session-stop autoEnd 语义一致）
  const state = readStateFile(storyId)
  state.status = 'completed'
  state.phase = 8
  state.quickStatus = 'done'
  state.updatedAt = now
  state.phases = state.phases || {}
  state.phases['2_development'] = { status: 'completed', startedAt: state.createdAt, completedAt: now }
  writeStateFile(storyId, state)

  // 撤销 dev-pass + 清除激活记录（含本会话绑定；PostToolUse 亦会按 harnessEvent:end 清理）
  revokeDevPass(storyId)
  clearHarnessRecordsForStory(storyId)

  ok({
    ok: true,
    harnessEvent: 'end',
    message: `✅ quick 任务已完成 (${storyId})\n   证据: ${evidence.length} 条，回执已写入 ${KNOWLEDGE_RECEIPT_FILE}\n   dev-pass 已撤销，src/ 编辑恢复受控`,
    data: { storyId }
  })
}

/**
 * 升格为完整 fixbugs 工作流
 */
function cmdEscalate (storyId, reason) {
  requireInProgress(storyId)
  const task = readQuickTask(storyId)
  if (!task || task._parseError) fail('quick-task.json 不存在或损坏')

  const now = new Date().toISOString()
  task.status = 'escalated'
  task.escalatedAt = now
  task.escalateReason = (reason || '').trim() || 'quick 风险触发升格'
  writeQuickTask(storyId, task)

  // story-input.json: 供完整流程的需求分析师摄入（quick 已做工作保留在 Story 目录）
  // 注意: schema 为 additionalProperties:false，仅使用白名单字段（title + sources.text）
  const escalateText = [
    `【quick 升格】${task.description}`,
    task.escalateReason ? `升格原因: ${task.escalateReason}` : '',
    `已定位文件: ${(Array.isArray(task.files) ? task.files : []).map(f => typeof f === 'string' ? f : f.path).join(', ')}`,
    `详见本 Story 目录 quick-task.json（已做的定位与修改保留，需求分析师可复用）`
  ].filter(Boolean).join('\n')
  fs.writeFileSync(path.join(getStoryDir(storyId), 'story-input.json'), JSON.stringify({
    mode: 'fixbugs',
    title: task.description,
    sources: { text: escalateText }
  }, null, 2), 'utf-8')

  // 重置 e2e-state 为完整 fixbugs 流程（Phase 0 起）
  writeStateFile(storyId, {
    storyId,
    title: task.description,
    phase: 0,
    status: 'running',
    mode: 'fixbugs',
    quickStatus: 'escalated',
    verificationMode: 'ask',
    createdAt: now,
    updatedAt: now,
    phases: {},
    escalatedFromQuick: true
  })

  // 撤销 quick 的 dev-pass（完整流程在 Phase 2 由 advance-phase 重新签发）
  revokeDevPass(storyId)

  ok({
    ok: true,
    message: `✅ 已升格为完整 fixbugs 工作流 (${storyId})\n   story-input.json 已生成，quick 定位结果保留在 Story 目录\n   下一步: node \${CLAUDE_PLUGIN_ROOT}/scripts/commands/dispatch.js ${storyId}`,
    data: { storyId, mode: 'fixbugs', escalateReason: task.escalateReason }
  })
}

/**
 * 查看任务状态
 */
function cmdStatus (storyId) {
  const task = readQuickTask(storyId)
  const state = readStateFile(storyId)
  if (!task && !state) fail(`任务 ${storyId} 不存在`)

  const pass = checkDevPass(storyId)
  ok({
    ok: true,
    storyId,
    quickTask: task,
    state: state ? {
      phase: state.phase, status: state.status, mode: state.mode,
      quickStatus: state.quickStatus, verificationMode: state.verificationMode
    } : null,
    devPass: { valid: pass.valid, reason: pass.reason }
  })
}

/**
 * 取消任务（用户明确放弃 / 中断收尾）
 */
function cmdCancel (storyId, reason) {
  if (!storyId) fail('用法: node quick-task.js cancel <storyId> [原因]')
  const r = cancelQuickTask(storyId, reason)
  if (!r.ok) fail(r.message)
  ok({
    ok: true,
    harnessEvent: 'end',
    message: `✅ ${r.message}\n   dev-pass 已撤销、激活记录已清除；被取消的任务不写知识回执`,
    data: { storyId, status: 'cancelled' }
  })
}

// ─── 入口 ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]
// 带值 flag 解析 positional 时连同其值一并跳过，防止 flag 值混入位置参数
// （如 create "描述" --story <id> 时 storyId 被拼进描述）
const VALUE_FLAGS = ['--story', '--note']
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (VALUE_FLAGS.includes(a)) { i++; continue }
  if (a.startsWith('--')) continue
  positional.push(a)
}
const flagValue = (name) => {
  const inline = args.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return null
}

switch (command) {
  case 'create':
    cmdCreate(positional.slice(1).join(' ').replace(/^["']|["']$/g, ''), flagValue('story'))
    break
  case 'scope':
    cmdScope(positional[1])
    break
  case 'done':
    cmdDone(positional[1], flagValue('note'))
    break
  case 'escalate':
    cmdEscalate(positional[1], positional.slice(2).join(' ').replace(/^["']|["']$/g, ''))
    break
  case 'cancel':
    cmdCancel(positional[1], positional.slice(2).join(' ').replace(/^["']|["']$/g, ''))
    break
  case 'status':
    cmdStatus(positional[1])
    break
  default:
    console.log([
      'FullstackFlow quick 模式 — 需求交付后的小范围修改/Bug 修复',
      '',
      '用法:',
      '  node quick-task.js create "<描述>" [--story <关联需求StoryId>]   创建 quick 任务',
      '  node quick-task.js scope <storyId>                              校验 files[] 并签发限域 dev-pass',
      '  node quick-task.js done <storyId> [--note "<经验一句话>"]        完成（校验证据、写知识回执）',
      '  node quick-task.js cancel <storyId> [原因]                       取消中断/放弃的任务',
      '  node quick-task.js escalate <storyId> "<原因>"                   升格为完整 fixbugs 工作流',
      '  node quick-task.js status <storyId>                             查看状态',
      '',
      '用户命令: /fsflow:quick',
      `陈旧判定: 最后活动超过 ${QUICK_STALE_TTL_MS / 3600000}h 的 in_progress 任务视为疑似中断`,
      '（未签发限域的在新任务创建时自动取消；已签发限域的报告给用户决定；可用 FSFLOW_QUICK_STALE_HOURS 覆盖）'
    ].join('\n'))
    process.exit(1)
}
