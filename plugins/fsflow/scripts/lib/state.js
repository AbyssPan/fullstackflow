#!/usr/bin/env node
/**
 * state.js — 工作流状态与契约的唯一读写层
 *
 * 职责:
 *   - 状态文件读写: e2e-state.json / repos.json / dev-pass.json / story-input.json 的 CRUD，按 Story 分目录管理
 *   - 路径解析: 归一化项目根路径（Windows Git Bash 兼容）、Story 目录、多仓库 repo 根路径反查
 *   - 契约校验: acceptance-criteria / open-questions / task-dag / acceptance-verification 等 JSON 契约的结构校验与交叉引用校验
 *   - 门控数据: PHASE_ARTIFACTS（产出物清单唯一信源）、PHASE_AGENTS（Phase→Agent 映射）、dev-pass 签发/撤销/续签
 *
 * 用法:
 *   作为模块引用:
 *     const { readStateFile, writeStateFile, checkPhaseArtifact } = require('../lib/state')
 *
 * 使用场景:
 *   - 被 hooks/ 复用（enforce-dev-pass / enforce-artifact / session-start / session-stop）:
 *     读 dev-pass 判断 src/ 编辑是否放行、读 e2e-state 判断是否跳 Phase
 *   - 被 services/ 复用（validate-phase-gate / validate-contracts / policy / schema-validator /
 *     prompt-builder / context-refresh / experience）: 做门控校验、契约校验、产出物清单与 prompt 组装
 *   - 被 commands/ 复用（create-workflow / advance-phase / dispatch / archive-story / harness-workflow）:
 *     做状态流转、dev-pass 生命周期管理、Story 目录创建与清理
 *   - 被 audit/ 三个脚本复用同一套校验逻辑，保证人工诊断与自动门控口径一致
 *
 * 说明:
 *   - v2.0 按 Story 分目录存储，文件命名去掉 storyId 前缀
 *     旧: plans/STORY-002-e2e-state.json
 *     新: plans/STORY-002/e2e-state.json
 *   - PHASE_ARTIFACTS 是产出物清单的**唯一信源**: 门控校验（checkPhaseArtifact）、
 *     prompt 产出要求（prompt-builder）、上下文摘要（context-refresh）都从此读取
 *   - PHASE_AGENTS 的 agent 字段是 Agent 注册名（frontmatter 的 name，英文），
 *     label 仅供人类阅读，禁止用于 Spawn
 *
 * @module state
 */

const fs = require('fs')
const path = require('path')

// ─── 路径常量 ──────────────────────────────────────────────────

/**
 * 归一化项目根路径，兼容 Windows 下 Git Bash / MSYS 风格路径
 *
 * 宿主在 Git Bash 环境下注入的 CLAUDE_PROJECT_DIR（CodeBuddy 兼容该别名）
 * 可能是 POSIX 风格（如 "/d/workfile/xxx" 或 "/c/Users/xxx"）。Windows 上
 * Node 的 path.join 会把 "/d/workfile" 当作当前盘符下的绝对路径，解析成
 * "d:\d\workfile\xxx"（多出一层盘符名目录），导致状态文件写错位置。
 * 此函数在 Windows 平台把 "/<盘符>/rest" 还原为 "<盘符>:/rest"。
 *
 * @param {string} p - 原始路径（可能是 POSIX 风格）
 * @returns {string} 归一化后的路径
 */
function normalizeProjectRoot (p) {
  if (!p) return p
  // 仅在 Windows 平台处理 Git Bash / MSYS 风格盘符路径
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p)
    if (m) {
      // "/d/workfile/xxx" → "d:/workfile/xxx"
      return `${m[1]}:/${m[2]}`
    }
  }
  return p
}

/** 项目根目录 */
const PROJECT_ROOT = normalizeProjectRoot(
  process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()
)

/** plans 目录 */
const PLANS_DIR = path.join(PROJECT_ROOT, '.codebuddy', 'plans')

// ─── Story ID 校验 ─────────────────────────────────────────────
// storyId 会直接拼进文件路径（getStoryDir）并作为 shell 参数传递，
// 未校验时可经「.. / 绝对路径」路径穿越或 shell 元字符注入越权读写。
// 统一收口：写入侧在 getStoryDir 断言，扫描侧在 listStoryDirs 过滤。

/** 合法 storyId：字母/数字开头，仅含字母、数字、连字符、下划线，最长 64 字符 */
const STORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * 判断 storyId 是否合法
 * @param {*} storyId
 * @returns {boolean}
 */
function isValidStoryId (storyId) {
  return typeof storyId === 'string' && STORY_ID_PATTERN.test(storyId)
}

/**
 * 断言 storyId 合法，非法时抛出带明确原因的错误
 * @param {*} storyId
 * @returns {string} 原样返回合法的 storyId
 */
function assertValidStoryId (storyId) {
  if (!isValidStoryId(storyId)) {
    throw new Error(
      `非法 storyId: ${JSON.stringify(storyId)} — 须以字母/数字开头，仅含字母、数字、-、_（最长 64 字符）`
    )
  }
  return storyId
}

// ─── 仓库注册表（repos.json，story 级独立）──────────────────

/**
 * 获取指定 Story 的 repos.json 路径（每个 story 独立配置）
 * @param {string} storyId - Story ID
 * @returns {string} 该 Story 的 repos.json 绝对路径
 */
function getReposFilePath (storyId) {
  return path.join(PLANS_DIR, storyId, 'repos.json')
}

/**
 * 获取项目根目录的 basename 作为默认仓库名
 * @returns {string} 默认仓库名（如 "userlive"）
 */
function getDefaultRepoName () {
  return path.basename(PROJECT_ROOT)
}

/**
 * 加载仓库注册表（repos.json，story 级独立）
 * 统一模式：无论单仓库还是多仓库，永远返回有效对象，不返回 null。
 * - storyId 指定且 repos.json 存在且合法 → 读取返回
 * - storyId 指定但 repos.json 不存在 → 返回单仓库默认（不写入文件）
 * - storyId 未指定（null/undefined）→ 返回单仓库默认（向后兼容）
 * @param {string} [storyId] - Story ID（story 级独立配置）
 * @returns {{ primary: string, repos: Object<string, string>, updatedAt?: string }}
 *   primary: 主仓库名；repos: 仓库名→绝对根路径映射
 */
function loadRepos (storyId) {
  // story 级配置优先
  if (storyId) {
    const storyReposFile = getReposFilePath(storyId)
    if (fs.existsSync(storyReposFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(storyReposFile, 'utf-8'))
        if (data && data.primary && data.repos && data.repos[data.primary]) {
          return data
        }
      } catch (e) { /* 解析失败，降级为单仓库默认 */ }
    }
  }
  // 单仓库默认（story 未配置或 storyId 未传）
  const name = getDefaultRepoName()
  return { primary: name, repos: { [name]: PROJECT_ROOT } }
}

/**
 * 确保 repos.json 存在（不存在则生成单仓库默认，story 级独立）
 * 在 `/fsflow:run` / `/fsflow:fixbugs` 建流和 create-workflow 时调用。
 * 多仓库场景由 AI 预先写入 repos.json，此函数检测到已存在则跳过（不覆盖）。
 * @param {string} storyId - Story ID（必填，story 级独立配置）
 * @param {Object} [overrideConfig] - 可选，强制写入的配置（{ primary, repos }），会覆盖已有文件
 * @returns {Object} 最终的 repos 配置
 */
