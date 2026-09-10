#!/usr/bin/env node
/**
 * 历史教训注入回归测试 — getLessonsForPhase 的注入侧归并（v3.1，2026-09）
 *
 * 背景: 写入侧的去重键含 rootCause 前 50 字符，对「不同根因」是对的，但模板化根因
 * （消息里嵌绝对路径，如 dev_pass_scope_violation 的「试图编辑限域外的文件: <path>」）
 * 每换一个文件就新开一条 pattern，对策却完全相同。这类条目 occurrences 极高，
 * 恒排 Top N 之首，会把真正不同的教训挤出注入窗口（maxItems=5）。
 * v3.1 只在注入侧按 failureType + resolution 归并，库里仍按根因分条留档。
 *
 * 期望值全部由 experience/failure-patterns.json 现算，不写死任何条数/次数 ——
 * 经验库会随失败自动增长，写死会让这个文件很快变成假红。
 *
 * 注意: EXPERIENCE_DIR 由 __dirname 推导（scripts/experience），不受环境变量影响，
 * 因此本测试无沙箱、直接读共享经验库；断言只针对「结构性质」而非具体数据。
 *
 * 用法:
 *   node scripts/__tests__/experience-lessons.test.js
 *   npm test            （在 plugins/fsflow 下）
 */

const path = require('path')

const SCRIPTS_DIR = path.resolve(__dirname, '..')
const experience = require(path.join(SCRIPTS_DIR, 'services/experience'))
const raw = require(path.join(SCRIPTS_DIR, 'experience/failure-patterns.json'))

const MAX_ITEMS = 5 // 与 getLessonsForPhase 默认值一致

let pass = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

/**
 * 归并键 —— 与 getLessonsForPhase 的 `failureType + resolution` 等价。
 * 只取 resolution 首行: 注入文本里「对策: xxx」是单行渲染，多行对策无法从文本还原，
 * 因此下面 section 0 先断言库内不存在多行 resolution，保证首行键与全文键等价。
 */
const groupKey = (failureType, resolution) => `${failureType}|${String(resolution || '').split('\n')[0].trim()}`

/** 从库里现算某 phase 归并后应有的组（key -> {occurrences, variants}） */
function expectedGroups (phase) {
  const groups = new Map()
  for (const p of raw.patterns) {
    if (p.phase !== phase) continue
    if (p.needsManualReview && p.reviewStatus !== 'confirmed') continue
    const key = groupKey(p.failureType, p.resolution)
    const hit = groups.get(key)
    if (hit) {
      hit.occurrences += (p.occurrences || 1)
      hit.variants += 1
    } else {
      groups.set(key, { occurrences: p.occurrences || 1, variants: 1 })
    }
  }
  return groups
}

/** 解析注入文本里的教训条目 */
function parseInjected (text) {
  const re = /⚠️ 历史教训 \((\d+)次\): (.+)\n\s+根因: ([\s\S]*?)\n\s+对策: (.+)/g
  const items = []
  let m
  while ((m = re.exec(text)) !== null) {
    items.push({
      occurrences: Number(m[1]),
      failureType: m[2].trim(),
      rootCause: m[3],
      resolution: m[4].trim(),
      key: groupKey(m[2].trim(), m[4])
    })
  }
  return items
}

// ════════════════════════════════════════════════════════════
section('0. 前置假设：resolution 均为单行（否则首行键与全文键不等价）')

const multiline = raw.patterns.filter(p => /\n/.test(String(p.resolution || '')))
ok('库内无多行 resolution', multiline.length === 0,
  multiline.map(p => `${p.phase}:${p.failureType}`).join(' / '))

// ════════════════════════════════════════════════════════════
section('1. 逐 Phase：注入条数 = 归并后组数（上限 maxItems）')

const perPhase = []
for (let phase = 0; phase <= 7; phase++) {
  const groups = expectedGroups(phase)
  const items = parseInjected(experience.getLessonsForPhase(phase))
  perPhase.push({ phase, groups, items })
  ok(`phase ${phase} 条数 = min(组数 ${groups.size}, ${MAX_ITEMS})`,
    items.length === Math.min(groups.size, MAX_ITEMS),
    `实际 ${items.length}`)
}

// ════════════════════════════════════════════════════════════
section('2. 同一 failureType + 对策不重复占位')

for (const { phase, items } of perPhase) {
  const keys = items.map(i => i.key)
  ok(`phase ${phase} 无重复条目`, new Set(keys).size === keys.length, keys.join(' / '))
}

// ════════════════════════════════════════════════════════════
section('3. 归并组的 occurrences 累加、并标注同类根因数')

let mergedSeen = 0
for (const { phase, groups, items } of perPhase) {
  for (const item of items) {
    const g = groups.get(item.key)
    ok(`phase ${phase} ${item.failureType} 命中库内组`, !!g, item.key)
    if (!g) continue
    ok(`phase ${phase} ${item.failureType} 次数为组内累加(${g.occurrences})`,
      item.occurrences === g.occurrences, String(item.occurrences))
    const marked = /另有 \d+ 个同类根因/.test(item.rootCause)
    ok(`phase ${phase} ${item.failureType} 同类根因标注与 variants=${g.variants} 一致`,
      marked === (g.variants > 1), `marked=${marked}`)
    if (g.variants > 1) mergedSeen++
  }
}

// ════════════════════════════════════════════════════════════
section('4. 归并确实发生过（否则本测试等于空跑，需回看经验库）')

const mergedGroups = perPhase.reduce((n, p) => n + [...p.groups.values()].filter(v => v.variants > 1).length, 0)
ok('库内存在多根因同对策的组', mergedGroups > 0, `组数 ${mergedGroups}`)
// 注入是 Top-N 截断的，被截掉的组不会出现在文本里，故只断言「至少观测到一次归并」
ok('至少有一组在注入文本里被归并为单条', mergedSeen > 0, `mergedSeen=${mergedSeen} / 库内 ${mergedGroups}`)
ok('观测到的归并数不超过库内组数', mergedSeen <= mergedGroups, `${mergedSeen} > ${mergedGroups}`)

// ════════════════════════════════════════════════════════════
section('5. 已淘汰的教训不再注入')

// agent_prompt_missing_context 描述的是「主 Agent 自行拼 prompt 时漏注入上下文」，
// 其对策还要求读 advance-phase.js 输出的 phaseSummaryContent/contractFilesToLoad。
// prompt-builder 成为单一信源、这些字段被删后，该模式既不可能复现、指路也已失效。
const allInjected = Array.from({ length: 8 }, (_, p) => experience.getLessonsForPhase(p)).join('\n')
ok('不再注入 agent_prompt_missing_context', !/agent_prompt_missing_context/.test(allInjected))
ok('不再出现已删除的输出字段名',
  !/phaseSummaryContent|promptInjectionTemplate/.test(allInjected))

// ════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(48)}`)
if (failures.length === 0) {
  console.log(`✅ ${pass} 项断言全部通过`)
  process.exit(0)
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
