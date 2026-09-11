#!/usr/bin/env node
/**
 * kb 系列脚本回归测试（kb-init / kb-update / gen-docs）
 *
 * 覆盖 2026-09-09 修复的三个 bug 的回归面 + 基本功能：
 *   1. kb-init: 插件市场仓识别（plugins/<name>/plugin.json + agents/skills/hooks）、
 *      dry-run 不落盘、正式初始化目录结构、.docs/llm-knowledge 唯一根
 *   2. kb-update: 通配符域匹配（修复前 *.md 去星号后前缀永远不命中）、
 *      designDocs 归域（修复前硬编码 settings）、无效 hash 兜底 HEAD~1
 *   3. gen-docs: 全量/单域文件收集、裸文件名 src 前缀兜底（修复前未实现）、stale 检测
 *
 * 沙箱策略：mkdtemp 临时目录 + 真实 git init（脚本依赖 git diff），
 *          三个脚本都用 process.cwd() 定位项目根，故用 spawnSync cwd 指向沙箱。
 *          跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/kb-scripts.test.js
 *   npm test            （在 plugins/fsflow 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execSync } = require('child_process')

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')
const KB_INIT = path.join(PLUGIN_ROOT, 'skills', 'kb-init', 'kb-init.cjs')
const KB_UPDATE = path.join(PLUGIN_ROOT, 'skills', 'kb-update', 'kb-update.cjs')
const GEN_DOCS = path.join(PLUGIN_ROOT, 'skills', 'gen-project-docs', 'gen-docs.cjs')

let pass = 0
const failures = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`) }
}
function section (t) { console.log(`\n-- ${t} --`) }

/** 跑脚本：cwd 指向沙箱，返回 stdout 中最后一个完整 JSON 对象。
 *  env 做净化：清掉宿主 IDE 注入的 *_PROJECT_DIR / *_PLUGIN_ROOT，
 *  确保 kb 脚本（以 process.cwd() 为项目根）定位到沙箱而非宿主项目。 */
function runScript (script, args, cwd) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/PROJECT_DIR|PLUGIN_ROOT/.test(k)) env[k] = v
  }
  const r = spawnSync(process.execPath, [script, ...(args || [])], { cwd, encoding: 'utf-8', timeout: 30000, env })
  if (r.status !== 0) return { __error: (r.stderr || r.stdout || '').slice(0, 300) }
  // 从 stdout 提取最后一个可解析的顶层 JSON（兼容多行嵌套 / 单行 / 尾随文本三种情况）：
  // 先截到最后一个 '}'，再从后往前扫每个 '{' 尝试 JSON.parse。
  // 嵌套对象的 '{' 解析必然失败（缺右括号），只有顶层的 '{' 才能成功。
  const out = (r.stdout || '').trimEnd()
  const bounded = out.slice(0, out.lastIndexOf('}') + 1)
  for (let i = bounded.length - 1; i >= 0; i--) {
    if (bounded[i] !== '{') continue
    try { return JSON.parse(bounded.slice(i)) } catch (e) { /* 试下一个 '{' */ }
  }
  return { __error: 'no JSON in output', raw: out.slice(0, 200) }
}

function git (cwd, cmd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15000 })
}

function mkSandbox (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  git(dir, 'git init -q .')
  git(dir, 'git config user.email t@t.com')
  git(dir, 'git config user.name t')
  // kb 系列脚本约定：meta.yaml 必须存在于 .docs/llm-knowledge/（kb-init 负责创建骨架）
  fs.mkdirSync(path.join(dir, '.docs', 'llm-knowledge'), { recursive: true })
  return dir
}

/** 写 meta.yaml（先建好目录） */
function writeMeta (dir, hash, domains) {
  const metaDir = path.join(dir, '.docs', 'llm-knowledge')
  fs.mkdirSync(metaDir, { recursive: true })
  const lines = ['git:', `  hash: "${hash}"`, 'domains:']
  for (const d of domains) {
    lines.push(`  - id: "${d.id}"`)
    lines.push(`    path: "${d.path}"`)
    lines.push(`    entry_files: ["${d.files.join('", "')}"]`)
  }
  fs.writeFileSync(path.join(metaDir, 'meta.yaml'), lines.join('\n'))
}