function ensureReposJson (storyId, overrideConfig) {
  if (!storyId) throw new Error('ensureReposJson: storyId is required')
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) {
    fs.mkdirSync(storyDir, { recursive: true })
  }
  const reposFile = getReposFilePath(storyId)
  // 强制覆盖模式（AI 检测到多仓库后主动写入）
  if (overrideConfig && overrideConfig.primary && overrideConfig.repos) {
    const config = { ...overrideConfig, updatedAt: new Date().toISOString() }
    fs.writeFileSync(reposFile, JSON.stringify(config, null, 2), 'utf-8')
    return config
  }
  // 已存在则不覆盖（保留用户/AI 预配置）
  if (!fs.existsSync(reposFile)) {
    const name = getDefaultRepoName()
    const config = {
      primary: name,
      repos: { [name]: PROJECT_ROOT },
      updatedAt: new Date().toISOString()
    }
    fs.writeFileSync(reposFile, JSON.stringify(config, null, 2), 'utf-8')
    return config
  }
  return loadRepos(storyId)
}

/**
 * 根据仓库名获取仓库根路径
 * @param {string} [repoName] - 仓库名，缺省或未注册时回退到 primary
 * @param {Object} [repos] - 已加载的 repos 配置，不传则自动 loadRepos()
 * @returns {string} 仓库根绝对路径
 */
function getRepoRoot (repoName, repos) {
  const r = repos || loadRepos()
  const name = repoName || r.primary
  return r.repos[name] || r.repos[r.primary] || PROJECT_ROOT
}

/**
 * 根据文件绝对路径反查所属仓库（支持嵌套目录最长前缀匹配）
 * @param {string} absPath - 文件绝对路径
 * @param {Object|string} [reposOrStoryId] - 已加载的 repos 配置 或 storyId（string）
 *   传入 Object → 直接使用
 *   传入 string → 调用 loadRepos(storyId)
 *   不传 → 单仓库默认（向后兼容）
 * @returns {{ name: string, root: string, relPath: string }|null}
 *   匹配成功返回 { name, root, relPath }；不属于任何已注册仓库返回 null
 */
function getRepoForFile (absPath, reposOrStoryId) {
  let r
  if (typeof reposOrStoryId === 'string') {
    r = loadRepos(reposOrStoryId)
  } else if (reposOrStoryId && typeof reposOrStoryId === 'object') {
    r = reposOrStoryId
  } else {
    r = loadRepos()
  }
  if (!absPath) return null
  const norm = path.resolve(absPath).replace(/\\/g, '/')
  let bestMatch = null
  let bestLen = 0
  for (const [name, root] of Object.entries(r.repos)) {
    const rootNorm = path.resolve(root).replace(/\\/g, '/') + '/'
    if (norm.startsWith(rootNorm) && rootNorm.length > bestLen) {
      bestMatch = { name, root, relPath: norm.slice(rootNorm.length) }
      bestLen = rootNorm.length
    }
  }
  return bestMatch
}

// ─── Story 目录辅助 ────────────────────────────────────────────

/**
 * 获取指定 Story 的子目录路径
 * @param {string} storyId - Story ID
 * @returns {string} Story 子目录的绝对路径
 */
function getStoryDir (storyId) {
  assertValidStoryId(storyId)
  return path.join(PLANS_DIR, storyId)
}

/**
 * 确保 Story 目录存在（如不存在则创建）
 * @param {string} storyId - Story ID
 */
function ensureStoryDir (storyId) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 列出所有 Story 子目录
 * @returns {string[]} 目录名称列表（即 storyId）
 */
function listStoryDirs () {
  if (!fs.existsSync(PLANS_DIR)) return []
  return fs.readdirSync(PLANS_DIR).filter(d => {
    // 过滤非法目录名：含路径穿越 / shell 元字符的目录绝不进入后续处理链路
    if (!isValidStoryId(d)) return false
    const stat = fs.statSync(path.join(PLANS_DIR, d))
    return stat.isDirectory()
  })
}

// ─── Phase 定义 ─────────────────────────────────────────────────

/** Phase slug 映射 (0-8) */
const PHASE_SLUGS = [
  'requirement_analysis',    // 0
  'task_planning',           // 1
  'development',             // 2
  'code_review',             // 3
  'e2e_verification',        // 4
  'git_submit',              // 5
  'knowledge_base_update',   // 6
  'deployment',              // 7
  'completed'                // 8 — 工作流终态
]

/** Phase 中文名称 */
const PHASE_NAMES = [
  '需求分析',       // 0
  '任务规划',       // 1
  '代码开发',       // 2
  '代码审查',       // 3
  '功能测试',       // 4
  'Git提交',        // 5
  '合入版本知识核验', // 6
  '云端部署',       // 7
  '工作流完成'      // 8 — 工作流终态
]

/**
 * 每个 Phase 的产出物文件名模式（新版：无 storyId 前缀）
 *
 * 本表是产出物清单的**唯一信源**: 门控校验（checkPhaseArtifact）、
 * prompt 产出要求（prompt-builder）、上下文摘要（context-refresh）都从此读取。
 *
 * `optional: true` 的产出物按条件产出（如原型/Figma 视 Story 输入而定），
 * 门控不因其缺失而失败，但存在时会进摘要与 prompt。判定逻辑各自独立:
 *   - prototype-analysis.md   → gateChecks.prototypeRequired
 *   - figma-frame-inventory.json → state.hasFigmaDesign
 */
const PHASE_ARTIFACTS = {
  0: {
    artifacts: [
      { fileName: 'requirement-analysis.md', description: '需求分析文档', contract: false },
      { fileName: 'acceptance-criteria.json', description: '验收标准契约', contract: true },
      { fileName: 'open-questions.json', description: '待确认项契约', contract: true },
      { fileName: 'prototype-analysis.md', description: '原型分析文档（有原型链接时产出）', contract: false, optional: true }
    ]
  },
  1: {
    artifacts: [
      { fileName: 'task-dag.md', description: '任务 DAG 文档', contract: false },
      { fileName: 'task-dag.json', description: '任务 DAG 契约', contract: true },
      { fileName: 'figma-frame-inventory.json', description: 'Figma Frame 清单（有 Figma 设计稿时产出，任务规划师拆 task 时只针对相关组件拉取，每个 frame 含 id/name/link/type/rect 及可选 designSpec 设计规格摘要）', contract: true, optional: true, requiredWhen: 'hasFigmaDesign' }
    ]
  },
  2: { artifacts: [{ fileName: null, description: '代码变更（git diff）', contract: false }] },
  3: { artifacts: [{ fileName: 'code-review.json', description: '代码审查结构化数据(JSON格式，唯一产出物)', contract: true }] },
  4: {
    artifacts: [
      { fileName: 'test-report.md', description: '测试报告', contract: false },
      { fileName: 'acceptance-verification.json', description: '验收对账契约', contract: true }
    ]
  },
  5: { artifacts: [{ fileName: null, description: 'Git commit + push', contract: false }] },
  6: { artifacts: [{ fileName: null, description: '用户同意后已增量更新；用户拒绝更新或未初始化时已留痕跳过', contract: false }] },
  7: { artifacts: [{ fileName: null, description: '部署 URL + 构建号', contract: false }] }
}

// ─── Phase → Agent 映射 ──────────────────────────────────────────

/**
 * 每个 Phase 应由哪个 Agent 承担 + 该 Agent 的任务指令。
 *
 * 设计说明:
 *   - `agent` 是 Agent 的**注册名**（agent 文件 frontmatter 的 `name` 字段，英文）。
 *     Agent 文件名和正文标题是中文，但注册键是英文 name——传中文名无法解析到 Agent。
 *   - `label` 仅供人类阅读（日志/文档），禁止用于 Spawn。
 *   - Phase→Agent 是确定性查表，不需要 LLM 推理。
 *     此表取代了原 agents/dispatcher.md 中的映射表。
 *   - Phase 8 为终态，无 Agent。
 */
