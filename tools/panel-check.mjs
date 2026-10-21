/**
 * 设置面板「随机事件」分页的纯函数级验证。
 *
 * lib/client.js 是浏览器 bundle，不能直接 import，所以和 snap-check 一样用
 * 「源码抽取 + eval」的办法把 groupEventsForPanel 拿出来跑，保证测的是**真代码**。
 *
 * 这里钉住的是三件容易悄悄坏掉的事：
 *   1. 两个池必须真的分开（长按事件不能漏到单击页，那会让分母算错、占比骗人）；
 *   2. 排序按 defaultWeight，用户改当前权重时行不许跳位；
 *   3. 占比的分母是本池合计，且脏数据（负数 / 字符串 / enabled:false）不能产生 NaN。
 *
 * 用法：node tools/panel-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ---------- 抽取 ---------- */

function grab(re, label) {
  const m = source.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[0]
}

const fnSource = grab(/function groupEventsForPanel\([\s\S]*?\n  \}/, 'groupEventsForPanel')
const groupEventsForPanel = new Function(`${fnSource}\nreturn groupEventsForPanel`)()

/* ---------- 断言 ---------- */

let pass = 0
let fail = 0
const failures = []

function checkTrue(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? `（${detail}）` : ''))
    console.log(`FAIL ${label}${detail ? `（${detail}）` : ''}`)
  }
}

