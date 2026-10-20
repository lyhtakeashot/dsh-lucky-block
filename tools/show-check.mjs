/**
 * 「同一时刻只播一场表演」的验证（用户 m18008 第 2 条）。
 *
 * 需求原文：上一个随机事件关闭前不能再点，除非 ESC 提前结束。
 *
 * 这套机制只有一个状态：`showRef`（正在播的表演数）。它出错的方式很少，
 * 但每一种都很难在界面上看出来：
 *   1. 计数漏减 → 方块永久点不动，用户只能重启
 *   2. 计数多减 → 演出还没结束就能再点，音乐和弹窗叠在一起
 *   3. 同一场被减两次 → 两条路同时来报收
 *
 * lib/client.js 是浏览器 bundle，不能 import，所以这里同样用「源码抽取」
 * 跑真代码。除纯函数级断言之外，另外几条是**静态**断言 —— 它们盯的是
 * 「四类表演是不是都接了收场信号」这种接线问题，靠跑是跑不出来的：
 * 漏接一路的表现是「那一类演出结束后方块还锁着」，只能靠真实点击复现。
 *
 * 用法：node tools/show-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ---------- 抽取 beginShow ---------- */

const beginMatch = source.match(/var beginShow = useCallback\(function \(\) \{[\s\S]*?\n    \}, \[\]\)/)
if (!beginMatch) {
  console.error('抽取失败：找不到 beginShow')
  process.exit(1)
}

const body = `
var showRef = { current: 0 }
var useCallback = function (fn) { return fn }
${beginMatch[0]}
return { beginShow: beginShow, showRef: showRef }
`
const api = new Function(body)()

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label} —— 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
  }
}

function checkTrue(label, actual) {
  check(label, actual === true, true)
}

/* ---- 1. 基本增减 ---- */

console.log('-- 开一场、收一场 --')
check('初始没有表演在播', api.showRef.current, 0)
const endA = api.beginShow()
check('开一场后计数是 1', api.showRef.current, 1)
endA()
check('收场后回到 0', api.showRef.current, 0)

/* ---- 2. 重复收场只算一次 ---- */

console.log('-- 同一场不会减两次 --')
const endB1 = api.beginShow()
const endB2 = api.beginShow()
check('两场同时播时计数是 2', api.showRef.current, 2)
endB1()
check('收掉一场还剩 1', api.showRef.current, 1)
endB1()
check('再收一次同一场还剩 1（幂等）', api.showRef.current, 1)
endB2()
check('两场都收完回到 0', api.showRef.current, 0)

/* ---- 3. 不会减成负数 ---- */

console.log('-- 计数不会被减成负数 --')
const endC = api.beginShow()
endC()
endC()
endC()
check('多叫几次仍是 0 而不是负数', api.showRef.current, 0)
checkTrue('计数没有变成负数', api.showRef.current >= 0)

/* ---- 4. 多次往返后仍能归零 ---- */

console.log('-- 反复使用后仍能归零 --')
const ends = []
for (let i = 0; i < 5; i += 1) ends.push(api.beginShow())
check('五场同时播', api.showRef.current, 5)
for (let i = 0; i < ends.length; i += 1) ends[i]()
check('全部收完归零', api.showRef.current, 0)

/* ---- 5. 阻塞判据写对了 ---- */

