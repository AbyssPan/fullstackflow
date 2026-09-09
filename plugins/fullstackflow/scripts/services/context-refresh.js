#!/usr/bin/env node
/**
 * context-refresh.js — Phase 完成后生成上下文摘要，供下个 Agent 替代完整对话历史
 *
 * 职责:
 *   - Phase 完成后生成 phase-N-summary.md（关键产出物 + 关键决策 + 待确认项状态 + 契约文件清单）
 *   - Phase 1 完成时把历史教训转成 mustCheck 清单注入 task-dag.json，
 *     让「注入的教训是否被规避」可被确定性检查（而非靠 LLM 自我诊断）
 *   - 提供摘要加载（loadLatestSummary）与契约文件枚举（getContractFiles），供下一轮上下文组装
 *
 * 用法:
 *   作为模块引用:
 *     const { generatePhaseSummary, loadLatestSummary } = require('./services/context-refresh')
 *
 * 使用场景:
 *   - commands/advance-phase.js Phase 推进成功后调用 generatePhaseSummary 落盘本 Phase 摘要
 *   - hooks/session-start.js 会话启动时用 loadLatestSummary 恢复上一 Phase 摘要，
 *     :175 用 getContractFiles 列出已完成 Phase 的契约文件注入上下文
 *   - services/prompt-builder.js 构造 Agent prompt 时加载摘要与契约清单作为下一轮输入
 *   - 本模块 injectMustCheck 依赖 services/experience.js 的 getLessonsAsChecklist 取已确认失败模式
 *
 * 说明:
 *   - 实现 Claude Code Level 4 Autocompact 的简化版: 只保存关键决策 + 契约路径 + 待办，不保存完整对话
 *   - 设计原则 (来自 Harness Engineering 指南): 对话历史占 60-80% context，是压缩核心；
 *     渐进式压缩（先轻量摘要，必要时升级）；预算跟踪需跨压缩边界
 *   - 无落盘产出物的 Phase（2/5/6/7）改从运行时真相源取证（getRuntimeEvidence），否则产出物段落为空
 *   - mustCheck 注入是「声明-消费一致性」在教训维度的落地：教训结构化写入，检查层确定性验证
 *
 * @module context-refresh
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getStoryDir, readJsonArtifact, readStateFile, getPhaseName, PHASE_SLUGS, PHASE_ARTIFACTS, loadRepos } = require('../lib/state')
const experience = require('./experience')

/**
 * 生成 Phase 完成后的上下文摘要
 * @param {string} storyId - Story ID
 * @param {number} phase - 刚完成的 Phase 编号
 * @returns {string} summary 文件路径
 */
function generatePhaseSummary (storyId, phase) {
  const storyDir = getStoryDir(storyId)
  const state = readStateFile(storyId)
  if (!state) return null

  const phaseName = getPhaseName(phase)
  const phaseSlug = PHASE_SLUGS[phase] || 'unknown'
  const summaryLines = [
    `# Phase ${phase} (${phaseName}) 完成摘要`,
    '',
    `> Story: ${storyId} | 完成时间: ${new Date().toISOString()}`,
    `> 本文件供下个 Agent 加载，替代完整对话历史。`,
    '',
    '## 关键产出物',
    ''
  ]

  // 根据 Phase 收集产出物信息
  const artifacts = getPhaseArtifacts(storyId, phase)
  for (const a of artifacts) {
    summaryLines.push(`- **${a.name}**: \`${a.path}\``)
    if (a.summary) summaryLines.push(`  - ${a.summary}`)
  }
  // 无落盘文件的 Phase（2/5/6/7）改从运行时真相源取证，否则本段落是空的
  if (artifacts.length === 0) {
    summaryLines.push(...getRuntimeEvidence(storyId, phase))
  }

  // 关键决策（从 e2e-state 中提取）
  summaryLines.push('', '## 关键决策', '')
  if (state.gateChecks && state.gateChecks.gateValidationResults) {
    const recentGates = state.gateChecks.gateValidationResults.filter(g => g.targetPhase <= phase + 1)
    for (const g of recentGates) {
      const status = g.pass ? '✅ 通过' : '❌ 失败'
      summaryLines.push(`- Phase ${g.targetPhase} 门控: ${status}`)
      if (g.warnings && g.warnings.length > 0) {
        summaryLines.push(`  - Warnings: ${g.warnings.join('; ')}`)
      }
    }
  }

  // 待确认项状态 — 从 open-questions.json 读取
  summaryLines.push('', '## 待确认项状态', '')
  const oqJsonPath = path.join(storyDir, 'open-questions.json')
  if (fs.existsSync(oqJsonPath)) {
    try {
      const oqData = JSON.parse(fs.readFileSync(oqJsonPath, 'utf-8'))
      if (Array.isArray(oqData.questions)) {
        const resolved = oqData.questions.filter(q => q.resolved)
        const unresolved = oqData.questions.filter(q => !q.resolved)
        summaryLines.push(`- 已解决: ${resolved.length} 项`)
        summaryLines.push(`- 未解决: ${unresolved.length} 项`)
        if (unresolved.length > 0) {
          summaryLines.push(`- ⚠️ 未解决项: ${unresolved.map(q => q.id).join(', ')}`)
        }
      }
    } catch (e) {
      summaryLines.push('- 无法解析 open-questions.json')
    }
  } else {
    summaryLines.push('- 无待确认项')
  }

  // 契约文件清单（供下个 Agent 快速加载）
  summaryLines.push('', '## 契约文件清单', '')
  const contracts = getContractFiles(storyId, phase)
  for (const c of contracts) {
    summaryLines.push(`- \`${c}\``)
  }

  const content = summaryLines.join('\n') + '\n'
  const summaryPath = path.join(storyDir, `phase-${phase}-summary.md`)
  fs.writeFileSync(summaryPath, content, 'utf-8')

  // Phase 1（任务规划）完成时，把历史教训转成 mustCheck 清单写进 task-dag.json
  // 这是「声明-消费一致性」在教训维度的落地：教训被结构化注入，供检查层确定性验证
  if (phase === 1) {
    injectMustCheck(storyId)
  }

  return summaryPath
}

