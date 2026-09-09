#!/usr/bin/env node
/**
 * harness-audit.js — Harness 工作流健康体检与自修复
 *
 * 职责:
 *   - 核心脚本语法体检: 对 scripts/{lib,services,audit,commands} 全量 .js/.cjs 跑 node --check
 *   - 悬空引用扫描: 抓「调用但未定义 / 未导入」的裸函数引用（运行时 ReferenceError 元凶），报 WARNING
 *   - 工作流状态审计: .harness-active 与 e2e-state.json 一致性、活跃工作流数、dev-pass 有效性与限域精度
 *   - 契约与产出物审计: 未完成 Story 的 acceptance-criteria / open-questions / task-dag /
 *     acceptance-verification 校验，以及已越过 Phase 的产出物缺失
 *   - 声明-消费一致性: story-input.json 声明了 Figma 链接但 Phase 1 未产出有效 frame 清单 → 告警
 *
 * 用法:
 *   独立执行:
 *     node plugins/fullstackflow/scripts/audit/harness-audit.js           # 人类可读报告
 *     node plugins/fullstackflow/scripts/audit/harness-audit.js --json    # 只输出 JSON，供 AI / 脚本解析
 *     node plugins/fullstackflow/scripts/audit/harness-audit.js --fix     # 自动修复（当前仅清理过期 dev-pass）
 *     flag 可组合，如 --json --fix
 *
 * 输出:
 *   - --json: { summary, issues, warnings, fixed }，其中 issues 为 BLOCKER、warnings 为 WARNING
 *   - 默认: 先打印 Harness 激活状态 / 活跃工作流数 / dev-pass 状态，
 *     再分段列出 BLOCKERS / WARNINGS / FIXED 及计数
 *   - 退出码: 存在 BLOCKER 时为 1，其余为 0
 *
 * 使用场景:
 *   - 人工诊断: /harness-evolve 的 Step 0 体检；或流程卡住时手动跑一遍，
 *     先分清是「脚本坏了」还是「状态/产出物缺失」再决定修哪边
 *   - 改脚本后的自检: 修改 scripts/ 下任一脚本后立刻跑，确认无语法错误与悬空引用再提交
 *   - 工作流卡死排查: 用 --json 拿到结构化结果，按 cat 字段定位 BLOCKER 类别
 *     （core-scripts / state / contract / artifact / decl-consume / dev-pass）
 *
 * 说明:
 *   - 语法体检覆盖 scripts/{lib,services,audit,commands}；悬空引用扫描额外覆盖 hooks/
 *   - 悬空引用为启发式检测: 先剥离字符串、注释与正则字面量，再扫描裸标识符调用点，
 *     只报高置信命中，仍可能误报，故一律降为 WARNING 而非 BLOCKER
 *   - --fix 目前只清理过期的 dev-pass.json，不会改动 e2e-state.json 或任何契约文件
 *   - 有 BLOCKER 时 exit 1，可直接用作提交前门禁或 CI 检查
 *
 * @module harness-audit
 */
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const { PLANS_DIR, listStoryDirs, readStateFile, findActiveWorkflows, checkPhaseArtifact, checkAcceptanceCriteria, checkOpenQuestions, checkTaskDagJson, validateContractReferences, checkAcceptanceVerification, checkDevPass, detectFigmaSource, checkFigmaFrameInventory } = require("../lib/state")
const args = process.argv.slice(2)
const fixMode = args.includes("--fix")
const jsonOnly = args.includes("--json")
const issues = [], warnings = [], fixed = []
const summary = {}

/**
 * 核心脚本语法体检 — 覆盖 scripts/{lib,services,audit,commands} 全量 .js/.cjs
 *
 * 历史教训: 原 audit 只对 hooks/ 做 `node --check`，而真正的核心逻辑在
 * services/（context-refresh、prompt-builder、experience）与 lib/（state、trace）。
 * 上次跌倒的 ReferenceError 正发生在 services/context-refresh.js —— hooks 全绿，
 * 但核心脚本在运行时崩溃，体检完全没拦住。
 *
 * @returns {void}
 */