// ══════════════════════════════════════════════════════════
// 1. kb-init
// ══════════════════════════════════════════════════════════
section('1. kb-init: 嵌套插件市场仓识别（修复回归）')
{
  const sb = mkSandbox('kb-init-')
  // 仿真插件市场仓结构
  fs.mkdirSync(path.join(sb, 'plugins', 'demo', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'plugins', 'demo', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'plugins', 'demo', 'plugin.json'), '{"name":"demo"}')

  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('dry-run 识别 projectType=plugin', dry.projectType === 'plugin', JSON.stringify(dry).slice(0, 120))
  ok('dry-run sourceRoot 指向 plugins/demo', dry.sourceRoot === 'plugins/demo', dry.sourceRoot)
  ok('dry-run 不落盘（.docs/llm-knowledge 下无新文件）',
    fs.readdirSync(path.join(sb, '.docs', 'llm-knowledge')).length === 0)

  const init = runScript(KB_INIT, [], sb)
  ok('正式初始化识别 plugin', init.projectType === 'plugin')
  ok('域包含 agents/skills', init.domains.includes('agents') && init.domains.includes('skills'))
  ok('知识库根为 .docs/llm-knowledge', init.kbRoot === '.docs/llm-knowledge')
  ok('.profile.yaml 落盘', fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', '.profile.yaml')))
  ok('common/conventions.md 落盘', fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', 'common', 'conventions.md')))
  ok('域目录 business/agents/custom 存在', fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'agents', 'custom')))

  fs.rmSync(sb, { recursive: true, force: true })
}

section('1b. kb-init: Java Maven 后端按业务域聚合（不按类生成文档）')
{
  const sb = mkSandbox('kb-init-java-')
  fs.writeFileSync(path.join(sb, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>')
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'controller'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'service'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'mapper'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'user', 'controller'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'resources', 'mapper', 'order'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'controller', 'OrderController.java'), 'class OrderController {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'service', 'OrderService.java'), 'class OrderService {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'mapper', 'OrderMapper.java'), 'class OrderMapper {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'user', 'controller', 'UserController.java'), 'class UserController {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'resources', 'mapper', 'order', 'OrderMapper.xml'), '<mapper></mapper>')

  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('Maven 项目识别 projectType=backend', dry.projectType === 'backend', JSON.stringify(dry).slice(0, 160))
  ok('Maven sourceRoot=src/main/java', dry.sourceRoot === 'src/main/java', dry.sourceRoot)
  ok('后端域按 order/user 聚合', dry.domains.includes('order') && dry.domains.includes('user'), JSON.stringify(dry.domains))
  ok('不把 Java 类名当成 domain', !dry.domains.includes('order-controller') && !dry.domains.includes('order-service'), JSON.stringify(dry.domains))
  ok('后端模板包含 routes/api/models', ['routes', 'api', 'models'].every(t => dry.templates.includes(t)), JSON.stringify(dry.templates))
  ok('order 域文件线索聚合 Controller/Service/Mapper/XML',
    dry.domainFileHints?.order?.source_files?.length === 3 &&
    dry.domainFileHints?.order?.resource_files?.some(f => f.endsWith('OrderMapper.xml')),
    JSON.stringify(dry.domainFileHints?.order))

  const init = runScript(KB_INIT, [], sb)
  ok('正式初始化 backend 模板落盘 routes/api/models',
    ['routes.template.md', 'api.template.md', 'models.template.md'].every(f => fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', 'templates', f))))
  ok('正式初始化 backend overview 模板覆盖通用前端化模板',
    /后端域总览/.test(fs.readFileSync(path.join(sb, '.docs', 'llm-knowledge', 'templates', 'overview.template.md'), 'utf-8')))
  ok('正式初始化 profile 记录 resource_root',
    /resource_root: "src\/main\/resources"/.test(fs.readFileSync(path.join(sb, '.docs', 'llm-knowledge', '.profile.yaml'), 'utf-8')))
  ok('正式初始化没有生成类级 md',
    !fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'order', 'OrderController.md')) &&
    init.domains.includes('order'))

  fs.rmSync(sb, { recursive: true, force: true })
}

section('1c. kb-init: Java 分层包从类名前缀聚合业务域')
{
  const sb = mkSandbox('kb-init-java-layered-')
  fs.writeFileSync(path.join(sb, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>')
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'controller'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'service'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'controller', 'OrderController.java'), 'class OrderController {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'service', 'OrderService.java'), 'class OrderService {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'controller', 'UserController.java'), 'class UserController {}')

  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('分层包按类名前缀识别 order/user', dry.domains.includes('order') && dry.domains.includes('user'), JSON.stringify(dry.domains))
  ok('分层包不把应用包 demo 当业务域', !dry.domains.includes('demo'), JSON.stringify(dry.domains))

  fs.rmSync(sb, { recursive: true, force: true })
}

