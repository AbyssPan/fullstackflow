#!/usr/bin/env node
/**
 * FullstackFlow 发布前一致性检查。
 *
 * 覆盖 manifest / marketplace / commands / skills / agents / hooks / JSON / JS 语法，
 * 用于捕获工作流运行测试之外的“能跑但装不上、文档命令不可达”问题。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const PLUGIN_ROOT = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..')
const errors = []
const checked = []

function fail(message) {
  errors.push(message)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`无法读取 ${path.relative(REPO_ROOT, file)}: ${error.message}`)
    return ''
  }
}

function readJson(file) {
  const text = readText(file)
  if (!text) return null
  try {
    const value = JSON.parse(text)
    checked.push(path.relative(REPO_ROOT, file))
    return value
  } catch (error) {
    fail(`JSON 无效 ${path.relative(REPO_ROOT, file)}: ${error.message}`)
    return null
  }
}

function walk(dir, predicate, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, predicate, result)
    else if (Reflect.apply(predicate, null, [full])) result.push(full)
  }
  return result
}

function frontmatter(file) {
  const text = readText(file)
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (!match) {
    fail(`缺少 YAML frontmatter: ${path.relative(REPO_ROOT, file)}`)
    return { text, fields: {} }
  }
  const fields = {}
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (item) fields[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { text, fields }
}

function checkManifests() {
  const files = [
    path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json'),
    path.join(PLUGIN_ROOT, '.codebuddy-plugin/plugin.json'),
    path.join(PLUGIN_ROOT, 'plugin.json'),
    path.join(PLUGIN_ROOT, 'package.json')
  ]
  const manifests = files.map(readJson)
  if (manifests.some(item => !item)) return

  const expectedName = manifests[0].name
  const expectedVersion = manifests[0].version
  if (path.basename(PLUGIN_ROOT) !== expectedName) {
    fail(`插件目录名 ${path.basename(PLUGIN_ROOT)} 必须与 manifest name ${expectedName} 一致`)
  }
  files.forEach((file, index) => {
    if (manifests[index].name !== expectedName) {
      fail(`${path.relative(REPO_ROOT, file)} name 与 ${expectedName} 不一致`)
    }
    if (manifests[index].version !== expectedVersion) {
      fail(`${path.relative(REPO_ROOT, file)} version 与 ${expectedVersion} 不一致`)
    }
  })

  const hostFields = ['name', 'displayName', 'version', 'description', 'license', 'homepage', 'repository']
  for (const field of hostFields) {
    if (manifests[0][field] !== manifests[1][field]) {
      fail(`Claude / CodeBuddy manifest 字段不一致: ${field}`)
    }
  }

  return { name: expectedName, version: expectedVersion }
}

function checkMarketplaces(identity) {
  const claudeFile = path.join(REPO_ROOT, '.claude-plugin/marketplace.json')
  const codebuddyFile = path.join(REPO_ROOT, '.codebuddy-plugin/marketplace.json')
  const claude = readJson(claudeFile)
  const codebuddy = readJson(codebuddyFile)
  if (!claude || !codebuddy || !identity) return

  if (JSON.stringify(claude) !== JSON.stringify(codebuddy)) {
    fail('Claude / CodeBuddy marketplace.json 内容不一致')
  }
  if (!claude.description) fail('marketplace 缺少 description')

  const entry = claude.plugins && claude.plugins.find(item => item.name === identity.name)
  if (!entry) {
    fail(`marketplace 未注册插件 ${identity.name}`)
    return
  }
  if (entry.version !== identity.version) fail(`marketplace 插件版本与 ${identity.version} 不一致`)
  if (typeof entry.source !== 'string' || !entry.source.startsWith('./')) {
    fail('marketplace source 必须是 ./ 开头的仓库内相对路径')
  } else if (entry.source !== `./plugins/${identity.name}`) {
    fail(`marketplace source 必须与插件名一致: ./plugins/${identity.name}`)
  } else if (!fs.existsSync(path.resolve(REPO_ROOT, entry.source))) {
    fail(`marketplace source 不存在: ${entry.source}`)
  }
}

function checkCommands(identity) {
  const dir = path.join(PLUGIN_ROOT, 'commands')
  const required = ['run.md', 'fixbugs.md', 'status.md', 'end.md', 'evolve.md', 'archive.md', 'fullstack.md']
  for (const name of required) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      fail(`缺少命令入口 commands/${name}`)
      continue
    }
    const { text, fields } = frontmatter(file)
    if (!fields.description) fail(`commands/${name} 缺少 description`)
    if (!text.includes('$ARGUMENTS')) fail(`commands/${name} 未声明 $ARGUMENTS，用户参数可能丢失`)
  }

  for (const file of [path.join(REPO_ROOT, 'README.md'), path.join(REPO_ROOT, 'INSTALL.md'), ...walk(dir, f => f.endsWith('.md'))]) {
    const text = readText(file)
    if (/\/harness(?:\s|`|$)/m.test(text)) {
      fail(`仍包含已废弃的 /harness 命令: ${path.relative(REPO_ROOT, file)}`)
    }
    if (/\/fullstack(?:\s|`|$)/m.test(text)) {
      fail(`仍包含未命名空间化的 /fullstack 命令: ${path.relative(REPO_ROOT, file)}`)
    }
    for (const match of text.matchAll(/\/([A-Za-z0-9_-]+):[A-Za-z0-9_-]+/g)) {
      if (match[1] !== identity.name) {
        fail(`Slash Command 命名空间应为 /${identity.name}:，实际为 /${match[1]}:（${path.relative(REPO_ROOT, file)}）`)
      }
    }
  }
}

function checkSkillsAndAgents(identity) {
  const skillFiles = walk(path.join(PLUGIN_ROOT, 'skills'), file => path.basename(file) === 'SKILL.md')
  const skillNames = new Set()
  for (const file of skillFiles) {
    const { fields } = frontmatter(file)
    const expected = path.basename(path.dirname(file))
    if (fields.name !== expected) fail(`Skill name 与目录不一致: ${expected} -> ${fields.name || '(空)'}`)
    if (!fields.description) fail(`Skill 缺少 description: ${expected}`)
    if (skillNames.has(fields.name)) fail(`Skill name 重复: ${fields.name}`)
    skillNames.add(fields.name)
  }

  const agentFiles = walk(path.join(PLUGIN_ROOT, 'agents'), file => file.endsWith('.md'))
  const agentNames = new Set()
  for (const file of agentFiles) {
    const { fields } = frontmatter(file)
    if (!fields.name) fail(`Agent 缺少 name: ${path.basename(file)}`)
    if (!fields.description) fail(`Agent 缺少 description: ${path.basename(file)}`)
    if (agentNames.has(fields.name)) fail(`Agent name 重复: ${fields.name}`)
    agentNames.add(fields.name)
  }

  const invocationFiles = [
    ...walk(path.join(PLUGIN_ROOT, 'commands'), file => file.endsWith('.md')),
    ...walk(path.join(PLUGIN_ROOT, 'skills'), file => file.endsWith('.md')),
    ...walk(path.join(PLUGIN_ROOT, 'agents'), file => file.endsWith('.md')),
    ...walk(path.join(PLUGIN_ROOT, 'scripts/services'), file => file.endsWith('.js'))
  ]
  const invocationPattern = /use_skill\("([^"]+)"\)/g
  for (const file of invocationFiles) {
    const text = readText(file)
    let match
    while ((match = invocationPattern.exec(text))) {
      if (match[1].startsWith(`${identity.name}:`)) {
        fail(`插件内 use_skill 调用不应带命名空间: ${match[1]}（${path.relative(REPO_ROOT, file)}）`)
      } else if (match[1].includes(':')) {
        fail(`插件内 use_skill 调用包含未知命名空间: ${match[1]}（${path.relative(REPO_ROOT, file)}）`)
      }
    }
  }

  checked.push(`${skillFiles.length} skills`, `${agentFiles.length} agents`)
}

function checkHooks() {
  const hookFile = path.join(PLUGIN_ROOT, 'hooks/hooks.json')
  const config = readJson(hookFile)
  if (!config || !config.hooks) return
  const commands = []
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type === 'command' && hook.command) commands.push(hook.command)
      }
    }
  }
  for (const command of commands) {
    const match = command.match(/\$\{(?:CLAUDE|CODEBUDDY)_PLUGIN_ROOT\}\/([^\s"']+)/)
    if (!match) {
      fail(`Hook 命令未使用插件根路径变量: ${command}`)
      continue
    }
    if (!fs.existsSync(path.join(PLUGIN_ROOT, match[1]))) fail(`Hook 脚本不存在: ${match[1]}`)
  }
  checked.push(`${commands.length} hook commands`)
}

function checkJsonAndJavaScript() {
  for (const file of walk(PLUGIN_ROOT, item => item.endsWith('.json'))) readJson(file)
  const scripts = walk(PLUGIN_ROOT, item => item.endsWith('.js') || item.endsWith('.cjs'))
  for (const file of scripts) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      fail(`JavaScript 语法错误 ${path.relative(REPO_ROOT, file)}: ${(result.stderr || '').trim()}`)
    }
  }
  checked.push(`${scripts.length} JavaScript files`)
}

const identity = checkManifests()
checkMarketplaces(identity)
checkCommands(identity)
checkSkillsAndAgents(identity)
checkHooks()
checkJsonAndJavaScript()

if (errors.length > 0) {
  console.error(`❌ 插件一致性检查失败（${errors.length} 项）`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(`✅ 插件一致性检查通过（${checked.length} 项文件/分组）`)
console.log(`   ${checked.join(' · ')}`)