function auditCoreScripts() {
  // audit 的 __dirname 是 scripts/audit/，所以 scripts 根在 ..
  const scriptsRoot = path.join(__dirname, "..")
  const subdirs = ["lib", "services", "audit", "commands"]
  for (const sub of subdirs) {
    const dir = path.join(scriptsRoot, sub)
    if (!fs.existsSync(dir)) continue
    let files = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".js") || f.endsWith(".cjs")) } catch (e) { continue }
    for (const f of files) {
      try { execSync("node --check \"" + path.join(dir, f) + "\"", { timeout: 8000, stdio: "pipe" }) }
      catch (e) { issues.push({ cat: "core-scripts", severity: "BLOCKER", msg: sub + "/" + f + " 语法错误: " + ((e.stderr||"")+"").substring(0,200) }) }
    }
  }
}

/**
 * 引用完整性检查 — 抓「调用但未定义/未导出」的悬空引用（ReferenceError 元凶）
 *
 * 语法检查 (`node --check`) 抓不住这类错误：函数被调用但从未定义或未从模块导出，
 * 这在语法上是合法的，运行时才抛 ReferenceError。上次跌倒的 getRuntimeEvidence
 * 就是典型 —— context-refresh.js 调用了它，但函数体和导出都没写。
 *
 * 实现思路（保守、只报高置信命中，避免误报）：
 * 1. 先剥离字符串 + 注释，避免把模板字符串里的 `use_skill(...)` 等误判
 * 2. 收集「本文件内 function 声明 + const 箭头函数」的名字集合
 * 3. 收集 require 解构导入 + 从模块变量二次解构导入的名字集合
 * 4. 收集剥离后源码里所有「裸标识符(」调用点
 * 5. 调用点名字若不在 [本文件定义 ∪ 导入 ∪ JS内建 ∪ Node内建] 中 → 判为悬空引用
 *
 * @returns {void}
 */
function auditDanglingReferences() {
  const scriptsRoot = path.join(__dirname, "..")
  const subdirs = ["lib", "services", "audit", "commands", "hooks"]
  // JS / Node 常用内建与关键字，避免把 console/require/if/for 等误判为悬空
  const builtins = new Set([
    // JS 关键字 + 语句（会以 name( 形式出现，必须排除）
    "if","for","while","switch","catch","function","return","typeof","new","delete","void","in","of","instanceof",
    // JS 全局
    "require","module","exports","console","process","Buffer","JSON","Math","Date","String","Number","Boolean","Array","Object","Promise","Set","Map","RegExp","Error","TypeError","parseInt","parseFloat","isNaN","isFinite","encodeURIComponent","decodeURIComponent","setTimeout","setInterval","clearTimeout","clearInterval","Symbol","Reflect","Proxy","structuredClone",
    // Node 全局
    "__dirname","__filename","globalThis","global"
  ])

  for (const sub of subdirs) {
    const dir = path.join(scriptsRoot, sub)
    if (!fs.existsSync(dir)) continue
    let files = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".js") || f.endsWith(".cjs")) } catch (e) { continue }
    for (const f of files) {
      const fp = path.join(dir, f)
      let src = ""
      try { src = fs.readFileSync(fp, "utf-8") } catch (e) { continue }

      // 0. 剥离字符串 + 注释，得到「纯代码」，避免模板字符串/注释里的文本被误判
      //    用等长空格替换被剥离区间，保留原始索引供后续定位（此处不需要索引，仅需正确剔除）
      const code = stripStringsAndComments(src)

      // 1. 本文件定义的函数名（对纯代码扫描）
      const defined = new Set()
      let m
      const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
      while ((m = fnRe.exec(code))) defined.add(m[1])
      const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
      while ((m = arrowRe.exec(code))) defined.add(m[1])
      const assignFnRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/g
      while ((m = assignFnRe.exec(code))) defined.add(m[1])

      // 2. require 导入的名字（直接解构 + 整体赋值 + 从模块变量二次解构）
      const imported = new Set()
      // const { a, b: c } = require(...)
      const reqRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(/g
      while ((m = reqRe.exec(code))) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(":")[0].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name)
        }
      }
      // const x = require(...)
      const reqWholeRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(/g
      while ((m = reqWholeRe.exec(code))) imported.add(m[1])
      // const { a, b } = someModule  (从已导入的模块变量二次解构)
      const destructureRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/g
      while ((m = destructureRe.exec(code))) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(":")[0].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name)
        }
      }

      // 3. 调用点（对纯代码扫描）
      const callRe = /([A-Za-z_$][\w$]*)\s*\(/g
      const dangling = []
      while ((m = callRe.exec(code))) {
        const name = m[1]
        if (builtins.has(name)) continue
        if (defined.has(name)) continue
        if (imported.has(name)) continue
        // 排除方法调用 a.b() 的 b —— 只报裸函数名调用（前面是 . 或标识符或 ]）
        const before = code.slice(0, m.index)
        if (/[\w$.\]]\s*$/.test(before)) continue
        if (!dangling.includes(name)) dangling.push(name)
      }

      if (dangling.length > 0) {
        for (const name of dangling.slice(0, 10)) {
          warnings.push({ cat: "dangling-ref", severity: "WARNING", msg: sub + "/" + f + " 疑似悬空引用: " + name + "() 未在本文件定义或导入（运行时可能抛 ReferenceError）" })
        }
      }
    }
  }
}