function checkEqual(label, actual, expected) {
  checkTrue(label, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function checkClose(label, actual, expected, tol = 1e-9) {
  checkTrue(label, Math.abs(actual - expected) <= tol, `实际 ${actual}，期望 ${expected}`)
}

function ids(rows) {
  return rows.map(r => r.id)
}

/* 一份有代表性的清单：4 个单击 + 2 个长按，权重故意带并列。 */
const EVENTS = [
  { id: 'popups', title: '无害弹窗表演', trigger: 'click', weight: 11, defaultWeight: 11 },
  { id: 'fortune', title: '虚拟运势', trigger: 'click', weight: 18, defaultWeight: 18 },
  { id: 'hold-ai', title: 'AI 吐槽', trigger: 'hold', weight: 4, defaultWeight: 4 },
  { id: 'bluescreen', title: '蓝屏屏保（60 秒）', trigger: 'click', weight: 11, defaultWeight: 11 },
  { id: 'blackout', title: '停电了（8 秒）', trigger: 'click', weight: 4, defaultWeight: 4 },
  { id: 'hold-look', title: '仔细看看你', trigger: 'hold', weight: 3, defaultWeight: 3 },
]

/* ---- 1. 拆分 ---- */

const g = groupEventsForPanel(EVENTS, {})

checkEqual('单击页只收单击事件（4 行）', g.click.rows.length, 4)
checkEqual('长按页只收长按事件（2 行）', g.hold.rows.length, 2)
checkEqual(
  '长按事件一个都不许漏到单击页',
  ids(g.click.rows).filter(id => id.startsWith('hold-')).length,
  0,
)
checkEqual(
  '单击事件一个都不许漏到长按页',
  ids(g.hold.rows).filter(id => !id.startsWith('hold-')).length,
  0,
)
checkEqual('两个池加起来不漏行', g.click.rows.length + g.hold.rows.length, EVENTS.length)

/* ---- 2. 排序 ---- */

checkEqual(
  '单击页按 defaultWeight 降序（并列按 id 稳定）',
  ids(g.click.rows).join(','),
  'fortune,bluescreen,popups,blackout',
)
checkEqual('长按页按 defaultWeight 降序', ids(g.hold.rows).join(','), 'hold-ai,hold-look')

/* 改当前权重不许让行跳位 —— 正在编辑的那一行从手指底下跑掉是最难受的。 */
const edited = groupEventsForPanel(EVENTS, { fortune: { weight: 1 } })
checkEqual(
  '把 fortune 的权重改成 1，它仍然排在第一行',
  edited.click.rows[0].id,
  'fortune',
)
checkEqual('改权重不改变排序：整页顺序一致', ids(edited.click.rows).join(','), ids(g.click.rows).join(','))

/* ---- 3. 占比 ---- */

checkEqual('单击页合计只算单击池（18+11+11+4）', g.click.total, 44)
checkEqual('长按页合计只算长按池（4+3）', g.hold.total, 7)
checkClose('fortune 占本池 18/44', g.click.rows[0].share, (18 / 44) * 100)
checkClose('长按页第一行占 4/7', g.hold.rows[0].share, (4 / 7) * 100)
checkClose(
  '单击页占比合计 100',
  g.click.rows.reduce((s, r) => s + r.share, 0),
  100,
  1e-9,
)
checkTrue(
  '每一行都有 share 字段（渲染时直接 toFixed）',
  g.click.rows.every(r => Number.isFinite(r.share)),
)

/* 编辑后占比按**当前**权重算：fortune 从 18 掉到 1，合计变成 27。 */
checkEqual('改权重后合计跟着变（1+11+11+4）', edited.click.total, 27)
checkClose('改权重后占比用新分母', edited.click.rows[0].share, (1 / 27) * 100)

/* ---- 4. 脏数据 ---- */

const off = groupEventsForPanel(EVENTS, { blackout: { enabled: false } })
const offRow = off.click.rows.find(r => r.id === 'blackout')
checkTrue('enabled:false 仍然留在列表里（不是被删掉）', Boolean(offRow))
checkEqual('enabled:false 的权重折成 0', offRow.weight, 0)
checkEqual('enabled:false 的占比是 0', offRow.share, 0)
checkEqual('enabled:false 的行 enabled=false', offRow.enabled, false)
checkEqual('enabled:false 后合计扣掉那 4 份', off.click.total, 40)

const bothOff = groupEventsForPanel(EVENTS, { blackout: { enabled: false, weight: 9 } })
checkEqual(
  'enabled:false 时 override.weight 也留不住它（两个字段说同一件事）',
  bothOff.click.rows.find(r => r.id === 'blackout').weight,
  0,
)

const negative = groupEventsForPanel(EVENTS, { popups: { weight: -3 } })
checkEqual('负权重夹到 0，不产生负数占比', negative.click.rows.find(r => r.id === 'popups').weight, 0)

const asString = groupEventsForPanel(EVENTS, { popups: { weight: '7' } })
checkEqual(
  '字符串权重被忽略，回落到 defaultWeight',
  asString.click.rows.find(r => r.id === 'popups').weight,
  11,
)

const zeroTotal = groupEventsForPanel(
  [{ id: 'a', title: 'A', trigger: 'click', weight: 0, defaultWeight: 0 }],
  {},
)
checkTrue(
  '合计为 0 时占比是 0 而不是 NaN（0/0 的坑）',
  Number.isFinite(zeroTotal.click.rows[0].share) && zeroTotal.click.rows[0].share === 0,
)

const weird = groupEventsForPanel([{ id: 'w', title: 'W', trigger: 'weird', weight: 2 }], {})
checkEqual('未知 trigger 归到单击页（宁可多一行，不要一行消失）', weird.click.rows.length, 1)

const noId = groupEventsForPanel([{ title: '没有 id', trigger: 'click', weight: 5 }, ...EVENTS], {})
checkEqual('缺 id 的行被跳过，不炸', noId.click.rows.length + noId.hold.rows.length, EVENTS.length)

const noDefault = groupEventsForPanel([{ id: 'nd', title: 'ND', trigger: 'click', weight: 6 }], {})
checkEqual('缺 defaultWeight 时用当前权重排序，不产出 NaN', noDefault.click.rows[0].sort, 6)

/* ---- 5. 面板确实用上了它 ---- */

checkTrue(
  '面板调用了 groupEventsForPanel(settingsOpen.events, settingsOpen.eventOverrides)',
  /groupEventsForPanel\(settingsOpen\.events, settingsOpen\.eventOverrides\)/.test(source),
)
checkTrue(
  '分页标签存在（单击池 / 长按池）',
  /panelTab\(t\('单击池'/.test(source) && /panelTab\(t\('长按池'/.test(source),
)
checkTrue('分页状态存在 settingsOpen.eventTab 上', /settingsOpen\.eventTab === 'hold'/.test(source))
checkTrue(
  '旧的混排列表已经删掉（同一个列表不可能既分页又平铺）',
  !/\(settingsOpen\.events \|\| \[\]\)\.map\(function \(item\) \{/.test(source),
)

/* ---- 6. 分组必须把所有子行都渲染出来 ---- */
/* 这一节是补的窟窿：panelGroup 早先只收第二个参数，而「方块外观」那一组
   是把每行摊成参数写的 —— 结果是那一组只显示「大小」，形状/圆角/描边/…
   全被静默吃掉。静态断言看不出这种问题（源码里每一行都在），
   只有真跑一遍、数孩子个数才会红。 */

const panelGroupSource = grab(/function panelGroup\(title\) \{[\s\S]*?\n  \}/, 'panelGroup')
const panelGroup = new Function(
  'h',
  `${panelGroupSource}\nreturn panelGroup`,
)(function () {
  const args = Array.prototype.slice.call(arguments)
  return { tag: args[0], props: args[1] || {}, children: args.slice(2) }
})

const variadic = panelGroup('T', 'a', 'b')
checkEqual('摊成参数的子行全部渲染（不是只留第一个）', variadic.children.length, 3)
checkEqual('摊成参数时顺序不变', variadic.children.slice(1).join(','), 'a,b')

const asArray = panelGroup('T', ['a', 'b'])
checkEqual('装进数组的子行同样全部渲染', asArray.children.length, 3)

const mixed = panelGroup('T', 'a', ['b', 'c'])
checkEqual('参数与数组混写时按顺序摊平', mixed.children.slice(1).join(','), 'a,b,c')

const withHoles = panelGroup('T', null, false, 'x')
checkEqual('null / false 被跳过，不占位', withHoles.children.slice(1).join(','), 'x')

checkTrue('分组标题始终是第一个孩子', variadic.children[0] && variadic.children[0].tag === 'div')
checkTrue('分组容器是 div', variadic.tag === 'div')

checkTrue(
  'panelGroup 定义收多个参数（用 arguments.length 遍历）',
  /function panelGroup\(title\) \{[\s\S]*arguments\.length/.test(source),
)
checkTrue(
  '「方块外观」组里形状行紧跟大小行（这一组就是靠参数摊开写的）',
  /panelRow\(t\('大小'[\s\S]{0,600}panelRow\(t\('形状'/.test(source),
)
checkTrue(
  '面板里有四个分组（外观 / 缩放幅度 / 随机事件 / 扩展接口）',
  (source.match(/panelGroup\(\s*\n?\s*t\('(方块外观|整页缩放幅度|随机事件|扩展接口)'/g) || []).length === 4,
)

/* ---------- 汇总 ---------- */

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
  process.exit(0)
}
console.log(`FAILED  pass=${pass} fail=${fail}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)