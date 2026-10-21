/**
 * 动效的「真跑一遍」验证：停电 / 假警报 / 掀桌（m00160 加的第四到第六个动效）。
 *
 * `show-check.mjs` 只做源码级接线断言（正则），它能证明「收场函数被传进去了」，
 * 但证不了「runBlackout 一跑起来不会炸」—— 变量名写错、`this` 用错、
 * 定时器忘了进数组，正则全都看不出来。这里用最小假 DOM + 假定时器
 * 把三个函数**真的执行一遍**，再按时间线推到每一个检查点。
 *
 * 和 `escape-check.mjs` / `snap-check.mjs` 一样：从 `lib/client.js` 抽源码 eval，
 * 测的是真代码，不是复制品。
 *
 * 这套东西最容易骗过测试的三件事，断言就围着它们写：
 *   1. 屏幕上看着对了，但收场时没把层删掉（DOM 里悄悄攒垃圾）
 *   2. 收场了却漏了 `unregister()`（那条早死的回调一辈子吞 ESC）
 *   3. 定时器没进数组（`finish()` 只 clearTimeout 数组里的 —— 漏的那个
 *      会在表演结束 5 秒后又往一个已经不在屏幕上的元素上写字）
 *
 * 用法：node tools/visual-run-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

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

function checkTrue(label, value) {
  check(label, Boolean(value), true)
}

/* ---------- 从 lib/client.js 抽源码 ---------- */

function grab(re, label) {
  const m = source.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}（这里的前提假设变了，先看 show-check 还在不在用同样的正则）`)
    process.exit(1)
  }
  return m[0]
}

const pieces = [
  grab(/var escFinishers = \[\]/, 'escFinishers'),
  grab(/var escBound = false/, 'escBound'),
  /* `t()` 不抽源码：它要连着 locale 服务（`lookupService` / `rootCtx` / `NS`）
     才能跑，而这三个动效对 i18n 的唯一要求就是「有话说时用中文」。
     用注入的假 `t`（原样返回中文）更接近它们真正依赖的那一点。 */
  grab(/function onEscapeKey\(event\) \{[\s\S]*?\n  \}/, 'onEscapeKey'),
  grab(/function registerEscape\(finisher\) \{[\s\S]*?\n  \}/, 'registerEscape'),
  grab(/function runBlackout\(durationMs, onDone\) \{[\s\S]*?\n  \}/, 'runBlackout'),
  grab(/function runFalseAlarm\(visual, onDone\) \{[\s\S]*?\n  \}/, 'runFalseAlarm'),
  grab(/function runTableFlip\(visual, onDone\) \{[\s\S]*?\n  \}/, 'runTableFlip'),
]

/* ---------- 假 DOM：只实现这三个函数用到的那一小块 ---------- */

function makeEl(tag) {
  const classes = new Set()
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    attrs: {},
  }
  el.style = {
    setProperty(name, value) {
      el.style[name] = value
    },
    removeProperty(name) {
      delete el.style[name]
    },
  }
  /* `cssText` 必须**真的解析**成一条条属性。代码是先整块写 `style.cssText = '...'`
     再单独改某一项的（`layer.style.opacity = '1'`），如果这里只是存一个字符串，
     那条 `opacity` 就永远读回 undefined —— 测试会在「实现完全正确」时报错。 */
  let cssTextRaw = ''
  Object.defineProperty(el.style, 'cssText', {
    get() {
      return cssTextRaw
    },
    set(value) {
      cssTextRaw = String(value || '')
      cssTextRaw.split(';').forEach((decl) => {
        const cut = decl.indexOf(':')
        if (cut <= 0) return
        const name = decl.slice(0, cut).trim()
        const val = decl.slice(cut + 1).trim()
        if (!name) return
        el.style[name] = val
        const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        if (camel !== name) el.style[camel] = val
      })
    },
  })
  el.classList = {
    add() {
      for (let i = 0; i < arguments.length; i += 1) classes.add(arguments[i])
    },
    remove() {
      for (let i = 0; i < arguments.length; i += 1) classes.delete(arguments[i])
    },
    contains(name) {
      return classes.has(name)
    },
    toggle(name) {
      if (classes.has(name)) classes.delete(name)
      else classes.add(name)
    },
  }
  /* className 与 classList 必须看到同一份数据 —— 代码里两种写法混用
     （`banner.className = '...'` 起手、之后 `classList.add/remove`），
     各管各的就会测出一个不存在的 bug（或者漏掉一个真的）。 */
  Object.defineProperty(el, 'className', {
    get() {
      return Array.from(classes).join(' ')
    },
    set(value) {
      classes.clear()
      String(value || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name))
    },
  })
  el.appendChild = (child) => {
    child.parentNode = el
    el.children.push(child)
    return child
  }
  el.removeChild = (child) => {
    const i = el.children.indexOf(child)
    if (i >= 0) el.children.splice(i, 1)
    child.parentNode = null
    return child
  }
  el.setAttribute = (name, value) => {
    el.attrs[name] = value
  }
  el.addEventListener = () => {}
  el.removeEventListener = () => {}
  return el
}

function makeDocument() {
  return {
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

/* ---------- 假定时器：能按时间线推进，也能问「还剩几个没跑」 ---------- */

function makeClock() {
  let now = 0
  let seq = 0
  const queue = []
  return {
    setTimeout(fn, ms) {
      seq += 1
      queue.push({ id: seq, at: now + Math.max(0, Number(ms) || 0), fn })
      return seq
    },
    clearTimeout(id) {
      const i = queue.findIndex((item) => item.id === id)
      if (i >= 0) queue.splice(i, 1)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let next = null
        for (const item of queue) {
          if (item.at <= target && (next === null || item.at < next.at)) next = item
        }
        if (next === null) break
        queue.splice(queue.indexOf(next), 1)
        now = next.at
        next.fn()
      }
      now = target
    },
    pending() {
      return queue.length
    },
  }
}

/** 一个独立的「一次表演」环境：自己的 document / 定时器 / ESC 登记表。 */
function session() {
  const document = makeDocument()
  const clock = makeClock()
  const body = `${pieces.join('\n')}