console.log('-- 点方块时的阻塞判据 --')
checkTrue(
  'onRoll 里有「已有表演就不开新的」的早退',
  /if \(showRef\.current > 0\) \{/.test(source),
)
checkTrue(
  '早退时给出提示而不是静默 return',
  /showRef\.current > 0\) \{\s*\n\s*say\(/.test(source),
)
checkTrue(
  '提示走会自动消失的台词气泡，不是要用户点掉的报错',
  !/showRef\.current > 0\) \{\s*\n\s*setError\(/.test(source),
)
checkTrue(
  '提示里告诉用户可以用 ESC 提前结束',
  /上一场还没收场[\s\S]{0,80}ESC/.test(source),
)

/* ---- 6. 四类表演都接了收场信号（接线断言） ---- */

console.log('-- 四类表演都接了收场信号 --')
checkTrue('蓝屏演出接了收场', /var bluescreenEnd = beginShow\(\)/.test(source))
checkTrue('蓝屏把收场函数传给了 runBluescreen', /runBluescreen\([\s\S]{0,400}bluescreenEnd/.test(source))
checkTrue('弹窗演出接了收场', /var popupsEnd = beginShow\(\)/.test(source))
checkTrue('弹窗把收场函数传给了 runPopupShow', /runPopupShow\([\s\S]{0,200}popupsEnd/.test(source))
checkTrue('音乐接了收场', /var musicEnd = beginShow\(\)/.test(source))
checkTrue('音乐把收场函数传给了 playTrack', /playTrack\(value\.audio\.file, musicEnd\)/.test(source))
checkTrue('没起音轨时立刻收场', /else musicEnd\(\)/.test(source))
checkTrue('居中播报接了收场', /var textEnd = beginShow\(\)/.test(source))
checkTrue('居中播报把收场函数传给了 broadcastText', /broadcastText\(value\.localText, 30000, textEnd\)/.test(source))

/* ---- 7. 每一条收场路径都会叫 onDone ---- */

console.log('-- 每一种收场方式都会解锁 --')
checkTrue(
  '右侧控件（音乐）自然播完会报收场',
  /addEventListener\('ended'/.test(source),
)
checkTrue(
  '音乐被掐断也会报收场',
  /function haltTrack\(\)[\s\S]{0,600}if \(done\) done\(\)/.test(source),
)
checkTrue(
  '播报的定时到点会解锁',
  /window\.setTimeout\(finish,/.test(source),
)
checkTrue(
  '播报被下一段顶掉会解锁',
  /if \(broadcastFinish\.current\) broadcastFinish\.current\(\)/.test(source),
)
checkTrue(
  '点击遮罩走的是同一个收场出口',
  /onClick: function \(\) \{[\s\S]{0,300}broadcastFinish\.current\)/.test(source),
)
checkTrue(
  '蓝屏的 ESC 与定时都走 finish',
  /var unregister = registerEscape\(finish\)[\s\S]{0,400}timer = setTimeout\(finish/.test(source),
)

/* ---- 8. 没有把 isBusy 当表演状态用 ---- */

console.log('-- 表演状态没和请求状态混用 --')
checkTrue(
  'showRef 是 ref 而不是 state（不该触发重渲染）',
  /var showRef = useRef\(0\)/.test(source),
)
checkTrue(
  '阻塞判据读的是 showRef 而不是 isBusy',
  /if \(showRef\.current > 0\)/.test(source),
)

/* ---- 9. 出错路径也要解锁 ---- */

console.log('-- 演出中途抛错不会把方块永久锁死 --')
checkTrue(
  'onRoll 里收集了本轮开出的表演',
  /var begun = \[\]/.test(source),
)
checkTrue(
  '四类表演的收场函数都进了 begun',
  (source.match(/begun\.push\(/g) ?? []).length === 4,
)
checkTrue(
  'catch 分支会放掉它们',
  /catch \(error\) \{[\s\S]{0,300}begun\[bi\]\(\)/.test(source),
)

/* ---- 10. 音乐起不来时也能解锁 ---- */

console.log('-- 音乐起不来时方块不会锁死 --')
checkTrue(
  'spawn 返回 null 时立刻收场',
  /if \(!audio\) \{[\s\S]{0,400}onEnd\(\)/.test(source),
)
checkTrue(
  '名字为空时立刻收场',
  /typeof name !== 'string' \|\| name\.length === 0\) \{[\s\S]{0,120}onEnd\(\)/.test(source),
)
checkTrue(
  '播放失败（error 事件）也报收场',
  /addEventListener\('error'/.test(source),
)

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
} else {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exitCode = 1
}