const PHASE_AGENTS = {
  0: {
    agent: 'requirement-analyst',
    label: '需求分析师',
    instruction: '启动后先执行唯一的知识库前置确认：缺库时经用户确认后初始化并全量生成，或记录用户拒绝；然后读取需求输入，产出需求分析文档、可测试的验收标准和待确认问题'
  },
  1: {
    agent: 'task-planner',
    label: '任务规划师',
    instruction: '基于 Phase 0 产出物，将需求拆解为可并行的任务 DAG，并在 task-dag.json 的 files[] 中列全所有待修改文件（该字段决定 Phase 2 的写入范围）'
  },
  2: {
    agent: 'fullstack-developer',
    label: '全栈开发工程师',
    instruction: '按 task-dag.json 的批次执行开发任务。同一 batch 内的任务可并行 Spawn 多个开发者 Agent，batch 之间串行；使用 Phase 0 已准备好的知识库上下文，不再执行初始化确认'
  },
  3: {
    agent: 'code-reviewer',
    label: '代码审查师',
    instruction: '审查本 Story 的代码变更（git diff），产出 code-review.json。若存在 fix-request.json 说明是修复回路复查，需做增量审查'
  },
  4: {
    agent: 'test-engineer',
    label: '测试工程师',
    instruction: '逐条验证 acceptance-criteria.json 中的 AC 是否通过，产出 test-report.md + acceptance-verification.json'
  },
  5: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '提交前按已获授权执行 kb-update，核实规格并记录按域维护回执；把代码与知识一起暂存，通过 staged 严格检查后执行已授权的 git commit/push/MR，目标分支沿用用户指定。禁止使用 --no-verify'
  },
  6: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '核验 Phase 5 提交前更新的知识与实际合入版本：meta.yaml 不存在时直接留痕跳过；维护模式运行 kb-maintenance.js check --ref <实际合入提交> --strict，复用已确认的更新或延期结果。无法取得合入版本或检查失败则记录 completed_with_errors。旧任务尚未维护时回功能分支补充 MR，不直接覆盖主分支。不询问初始化，不初始化、不全量生成，不重复生成知识正文'
  },
  7: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '发布收尾：前端项目通过 devops MCP 触发云端构建和部署，回报部署 URL + 构建号；后端项目跳过云端部署，确认 MR 合并后汇报分支与变更清单即收尾'
  }
}

/**
 * 获取指定 Phase 的 Agent 信息
 * @param {number} phase - Phase 编号
 * @returns {{ agent: string, label: string, instruction: string }|null} 终态(8)或越界返回 null
 */
function getPhaseAgent (phase) {
  return PHASE_AGENTS[phase] || null
}

// ─── 契约文件常量 ─────────────────────────────────────────────────

/** 契约 JSON 文件名 */
const ACCEPTANCE_CRITERIA_FILE = 'acceptance-criteria.json'
const OPEN_QUESTIONS_FILE = 'open-questions.json'
const TASK_DAG_JSON_FILE = 'task-dag.json'
const ACCEPTANCE_VERIFICATION_FILE = 'acceptance-verification.json'

/**
 * Story 原始输入契约文件名
 *
 * 主 Agent 从用户消息提取参数写入此文件后即完成职责，不做任何分析。
 * 需求分析师在 Phase 0 读取它，自行决定检索策略（含 fixbugs 模式下调用
 * tapd-bug-analyzer skill）。这样「分析」始终发生在需求分析师上下文内，
 * 不会因跨 Agent 传递而丢失中间推理。
 */
const STORY_INPUT_FILE = 'story-input.json'

/** 🌐 Figma 设计稿清单文件名 */
const FIGMA_FRAME_INVENTORY_FILE = 'figma-frame-inventory.json'

// ─── stdin 读取 ─────────────────────────────────────────────────

/**
 * 读取 stdin 全部内容（Windows 兼容）
 * 使用 fs.readSync 从 fd 0 读取，避免 Windows 上 process.stdin 的异步问题。
 * @returns {string} stdin 内容字符串
 */
function readStdin () {
  const chunks = []
  try {
    const buf = Buffer.alloc(65536)
    const fd = 0
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, 4096, null)
      if (bytesRead === 0) break
      chunks.push(buf.slice(0, bytesRead))
    }
    return Buffer.concat(chunks).toString('utf-8')
  } catch (e) {
    try {
      const fd = fs.openSync(process.stdin.fd, 'r')
      const buf = Buffer.alloc(65536)
      const bytesRead = fs.readSync(fd, buf, 0, 65536, null)
      fs.closeSync(fd)
      if (bytesRead > 0) {
        return buf.toString('utf-8', 0, bytesRead)
      }
      return ''
    } catch (e2) {
      return ''
    }
  }
}

// ─── 文件路径检查 ───────────────────────────────────────────────

/**
 * 检查文件路径是否在某个已注册仓库的 src/ 目录下（需要保护的代码区域）
 * 统一模式：基于 repos.json 判断，单仓库时 repos.json 缺省即 primary 仓库。
 * @param {string} filePath - 文件路径（相对或绝对）
 * @returns {boolean} 是否属于已注册仓库的 src/
 */
function isSrcFile (filePath) {
  if (!filePath) return false
  const normalized = path.normalize(filePath).replace(/\\/g, '/')
  // 快速过滤：不含 /src/ 的路径直接排除
  if (!normalized.includes('/src/') && !normalized.startsWith('src/')) return false
  // 统一模式：确认属于某个已注册仓库（单仓库时自动匹配 primary）
  const repoInfo = getRepoForFile(filePath)
  return repoInfo !== null
}

/**
 * 检查文件路径是否为 e2e-state.json 状态文件
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isStateFile (filePath) {
  if (!filePath) return false
  const normalized = path.normalize(filePath).replace(/\\/g, '/')
  return normalized.endsWith('/e2e-state.json') && normalized.includes('/plans/')
}

// ─── 状态文件操作 ───────────────────────────────────────────────

/**
 * 读取并解析 e2e-state.json
 * @param {string} storyId - Story ID
 * @returns {Object|null} 状态对象，文件不存在时返回 null
 */