/**
 * 将历史教训转成 mustCheck 清单，注入 task-dag.json
 *
 * 目的：让「注入的教训是否被规避」可被确定性检查（而非靠 LLM 自我诊断）。
 * 从 experience 读取已确认的失败模式（覆盖开发 Phase 2 + 审查 Phase 3 的教训），
 * 转成 { fingerprint, failureType, lesson, check } 结构，写进 task-dag.json 的 mustCheck。
 * 检查层（S3 阶段）遍历 mustCheck，判断每条 check 是否在代码产物中体现。
 *
 * @param {string} storyId - Story ID
 * @returns {boolean} 是否成功注入
 */
function injectMustCheck (storyId) {
  const storyDir = getStoryDir(storyId)
  const taskDagPath = path.join(storyDir, 'task-dag.json')
  if (!fs.existsSync(taskDagPath)) return false

  try {
    const lessons = experience.getLessonsAsChecklist(2)
    if (lessons.length === 0) return false

    const dag = JSON.parse(fs.readFileSync(taskDagPath, 'utf-8'))
    // 合并：保留已有 mustCheck（避免覆盖手工/已有项），按 fingerprint 去重追加
    const existing = Array.isArray(dag.mustCheck) ? dag.mustCheck : []
    const existingFps = new Set(existing.map(m => m.fingerprint))
    const toAdd = lessons.filter(l => !existingFps.has(l.fingerprint))

    if (toAdd.length === 0) return false

    dag.mustCheck = [...existing, ...toAdd]
    fs.writeFileSync(taskDagPath, JSON.stringify(dag, null, 2), 'utf-8')
    return true
  } catch (e) {
    // 注入失败不阻断主流程，仅静默返回 false
    return false
  }
}

/**
 * 获取指定 Phase 的产出物信息
 *
 * 产出物清单来自 state.js 的 PHASE_ARTIFACTS（唯一信源）。此处不再自建映射表——
 * 历史上本函数维护过第二份表，与 PHASE_ARTIFACTS 漂移（Phase 0 多出原型/Figma 两项）。
 * @param {string} storyId
 * @param {number} phase
 * @returns {Array<{name: string, path: string, summary?: string}>}
 */
