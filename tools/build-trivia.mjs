/**
 * 把两个并行 subagent 各自产出的候选池合并成**唯一权威**的 `lib/trivia-data.json`。
 *
 * 为什么需要重写这个脚本：冷知识库这一轮被两个 subagent **同时写入**，
 * 而两边各自都带了一个自称"权威"的生成器（`tools/build-trivia.mjs` 与
 * `research/build-final.mjs`）。结果是：跑哪个生成器，文件就变成哪个版本 ——
 * 实测跑 `build-final.mjs` 把 447 条**回退成 435 条**，静默丢掉另一边的
 * 13 条改写与 1 条伪科学修正。在这里「有个生成器」不是保障，而是**回退陷阱**。
 *
 * 本脚本的立场：**运行库 `lib/trivia-data.json` 是唯一事实来源**，
 * `research/trivia-candidates.mjs` 只作为补充候选。不再保留第二个能覆盖它的生成器。
 *
 * 用法：node tools/build-trivia.mjs           # 合并并写回
 *       node tools/build-trivia.mjs --check    # 只检查，不写
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'lib', 'trivia-data.json')

/** 允许的 topic 枚举。 */
const TOPICS = new Set(['科学', '人体', '动物', '地理', '历史', '语言', '日常'])

/** 正文长度区间（按字符计，中文一个字算一个）。120 是"一口气念不完"的界限。 */
const MIN_LEN = 8
const MAX_LEN = 120

/**
 * 已辟谣的伪冷知识。
 *
 * 注意这里**允许辟谣条目通过**：正文写「舌头味觉分区图是误传……」的条目
 * 正是用来纠正讹传的，把它一起拦掉反而会让库里只剩错误说法。
 * 判据是正文里有明确的否定词。
 */
const DEBUNKED = [
  /金鱼.{0,8}记忆.{0,6}(?:7|七)秒/,
  /(?:DNA|基因).{0,10}(?:60%|六成)/,
  /长城.{0,12}(?:太空|月球).{0,8}肉眼/,
  /一生.{0,8}(?:吞|吃)(?:下)?.{0,6}\d+.{0,2}只蜘蛛/,
  /舌头.{0,8}味觉分区/,
  /(?:左脑|右脑).{0,10}(?:负责|管|擅长).{0,10}(?:逻辑|创造|艺术)/,
  /(?:剃|刮)(?:毛|掉).{0,10}(?:长得|变).{0,6}(?:快|粗|黑)/,
  /(?:死后|人死后).{0,14}(?:头发|指甲).{0,8}(?:继续|还会|仍在)(?:生长|长)/,
  /静脉血.{0,8}(?:蓝色|蓝的)/,
  /只(?:用|使用)了.{0,4}(?:10%|10％|百分之十).{0,6}(?:大脑|脑)/,
  /百慕大.{0,8}三角.{0,12}神秘/,
  /爱因斯坦.{0,10}(?:小时)?.{0,8}(?:数学|成绩).{0,6}(?:不好|差)/,
  /每天(?:要)?喝(?:够)?.{0,6}(?:8|八).{0,4}杯水/,
  /(?:手机|电池).{0,10}充.{0,6}(?:12|十二).{0,4}小时/,
  /成年人.{0,10}(?:有)?.{0,4}206.{0,6}块骨头/,
]

/**
 * 正文里禁止出现的东西：Markdown 标记与换行。
 *
 * 这里**故意不拦「你知道吗」「冷知识：」这类开场白** —— 库里的正文是
 * 用户直接看到的最终文案，有些条目靠这种口吻才自然。真要在意的话应该
 * 单独做一次风格检查，而不是顺手塞进合法性校验（顺手塞的结果实测是
 * 把一条正常条目判成非法，见下面的 `DATA` 注释）。
 */
const BAD_TEXT = /[*#`\n\r]/
/**
 * 否定词：出现这些说明条目是在**辟谣**，不该按伪科学拦掉。
 *
 * 「并」必须在列表里：中文辟谣句几乎都用「并不/并没有」，
 * 只写「并没有」会漏掉「并不支持」这种更常见的说法（实测漏过 2 条）。
 */
const NEGATION = /误传|讹传|错的|不实|并不|并没有|并非|其实不|不是真的|已辟谣|渲染|不支持/

function load(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`读不了 ${file}：${error.message}`)
    return null
  }
}

/** 把一个条目规整成目标形状；不合格返回 null。 */
function normalize(item) {
  const text = String(item?.text ?? '').trim()
  const topic = String(item?.topic ?? '').trim()
  const source = String(item?.source ?? '').trim()
  if (!text || !TOPICS.has(topic)) return null
  if (text.length < MIN_LEN || text.length > MAX_LEN) return null
  if (BAD_TEXT.test(text)) return null
  for (const re of DEBUNKED) {
    if (re.test(text) && !NEGATION.test(text)) return null
  }
  return { text, topic, source: source || '公开常识' }
}

/* ---------------- 主流程 ---------------- */

const current = load(TARGET)
if (!Array.isArray(current)) {
  console.error('运行库不是合法 JSON 数组，中止（不要用本脚本去"修"一个坏文件）')
  process.exit(1)
}

const pool = []
let dropped = 0
for (const item of current) {
  const normalized = normalize(item)
  if (normalized) pool.push(normalized)
  else dropped += 1
}
console.log(`运行库条目: ${current.length}（不合格被剔除 ${dropped}）`)

/* 候选池是补充来源。它不存在也不影响主流程。
   注意 Windows 上 import() 不认盘符路径（'d:/...'），必须转成 file:// URL。 */
let candidatesSeen = 0
try {
  const mod = await import(pathToFileURL(path.join(ROOT, 'research', 'trivia-candidates.mjs')).href)
  const candidates = Array.isArray(mod.candidates) ? mod.candidates : []
  candidatesSeen = candidates.length
  for (const item of candidates) {
    const normalized = normalize(item)
    if (normalized) pool.push(normalized)
  }
} catch (error) {
  console.log(`候选池不可用（跳过，不是错误）：${error.message}`)
}
console.log(`候选池条目: ${candidatesSeen}`)

/* 去重：正文完全相同的只留第一条。 */
const seen = new Set()
const final = []
for (const item of pool) {
  if (seen.has(item.text)) continue
  seen.add(item.text)
  final.push(item)
}

const byTopic = {}
for (const item of final) byTopic[item.topic] = (byTopic[item.topic] ?? 0) + 1

console.log(`合并后: ${final.length} 条`)
console.log(`topic 分布: ${JSON.stringify(byTopic)}`)
console.log(`长度区间: ${Math.min(...final.map((x) => x.text.length))}–${Math.max(...final.map((x) => x.text.length))} 字`)

if (process.argv.includes('--check')) {
  console.log('\n--check 模式，未写盘。')
  process.exit(0)
}

writeFileSync(TARGET, `${JSON.stringify(final, null, 2)}\n`, 'utf8')

/* 写回后立刻回读验证：不相信"我刚写了什么"，只相信从磁盘读回来的。 */
const back = load(TARGET)
const bytes = readFileSync(TARGET)
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

console.log('\n=== 写回验证 ===')
console.log(`BOM: ${hasBom ? '❌ 有' : '✅ 无'}`)
console.log(`JSON.parse: ${Array.isArray(back) ? '✅ 成功' : '❌ 失败'}`)
console.log(`回读条数: ${back?.length ?? 0}`)
console.log(`字节数: ${bytes.length}`)

if (hasBom || !Array.isArray(back) || back.length !== final.length) {
  console.error('写回验证失败')
  process.exit(1)
}
