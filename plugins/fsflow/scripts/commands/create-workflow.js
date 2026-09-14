#!/usr/bin/env node
/**
 * create-workflow.js — 创建工作流状态文件并判定原型/Figma 门控
 *
 * 职责:
 *   - 创建 .codebuddy/plans/<storyId>/e2e-state.json，初始化 8 个 Phase 的状态与门控默认项
 *   - 判定并记录 prototypeRequired（是否要求 prototype-analysis.md）与 hasFigmaDesign（Figma 硬门控开关）
 *   - 确保 story 级 repos.json 存在；--bypass 时直接进入 Phase 2 并立即签发 dev-pass
 *   - --input: 建流前摄入并校验 story-input.json，使上述两项判定一次算准
 *   - --refresh-input: 在 story-input.json 写入后补算上述两项判定，不触碰 phase / status
 *   - --set-verification=full|review-only: Phase 4 记录用户测试选择，同步输入与状态，不推进 phase
 *
 * 用法:
 *   node plugins/fsflow/scripts/commands/create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs] [--input <file>]
 *   node plugins/fsflow/scripts/commands/create-workflow.js <storyId> --refresh-input [--figma]
 *   --bypass         跳过 Phase 0-1，直接进入 Phase 2（hotfix 场景），并立即签发 dev-pass
 *   --figma          手工强制开启 Figma 硬门控，覆盖自动推导（任何模式生效）
 *   --mode=<m>       工作流模式: run（默认，新功能开发）/ fixbugs（Bug 修复，免除原型文档要求）
 *   --input <file>   摄入 story-input.json 后再判定原型/Figma，免去 --refresh-input
 *                    （同时支持 --input=<file>；校验不通过则拒绝建流）
 *   --refresh-input  story-input.json 写入后补算原型/Figma 判定，只改这两项，不改 phase
 *
 * 使用场景:
 *   - 用户启动 FullstackFlow 后，由 harness-workflow.js start 内部调用 createWorkflow 创建状态文件；
 *     本命令是该调用的等价手工入口
 *   - 主 Agent 已经写好 story-input.json 时，用 --input 一步建流并算准判定（推荐路径）
 *   - 历史路径下 harness-workflow.js 先建工作流、主 Agent 此后才写 story-input.json，
 *     导致原型/Figma 判定失真时，主 Agent 执行 --refresh-input 回填
 *   - hotfix 场景不需要需求分析与任务规划时，加 --bypass 让 Story 直接落到 Phase 2 并拿到 dev-pass
 *   - 不走标准激活流程、需要单独为一个 Story 建流时，主 Agent 或用户手动执行本命令
 *
 * 说明:
 *   - 关于原型文档: 旧实现无条件检查 prototype-analysis.md，缺失即写入 Greenfield stub，
 *     导致 fixbugs 场景每个 Story 都留下一个空壳文件，还会被 context-refresh 当成 Phase 0 产出物收集。
 *     现改为按需判定 —— 只有 story-input.json 里真的给了原型/Figma 链接时才要求产出该文档，
 *     且由需求分析师产出，create-workflow 不再代写任何内容。
 *   - Figma 硬门控分模式处理: run 模式照设计稿从零搭 UI，需要完整 frame 清单 + 全量组件映射 → 按
 *     story-input.json 的 figmaUrls 自动推导开关；fixbugs 模式只碰个别页面，强制全量清单会卡死
 *     修复流程 → 默认关闭；--figma 是手工覆盖开关，无 story-input.json 时的兜底入口。
 *   - 门控开关不影响 prompt 注入。子 Agent 是否被提示解析 Figma 由 prompt-builder 直接读
 *     story-input.json 的 figmaUrls 决定，两种模式都注入。
 *   - --input 与 --refresh-input 的分工: 前者是正向路径（先有输入再建流，判定一次算准），
 *     后者是补救路径（建流后才拿到/改动输入）。两者都不碰 phase / status，
 *     相位跃迁仍归 advance-phase.js 独有。
 *   - --input 为 fail-closed: 文件缺失 / JSON 非法 / schema 不符一律拒绝建流，并且在写任何状态
 *     之前拒绝。静默放行会让一份错输入一路漂到 Phase 0 门控甚至 Phase 1 才暴露。
 *   - --input 的 mode 仲裁: 以文件内 mode 为准；与显式 --mode 冲突时报错退出，不静默取一方
 *     （两者分别驱动 e2e-state.mode 与 story-input.mode，分歧会让 getStoryMode() 与门控各读一半）。
 *   - --refresh-input 为何是显式命令而非惰性重算: 状态文件只能由授权脚本改写（enforce-state-file.js），
 *     在 dispatch 通道隐式改写会破坏"状态机单写者"这条铁律。
 *   - 工作流已存在（e2e-state.json 可读）时直接返回错误，不覆盖既有状态。
 *   - 输出: 成功 → 输出含 stateFile / message 的 JSON 并以退出码 0 结束；
 *     失败 → 输出 errors 数组并以退出码 1 结束。
 *   - module.exports = { createWorkflow, refreshStoryInput, precheckStoryInput, takeFlagValue }：
 *     前两个被同目录的 harness-workflow.js require（start 时同步创建 e2e-state.json 并透传 --input）；
 *     precheckStoryInput 供其在写 .harness-active 之前先做无副作用校验；
 *     takeFlagValue 供其复用同一套 flag 解析。CLI 分支由 require.main === module 守卫。
 *
 * @module create-workflow
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  readStateFile,
  writeStateFile,
  isPrototypeRequired,
  detectFigmaSource,
  issueDevPass,
  ensureReposJson,
  STORY_INPUT_FILE,
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS
} = require('../lib/state')
const { validateFile } = require('../services/schema-validator')

/**
 * 摘取 `--flag=<value>` / `--flag <value>` 两种形式的 flag 值
 *
 * 为何两种都支持: 用户与文档习惯写 `--input <file>`（空格分隔），而本目录既有的
 * `--mode=` 用等号形式。只认一种会让另一种静默失效 —— 空格形式尤其危险，
 * 值 token 不以 `--` 开头，会被位置参数解析吞掉（见 harness-workflow.js 的 positional 过滤）。
 *
 * @param {string[]} args - 原始 argv 片段
 * @param {string} flag - flag 名，含前导 `--`（如 '--input'）
 * @returns {{ value: string|null, rest: string[] }} rest 已剔除 flag 及其值 token
 */