section('1d. kb-init: 多模块 Maven reactor 跨 module 聚合业务域')
{
  const sb = mkSandbox('kb-init-maven-multi-')
  fs.writeFileSync(path.join(sb, 'pom.xml'), [
    '<project>',
    '  <packaging>pom</packaging>',
    '  <modules>',
    '    <module>order-service</module>',
    '    <module>user-service</module>',
    '  </modules>',
    '</project>'
  ].join('\n'))
  for (const mod of ['order-service', 'user-service']) {
    fs.mkdirSync(path.join(sb, mod, 'src', 'main', 'java', 'com', 'demo', mod.startsWith('order') ? 'order' : 'user', 'controller'), { recursive: true })
    fs.mkdirSync(path.join(sb, mod, 'src', 'main', 'resources', 'mapper', mod.startsWith('order') ? 'order' : 'user'), { recursive: true })
    fs.writeFileSync(path.join(sb, mod, 'pom.xml'), '<project><parent/></project>')
  }
  fs.writeFileSync(path.join(sb, 'order-service', 'src', 'main', 'java', 'com', 'demo', 'order', 'controller', 'OrderController.java'), 'class OrderController {}')
  fs.writeFileSync(path.join(sb, 'order-service', 'src', 'main', 'java', 'com', 'demo', 'order', 'controller', 'OrderService.java'), 'class OrderService {}')
  fs.writeFileSync(path.join(sb, 'order-service', 'src', 'main', 'resources', 'mapper', 'order', 'OrderMapper.xml'), '<mapper></mapper>')
  fs.writeFileSync(path.join(sb, 'user-service', 'src', 'main', 'java', 'com', 'demo', 'user', 'controller', 'UserController.java'), 'class UserController {}')

  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('多模块 Maven 识别 projectType=backend', dry.projectType === 'backend', JSON.stringify(dry).slice(0, 160))
  ok('多模块 Maven sourceRoot=.', dry.sourceRoot === '.', dry.sourceRoot)
  ok('多模块 Maven 输出 module 清单', dry.mavenModules?.includes('order-service') && dry.mavenModules?.includes('user-service'), JSON.stringify(dry.mavenModules))
  ok('多模块 Maven 输出 sourceRoots', dry.sourceRoots?.includes('order-service/src/main/java') && dry.sourceRoots?.includes('user-service/src/main/java'), JSON.stringify(dry.sourceRoots))
  ok('多模块 Maven 跨 module 聚合 order/user 域', dry.domains.includes('order') && dry.domains.includes('user'), JSON.stringify(dry.domains))
  ok('多模块 Maven 文件线索保留 module 前缀',
    dry.domainFileHints?.order?.source_files?.some(f => f === 'order-service/src/main/java/com/demo/order/controller/OrderController.java') &&
    dry.domainFileHints?.order?.resource_files?.some(f => f === 'order-service/src/main/resources/mapper/order/OrderMapper.xml'),
    JSON.stringify(dry.domainFileHints?.order))

  const init = runScript(KB_INIT, [], sb)
  const profile = fs.readFileSync(path.join(sb, '.docs', 'llm-knowledge', '.profile.yaml'), 'utf-8')
  ok('多模块 profile 写入 maven_modules', /maven_modules: \["order-service", "user-service"\]/.test(profile), profile)
  ok('多模块不生成模块级 md', !fs.existsSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'order-service.md')) && init.domains.includes('order'))

  fs.rmSync(sb, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════
// 2. kb-update
// ══════════════════════════════════════════════════════════
section('2. kb-update: 通配符域匹配（修复回归：*.md 去星号后前缀失效）')
{
  const sb = mkSandbox('kb-upd-')
  fs.mkdirSync(path.join(sb, 'plugins', 'harness', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'views', 'settings'), { recursive: true })
  fs.mkdirSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'settings'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'plugins', 'harness', 'agents', 'a.md'), 'a')
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S1.vue'), 's')
  git(sb, 'git add -A && git commit -qm init')
  const baseHash = git(sb, 'git rev-parse HEAD').trim()

  writeMeta(sb, baseHash, [
    { id: 'settings', path: 'business/settings/', files: ['src/views/settings/*.vue'] },
    { id: 'scripts-core', path: 'business/scripts-core/', files: ['plugins/harness/agents/*.md'] }
  ])

  // 第二次提交：settings 域 + scripts-core 域各改一个文件
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S2.vue'), 's2')
  fs.writeFileSync(path.join(sb, 'plugins', 'harness', 'agents', 'a2.md'), 'a2')
  git(sb, 'git add -A && git commit -qm change')

  const r = runScript(KB_UPDATE, [], sb)
  const ids = (r.affectedDomains || []).map(d => d.id)
  ok('settings 域命中 S2.vue（通配符 *.vue）', ids.includes('settings'), JSON.stringify(ids))
  ok('scripts-core 域命中 a2.md（通配符 *.md，修复前失效）', ids.includes('scripts-core'), JSON.stringify(ids))
  ok('changedFiles 含两个变更文件', (r.changedFiles || []).length >= 2)

  fs.rmSync(sb, { recursive: true, force: true })
}

