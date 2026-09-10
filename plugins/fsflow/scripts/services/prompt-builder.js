#!/usr/bin/env node
/**
 * prompt-builder.js — Agent Prompt 构造服务，prompt 的唯一出口
 *
 * 职责:
 *   - buildAgentPrompt: 把「下一个 Phase 的 Agent 需要知道的一切」组装成一段完整 prompt
 *     （角色与约束 / 上一 Phase 摘要 / 契约文件路径 / Story 背景 / 历史教训 / 修复回路上下文）
 *   - buildFixLoopContext: 修复回路场景追加 BLOCKER 清单与回退轮次上下文
 *   - 提供 Figma 对齐指令与任务规划 Figma 指令等 Phase 专属片段
 *
 * 用法:
 *   作为模块引用:
 *     const { buildAgentPrompt } = require('./services/prompt-builder')
 *
 * 使用场景:
 *   - commands/dispatch.js 决定该 Spawn 哪个 Agent 时，一并产出 agentPrompt，
 *     使主 Agent 只需原样注入，无需自行判断该拼什么
 *   - 内部依赖 services/context-refresh.js 取摘要与契约清单、services/experience.js 取历史教训
 *   - 回归测试 __tests__/fixbugs-regression.test.js、figma-detection.test.js 直接断言其输出
 *
 * 说明:
 *   - 设计原则 — 单一信源: 历史上 prompt 有两个来源（advance-phase.js 的 suggestedAgentPrompt 与
 *     dispatcher Agent 的 instruction/inputFiles），主 Agent 面对两个都自称权威的来源只能自行拼接，
 *     而「拼接」就是判断——判断权回到主 Agent 手里，正是流程失控的成因。
 *     本模块是 prompt 的唯一构造器，只由 dispatch.js 在真正需要 Spawn 时调用；
 *     advance-phase.js 只返回推进结果，主 Agent 推进后回 dispatch 取下一步。
 *   - 本模块为纯只读: 只读产出物文件，不写任何文件、不改状态
 *   - v2（需求10）: 不再内联截断契约内容——截断会导致关键信息（AC 全表、task-dag 全量文件、
 *     跨仓字段）丢失，让下游 Agent 基于残缺信息越做越错。改为只给完整文件路径，
 *     token 由「内联截断」让位给「按需读取」，信息完整性不再受注入上限约束
 *   - v3 token 优化（2026-09）: v2 把成本从 prompt 挪到了工具调用，于是「让谁去读什么」
 *     成了新的成本项。三处收敛，判据都是「这个 Phase 到底用不用得上」:
 *       1. Story 背景资料（bug 分析报告，实测真实项目 10.5~27.5 KB）只在 Phase 0-1 注入。
 *          原实现无 Phase 过滤，Phase 5/6/7 的发布助手也被要求去读它 —— 做 git commit /
 *          知识库更新 / 云端部署根本用不上。报告在 Phase 0-1 已消化进契约文件。
 *       2. 全 Phase 常驻约束收敛为 1 条；代码检索约束只在 Phase 0-2 按需注入。
 *          已在 agent .md 里写明的通用规则不再重复计费。
 *       3. 契约文件路径只打一次（原来相对 + 绝对各打一遍）。
 *     实测口径: agentPrompt 本身只占单次 spawn payload 的 7~17%（agent .md 是它的 6~13 倍），
 *     所以真正的收益来自「少一次大文件读」，不是「prompt 少几个字」。
 *
 * @module prompt-builder
 */

const fs = require('fs')
const path = require('path')

const {
  PLANS_DIR,
  PHASE_ARTIFACTS,
  getPhaseName,
  getPhaseAgent,
  STORY_INPUT_FILE,
  readStoryInput,
  getStoryMode,
  detectFigmaSource,
  readStateFile,
  loadRepos,
  getMaxFixRounds,
  getTasksRequiringFigma
} = require('../lib/state')

const contextRefresh = require('./context-refresh')
const experience = require('./experience')

const toPosix = value => String(value || '').replace(/\\/g, '/')

