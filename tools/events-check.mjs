/**
 * 事件权重 / 开关覆盖层 + 第三方事件扩展的形状校验。
 *
 * lib/index.js 是宿主 bundle、跑在 cordis 里（要 ctx、要读真文件），
 * 不能直接 import，所以这里用「源码抽取」的办法把纯函数取出来 eval，
 * 保证测的是**真代码**而不是复制品。index.js 一改，这个测试就跟着变。
 *
 * 这条覆盖层是用户唯一能动的事件入口，写坏一次的表现是
 * 「我明明调成 0 了怎么还在抽」—— 没有任何日志、没有任何报错，
 * 所以形状规则必须被单测钉死。
 *
 * 用法：node tools/events-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.resolve(here, '..', 'lib', 'index.js'), 'utf8')

/**
 * 从源码里抠出一个「以函数头开头、大括号配平」的片段。
 *
 * 为什么不用正则：这些函数里有嵌套的 `for` / `if` 块，它们的收尾 `}`
 * 和函数自己的收尾 `}` **缩进完全相同**（都是两空格）。用
 * `/function xxx\([\s\S]*?\n  \}/` 会停在第一个两空格 `}` 上 ——
 * 也就是 for 块的尾巴，抠出来的只含函数前半段。测试照样能跑，
 * 于是测的是半截代码，还一路绿灯。
 *
 * 改成从函数头往后数大括号：深度归零处就是函数的真收尾，与缩进无关。
 * （字符串和注释里的花括号在这个文件里都是配平的，不影响计数。）
 */
function grabBlock(source, header, label) {
  const start = source.indexOf(header)
  if (start < 0) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  console.error(`抽取失败：${label} 的大括号没有配平`)
  process.exit(1)
}

const pieces = [
  grabBlock(source, 'const EVENT_OVERRIDE_LIMITS', 'EVENT_OVERRIDE_LIMITS'),
  grabBlock(source, 'function clampWeight(', 'clampWeight'),
  grabBlock(source, 'function isSafeEventId(', 'isSafeEventId'),
  grabBlock(source, 'function eventOverrideSafe(', 'eventOverrideSafe'),
  grabBlock(source, 'function applyEventOverrides(', 'applyEventOverrides'),
  grabBlock(source, 'function validateCustomEvent(', 'validateCustomEvent'),
]

/* 抽取完先自检：任何一个片段被截断（丢了收尾 `}`）都会在这里炸，
   而不是等到断言阶段输出一堆看不懂的 FAIL。 */
for (const piece of pieces) {
  const opens = (piece.match(/\{/g) || []).length
  const closes = (piece.match(/\}/g) || []).length
  if (opens !== closes) {
    console.error(`抽取失败：大括号不配平（${opens} 个 { 对 ${closes} 个 }）\n${piece}`)
    process.exit(1)
  }
  /* 每段单独过一次解析器：语法错就在这里报，不会拖到 new Function 那一行。 */
  try {
    new Function(piece)
  } catch (error) {
    console.error(`抽取失败：${piece.split('(')[0]} 解析不过：${String(error)}`)
    process.exit(1)
  }
}

const body = `${pieces.join('\n')}\nreturn {
  EVENT_OVERRIDE_LIMITS, clampWeight, isSafeEventId,
  eventOverrideSafe, applyEventOverrides, validateCustomEvent,
}`
const api = new Function(body)()

