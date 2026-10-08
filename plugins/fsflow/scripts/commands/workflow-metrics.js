#!/usr/bin/env node
const { collectMetrics, formatMetrics, saveMetrics } = require('../services/workflow-metrics')
const { readStateFile } = require('../lib/state')
const id = process.argv[2]
if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !readStateFile(id)) {
  console.error('用法: node workflow-metrics.js <storyId> [--json]；Story 必须存在')
  process.exit(1)
}
const report = (process.argv.includes('--write') ? saveMetrics(id)?.report : null) || collectMetrics(id)
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatMetrics(report))
