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
 * 输出按 **trigger 分池** 分组打印：权重只在同一个池子里比较，
 * 拿全局总权重算出来的概率会误导（单击池 14、长按池 8，两者互不稀释）。
 *
 * 用法：node tools/list-events.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(here, '..', 'lib', 'index.js'), 'utf8')

/* 音频事件按曲目展开（`...audioEvents(audioTracks)`），静态解析看不见它们 ——
   展开发生在运行期，源文件里只有一句 spread。所以这里照抄一份同样的展开规则：
   文件名去扩展名、转小写、加 `audio-` 前缀，权重固定 1、trigger 固定 click。

   判据必须与 lib/index.js 的 audioEvents() **逐字一致**，否则工具打印的清单
   会和运行期对不上：那个函数里不合规的文件名会被 isSafeEventId 挡掉，
   这里也要挡（`.toLowerCase()` 之后仍要过同一个白名单）。 */
function audioTracks() {
  let raw = null
  try {
    raw = readFileSync(path.resolve(here, '..', 'lib', 'audio-tracks.json'), 'utf8')
  } catch {
    return []
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item) => item && typeof item.file === 'string' && /^[A-Za-z0-9_-]+\.(ogg|mp3)$/.test(item.file),
  )
}

// 只扫 buildEvents() 的函数体，避免误抓别处的 id/weight/title 组合。
// 注意它现在是 `async function buildEvents()`，用 indexOf 找 `function buildEvents()`
// 仍然能命中（子串匹配），但别改成带 `^` 锚点的正则。
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
    /* trigger 缺失时**不要**给默认值：那会让「漏写 trigger」这种真 bug
       在工具里被静默补成 hold，而运行期 drawEvent 直接跳过它、
       该事件永远抽不到。宁可打印成 '?' 让漂移一眼可见。 */
    trigger: field(chunk, 'trigger', 'str'),
  })
}

if (rows.length === 0) {
  console.error('没有解析到任何事件，检查 buildEvents() 的结构是否变了')
  process.exit(1)
}

/* 静态解析拿不到 `...audioEvents()` 展开的那几条，在这里补上。 */
for (const track of audioTracks()) {
  const stem = track.file.replace(/\.(ogg|mp3)$/i, '')
  const id = `audio-${stem}`.toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(id) || id.length > 48) continue
  rows.push({
    id,
    title: typeof track.title === 'string' && track.title.trim().length > 0 ? track.title.trim() : track.file,
    weight: 1,
    kind: 'local',
    trigger: 'click',
  })
}

const missingTrigger = rows.filter((r) => !r.trigger)
if (missingTrigger.length > 0) {
  console.error(`有事件没解析到 trigger：${missingTrigger.map((r) => r.id).join('、')}`)
  process.exit(1)
}

/* 三种 kind 的中文标签。
   注意别退化成「不是 visual 就是 AI」——本地文本事件（今日运气 / 冷知识 / 冷笑话）
   同样不调模型，标成 AI 会让文档凭空多出一个不存在的调用。 */
const KIND_LABEL = { agent: 'AI', visual: '视觉', local: '本地' }

/* 按 trigger 分池打印。概率的分母是**本池**权重，不是全局 ——
   否则往单击池加十条音频会显得长按事件「概率变低了」，其实它一点没变。 */
const POOL_LABEL = {
  click: '左键单击（零 token，全部本地）',
  hold: '长按挖满（调用 AI）',
}

/* 列宽跟着最长 id 走：音频事件的 id 是 `audio-<文件名>`，23 字符起步，
   写死 14 会让它们在表格里顶出来把后面的列全挤歪。 */
const ID_WIDTH = Math.max(14, ...rows.map((r) => r.id.length))

for (const pool of ['click', 'hold']) {
  const items = rows.filter((r) => r.trigger === pool)
  if (items.length === 0) {
    console.log(`\n【${POOL_LABEL[pool]}】没有事件 —— drawEvent 抽到这一池会直接报错`)
    continue
  }
  const poolTotal = items.reduce((sum, r) => sum + r.weight, 0)
  console.log(`\n【${POOL_LABEL[pool]}】${items.length} 个事件，权重合计 ${poolTotal}`)
  console.log(`  ${'id'.padEnd(ID_WIDTH)} ${'类型'.padEnd(6)} ${'权重'.padEnd(4)} ${'概率'.padEnd(7)} 说明`)
  console.log('  ' + '-'.repeat(ID_WIDTH + 56))
  for (const r of items) {
    const pct = ((r.weight / poolTotal) * 100).toFixed(1) + '%'
    console.log(
      `  ${r.id.padEnd(ID_WIDTH)} ${(KIND_LABEL[r.kind] ?? r.kind).padEnd(4)} ${String(r.weight).padEnd(4)} ${pct.padEnd(7)} ${r.title}`,
    )
  }
}

console.log(`\n共 ${rows.length} 个事件`)

/* 不建会话、不调模型的事件：从 kind 字段读，不靠 id 猜。 */
const zeroToken = rows.filter((r) => r.kind === 'visual' || r.kind === 'local')
console.log(`其中零 token 的 ${zeroToken.length} 个（不建会话、不调模型）：${zeroToken.map((r) => r.title).join('、') || '（无）'}`)