/**
 * 剥离源码中的字符串与注释，返回等长替换后的纯代码串
 * （用空格替换剥离区间，保留行结构；不保留原始索引，仅供标识符/调用点扫描）
 *
 * 处理顺序：
 * 1. 块注释 /* ... *​/ 与行注释 // ... （先处理，避免字符串里的 // 被误剥离）
 * 2. 单引号/双引号/反引号字符串（含模板字符串，剥离其内部 ${...} 也一并剔除，避免误报）
 *
 * @param {string} src - 原始源码
 * @returns {string} 剥离后的等长字符串
 */
function stripStringsAndComments(src) {
  const len = src.length
  const out = new Array(len).fill(' ')
  const chars = src.split('')

  // 判断当前位置的 '/' 是否为正则字面量开头（而非除法/注释）
  // 启发式: 看 '/' 前最近的非空白字符，若其属于「值位置」字符（= ( , : [ ! & | ? { ; 或行首），
  // 则 '/.../' 是正则；否则是除法或注释。
  // 注意: 刻意排除 '>' ')' '}' '+' '-' '*' '%' '~' '^' 等字符 —— 它们在除法、箭头函数、
  // 比较运算等场景下极常见，纳入会大量误判。正则字面量的判定宁可漏判（把正则当除法），
  // 也不能误判（把除法/箭头当正则），因为误判会导致后续字符串扫描错位。
  const isRegexStart = (idx) => {
    let j = idx - 1
    // 关键: 必须基于剥离后的 out（而非原始 chars）判断前一个字符。
    // 否则注释/字符串里的内容（如行注释里的 "state.json"）会被误认为
    // 前一个代码字符，导致紧跟其后的正则字面量无法被识别。
    while (j >= 0 && /\s/.test(out[j])) j--
    if (j < 0) return true // 行首
    const c = out[j]
    return '=(,:[!&|?{;'.indexOf(c) >= 0
  }

  let i = 0
  // shebang 行（#!/usr/bin/env node）整行剥离，避免其中 '/' 被正则字面量判断误判
  if (chars[0] === '#' && chars[1] === '!') {
    while (i < len && chars[i] !== '\n') { i++ }
  }
  while (i < len) {
    // 正则字面量 /.../flags（先于注释/除法判断，因为正则内可能含 // 与引号）
    if (chars[i] === '/' && isRegexStart(i) && chars[i + 1] !== '/' && chars[i + 1] !== '*' && chars[i + 1] !== '\n') {
      i++ // 跳过起始 /
      while (i < len) {
        if (chars[i] === '\\') { i += 2; continue }
        if (chars[i] === '/') { i++; break }
        if (chars[i] === '\n') break // 正则不能跨行，安全兜底
        i++
      }
      continue
    }
    // 行注释
    if (chars[i] === '/' && chars[i + 1] === '/') {
      while (i < len && chars[i] !== '\n') { i++ }
      continue
    }
    // 块注释
    if (chars[i] === '/' && chars[i + 1] === '*') {
      i += 2
      while (i < len && !(chars[i] === '*' && chars[i + 1] === '/')) { i++ }
      i += 2
      continue
    }
    // 单引号 / 双引号字符串（无插值，简单处理）
    if (chars[i] === '"' || chars[i] === "'") {
      const quote = chars[i]
      i++ // 跳过起始引号
      while (i < len) {
        if (chars[i] === '\\') { i += 2; continue } // 跳过转义
        if (chars[i] === quote) { i++; break }
        if (chars[i] === '\n') break // 字符串不能跨行，安全兜底
        i++
      }
      continue
    }
    // 模板字符串 `...` —— 整体剥离到下一个未转义的反引号。
    // 注意: 模板字符串内可能含 ${ 插值，插值里的内容（含嵌套模板/正则/引号）可能干扰简单扫描。
    // 这里选择「剥离到下一个未转义 ` 或行尾」，宁可多剥离、不误保留 —— 因为我们的目标是
    // 抓「代码里的裸函数调用」，模板字符串插值里的函数调用不在目标场景内（且 ${} 里的引用
    // 若真悬空，也属极少数，漏报代价远低于误报）。
    if (chars[i] === '`') {
      i++ // 跳过起始 `
      while (i < len) {
        if (chars[i] === '\\') { i += 2; continue }
        if (chars[i] === '`') { i++; break }
        if (chars[i] === '\n') break // 跨行模板字符串安全兜底：剥离到行尾
        i++
      }
      continue
    }
    // 普通代码字符 → 保留
    out[i] = chars[i]
    i++
  }
  return out.join('')
}

