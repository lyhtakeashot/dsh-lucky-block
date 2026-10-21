/**
 * 蓝屏十张脸的「内容质量」检查。
 *
 * lib/index.js 是宿主 ESM 模块，直接 import 会拉起 apply()、读真实 $DSH_HOME，
 * 而这里要测的只是 BLUESCREEN_VARIANTS 这一块**纯数据**。所以和 panel-check
 * 一样用「源码抽取 + eval」：把数组字面量抠出来跑一遍，测的是真代码里的真文案。
 *
 * 钉住四件容易悄悄坏掉的事：
 *   1. 张数：正好十张。改这个数要连着改文档和本脚本 —— 是一次有意识的操作，
 *      不该被顺手加一张悄悄带过去。
 *   2. 不重复：表情 / 背景色 / STOP 码 / 首句，四者都不能撞。撞了的表现是
 *      「明明十张，用户却觉得只有三张」—— 而他永远不会来报告这件事。
 *   3. 结构：每张四行、都有一行 STOP 码、STOP 码格式统一、背景色是合法 hex、
 *      表情是 ASCII（96px 的中文字体里 o_o / >_< 能排，缺字的符号会变豆腐块）。
 *   4. 出口与时长：每张末行必须有 ESC，每张必须说清时长（60 秒 / 六十秒），
 *      且 BLUESCREEN_MS 真的是 60 秒 —— 文案说 60、代码跑 30 是最坏的错。
 *
 * 用法：node tools/bluescreen-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.resolve(here, '..', 'lib', 'index.js')
const source = readFileSync(indexPath, 'utf8')

/* ---------- 抽取 ---------- */

function grab(re, label) {
  const m = source.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[1]
}

const arraySource = grab(/const BLUESCREEN_VARIANTS = (\[[\s\S]*?\n\])\n/, 'BLUESCREEN_VARIANTS')
const variants = new Function(`return ${arraySource}`)()

/* ---------- 断言 ---------- */

let pass = 0
let fail = 0
const failures = []

function checkTrue(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? `（${detail}）` : ''))
    console.log(`FAIL ${label}${detail ? `（${detail}）` : ''}`)
  }
}

function checkEqual(label, actual, expected) {
  checkTrue(label, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function duplicates(list) {
  const seen = new Set()
  const dup = new Set()
  for (const item of list) {
    if (seen.has(item)) dup.add(item)
    seen.add(item)
  }
  return [...dup]
}

function stopCodeOf(lines) {
  const hit = lines.find((line) => typeof line === 'string' && line.startsWith('STOP: '))
  return hit === undefined ? '' : hit.split(' ')[1]
}

const names = variants.map((v, i) => `#${i + 1}`)

/* ---- 1. 张数与结构 ---- */

checkEqual('正好十张脸', variants.length, 10)
checkEqual('每张都恰好三个字段（background/heading/lines，多一个就是没接线）',
  [...new Set(variants.map((v) => Object.keys(v).sort().join(',')))].join(' | '),
  'background,heading,lines')

variants.forEach((v, i) => {
  const tag = names[i]
  checkTrue(`${tag} 的 lines 恰好四行`, Array.isArray(v.lines) && v.lines.length === 4,
    `实际 ${Array.isArray(v.lines) ? v.lines.length : 'NA'}`)
  checkTrue(`${tag} 的四行都是非空字符串`,
    Array.isArray(v.lines) && v.lines.every((line) => typeof line === 'string' && line.trim().length > 0))
  checkTrue(`${tag} 有一行以 STOP: 开头`, Array.isArray(v.lines) && v.lines.some((l) => typeof l === 'string' && l.startsWith('STOP: ')))
})

/* ---- 2. 四样东西都不许撞 ---- */

checkTrue('表情两两不重复', duplicates(variants.map((v) => v.heading)).length === 0,
  `重复: ${JSON.stringify(duplicates(variants.map((v) => v.heading)))}`)
checkTrue('背景色两两不重复', duplicates(variants.map((v) => v.background)).length === 0,
  `重复: ${JSON.stringify(duplicates(variants.map((v) => v.background)))}`)
checkTrue('STOP 码两两不重复', duplicates(variants.map((v) => stopCodeOf(v.lines))).length === 0,
  `重复: ${JSON.stringify(duplicates(variants.map((v) => stopCodeOf(v.lines))))}`)
checkTrue('首句两两不重复', duplicates(variants.map((v) => v.lines[0])).length === 0,
  `重复: ${JSON.stringify(duplicates(variants.map((v) => v.lines[0])))}`)

/* ---- 3. 格式 ---- */

variants.forEach((v, i) => {
  const tag = names[i]
  checkTrue(`${tag} 的背景色是合法 hex`, /^#[0-9a-f]{6}$/i.test(String(v.background)), `实际 ${v.background}`)
  checkTrue(`${tag} 的表情是 1~4 个可见 ASCII 字符`, /^[\x21-\x7e]{1,4}$/.test(String(v.heading)),
    `实际 ${JSON.stringify(v.heading)}`)
  checkTrue(`${tag} 的 STOP 码格式统一`, /^STOP: 0x[0-9A-Z]{6,12} \([A-Z0-9_]+\)$/.test(
    String(v.lines.find((l) => typeof l === 'string' && l.startsWith('STOP: ')))),
    `实际 ${JSON.stringify(v.lines.find((l) => typeof l === 'string' && l.startsWith('STOP: ')))}`)
  checkTrue(`${tag} 的 STOP 码里藏着可读的词（至少 6 个字符，不是随手打的 hex）`,
    stopCodeOf(v.lines).replace(/^0x/, '').length >= 6)
})

/* ---- 4. 出口与时长 ---- */

variants.forEach((v, i) => {
  const tag = names[i]
  checkTrue(`${tag} 末行留了 ESC 出口（用户永远能提前走）`, /ESC/.test(String(v.lines[3])),
    `实际 ${JSON.stringify(v.lines[3])}`)
  checkTrue(`${tag} 说清了时长（60 秒 / 六十秒）`, /60|六十/.test(v.lines.join(' ')),
    `实际 ${JSON.stringify(v.lines.join(' '))}`)
})

/* ---- 5. 接线：宿主真的随机抽，不是永远第一张 ---- */

checkTrue('prepare() 用 variants.length 随机抽一张',
  /BLUESCREEN_VARIANTS\[Math\.floor\(rand\(\) \* BLUESCREEN_VARIANTS\.length\)\]/.test(source))
checkTrue('BLUESCREEN_MS 仍然是 60 秒（文案说的时长要和代码对得上）',
  /const BLUESCREEN_MS = 60_000\b/.test(source))
checkTrue('BLUESCREEN_LINES 仍指向第一张（客户端兜底那条路不能断）',
  /const BLUESCREEN_LINES = BLUESCREEN_VARIANTS\[0\]\.lines/.test(source))

/* ---------- 汇总 ---------- */

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
  process.exit(0)
}
console.log(`FAILED  pass=${pass} fail=${fail}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)