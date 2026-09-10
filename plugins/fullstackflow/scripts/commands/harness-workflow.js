#!/usr/bin/env node
/**
 * harness-workflow.js — FullstackFlow 模式激活与关闭（dev-pass 门控总开关）
 *
 * 职责:
 *   - 通过 .codebuddy/plans/.harness-active 标记文件控制 harness 模式的激活/关闭
 *   - start: 生成或采用 storyId，写标记文件，并内部调用 createWorkflow 同步创建 e2e-state.json
 *   - start --input: 建流前摄入并校验 story-input.json，使原型/Figma 判定一次算准
 *   - end: 删除标记文件，恢复 src/ 的自由编辑
 *   - status: 输出激活状态、当前 Phase、主仓库与涉及仓库
 *
 * 用法:
 *   node plugins/fullstackflow/scripts/commands/harness-workflow.js start <storyId> "<标题>" [--mode=run|fixbugs] [--input <file>]
 *     激活 harness 模式（写 .harness-active 标记文件）
 *   node plugins/fullstackflow/scripts/commands/harness-workflow.js end
 *     关闭 harness 模式（删除标记文件）
 *   node plugins/fullstackflow/scripts/commands/harness-workflow.js status
 *     查看当前状态
 *   storyId 可省略，缺省自动生成 STORY-YYYYMMDD-NN（扫描当日已有目录取最大序号 +1）
 *   --mode=fixbugs  Bug 修复模式：免除原型文档要求，Phase 0 改由需求分析师产出 Bug 分析报告
 *   --input <file>  摄入 story-input.json（也支持 --input=<file>）。文件内 mode 为准，
 *                   与 --mode 冲突或 schema 不符时拒绝启动，不写标记文件
 *
 * 使用场景:
 *   - 用户执行 `/fullstackflow:run` 或 `/fullstackflow:fixbugs` 时主 Agent 执行 start：
 *     开启 dev-pass 强制校验（此后编辑 src/ 需持 pass），
 *     同时建好工作流状态文件
 *   - harness-start skill 的两步初始化：先写 story-input.json，再 start --input 一步建流
 *   - 工作流走到 Phase 7 完成、归档收尾后，用户执行 `/fullstackflow:end`，主 Agent 调用 end 删除标记，
 *     解除编辑限制
 *   - 主 Agent 或用户想确认「harness 是否还开着、当前 Story 停在哪一 Phase、涉及哪些仓库」时执行 status
 *   - 已有 Story 未走标准激活流程时，可直接用 start 补一次激活；若已激活则拒绝并提示先 end
 *
 * 说明:
 *   - 设计思路:
 *       - 用户启动 FullstackFlow 时，AI 调用 `start` 创建标记文件
 *       - enforce-dev-pass.js 检查标记文件：有 → 需 dev-pass，无 → 直接放行
 *       - 工作流完成后，AI 调用 `end` 删除标记文件
 *       - 标记文件内容记录当前 activated story，方便 status 查询
 *   - 标记文件是 dev-pass 门控的总开关：删除标记等于整体解除 src/ 编辑限制，
 *     因此 end 只在确认工作流收尾后执行。
 *   - start 内部调用 create-workflow.js 的 createWorkflow 创建 e2e-state.json（断链修复）；
 *     该调用失败不阻塞 start，脚本会在输出里给出手工补救命令。
 *   - 多仓库唯一真实信源 = story 级 repos.json（由 AI 在 Phase 0/1 通过 ensureReposJson 预配置）。
 *     不再依赖任何宿主环境变量（CODEBUDDY_WORKSPACES/CLAUDE_WORKSPACES 均非官方变量，
 *     且原实现存在变量名不一致 bug）。
 *   - status 的 Phase 从 e2e-state.json 读取（唯一信源），避免与 .harness-active 中记录的 phase 不同步。
 *   - 本文件无 module.exports，仅作为 CLI 被主 Agent 调用。
 *
 * @module harness-workflow
 */

const fs = require('fs')
const path = require('path')
const { ensureReposJson, readStateFile, loadRepos, PROJECT_ROOT, PLANS_DIR } = require('../lib/state')
const { createWorkflow, precheckStoryInput, takeFlagValue } = require('./create-workflow')

// ─── 路径常量 ──────────────────────────────────────────────────
// PROJECT_ROOT / PLANS_DIR 单一信源: lib/state.js（含 CLAUDE_PROJECT_DIR 跨宿主回退）

/** harness 激活标记文件 */
const HARNESS_FLAG = path.join(PLANS_DIR, '.harness-active')

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 确保 plans 目录存在
 */