function takeFlagValue (args, flag) {
  const rest = []
  let value = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === flag) {
      value = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : null
      if (value !== null) i++ // 连带跳过值 token，避免它落进位置参数
      continue
    }
    if (a.startsWith(flag + '=')) {
      value = a.slice(flag.length + 1)
      continue
    }
    rest.push(a)
  }

  return { value, rest }
}

/**
 * 校验 story-input.json 并仲裁 mode —— 纯检查，不写任何文件
 *
 * 独立于 ingestStoryInput 是为了让调用方能在产生任何副作用之前先失败。
 * harness-workflow.js 的 start 必须先过这一关再写 .harness-active，否则一份非法输入
 * 会留下「标记文件已写、工作流未建」的半激活状态。
 *
 * @param {string} inputFile - 用户给的 story-input.json 路径
 * @param {'run'|'fixbugs'} cliMode - CLI `--mode` 值
 * @param {boolean} modeExplicit - `--mode` 是否由用户显式给出（用于冲突判定）
 * @returns {{ ok: boolean, errors?: string[], mode?: 'run'|'fixbugs', input?: Object }}
 */
function precheckStoryInput (inputFile, cliMode, modeExplicit) {
  const result = validateFile(inputFile, 'story-input.schema.json')
  if (!result.valid) {
    return { ok: false, errors: [`--input 校验失败: ${inputFile}`, ...result.errors] }
  }

  const input = result.data
  const fileMode = input.mode === 'fixbugs' ? 'fixbugs' : 'run'

  // mode 仲裁: 文件内的 mode 为准。与显式 --mode 冲突时报错而不静默取一方 ——
  // 两者分别驱动 e2e-state.mode 与 story-input.mode，静默分歧会让 getStoryMode()
  // 与门控判定各读一半，排查成本远高于当场失败。
  if (modeExplicit && cliMode !== fileMode) {
    return {
      ok: false,
      errors: [
        `mode 冲突: --mode=${cliMode} 与 ${STORY_INPUT_FILE} 的 "mode": "${fileMode}" 不一致`,
        '请去掉 --mode（以文件为准），或把两处改成同一个值'
      ]
    }
  }

  return { ok: true, mode: fileMode, input }
}

