/** Deterministic recovery routing. Reports classify causes; scripts choose the phase. */
const fs = require('fs')
const path = require('path')
const { PLANS_DIR, PHASE_ARTIFACTS, PHASE_SLUGS } = require('../lib/state')

function planRecovery (storyId, phase) {
  if (phase !== 3 && phase !== 4) return null
  const sourceFile = phase === 3 ? 'code-review.json' : 'acceptance-verification.json'
  let report
  try { report = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, storyId, sourceFile), 'utf8')) } catch { return null }
  const issues = phase === 3
    ? (report.issues || []).filter(i => i.severity === 'BLOCKER' && i.status === 'open')
    : (report.results || []).filter(i => i.status === 'failed')
  if (!issues.length) return null
  const targets = { requirement: 0, planning: 1, implementation: 2, environment: phase, verification: phase }
  const causes = issues.map(i => i.failureKind || 'implementation') // legacy reports
  const uncertain = issues.some((i, n) => !(causes[n] in targets) ||
    (i.failureKind && (!i.failureReason || !i.failureReason.trim())))
  return {
    sourcePhase: phase,
    sourceFile,
    targetPhase: uncertain ? null : Math.min(...causes.map(c => targets[c])),
    causes: [...new Set(causes)],
    issues,
    description: uncertain
      ? '失败原因未明确：由原审查/测试 Agent 补充 failureKind 与 failureReason，禁止猜测回退阶段。'
      : '按失败原因恢复：需求→P0，规划→P1，实现→P2，环境/验证→当前阶段；保留更早阶段的有效产物。'
  }
}

// Archive invalidated artifacts, including the target phase. Keeping the target's old
// passing report would make dispatch immediately skip the very work being retried.
function invalidateArtifacts (storyId, state, targetPhase, archiveDir) {
  const dir = path.join(PLANS_DIR, storyId)
  fs.mkdirSync(archiveDir, { recursive: true })
  const files = new Set(['fix-verification.json', 'fix-context.md', 'failure-recovery.json'])
  for (let p = targetPhase; p < PHASE_SLUGS.length; p++) {
    for (const art of PHASE_ARTIFACTS[p]?.artifacts || []) if (art.fileName) files.add(art.fileName)
    files.add(`phase-${p}-summary.md`)
    if (state.phases?.[`${p}_${PHASE_SLUGS[p]}`]) state.phases[`${p}_${PHASE_SLUGS[p]}`].status = 'rolled_back'
  }
  // Retain source reports in the archive as evidence; never reuse stale pass/fail results.
  for (const file of files) {
    const src = path.join(dir, file)
    if (fs.existsSync(src)) fs.renameSync(src, path.join(archiveDir, file))
  }
}

module.exports = { planRecovery, invalidateArtifacts }
