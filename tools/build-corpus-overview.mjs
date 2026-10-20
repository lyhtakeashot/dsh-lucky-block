/**
 * 生成 lib/语料库总览.md —— 本地语料库的人工查阅版。
 *
 * 为什么要有这个脚本：
 *   这份总览原先是我手工从两个 JSON 里抄出来的，于是每次扩充语料（170→353 条笑话、
 *   435→818 条冷知识）它就立刻过期，而**过期文档比没有文档更坏** —— 后来读它的人
 *   会拿旧数字去核对新数据，然后怀疑数据错了。
 *   所以改成从运行库直接生成，语料一变就重跑。
 *
 * 生成的内容分两节：
 *   一、冷笑话专场（lib/jokes-data.json）—— 按 form 分组，逐条编号列出
 *   二、随机冷知识闲聊（lib/trivia-data.json）—— 按 topic 分组，逐条编号列出
 *
 * 用法：
 *   node tools/build-corpus-overview.mjs          写盘
 *   node tools/build-corpus-overview.mjs --check  只对比，不写盘（给 CI/回归用）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const OUT = path.join(root, 'lib', '语料库总览.md')

const checkOnly = process.argv.includes('--check')

/** 读 JSON，剥掉可能存在的 BOM（Windows 工具链的经典坑）。 */
function loadJson(file) {
  const raw = readFileSync(file, 'utf8')
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(text)
}

const jokeFile = loadJson(path.join(root, 'lib', 'jokes-data.json'))
const jokes = jokeFile.jokes
const quips = jokeFile.quips
const trivia = loadJson(path.join(root, 'lib', 'trivia-data.json'))

/** 按某个字段分组，保持「出现次数多的类型排在前面」。 */
function groupBy(items, key) {
  const map = new Map()
  for (const item of items) {
    const k = item[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
}

/* ---------- 第一节：笑话 ---------- */
const jokeSections = []
for (const [form, list] of groupBy(jokes, 'form')) {
  jokeSections.push(`### ${form}（${list.length} 条）\n`)
  list.forEach((j, i) => jokeSections.push(`${i + 1}. ${j.text}`))
  jokeSections.push('')
}

/* ---------- 点评 ---------- */
const quipSection = [`### 点评（${quips.length} 条）\n`]
quips.forEach((q, i) => quipSection.push(`${i + 1}. ${q}`))
quipSection.push('')

/* ---------- 第二节：冷知识 ---------- */
const triviaSections = []
for (const [topic, list] of groupBy(trivia, 'topic')) {
  triviaSections.push(`### ${topic}（${list.length} 条）\n`)
  list.forEach((t, i) => triviaSections.push(`${i + 1}. ${t.text}`))
  triviaSections.push('')
}

/* ---------- 拼装 ---------- */
const topicLine = groupBy(trivia, 'topic')
  .map(([t, list]) => `${t} ${list.length}`)
  .join(' / ')

const doc = [
  '# 幸运方块 · 本地语料库总览',
  '',
  '> **本文件由 `node tools/build-corpus-overview.mjs` 自动生成，请勿手工编辑。**',
  '> 运行库是 `lib/jokes-data.json` 与 `lib/trivia-data.json`，本文件只是它们的人工查阅版。',
  '> 语料改动后重跑该脚本即可。',
  '',
  '---',
  '',
  '## 一、冷笑话专场（lib/jokes-data.json）',
  '',
  `共 **${jokes.length}** 条笑话 + **${quips.length}** 条点评。`,
  '点评是独立随机抽取的，且只有约 35% 的概率会附加，避免稀释笑话本身。',
  '',
  ...jokeSections,
  ...quipSection,
  '---',
  '',
  '## 二、随机冷知识闲聊（lib/trivia-data.json）',
  '',
  `共 **${trivia.length}** 条（${topicLine}），每条带 topic 与 source。`,
  '掷骰子时随机抽 1 条讲。',
  '',
  ...triviaSections,
].join('\n')

/* ---------- 写或比对 ---------- */
if (checkOnly) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`!! ${OUT} 不存在`)
    process.exit(1)
  }
  if (current === doc) {
    console.log('语料库总览与运行库一致')
  } else {
    console.error('!! 语料库总览已过期 —— 请重跑 node tools/build-corpus-overview.mjs')
    const a = current.split('\n').length
    const b = doc.split('\n').length
    console.error(`   现有 ${a} 行，应为 ${b} 行`)
    process.exit(1)
  }
} else {
  writeFileSync(OUT, doc, 'utf8')
  const back = readFileSync(OUT)
  const bom = back[0] === 0xef && back[1] === 0xbb && back[2] === 0xbf
  console.log(`已写出 ${OUT}`)
  console.log(`  笑话 ${jokes.length} 条 / 点评 ${quips.length} 条 / 冷知识 ${trivia.length} 条`)
  console.log(`  字节 ${back.length}, BOM=${bom}, 行数 ${doc.split('\n').length}`)
  if (bom) {
    console.error('!! 写出了 BOM')
    process.exit(1)
  }
}