/**
 * 摄入 story-input.json（`--input <file>`）
 *
 * 为何要有这一步: 原流程是 `start` 先建流、主 Agent 之后才写 story-input.json，
 * createWorkflow 执行时该文件尚不存在 —— prototypeRequired 走保守分支恒 true、
 * hasFigmaDesign 恒 false，必须再补一条 `--refresh-input` 回填。漏执行那条命令
 * 就会让 Figma 硬门控静默失效。先摄入输入再判定，这类故障从源头消失。
 *
 * fail-closed: 文件缺失 / JSON 非法 / schema 不符 / mode 冲突一律拒绝，且**在建流之前**拒绝，
 * 不留下半成品状态。
 *
 * @param {string} storyId - Story ID
 * @param {string} title - 需求标题（回填用）
 * @param {string} inputFile - 用户给的 story-input.json 路径
 * @param {'run'|'fixbugs'} cliMode - CLI `--mode` 值
 * @param {boolean} modeExplicit - `--mode` 是否由用户显式给出
 * @returns {{ ok: boolean, errors?: string[], mode?: 'run'|'fixbugs', target?: string }}
 */
function ingestStoryInput (storyId, title, inputFile, cliMode, modeExplicit) {
  const pre = precheckStoryInput(inputFile, cliMode, modeExplicit)
  if (!pre.ok) return pre

  const input = pre.input

  // 回填顶层三字段，让调用方只需写 { mode, sources }
  if (!input.storyId) input.storyId = storyId
  if (!input.title && title) input.title = title
  if (!input.createdAt) input.createdAt = new Date().toISOString()

  const target = path.join(PLANS_DIR, storyId, STORY_INPUT_FILE)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(input, null, 2) + '\n', 'utf-8')

  return {
    ok: true,
    mode: pre.mode,
    verificationMode: input.verificationMode || 'ask',
    target
  }
}

/**
 * 判定本 Story 是否开启 Figma 硬门控（hasFigmaDesign）
 *
 * 分模式处理 —— run 与 fixbugs 对设计稿的用法本质不同:
 *   - run: 照设计稿从零搭 UI，需要完整 frame 清单 + 全量组件映射 → 开门控
 *   - fixbugs: 只碰个别页面，强制全量清单会卡死修复流程 → 关门控
 *   - --figma: 手工覆盖，任何模式下强制开启（无 story-input.json 时的兜底入口）
 *
 * ⚠️ 门控开关不影响 prompt 注入。子 Agent 是否被提示解析 Figma 由
 * prompt-builder 直接读 story-input.json 的 figmaUrls 决定，两种模式都注入。
 *
 * @param {string} storyId - Story ID
 * @param {boolean} hasFigmaFlag - CLI `--figma` 手工开关
 * @param {'run'|'fixbugs'} workflowMode - 工作流模式
 * @param {boolean} bypass - 是否跳过 Phase 0-1
 * @returns {{ enabled: boolean, reason: string, detectedUrls: number }}
 */
