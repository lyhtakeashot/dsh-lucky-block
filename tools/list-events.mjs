/**
 * 从 lib/index.js 的 buildEvents() 里抽出事件清单，打印 id / 标题 / 权重 / 概率 / 类型。
 * 用途：骰子按钮的「事件一览」文档与 ping 自检都依赖这份真实清单，
 * 避免文档和代码漂移。
 *
 * 实现要点：**不假设字段顺序**。早期版本用一条把 id/weight/title 写死成
 * 相邻三行的正则，结果加了 kind 字段（插在 weight 和 title 之间）之后
 * 视觉事件全部解析不到 —— 而输出看起来完全正常，只是少了两行。
 * 那种错误比抛异常危险得多，所以改成逐条切分再逐字段取值。
 *
 * 用法：node tools/list-events.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(here, '..', 'lib', 'index.js'), 'utf8')

// 只扫 buildEvents() 的函数体，避免误抓别处的 id/weight/title 组合。
const start = src.indexOf('function buildEvents()')
if (start === -1) {
  console.error('找不到 buildEvents()，检查函数是否被改名')
  process.exit(1)
}
// 函数体的结束：下一个顶层「零缩进」的 /* 注释块，或文件结束。
const end = src.indexOf('\n/* ---', start)
const body = src.slice(start, end === -1 ? undefined : end)

/* 按「顶层事件对象」切分。
   每个事件的开头是 `    {` 后跟 `      id: 'xxx',`（缩进 4 空格）。
   用缩进区分顶层事件和嵌套对象，避免抽到 visual: { kind: 'popups' } 里的东西。 */
const chunks = body.split(/\n(?= {4}\{\n {6}id:)/)

/** 在一条事件文本里取某个字段（字符串 / 数字）。
 *
 * 取**第一个**匹配 —— 这依赖「事件对象的字段写在最前面，注释与后续逻辑在后」这一结构。
 * 但有个坑：只要任何一条事件的 id 出现在 chunk 里更早的位置（例如某段 JSDoc 里
 * 举例写了 `id: 'foo'`），就会抢到这一条。所以下面额外做一次「块首校验」：
 * 事件块的 `id:` 必须紧跟在开头的 `    {` 之后（允许中间只有空白），
 * 否则说明这一段不是事件定义，直接丢弃。 */
function field(text, name, kind) {
  const re = new RegExp(`\\b${name}:\\s*(${kind === 'num' ? '[0-9_]+' : `'[^']*'`})`)
  const m = re.exec(text)
  if (!m) return null
  return kind === 'num' ? Number(m[1].replace(/_/g, '')) : m[1].slice(1, -1)
}

const rows = []
for (const chunk of chunks) {
  // 事件块必须以 `{` 开头，且第一个字段就是 id —— 不是这样的 chunk 是伪命中。
  const head = chunk.replace(/^\s+/, '')
  if (!head.startsWith('{')) continue
  const firstField = /^\{\s*\n\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(head)
  if (!firstField || firstField[1] !== 'id') continue

  const id = field(chunk, 'id', 'str')
  const title = field(chunk, 'title', 'str')
  const weight = field(chunk, 'weight', 'num')
  if (!id || !title || weight === null) continue
  rows.push({
    id,
    title,
    weight,
    kind: field(chunk, 'kind', 'str') ?? 'agent',
  })
}

if (rows.length === 0) {
  console.error('没有解析到任何事件，检查 buildEvents() 的结构是否变了')
  process.exit(1)
}

const total = rows.reduce((sum, r) => sum + r.weight, 0)

console.log(`${'id'.padEnd(14)} ${'类型'.padEnd(8)} ${'权重'.padEnd(4)} ${'概率'.padEnd(7)} 说明`)
console.log('-'.repeat(72))
for (const r of rows) {
  const pct = ((r.weight / total) * 100).toFixed(1) + '%'
  const kindLabel = r.kind === 'visual' ? '视觉' : 'AI'
  console.log(`${r.id.padEnd(14)} ${kindLabel.padEnd(6)} ${String(r.weight).padEnd(4)} ${pct.padEnd(7)} ${r.title}`)
}
console.log('-'.repeat(72))
console.log(`共 ${rows.length} 个事件，权重合计 ${total}`)

// 视觉类事件（会直接在界面上表演，零 token）：从 kind 字段读，不靠 id 猜。
const visual = rows.filter((r) => r.kind === 'visual')
console.log(`其中带界面表演的（零 token）：${visual.map((r) => r.title).join('、') || '（无）'}`)
