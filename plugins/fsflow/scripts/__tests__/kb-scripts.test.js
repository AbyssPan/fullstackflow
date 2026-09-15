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

section('1e. backend index: package ownership, common code, resources and refresh')
{
  const sb = mkSandbox('kb-backend-index-')
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(sb, file)), { recursive: true })
    fs.writeFileSync(path.join(sb, file), content)
  }
  const java = 'src/main/java/com/example/app/'
  put('pom.xml', '<project/>')
  put(java + 'Application.java', 'package com.example.app;\n@SpringBootApplication\nclass Application {}')
  put(java + 'chat/controller/MessageController.java', 'package com.example.app.chat.controller;\nimport com.example.app.common.Clock;\n@GetMapping("/messages")\nclass MessageController {}')
  put(java + 'chat/mapper/MessageMapper.java', 'package com.example.app.chat.mapper;\ninterface MessageMapper {}')
  put(java + 'document/service/ParserService.java', 'package com.example.app.document.service;\nimport com.example.app.common.Clock;\nclass ParserService {}')
  put(java + 'common/Clock.java', 'package com.example.app.common;\nclass Clock {}')
  put(java + 'http/HttpClient.java', 'package com.example.app.http;\nclass HttpClient {}')
  put(java + 'Mystery.java', 'package com.example.app;\nclass Mystery {}')
  put('src/main/kotlin/com/example/app/chat/model/Reply.kt', 'package com.example.app.chat.model\ndata class Reply(val text: String)')
  put('src/main/resources/mappers/MessageMapper.xml', '<mapper namespace="com.example.app.chat.mapper.MessageMapper"/>')
  put('src/main/resources/notchat/settings.xml', '<settings/>')
  put('src/main/resources/application.yml', 'server:\n  port: 8080')
  git(sb, 'git add -A && git commit -qm baseline')
  const baseline = git(sb, 'git rev-parse HEAD').trim()

  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('business package wins over Message/Parser class prefixes', JSON.stringify(dry.domains) === '["chat","document"]', JSON.stringify(dry.domains))
  ok('dry-run with backend facts remains read-only', !fs.existsSync(path.join(sb, '.docs/llm-knowledge/backend-index.json')))
  const summary = runScript(KB_INIT, ['--dry-run', '--summary'], sb)
  ok('summary 输出计数而非整份后端索引', summary.backendIndex?.file_count === dry.backendIndex.files.length && !summary.backendIndex.files)
  ok('summary 预览保持只读', !fs.existsSync(path.join(sb, '.docs/llm-knowledge/backend-index.json')))
  ok('Java and Kotlin source roots both indexed', dry.backendIndex?.source_roots.length === 2)
  ok('common and technical classes do not become business domains', dry.backendIndex?.common_files.includes(java + 'http/HttpClient.java') && dry.backendIndex.common_files.includes(java + 'common/Clock.java'))
  ok('uncertain classes and substring-only resources stay unclassified', dry.backendIndex?.unclassified_files.includes(java + 'Mystery.java') && dry.backendIndex.unclassified_files.includes('src/main/resources/notchat/settings.xml'))
  ok('mapper namespace links XML despite unrelated resource directory', dry.domainFileHints?.chat.resource_files.includes('src/main/resources/mappers/MessageMapper.xml'))
  const entry = dry.backendIndex?.files.find(f => f.path.endsWith('MessageController.java'))
  ok('entry annotations retain line and lexical status', entry?.entries[0]?.line === 3 && entry.entries[0].status === 'lexical_hint' && entry.entries[0].declaration.includes('/messages'))

  runScript(KB_INIT, [], sb)
  ok('backend init creates navigation and structure explanation', ['backend-index.json', 'STRUCTURE.md', 'overview.md', 'meta.yaml'].every(f => fs.existsSync(path.join(sb, '.docs/llm-knowledge', f))))
  ok('initial skeleton is not reported as synchronized documentation', runScript(GEN_DOCS, ['--stale'], sb).stale === true)
  writeMeta(sb, baseline, [{ id: 'obsolete', path: 'business/obsolete/', files: ['old.java'] }])
  put('.docs/llm-knowledge/business/chat/custom/README.md', 'handwritten rules')
  put('.docs/llm-knowledge/common/conventions.md', '<!-- CUSTOM:START -->team rules<!-- CUSTOM:END -->')
  put('.docs/llm-knowledge/common/README.md', 'team knowledge index')
  const metaBefore = fs.readFileSync(path.join(sb, '.docs/llm-knowledge/meta.yaml'), 'utf8')
  runScript(KB_INIT, ['--force'], sb)
  ok('backend force retains handwritten content and existing meta', fs.readFileSync(path.join(sb, '.docs/llm-knowledge/business/chat/custom/README.md'), 'utf8') === 'handwritten rules' && fs.readFileSync(path.join(sb, '.docs/llm-knowledge/meta.yaml'), 'utf8') === metaBefore)
  ok('backend force preserves common conventions and index', fs.readFileSync(path.join(sb, '.docs/llm-knowledge/common/conventions.md'), 'utf8').includes('team rules') && fs.readFileSync(path.join(sb, '.docs/llm-knowledge/common/README.md'), 'utf8') === 'team knowledge index')

  put(java + 'common/Clock.java', 'package com.example.app.common;\nclass Clock { int version = 2; }')
  put(java + 'chat/service/NewService.java', 'package com.example.app.chat.service;\nclass NewService {}')
  fs.renameSync(path.join(sb, java + 'document/service/ParserService.java'), path.join(sb, java + 'document/service/ReaderService.java'))
  ok('backend stale check includes uncommitted source changes', runScript(GEN_DOCS, ['--stale'], sb).stale === true)
  const update = runScript(KB_UPDATE, [], sb)
  ok('shared changes affect import-dependent domains', update.affectedDomains?.some(d => d.id === 'chat') && update.affectedDomains.some(d => d.id === 'document'), JSON.stringify(update))
  ok('uncommitted additions/deletions detected from index hashes', update.changedFiles?.includes(java + 'chat/service/NewService.java') && update.changedFiles.includes(java + 'document/service/ParserService.java') && update.changedFiles.includes(java + 'document/service/ReaderService.java'))
  ok('common update surfaced separately', update.backend?.commonFiles.includes(java + 'common/Clock.java'))
  ok('index refresh does not make unsynchronized documents fresh', runScript(GEN_DOCS, ['--stale'], sb).stale === true)
  const repeated = runScript(KB_UPDATE, [], sb)
  ok('repeated update retains pending worktree changes', repeated.changedFiles?.includes(java + 'common/Clock.java') && repeated.changedFiles.includes(java + 'chat/service/NewService.java'))
  const gen = runScript(GEN_DOCS, ['--all'], sb)
  ok('generation follows refreshed index rather than stale meta file list', gen.domains?.some(d => d.id === 'chat' && d.files.all.some(f => f.endsWith('NewService.java'))) && !gen.domains.some(d => d.id === 'obsolete'))
  ok('generation exposes unclassified and source evidence', gen.unclassifiedFiles?.includes(java + 'Mystery.java') && gen.domains[0].evidence[0].sha256.length === 64)
  git(sb, 'git add -A && git commit -qm synchronized')
  const synchronized = git(sb, 'git rev-parse HEAD').trim()
  writeMeta(sb, synchronized, gen.domains.map(d => ({ id: d.id, path: d.path, files: d.files.all.map(f => path.relative(fs.realpathSync(sb), f).replace(/\\/g, '/')) })))
  runScript(KB_INIT, ['--index-only'], sb)
  ok('synchronized backend does not replay the previous commit', runScript(KB_UPDATE, [], sb).affectedDomains?.length === 0)
  const removed = java + 'chat/service/NewService.java'
  fs.unlinkSync(path.join(sb, removed))
  runScript(KB_UPDATE, [], sb)
  const retryDelete = runScript(KB_UPDATE, [], sb)
  ok('deleted file remains mapped through document metadata on retry', retryDelete.affectedDomains?.some(d => d.id === 'chat' && d.matchedFiles.includes(removed)), JSON.stringify(retryDelete))
  fs.rmSync(sb, { recursive: true, force: true })
}