function readStateFile (storyId) {
  const filePath = path.join(getStoryDir(storyId), 'e2e-state.json')
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 写入 e2e-state.json
 * @param {string} storyId - Story ID
 * @param {Object} state - 状态对象
 */
function writeStateFile (storyId, state) {
  ensureStoryDir(storyId)
  const filePath = path.join(getStoryDir(storyId), 'e2e-state.json')
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * 查找所有活跃的工作流（status 为 running 或 paused）
 * @returns {Array<{storyId: string, state: Object}>} 活跃的工作流列表
 */
function findActiveWorkflows () {
  const dirs = listStoryDirs()
  const workflows = []

  for (const dir of dirs) {
    const stateFile = path.join(PLANS_DIR, dir, 'e2e-state.json')
    if (!fs.existsSync(stateFile)) continue

    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      if (state.status === 'running' || state.status === 'paused') {
        workflows.push({ storyId: dir, state })
      }
    } catch (e) {
      // JSON 解析失败，忽略
    }
  }

  return workflows
}

/**
 * 检查是否有活跃的 e2e 工作流
 * @returns {boolean}
 */
function hasActiveWorkflow () {
  return findActiveWorkflows().length > 0
}

/**
 * 检查指定 Phase 是否已完成
 * @param {Object} state - 状态对象
 * @param {number} phaseNum - Phase 编号
 * @returns {boolean}
 */
function isPhaseCompleted (state, phaseNum) {
  const phaseKey = `${phaseNum}_${PHASE_SLUGS[phaseNum]}`
  const phaseState = state?.phases?.[phaseKey]
  return phaseState?.status === 'completed'
}

/**
 * 获取 Phase 的 slug 名称
 * @param {number} phaseNum
 * @returns {string}
 */
function getPhaseSlug (phaseNum) {
  return PHASE_SLUGS[phaseNum] || 'unknown'
}

/**
 * 获取 Phase 的中文名称
 * @param {number} phaseNum
 * @returns {string}
 */
function getPhaseName (phaseNum) {
  return PHASE_NAMES[phaseNum] || '未知'
}

// ─── 产出物检查 ─────────────────────────────────────────────────

/**
 * 检查指定 Phase 的产出物文件是否存在
 * 新版支持每个 Phase 多个产出物（含契约 JSON），任意**必需** artifact 不存在即返回 exists=false。
 * `optional: true` 的产出物按条件产出（原型/Figma），不参与门控判定；
 * 但若同时声明了 `requiredWhen: 'hasFigmaDesign'` 且传入了 state，则该条件成立时升级为必需。
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - Phase 编号
 * @param {Object} [state] - e2e-state 对象，用于判定 requiredWhen 条件；不传则条件产出物一律按可选处理
 * @returns {{ exists: boolean, missing: Array<{path:string, description:string}>, description: string }}
 */
function checkPhaseArtifact (storyId, phaseNum, state) {
  const phaseDef = PHASE_ARTIFACTS[phaseNum]
  if (!phaseDef || !phaseDef.artifacts) {
    return { exists: true, missing: [], description: '无' }
  }

  const required = phaseDef.artifacts.filter(a => {
    if (!a.fileName) return false
    if (!a.optional) return true
    // 条件必需：仅当传入 state 且条件成立时参与门控
    return Boolean(state) && a.requiredWhen === 'hasFigmaDesign' && hasFigmaDesign(state)
  })
  const missing = []
  for (const artifact of required) {
    const filePath = path.join(getStoryDir(storyId), artifact.fileName)
    if (!fs.existsSync(filePath)) {
      missing.push({ path: filePath, description: artifact.description, fileName: artifact.fileName })
    }
  }

  return {
    exists: missing.length === 0,
    missing,
    description: required.map(a => a.description).join(', ')
  }
}

/**
 * 读取 Story 原始输入契约（story-input.json）
 * @param {string} storyId - Story ID
 * @returns {Object|null} 解析后的对象；文件不存在返回 null，解析失败返回 { _parseError }
 */
function readStoryInput (storyId) {
  const filePath = path.join(getStoryDir(storyId), STORY_INPUT_FILE)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 获取 Story 的工作流模式
 *
 * 优先取 story-input.json 的 mode；缺失时回退到 e2e-state.json 的 mode
 * （create-workflow.js 会把 --mode 落到状态文件，供 story-input.json
 * 尚未写入或已被清理的场景使用）。都没有则默认 'run'。
 *
 * @param {string} storyId - Story ID
 * @returns {'run'|'fixbugs'}
 */
function getStoryMode (storyId) {
  const input = readStoryInput(storyId)
  if (input && !input._parseError && (input.mode === 'run' || input.mode === 'fixbugs')) {
    return input.mode
  }
  const state = readStateFile(storyId)
  if (state && (state.mode === 'run' || state.mode === 'fixbugs')) {
    return state.mode
  }
  return 'run'
}

/**
 * 探测 story-input.json 里是否提供了 Figma 设计稿链接
 *
 * 历史问题: `hasFigmaDesign` 只来自 `--figma` CLI flag，而唯一入口
 * `harness-workflow.js` 调 createWorkflow 时该参数硬编码 false，导致三道
 * Figma 门控（validate-phase-gate.js 的 hasFigmaFrameInventoryIfDesign /
 * hasFigmaMapIfDesign / task figmaNodeId 校验）在正常流程下永远不触发。
 *
 * 现以 story-input.json 的 `sources.figmaUrls` 为信源自动推导，`--figma`
 * 降级为手工覆盖开关（无 story-input.json 时仍可强制开启）。
 *
 * @param {string} storyId - Story ID
 * @returns {{ hasFigma: boolean, urls: string[], reason: string }}
 */
function detectFigmaSource (storyId) {
  const input = readStoryInput(storyId)
  if (!input || input._parseError) {
    return { hasFigma: false, urls: [], reason: 'story-input.json 不存在或解析失败' }
  }

  const urls = Array.isArray(input.sources?.figmaUrls)
    ? input.sources.figmaUrls.filter(u => typeof u === 'string' && u.trim())
    : []

  return {
    hasFigma: urls.length > 0,
    urls,
    reason: urls.length > 0
      ? `story-input.json 提供了 ${urls.length} 个 Figma 链接`
      : 'story-input.json 未提供 Figma 链接'
  }
}

/**
 * 判断本 Story 是否需要原型分析文档
 *
 * 历史问题: create-workflow.js 曾无条件检查 prototype-analysis.md，缺失即写入
 * Greenfield stub。fixbugs 场景本无原型，于是每个 Bug 修复 Story 都留下一个
 * 空壳文件，还会被 context-refresh 当成 Phase 0 产出物收集。
 *
 * 现在改为按需判定: 只有 story-input.json 里真的给了原型/Figma 链接，
 * 才要求产出 prototype-analysis.md。
 *
 * @param {string} storyId - Story ID
 * @returns {{ required: boolean, reason: string }}
 */
function isPrototypeRequired (storyId) {
  const input = readStoryInput(storyId)

  // 无 story-input.json → 无法判定，沿用旧行为（要求原型文档）以免漏检 run 模式
  if (!input || input._parseError) {
    return { required: true, reason: 'story-input.json 不存在或解析失败，保守要求原型文档' }
  }

  if (input.mode === 'fixbugs') {
    return { required: false, reason: 'fixbugs 模式，Bug 修复无原型依赖' }
  }

  const sources = input.sources || {}
  const protoCount = Array.isArray(sources.prototypeUrls) ? sources.prototypeUrls.length : 0
  const figmaCount = Array.isArray(sources.figmaUrls) ? sources.figmaUrls.length : 0

  if (protoCount + figmaCount > 0) {
    return {
      required: true,
      reason: `提供了 ${protoCount} 个原型链接 + ${figmaCount} 个 Figma 链接`
    }
  }

  return { required: false, reason: '未提供原型或 Figma 链接' }
}

/**
 * 查找 Story 目录下的 Bug 分析报告
 *
 * 文件名含动态需求标题（`{storyTitle}_bug分析报告.md`），无法进 PHASE_ARTIFACTS
 * 的固定文件名表，故用后缀匹配单独检查。
 *
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, files: string[], paths: string[] }}
 */
function findBugAnalysisReports (storyId) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) return { exists: false, files: [], paths: [] }

  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return { exists: false, files: [], paths: [] }
  }

  const files = names.filter(n => /bug分析报告\.md$/.test(n)).sort()
  return {
    exists: files.length > 0,
    files,
    paths: files.map(f => path.join(dir, f))
  }
}

/**
 * 检查需求分析文档是否存在
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, path: string }}
 */
function checkRequirementDoc (storyId) {
  const filePath = path.join(getStoryDir(storyId), 'requirement-analysis.md')
  return {
    exists: fs.existsSync(filePath),
    path: filePath
  }
}

/**
 * 检查任务 DAG 文档是否存在
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, path: string }}
 */