function getPhaseArtifacts (storyId, phase) {
  const storyDir = getStoryDir(storyId)
  const artifacts = []

  const phaseDef = PHASE_ARTIFACTS[phase]
  const files = phaseDef
    ? phaseDef.artifacts.filter(a => a.fileName).map(a => a.fileName)
    : []
  for (const f of files) {
    const filePath = path.join(storyDir, f)
    if (fs.existsSync(filePath)) {
      let summary = ''
      // 为 JSON 文件生成简短摘要
      if (f.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (f === 'acceptance-criteria.json' && data.criteria) {
            summary = `${data.criteria.length} 条验收标准`
          } else if (f === 'open-questions.json' && data.questions) {
            const resolved = data.questions.filter(q => q.resolved).length
            summary = `${data.questions.length} 项 (${resolved} 已解决)`
          } else if (f === 'task-dag.json' && data.tasks) {
            summary = `${data.tasks.length} 个任务`
          } else if (f === 'code-review.json' && Array.isArray(data.issues)) {
            const openBlockers = data.issues.filter(i => i.severity === 'BLOCKER' && i.status === 'open').length
            summary = `${data.issues.length} 个问题 (${openBlockers} 个未修复 BLOCKER)`
          } else if (f === 'acceptance-verification.json' && data.results) {
            const passed = data.results.filter(r => r.status === 'passed').length
            summary = `${data.results.length} 条 (${passed} passed)`
          } else if (f === 'figma-frame-inventory.json' && data.frames) {
            summary = `${data.frames.length} 个 frame`
          }
        } catch (e) { /* ignore */ }
      }
      artifacts.push({ name: f, path: `.codebuddy/plans/${storyId}/${f}`, summary })
    }
  }

  return artifacts
}

// ─── 运行时取证（Phase 2/5/6/7 无落盘文件，从真相源提取产出物）────

/** 改动文件列表封顶条数 */
const CAP_LIMIT = 15

/** 取列表前 N 条，超出时追加「…还有 M 项」提示行 */
function capList (list, limit = CAP_LIMIT) {
  if (!Array.isArray(list)) return []
  if (list.length <= limit) return list.slice()
  return [...list.slice(0, limit), `…还有 ${list.length - limit} 项`]
}

/**
 * 逐行读取并解析 trace.jsonl，容错跳过坏行
 * @param {string} storyId - Story ID
 * @returns {Array<Object>} 解析成功的 trace 条目数组
 */
function readTrace (storyId) {
  const storyDir = getStoryDir(storyId)
  const traceFile = path.join(storyDir, 'trace.jsonl')
  if (!fs.existsSync(traceFile)) return []
  const entries = []
  let raw = ''
  try {
    raw = fs.readFileSync(traceFile, 'utf-8')
  } catch (e) {
    return []
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch (e) { /* 跳过坏行 */ }
  }
  return entries
}

/**
 * 安全执行 git 命令：带 timeout / maxBuffer / stderr 屏蔽，失败返回空串
 * @param {string} repoRoot - 仓库根路径
 * @param {string} args - git 子命令及参数
 * @returns {string} stdout 文本，失败时返回空串
 */
function safeGit (repoRoot, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 8000,
      maxBuffer: 1024 * 1024, // 1MB
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (e) {
    return ''
  }
}

/**
 * Phase 2 取证：列出多仓库的未提交改动文件
 * @param {string} storyId - Story ID
 * @returns {string[]} summary 段落行
 */
function evidenceCodeChanges (storyId) {
  const repos = loadRepos(storyId)
  const lines = []
  for (const [repoName, root] of Object.entries(repos.repos)) {
    // 逐仓库 try/catch：单仓库失败不连累其它仓库
    try {
      if (!root || !fs.existsSync(root)) {
        lines.push(`- \`${repoName}\`: 仓库目录不存在，跳过`)
        continue
      }
      const porcelain = safeGit(root, '-c core.quotepath=false status --porcelain')
      const shortstat = safeGit(root, 'diff --shortstat')
      if (!porcelain) {
        lines.push(`- \`${repoName}\`: 无未提交改动`)
        continue
      }
      // porcelain 前两字符是状态码（XY），其后可能是空格或路径；统一截掉前 3 字符再 trim
      const changed = porcelain.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      lines.push(`- \`${repoName}\`: ${changed.length} 个文件变更${shortstat ? ` (${shortstat})` : ''}`)
      for (const f of capList(changed)) {
        lines.push(`  - ${f}`)
      }
    } catch (e) {
      lines.push(`- \`${repoName}\`: 取证失败 (${e.message})`)
    }
  }
  return lines
}

/**
 * Phase 5 取证：从 trace 读 commit 事件，空则回退 git log -1
 * @param {string} storyId - Story ID
 * @returns {string[]} summary 段落行
 */