section('1f. backend index: explicit boundaries and module collisions')
{
  const sb = mkSandbox('kb-backend-modules-')
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(sb, file)), { recursive: true })
    fs.writeFileSync(path.join(sb, file), content)
  }
  put('pom.xml', '<project><modules><module>crm</module><module>billing</module></modules></project>')
  for (const mod of ['crm', 'billing']) {
    put(`${mod}/pom.xml`, '<project/>')
    put(`${mod}/src/main/java/com/example/app/Application.java`, 'package com.example.app;\n@SpringBootApplication class Application {}')
    put(`${mod}/src/main/java/com/example/app/user/controller/UserController.java`, 'package com.example.app.user.controller;\nclass UserController {}')
  }
  const dry = runScript(KB_INIT, ['--dry-run'], sb)
  ok('same domain in separate modules does not silently merge', JSON.stringify(dry.domains) === '["billing-user","crm-user"]', JSON.stringify(dry.domains))
  put('src/main/java/com/example/root/Application.java', 'package com.example.root;\n@SpringBootApplication class Application {}')
  put('src/main/java/com/example/root/audit/AuditService.java', 'package com.example.root.audit;\nclass AuditService {}')
  put('src/main/resources/application.yml', 'server:\n  port: 8080')
  put('crm/src/main/resources/application.yml', 'server:\n  port: 8081')
  const withRoot = runScript(KB_INIT, ['--dry-run'], sb)
  ok('reactor root source and resources are retained alongside modules', withRoot.backendIndex?.source_roots.includes('src/main/java') && withRoot.backendIndex.resource_roots.includes('src/main/resources') && withRoot.domains.includes('audit'))
  put('.docs/llm-knowledge/backend.config.json', JSON.stringify({ auto_discover: false, domains: [{ id: 'account', include: ['crm/**/user/**/*.java', 'billing/**/user/**/*.java'] }], common: ['**/Application.java'] }))
  const configured = runScript(KB_INIT, ['--dry-run'], sb)
  ok('explicit rule merges a business across physical modules', JSON.stringify(configured.domains) === '["account"]' && configured.domainFileHints.account.total_files === 2)
  put('.docs/llm-knowledge/backend.config.json', JSON.stringify({ domains: [{ id: 'one', include: ['**/*.java'] }, { id: 'two', include: ['crm/**/*.java'] }] }))
  ok('overlapping ownership rules fail instead of guessing', Boolean(runScript(KB_INIT, ['--dry-run'], sb).__error))
  put('.docs/llm-knowledge/backend.config.json', JSON.stringify({ domains: [{ id: '../escape', include: ['**/*.java'] }] }))
  ok('invalid domain IDs rejected before directory creation', Boolean(runScript(KB_INIT, [], sb).__error) && !fs.existsSync(path.join(sb, '.docs/llm-knowledge/backend-index.json')))
  put('.docs/llm-knowledge/backend.config.json', JSON.stringify({ domains: [{ include: ['**/*.java'] }] }))
  ok('missing domain ID cannot become an undefined domain', Boolean(runScript(KB_INIT, ['--dry-run'], sb).__error))
  put('.docs/llm-knowledge/backend.config.json', '[]')
  ok('configuration must be a JSON object', Boolean(runScript(KB_INIT, ['--dry-run'], sb).__error))
  fs.rmSync(sb, { recursive: true, force: true })
}