/**
 * Agent 通用约束（所有 Phase 的 Agent 都必须遵守）
 *
 * 只保留 agent 定义文件里**没有**覆盖到的条目 —— 逐条核对 agents/*.md 的结果:
 *   - 禁止改 e2e-state.json / dev-pass.json → 6/6 个 agent .md 都已写明 → 已删
 *   - 由主 Agent 调 advance-phase.js 推进 phase → 6/6 都已写明 → 已删
 *   - 只产出本 Phase 产出物 + 汇报路径 → 本 prompt 末尾「## 完成后」段已单独写 → 已删
 *   - 禁止 shell 绕过写状态文件 → 只有 1/6（前端开发工程师）写了 → **保留**
 *   - 代码检索约束 → 只在 Phase 0-2 与仓库检索入口一起注入，发布阶段不重复计费
 *
 * 每条约束都会在 8 次 spawn 里各计费一次，而重复一遍并不会让已经写在 system prompt
 * 里的规则更被遵守 —— 所以这里的判据是「agent .md 有没有」，不是「重要不重要」。
 */
const AGENT_CONSTRAINTS = [
  '禁止通过 shell 命令绕过限制写 e2e-state.json / dev-pass.json（hook 会拦截并记录违规）'
]

const SEARCH_CONSTRAINTS = [
  '查找/定位代码时按「代码检索入口」选择 graphify 或已指定的 kb-query + Grep 降级路径，禁止猜测文件路径',
  'graphify / Bash 在已标注图谱可用时仍检索失败，必须停下上报主 Agent，禁止静默降级后猜测实现'
]

/**
 * 实测某仓库的 graphify 图谱状态，避免每个子 Agent 重复探测。
 * @param {string} repoRoot
 * @returns {{ built: boolean, label: string }}
 */
function probeGraphStatus (repoRoot) {
  const graphPath = path.join(repoRoot, 'graphify-out', 'graph.json')
  try {
    const stat = fs.statSync(graphPath)
    if (!stat.isFile()) return { built: false, label: '图谱：未建' }
    const mb = stat.size / (1024 * 1024)
    const size = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(mb * 1024))}KB`
    return { built: true, label: `图谱：已建 ${size}` }
  } catch (_) {
    return { built: false, label: '图谱：未建' }
  }
}

/**
 * 只向需要代码检索的 Phase 注入「仓库路径 + 图谱客观状态 + cwd 规则」。
 * Graphify 的完整用法由其 skill 按需披露，这里不重复说明。
 * @param {string} storyId
 * @param {number} targetPhase
 * @returns {string[]}
 */
function buildRepoSearchEntries (storyId, targetPhase) {
  if (![0, 1, 2].includes(targetPhase)) return []
  const repos = loadRepos(storyId)
  if (!repos || !repos.repos) return []

  const names = [repos.primary, ...Object.keys(repos.repos).filter(name => name !== repos.primary)]
    .filter(name => repos.repos[name])
  const entries = names.map(name => ({
    name,
    root: repos.repos[name],
    primary: name === repos.primary,
    graph: probeGraphStatus(repos.repos[name])
  }))
  const hasGraph = entries.some(entry => entry.graph.built)

  const lines = [
    '## 🔎 代码检索入口',
    '',
    ...entries.map(entry =>
      `- ${entry.name}${entry.primary ? '（主仓，即当前工作目录）' : ''} → \`${toPosix(entry.root)}\`（${entry.graph.label}）`
    ),
    '',
    '检索统一走 `graphify` skill（`/graphify`）：`graphify query "<模块/关键词>"`。',
    '',
    '> 图谱按 **cwd** 解析：检索非主仓前先 `cd` 到上述目录。',
    '',
    hasGraph
      ? '> 标注「已建」的仓库直接检索，无需再探测图谱。'
      : '> 所有仓库均未建图谱：不要反复探测，改用 kb-query + Grep 双源交叉验证。',
    ''
  ]
  if (hasGraph && entries.some(entry => !entry.graph.built)) {
    lines.push('> 标注「未建」的仓库改用 kb-query + Grep，不要耗时探测。', '')
  }
  return lines
}

