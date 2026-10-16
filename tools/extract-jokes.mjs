/**
 * 从 research/joke-library.md 里抽出 A/B 两个 JSON 块，写入 lib/jokes-data.json。
 *
 * 为什么要走这一步：语料是子代理写进 Markdown 的，手抄进 .js 字符串字面量
 * 极易把内容写坏（子代理也明确提醒过）。抽成 JSON 文件后，
 * 代码里 `readFile + JSON.parse` 就是唯一真相，没有二次转写的余地。
 *
 * 用法：node tools/extract-jokes.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'research', 'joke-library.md')
const dst = path.join(root, 'lib', 'jokes-data.json')

// 注意：不要在这里用含反引号的模板字面量拼 fence，容易看错；直接 split。
const text = await readFile(src, 'utf8')
const fence = '`'.repeat(3)
const parts = text.split(fence)

let jokes = null
let quips = null

for (const part of parts) {
  // 代码块的内容形如 "json\n[...]"，语言标记后紧跟换行。
  const body = part.replace(/^(?:json|js|javascript)\s*\n/, '').trim()
  if (!body.startsWith('[')) continue

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    console.warn(`跳过无法解析的块（${body.length} 字）：${error.message}`)
    continue
  }
  if (!Array.isArray(parsed) || parsed.length === 0) continue

  const isJokeArray = parsed.every((x) => x && typeof x === 'object' && typeof x.text === 'string')
  const isQuipArray = parsed.every((x) => typeof x === 'string')

  if (isJokeArray && (!jokes || parsed.length > jokes.length)) jokes = parsed
  if (isQuipArray && (!quips || parsed.length > quips.length)) quips = parsed
}

if (!jokes) throw new Error('没找到笑话数组（对象数组，每项含 text）')
if (!quips) throw new Error('没找到点评数组（字符串数组）')

// 去重（按正文），并统计结构分布，便于发现语料退化。
const seen = new Set()
const uniqueJokes = []
for (const j of jokes) {
  const key = String(j.text).trim()
  if (key.length === 0 || seen.has(key)) continue
  seen.add(key)
  uniqueJokes.push({ text: key, form: typeof j.form === 'string' ? j.form : '未分类' })
}

const byForm = {}
for (const j of uniqueJokes) byForm[j.form] = (byForm[j.form] ?? 0) + 1

const out = {
  jokes: uniqueJokes,
  quips: [...new Set(quips.map((q) => String(q).trim()).filter((q) => q.length > 0))],
}

await writeFile(dst, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(`笑话 ${out.jokes.length} 条（原始 ${jokes.length}）/ 点评 ${out.quips.length} 条`)
console.log('结构分布：', byForm)
console.log(`-> ${dst}`)