function auditActiveStory() {
  const hf = path.join(PLANS_DIR, ".harness-active")
  const ha = fs.existsSync(hf)
  const wfs = findActiveWorkflows()
  if (ha) {
    try {
      const flag = JSON.parse(fs.readFileSync(hf, "utf-8"))
      summary.harnessStoryId = flag.storyId; summary.harnessActive = true
      const st = readStateFile(flag.storyId)
      if (!st) issues.push({ cat: "state", severity: "BLOCKER", msg: ".harness-active 引用 " + flag.storyId + " 但 e2e-state.json 不存在" })
      else summary.harnessPhase = st.phase
    } catch { issues.push({ cat: "state", severity: "BLOCKER", msg: ".harness-active JSON 解析失败" }) }
  } else { summary.harnessActive = false; if (wfs.length > 0) warnings.push({ cat: "state", severity: "WARNING", msg: String(wfs.length) + " 个活跃工作流但 .harness-active 不存在" }) }
  summary.activeWorkflows = wfs.length
}

function auditDevPass() {
  const dp = checkDevPass()
  summary.devPassValid = dp.valid; summary.devPassStoryId = dp.storyId
  if (dp.valid && dp.storyId) {
    try {
      const pp = path.join(PLANS_DIR, dp.storyId, "dev-pass.json")
      const pass = JSON.parse(fs.readFileSync(pp, "utf-8"))
      if (pass.pathSource === "fallback-src-glob") warnings.push({ cat: "dev-pass", severity: "WARNING", msg: "dev-pass 降级为 src/** 全局 (storyId=" + dp.storyId + ")，建议完善 task-dag.json files" })
      else summary.devPassScope = "precise (" + (pass.allowedPaths ? pass.allowedPaths.length : 0) + " files)"
    } catch {}
  } else if (dp.storyId && fixMode) {
    try { fs.unlinkSync(path.join(PLANS_DIR, dp.storyId, "dev-pass.json")); fixed.push("已清理过期 dev-pass: " + dp.storyId) } catch {}
  }
}

function auditContracts() {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === "completed") continue
    const ph = st.phase || 0
    if (ph >= 1 || (st.phases && st.phases["0_requirement_analysis"] && st.phases["0_requirement_analysis"].status === "completed")) {
      const ac = checkAcceptanceCriteria(sid)
      if (!ac.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] acceptance-criteria.json: " + ac.errors.join("; ") })
      const oq = checkOpenQuestions(sid)
      if (!oq.allResolved) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] open-questions.json: " + oq.unresolved.length + " 项未解决" })
    }
    if (ph >= 2 || (st.phases && st.phases["1_task_planning"] && st.phases["1_task_planning"].status === "completed")) {
      const tdj = checkTaskDagJson(sid)
      if (!tdj.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] task-dag.json: " + tdj.errors.join("; ") })
      const ref = validateContractReferences(sid)
      if (!ref.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] AC-Task 引用: " + ref.errors.join("; ") })
    }
    if (ph >= 5 || (st.phases && st.phases["4_e2e_verification"] && st.phases["4_e2e_verification"].status === "completed")) {
      const av = checkAcceptanceVerification(sid)
      if (!av.allPassed) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] acceptance-verification.json: " + av.errors.join("; ") })
    }
  }
}