function checkTaskDAGDoc (storyId) {
  const filePath = path.join(getStoryDir(storyId), 'task-dag.md')
  return {
    exists: fs.existsSync(filePath),
    path: filePath
  }
}

/**
 * 🌐 检查工作流是否指定了 Figma 设计稿
 * @param {Object} state - 状态对象
 * @returns {boolean}
 */
function hasFigmaDesign (state) {
  return state?.hasFigmaDesign === true
}

/**
 * 🌐 检查 Figma Frame 清单 (figma-frame-inventory.json) 是否完整
 * Phase 1 任务规划师拆 task 时的产出（需求分析师不拉设计稿）。每个 frame 必须有 id、name、link。
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, frames: Array, errors: string[] }}
 */
function checkFigmaFrameInventory (storyId) {
  const result = { exists: false, valid: false, frames: [], errors: [] }
  const data = readJsonArtifact(storyId, FIGMA_FRAME_INVENTORY_FILE)

  if (!data) {
    result.errors.push(FIGMA_FRAME_INVENTORY_FILE + ' 不存在（如有 Figma 设计稿，Phase 1 任务规划师必须产出此文件）')
    return result
  }
  if (data._parseError) {
    result.errors.push('JSON 解析失败: ' + data._parseError)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.frames)) {
    result.errors.push('缺少 frames 数组')
    return result
  }

  result.frames = data.frames
  if (data.frames.length === 0) {
    result.errors.push('frames 数组为空，至少需要 1 个 frame')
  }

  // 按类型统计
  const types = { page: 0, dialog: 0, drawer: 0, component: 0, unknown: 0 }
  for (let i = 0; i < data.frames.length; i++) {
    const f = data.frames[i]
    const prefix = 'Frame[' + i + ']'
    if (!f.id) result.errors.push(prefix + ': 缺少 id（Figma node ID，如 "3020:83533"）')
    if (!f.name) result.errors.push(prefix + ': 缺少 name')
    if (!f.link) result.errors.push(prefix + ': 缺少 link（完整 Figma node URL）')
    if (f.type) {
      types[f.type] = (types[f.type] || 0) + 1
    } else {
      types.unknown++
      result.errors.push(prefix + ': 缺少 type（page/dialog/drawer/component）')
    }
  }

  // 所有 frame 必须有完整的 Figma link
  const missingLinks = data.frames.filter(f => !f.link)
  if (missingLinks.length > 0) {
    result.errors.push(missingLinks.length + ' 个 frame 缺少完整 Figma node 链接')
  }

  result.types = types
  result.valid = result.errors.length === 0
  return result
}

/**
 * 🌐 验证 task-dag.json 中每个 UI task 是否引用了有效的 Figma frame
 * 仅当 hasFigmaDesign=true 时强制执行。验证 vs 猜测 — 精确匹配变成简单验证。
 * @param {string} storyId - Story ID
 * @returns {{ valid: boolean, unmatched: Array, invalidRefs: Array, errors: string[] }}
 */