function resolveFigmaDesign (storyId, hasFigmaFlag, workflowMode, bypass) {
  const detected = detectFigmaSource(storyId)

  if (hasFigmaFlag) {
    return { enabled: true, reason: '--figma 手工指定', detectedUrls: detected.urls.length }
  }
  if (bypass) {
    return { enabled: false, reason: 'bypass 模式跳过 Phase 0-1，Figma 门控无意义', detectedUrls: detected.urls.length }
  }
  if (workflowMode === 'fixbugs') {
    return {
      enabled: false,
      reason: 'fixbugs 模式不做全量设计稿还原（如需强制开启用 --figma）',
      detectedUrls: detected.urls.length
    }
  }
  return { enabled: detected.hasFigma, reason: detected.reason, detectedUrls: detected.urls.length }
}

/**
 * 执行工作流创建
 * @param {string} storyId - Story ID
 * @param {string} title - 需求标题
 * @param {boolean} bypass - 是否跳过 Phase 0-1（hotfix 模式）
 * @param {boolean} hasFigma - 是否提供了 Figma 设计稿（CLI --figma 手工开关）
 * @param {'run'|'fixbugs'} [mode='run'] - 工作流模式
 * @param {Object} [opts] - 可选项
 * @param {string} [opts.inputFile] - story-input.json 路径（--input），建流前摄入并据此判定
 * @param {boolean} [opts.modeExplicit] - --mode 是否由用户显式给出，用于与 inputFile 的 mode 做冲突判定
 * @returns {{ success: boolean, storyId: string, message: string, errors?: string[] }}
 */