function ensurePlansDir() {
  if (!fs.existsSync(PLANS_DIR)) {
    fs.mkdirSync(PLANS_DIR, { recursive: true })
  }
}

/**
 * 读取标记文件内容
 * @returns {Object|null} 标记内容，不存在时返回 null
 */
function readFlag() {
  if (!fs.existsSync(HARNESS_FLAG)) return null
  try {
    return JSON.parse(fs.readFileSync(HARNESS_FLAG, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 写入标记文件
 * @param {Object} data - 标记数据
 */
function writeFlag(data) {
  ensurePlansDir()
  fs.writeFileSync(HARNESS_FLAG, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 删除标记文件
 */
function deleteFlag() {
  if (fs.existsSync(HARNESS_FLAG)) {
    fs.unlinkSync(HARNESS_FLAG)
  }
}

// ─── 命令处理 ──────────────────────────────────────────────────

/**
 * 自动生成 Story ID
 * @returns {string} 格式为 STORY-YYYYMMDD-NN
 */
function generateStoryId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `STORY-${today}`
  // 扫描已有 story，找到今日最大序号 +1
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

/**
 * 激活 harness 模式
 * @param {string} [storyId] - Story ID，不提供则自动生成
 * @param {string} [title] - 需求标题，不提供则标记为"待定"
 * @param {'run'|'fixbugs'} [mode='run'] - 工作流模式
 * @param {Object} [opts] - 可选项
 * @param {string} [opts.inputFile] - story-input.json 路径（--input），建流前摄入
 * @param {boolean} [opts.modeExplicit] - --mode 是否由用户显式给出
 */
function cmdStart(storyId, title, mode, opts = {}) {
  let workflowMode = mode === 'fixbugs' ? 'fixbugs' : 'run'

  // --input 先做无副作用校验，早于一切写操作。
  // 不能等 createWorkflow 里报错: 它被 try/catch 包住且失败不阻塞 start，
  // 那时 .harness-active 已经写下去了，会留下「标记已写、工作流未建」的半激活状态。
  if (opts.inputFile) {
    const pre = precheckStoryInput(opts.inputFile, workflowMode, opts.modeExplicit)
    if (!pre.ok) {
      console.error(JSON.stringify({ ok: false, errors: pre.errors }, null, 2))
      process.exit(1)
    }
    workflowMode = pre.mode
  }

  // 检查是否已有激活的 harness
  const existing = readFlag()
  if (existing && existing.active) {
    console.log(JSON.stringify({
      ok: false,
      message: `⚠️ Harness 模式已激活 (storyId: ${existing.storyId} "${existing.title}")，请先执行 /fullstackflow:end 结束当前工作流`,
      current: existing
    }))
    process.exit(0)
  }

  const id = storyId || generateStoryId()
  const name = title || '待定'

  // 多仓库唯一真实信源 = story 级 repos.json（由 AI 在 Phase 0/1 通过 ensureReposJson 预配置）
  // 不再依赖任何宿主环境变量（CODEBUDDY_WORKSPACES/CLAUDE_WORKSPACES 均非官方变量，且原实现存在变量名不一致 bug）
  // ensureReposJson: 若 repos.json 已存在（AI 预配置多仓库）则不覆盖，否则写入单仓库默认
  const reposConfig = ensureReposJson(id)

  const data = {
    active: true,
    storyId: id,
    title: name,
    mode: workflowMode,
    activatedAt: new Date().toISOString(),
    primaryRepo: reposConfig.primary,
    repoCount: Object.keys(reposConfig.repos).length
  }

  writeFlag(data)

  // 内部调用 create-workflow.js 创建 e2e-state.json（断链修复）
  let workflowResult = null
  try {
    workflowResult = createWorkflow(id, name, false, false, workflowMode, {
      inputFile: opts.inputFile,
      modeExplicit: opts.modeExplicit
    })
    if (workflowResult && workflowResult.success) {
      data.phase = workflowResult.phase
      data.e2eStateCreated = true
      if (workflowResult.storyInputFile) data.storyInputFile = workflowResult.storyInputFile
    }
  } catch (e) {
    // createWorkflow 失败不阻塞 start，AI 可后续手动补执行
    data.e2eStateCreated = false
    data.e2eStateError = e.message
  }

  console.log(JSON.stringify({
    ok: true,
    message: `✅ Harness 模式已激活\n   Story: ${id} "${name}"\n   模式: ${workflowMode}${workflowMode === 'fixbugs' ? ' (Bug 修复，免原型文档)' : ''}\n   Phase: 0 (需求分析)\n   标记文件: .codebuddy/plans/.harness-active` +
      (workflowResult?.success ? '\n   e2e-state.json: ✅ 已创建' : '\n   ⚠ e2e-state.json 创建失败，请手动执行: node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/create-workflow.js ' + id + ' "' + name + '" --mode=' + workflowMode) +
      (workflowResult?.storyInputFile ? '\n   story-input.json: ✅ 已摄入，原型/Figma 判定已算准，无需 --refresh-input' : ''),
    data
  }))
}

/**
 * 关闭 harness 模式
 */
function cmdEnd() {
  const existing = readFlag()

  if (!existing || !existing.active) {
    console.log(JSON.stringify({
      ok: true,
      message: 'ℹ️ Harness 模式未激活，无需关闭'
    }))
    process.exit(0)
  }

  const summary = {
    storyId: existing.storyId,
    title: existing.title,
    activatedAt: existing.activatedAt,
    completedAt: new Date().toISOString()
  }

  deleteFlag()

  console.log(JSON.stringify({
    ok: true,
    message: `✅ Harness 模式已关闭\n   Story: ${existing.storyId} "${existing.title}"\n   标记文件已删除，src/ 编辑恢复正常`,
    summary
  }))
}

/**
 * 查看当前 harness 状态
 */
function cmdStatus() {
  const existing = readFlag()

  if (!existing || !existing.active) {
    console.log(JSON.stringify({
      active: false,
      message: '🟢 普通模式 — src/ 编辑不受限制'
    }))
  } else {
    // phase 从 e2e-state.json 读取（唯一信源，避免与 .harness-active 不同步）
    const state = readStateFile(existing.storyId)
    const phase = (state && typeof state.phase === 'number') ? state.phase : 0
    // repos 从 story 级 repos.json 读取
    const repos = loadRepos(existing.storyId)
    console.log(JSON.stringify({
      active: true,
      message: `🔴 Harness 模式已激活\n   Story: ${existing.storyId} "${existing.title}"\n   激活时间: ${existing.activatedAt}\n   Phase: ${phase}\n   主仓库: ${repos.primary}\n   涉及仓库: ${Object.keys(repos.repos).join(', ')}\n   src/ 编辑需要 dev-pass`,
      data: { ...existing, phase, repoCount: Object.keys(repos.repos).length }
    }))
  }
}

// ─── 入口 ──────────────────────────────────────────────────────

// --input 支持 `--input=<p>` 与 `--input <p>`。空格形式的值 token 不以 -- 开头，
// 必须先摘掉，否则下面的 positional 过滤会把路径当成标题的一部分。
const { value: cliInput, rest: args } = takeFlagValue(process.argv.slice(2), '--input')
const command = args[0]

// --mode=run|fixbugs 可出现在任意位置，先摘出来再解析位置参数
const modeArg = args.find(a => a.startsWith('--mode='))
const cliMode = modeArg ? modeArg.slice('--mode='.length) : 'run'
const positional = args.filter(a => !a.startsWith('--'))

switch (command) {
  case 'start':
    if (cliMode !== 'run' && cliMode !== 'fixbugs') {
      console.error(`❌ 无效的 --mode 值: ${cliMode}（仅支持 run / fixbugs）`)
      process.exit(1)
    }
    cmdStart(positional[1], positional.slice(2).join(' ').replace(/^["']|["']$/g, ''), cliMode, {
      inputFile: cliInput,
      modeExplicit: Boolean(modeArg)
    })
    break

  case 'end':
    cmdEnd()
    break

  case 'status':
    cmdStatus()
    break

  default:
    console.log([
      'FullstackFlow 工作流管理脚本',
      '',
      '用法:',
      '  node harness-workflow.js start <storyId> "<标题>" [--mode=run|fixbugs] [--input <file>]   激活 harness 模式',
      '  node harness-workflow.js end                          关闭 harness 模式',
      '  node harness-workflow.js status                       查看当前状态',
      '',
      '  --mode=fixbugs   Bug 修复模式：免除原型文档要求，Phase 0 需求分析师负责产出 Bug 分析报告',
      '  --input <file>   建流前摄入 story-input.json，原型/Figma 判定一次算准（免去 --refresh-input）；',
      '                   文件内的 mode 为准，与 --mode 冲突则拒绝启动',
      '',
      '用户命令: /fullstackflow:run、/fullstackflow:fixbugs、/fullstackflow:status、/fullstackflow:end'
    ].join('\n'))
    process.exit(1)
}
