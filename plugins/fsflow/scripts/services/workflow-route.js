// A light route reduces preparation work, never verification or authorization gates.
const path = require('path')
const { readStoryInput, readJsonArtifact, loadRepos } = require('../lib/state')
const FLAGS = ['crossModule', 'publicApiChanged', 'dependenciesChanged', 'dataMigration', 'securitySensitive']
function selectRoute (storyId, state = {}) {
  const input = readStoryInput(storyId)
  const requested = input?.workflowProfile || state.workflowProfile || 'full'
  const full = (...reasons) => ({ profile: 'full', requested, reasons })
  if (requested === 'full') return full('显式完整流程或旧流程未启用自动分流')
  if (!['auto', 'light'].includes(requested)) return full('无法识别的路线配置')
  const scope = readJsonArtifact(storyId, 'change-scope.json')
  if (!scope || scope._parseError) return full('尚无可核验的影响范围评估')
  if (scope.risk !== 'low' || FLAGS.some(k => scope[k] !== false)) return full('风险、依赖或边界变化不满足轻量条件')
  if (!Array.isArray(scope.evidence) || !scope.evidence.some(e => typeof e === 'string' && e.trim())) return full('缺少影响面查证依据')
  const repos = loadRepos(storyId)
  if (Object.keys(repos.repos).length !== 1 || state.hasFigmaDesign) return full('跨仓或设计稿还原保留独立规划')
  if (!Array.isArray(scope.files) || scope.files.length < 1 || scope.files.length > 3 || new Set(scope.files).size !== scope.files.length) return full('轻量范围须为 1–3 个明确文件')
  const unsafe = f => typeof f !== 'string' || !f.trim() || path.isAbsolute(f) ||
    /[\\*?\[\]{}]/.test(f) || f.split('/').some(p => !p || p === '.' || p === '..') ||
    !path.extname(f) || /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|.*config\.[^/]+|migrations?|auth|permissions?|security)(\/|$)/i.test(f)
  if (scope.files.some(unsafe)) return full('目录、通配范围或高风险配置不走轻量路线')
  const tasks = readJsonArtifact(storyId, 'task-dag.json')
  if (tasks && (tasks._parseError || !Array.isArray(tasks.tasks) || tasks.tasks.some(t =>
    !t || typeof t !== 'object' ||
    (t.project && t.project !== repos.primary) || (t.repoPath && (typeof t.repoPath !== 'string' || path.resolve(t.repoPath) !== path.resolve(repos.repos[repos.primary]))) ||
    !Array.isArray(t.files) || t.files.some(f => !scope.files.includes(f))))) return full('任务范围超出轻量评估，使用完整规划')
  return { profile: 'light', requested, reasons: ['单仓、低风险、至多 3 个明确文件，未改变接口/依赖/数据/权限边界'], files: scope.files }
}
module.exports = { selectRoute }
