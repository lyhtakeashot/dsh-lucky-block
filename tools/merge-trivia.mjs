/**
 * 把扩充语料合并进运行库 lib/trivia-data.json。
 *
 * 数据来源：
 *   · 旧库 435 条（原始权威）
 *   · research/trivia-batch-a.json  185 条（科学/人体/动物）
 *   · research/trivia-batch-b.json  200 条（历史/地理/语言/日常）
 *
 * 与 tools/merge-jokes.mjs 同构，但冷知识有几条额外校验：
 *   · `topic` 必须落在固定词表内（拼错一个 topic 会在客户端分组时静默消失）
 *   · 必须有非空 `source`（这个字段不展示给用户，但留着便于日后复核来源）
 *   · 比笑话更需要防**伪冷知识**，所以带一份黑名单扫描 —— 命中不直接拒绝，
 *     而是打出来让人看：很多禁令词的合法语境是「辟谣」，那种必须放行。
 *
 * 设计原则：
 *   1. **运行库是唯一事实来源**。候选文件合并后**保留**在 research/ 里，
 *      但注意：本脚本会按 `research/trivia-candidates.mjs` 的同名旧路数覆盖
 *      运行库内容 —— 所以**不要**再跑 research/ 下的旧生成器，那会把库回退。
 *   2. 去重按 text 精确比对。
 *   3. UTF-8 无 BOM 写出并回读验证。
 *
 * 用法：
 *   node tools/merge-trivia.mjs           合并并写盘
 *   node tools/merge-trivia.mjs --check   只体检，不写盘
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const LIB = path.join(root, 'lib', 'trivia-data.json')

const checkOnly = process.argv.includes('--check')

/** 合法的主题词表。写错一个 topic 就会让客户端按主题筛选时丢失该条。 */
const TOPICS = ['科学', '人体', '动物', '地理', '历史', '语言', '日常']

/**
 * 常见伪冷知识黑名单。
 *
 * ⚠️ 命中**不等于**要删 —— 库里有一批条目是**辟谣**（「舌头味觉分区图是误传」），
 * 那种必须留下，否则读者只记得讹传。所以这里只负责「把可疑的挑出来给人看」，
 * 由 `NEGATION` 判断是不是辟谣语境，两者结合才决定删不删。
 */
const DEBUNKED = [
  /金鱼.{0,4}(七|7|三|3)秒/,
  /香蕉.{0,8}DNA/,
  /长城.{0,10}(太空|肉眼)/,
  /味觉分区/,
  /一生.{0,6}吞.{0,4}蜘蛛/,
  /静脉血.{0,4}蓝色/,
  /大脑.{0,6}10%/,
  /左右脑.{0,4}(分工|理性)/,
  /百慕大/,
  /拿破仑.{0,4}矮/,
  /爱因斯坦.{0,6}(数学|成绩差)/,
  /(每天|每日).{0,4}8\s*杯水/,
  /口香糖.{0,6}(7|七)年/,
  /玻璃.{0,10}(液体|流动)/,
  /公牛.{0,6}红(色|布)/,
  /狗.{0,4}黑白/,
  /鸵鸟.{0,8}(埋|沙子)/,
  /蝙蝠.{0,4}瞎/,
]

/**
 * 辟谣语境的判据。命中黑名单但命中这个，说明条目本身是在纠正讹传，应放行。
 *
 * 「不是」必须单独在列，不能只靠「不是真的」：中文辟谣句最常见的形态就是
 * 「X 不是 Y，而是 Z」（如「玻璃不是流动的液体，而是非晶态固体」）。
 * 只写「不是真的」会漏掉这一整类，把它们当成讹传打出来 —— 实测就误报过。
 */
const NEGATION = /误传|讹传|错的|不实|并不|并没有|并非|其实不|不是真的|不是|已辟谣|是假的|被推翻|说法不成立|没有证据/