section('1g. frontend and non-JVM backend retain existing initialization')
{
  const sb = mkSandbox('kb-frontend-unchanged-')
  fs.mkdirSync(path.join(sb, 'src/views/account'), { recursive: true })
  fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ dependencies: { vue: '3' } }))
  const init = runScript(KB_INIT, [], sb)
  ok('frontend keeps page-domain and template behavior', init.projectType === 'frontend' && JSON.stringify(init.domains) === '["account"]' && init.templates.includes('pages') && !init.templates.includes('flows'))
  ok('frontend creates no backend index or backend structure files', !fs.existsSync(path.join(sb, '.docs/llm-knowledge/backend-index.json')) && !fs.existsSync(path.join(sb, '.docs/llm-knowledge/STRUCTURE.md')))
  fs.mkdirSync(path.join(sb, 'server/service/order'), { recursive: true })
  const backend = runScript(KB_INIT, ['--project-type', 'backend', '--dry-run'], sb)
  ok('non-JVM backend retains service directory fallback', backend.domains?.includes('order') && !backend.backendIndex)
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

section('2a. kb-update: 成功的空 diff 不重放上次提交')
{
  const sb = mkSandbox('kb-upd-empty-')
  const source = path.join(sb, 'src', 'settings.js')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'v1')
  git(sb, 'git add -A && git commit -qm init')
  const baseHash = git(sb, 'git rev-parse HEAD').trim()
  fs.writeFileSync(source, 'v2')
  git(sb, 'git add -A && git commit -qm change')
  const domains = [{ id: 'settings', path: 'business/settings/', files: ['src/settings.js'] }]
  writeMeta(sb, git(sb, 'git rev-parse HEAD').trim(), domains)

  const synced = runScript(KB_UPDATE, [], sb)
  ok('已同步 HEAD 时不返回旧变更或受影响域', synced.changedFiles?.length === 0 && synced.affectedDomains?.length === 0,
    JSON.stringify(synced))
  ok('已同步 HEAD 时无错误', synced.errors?.length === 0)

  // 两个不同提交具有相同源码树：净变更为空也不能回退到最后一次提交。
  fs.writeFileSync(source, 'v1')
  git(sb, 'git add src/settings.js && git commit -qm revert')
  writeMeta(sb, baseHash, domains)
  const reverted = runScript(KB_UPDATE, [], sb)
  ok('不同 hash 的空 diff 不返回旧变更', reverted.lastHash !== reverted.currentHash &&
    reverted.changedFiles?.length === 0 && reverted.affectedDomains?.length === 0, JSON.stringify(reverted))
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

  const r = runScript(KB_UPDATE, ['--story', 'STORY-001'], sb)
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
