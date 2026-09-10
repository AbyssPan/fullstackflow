#!/usr/bin/env node
/**
 * 测试入口 — 自动发现并串行跑 __tests__ 下所有 *.test.js
 *
 * 串行而非并行: 每个测试用例都会设置 CLAUDE_PROJECT_DIR 沙箱，
 * 并行会互相覆盖环境变量。
 *
 * 用法: npm test  （在 plugins/fsflow 下）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const TESTS_DIR = __dirname
const files = fs.readdirSync(TESTS_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort()

if (files.length === 0) {
  console.error('未发现任何 *.test.js')
  process.exit(1)
}

const failed = []

for (const f of files) {
  console.log(`\n${'═'.repeat(48)}\n▶ ${f}\n${'═'.repeat(48)}`)
  const r = spawnSync(process.execPath, [path.join(TESTS_DIR, f)], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(f)
}

console.log(`\n${'═'.repeat(48)}`)
if (failed.length === 0) {
  console.log(`✅ ${files.length} 个测试文件全部通过`)
  process.exit(0)
} else {
  console.log(`❌ ${failed.length}/${files.length} 个测试文件失败:\n  - ${failed.join('\n  - ')}`)
  process.exit(1)
}