/** 正文里不该出现的字符：markdown 标记、换行。 */
const BAD_TEXT = /[*#`\n\r]/

function load(file) {
  const raw = readFileSync(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const data = JSON.parse(text)
  if (Array.isArray(data)) return data
  throw new Error(`${path.basename(file)} 顶层不是数组`)
}

/* ---------- 读旧库 ---------- */
const old = load(LIB)
console.log(`旧库 ${old.length} 条`)
const seen = new Set(old.map((x) => x.text))
const merged = [...old]

/* ---------- 合并候选 ---------- */
const CANDIDATES = ['trivia-batch-a.json', 'trivia-batch-b.json']
for (const name of CANDIDATES) {
  const file = path.join(root, 'research', name)
  if (!existsSync(file)) {
    console.log(`  跳过（不存在）: ${name}`)
    continue
  }
  const items = load(file)
  let ok = 0
  let dup = 0
  let bad = 0
  for (const item of items) {
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    const topic = typeof item?.topic === 'string' ? item.topic.trim() : ''
    const source = typeof item?.source === 'string' ? item.source.trim() : ''
    if (!text || !topic || !source) { bad += 1; continue }
    if (seen.has(text)) { dup += 1; continue }
    seen.add(text)
    // 键顺序固定成 text / topic / source，方便 diff 与人工核对。
    merged.push({ text, topic, source })
    ok += 1
  }
  console.log(`  ${name}: 新增 ${ok} 条，重复 ${dup} 条，缺字段 ${bad} 条`)
}

/* ---------- 体检 ---------- */
const problems = []
const suspicions = []

for (const [i, item] of merged.entries()) {
  const { text, topic, source } = item
  if (!text || !topic || !source) problems.push(`#${i} 有空字段`)
  if (!TOPICS.includes(topic)) problems.push(`#${i} 非法 topic「${topic}」`)
  if (/[,;:!?]/.test(text)) problems.push(`#${i} 含英文标点: ${text.slice(0, 24)}`)
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push(`#${i} 含 emoji`)
  if (BAD_TEXT.test(text)) problems.push(`#${i} 含 markdown 或换行`)
  if (text.length < 8 || text.length > 120) problems.push(`#${i} 长度越界(${text.length}): ${text.slice(0, 24)}`)

  // 伪冷知识扫描：命中黑名单但**不是**辟谣语境的，才拿出来给人看。
  for (const re of DEBUNKED) {
    if (re.test(text)) {
      if (!NEGATION.test(text)) suspicions.push(`#${i} 疑似讹传: ${text.slice(0, 50)}`)
      break
    }
  }
}

const byTopic = {}
for (const x of merged) byTopic[x.topic] = (byTopic[x.topic] || 0) + 1

const lens = merged.map((x) => x.text.length)
const uniq = new Set(merged.map((x) => x.text))

console.log('\n=== 合并结果 ===')
console.log(`总数:   ${merged.length}`)
console.log(`去重后: ${uniq.size}`)
console.log(`长度:   ${Math.min(...lens)} - ${Math.max(...lens)}`)
console.log('\n按主题分布:')
for (const t of TOPICS) console.log(`  ${t.padEnd(4)} ${String(byTopic[t] ?? 0).padStart(4)}`)

if (suspicions.length > 0) {
  console.log(`\n⚠ 疑似伪冷知识 ${suspicions.length} 条（请人工复核，不自动拒绝）：`)
  for (const s of suspicions) console.log(`   ${s}`)
} else {
  console.log('\n伪冷知识扫描: 无命中')
}

if (problems.length > 0) {
  console.log(`\n!! 发现问题 ${problems.length} 个：`)
  for (const p of problems.slice(0, 30)) console.log(`   ${p}`)
} else {
  console.log('体检: 全部通过')
}

if (checkOnly) {
  console.log('\n--check 模式：未写盘')
  process.exit(problems.length === 0 ? 0 : 1)
}

if (problems.length > 0) {
  console.error('\n体检不通过，拒绝写盘。')
  process.exit(1)
}

/* ---------- 写盘 ---------- */
const json = JSON.stringify(merged, null, 2)
writeFileSync(LIB, json, 'utf8')

const back = readFileSync(LIB)
const bom = back[0] === 0xef && back[1] === 0xbb && back[2] === 0xbf
const reparsed = JSON.parse(back.toString('utf8'))
console.log(`\n已写出 ${LIB}`)
console.log(`  回读: 字节 ${back.length}, BOM=${bom}, 条数 ${reparsed.length}`)
if (bom || reparsed.length !== merged.length) {
  console.error('!! 回读验证失败')
  process.exit(1)
}
console.log('  回读验证通过')
