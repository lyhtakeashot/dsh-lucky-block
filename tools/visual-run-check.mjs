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
  grab(/function runButterFingers\(block, durationMs, onDone\) \{[\s\S]*?\n  \}/, 'runButterFingers'),
  grab(/function runRave\(durationMs, onDone\) \{[\s\S]*?\n  \}/, 'runRave'),
  grab(/function runZoom\(visual, block, onDone\) \{[\s\S]*?\n  \}/, 'runZoom'),
  grab(/function runLowGravity\(block, durationMs, onDone\) \{[\s\S]*?\n  \}/, 'runLowGravity'),
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
  /* 浏览器里「没设过的内联属性」读出来是**空串**，假 DOM 里是 undefined。
     这个差别专门坑「记下原值、收场再还回去」的动效（runZoom 记 zoom 与
     pointer-events）：还原成 undefined 之后，`style.zoom` 读到的不是 ''，
     而真机上它确实是 ''。照浏览器来，不照 JS 来。 */
  ;['zoom', 'pointerEvents', 'animationDuration', 'transition', 'opacity'].forEach((name) => {
    el.style[name] = ''
  })
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
  /* 黄油手要用到这两样：复制品的按屏幕坐标重定位依赖 `getBoundingClientRect()`，
     掉下去的正是 `cloneNode(true)` 的产物。假 DOM 里也必须**真的**复制一份，
     否则「掉的是复制品、原节点只是藏起来」这条最要紧的断言就测不出来。 */
  el.rect = { left: 0, top: 0, width: 48, height: 48 }
  el.getBoundingClientRect = () => ({ ...el.rect })
  el.cloneNode = function (deep) {
    const copy = makeEl(el.tagName)
    copy.style.cssText = el.style.cssText
    /* 真实 DOM 上 cssText 和逐条属性是同一份数据，假 DOM 里不是：
       逐条设置的属性（React 就是这么设的）不会进 cssText，所以两边都抄。 */
    Object.keys(el.style).forEach((name) => {
      if (name === 'setProperty' || name === 'removeProperty' || name === 'cssText') return
      copy.style[name] = el.style[name]
    })
    copy.className = el.className
    copy.textContent = el.textContent
    if (deep) el.children.forEach((child) => copy.appendChild(child.cloneNode(true)))
    return copy
  }
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
  /* 这里**故意不提供 `nodeRef`**。它曾经是作为参数注进来的（因为 runZoom
     当初直接读了 `nodeRef.current`），结果真机上 `runZoom` 在模块作用域里
     根本没有 `nodeRef`，一演就 ReferenceError —— 而检查全绿，因为它把那个
     不存在的变量替用户补上了。测试替身不许替实现圆谎：
     模块作用域的函数要吃节点就吃参数（m01307）。 */
  const body = `${pieces.join('\n')}
return {
  runBlackout: runBlackout,
  runFalseAlarm: runFalseAlarm,
  runTableFlip: runTableFlip,
  runButterFingers: runButterFingers,
  runRave: runRave,
  runZoom: runZoom,
  runLowGravity: runLowGravity,
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

/* ================= 4. 黄油手 ================= */

console.log('— 黄油手 —')
{
  const { api, document, clock } = session()
  const block = document.createElement('div')
  block.className = 'dsh-lucky-someone'
  /* 方块不是一张图，是一棵带贴图/裂纹的子树 —— 复制品要做到「看起来还是同一块」，
     靠的就是这个深拷贝。这里放一个子节点来钉住这件事。 */
  const face = document.createElement('div')
  face.textContent = '面'
  block.appendChild(face)
  block.rect = { left: 300, top: 200, width: 48, height: 48 }

  let done = 0
  api.runButterFingers(block, 1600, () => {
    done += 1
  })

  const fallMs = Math.round(1600 * 0.56)
  const bounceMs = Math.round(1600 * 0.26)

  check('屏幕里多了一个复制品', document.body.children.length, 1)
  const clone = document.body.children[0]
  check('复制品是深拷贝（贴图子树跟着一起掉）', clone.children.length, 1)
  check('复制品的子节点也是原样', clone.children[0] && clone.children[0].textContent, '面')
  check('复制品按屏幕坐标落位（拖到一半时 geometry 和实际位置并不一致）', clone.style.left, '300px')
  check('复制品同样是 fixed', clone.style.position, 'fixed')
  check('复制品不挡鼠标（掉下去的东西不该接住点击）', clone.style.pointerEvents, 'none')
  check('复制品在方块本体（100010）之下', clone.style.zIndex, '100004')
  checkTrue('复制品挂了掉落动画（带 forwards）', /dshLuckyButterFall 896ms/.test(clone.style.animation) && /forwards/.test(clone.style.animation))
  check('原节点被藏起来了', block.classList.contains('dsh-lucky-butter-hidden'), true)
  check('被藏的只是原节点，复制品没被连带藏掉', clone.classList.contains('dsh-lucky-butter-hidden'), false)
  check('原节点的其他 class 没被动过', block.classList.contains('dsh-lucky-someone'), true)

  clock.advance(fallMs - 1)
  check('掉完之前原节点还藏着（早一帧接回来就能看见两个方块）', block.classList.contains('dsh-lucky-butter-hidden'), true)

  clock.advance(1)
  check('掉完：复制品删干净', document.body.children.length, 0)
  check('掉完：原节点接回来', block.classList.contains('dsh-lucky-butter-hidden'), false)
  check('掉完：开始弹（这一下就是「捡起来」的全部表演）', block.classList.contains('dsh-lucky-butter-back'), true)
  check('弹的时候还没报收场（这一下也算演出）', done, 0)

  clock.advance(bounceMs - 1)
  check('弹完前一毫秒：动画类还在', block.classList.contains('dsh-lucky-butter-back'), true)

  clock.advance(1)
  check('弹完：动画类必须摘掉（`both` 会把 scale 钉在方块上，之后拖拽会叠着它）', block.classList.contains('dsh-lucky-butter-back'), false)

  clock.advance(1600 - fallMs - bounceMs)
  check('收场：onDone 只响一次', done, 1)
  check('收场：ESC 登记表清空', api.finisherCount(), 0)
  check('收场：没有残留定时器', clock.pending(), 0)
}

/* 兜底：拿不到方块节点（组件正在卸载，或 ref 还没挂上）。
   这条比演出本身重要 —— 挂一个永不执行的收场函数会把方块锁死到刷新为止。 */
{
  const { api, document, clock } = session()
  let done = 0
  api.runButterFingers(null, 1600, () => {
    done += 1
  })
  check('没有节点：当场收场', done, 1)
  check('没有节点：登记表里不留悬着的收场函数', api.finisherCount(), 0)
  check('没有节点：一个定时器都没挂', clock.pending(), 0)
  check('没有节点：屏幕上也没多东西', document.body.children.length, 0)
}

/* ================= 5. 彩虹 ================= */

console.log('— 彩虹 —')
{
  const { api, document, clock } = session()
  let done = 0
  api.runRave(4200, () => {
    done += 1
  })

  check('盖了一层全屏', document.body.children.length, 1)
  const layer = layerOf(document)
  check('渐变与动画都在 class 里（层自己承担混合）', layer.className, 'dsh-lucky-rave')
  checkTrue('z-index 是 100004（在方块 100010 之下，方块不被染色）', /z-index:100004/.test(layer.style.cssText))
  checkTrue('不挡点击（它只调色，不演「现在不能操作」）', /pointer-events:none/.test(layer.style.cssText))
  checkTrue('混合落在层自己身上（底下什么都不用动）', /mix-blend-mode:overlay/.test(layer.style.cssText))
  check('起手透明（否则颜色是硬闪进来的）', layer.style.opacity, '0')

  clock.advance(30)
  check('30ms 后推到目标不透明度', layer.style.opacity, '0.34')

  clock.advance(4200 - 340 - 30)
  check('收场前先把不透明度压回去（颜色不该硬切）', layer.style.opacity, '0')
  check('压回去的这一刻层还在（还要走完那段过渡）', document.body.children.length, 1)

  clock.advance(340)
  check('自然结束：层被删干净', document.body.children.length, 0)
  check('自然结束：onDone 只响一次', done, 1)
  check('自然结束：ESC 登记表清空', api.finisherCount(), 0)
  check('自然结束：没有残留定时器', clock.pending(), 0)
}

/* ================= 6. 缩水 / 巨人（同一个 runZoom，两个方向） ================= */

console.log('— 缩水 / 巨人 —')
{
  const { api, document, clock } = session()
  const block = document.createElement('div')
  let done = 0
  api.runZoom({ factor: 0.85, durationMs: 3000 }, block, () => {
    done += 1
  })

  check('整页缩到 85%', document.documentElement.style.zoom, '0.85')
  check('缩放期间方块不许被拖（坐标系变了，拖一下就把坐标写歪）', block.style.pointerEvents, 'none')

  clock.advance(3000)
  check('收场：zoom 还回去（否则整页永远停在 85%）', document.documentElement.style.zoom, '')
  check('收场：方块的可点性也还回去', block.style.pointerEvents, '')
  check('收场：onDone 只响一次', done, 1)
  check('收场：ESC 登记表清空', api.finisherCount(), 0)
  check('收场：没有残留定时器', clock.pending(), 0)
}
{
  const { api, document, clock } = session()
  let done = 0
  api.runZoom({ factor: 1.15, durationMs: 3000 }, document.createElement('div'), () => {
    done += 1
  })
  check('巨人：同一个函数，factor 说放大就放大', document.documentElement.style.zoom, '1.15')
  clock.advance(3000)
  check('巨人：收场后也还回去', document.documentElement.style.zoom, '')
  check('巨人：onDone 只响一次', done, 1)
}
{
  /* 宿主或别的插件可能已经设过 zoom。收场必须还它**原来的那个值**，
     不是一律清成空串 —— 清空会把别人的设置一起吃掉。 */
  const { api, document, clock } = session()
  document.documentElement.style.zoom = '0.9'
  api.runZoom({ factor: 0.85, durationMs: 3000 }, document.createElement('div'), () => {})
  check('原有 zoom 被暂时覆盖', document.documentElement.style.zoom, '0.85')
  clock.advance(3000)
  check('收场：还原成原来那个 0.9，不是清空', document.documentElement.style.zoom, '0.9')
}
{
  /* 兜底：spec 是宿主给的，一个坏数字能把整页缩到看不见。
     夹在 0.6~1.6 之后，最坏情况只是「缩了一下」而不是「界面没了」。 */
  const { api, document, clock } = session()
  const block = document.createElement('div')
  api.runZoom({ factor: 0, durationMs: 1000 }, block, () => {})
  check('factor=0：兜底成 1（不是缩小 100%）', document.documentElement.style.zoom, '1')
  clock.advance(1000)
  api.runZoom({ factor: 9, durationMs: 1000 }, block, () => {})
  check('factor=9：夹到上限 1.6', document.documentElement.style.zoom, '1.6')
  clock.advance(1000)
  api.runZoom({ factor: 0.1, durationMs: 1000 }, block, () => {})
  check('factor=0.1：夹到下限 0.6（再小就看不见了）', document.documentElement.style.zoom, '0.6')
  clock.advance(1000)
  api.runZoom(null, block, () => {})
  check('spec 整个缺失：不缩（factor 回落成 1）', document.documentElement.style.zoom, '1')
  check('spec 缺失时用的也是默认时长，不会立刻收场', api.finisherCount(), 1)
}
{
  /* 拿不到 documentElement 这种事不该发生，但「当场收场」永远比「锁死」好。 */
  const document = makeDocument()
  document.documentElement = null
  const clock = makeClock()
  const body = `${pieces.join('\n')}