/**
 * 声明-消费一致性检查 — 抓「story-input 声明了外部依赖但流程未消费」的断裂
 *
 * 历史教训: 曾有 Story 在 story-input.json 声明了 figmaUrls，但开发阶段从未真正
 * 消费它 —— Figma 链路静默断裂，前端用默认样式实现，验收才发现货不对板。
 *
 * 检查逻辑: 对每个未完成 Story，若 story-input 声明了 Figma 链接（detectFigmaSource.hasFigma），
 * 则校验后续是否真的产出了 figma-frame-inventory.json（checkFigmaFrameInventory）。
 * 声明了 Figma 但 Phase 1（任务规划）没产出 frame 清单 = 断裂，告警。
 *
 * @returns {void}
 */
function auditDeclarationConsumption() {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === "completed") continue

    // 声明了 Figma 设计稿？
    const figma = detectFigmaSource(sid)
    if (!figma.hasFigma) continue

    // 是否已进入需要消费 Figma 的阶段（Phase >= 1，即已通过需求分析）
    const ph = st.phase || 0
    if (ph < 1) continue

    // 是否产出了 frame 清单（消费证据）
    const ffi = checkFigmaFrameInventory(sid)
    if (!ffi.valid) {
      const errText = (ffi.errors && ffi.errors.length > 0)
        ? ffi.errors.join("; ")
        : "figma-frame-inventory.json 缺失或无效"
      warnings.push({ cat: "decl-consume", severity: "WARNING", msg: "[" + sid + "] 声明了 " + figma.urls.length + " 个 Figma 链接但 Phase 1 未产出有效 frame 清单: " + errText })
    }
  }
}

function auditArtifacts() {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === "completed") continue
    const ph = st.phase || 0
    for (let p = 0; p < ph; p++) {
      if (st.bypass && p < 2) continue
      const art = checkPhaseArtifact(sid, p)
      if (!art.exists) { for (const m of art.missing) warnings.push({ cat: "artifact", severity: "WARNING", msg: "[" + sid + "] Phase " + p + " 缺失: " + m.description + " -> " + m.fileName }) }
    }
  }
}

function run() {
  auditCoreScripts(); auditDanglingReferences(); auditActiveStory(); auditDevPass(); auditContracts(); auditDeclarationConsumption(); auditArtifacts()
  summary.auditedAt = (new Date()).toISOString()
  summary.totalIssues = issues.length; summary.totalWarnings = warnings.length; summary.totalFixed = fixed.length
  if (jsonOnly) { console.log(JSON.stringify({ summary: summary, issues: issues, warnings: warnings, fixed: fixed }, null, 2)); return }
  console.log("")
  console.log("═══════════════════════════════════════════════════════")
  console.log("  Harness Engineering — CCHF 健康审计报告")
  console.log("  时间: " + summary.auditedAt)
  console.log("  Harness: " + (summary.harnessActive ? ("已激活 (" + (summary.harnessStoryId||"?") + ")") : "未激活"))
  console.log("  活跃工作流: " + (summary.activeWorkflows || 0) + " 个")
  console.log("  dev-pass: " + (summary.devPassValid ? ("有效" + (summary.devPassScope ? (" (" + summary.devPassScope + ")") : "")) : "无效"))
  console.log("═══════════════════════════════════════════════════════")
  if (issues.length > 0) { console.log(""); console.log("BLOCKERS (" + issues.length + "):"); for (const i of issues) console.log("  [" + i.cat + "] " + i.msg) }
  if (warnings.length > 0) { console.log(""); console.log("WARNINGS (" + warnings.length + "):"); for (const w of warnings) console.log("  [" + w.cat + "] " + w.msg) }
  if (fixed.length > 0) { console.log(""); console.log("FIXED (" + fixed.length + "):"); for (const f of fixed) console.log("  [ok] " + f) }
  if (issues.length === 0 && warnings.length === 0) { console.log(""); console.log("All checks passed.") }
  console.log(""); console.log("═══════════════════════════════════════════════════════")
  console.log("  Blockers: " + summary.totalIssues + " | Warnings: " + summary.totalWarnings + " | Fixed: " + summary.totalFixed)
  console.log("═══════════════════════════════════════════════════════")
  if (issues.length > 0) process.exit(1)
}
run()