function evidenceGitCommits (storyId) {
  const lines = []
  const entries = readTrace(storyId)
  const gitEntries = entries.filter(e => e.type === 'git' && e.action === 'commit' && e.result === 'success')
  const commitDetails = gitEntries.map(e => e.details || {}).filter(d => d.hash)

  if (commitDetails.length > 0) {
    for (const d of capList(commitDetails)) {
      const hash = d.hash ? d.hash.slice(0, 8) : ''
      lines.push(`- commit \`${hash}\`${d.message ? ` — ${d.message}` : ''}${d.url ? ` (${d.url})` : ''}`)
    }
    return lines
  }

  // 回退：trace 无 commit 记录，用 git log 兜底并标注
  const repos = loadRepos(storyId)
  for (const [repoName, root] of Object.entries(repos.repos)) {
    try {
      if (!root || !fs.existsSync(root)) continue
      const log = safeGit(root, 'log -1 --oneline')
      if (log) {
        lines.push(`- \`${repoName}\`: ${log}（git log 回退，trace 无 commit 记录）`)
      }
    } catch (e) { /* 单仓库失败跳过 */ }
  }
  if (lines.length === 0) {
    lines.push('- 未找到 commit 记录（trace 与 git log 均无）')
  }
  return lines
}

/**
 * 简化解析 meta.yaml 的 git.hash 字段（仅匹配 git: 块下的 hash）
 * @param {string} content - meta.yaml 文本
 * @returns {string} hash 值，未找到返回空串
 */
function parseMetaHash (content) {
  const gitBlock = content.match(/git:\s*\n([\s\S]*?)(?=\n\S|$)/)
  if (!gitBlock) return ''
  const hashMatch = gitBlock[1].match(/hash:\s*"([^"]+)"/)
  return hashMatch ? hashMatch[1] : ''
}

/**
 * Phase 6 取证：陈述式比对 meta.yaml 记录 hash vs 当前 HEAD
 * 只陈述事实，不把 hash 不一致断言为失败（Phase 6 时序陷阱）。
 * @param {string} storyId - Story ID
 * @returns {string[]} summary 段落行
 */
function evidenceKbRefresh (storyId) {
  const lines = []
  const repos = loadRepos(storyId)
  let foundAny = false
  for (const [repoName, root] of Object.entries(repos.repos)) {
    try {
      if (!root || !fs.existsSync(root)) continue
      // 知识库根已从 .docs/llm-knowledge/frontend 改为 .docs/llm-knowledge（去掉 frontend 硬编码层）
      // 向后兼容：先找新路径，找不到回退旧 frontend 路径
      const newMetaPath = path.join(root, '.docs', 'llm-knowledge', 'meta.yaml')
      const legacyMetaPath = path.join(root, '.docs', 'llm-knowledge', 'frontend', 'meta.yaml')
      const metaPath = fs.existsSync(newMetaPath) ? newMetaPath : (fs.existsSync(legacyMetaPath) ? legacyMetaPath : null)
      if (!metaPath) continue
      foundAny = true
      let recordedHash = ''
      try {
        recordedHash = parseMetaHash(fs.readFileSync(metaPath, 'utf-8'))
      } catch (e) { /* 解析失败按空处理 */ }
      const head = safeGit(root, 'rev-parse HEAD')
      const stat = fs.statSync(metaPath)
      lines.push(`- \`${repoName}\`: 记录 hash \`${recordedHash ? recordedHash.slice(0, 8) : 'N/A'}\``)
      lines.push(`  - 当前 HEAD \`${head ? head.slice(0, 8) : 'N/A'}\``)
      lines.push(`  - 最后更新 ${stat.mtime.toISOString()}`)
      if (recordedHash && head && recordedHash !== head) {
        lines.push(`  - ⚠️ 记录 hash 与当前 HEAD 不一致（陈述事实，不判失败）`)
      }
    } catch (e) { /* 单仓库失败跳过 */ }
  }
  if (!foundAny) {
    lines.push('- 未找到知识库 meta.yaml（`.docs/llm-knowledge/meta.yaml`）')
  }
  return lines
}

/**
 * Phase 7 取证：从 trace 读部署事件，无则显式声明缺失
 * @param {string} storyId - Story ID
 * @returns {string[]} summary 段落行
 */
