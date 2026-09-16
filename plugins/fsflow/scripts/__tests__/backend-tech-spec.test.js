#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')
let pass = 0
const failures = []

function ok (name, condition) {
  if (condition) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.error(`  FAIL ${name}`)
  }
}

console.log('\n-- 后端规范优先级与 Agent 集成 --')

const spec = read('skills/backend-tech-spec/SKILL.md')
const analyst = read('agents/需求分析师.md')
const developer = read('agents/全栈开发工程师.md')
const reviewer = read('agents/代码审查师.md')

ok('Skill 注册名正确', /name:\s*backend-tech-spec/.test(spec))
ok('项目知识库位于内置审查规则之前',
  spec.indexOf('当前项目知识库') < spec.indexOf('OpenCodeReview 抽取规则'))
ok('内置审查规则位于 Skill 默认规范之前',
  spec.indexOf('OpenCodeReview 抽取规则') < spec.indexOf('本 skill 的默认规范'))
ok('只有需求分析 Agent 执行知识库初始化确认',
  /唯一的知识库初始化确认点/.test(analyst) && /use_skill\("kb-init"\)/.test(analyst) &&
  /use_skill\("gen-project-docs"\)/.test(analyst) && /phase-outcome <storyId> 0 skipped_by_user/.test(analyst) &&
  !/知识库前置确认/.test(developer) && !/use_skill\("kb-init"\)/.test(developer))
ok('开发 Agent 调用 backend-tech-spec', /use_skill\("backend-tech-spec"\)/.test(developer))
ok('开发 Agent 预读 OpenCodeReview 规则', /预读内置 OpenCodeReview 规则/.test(developer))
ok('审查 Agent 调用 backend-tech-spec', /use_skill\("backend-tech-spec"\)/.test(reviewer))
ok('审查 Agent 明确审查规则优先于开发默认规范',
  /优先级固定为：[\s\S]*内置 OpenCodeReview 抽取规则[\s\S]*backend-tech-spec` 默认规范/.test(reviewer))
ok('已移除 ServiceImpl 禁止调用 Mapper 的错误规则', !/ServiceImpl 仅调 Service 不跨层直调 Mapper/.test(reviewer))
ok('事实与规范冲突策略已区分',
  /实现事实冲突以源码为准/.test(developer) && /编码规范冲突以知识库为准/.test(developer))

console.log(`\n${'='.repeat(48)}`)
if (failures.length === 0) {
  console.log(`通过 ${pass} / ${pass}   [全绿]`)
  process.exit(0)
}

console.log(`通过 ${pass} / ${pass + failures.length}\n失败项:\n  - ${failures.join('\n  - ')}`)
process.exit(1)
