const fs = require('fs')
const path = require('path')
const { PLANS_DIR, readStateFile, getPhaseName, PHASE_SLUGS } = require('../lib/state')

function readEvents (storyId) {
  try {
    return fs.readFileSync(path.join(PLANS_DIR, storyId, 'trace.jsonl'), 'utf8').split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [] } catch { return [] }
    })
  } catch { return [] }
}
const number = n => Number.isSafeInteger(n) && n >= 0 ? n : null
const modelName = value => typeof value === 'string' && value.trim() ? value.trim() : null
function configuredModel (agent) {
  const dir = path.join(__dirname, '../../agents')
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] || ''
    const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    if (name === agent) return modelName(text.match(/^model:\s*(.+)$/m)?.[1])
  }
  return null
}
function normalizeUsage (usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = number(usage.inputTokens ?? usage.input_tokens)
  const outputTokens = number(usage.outputTokens ?? usage.output_tokens)
  // Do not infer billed totals: hosts differ on whether cached tokens are part of input.
  const totalTokens = number(usage.totalTokens ?? usage.total_tokens)
  const cacheReadTokens = number(usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens)
  const cacheWriteTokens = number(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens)
  if ([inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens].every(n => n === null)) return null
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, source: 'host' }
}

function collectMetrics (storyId, now = Date.now()) {
  const state = readStateFile(storyId) || {}
  const events = readEvents(storyId)
  const phases = PHASE_SLUGS.slice(0, -1).map((slug, phase) => ({
    phase, name: getPhaseName(phase), status: state.phases?.[`${phase}_${slug}`]?.status || (state.phase === phase && state.status === 'running' ? 'running' : 'pending'),
    elapsedMs: null, agentMs: null, attempts: 0, failures: 0,
    models: [], configuredModels: [], modelCoverage: 0,
    tokens: { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, coverage: {}, reportedInvocations: 0, missingInvocations: 0 },
    recoveries: 0
  }))
  // Replay transitions to retain every visit, including repairs overwritten in state.phases.
  const transitions = events.filter(e => (e.type === 'phase_transition' && e.result === 'transitioned' && e.details) || e.type === 'failure_recovery')
  let phase = transitions.length ? Number(transitions[0].details?.fromPhase ?? transitions[0].from) : state.phase
  let since = Date.parse(state.phases?.[`${phase}_${PHASE_SLUGS[phase]}`]?.startedAt)
  // Only the original entry phase may start at Story creation. In old workflows
  // without transition history, do not assign the entire Story age to its current phase.
  if (phase === (state.bypass ? 2 : 0)) since = Date.parse(state.createdAt) || since
  if (transitions.length && phase !== (state.bypass ? 2 : 0)) {
    const firstAt = Date.parse(transitions[0].ts)
    if (since > firstAt) since = NaN // state may only retain a later retry's start
  }
  const addElapsed = until => {
    if (phases[phase] && Number.isFinite(since) && Number.isFinite(until) && until >= since) {
      phases[phase].elapsedMs = (phases[phase].elapsedMs || 0) + until - since
    }
  }
  for (const e of transitions) {
    const at = Date.parse(e.ts)
    if (!Number.isFinite(at) || (Number.isFinite(since) && at < since)) continue
    addElapsed(at)
    phase = Number(e.details?.toPhase ?? e.to)
    since = at
  }
  addElapsed(state.status === 'completed' || state.status === 'archived' ? Date.parse(state.completedAt || state.updatedAt) : now)
  const invocations = new Map()
  let sequence = 0
  for (const e of events) {
    if (e.type === 'fix_loop' || e.type === 'failure_recovery') {
      const p = Number(e.sourcePhase ?? e.from)
      if (phases[p]) phases[p].recoveries++
    }
    if (!['agent_spawn', 'agent_result'].includes(e.type)) continue
    const id = e.invocationId || e.details?.invocationId
    if (e.type === 'agent_spawn') {
      const key = id || `legacy-${sequence++}`
      if (!invocations.has(key)) invocations.set(key, { agent: e.agent, taskId: e.taskId || null, configuredModel: modelName(e.details?.configuredModel), phase: Number(e.phase ?? e.details?.phase), start: Date.parse(e.ts), result: null })
    } else {
      let record = id && invocations.get(id)
      if (!id) {
        const pending = [...invocations.values()].filter(i => i.agent === e.agent && !i.result)
        if (pending.length === 1) record = pending[0]
      }
      if (!record) {
        const key = id || `result-${sequence++}`
        record = invocations.get(key) || { agent: e.agent, phase: Number(e.phase ?? e.details?.phase), start: NaN }
        invocations.set(key, record)
      }
      if (!record.result) record.result = e
      else {
        // Enrich an incomplete host callback using the same invocation ID, without
        // adding tokens twice or replacing already recorded values.
        const old = record.result.details || {}
        const fresh = e.details || {}
        const usage = { ...(fresh.usage || {}) }
        for (const [key, value] of Object.entries(old.usage || {})) if (value !== null && value !== undefined) usage[key] = value
        record.result = { ...record.result, details: { ...fresh, ...old,
          model: old.model || fresh.model, durationMs: old.durationMs ?? fresh.durationMs, usage } }
      }
    }
  }
  let unassignedInvocations = 0
  const calls = []
  for (const [invocationId, invocation] of invocations) {
    const e = invocation.result
    const actualModel = modelName(e?.details?.model)
    const configModel = invocation.configuredModel || modelName(e?.details?.configuredModel)
    const usage = normalizeUsage(e?.details?.usage)
    const elapsed = e && Number.isFinite(invocation.start) ? number(Date.parse(e.ts) - invocation.start) : null
    const duration = number(e?.details?.durationMs) ?? elapsed
    calls.push({ invocationId, agent: invocation.agent, taskId: invocation.taskId || null,
      phase: Number.isInteger(invocation.phase) ? invocation.phase : null,
      configuredModel: configModel, model: actualModel, modelSource: actualModel ? 'host' : 'unavailable',
      status: e?.result || 'running', startedAt: Number.isFinite(invocation.start) ? new Date(invocation.start).toISOString() : null,
      finishedAt: e?.ts || null, durationMs: duration,
      durationSource: number(e?.details?.durationMs) !== null ? 'host' : elapsed !== null ? 'trace' : 'unavailable', usage })
    const row = phases[invocation.phase]
    if (!row) { unassignedInvocations++; continue }
    row.attempts++
    if (actualModel) row.modelCoverage++
    if (actualModel && !row.models.includes(actualModel)) row.models.push(actualModel)
    if (configModel && !row.configuredModels.includes(configModel)) row.configuredModels.push(configModel)
    if (e?.result === 'failed') row.failures++
    if (duration !== null) row.agentMs = (row.agentMs || 0) + duration
    if (usage?.totalTokens !== null && usage?.totalTokens !== undefined) row.tokens.reportedInvocations++
    else row.tokens.missingInvocations++
    for (const [key, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['total', 'totalTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens']]) {
      if (usage?.[field] !== null && usage?.[field] !== undefined) {
        row.tokens[key] = (row.tokens[key] || 0) + usage[field]
        row.tokens.coverage[key] = (row.tokens.coverage[key] || 0) + 1
      }
    }
  }
  const totals = { elapsedMs: null, agentMs: null, reportedTokens: null, reportedInvocations: 0, missingInvocations: unassignedInvocations, attempts: invocations.size }
  for (const p of phases) {
    for (const key of ['elapsedMs', 'agentMs']) if (p[key] !== null) totals[key] = (totals[key] || 0) + p[key]
    if (p.tokens.total !== null) totals.reportedTokens = (totals.reportedTokens || 0) + p.tokens.total
    totals.reportedInvocations += p.tokens.reportedInvocations
    totals.missingInvocations += p.tokens.missingInvocations
  }
  const suggestions = []
  if (!totals.reportedInvocations || totals.missingInvocations) suggestions.push('Token 数据未完整采集；先补齐宿主 usage，再比较成本，未采集不等于 0。')
  const slowest = [...phases].filter(p => p.elapsedMs > 0).sort((a, b) => b.elapsedMs - a.elapsedMs)[0]
  if (slowest) suggestions.push(`优先查看 P${slowest.phase} 的等待与执行记录；它占已记录阶段耗时的 ${Math.round(slowest.elapsedMs / totals.elapsedMs * 100)}%。`)
  const mostTokens = [...phases].filter(p => p.tokens.total > 0).sort((a, b) => b.tokens.total - a.tokens.total)[0]
  if (mostTokens) suggestions.push(`P${mostTokens.phase} 的已采集 Token 最多（${mostTokens.tokens.total}）；可检查重复读取、prompt 长度和重试次数，采集不全时不能据此比较总成本。`)
  if (phases.some(p => p.recoveries > 0)) suggestions.push('存在返修，优先检查失败证据和影响面，避免重复分析或全量重跑。')
  return { schemaVersion: 1, storyId, generatedAt: new Date(now).toISOString(),
    workflowRoute: require('./workflow-route').selectRoute(storyId, state),
    phases, totals, calls, unassignedInvocations, suggestions,
    measurement: '阶段耗时含用户等待、工具执行和离线间隔，不等于模型运行时间；Agent 耗时为各调用累计，并行时可能大于墙钟耗时。Token 为宿主报告的子 Agent 用量，不含未上报的主控上下文；缺失标为未采集，不推算。缓存 Token 单列，不重复加入总量；不推算费用。实际模型仅取宿主返回值，配置模型不是实际调用证明。' }
}
const duration = ms => ms === null ? '未采集' : `${(ms / 1000).toFixed(1)}s`
function formatMetrics (report) {
  const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
  const lines = [`# ${cell(report.storyId)} 执行度量`, '', `更新：${report.generatedAt}（UTC） · 路线：${report.workflowRoute.profile} · ${report.workflowRoute.reasons.map(cell).join('；')}`, '',
    '| 环节 / 状态 | 实际模型 | 配置模型 | 阶段耗时（含等待） | Agent 累计耗时 | 已采集 Token | 用量覆盖 | 调用 / 失败 / 返修 |', '|---|---|---|---:|---:|---:|---:|---:|']
  for (const p of report.phases) lines.push(`| P${p.phase} ${p.name} / ${p.status} | ${p.models.length ? p.models.map(cell).join(', ') + `（${p.modelCoverage}/${p.attempts}）` : '未采集'} | ${p.configuredModels.map(cell).join(', ') || '未采集'} | ${duration(p.elapsedMs)} | ${duration(p.agentMs)} | ${p.tokens.total === null ? '未采集' : p.tokens.total + (p.tokens.missingInvocations ? '（部分）' : '')} | ${p.tokens.reportedInvocations}/${p.attempts} | ${p.attempts} / ${p.failures} / ${p.recoveries} |`)
  lines.push(`| 合计 | — | — | ${duration(report.totals.elapsedMs)} | ${duration(report.totals.agentMs)} | ${report.totals.reportedTokens ?? '未采集'} | ${report.totals.reportedInvocations}/${report.totals.attempts} | — |`)
  lines.push('', '## Token 明细', '', '| 环节 | 输入 | 输出 | 缓存读取 | 缓存写入 |', '|---|---:|---:|---:|---:|')
  const token = (p, key) => p.tokens[key] === null ? '未采集' : `${p.tokens[key]}（${p.tokens.coverage[key]}/${p.attempts}）`
  for (const p of report.phases) lines.push(`| P${p.phase} | ${['input', 'output', 'cacheRead', 'cacheWrite'].map(k => token(p, k)).join(' | ')} |`)
  lines.push('', report.measurement, '', ...report.suggestions.map(s => `- ${s}`))
  return lines.join('\n')
}
function saveMetrics (storyId) {
  const state = readStateFile(storyId)
  if (!state || state._parseError || state.status === 'archived') return null
  const report = collectMetrics(storyId)
  const dir = path.join(PLANS_DIR, storyId)
  const files = { json: path.join(dir, 'workflow-metrics.json'), markdown: path.join(dir, 'workflow-metrics.md') }
  for (const [file, content] of [[files.json, JSON.stringify(report, null, 2) + '\n'], [files.markdown, formatMetrics(report) + '\n']]) {
    const temp = file + `.${process.pid}.${require('crypto').randomUUID()}.tmp`
    try { fs.writeFileSync(temp, content, 'utf8'); fs.renameSync(temp, file) } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  return { ...files, report }
}
module.exports = { readEvents, normalizeUsage, collectMetrics, formatMetrics, saveMetrics, configuredModel }
