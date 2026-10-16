/**
 * 把扩充语料合并进运行库 lib/jokes-data.json。
 *
 * 数据来源：
 *   · 旧库 170 条（其中「拆字式」12 条按用户决定删除）
 *   · research/jokes-absurd.json   65 条（荒谬逻辑）
 *   · research/jokes-literal.json  65 条（反向解读）
 *   · research/jokes-machine.json  65 条（机器视角）
 *
 * 设计原则：
 *   1. **运行库是唯一事实来源**。这个脚本读完三个候选文件后**不删它们**，
 *      只是合并 —— 候选文件留在 research/ 里作为存档。
 *   2. 去重按 text 精确比对（新库三批之间已由子代理各自查重，这里再兜一次跨批重复）。
 *   3. 全部走 UTF-8 无 BOM 写出（Windows 上 PowerShell 的 Set-Content 会写 BOM，
 *      那会让 JSON.parse 直接抛，见 DESIGN.md 记过的坑）。
 *
 * 用法：
 *   node tools/merge-jokes.mjs           合并并写盘
 *   node tools/merge-jokes.mjs --check   只体检，不写盘
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const LIB = path.join(root, 'lib', 'jokes-data.json')

const checkOnly = process.argv.includes('--check')

/** 用户明确要求删掉的类型：把成语/词逐字拆开反问，没有场景也没有洞察。 */
const DROP_FORM = '拆字式'

const CANDIDATES = [
  path.join(root, 'research', 'jokes-absurd.json'),
  path.join(root, 'research', 'jokes-literal.json'),
  path.join(root, 'research', 'jokes-machine.json'),
]

/** 读一个 JSON 文件，兼容两种形状：裸数组，或 `{jokes, quips}` 对象。 */
function load(file) {
  const raw = readFileSync(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const data = JSON.parse(text)
  if (Array.isArray(data)) return { jokes: data, quips: null }
  if (data && typeof data === 'object' && Array.isArray(data.jokes)) {
    return { jokes: data.jokes, quips: Array.isArray(data.quips) ? data.quips : null }
  }
  throw new Error(`${path.basename(file)} 既不是数组也不是 {jokes,quips} 对象`)
}

/* ---------- 读旧库 ---------- */
const oldFile = load(LIB)
const old = oldFile
const kept = old.jokes.filter((j) => j.form !== DROP_FORM)
const dropped = old.jokes.length - kept.length
console.log(`旧库 ${old.jokes.length} 条，删掉「${DROP_FORM}」${dropped} 条，保留 ${kept.length} 条`)

/* ---------- 读新库 ---------- */
const seen = new Set(kept.map((j) => j.text))
const added = []
for (const file of CANDIDATES) {
  if (!existsSync(file)) {
    console.log(`  跳过（不存在）: ${path.basename(file)}`)
    continue
  }
  const items = load(file).jokes
  let ok = 0
  let dup = 0
  for (const item of items) {
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    const form = typeof item?.form === 'string' ? item.form.trim() : ''
    if (!text || !form) continue
    if (seen.has(text)) {
      dup += 1
      continue
    }
    seen.add(text)
    added.push({ text, form })
    ok += 1
  }
  console.log(`  ${path.basename(file)}: 新增 ${ok} 条，跨批重复 ${dup} 条`)
}

const jokes = [...kept, ...added]

/* ---------- 体检 ---------- */
const byForm = {}
for (const j of jokes) byForm[j.form] = (byForm[j.form] || 0) + 1

const problems = []
for (const [i, j] of jokes.entries()) {
  if (typeof j.text !== 'string' || j.text.trim().length === 0) problems.push(`#${i} text 为空`)
  if (typeof j.form !== 'string' || j.form.trim().length === 0) problems.push(`#${i} form 为空`)
  if (/[,;:!?]/.test(j.text)) problems.push(`#${i} 含英文标点: ${j.text.slice(0, 30)}`)
  if (/\p{Extended_Pictographic}/u.test(j.text)) problems.push(`#${i} 含 emoji`)
  if (/[*#`\n\r]/.test(j.text)) problems.push(`#${i} 含 markdown 或换行`)
}

const lens = jokes.map((j) => j.text.length)
const uniq = new Set(jokes.map((j) => j.text))

console.log('\n=== 合并结果 ===')
console.log(`笑话总数: ${jokes.length}`)
console.log(`去重后:   ${uniq.size}`)
console.log(`长度范围: ${Math.min(...lens)} - ${Math.max(...lens)}`)
console.log('\n按类型分布:')
for (const [form, n] of Object.entries(byForm).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${form.padEnd(14)} ${String(n).padStart(3)}`)
}
console.log(`\n点评数: ${oldFile.quips ? oldFile.quips.length : 0}`)

if (problems.length > 0) {
  console.log(`\n!! 体检发现 ${problems.length} 个问题：`)
  for (const p of problems.slice(0, 30)) console.log(`   ${p}`)
} else {
  console.log('\n体检: 全部通过（无空字段 / 无英文标点 / 无 emoji / 无 markdown）')
}

if (checkOnly) {
  console.log('\n--check 模式：未写盘')
  process.exit(problems.length === 0 ? 0 : 1)
}

/* ---------- 写盘 ---------- */
if (problems.length > 0) {
  console.error('\n体检不通过，拒绝写盘。')
  process.exit(1)
}

const next = { jokes, quips: oldFile.quips ?? [] }
const json = JSON.stringify(next, null, 2)
writeFileSync(LIB, json, 'utf8')

// 回读验证：BOM、可解析、条数一致。写盘不验证等于没写。
const back = readFileSync(LIB)
const bom = back[0] === 0xef && back[1] === 0xbb && back[2] === 0xbf
const reparsed = JSON.parse(back.toString('utf8'))
console.log(`\n已写出 ${LIB}`)
console.log(`  回读: 字节 ${back.length}, BOM=${bom}, 笑话 ${reparsed.jokes.length}, 点评 ${reparsed.quips.length}`)
if (bom || reparsed.jokes.length !== jokes.length) {
  console.error('!! 回读验证失败')
  process.exit(1)
}
console.log('  回读验证通过')
