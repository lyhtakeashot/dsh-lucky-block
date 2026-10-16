/**
 * 本地内容路径的行为测试。
 *
 * 为什么不能只靠 host-smoke：smoke 只验证「注册了路由 / 清单里有 local 标记」，
 * 而这里要验证**真的能取出内容**，且内容符合契约。
 *
 * 做法：从 lib/index.js 抽真源码里的 localPayload / localOnlyConfig 逻辑太脆弱，
 * 改为直接测它们依赖的两个数据源 + 语义不变量：
 *   1. 两个语料库都读得到、条数够、无脏数据
 *   2. localOnlyConfig 的白名单语义（这是最容易写错的地方）
 *
 * 用法：node tools/local-check.mjs
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadJokeLibrary } from '../lib/jokes.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* --- 1. 冷笑话库 --- */
const { jokes, quips } = await loadJokeLibrary()
check('笑话库非空', jokes.length >= 100, `实际 ${jokes.length}`)
check('点评库非空', quips.length >= 10, `实际 ${quips.length}`)
check('笑话无空文本', jokes.every((j) => j.text.trim().length > 0))
check('笑话无英文标点', jokes.every((j) => !/[,;:!?]/.test(j.text)), jokes.find((j) => /[,;:!?]/.test(j.text))?.text?.slice(0, 40))
check('笑话有结构分类', jokes.every((j) => typeof j.form === 'string' && j.form.length > 0))
check('笑话文本无重复', new Set(jokes.map((j) => j.text)).size === jokes.length)
check('点评无重复', new Set(quips).size === quips.length)
// form 绝不能出现在正文里（否则会泄漏给用户）
check('正文不含 form 标注', jokes.every((j) => !j.text.includes(j.form)))

/* --- 2. 冷知识库 --- */
const triviaRaw = await readFile(path.join(root, 'lib', 'trivia-data.json'), 'utf8').catch(() => null)
check('trivia-data.json 存在', triviaRaw !== null)
if (triviaRaw) {
  const clean = triviaRaw.charCodeAt(0) === 0xfeff ? triviaRaw.slice(1) : triviaRaw
  let trivia = null
  try {
    trivia = JSON.parse(clean)
  } catch (error) {
    check('trivia-data.json 可解析', false, error.message)
  }
  if (Array.isArray(trivia)) {
    // 下限设为 100：种子数据只有 20 条时这里必须是红的 —— 它是在提醒
    // 「语料还没补全」，不是在报一个格式错误。
    check('冷知识条数 ≥ 100', trivia.length >= 100, `实际 ${trivia.length}`)
    check('冷知识每项有 text', trivia.every((t) => t && typeof t.text === 'string' && t.text.trim().length > 0))
    check('冷知识每项有 topic', trivia.every((t) => t && typeof t.topic === 'string' && t.topic.length > 0))
    check('冷知识文本无重复', new Set(trivia.map((t) => t.text)).size === trivia.length)
    check('冷知识单条 ≤ 120 字', trivia.every((t) => t.text.length <= 120), `最长 ${Math.max(...trivia.map((t) => t.text.length))}`)
    const topics = {}
    for (const t of trivia) topics[t.topic] = (topics[t.topic] ?? 0) + 1
    console.log('冷知识 topic 分布:', JSON.stringify(topics))
  } else if (trivia !== null) {
    check('trivia-data.json 是数组', false, typeof trivia)
  }
}

/* --- 3. localOnlyConfig 的白名单语义 ---
   这段逻辑在 lib/index.js 的 apply 作用域里，拿不到。所以这里用**行为等价**的
   复现来锁定语义 —— 它测的是我理解的规则，若实现改了这里也要跟着改。
   真正的端到端由 tools/probe-local.mjs（连真宿主）负责。 */
function localOnlySemantics(declared, capable) {
  const set = new Set()
  if (declared === true) return new Set(capable)
  const listed = Array.isArray(declared)
    ? declared
    : declared && typeof declared === 'object'
      ? Object.entries(declared).filter(([, v]) => v === true).map(([k]) => k)
      : []
  for (const item of listed) {
    const id = String(item ?? '').trim()
    if (id === '*') for (const c of capable) set.add(c)
    else if (capable.includes(id)) set.add(id)
  }
  return set
}
const capable = ['trivia', 'joke']
check('未配置 → 全关', localOnlySemantics(undefined, capable).size === 0)
check('数组白名单 → 只开列出的', [...localOnlySemantics(['trivia'], capable)].join() === 'trivia')
check('* → 全开', localOnlySemantics(['*'], capable).size === 2)
check('对象写法 → 只取 true', [...localOnlySemantics({ trivia: true, joke: false }, capable)].join() === 'trivia')
check('true → 全开', localOnlySemantics(true, capable).size === 2)
check('不支持的 id 被忽略', localOnlySemantics(['news', 'trivia'], capable).size === 1)
check('拼错/空串被忽略', localOnlySemantics(['', '  ', 'jokee'], capable).size === 0)
check('垃圾类型 → 全关', localOnlySemantics(42, capable).size === 0)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