function validateTaskFigmaReferences (storyId) {
  const result = { valid: false, unmatched: [], invalidRefs: [], errors: [] }

  const tdjCheck = checkTaskDagJson(storyId)
  if (!tdjCheck.exists) {
    result.errors.push('task-dag.json 不存在，跳过 Figma 引用验证')
    return result
  }

  const figmaCheck = checkFigmaFrameInventory(storyId)
  const figmaFrameIds = figmaCheck.exists && Array.isArray(figmaCheck.frames)
    ? new Set(figmaCheck.frames.map(f => f.id))
    : new Set()

  // 检查每个 task 是否引用了 figmaNodeId（单值 string / 多值 array / figmaRefs 精确配对）
  for (const task of tdjCheck.tasks) {
    // 归一化 figmaNodeId 为数组：null/undefined/空数组 → 未绑定；string → 单元素
    let nodeIds = []
    if (Array.isArray(task.figmaRefs)) {
      // 优先用精确配对 figmaRefs（nodeId + link），nodeIds 取自其 nodeId
      nodeIds = task.figmaRefs.map(r => r && r.nodeId).filter(Boolean)
    } else if (Array.isArray(task.figmaNodeId)) {
      nodeIds = task.figmaNodeId.filter(Boolean)
    } else if (typeof task.figmaNodeId === 'string' && task.figmaNodeId.trim()) {
      nodeIds = [task.figmaNodeId.trim()]
    }

    if (nodeIds.length === 0) {
      // 如果是纯逻辑 task（如 API 层），允许没有 Figma 引用
      if (task.files && task.files.some(f => f.includes('.vue'))) {
        result.unmatched.push({
          taskId: task.id,
          title: task.title,
          reason: 'Vue 组件缺少 figmaNodeId/figmaRefs 引用，请在 task-dag.json 中为 ' + (task.title || task.id) + ' 添加 figmaNodeId 或 figmaRefs 字段'
        })
      }
    } else if (figmaFrameIds.size > 0) {
      for (const nodeId of nodeIds) {
        if (!figmaFrameIds.has(nodeId)) {
          result.invalidRefs.push({
            taskId: task.id,
            figmaNodeId: nodeId,
            reason: 'figmaNodeId "' + nodeId + '" 不在 figma-frame-inventory.json 中'
          })
        }
      }
    }
  }

  if (result.unmatched.length > 0) {
    result.errors.push(result.unmatched.length + ' 个 Vue 组件未绑定 Figma frame: ' +
      result.unmatched.map(u => u.taskId + '(' + u.title + ')').join(', '))
  }
  if (result.invalidRefs.length > 0) {
    result.errors.push(...result.invalidRefs.map(r => r.reason))
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 获取本 Story 中「需要 Figma」的 task 列表（开发阶段判断是否要求校验 Figma MCP）
 *
 * 判定：task 声明了 figmaNodeId（单值或数组）或 files 含 .vue 文件，即视为涉及 UI、
 * 需要对照设计稿。当需求要求 Figma（story-input 有 figmaUrls）且存在这类 task 时，
 * 开发 Agent 开工前必须先校验 Figma MCP 可用性，不可用则停下流程。
 *
 * @param {string} storyId - Story ID
 * @returns {Array<{id: string, title: string, figmaNodeIds: string[]}>} 需要 Figma 的 task 列表
 */
function getTasksRequiringFigma (storyId) {
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  if (!taskData || taskData._parseError || !Array.isArray(taskData.tasks)) return []

  const result = []
  for (const task of taskData.tasks) {
    // 归一化 figmaRefs / figmaNodeId（figmaRefs 优先，其次单值 string 或多值 array）
    let nodeIds = []
    if (Array.isArray(task.figmaRefs)) {
      nodeIds = task.figmaRefs.map(r => r && r.nodeId).filter(Boolean)
    } else if (Array.isArray(task.figmaNodeId)) {
      nodeIds = task.figmaNodeId.filter(Boolean)
    } else if (typeof task.figmaNodeId === 'string' && task.figmaNodeId.trim()) {
      nodeIds = [task.figmaNodeId.trim()]
    }

    // 涉及 UI 的判定：
    //   1) 显式声明了 figmaNodeId/figmaRefs
    //   2) files 含 .vue 文件
    //   3) files 是目录级 glob（如 src/views/pc/modules/** 或纯目录）——可能涵盖 .vue 组件，保守视为需 Figma
    const hasVueFile = Array.isArray(task.files) && task.files.some(f => {
      if (f.includes('.vue')) return true
      // 目录 glob / 目录路径 → 该目录下可能含 .vue 组件，保守视为 UI 相关
      return /\*\*|\*/.test(f) || /\/$/.test(f)
    })
    if (nodeIds.length > 0 || hasVueFile) {
      result.push({ id: task.id, title: task.title || task.id, figmaNodeIds: nodeIds })
    }
  }
  return result
}

/**
 * 判断本 Story 是否有 task 需要 Figma（供开发阶段 prompt 决定是否要求 Figma MCP 校验）
 * @param {string} storyId - Story ID
 * @returns {boolean} 是否存在需要 Figma 的 task
 */
function hasTaskRequiringFigma (storyId) {
  return getTasksRequiringFigma(storyId).length > 0
}

// ─── 契约 JSON 读取与校验 ───────────────────────────────────────

/**
 * 读取 Story 目录下的 JSON 契约文件
 * @param {string} storyId - Story ID
 * @param {string} fileName - JSON 文件名（如 'acceptance-criteria.json'）
 * @returns {Object|null} 解析后的 JSON，文件不存在或解析失败返回 null
 */
function readJsonArtifact (storyId, fileName) {
  const filePath = path.join(getStoryDir(storyId), fileName)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 检查验收标准契约 (acceptance-criteria.json) 是否完整
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, count: number, errors: string[] }}
 */
function checkAcceptanceCriteria (storyId) {
  const result = { exists: false, valid: false, count: 0, errors: [] }
  const data = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)

  if (!data) {
    result.errors.push(`${ACCEPTANCE_CRITERIA_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  // 检查 criteria 数组
  if (!Array.isArray(data.criteria)) {
    result.errors.push('缺少 criteria 数组')
  } else {
    result.count = data.criteria.length
    if (result.count === 0) {
      result.errors.push('criteria 数组为空，至少需要 1 条验收标准')
    }
    // 检查每条 AC 的必填字段
    for (let i = 0; i < data.criteria.length; i++) {
      const ac = data.criteria[i]
      if (!ac.id) result.errors.push(`AC[${i}]: 缺少 id`)
      if (!ac.description) result.errors.push(`AC[${i}]: 缺少 description`)
    }
    // 检查 ID 唯一性
    const ids = data.criteria.map(c => c.id).filter(Boolean)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dupes.length > 0) {
      result.errors.push(`重复的 AC ID: ${[...new Set(dupes)].join(', ')}`)
    }
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 检查待确认项契约 (open-questions.json) 是否全部已解决
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, allResolved: boolean, unresolved: Array, errors: string[] }}
 */
function checkOpenQuestions (storyId) {
  const result = { exists: false, allResolved: false, unresolved: [], errors: [] }
  const data = readJsonArtifact(storyId, OPEN_QUESTIONS_FILE)

  if (!data) {
    result.errors.push(`${OPEN_QUESTIONS_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.questions)) {
    result.errors.push('缺少 questions 数组')
    return result
  }

  result.unresolved = data.questions.filter(q => !q.resolved)
  result.allResolved = result.unresolved.length === 0

  if (!result.allResolved) {
    result.errors.push(`${result.unresolved.length} 项待确认问题未解决`)
  }

  return result
}

/**
 * 检查任务 DAG 契约 (task-dag.json) 是否完整
 * 验证: 每个 task 必须有 acceptanceCriteria 引用 + files 非空
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, tasks: Array, errors: string[], warnings: string[] }}
 */
function checkTaskDagJson (storyId) {
  const result = { exists: false, valid: false, tasks: [], errors: [], warnings: [] }
  const data = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!data) {
    result.errors.push(`${TASK_DAG_JSON_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.tasks)) {
    result.errors.push('缺少 tasks 数组')
    return result
  }

  result.tasks = data.tasks
  if (data.tasks.length === 0) {
    result.errors.push('tasks 数组为空')
  }

  for (let i = 0; i < data.tasks.length; i++) {
    const task = data.tasks[i]
    const prefix = `Task[${task.id || i}]`

    // 检查必填字段
    if (!task.id) result.errors.push(`${prefix}: 缺少 id`)
    if (!task.title) result.errors.push(`${prefix}: 缺少 title`)

    // 检查 acceptanceCriteria 引用
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      result.errors.push(`${prefix}: 缺少 acceptanceCriteria 引用（至少需关联 1 条验收标准）`)
    }

    // 检查 files 范围（用于 dev-pass 限域）
    if (!Array.isArray(task.files) || task.files.length === 0) {
      result.warnings.push(`${prefix}: files 为空，dev-pass 将降级为 src/** 全局授权（高风险）`)
    }

    // 跨项目 task 校验：有 project 字段时必须有 repoPath
    if (task.project && task.project !== repos.primary && !task.repoPath) {
      result.errors.push(`${prefix}: 跨项目 task (project=${task.project}) 必须指定 repoPath`)
    }

    // 跨项目 task 强制细化：description 必须包含行号引用
    if (task.project && task.project !== repos.primary) {
      // 检查是否有 description 字段且包含行号格式（如 L123 或 L12-L45）
      const desc = task.description || ''
      if (!desc) {
        result.errors.push(`${prefix}: 跨项目 task 必须有 description 字段`)
      } else if (!/L\d+/i.test(desc) && !/\bline\s*\d+/i.test(desc)) {
        result.errors.push(`${prefix}: 跨项目 task description 必须包含行号引用（如 L123 或 line 45）`)
      }
    }
  }

  // 检查 ID 唯一性
  const ids = data.tasks.map(t => t.id).filter(Boolean)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) {
    result.errors.push(`重复的 Task ID: ${[...new Set(dupes)].join(', ')}`)
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 验证 AC↔Task 交叉引用完整性
 * 每条 AC 至少被 1 个 Task 引用；每个 Task 引用的 AC 都存在
 * @param {string} storyId - Story ID
 * @returns {{ valid: boolean, orphanACs: string[], invalidRefs: Array, errors: string[] }}
 */
function validateContractReferences (storyId) {
  const result = { valid: false, orphanACs: [], invalidRefs: [], errors: [], warnings: [] }

  const acData = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)

  // 两个契约文件都不存在 → 无法验证
  if (!acData && !taskData) {
    result.errors.push('acceptance-criteria.json 和 task-dag.json 均不存在，无法验证交叉引用')
    return result
  }

  if (acData && !acData._parseError && Array.isArray(acData.criteria)) {
    const allACIds = acData.criteria.map(c => c.id).filter(Boolean)
    const referencedACIds = new Set()
    /** @type {Array<{taskId:string, rawValue:string, normalizedId:string}>} */
    const formatDrifts = [] // 追踪 AC 引用格式漂移（如 "AC-1: 描述" 而非 "AC-1"）

    if (taskData && !taskData._parseError && Array.isArray(taskData.tasks)) {
      for (const task of taskData.tasks) {
        if (Array.isArray(task.acceptanceCriteria)) {
          for (const rawAcId of task.acceptanceCriteria) {
            // 容错：从 "AC-1: 描述文本" 格式中提取纯 ID
            const normalizedId = typeof rawAcId === 'string'
              ? rawAcId.split(':')[0].trim()
              : String(rawAcId)
            const hasFormatDrift = normalizedId !== rawAcId

            if (hasFormatDrift) {
              formatDrifts.push({ taskId: task.id, rawValue: rawAcId, normalizedId })
            }

            referencedACIds.add(normalizedId)
            // 检查引用的 AC 是否存在（使用归一化后的 ID）
            if (!allACIds.includes(normalizedId)) {
              result.invalidRefs.push({ taskId: task.id, referencedAC: rawAcId, reason: '引用的 AC ID 不存在' })
            }
          }
        }
      }
    }

    // 格式漂移：从 warning 升级为 error（blocker），强制 Agent 修复 task-dag.json
    // 避免格式问题传播到下游，减少后续 Story 重复出现
    if (formatDrifts.length > 0) {
      const driftedTaskIds = [...new Set(formatDrifts.map(d => d.taskId))]
      result.errors.push(
        `检测到 ${formatDrifts.length} 处 AC 引用格式漂移（Task: ${driftedTaskIds.join(', ')}），` +
        `acceptanceCriteria 必须使用纯 ID（如 "AC-1"）而非 "AC-1: 描述"。请修复 task-dag.json 后重新提交。` +
        `（示例: 将 "${formatDrifts[0].rawValue}" 改为 "${formatDrifts[0].normalizedId}"）`
      )
    }

    // 找出未被任何 Task 引用的孤立 AC
    result.orphanACs = allACIds.filter(id => !referencedACIds.has(id))
    if (result.orphanACs.length > 0) {
      result.errors.push(`${result.orphanACs.length} 条验收标准未被任何 Task 引用: ${result.orphanACs.join(', ')}`)
    }
  }

  if (result.invalidRefs.length > 0) {
    result.errors.push(
      ...result.invalidRefs.map(r => `Task ${r.taskId} 引用了不存在的 AC: ${r.referencedAC}`)
    )
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 检查验收对账契约 (acceptance-verification.json) 是否全量通过
 * 所有 AC 都必须有 status=passed 且至少 1 条 evidence
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, allPassed: boolean, results: Array, failed: Array, errors: string[] }}
 */
function checkAcceptanceVerification (storyId) {
  const result = { exists: false, allPassed: false, results: [], failed: [], unverifiable: [], errors: [] }
  const data = readJsonArtifact(storyId, ACCEPTANCE_VERIFICATION_FILE)

  if (!data) {
    result.errors.push(`${ACCEPTANCE_VERIFICATION_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.results)) {
    result.errors.push('缺少 results 数组')
    return result
  }

  result.results = data.results

  // 同时读取 AC 契约，确保覆盖率 100%
  const acData = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)
  const expectedACIds = (acData && !acData._parseError && Array.isArray(acData.criteria))
    ? new Set(acData.criteria.map(c => c.id).filter(Boolean))
    : null

  const verifiedACIds = new Set()

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i]
    const prefix = `Result[${r.id || i}]`

    if (!r.id) {
      result.errors.push(`${prefix}: 缺少 id`)
      continue
    }
    verifiedACIds.add(r.id)

    if (r.status === 'failed') {
      result.failed.push({ id: r.id, status: r.status })
    } else if (r.status === 'unverifiable') {
      result.unverifiable.push({ id: r.id, status: r.status })
    }

    if (!Array.isArray(r.evidence) || r.evidence.length === 0) {
      result.errors.push(`${prefix}: 缺少 evidence（需提供验收证据）`)
    }
  }

  // 检查覆盖率：AC 契约中的所有条目是否都有验收结果
  if (expectedACIds) {
    for (const acId of expectedACIds) {
      if (!verifiedACIds.has(acId)) {
        result.errors.push(`AC ${acId}: 缺少验收结果`)
      }
    }
  }

  // 门控通过条件：failed=0 且 errors=0（unverifiable 不阻塞，跳过即可，降级为 warning）
  // 历史缺陷: 旧实现有 unverifiable 比例阈值（run 0.5 / fixbugs 1.0），超过即阻塞推进，
  //   导致大量依赖授权态/联调环境的 UI 型 AC 无法验证时被卡死流程。
  //   既然无法验证就跳过，不阻塞 —— unverifiable 结果由 policy 层降级为 warning 提示即可。
  result.allPassed = result.failed.length === 0 && result.errors.length === 0
  return result
}

/**
 * 从 task-dag.json 中提取 dev-pass 允许编辑的文件路径
 * 用于 Phase 2 开发通行证的精确限域。
 * 统一模式：输出 { repo, path } 对象数组，repo 缺省为 primary 仓库。
 * @param {string} storyId - Story ID
 * @returns {{ paths: Array<{repo:string,path:string}>, source: string, warnings: string[] }}
 *   paths: 允许编辑的文件列表（对象数组）；source: 'task-dag.json' | 'fallback-src-glob' | 'none'
 */
function getDevPassAllowedPaths (storyId) {
  const result = { paths: [], source: 'none', warnings: [] }
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!taskData || taskData._parseError) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push(`${TASK_DAG_JSON_FILE} 不存在或解析失败，dev-pass 降级为 ${repos.primary}:src/** 授权`)
    return result
  }

  if (!Array.isArray(taskData.tasks) || taskData.tasks.length === 0) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push('task-dag.json 中无任务，dev-pass 降级为 ' + repos.primary + ':src/** 全局授权')
    return result
  }

  // 收集所有 task 的 files，统一为 { repo, path } 对象格式（去重）
  const allFiles = new Set()
  for (const task of taskData.tasks) {
    if (!Array.isArray(task.files)) continue
    // 优先使用 task.project，其次 task.repo，缺省为 primary
    const repoName = task.project || task.repo || repos.primary
    // 验证 repo 是否已注册，未注册则回退到 primary
    const validRepo = repos.repos[repoName] ? repoName : repos.primary
    for (const f of task.files) {
      if (typeof f === 'string' && f.trim()) {
        allFiles.add(JSON.stringify({ repo: validRepo, path: f.trim() }))
      }
    }
  }

  if (allFiles.size === 0) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push('task-dag.json 中所有 task 的 files 均为空，dev-pass 降级为 ' + repos.primary + ':src/** 全局授权')
  } else {
    result.source = TASK_DAG_JSON_FILE
    result.paths = [...allFiles].map(s => JSON.parse(s))
  }

  return result
}

// ─── dev-pass 管理 ──────────────────────────────────────────────

/** dev-pass 默认有效期（毫秒）：2 小时 */
const DEV_PASS_TTL = 2 * 60 * 60 * 1000

/**
 * 签发 dev-pass（开发通行证）
 * 在 Phase 2 开始时调用，允许 src/ 目录的文件编辑。
 * CCHF 升级：支持从 task-dag.json 读取精确限域，替代全局 src/** 授权。
 * @param {string} storyId - Story ID
 * @param {number} ttl - 有效期（毫秒），默认 2 小时
 * @param {string[]} allowedPaths - 允许编辑的文件路径列表，不传则用 getDevPassAllowedPaths() 自动获取
 * @returns {Object} dev-pass 对象
 */
function issueDevPass (storyId, ttl = DEV_PASS_TTL, allowedPaths = null) {
  const now = new Date()

  // CCHF: 统一路径格式 — 支持数组直接传入或从 task-dag.json 获取
  let paths
  if (Array.isArray(allowedPaths)) {
    // 外部已传入路径数组，包装为统一格式
    paths = { paths: allowedPaths, source: 'external', warnings: [] }
  } else {
    // 从 task-dag.json 自动获取
    paths = getDevPassAllowedPaths(storyId)
  }

  const devPass = {
    storyId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    phase: 2,
    reason: 'Phase 2 development',
    allowedPaths: paths.paths,
    pathSource: paths.source,
    pathWarnings: paths.warnings
  }

  ensureStoryDir(storyId)
  const filePath = path.join(getStoryDir(storyId), 'dev-pass.json')
  fs.writeFileSync(filePath, JSON.stringify(devPass, null, 2), 'utf-8')

  return devPass
}

/**
 * 撤销 dev-pass
 * 在 Phase 2 结束或 Phase 3 开始时调用，阻止后续 src/ 编辑。
 * @param {string} storyId - Story ID
 */
function revokeDevPass (storyId) {
  const filePath = path.join(getStoryDir(storyId), 'dev-pass.json')
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

/**
 * 检查是否存在有效的 dev-pass
 * 扫描所有 Story 子目录下的 dev-pass.json，返回第一个有效的。
 * @returns {{ valid: boolean, storyId: string|null, reason: string }}
 */
function checkDevPass () {
  const dirs = listStoryDirs()
  const now = new Date()

  for (const dir of dirs) {
    const filePath = path.join(PLANS_DIR, dir, 'dev-pass.json')
    if (!fs.existsSync(filePath)) continue

    try {
      const pass = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const expiresAt = new Date(pass.expiresAt)

      if (now < expiresAt) {
        return {
          valid: true,
          storyId: dir,
          reason: `有效 (storyId: ${dir}, 过期时间: ${pass.expiresAt})`
        }
      } else {
        // 已过期，自动清理
        fs.unlinkSync(filePath)
      }
    } catch (e) {
      // 解析失败，删除无效文件
      try { fs.unlinkSync(filePath) } catch {}
    }
  }

  return { valid: false, storyId: null, reason: '无有效的开发通行证' }
}

/**
 * 续签 dev-pass
 * 当开发时间超过有效期时，可续签。
 * @param {string} storyId - Story ID
 * @param {number} ttl - 新有效期（毫秒），默认 2 小时
 * @returns {Object|null} 续签后的 dev-pass，状态文件不存在时返回 null
 */
function renewDevPass (storyId, ttl = DEV_PASS_TTL) {
  const state = readStateFile(storyId)
  if (!state || state.phase !== 2) {
    return null
  }
  return issueDevPass(storyId, ttl)
}

// ─── 修复回路配置 ───────────────────────────────────────────────

/**
 * 默认最大修复轮次 —— 按失败源（Phase 3 代码审查 / Phase 4 功能测试）独立预算。
 *
 * 历史缺陷: 旧实现单一 `maxFixRounds`，Phase 3 与 Phase 4 发起的 fix-loop
 * 共享同一轮次预算，code-review 耗尽的次数会吃掉 test 的额度，反之亦然。
 * 现拆分为各 2 次独立计数，用尽各自转人工。
 */
const DEFAULT_MAX_REVIEW_FIX_ROUNDS = 2
const DEFAULT_MAX_TEST_FIX_ROUNDS = 2

/**
 * 获取指定失败源的最大修复轮次配置
 * 统一从 e2e-state.json 读取（在 create-workflow.js 创建 state 时写入）：
 *   - sourcePhase 3（代码审查）→ maxReviewFixRounds
 *   - sourcePhase 4（功能测试）→ maxTestFixRounds
 * 缺省用各自默认值。如需调整，直接修改 e2e-state.json 对应字段即可，单一信源无歧义。
 * @param {string} storyId - Story ID
 * @param {number} [sourcePhase] - 失败源 Phase（3=code-review / 4=test），缺省或非 3/4 回退到 review 预算
 * @returns {number} 最大修复轮次
 */
function getMaxFixRounds (storyId, sourcePhase) {
  const state = readStateFile(storyId)
  if (state && sourcePhase === 4) {
    if (typeof state.maxTestFixRounds === 'number' && state.maxTestFixRounds > 0) {
      return state.maxTestFixRounds
    }
    return DEFAULT_MAX_TEST_FIX_ROUNDS
  }
  if (state && typeof state.maxReviewFixRounds === 'number' && state.maxReviewFixRounds > 0) {
    return state.maxReviewFixRounds
  }
  return DEFAULT_MAX_REVIEW_FIX_ROUNDS
}

// ─── 目录清理 ───────────────────────────────────────────────────

/**
 * 清理 Story 目录（删除空目录或整个目录）
 * @param {string} storyId - Story ID
 * @param {boolean} force - 是否强制删除（即使目录非空）
 */
function cleanStoryDir (storyId, force = false) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) return

  if (force) {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }

  // 非强制：仅删除空目录
  const files = fs.readdirSync(dir)
  if (files.length === 0) {
    fs.rmdirSync(dir)
  }
}

// ─── 结构化错误辅助 ──────────────────────────────────────────────

/**
 * 创建结构化错误对象，用于门控校验输出
 * 结构化错误携带 failureType，可直接用于经验沉淀，无需关键词猜测
 * @param {string} type - 错误类型标识（如 'ac_missing_id', 'task_missing_title'）
 * @param {string} message - 错误描述文本（人可读）
 * @param {number} [level=2] - 恢复等级 (1=自动修复, 2=提示修复, 3=降级, 4=人工介入)
 * @param {string} [resolution=''] - 建议的解决方案
 * @returns {{ type: string, message: string, level: number, resolution: string }}
 */
function structuredError (type, message, level = 2, resolution = '') {
  return { type, message, level, resolution }
}

/**
 * 将结构化错误对象转为字符串（兼容旧的纯字符串 errors 格式）
 * @param {{ type: string, message: string }|string} err - 结构化错误或纯字符串
 * @returns {string} 纯字符串
 */
function errorToString (err) {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && err.message) return err.message
  return String(err)
}

/**
 * 从错误中提取 failureType（结构化错误直接取 type，纯字符串返回 'unknown'）
 * @param {{ type: string, message: string }|string} err - 结构化错误或纯字符串
 * @returns {string} failureType
 */
function errorToType (err) {
  if (typeof err === 'string') return 'unknown'
  if (err && typeof err === 'object' && err.type) return err.type
  return 'unknown'
}

// ─── 导出 ───────────────────────────────────────────────────────

module.exports = {
  // 路径常量
  PROJECT_ROOT,
  PLANS_DIR,
  DEV_PASS_TTL,
  PHASE_SLUGS,
  PHASE_NAMES,
  PHASE_ARTIFACTS,
  PHASE_AGENTS,
  getPhaseAgent,

  // 仓库注册表（repos.json，story 级独立）
  getDefaultRepoName,
  getReposFilePath,
  loadRepos,
  ensureReposJson,
  getRepoRoot,
  getRepoForFile,

  // Story 目录辅助
  getStoryDir,
  ensureStoryDir,
  listStoryDirs,

  // stdin 读取
  readStdin,

  // 文件路径检查
  isSrcFile,
  isStateFile,

  // 状态文件操作
  readStateFile,
  writeStateFile,
  findActiveWorkflows,
  hasActiveWorkflow,
  isPhaseCompleted,
  getPhaseSlug,
  getPhaseName,

  // 产出物检查
  checkPhaseArtifact,
  isPrototypeRequired,
  detectFigmaSource,
  findBugAnalysisReports,
  checkRequirementDoc,
  checkTaskDAGDoc,
  hasFigmaDesign,
  checkFigmaFrameInventory,
  validateTaskFigmaReferences,
  getTasksRequiringFigma,
  hasTaskRequiringFigma,

  // 契约 JSON 读取与校验
  ACCEPTANCE_CRITERIA_FILE,
  OPEN_QUESTIONS_FILE,
  TASK_DAG_JSON_FILE,
  ACCEPTANCE_VERIFICATION_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  STORY_INPUT_FILE,
  readStoryInput,
  getStoryMode,
  readJsonArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  checkAcceptanceVerification,
  getDevPassAllowedPaths,

  // dev-pass 管理
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  renewDevPass,

  // 修复回路配置
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS,
  getMaxFixRounds,

  // 结构化错误辅助
  structuredError,
  errorToString,
  errorToType,

  // 目录清理
  cleanStoryDir,

  // Story ID 校验
  STORY_ID_PATTERN,
  isValidStoryId,
  assertValidStoryId
}