/**
 * 读取契约文件清单并格式化为 prompt 片段。
 *
 * v2（需求10）：不再内联截断契约内容 —— 截断会导致关键信息丢失（AC 全表、
 * task-dag 全量文件、跨仓字段等被砍掉），让下游 Agent 基于残缺信息越做越错。
 * 改为只给出**完整文件路径**，由 Agent 自行读取完整内容。token 由「内联截断」
 * 让位给「按需读取」，信息完整性不再受注入上限约束。
 *
 * v3：只打印一次路径。原实现相对路径 + 绝对路径各打一遍，同一个位置说两次，
 * 既不增加信息也让 Agent 需要判断该用哪个。统一给绝对路径（Agent 直接可用，
 * 不依赖它的当前工作目录）。
 *
 * @param {string} storyId - Story ID
 * @param {string[]} contractFiles - 契约文件路径列表（形如 .codebuddy/plans/<id>/xxx.json）
 * @returns {string[]} 已格式化的 markdown 片段（每个文件一条路径提示）
 */
function readContractContents (storyId, contractFiles) {
  const lines = []
  for (const cf of contractFiles || []) {
    const cfPath = path.join(PLANS_DIR, storyId, cf.replace(/^\.codebuddy\/plans\/[^/]+\//, ''))
    if (!fs.existsSync(cfPath)) continue
    lines.push(`- \`${cfPath}\``)
  }
  return lines
}

/**
 * 读取 Story 级背景资料文件清单（bug 分析报告 / story-context.md），注入到 prompt。
 *
 * v2（需求10）：不再内联截断背景资料（如 bug 分析报告可能很长，截断后丢失
 * 代码定位/根因等关键事实），改为只给文件路径，Agent 自行读取完整内容。
 *
 * v3：**只在 Phase 0-1 注入**。原实现无 Phase 过滤，Phase 1~7 全都被要求去读同一份
 * 报告 —— 实测真实项目里 bug 分析报告 10.5~27.5 KB（约 3.5~9.2K token），
 * 而 Phase 5/6/7 的发布助手在做 git commit / 知识库更新 / 云端部署，压根用不上它。
 * 报告的价值在 Phase 0（产出事实）与 Phase 1（据此拆 task）就已经被消化进
 * requirement-analysis.md / acceptance-criteria.json / task-dag.json，
 * 后续 Phase 读这些产出物即可，不必回头读原始报告。
 * （Phase 0 通常还没有报告，返回空数组；重试/修复回路场景下报告已存在则仍注入。）
 *
 * 约定文件名: `*bug分析报告.md` 或 `story-context.md`
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase；> 1 时返回空数组
 * @returns {string[]} 已格式化的 markdown 片段（每个文件一条路径提示）
 */
function readStoryContext (storyId, targetPhase) {
  if (typeof targetPhase === 'number' && targetPhase > 1) return []

  const storyDir = path.join(PLANS_DIR, storyId)
  if (!fs.existsSync(storyDir)) return []

  let names
  try {
    names = fs.readdirSync(storyDir)
  } catch (e) {
    return []
  }

  const matched = names
    .filter(n => /bug分析报告\.md$/.test(n) || n === 'story-context.md')
    .sort()

  const contents = []
  for (const name of matched) {
    contents.push(`- \`${path.join(storyDir, name)}\``)
  }
  return contents
}

/**
 * 读取 Figma Frame 清单中的 designSpec（每个 frame 的设计规格摘要），在 Phase 2 注入 prompt。
 *
 * 合并后（figma-component-map.md 已删除）：frame-inventory.json 的每个 frame 含可选 designSpec
 * 字段（色值/间距/字体/布局等设计规格摘要）。开发 agent 以 Figma MCP 完整拉取为准，
 * designSpec 仅作辅助参考，避免全量探索设计稿。
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} 已格式化的 markdown 片段，无 designSpec 时返回空数组
 */
function readFigmaDesignSpec (storyId) {
  const invPath = path.join(PLANS_DIR, storyId, 'figma-frame-inventory.json')
  if (!fs.existsSync(invPath)) return []
  try {
    const inv = JSON.parse(fs.readFileSync(invPath, 'utf-8'))
    const withSpec = (inv.frames || []).filter(f => f.designSpec)
    if (withSpec.length === 0) return []
    const lines = [
      '## Figma 设计规格摘要（frame-inventory 中的 designSpec，辅助参考）',
      '',
      '> 设计稿完整内容以你通过 Figma MCP 拉取为准；以下仅列出 Phase 1 任务规划阶段已提取的关键规格，减少全量探索。',
      ''
    ]
    for (const f of withSpec) {
      lines.push(`- **${f.name}** (node ${f.id}): ${f.designSpec}`)
    }
    lines.push('')
    return lines
  } catch (e) {
    return [`## Figma 设计规格摘要\n(读取失败: ${e.message})\n`]
  }
}

/**
 * 构造「有 Figma 设计稿时必须对齐」的开发阶段指令片段。
 *
 * 仅在 Phase 2（前端开发）注入。核心诉求: 有 Figma 链接时，前端 agent 必须亲自
 * 用 Figma MCP 拉取完整设计内容实现（设计稿内容由 agent 自行获取，不在 prompt 转译）。
 * 因此 prompt 只保留**关键指令**（对齐设计稿 + MCP 不可用停下），删去冗长的样式还原
 * 细节（CSS class / ::v-deep / 逐条核对等）——那些 agent 自会从 Figma MCP 获取，
 * 写在 prompt 里只会常驻占用上下文（原为 924 字符固定文案，多轮 fix-loop 反复计费）。
 *
 * v3（2026-09）: 逐 task 的 node-id 清单也不再内联。task-dag.json 是 Phase 2 的契约文件
 * （`context-refresh.js:getContractFiles` 对 nextPhase=2 必列），prompt 里已强制要求
 * 「逐个读取契约文件、不要依赖摘要」，因此 node 清单是 agent 无论如何都会读到的数据的
 * 第二份拷贝 —— UI task 多时（每 task 一行含完整链接）反而是 fix-loop 里最贵的重复段。
 * 保留的是**行为要求**（按 task 精准拉取、不做全量探索）与字段指路。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string[]} markdown 行，无 Figma 或非 Phase 2 时返回空数组
 */
function buildFigmaAlignInstruction (storyId, targetPhase) {
  if (targetPhase !== 2) return []
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []
  // 需求要求 Figma，但本 Story 没有任何需要 Figma 的 task（纯逻辑改动，无 UI）→ 不强求对齐
  const figmaTasks = getTasksRequiringFigma(storyId)
  if (figmaTasks.length === 0) return []

  return [
    '## 🎨 Figma 设计稿对齐（强制）',
    '',
    '- UI 必须严格对齐设计稿，禁止使用默认/直觉样式。',
    '- 每个 UI 任务**自行调用 Figma MCP** 拉取该节点的完整设计上下文（`get_design_context` 为主，`get_screenshot` 为辅）——设计稿内容以 MCP 返回为准，不要凭截图/摘要推测。',
    '- **开工前先校验 Figma MCP 可用性**；若无法使用（工具不可用 / Figma 桌面端未运行 / 返回错误）——**立即停下当前任务并上报主 Agent，禁止硬做**（设计稿未对齐就开发会导致大量返工）。',
    `- **精确节点清单在 \`task-dag.json\` 里**: 本 Story 有 ${figmaTasks.length} 个 task 需要 Figma，逐个读 task 的 \`figmaRefs[]\`（\`nodeId\` + \`link\`，旧数据回落 \`figmaNodeId\`），按 task 精准拉取对应 node，**不要全量探索整个设计稿文件**。`,
    ...(detected.urls.length > 0 ? ['- 设计稿文件链接：', ...detected.urls.map(u => `  - ${u}`)] : []),
    ''
  ]
}

/**
 * 构造「本 Story 原始输入」prompt 片段。
 *
 * 设计意图: 主 Agent 只把用户消息里的参数搬运进 story-input.json 就结束职责，
 * 不做任何分析。分析由需求分析师在 Phase 0 自行完成（fixbugs 模式下由它自己
 * 调用 tapd-bug-analyzer skill），这样中间推理始终留在同一个上下文里，
 * 不会因跨 Agent 传递而丢失。
 *
 * 只在 Phase 0 注入完整内容 —— 后续 Phase 需要的是分析结论（bug 分析报告 /
 * requirement-analysis.md），不是原始链接，注入全文只会挤占上下文。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string} markdown 片段，无内容时返回空串
 */
function buildStoryInputSection (storyId, targetPhase) {
  if (targetPhase !== 0) return ''

  const input = readStoryInput(storyId)
  if (!input) return ''

  if (input._parseError) {
    return `## 本 Story 原始输入\n⚠️ ${STORY_INPUT_FILE} 解析失败: ${input._parseError}\n请读取源文件 .codebuddy/plans/${storyId}/${STORY_INPUT_FILE} 自行确认，或向主 Agent 索要参数。\n`
  }

  const mode = input.mode === 'fixbugs' ? 'fixbugs' : 'run'
  const lines = [
    '## 本 Story 原始输入',
    `请读取 .codebuddy/plans/${storyId}/${STORY_INPUT_FILE} 获取完整参数（含 TAPD/原型/Figma 链接等）——此处不内联全文，避免占上下文。`,
    '',
  ]

  if (mode === 'fixbugs') {
    lines.push(
      '**模式: fixbugs（Bug 修复）**',
      '',
      '- 上述参数由主 Agent 原样搬运，**未经任何分析** —— Bug 分析是你的职责，不是主 Agent 的。',
      '- 你需要自行 `use_skill("fsflow:tapd-bug-analyzer")`，用 sources 里的 tapdUrl / workspaceId / owner / statusFilter 拉取并分析缺陷。',
      '- Bug 分析报告**只记录事实**: 问题复述、复现步骤、代码定位、根因、责任方分类。',
      '  🚫 **不要写修复方案**（不写"应该怎么改"、不给伪代码/diff）—— 修复设计属于开发工程师。',
      '- 产出 `{标题}_bug分析报告.md` 后，再写 `requirement-analysis.md`：只引用 Bug 编号，不复制 Bug 正文。',
      ''
    )
  } else {
    lines.push(
      '**模式: run（新功能开发）**',
      '',
      '- 上述参数由主 Agent 原样搬运，未经分析。请按 sources 里实际存在的字段决定检索策略。',
      ''
    )
  }

  // Figma 处理不在 Phase 0（需求分析阶段）——frame-inventory 由 Phase 1 任务规划师拆 task 时产出。
  // 见 buildTaskPlannerFigmaInstruction（Phase 1 注入）。

  return lines.join('\n')
}

/**
 * 构造 Figma 解析指令片段
 *
 * 与 fixbugs 注入 `tapd-bug-analyzer` 对称: 检测到设计稿链接就显式点名要调用的
 * skill，避免子 Agent 拿到链接却不知道该走哪条解析路径。
 *
 * @param {string} storyId - Story ID
 * @param {Object} input - 已解析的 story-input.json
 * @returns {string[]} markdown 行，无 Figma 链接时返回空数组
 */
/**
 * 构造「任务规划阶段处理 Figma」指令片段（Phase 1 注入）。
 *
 * Figma 处理从 Phase 0 移到 Phase 1：需求分析师只做需求分析（不拉设计稿），
 * 任务规划师拆 task 时才处理 Figma——只针对要拆的组件精确拉取，产出
 * figma-frame-inventory.json，并为每个 UI task 绑定 figmaRefs。这样真正"按需拉稿"，
 * 避免需求阶段猜测性全量/半量拉取（省 token + 更精确）。
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} markdown 行，无 Figma 链接时返回空数组
 */
function buildTaskPlannerFigmaInstruction (storyId) {
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []

  const state = readStateFile(storyId)
  const gateEnabled = state?.hasFigmaDesign === true

  return [
    `**🌐 检测到 ${detected.urls.length} 个 Figma 设计稿链接（任务规划阶段处理）**`,
    '',
    '- 拆 task 前调用 `use_skill("fsflow:figma-to-component-map")` 处理设计稿，**禁止凭链接猜测 UI 结构**。',
    '- 前置条件: Figma 桌面端需处于运行状态并已打开该文件；未运行则如实告知用户并停止，不要退回缓存数据。',
    `- 只针对**要拆分的 task 涉及的文件/组件**产出 \`figma-frame-inventory.json\`（覆盖每个相关 page / dialog / drawer 的完整 node 链接），**不要全量扫描所有页面**——拆到哪些组件就拉哪些，避免重复分析浪费 token。`,
    '- **只用 `get_metadata` 扫帧结构（id/name/type/link/rect），禁止调用 `get_design_context` / `get_screenshot`**——设计稿完整内容（色值/间距/字体/布局/交互）由开发工程师 Phase 2 拉取，你不拉，避免重复调用浪费 token。',
    '- 为每个 UI task 绑定 `figmaRefs: [{ nodeId, link }]` 精确配对（nodeId 用 `:`，link 用 `-`），全栈开发工程师据此一次精准拉取设计稿。',
    gateEnabled
      ? '- ⚠️ 本 Story 已开启 Figma 门控，Phase 1→2 会校验 frame-inventory 完整性及 task 的 figmaNodeId 命中清单，缺失或不完整将阻断推进。'
      : '- 本 Story 未开启 Figma 强制门控（fixbugs 模式），但涉及 UI 的改动仍应按清单核对设计规范。',
    ...detected.urls.map(u => `  - ${u}`),
    ''
  ]
}

/**
 * 探测修复回路上下文（推进/调度到 Phase 3 时使用）
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {Object|null} fixLoopContext，无修复回路时返回 null
 */
function buildFixLoopContext (storyId, targetPhase) {
  if (targetPhase !== 3) return null

  const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
  if (!fs.existsSync(fixRequestPath)) return null

  try {
    const fixRequest = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8'))
    const fixVerificationPath = path.join(PLANS_DIR, storyId, 'fix-verification.json')
    const hasFixVerification = fs.existsSync(fixVerificationPath)
    // 修复预算按失败源独立计数（code-review / test 各 2 次），maxRounds 取对应预算
    const sourcePhase = fixRequest.sourcePhase === 4 ? 4 : 3
    const maxRounds = getMaxFixRounds(storyId, sourcePhase)
    return {
      active: true,
      round: fixRequest.round,
      maxRounds,
      sourcePhase: fixRequest.sourcePhase,
      issueCount: fixRequest.issues ? fixRequest.issues.length : 0,
      affectedFiles: fixRequest.affectedFiles || [],
      fixVerificationExists: hasFixVerification,
      fixContextFile: '.codebuddy/plans/' + storyId + '/fix-context.md',
      instruction: '本次审查为修复回路后的复查。请加载 fix-context.md + fix-request.json' +
        (hasFixVerification ? ' + fix-verification.json' : '') +
        '，逐项核对每个 FIX-XX 是否真正修复，聚焦复查 affectedFiles 的改动，确认未引入新问题。'
    }
  } catch (e) {
    // fix-request.json 解析失败 → 视为无修复回路上下文
    return null
  }
}

/**
 * 构造下一个 Phase 的 Agent Prompt 及其配套元信息。
 *
 * @param {Object} opts
 * @param {string} opts.storyId - Story ID
 * @param {number} opts.targetPhase - 即将进入的 Phase（Agent 要干活的那个 Phase）
 * @param {number} opts.summaryPhase - 用于取摘要的 Phase（通常是 targetPhase - 1）
 * @param {Object} [opts.summaryInfo] - 已加载的摘要对象；不传则自行加载
 * @returns {{
 *   agent: string|null,
 *   agentLabel: string|null,
 *   phaseInstruction: string|null,
 *   agentPrompt: string,
 *   contractFilesToLoad: string[],
 *   agentConstraints: string[],
 *   lessonsFromHistory?: string,
 *   metricsInsights?: string,
 *   fixLoopContext?: Object,
 *   expectedOutputs: string[]
 * }}
 */
function buildAgentPrompt (opts) {
  const { storyId, targetPhase } = opts
  const summaryPhase = opts.summaryPhase !== undefined ? opts.summaryPhase : targetPhase - 1

  const agentInfo = getPhaseAgent(targetPhase)

  // 上一 Phase 摘要
  const summaryInfo = opts.summaryInfo !== undefined
    ? opts.summaryInfo
    : contextRefresh.loadLatestSummary(storyId, summaryPhase)

  // 契约文件（下个 Phase 需要读的）
  const contractFilesToLoad = contextRefresh.getContractFiles(storyId, summaryPhase) || []
  const contractContents = readContractContents(storyId, contractFilesToLoad)

  // 历史教训 + 度量洞察
  const lessons = experience.getLessonsForPhase(targetPhase)
  const metricsInsights = experience.getMetricsInsights(targetPhase)

  // Story 级背景资料（如 bug 分析报告）—— 只在 Phase 0-1 注入，见 readStoryContext 说明
  const storyContext = readStoryContext(storyId, targetPhase)

  // 本 Story 原始输入（仅 Phase 0 注入完整内容）
  const storyInputSection = buildStoryInputSection(storyId, targetPhase)
  const storyMode = getStoryMode(storyId)
  const kbPreflightInstruction = targetPhase === 2
    ? [
        '## 知识库前置确认（编码前执行）',
        '在执行任何 task、修改代码或并行 Spawn 开发 Agent 前，按 task-dag.json / repos.json 逐仓检查 `.docs/llm-knowledge/meta.yaml`。',
        '- 已存在：禁止重建，直接执行 kb-query。',
        '- 不存在：编码前询问用户“项目知识库尚未初始化，是否现在初始化？”。同意则依次调用 `use_skill("fsflow:kb-init")` 和 `use_skill("fsflow:gen-project-docs")` 全量模式，完成后重新执行 kb-query。',
        '- 用户拒绝：执行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/trace.js" phase-outcome <storyId> 2 skipped_by_user \'{"reason":"knowledge_base_initialization_declined"}\'` 记录决定，然后允许继续编码，并在交付说明中注明未使用知识库。',
        '- 多仓库一次列出缺库仓库；用户同意后按仓库串行初始化，再并行编码。',
        '- 初始化或全量生成失败：报告失败并询问是否降级继续，不得自行决定。',
        '- Phase 6 复用本次决定：已有知识库则增量更新；Phase 2 已拒绝则不重复询问。',
        ''
      ].join('\n')
    : ''

  // Figma 设计规格摘要（frame-inventory 的 designSpec，Phase 2 前端开发注入，辅助参考）
  const figmaDesignSpec = readFigmaDesignSpec(storyId)
  // Figma 对齐指令（Phase 2 前端开发时强制要求按设计稿实现）
  const figmaAlignInstruction = buildFigmaAlignInstruction(storyId, targetPhase)
  // Figma 任务规划指令（Phase 1 任务规划师拆 task 时处理 Figma，产出 frame-inventory + 绑定 figmaRefs）
  const taskPlannerFigmaInstruction = buildTaskPlannerFigmaInstruction(storyId)
  const repoSearchEntries = buildRepoSearchEntries(storyId, targetPhase)
  const agentConstraints = repoSearchEntries.length > 0
    ? [...AGENT_CONSTRAINTS, ...SEARCH_CONSTRAINTS]
    : AGENT_CONSTRAINTS

  // 修复回路上下文
  const fixLoopContext = buildFixLoopContext(storyId, targetPhase)

  // 本 Phase 应产出的文件（来自 PHASE_ARTIFACTS，Phase 2/5/6/7 无文件产出）
  // optional 产出物（原型/Figma）按条件产出，不列入 expectedOutputs——主 Agent 靠该
  // 列表校验子 Agent 汇报，列进去会让「按条件不产出」被误判为漏产。
  const phaseArtifacts = PHASE_ARTIFACTS[targetPhase]
  const requiredArtifacts = phaseArtifacts
    ? phaseArtifacts.artifacts.filter(a => !a.optional)
    : []
  const expectedOutputs = requiredArtifacts.filter(a => a.fileName).map(a => a.fileName)
  const expectedDescriptions = requiredArtifacts
    .map(a => a.fileName ? `${a.fileName} — ${a.description}` : a.description)

  // fixbugs 模式下 Phase 0 额外要求 Bug 分析报告（文件名含动态标题，无法进 PHASE_ARTIFACTS 固定表）
  // 同时进 expectedOutputs —— 主 Agent 靠它校验子 Agent 的产出物汇报，只写 descriptions 会漏检
  if (targetPhase === 0 && storyMode === 'fixbugs') {
    expectedOutputs.unshift('*bug分析报告.md')
    expectedDescriptions.unshift('{需求标题}_bug分析报告.md — Bug 事实记录（问题复述 + 复现步骤 + 代码定位 + 根因 + 责任方分类，不含修复方案）')
  }

  const promptLines = [
    `## Story: ${storyId} | Phase: ${targetPhase} (${getPhaseName(targetPhase)})`,
    '',
    agentInfo ? `## 你的角色\n${agentInfo.label} (注册名: ${agentInfo.agent})` : '',
    agentInfo ? `\n## 你的任务\n${agentInfo.instruction}` : '',
    '',
    storyInputSection,
    kbPreflightInstruction,
    storyContext.length > 0 ? `## Story 背景资料\n请读取以下文件获取完整内容：\n${storyContext.join('\n')}\n` : '',
    (targetPhase === 1 && taskPlannerFigmaInstruction.length > 0) ? taskPlannerFigmaInstruction.join('\n') : '',
    figmaAlignInstruction.length > 0 ? figmaAlignInstruction.join('\n') : '',
    figmaDesignSpec.length > 0 ? figmaDesignSpec.join('\n') : '',
    '## 上一 Phase 摘要',
    summaryInfo ? `请读取上轮摘要文件获取完整信息（路径: ${summaryInfo.path}）` : '(无摘要)',
    '',
    lessons ? `## 历史教训\n${lessons.trim()}\n` : '',
    metricsInsights ? `## 度量洞察\n${metricsInsights.trim()}\n` : '',
    fixLoopContext ? `## 修复回路上下文 (第 ${fixLoopContext.round}/${fixLoopContext.maxRounds} 轮)\n${fixLoopContext.instruction}\n受影响文件: ${fixLoopContext.affectedFiles.join(', ') || '(见 fix-request.json)'}\n` : '',
    '## 契约文件内容',
    contractContents.length > 0 ? '请逐个读取以下契约文件获取完整内容（不要依赖摘要）：\n' + contractContents.join('\n') : '(无契约文件)',
    '',
    expectedDescriptions.length > 0
      ? `## 产出要求\n${expectedDescriptions.map(d => `- ${d}`).join('\n')}\n产出目录: .codebuddy/plans/${storyId}/`
      : '',
    '',
    (storyMode === 'fixbugs' && targetPhase === 2)
      ? '## Bug 修复说明\nBug 事实（问题复述 / 复现步骤 / 代码定位 / 根因）已在 Phase 0 分析完毕、并在 Phase 1 消化进 `task-dag.json` 与 `acceptance-criteria.json`。\n**以契约文件为准动手**: `task-dag.json` 的 `files[]` 就是改动范围，`acceptanceCriteria` 关联的 AC 描述里带 Bug 编号。\n修复怎么改由你设计: 先用 kb-query ∥ graphify 双源交叉验证确认真实改动点，再给出实现。\n'
      : '',
    repoSearchEntries.length > 0 ? repoSearchEntries.join('\n') : '',
    '## 约束',
    ...agentConstraints.map(c => `- 🚫 ${c}`),
    '',
    '## 完成后',
    '汇报产出物的完整路径，不要自行推进 Phase。'
  ]

  const result = {
    agent: agentInfo ? agentInfo.agent : null,
    agentLabel: agentInfo ? agentInfo.label : null,
    phaseInstruction: agentInfo ? agentInfo.instruction : null,
    agentPrompt: promptLines.filter(Boolean).join('\n'),
    contractFilesToLoad,
    agentConstraints,
    expectedOutputs,
    storyMode
  }

  if (lessons) result.lessonsFromHistory = lessons.trim()
  if (metricsInsights) result.metricsInsights = metricsInsights.trim()
  if (fixLoopContext) result.fixLoopContext = fixLoopContext

  return result
}

module.exports = {
  buildAgentPrompt,
  buildFixLoopContext,
  buildStoryInputSection,
  readContractContents,
  readStoryContext,
  readFigmaDesignSpec,
  buildFigmaAlignInstruction,
  buildTaskPlannerFigmaInstruction,
  buildRepoSearchEntries,
  probeGraphStatus,
  AGENT_CONSTRAINTS,
  SEARCH_CONSTRAINTS
}