return { runZoom: runZoom, finisherCount: function () { return escFinishers.length } }`
  const api = new Function('root', 'document', 'window', 't', body)(
    { addEventListener: () => {}, removeEventListener: () => {} },
    document,
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    (zh) => zh,
  )
  let done = 0
  api.runZoom({ factor: 0.85, durationMs: 3000 }, document.createElement('div'), () => {
    done += 1
  })
  check('没有 documentElement：当场收场', done, 1)
  check('没有 documentElement：一个定时器都不挂', clock.pending(), 0)
}

/* ================= 7. 低重力 ================= */

console.log('— 低重力 —')
{
  const { api, document, clock } = session()
  const block = document.createElement('div')
  block.classList.add('dsh-lucky-someone')
  let done = 0
  api.runLowGravity(block, 3400, () => {
    done += 1
  })

  check('方块挂上了低重力动画', block.classList.contains('dsh-lucky-low-gravity'), true)
  check('时长写进 inline animation-duration（class 里那条只是默认值）', block.style.animationDuration, '3400ms')
  check('方块原有的 class 没被动过', block.classList.contains('dsh-lucky-someone'), true)
  check('低重力期间没有任何全屏层（它只动方块）', document.body.children.length, 0)

  clock.advance(3399)
  check('到点之前还在飘', block.classList.contains('dsh-lucky-low-gravity'), true)

  clock.advance(1)
  check('收场：动画类摘掉', block.classList.contains('dsh-lucky-low-gravity'), false)
  check('收场：inline 时长也收回（否则下一次会沿用这次的时长）', block.style.animationDuration, '')
  check('收场：onDone 只响一次', done, 1)
  check('收场：ESC 登记表清空', api.finisherCount(), 0)
  check('收场：没有残留定时器', clock.pending(), 0)
}
{
  const { api, document, clock } = session()
  let done = 0
  api.runLowGravity(null, 3400, () => {
    done += 1
  })
  check('没有节点：当场收场', done, 1)
  check('没有节点：登记表里不留悬着的收场函数', api.finisherCount(), 0)
  check('没有节点：一个定时器都没挂', clock.pending(), 0)
  check('没有节点：屏幕上也没多东西', document.body.children.length, 0)
}

/* ================= 8. 七个都能被 ESC 掐断，且只报一次收场 ================= */

console.log('— ESC 掐断（七个动效逐个）—')
const STARTERS = {
  停电: (api, onDone) => api.runBlackout(8000, onDone),
  假警报: (api, onDone) => api.runFalseAlarm({ durationMs: 5200, suspenseMs: 2600, suspense: '甲', payoff: '乙' }, onDone),
  掀桌: (api, onDone) => api.runTableFlip({ durationMs: 4800, flip: 'A', unflip: 'B' }, onDone),
  黄油手: (api, onDone, ctx) => api.runButterFingers(ctx.block, 1600, onDone),
  彩虹: (api, onDone) => api.runRave(4200, onDone),
  缩水: (api, onDone, ctx) => api.runZoom({ factor: 0.85, durationMs: 3000 }, ctx.block, onDone),
  低重力: (api, onDone, ctx) => api.runLowGravity(ctx.block, 3400, onDone),
}
for (const [name, start] of Object.entries(STARTERS)) {
  const { api, document, clock } = session()
  const block = document.createElement('div')
  let done = 0
  start(
    api,
    () => {
      done += 1
    },
    { block },
  )
  clock.advance(200)
  check(`${name}：演出中 ESC 登记表里有一条`, api.finisherCount(), 1)

  api.pressEscape()
  check(`${name}：ESC 立刻收场（层被删）`, document.body.children.length, 0)
  check(`${name}：ESC 也算自然收场（onDone 响一次）`, done, 1)
  check(`${name}：ESC 后定时器全撤（不会隔几秒再往空元素上写字）`, clock.pending(), 0)
  check(`${name}：ESC 后登记表清空`, api.finisherCount(), 0)
  /* 中断在半路时最容易留下的残骸：方块还藏在「正在掉」的状态里。
     那不会有任何报错，只会让方块从屏幕上消失，直到刷新。 */
  check(`${name}：ESC 后方块没被留在不可见状态`, block.classList.contains('dsh-lucky-butter-hidden'), false)
  /* 第二种残骸（m00793 新增）：整页还停在缩放状态里、或者方块还挂着飘的动画。
     这两种都比「看不见方块」更难发现 —— 用户会以为是自己按到了什么。 */
  check(`${name}：ESC 后整页没被留在缩放状态`, document.documentElement.style.zoom, '')
  check(`${name}：ESC 后方块没被留在动画状态`, block.classList.contains('dsh-lucky-low-gravity') || block.style.animationDuration === '', true)

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