let pass = 0
let fail = 0
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望 ${JSON.stringify(expected)}`)
    console.log(`        实际 ${JSON.stringify(got)}`)
  }
}

console.log('— eventOverrideSafe：读与写同一套规则 —')
check('空输入 → {}', api.eventOverrideSafe(null), {})
check('数组不是对象 → {}', api.eventOverrideSafe([]), {})
check('纯 weight', api.eventOverrideSafe({ joke: { weight: 7 } }), { joke: { weight: 7 } })
check('纯 enabled', api.eventOverrideSafe({ joke: { enabled: false } }), { joke: { enabled: false } })
/* JSON.stringify 的 key 顺序由**源对象**决定，所以期望值写成源顺序。 */
check('两个字段都留', api.eventOverrideSafe({ joke: { weight: 4, enabled: true } }), { joke: { enabled: true, weight: 4 } })
check('enabled 非布尔丢掉', api.eventOverrideSafe({ joke: { enabled: 'no' } }), {})
/* weight 写坏成非数字时**保留**、回落成 1：语义是「我想改权重」，
   此时给一个可用的数比把整条覆盖删掉更好（删掉等于用户以为改成功了）。 */
check('weight 非数 → 回落 1 并保留', api.eventOverrideSafe({ joke: { weight: 'abc' } }), { joke: { weight: 1 } })
/* weight: 0 是合法值，语义是「关掉这条事件」（applyEventOverrides 认）。 */
check('weight = 0 保留（= 关掉）', api.eventOverrideSafe({ joke: { weight: 0 } }), { joke: { weight: 0 } })
/* 负数夹到 0 —— 不是异常，是「关掉」。 */
check('weight 负值夹到 0', api.eventOverrideSafe({ joke: { weight: -5 } }), { joke: { weight: 0 } })
check('weight 超大夹到上限', api.eventOverrideSafe({ joke: { weight: 9999 } }), {
  joke: { weight: api.EVENT_OVERRIDE_LIMITS.weight[1] },
})
check('小数四舍五入', api.eventOverrideSafe({ joke: { weight: 3.6 } }), { joke: { weight: 4 } })
check('空 patch 丢掉', api.eventOverrideSafe({ joke: {} }), {})
check('patch 不是对象丢掉', api.eventOverrideSafe({ joke: 'nope' }), {})
/* 未知 id 这里**不**判：一个 patch 看不出 id 在不在当前池子里（池子随语料、
   第三方事件变化）。过滤发生在 applyEventOverrides（点不中的 id 被忽略）。 */
check('未知 id 此处不判（由 applyEventOverrides 过滤）', api.eventOverrideSafe({ nope: { weight: 3 } }), { nope: { weight: 3 } })
/* `__proto__` 在对象字面量里是设原型、不产生自有键，所以它压根不会出现。
   `constructor` 形状合法所以留着了 —— 无害：applyEventOverrides 只按内置
   事件的 id 去读，池子里没有叫 constructor 的事件。 */
check('注入用的 key 原样留下（读取侧按 id 查，无副作用）', api.eventOverrideSafe({
  constructor: { weight: 3 },
}), { constructor: { weight: 3 } })
check('大小写 / 下划线不合规丢掉', api.eventOverrideSafe({ Joke: { weight: 3 }, my_event: { weight: 3 } }), {})
check('横杠合法', api.eventOverrideSafe({ 'todo-shuffle': { weight: 3 } }), { 'todo-shuffle': { weight: 3 } })
check('尾部多余字段忽略', api.eventOverrideSafe({ joke: { weight: 2, note: 'x' } }), { joke: { weight: 2 } })

console.log('')
console.log('— isSafeEventId —')
check('joke 合法', api.isSafeEventId('joke'), true)
check('todo-shuffle 合法', api.isSafeEventId('todo-shuffle'), true)
check('空串不合法', api.isSafeEventId(''), false)
check('非字符串不合法', api.isSafeEventId(42), false)
check('超长不合法', api.isSafeEventId('a'.repeat(49)), false)
check('48 字符正好合法', api.isSafeEventId('a'.repeat(48)), true)
check('大写不合法', api.isSafeEventId('Joke'), false)
check('下划线不合法', api.isSafeEventId('my_event'), false)
check('开头横杠不合法', api.isSafeEventId('-joke'), false)
check('斜杠不合法（路径穿越）', api.isSafeEventId('../etc'), false)

console.log('')
console.log('— clampWeight —')
/* 注意 fallback 的语义：它是「事件本来的权重」，**不是下限**。
   用户显式写 0 / 负数表达的是「关掉」，不能被悄悄抬成 1 —— 那样用户会看到
   一条关了却还在抽的事件。下限只由 EVENT_OVERRIDE_LIMITS.weight[0] 保证。 */
check('正常值原样', api.clampWeight(3, 1), 3)
check('0 就是 0（写 0 是想关掉）', api.clampWeight(0, 1), 0)
check('负数夹到下限 0', api.clampWeight(-4, 5), 0)
check('NaN 抬到 fallback', api.clampWeight(NaN, 2), 2)
check('字符串数字认得出来', api.clampWeight('6', 1), 6)
check('非数字字符串走 fallback', api.clampWeight('abc', 7), 7)
/* `Number(null)` 是 0 —— 这是 JS 的坑，不是 fallback 不生效。
   真实路径上 null/undefined 会被 `patch.weight !== undefined` 挡在 clampWeight 之前
   （eventOverrideSafe），所以这里断言的是「即便漏过来也只是当 0」，不是 fallback。 */
check('null 走 Number(null)=0 这条路', api.clampWeight(null, 4), 0)
check('undefined 走 NaN → fallback', api.clampWeight(undefined, 4), 4)
check('小数四舍五入', api.clampWeight(3.4, 1), 3)
check('.5 取远离零侧', api.clampWeight(3.5, 1), 4)
check('超大夹到上限', api.clampWeight(1e9, 1), api.EVENT_OVERRIDE_LIMITS.weight[1])

console.log('')
console.log('— applyEventOverrides：覆盖层是最后一道，必须能整条摘掉事件 —')
const base = [{ id: 'a', weight: 2 }, { id: 'b', weight: 3 }, { id: 'c', weight: 4 }]
check('没有覆盖 → 原样', api.applyEventOverrides(base, {}), base)
check('只改权重 → 就地替换', api.applyEventOverrides(base, { b: { weight: 9 } }), [
  { id: 'a', weight: 2 },
  { id: 'b', weight: 9 },
  { id: 'c', weight: 4 },
])
check('enabled:false → 整条摘掉', api.applyEventOverrides(base, { b: { enabled: false } }), [
  { id: 'a', weight: 2 },
  { id: 'c', weight: 4 },
])
check('weight 0 → 整条摘掉', api.applyEventOverrides(base, { b: { weight: 0 } }), [
  { id: 'a', weight: 2 },
  { id: 'c', weight: 4 },
])
check('两个都被关掉', api.applyEventOverrides(base, { a: { enabled: false }, c: { enabled: false } }), [
  { id: 'b', weight: 3 },
])
check('全关掉 → 空池', api.applyEventOverrides(base, {
  a: { weight: 0 },
  b: { weight: 0 },
  c: { weight: 0 },
}), [])
check('enabled:true 不动权重', api.applyEventOverrides(base, { b: { enabled: true } }), base)
check('覆盖层含多余字段不影响', api.applyEventOverrides(base, { b: { weight: 1, note: 'x' } }), [
  { id: 'a', weight: 2 },
  { id: 'b', weight: 1 },
  { id: 'c', weight: 4 },
])
check('覆盖层里点不中的 id 被忽略', api.applyEventOverrides(base, { zzz: { weight: 9 } }), base)
/* 原数组不能被就地改：buildEvents 里 built 后面还要 concat 第三方事件。 */
const original = [{ id: 'a', weight: 2 }]
api.applyEventOverrides(original, { a: { weight: 8 } })
check('不就地改入参', original, [{ id: 'a', weight: 2 }])

console.log('')
console.log('— validateCustomEvent：写坏一条就整份忽略，所以错误信息要能指到具体那条 —')
function expectError(name, item, fragment) {
  const msg = api.validateCustomEvent(item, 0)
  const ok = typeof msg === 'string' && msg.includes(fragment)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望含 "${fragment}"，实际 ${JSON.stringify(msg)}`)
  }
}
function expectOk(name, item) {
  const msg = api.validateCustomEvent(item, 0)
  if (msg === null) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望通过，实际报 ${JSON.stringify(msg)}`)
  }
}

expectOk('最小 local 事件', {
  id: 'my-event',
  trigger: 'click',
  kind: 'local',
  title: '我的事件',
  lines: ['一句话'],
})
expectOk('最小 agent 事件', {
  id: 'my-event',
  trigger: 'hold',
  kind: 'agent',
  title: '我的事件',
  prompt: '做点什么',
})
expectOk('带了 weight 和 visual 也放行', {
  id: 'my-event',
  trigger: 'click',
  kind: 'local',
  title: '我的事件',
  lines: ['a'],
  weight: 4,
  visual: { kind: 'popups', count: 3 },
})
expectError('id 空', { id: '', trigger: 'click', kind: 'local', title: 'x', lines: ['a'] }, 'id 只能')
expectError('id 有大写', { id: 'Bad', trigger: 'click', kind: 'local', title: 'x', lines: ['a'] }, 'id 只能')
expectError('id 过长', { id: 'a'.repeat(49), trigger: 'click', kind: 'local', title: 'x', lines: ['a'] }, 'id 只能')
expectError('trigger 拼错', { id: 'x', trigger: 'touch', kind: 'local', title: 'x', lines: ['a'] }, 'trigger 只能')
expectError('kind 缺失', { id: 'x', trigger: 'click', title: 'x', lines: ['a'] }, 'kind 只能')
expectError('kind 是 visual（本插件不开放）', { id: 'x', trigger: 'click', kind: 'visual', title: 'x' }, 'kind 只能')
expectError('title 空', { id: 'x', trigger: 'click', kind: 'local', title: '  ', lines: ['a'] }, 'title 不能为空')
expectError('title 缺失', { id: 'x', trigger: 'click', kind: 'local', lines: ['a'] }, 'title 不能为空')
expectError('local 缺 lines', { id: 'x', trigger: 'click', kind: 'local', title: 'x' }, 'lines')
expectError('local 的 lines 有空行', { id: 'x', trigger: 'click', kind: 'local', title: 'x', lines: [''] }, 'lines')
expectError('local 的 lines 太多', {
  id: 'x',
  trigger: 'click',
  kind: 'local',
  title: 'x',
  lines: new Array(201).fill('a'),
}, 'lines 最多')
expectError('agent 缺 prompt', { id: 'x', trigger: 'hold', kind: 'agent', title: 'x' }, 'prompt')
expectError('agent 的 prompt 空', { id: 'x', trigger: 'hold', kind: 'agent', title: 'x', prompt: ' ' }, 'prompt')
expectError('agent 的 prompt 太长', { id: 'x', trigger: 'hold', kind: 'agent', title: 'x', prompt: 'a'.repeat(4001) }, 'prompt 最长')
expectError('weight 为负', { id: 'x', trigger: 'click', kind: 'local', title: 'x', lines: ['a'], weight: -1 }, 'weight 必须是正数')
/* 字符串 '3' 也会被 Number() 接受。这里**放行**（Number.isFinite('3'→3) 且 > 0），
   因为 buildEvents 那边最终会 clampWeight 掉。刻意留一条 expectOk 记录这个决定：
   第三方文件是人手写的 JSON，为「3」和 3 区别对待只会让报错信息更难懂。 */
expectOk('weight 写成字符串数字放行', {
  id: 'x',
  trigger: 'click',
  kind: 'local',
  title: 'x',
  lines: ['a'],
  weight: '3',
})
expectError('weight 是非数字字符串', { id: 'x', trigger: 'click', kind: 'local', title: 'x', lines: ['a'], weight: 'abc' }, 'weight 必须是正数')
expectError('visual 不是对象', { id: 'x', trigger: 'click', kind: 'local', title: 'x', lines: ['a'], visual: 'popups' }, 'visual 必须是对象')
/* 200 条正好放行：边界值写错方向（<变成<=）不会有人发现。 */
expectOk('local 的 lines 正好 200 条', {
  id: 'x',
  trigger: 'click',
  kind: 'local',
  title: 'x',
  lines: new Array(200).fill('a'),
})

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