function evidenceDeploy (storyId) {
  const lines = []
  const entries = readTrace(storyId)
  // 部署证据可能记录为 git/deploy 事件或 agent_result，宽松匹配 details 含 env/buildNumber
  const deployEntries = entries.filter(e => {
    const d = e.details || {}
    return d.env || d.buildNumber || d.deployUrl || e.type === 'deploy'
  })
  if (deployEntries.length === 0) {
    lines.push('- ⚠️ 未记录部署证据（trace 中无 env/buildNumber/deployUrl）')
    return lines
  }
  for (const e of capList(deployEntries)) {
    const d = e.details || {}
    lines.push(`- 环境 \`${d.env || 'N/A'}\`${d.buildNumber ? ` 构建号 \`${d.buildNumber}\`` : ''}${d.deployUrl ? ` URL ${d.deployUrl}` : ''}`)
  }
  return lines
}

/**
 * 按 Phase 分发运行时取证，返回 summary 段落行
 * @param {string} storyId - Story ID
 * @param {number} phase - Phase 编号（2/5/6/7）
 * @returns {string[]} summary 段落行
 */
function getRuntimeEvidence (storyId, phase) {
  switch (phase) {
    case 2: return evidenceCodeChanges(storyId)
    case 5: return evidenceGitCommits(storyId)
    case 6: return evidenceKbRefresh(storyId)
    case 7: return evidenceDeploy(storyId)
    default: return []
  }
}

/**
 * 获取应加载的契约文件清单
 * @param {string} storyId
 * @param {number} phase
 * @returns {string[]}
 */
function getContractFiles (storyId, phase) {
  // 下个 Phase 需要的契约文件
  const nextPhase = phase + 1
  const storyDir = getStoryDir(storyId)
  const baseContracts = {
    1: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json', '.codebuddy/plans/' + storyId + '/task-dag.json'],
    2: ['.codebuddy/plans/' + storyId + '/task-dag.json', '.codebuddy/plans/' + storyId + '/acceptance-criteria.json'],
    3: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json'],
    4: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json', '.codebuddy/plans/' + storyId + '/acceptance-verification.json'],
    5: ['.codebuddy/plans/' + storyId + '/acceptance-verification.json'],
    6: [],
    7: []
  }
  const contracts = [...(baseContracts[nextPhase] || [])]

  // 修复回路上下文：Phase 3 审查时，如果存在 fix-request.json，
  // 增加修复相关契约文件供审查师加载（增量审查锚点）
  if (nextPhase === 3) {
    const fixRequestFile = path.join(storyDir, 'fix-request.json')
    if (fs.existsSync(fixRequestFile)) {
      contracts.push('.codebuddy/plans/' + storyId + '/fix-request.json')
      contracts.push('.codebuddy/plans/' + storyId + '/fix-context.md')
      const fixVerificationFile = path.join(storyDir, 'fix-verification.json')
      if (fs.existsSync(fixVerificationFile)) {
        contracts.push('.codebuddy/plans/' + storyId + '/fix-verification.json')
      }
    }
  }

  return contracts
}

/**
 * 加载指定 Story 的最新 Phase summary 内容
 * 用于将上轮产出物摘要注入到下个 Agent 的 prompt 或 session-start additionalContext 中
 * 只加载编号不超过 currentPhase 的 summary（避免显示后续 Phase 的摘要）
 * @param {string} storyId - Story ID
 * @param {number} [currentPhase=Infinity] - 当前 Phase 编号，只取不超过此编号的 summary
 * @param {number} [maxLines=200] - 最大行数限制，防止 summary 过大占用过多上下文
 * @returns {{ content: string, phase: number, path: string }|null} summary 信息，不存在时返回 null
 */
function loadLatestSummary (storyId, currentPhase = Infinity, maxLines = 200) {
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) return null

  // 找到编号不超过 currentPhase 的最大 summary 文件（降序排列取第一个符合条件的）
  const summaryRegex = /^phase-(\d+)-summary\.md$/
  const files = fs.readdirSync(storyDir)
    .filter(f => {
      const match = f.match(summaryRegex)
      if (!match) return false
      const phaseNum = parseInt(match[1], 10)
      return phaseNum <= currentPhase
    })
    .sort((a, b) => {
      const na = parseInt(a.match(summaryRegex)[1], 10)
      const nb = parseInt(b.match(summaryRegex)[1], 10)
      return nb - na
    })

  if (files.length === 0) return null

  // 读取最新的 summary（截取防止过大）
  const latestFile = files[0]
  const phaseNum = parseInt(latestFile.match(summaryRegex)[1], 10)
  const filePath = path.join(storyDir, latestFile)
  const rawContent = fs.readFileSync(filePath, 'utf-8')

  // 行数截取：超过 maxLines 时截断并添加提示
  const lines = rawContent.split('\n')
  let content
  if (lines.length > maxLines) {
    content = lines.slice(0, maxLines).join('\n') + `\n\n> ⚠️ summary 已截取前 ${maxLines} 行，完整内容见 ${latestFile}`
  } else {
    content = rawContent
  }

  return { content, phase: phaseNum, path: filePath }
}

module.exports = {
  generatePhaseSummary,
  injectMustCheck,
  getPhaseArtifacts,
  getContractFiles,
  loadLatestSummary,
  getRuntimeEvidence,
  readTrace
}