function createWorkflow (storyId, title, bypass, hasFigma, mode, opts = {}) {
  const errors = []
  let workflowMode = mode === 'fixbugs' ? 'fixbugs' : 'run'
  let verificationMode = 'ask'

  // 1. 检查是否已有状态文件
  const existingState = readStateFile(storyId)
  if (existingState) {
    errors.push(`工作流已存在: .codebuddy/plans/${storyId}/e2e-state.json (当前 phase=${existingState.phase})`)
    return { success: false, storyId, errors }
  }

  // 1b. 摄入 story-input.json（--input）—— 必须早于第 2/2b 步的判定，
  //     否则 isPrototypeRequired / detectFigmaSource 读不到输入，只能走保守分支
  let storyInputFile = null
  if (opts.inputFile) {
    const ingested = ingestStoryInput(storyId, title, opts.inputFile, workflowMode, opts.modeExplicit)
    if (!ingested.ok) {
      return { success: false, storyId, errors: ingested.errors }
    }
    workflowMode = ingested.mode
    verificationMode = ingested.verificationMode
    storyInputFile = ingested.target
  }

  // 2. 判定本 Story 是否需要原型分析文档
  //    bypass 跳过 Phase 0，fixbugs 无原型依赖，两者都直接免除
  //    ⚠️ 不在此处写任何 stub —— 需要时由需求分析师在 Phase 0 产出
  let protoRequired
  if (bypass) {
    protoRequired = { required: false, reason: 'bypass 模式跳过 Phase 0' }
  } else if (workflowMode === 'fixbugs') {
    protoRequired = { required: false, reason: 'fixbugs 模式，Bug 修复无原型依赖' }
  } else {
    protoRequired = isPrototypeRequired(storyId)
  }

  // 2b. 判定 Figma 硬门控开关（run 开 / fixbugs 关 / --figma 强制开）
  const figma = resolveFigmaDesign(storyId, hasFigma, workflowMode, bypass)

  // 3. 确保 story 级 repos.json 存在（单仓库自动生成默认，多仓库由 AI 预先写入覆盖）
  ensureReposJson(storyId)

  // 4. 创建状态文件
  const now = new Date().toISOString()
  const initialPhase = bypass ? 2 : 0

  /** @type {Object} e2e 状态对象 */
  const state = {
    storyId,
    title,
    phase: initialPhase,
    status: 'running',
    mode: workflowMode, // run | fixbugs —— story-input.json 缺失时的模式回退信源
    createdAt: now,
    updatedAt: now,
    bypass: bypass || false,
    verificationMode,
    hasFigmaDesign: figma.enabled, // 🌐 是否开启 Figma 硬门控（信源: story-input.json figmaUrls / --figma）
    hasFigmaDesignReason: figma.reason, // 判定依据，便于排查门控为何未触发
    // 修复回路最大轮次 —— 按失败源（Phase 3 代码审查 / Phase 4 功能测试）独立预算，各 2 次，用尽转人工
    maxReviewFixRounds: DEFAULT_MAX_REVIEW_FIX_ROUNDS,
    maxTestFixRounds: DEFAULT_MAX_TEST_FIX_ROUNDS,
    gateChecks: {
      // 本 Story 是否要求 prototype-analysis.md（false 时 Phase 0→1 门控跳过原型检查）
      prototypeRequired: protoRequired.required,
      prototypeRequiredReason: protoRequired.reason,
      // 不需要原型时视同已确认，避免门控卡住
      prototypeConfirmed: !protoRequired.required,
      documentConfirmed: false,
      apiSpecConfirmed: false,
      gateValidationResults: []
    },
    phases: {}
  }

  // 初始化所有 Phase 的状态
  const phaseKeys = [
    '0_requirement_analysis',
    '1_task_planning',
    '2_development',
    '3_code_review',
    '4_e2e_verification',
    '5_git_submit',
    '6_knowledge_base_update',
    '7_deployment'
  ]

  for (let i = 0; i < phaseKeys.length; i++) {
    if (bypass && i < initialPhase) {
      // bypass 模式下，跳过的 Phase 标记为 skipped
      state.phases[phaseKeys[i]] = {
        status: 'skipped',
        assignedTo: 'bypass',
        output: 'bypass 模式跳过'
      }
    } else if (i === initialPhase) {
      state.phases[phaseKeys[i]] = {
        status: bypass ? 'running' : 'pending'
      }
    } else {
      state.phases[phaseKeys[i]] = { status: 'pending' }
    }
  }

  // bypass 模式下，Phase 2 标记为 running
  if (bypass) {
    state.phases['2_development'] = {
      status: 'running',
      assignedTo: '全栈开发工程师',
      startedAt: now
    }
  }

  // 5. 写入状态文件（通过 hook-utils 写入 Story 子目录）
  writeStateFile(storyId, state)
  const stateFilePath = path.join(PLANS_DIR, storyId, 'e2e-state.json')

  // 6. bypass 模式下签发 dev-pass
  if (bypass) {
    issueDevPass(storyId)
  }

  return {
    success: true,
    storyId,
    title,
    phase: initialPhase,
    bypass,
    mode: workflowMode,
    verificationMode,
    prototypeRequired: protoRequired.required,
    hasFigmaDesign: figma.enabled,
    stateFile: stateFilePath,
    storyInputFile,
    message: bypass
      ? `✅ 工作流已创建（bypass 模式），直接进入 Phase 2 (代码开发)，dev-pass 已签发`
      : `✅ 工作流已创建（mode=${workflowMode}），当前 Phase 0 (需求分析)，请 spawn 需求分析师 (agent 注册名: requirement-analyst)` +
        (storyInputFile ? `\n   story-input.json: ✅ 已摄入，原型/Figma 判定已按输入算准，无需 --refresh-input` : '') +
        (protoRequired.required
          ? `\n   原型文档: 必需 — ${protoRequired.reason}，由需求分析师产出 prototype-analysis.md`
          : `\n   原型文档: 免除 — ${protoRequired.reason}`) +
        `\n   Figma 门控: ${figma.enabled ? '开启' : '关闭'} — ${figma.reason}` +
        (storyInputFile
          ? ''
          : `\n   ⚠️ 若 story-input.json 是在本命令之后才写入的，请执行:` +
            `\n      node ${path.basename(__filename)} ${storyId} --refresh-input`)
  }
}

