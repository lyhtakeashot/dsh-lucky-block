/**
 * 配置读取的边界测试：确认 readJson 能吃掉各种「看起来正常但不生效」的文件。
 *
 * 重点案例是 UTF-8 BOM —— Windows 记事本 / PowerShell `Set-Content -Encoding UTF8`
 * 保存 JSON 时会写 EF BB BF，`JSON.parse` 直接抛错，而 readJson 是 catch 掉返回
 * fallback 的，于是配置「写对了却完全不生效，还一声不吭」。实测踩过。
 *
 * 做法：从 lib/index.js 里抽出 readJson / stripBom 的真源码来跑（不是复制品），
 * 保证测的就是插件实际用的那两行。
 *
 * 用法：node tools/config-check.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(here, '..', 'lib', 'index.js'), 'utf8')

/* ---------- 抽真源码 ---------- */

function grab(re, label) {
  const m = src.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[0]
}

const readJsonSrc = grab(/async function readJson\(file, fallback\) \{[\s\S]*?\n\}/, 'readJson')
const stripBomSrc = grab(/function stripBom\(text\) \{[\s\S]*?\n\}/, 'stripBom')

// readJson 里用了 readFile，注入进来。
const factory = new Function(
  'readFile',
  `${stripBomSrc}\n${readJsonSrc}\nreturn { readJson, stripBom }`,
)

const dir = mkdtempSync(path.join(os.tmpdir(), 'lucky-cfg-'))
const readFile = (file) => Promise.resolve(readFileSync(file, 'utf8'))
const { readJson } = factory(readFile)

/* ---------- 用例 ---------- */

let pass = 0
let fail = 0

async function check(name, bytes, expected) {
  const file = path.join(dir, `${pass + fail}.json`)
  writeFileSync(file, Buffer.from(bytes))
  const got = await readJson(file, 'FALLBACK')
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`)
  }
}

const GOOD = '{"model":{"provider":"workbuddy","model":"deepseek-v4.1-flash"}}'
const PARSED = { model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }

console.log('— 正常文件 —')
await check('纯 UTF-8 无 BOM', Buffer.from(GOOD, 'utf8'), PARSED)
await check('带缩进与换行', Buffer.from(JSON.stringify(PARSED, null, 2), 'utf8'), PARSED)

console.log('')
console.log('— UTF-8 BOM（Windows 记事本 / PowerShell Set-Content 的产物）—')
await check(
  '带 EF BB BF 前缀',
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GOOD, 'utf8')]),
  PARSED,
)
await check(
  '带 BOM 且带缩进',
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(PARSED, null, 4), 'utf8'),
  ]),
  PARSED,
)

console.log('')
console.log('— 坏文件一律安静退回 fallback（不抛错）—')
await check('空文件', Buffer.from('', 'utf8'), 'FALLBACK')
await check('只有空白', Buffer.from('   \n  ', 'utf8'), 'FALLBACK')
await check('截断的 JSON', Buffer.from('{"model":{', 'utf8'), 'FALLBACK')
await check('是数组不是对象', Buffer.from('[1,2,3]', 'utf8'), [1, 2, 3])
await check('纯文本', Buffer.from('hello', 'utf8'), 'FALLBACK')

console.log('')
console.log('— 文件不存在 —')
const missing = await readJson(path.join(dir, 'nope.json'), 'FALLBACK')
if (missing === 'FALLBACK') {
  pass += 1
  console.log('  PASS  不存在的路径返回 fallback')
} else {
  fail += 1
  console.log(`  FAIL  不存在的路径返回了 ${JSON.stringify(missing)}`)
}

rmSync(dir, { recursive: true, force: true })

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