section('2b. kb-update: designDocs 归域不硬编码 settings（修复回归）')
{
  const sb = mkSandbox('kb-upd2-')
  fs.mkdirSync(path.join(sb, 'src', 'views', 'chat'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'views', 'settings'), { recursive: true })
  fs.mkdirSync(path.join(sb, '.codebuddy', 'plans', 'STORY-001'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'views', 'chat', 'C1.vue'), 'c')
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S1.vue'), 's')
  git(sb, 'git add -A && git commit -qm init')
  const baseHash = git(sb, 'git rev-parse HEAD').trim()

  writeMeta(sb, baseHash, [
    { id: 'chat', path: 'business/chat/', files: ['src/views/chat/*.vue'] },
    { id: 'settings', path: 'business/settings/', files: ['src/views/settings/*.vue'] }
  ])

  // 只改 chat 域（2 个文件），settings 域不动 → 修复前会硬编码归到 settings
  fs.writeFileSync(path.join(sb, 'src', 'views', 'chat', 'C2.vue'), 'c2')
  fs.writeFileSync(path.join(sb, 'src', 'views', 'chat', 'C3.vue'), 'c3')
  git(sb, 'git add -A && git commit -qm change')
  // e2e-state 不写 domain → 走受影响域兜底逻辑
  fs.writeFileSync(path.join(sb, '.codebuddy', 'plans', 'STORY-001', 'prototype-analysis.md'), '# 聊天改版\nprototype_url: https://modao.cc/x\n')

  const r = runScript(KB_UPDATE, [], sb)
  const dd = (r.designDocs || [])[0]
  ok('designDocs 非空', !!dd, JSON.stringify(r.designDocs))
  ok('原型文档归到匹配文件数最多的 chat 域（修复前硬编码 settings）', dd && dd.targetDomain === 'chat', dd && dd.targetDomain)
  ok('targetPath 在 .docs/llm-knowledge/business/chat/design/ 下', dd && /business\/chat\/design\//.test(dd.targetPath || ''), dd && dd.targetPath)

  fs.rmSync(sb, { recursive: true, force: true })
}

section('2c. kb-update: 无效 lastHash 兜底 HEAD~1')
{
  const sb = mkSandbox('kb-upd3-')
  fs.mkdirSync(path.join(sb, 'src', 'views', 'settings'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S1.vue'), 's')
  git(sb, 'git add -A && git commit -qm init')
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S2.vue'), 's2')
  git(sb, 'git add -A && git commit -qm change')
  const head = git(sb, 'git rev-parse HEAD').trim()

  writeMeta(sb, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', [  // 无效 hash（rebase 后消失等场景）
    { id: 'settings', path: 'business/settings/', files: ['src/views/settings/*.vue'] }
  ])

  const r = runScript(KB_UPDATE, [], sb)
  ok('无效 hash 时兜底取到 HEAD~1 变更（S2.vue）', (r.changedFiles || []).includes('src/views/settings/S2.vue'), JSON.stringify(r.changedFiles))
  ok('currentHash 为 HEAD', r.currentHash === head)

  fs.rmSync(sb, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════
// 3. gen-docs
// ══════════════════════════════════════════════════════════
section('3. gen-docs: 全量/单域/裸文件名 src 兜底（修复回归）')
{
  const sb = mkSandbox('kb-gen-')
  fs.mkdirSync(path.join(sb, 'src', 'views', 'settings'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S1.vue'), 's')
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S2.vue'), 's2')
  fs.writeFileSync(path.join(sb, 'src', 'helper.js'), 'h')  // 裸文件名兜底目标
  git(sb, 'git add -A && git commit -qm init')
  const baseHash = git(sb, 'git rev-parse HEAD').trim()

  fs.mkdirSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'settings'), { recursive: true })
  fs.writeFileSync(path.join(sb, '.docs', 'llm-knowledge', '.profile.yaml'),
    'project_type: "frontend"\nsource_root: "src"\ndomain_axis: "business"\n')
  writeMeta(sb, baseHash, [
    { id: 'settings', path: 'business/settings/', files: ['src/views/settings/*.vue', 'helper.js'] }
  ])

  // 全量：通配符展开 + 裸文件名（helper.js 不带 / 前缀 → 兜底 src/helper.js）
  const all = runScript(GEN_DOCS, ['--all'], sb)
  const dom = ((all.domains || []).find(d => d.id === 'settings')) || {}
  const files = (dom.files && dom.files.all) || []
  ok('全量模式收集到 3 个文件', files.length === 3, JSON.stringify(files))
  ok('通配符展开 S1/S2.vue', files.some(f => f.endsWith('S1.vue')) && files.some(f => f.endsWith('S2.vue')))
  ok('裸文件名 helper.js 兜底到 src/helper.js（修复前未实现）', files.some(f => f.endsWith('src/helper.js')))

  // 单域
  const single = runScript(GEN_DOCS, ['settings'], sb)
  ok('单域模式只含 settings', (single.domains || []).length === 1 && single.domains[0].id === 'settings')
  ok('单域模式 mode=single', single.mode === 'single')

  // stale：baseHash == HEAD → 不 stale
  const stale0 = runScript(GEN_DOCS, ['--stale'], sb)
  ok('stale=false（无新提交）', stale0.stale === false, JSON.stringify(stale0))
  // 提交新变更 → stale（diff 范围内还含 meta.yaml/.profile.yaml 等测试脚手架文件，只断言 >=1）
  fs.writeFileSync(path.join(sb, 'src', 'views', 'settings', 'S3.vue'), 's3')
  git(sb, 'git add -A && git commit -qm change2')
  const stale1 = runScript(GEN_DOCS, ['--stale'], sb)
  ok('stale=true（有新提交）', stale1.stale === true, JSON.stringify(stale1))
  ok('changedCount>=1', (stale1.changedCount || 0) >= 1, String(stale1.changedCount))

  fs.rmSync(sb, { recursive: true, force: true })
}

section('3b. gen-docs: 后端递归 glob 收集 Java 包文件')
{
  const sb = mkSandbox('kb-gen-java-')
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'controller'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'service'), { recursive: true })
  fs.mkdirSync(path.join(sb, 'src', 'main', 'resources', 'mapper', 'order'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'controller', 'OrderController.java'), 'class OrderController {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'java', 'com', 'demo', 'order', 'service', 'OrderService.java'), 'class OrderService {}')
  fs.writeFileSync(path.join(sb, 'src', 'main', 'resources', 'mapper', 'order', 'OrderMapper.xml'), '<mapper></mapper>')
  git(sb, 'git add -A && git commit -qm init')
  const baseHash = git(sb, 'git rev-parse HEAD').trim()

  fs.mkdirSync(path.join(sb, '.docs', 'llm-knowledge', 'business', 'order'), { recursive: true })
  fs.writeFileSync(path.join(sb, '.docs', 'llm-knowledge', '.profile.yaml'),
    'project_type: "backend"\nsource_root: "src/main/java"\ndomain_axis: "service"\nresource_root: "src/main/resources"\n')
  writeMeta(sb, baseHash, [
    { id: 'order', path: 'business/order/', files: ['src/main/java/com/demo/order/**/*.java', 'src/main/resources/mapper/order/*.xml'] }
  ])

  const all = runScript(GEN_DOCS, ['--all'], sb)
  const dom = ((all.domains || []).find(d => d.id === 'order')) || {}
  const files = (dom.files && dom.files.all) || []
  ok('后端 **/*.java 递归收集 Controller/Service', files.some(f => f.endsWith('OrderController.java')) && files.some(f => f.endsWith('OrderService.java')), JSON.stringify(files))
  ok('后端同时收集 Mapper XML', files.some(f => f.endsWith('OrderMapper.xml')), JSON.stringify(files))

  fs.rmSync(sb, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(48)}`)
if (failures.length === 0) {
  console.log(`✅ kb-scripts: ${pass} 个断言全部通过`)
  process.exit(0)
} else {
  console.log(`❌ kb-scripts: ${failures.length}/${pass + failures.length} 个断言失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
