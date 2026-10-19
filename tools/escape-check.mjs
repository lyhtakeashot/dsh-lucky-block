/**
 * ESC 统一收尾机制的纯函数级验证。
 *
 * lib/client.js 是浏览器 bundle，不能直接 import，所以这里用「源码抽取」
 * 的办法把 onEscapeKey / registerEscape 及其闭包变量取出来 eval，
 * 保证测的是**真代码**而不是复制品。client.js 一改，测试跟着变，不会漂移。
 *
 * 这套机制最怕三件事，测试就围着它们写：
 *   1. 没有表演在放时还吞 ESC（用户关不掉 dsh 自己的东西）
 *   2. 表演结束了但没注销（那条早死的回调一辈子拦着 ESC）
 *   3. 一次按键执行不了全部登记（后起的挤掉先起的）
 *
 * 用法：node tools/escape-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ---------- 抽取常量与函数 ---------- */

function grab(re, label) {
  const m = source.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[0]
}

const pieces = [
  grab(/var escFinishers = \[\]/, 'escFinishers'),
  grab(/var escBound = false/, 'escBound'),
  grab(/function onEscapeKey\(event\) \{[\s\S]*?\n  \}/, 'onEscapeKey'),
  grab(/function registerEscape\(finisher\) \{[\s\S]*?\n  \}/, 'registerEscape'),
]

// 假 window：只实现 addEventListener，把绑上的监听器记下来。
const listeners = []
const fakeRoot = {
  addEventListener(type, fn, capture) {
    listeners.push({ type, fn, capture })
  },
}

const body = `${pieces.join('\n')}
return {
  onEscapeKey: onEscapeKey,
  registerEscape: registerEscape,
  finisherCount: function () { return escFinishers.length },
}`
const api = new Function('root', body)(fakeRoot)

/* ---------- 断言 ---------- */

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

/** 造一个假的 keydown 事件，记录它有没有被拦。 */
function keyEvent(key) {
  return {
    key,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
  }
}

/** 直接把事件喂给 onEscapeKey（等同于用户按了一次键）。 */
function pressKey(key) {
  const e = keyEvent(key)
  api.onEscapeKey(e)
  return e
}

/* ---- 1. 没有登记时：ESC 必须放行 ---- */

console.log('-- 空表时必须放行（不能吞掉 dsh 自己的 ESC）--')
const emptyEscape = pressKey('Escape')
check('没有登记时不 preventDefault', emptyEscape.prevented, false)
check('没有登记时不 stopPropagation', emptyEscape.stopped, false)
check('registerEscape 尚未调用时没有绑定监听器', listeners.length, 0)

/* ---- 2. 非 ESC 键：永远放行 ---- */

console.log('-- 非 ESC 键一律放行 --')
const calls = []
api.registerEscape(() => calls.push('a'))
check('登记后立即懒绑 keydown', listeners.length, 1)
check('绑定在捕获阶段', listeners[0].capture, true)
check('绑定的是 keydown', listeners[0].type, 'keydown')

for (const key of ['Enter', 'a', ' ', 'EscapeX', 'esc']) {
  const e = pressKey(key)
  check(`按键 ${JSON.stringify(key)} 不拦截`, e.prevented, false)
}
check('非 ESC 键一个回调都没执行', calls.length, 0)
check('非 ESC 键不动登记表', api.finisherCount(), 1)

/* ---- 3. 登记后：ESC 拦截并执行 ---- */

console.log('-- 有登记时 ESC 拦截并执行 --')
const esc1 = pressKey('Escape')
check('ESC 被 preventDefault', esc1.prevented, true)
check('ESC 被 stopPropagation', esc1.stopped, true)
check('回调执行了一次', calls.join(','), 'a')
check('执行后登记表清空', api.finisherCount(), 0)

const esc2 = pressKey('Escape')
check('第二次 ESC 放行（表已空）', esc2.prevented, false)
check('第二次 ESC 不会再执行回调', calls.length, 1)

/* ---- 4. 多个登记：按登记顺序全部执行 ---- */

console.log('-- 多路同时表演时一次收干净 --')
const order = []
api.registerEscape(() => order.push('song'))
api.registerEscape(() => order.push('bluescreen'))
api.registerEscape(() => order.push('broadcast'))
check('三条登记都在表里', api.finisherCount(), 3)
pressKey('Escape')
check('三条全部执行（不是只关最后一个）', order.join(','), 'song,bluescreen,broadcast')
check('执行顺序 = 登记顺序', order.join(','), 'song,bluescreen,broadcast')
check('执行完表清空', api.finisherCount(), 0)

/* ---- 5. 'Esc' 这个别名也认 ---- */

console.log('-- 认 Esc 这个别名 --')
let aliasHit = 0
api.registerEscape(() => (aliasHit += 1))
const escAlias = pressKey('Esc')
check("'Esc' 被拦截", escAlias.prevented, true)
check("'Esc' 触发了回调", aliasHit, 1)

/* ---- 6. 注销之后不再执行 ---- */

console.log('-- 注销后不再执行 --')
let afterUnregister = 0
const unregister = api.registerEscape(() => (afterUnregister += 1))
unregister()
check('注销后表为空', api.finisherCount(), 0)
pressKey('Escape')
check('注销后 ESC 不执行该回调', afterUnregister, 0)

/* ---- 7. 注销是幂等的 ---- */

console.log('-- 注销可以重复调用 --')
let shared = 0
const un1 = api.registerEscape(() => (shared += 1))
const un2 = api.registerEscape(() => (shared += 10))
un1()
un1()
un1()
check('重复注销不会误删别人的登记', api.finisherCount(), 1)
pressKey('Escape')
check('只执行了没注销的那条', shared, 10)

/* ---- 8. 一条回调抛错不影响其它 ---- */

console.log('-- 一条回调抛错不影响其它 --')
const resilient = []
api.registerEscape(() => {
  throw new Error('这条收尾自己炸了')
})
api.registerEscape(() => resilient.push('still-ran'))
pressKey('Escape')
check('抛错之后后面的回调照样执行', resilient.join(','), 'still-ran')
check('抛错也不留残骸', api.finisherCount(), 0)

/* ---- 9. 回调里新登记的不会被同一次按键收掉 ---- */

console.log('-- 回调里新登记的不被同一次按键收掉 --')
let replayRan = 0
api.registerEscape(() => {
  /* 模拟「关掉后又立刻重播」：新登记一条，它该活到下一次 ESC。 */
  api.registerEscape(() => (replayRan += 1))
})
pressKey('Escape')
check('新登记的那条没被同一次按键执行', replayRan, 0)
check('新登记的那条还在表里', api.finisherCount(), 1)
pressKey('Escape')
check('下一次按键才执行它', replayRan, 1)

/* ---- 10. 监听器只绑一次 ---- */

console.log('-- keydown 只绑一次 --')
for (let i = 0; i < 5; i += 1) {
  api.registerEscape(() => {})
}
check('反复登记不会重复绑监听器', listeners.length, 1)

/* ---- 11. 非函数参数不炸 ---- */

console.log('-- 传进来的不是函数也不炸 --')
const noop = api.registerEscape(null)
check('接受非函数参数', typeof noop, 'function')
noop()
check('非函数参数不进表', api.finisherCount(), 5)

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
} else {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exitCode = 1
}