/**
 * 补算 story-input.json 派生的判定结果（--refresh-input）
 *
 * 为何需要这条命令: harness-workflow.js 的 Step 1A 先创建工作流，主 Agent 的
 * Step 1B 才写 story-input.json。createWorkflow 执行时该文件尚不存在，
 * prototypeRequired 走「保守要求」分支、hasFigmaDesign 恒为 false。
 * 主 Agent 写完 story-input.json 后执行本命令回填，让两项判定与实际输入一致。
 *
 * 显式命令而非惰性重算 —— 状态文件只能由授权脚本改写（enforce-state-file.js），
 * 在 dispatch 通道隐式改写会破坏「状态机单写者」这条铁律。
 *
 * 只回填这两项，不触碰 phase / status —— 相位跃迁仍归 advance-phase.js 独有。
 *
 * @param {string} storyId - Story ID
 * @param {boolean} [hasFigmaFlag=false] - 是否附带 --figma 手工开关
 * @returns {{ success: boolean, storyId: string, message?: string, errors?: string[] }}
 */
function refreshStoryInput (storyId, hasFigmaFlag = false) {
  const state = readStateFile(storyId)
  if (!state) {
    return { success: false, storyId, errors: [`工作流不存在: 未找到 .codebuddy/plans/${storyId}/e2e-state.json`] }
  }

  const workflowMode = state.mode === 'fixbugs' ? 'fixbugs' : 'run'
  const bypass = state.bypass || false

  const protoRequired = (bypass || workflowMode === 'fixbugs')
    ? { required: false, reason: bypass ? 'bypass 模式跳过 Phase 0' : 'fixbugs 模式，Bug 修复无原型依赖' }
    : isPrototypeRequired(storyId)
  const figma = resolveFigmaDesign(storyId, hasFigmaFlag || state.hasFigmaDesign, workflowMode, bypass)
  let verificationMode = state.verificationMode || 'full'
  try {
    const inputPath = path.join(PLANS_DIR, storyId, STORY_INPUT_FILE)
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
    if (['ask', 'full', 'review-only'].includes(input.verificationMode)) {
      verificationMode = input.verificationMode
    }
  } catch (_) { /* 无输入或解析失败时保留当前模式 */ }

  const before = {
    proto: state.gateChecks.prototypeRequired,
    figma: state.hasFigmaDesign,
    verificationMode: state.verificationMode || 'full'
  }

  state.hasFigmaDesign = figma.enabled
  state.hasFigmaDesignReason = figma.reason
  state.verificationMode = verificationMode
  state.gateChecks.prototypeRequired = protoRequired.required
  state.gateChecks.prototypeRequiredReason = protoRequired.reason
  state.gateChecks.prototypeConfirmed = !protoRequired.required
  state.updatedAt = new Date().toISOString()
  writeStateFile(storyId, state)

  const changed = before.proto !== protoRequired.required || before.figma !== figma.enabled ||
    before.verificationMode !== verificationMode
  return {
    success: true,
    storyId,
    prototypeRequired: protoRequired.required,
    hasFigmaDesign: figma.enabled,
    verificationMode,
    message: `${changed ? '✅ 判定已更新' : 'ℹ️ 判定无变化'}（mode=${workflowMode}）` +
      `\n   原型文档: ${protoRequired.required ? '必需' : '免除'} — ${protoRequired.reason}` +
      `\n   Figma 门控: ${figma.enabled ? '开启' : '关闭'} — ${figma.reason}`
  }
}