return {
  runBlackout: runBlackout,
  runFalseAlarm: runFalseAlarm,
  runTableFlip: runTableFlip,
  pressEscape: function () {
    onEscapeKey({ key: 'Escape', preventDefault: function () {}, stopPropagation: function () {} })
  },
  finisherCount: function () { return escFinishers.length },
}`
  const root = { addEventListener: () => {}, removeEventListener: () => {} }
  const api = new Function('root', 'document', 'window', 't', body)(
    root,
    document,
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    (zh) => zh,
  )
  return { api, document, clock }
}

const layerOf = (document) => document.body.children[document.body.children.length - 1]

/* ================= 1. 停电 ================= */

console.log('— 停电 —')
{
  const { api, document, clock } = session()
  let done = 0
  api.runBlackout(8000, () => {
    done += 1
  })

  check('盖了一层全屏', document.body.children.length, 1)
  const layer = layerOf(document)
  checkTrue('z-index 是 100004（在方块 100010 之下，所以方块还亮着）', /z-index:100004/.test(layer.style.cssText))
  checkTrue('吃掉点击（看不见的界面上不该能点到东西）', /pointer-events:auto/.test(layer.style.cssText))
  check('起手是透明的（否则黑屏成了硬闪）', layer.style.opacity, '0')

  clock.advance(30)
  check('30ms 后推到不透明', layer.style.opacity, '1')

  clock.advance(8000 - 560 - 30)
  checkTrue('最后 560ms 交给闪回动画', layer.classList.contains('dsh-lucky-blackout-out'))
  check('闪回把过渡关掉（动画优先，混着会打架）', layer.style.transition, 'none')

  clock.advance(560)
  check('自然结束：层被删干净', document.body.children.length, 0)
  check('自然结束：onDone 只响一次', done, 1)
  check('自然结束：ESC 登记表清空', api.finisherCount(), 0)
  check('自然结束：没有残留定时器', clock.pending(), 0)
}

/* ================= 2. 假警报 ================= */

console.log('— 假警报 —')
{
  const { api, document, clock } = session()
  let done = 0
  api.runFalseAlarm(
    { durationMs: 5200, suspenseMs: 2600, suspense: '甲', payoff: '乙' },
    () => {
      done += 1
    },
  )

  const layer = document.body.children[0]
  checkTrue('不挡点击（它是一条通知，不是一堵墙）', /pointer-events:none/.test(layer.style.cssText))
  const banner = layer.children[0]
  const dot = banner.children[0]
  const text = banner.children[1]
  check('第一句是悬念', text.textContent, '甲')
  checkTrue('圆点在跳（没有它就是「加载失败」的样子）', /dshLuckyAlarmDot/.test(dot.style.cssText))
  checkTrue('起手挂入场动画', banner.classList.contains('dsh-lucky-alarm-in'))

  clock.advance(2599)
  check('悬念段没到点就还不能换词', text.textContent, '甲')

  clock.advance(1)
  check('到点换成「没有东西」', text.textContent, '乙')
  check('圆点停下', dot.style.animation, 'none')
  check('圆点变灰', dot.style.background, 'rgba(255,255,255,.32)')
  check('左边框一起泄气', banner.style.borderLeftColor, 'rgba(255,255,255,.32)')
  checkTrue('入场类换成收场类', banner.classList.contains('dsh-lucky-alarm-payoff'))
  check('入场类确实摘掉了（不摘会两条动画叠着）', banner.classList.contains('dsh-lucky-alarm-in'), false)

  clock.advance(5200 - 240 - 2600)
  check('淡出前先摘动画类（`both` 会盖过内联 opacity）', banner.classList.contains('dsh-lucky-alarm-payoff'), false)
  check('然后才置透明', banner.style.opacity, '0')

  clock.advance(240)
  check('收场：层被删干净', document.body.children.length, 0)
  check('收场：onDone 只响一次', done, 1)
  check('收场：没有残留定时器', clock.pending(), 0)
}

/* ================= 3. 掀桌 ================= */

console.log('— 掀桌 —')
{
  const { api, document, clock } = session()
  let done = 0
  api.runTableFlip({ durationMs: 4800, flip: 'A', unflip: 'B' }, () => {
    done += 1
  })

  const layer = document.body.children[0]
  const box = layer.children[0]
  const flipNode = box.children[0]
  const unflipNode = box.children[1]
  checkTrue('不转整个页面（只在自家这一层里动，body 一个字都不碰）', /z-index:100004/.test(layer.style.cssText))
  checkTrue('盒子高度是 0（换脸时不撑高容器，字幕才不会跳）', /height:0/.test(box.style.cssText))
  check('第一张脸是掀', flipNode.textContent, 'A')
  check('第二张脸先藏着', unflipNode.style.opacity, '0')
  checkTrue('第一张脸挂入场动画', flipNode.classList.contains('dsh-lucky-flip-in'))

  const flipMs = Math.round(4800 * 0.42)
  const unflipAt = flipMs + Math.round(4800 * 0.14)

  clock.advance(flipMs)
  check('第一拍：掀翻的那张摔出去', flipNode.className, 'dsh-lucky-flip-out')

  clock.advance(unflipAt - flipMs)
  check('第二拍：扶起来的那张进来', unflipNode.className, 'dsh-lucky-unflip-in')
  check('第二张脸同时撤掉隐藏', unflipNode.style.opacity, '')
  check('第一张脸仍停在出场态（不抢戏）', flipNode.className, 'dsh-lucky-flip-out')

  clock.advance(4800 - 300 - unflipAt)
  check('收尾：先摘动画类', unflipNode.className, '')
  check('收尾：再淡出', unflipNode.style.opacity, '0')
  checkTrue('收尾：补上淡出过渡（否则这一下是硬切）', /opacity \.28s/.test(unflipNode.style.transition))

  clock.advance(300)
  check('收场：层被删干净', document.body.children.length, 0)
  check('收场：onDone 只响一次', done, 1)
  check('收场：没有残留定时器', clock.pending(), 0)
}

/* ================= 4. 三个都能被 ESC 掐断，且只报一次收场 ================= */

console.log('— ESC 掐断（三个动效逐个）—')
const STARTERS = {
  停电: (api, onDone) => api.runBlackout(8000, onDone),
  假警报: (api, onDone) => api.runFalseAlarm({ durationMs: 5200, suspenseMs: 2600, suspense: '甲', payoff: '乙' }, onDone),
  掀桌: (api, onDone) => api.runTableFlip({ durationMs: 4800, flip: 'A', unflip: 'B' }, onDone),
}
for (const [name, start] of Object.entries(STARTERS)) {
  const { api, document, clock } = session()
  let done = 0
  start(api, () => {
    done += 1
  })
  clock.advance(200)
  check(`${name}：演出中 ESC 登记表里有一条`, api.finisherCount(), 1)

  api.pressEscape()
  check(`${name}：ESC 立刻收场（层被删）`, document.body.children.length, 0)
  check(`${name}：ESC 也算自然收场（onDone 响一次）`, done, 1)
  check(`${name}：ESC 后定时器全撤（不会隔几秒再往空元素上写字）`, clock.pending(), 0)
  check(`${name}：ESC 后登记表清空`, api.finisherCount(), 0)

  api.pressEscape()
  check(`${name}：再按一次 ESC 不会再报一次收场`, done, 1)
}

/* ================= 汇总 ================= */

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
  process.exit(0)
} else {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exit(1)
}