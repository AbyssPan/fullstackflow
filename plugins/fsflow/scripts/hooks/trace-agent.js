#!/usr/bin/env node
// Optional host telemetry: missing/unsupported fields never block task execution.
const { readStdin, readStateFile, resolveHarnessStory } = require('../lib/state')
const trace = require('../lib/trace')
const { readEvents, normalizeUsage } = require('../services/workflow-metrics')
try {
  const event = JSON.parse(readStdin())
  if (['Agent', 'Task'].includes(event.tool_name)) {
    // v1.5 会话级激活: 按 session_id 解析本会话绑定的 Story（兼容旧单文件与唯一 pending）
    const resolution = resolveHarnessStory(event.session_id)
    if (resolution.active && resolution.storyId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(resolution.storyId)) {
      const id = resolution.storyId
      const state = readStateFile(id)
      const agent = event.tool_input?.subagent_type || event.tool_input?.name || 'agent'
      const invocationId = event.tool_use_id
      if (state && !state._parseError && state.status === 'running') {
        if (process.argv[2] === 'start') {
          // Without an ID, leave automatic correlation to the explicit CLI fallback.
          if (invocationId) trace.traceAgentSpawn(id, agent, '', { phase: state.phase, invocationId, source: 'hook', configuredModel: event.tool_input?.model })
        } else {
          const response = event.tool_response || {}
          const started = invocationId && readEvents(id).find(e => e.type === 'agent_spawn' && e.invocationId === invocationId)
          const background = event.tool_input?.run_in_background || response.is_async || response.status === 'running'
          if (started && !background) {
            const usage = normalizeUsage(response.usage || response)
            trace.traceAgentResult(id, agent, response.is_error || event.is_error ? 'failed' : 'completed', {
              invocationId, phase: started.phase, source: 'hook', usage,
              model: typeof response.model === 'string' ? response.model : typeof response.model_id === 'string' ? response.model_id : null,
              durationMs: Number.isSafeInteger(response.duration_ms) && response.duration_ms >= 0 ? response.duration_ms : undefined
            })
          }
        }
      }
    }
  }
} catch { /* no reliable host data: do not fabricate metrics */ }
console.log(JSON.stringify({ continue: true }))