/** 记录 Phase 4 的用户选择；只更新验证策略，不推进 Phase。 */
function setVerificationMode (storyId, mode) {
  if (!storyId || storyId.startsWith('--')) {
    return { success: false, errors: ['记录测试选择需要 storyId'] }
  }
  if (!['full', 'review-only'].includes(mode)) {
    return { success: false, errors: ['验证选择仅支持 full / review-only'] }
  }
  const state = readStateFile(storyId)
  if (!state || state._parseError || state.phase !== 4 || state.status !== 'running') {
    return { success: false, errors: ['仅可在运行中的 Phase 4 记录测试选择'] }
  }
  const inputPath = path.join(PLANS_DIR, storyId, STORY_INPUT_FILE)
  if (fs.existsSync(inputPath)) {
    const checked = validateFile(inputPath, 'story-input.schema.json')
    if (!checked.valid) return { success: false, errors: checked.errors }
    checked.data.verificationMode = mode
    fs.writeFileSync(inputPath, JSON.stringify(checked.data, null, 2) + '\n', 'utf-8')
  }
  state.verificationMode = mode
  state.updatedAt = new Date().toISOString()
  writeStateFile(storyId, state)
  return { success: true, storyId, verificationMode: mode, phase: state.phase }
}

// ─── 执行（CLI 模式） ──────────────────────────────────────────

if (require.main === module) {
  // --input 支持 `--input=<p>` 与 `--input <p>` 两种形式；后者的值 token 不以 -- 开头，
  // 必须先摘出来，否则会被当成位置参数（storyId / title）
  const { value: cliInput, rest: args } = takeFlagValue(process.argv.slice(2), '--input')

  const cliStoryId = args[0]
  const cliTitle = args[1]
  const cliBypass = args.includes('--bypass')
  const cliHasFigma = args.includes('--figma')
  const modeArg = args.find(a => a.startsWith('--mode='))
  const cliMode = modeArg ? modeArg.slice('--mode='.length) : 'run'
  const cliRefreshInput = args.includes('--refresh-input')
  const verificationArg = args.find(a => a.startsWith('--set-verification='))
  if (verificationArg) {
    const result = setVerificationMode(cliStoryId, verificationArg.slice('--set-verification='.length))
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.success ? 0 : 1)
  }

  // --refresh-input 只需 storyId（模式/bypass 从既有状态文件读取）
  if (cliRefreshInput) {
    if (!cliStoryId) {
      console.error('用法: node create-workflow.js <storyId> --refresh-input [--figma]')
      process.exit(1)
    }
    const refreshResult = refreshStoryInput(cliStoryId, cliHasFigma)
    console.log(JSON.stringify(refreshResult, null, 2))
    process.exit(refreshResult.success ? 0 : 1)
  }

  if (!cliStoryId || !cliTitle) {
    console.error('用法: node create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs] [--input <file>]')
    console.error('      node create-workflow.js <storyId> --refresh-input [--figma]')
    console.error('      node create-workflow.js <storyId> --set-verification=full|review-only')
    console.error('示例: node create-workflow.js STORY-001 "1v1客服等级分配模式"')
    console.error('  --bypass          跳过 Phase 0-1')
    console.error('  --figma           手工强制开启 Figma 硬门控（任何模式生效，覆盖自动推导）')
    console.error('  --mode=fixbugs    Bug 修复模式，免除原型文档要求，Phase 0 需产出 Bug 分析报告')
    console.error('  --input <file>    建流前摄入 story-input.json，据此算准原型/Figma 判定（免去 --refresh-input）')
    console.error('  --refresh-input   story-input.json 写入后补算原型/Figma 判定（不改 phase）')
    process.exit(1)
  }

  if (cliMode !== 'run' && cliMode !== 'fixbugs') {
    console.error(`❌ 无效的 --mode 值: ${cliMode}（仅支持 run / fixbugs）`)
    process.exit(1)
  }

  const result = createWorkflow(cliStoryId, cliTitle, cliBypass, cliHasFigma, cliMode, {
    inputFile: cliInput,
    modeExplicit: Boolean(modeArg)
  })
  if (result.success) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } else {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
}

module.exports = { createWorkflow, refreshStoryInput, setVerificationMode, precheckStoryInput, takeFlagValue }
