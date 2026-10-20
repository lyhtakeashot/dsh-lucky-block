/**
 * 科乐美秘技的状态机测试。
 *
 * 为什么单独测这个：它是一段**没有任何输出**的代码 —— 按对了只是让方块变金四秒。
 * 所以「按错了没反应」和「按对了也没反应」在界面上长得一模一样，
 * 靠手动点方块永远发现不了「最后一键要按 Shift 才认」这种 bug。
 *
 * 做法：从 `lib/client.js` 抠出 `KONAMI_SEQUENCE` 与 `createKonami()`
 * 的源码，用 `new Function` 跑真代码 —— 不复写一遍状态机，
 * 因为「测我的理解」和「测代码」是两件事，前者永远绿。
 *
 * 用法：node tools/konami-check.mjs
 */
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.error(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/* ---- 抠源码 ---- */
function sliceFrom(marker, endMarker) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`找不到 ${marker}`)
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  if (end < 0) throw new Error(`找不到 ${endMarker} 的结尾`)
  return source.slice(start, end + endMarker.length)
}

const seqSrc = sliceFrom('var KONAMI_SEQUENCE = ', '\n')
const gapSrc = sliceFrom('var KONAMI_GAP_MS = ', '\n')
const fnSrc = sliceFrom('function createKonami(onHit) {', '\n  }\n')

const build = new Function(`
  ${seqSrc}
  ${gapSrc}
  ${fnSrc}
  return { KONAMI_SEQUENCE, KONAMI_GAP_MS, createKonami }
`)
const { KONAMI_SEQUENCE, KONAMI_GAP_MS, createKonami } = build()

/* ---- 1. 指令本身 ---- */
console.log('-- 指令内容 --')
check('整串是十步', KONAMI_SEQUENCE.length === 10, `实际 ${KONAMI_SEQUENCE.length}`)
check(
  '就是 ↑↑↓↓←→←→BA',
  KONAMI_SEQUENCE.join(',') === 'ArrowUp,ArrowUp,ArrowDown,ArrowDown,ArrowLeft,ArrowRight,ArrowLeft,ArrowRight,b,a',
  KONAMI_SEQUENCE.join(','),
)
check('允许的间隔是正数', Number.isFinite(KONAMI_GAP_MS) && KONAMI_GAP_MS > 0, KONAMI_GAP_MS)

/* ---- 2. 按对了才触发 ---- */
console.log('\n-- 命中 --')
function press(handler, key, at) {
  handler({ key, preventDefault() {}, stopPropagation() {} })
  if (typeof at === 'function') at()
}

let hits = 0
let handler = createKonami(() => {
  hits += 1
})
for (const key of KONAMI_SEQUENCE.slice(0, 9)) press(handler, key)
check('按到第九步还不触发', hits === 0, hits)
press(handler, KONAMI_SEQUENCE[9])
check('按完第十步触发一次', hits === 1, hits)
for (const key of KONAMI_SEQUENCE) press(handler, key)
check('再按一整串又触发一次', hits === 2, hits)

/* ---- 3. 全程无 preventDefault ---- */
console.log('\n-- 不抢按键 --')
let prevented = 0
const quiet = createKonami(() => {})
for (const key of KONAMI_SEQUENCE) {
  quiet({
    key,
    preventDefault() {
      prevented += 1
    },
    stopPropagation() {},
  })
}
check('整串按下都不 preventDefault', prevented === 0, `实际 ${prevented} 次`)

/* ---- 4. 大小写（按着 Shift 时 event.key 是大写） ---- */
console.log('\n-- 大小写 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
for (const key of KONAMI_SEQUENCE.slice(0, 8)) press(handler, key)
press(handler, 'B')
press(handler, 'A')
check('大写 BA 同样触发（Shift 没松的人也能用）', hits === 1, hits)

/* ---- 5. 错一步就从头数 ---- */
console.log('\n-- 错误输入 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
for (const key of KONAMI_SEQUENCE.slice(0, 5)) press(handler, key)
press(handler, 'ArrowUp')
for (const key of KONAMI_SEQUENCE.slice(6)) press(handler, key)
check('中途按错，后面接上也不触发', hits === 0, hits)

hits = 0
handler = createKonami(() => {
  hits += 1
})
press(handler, 'ArrowUp')
press(handler, 'x')
/* 按错之后 `x` 不是序列第一步，所以进度归零；此时再按完整的整串应当命中。 */
for (const key of KONAMI_SEQUENCE) press(handler, key)
check('按错后重新输入整串仍然触发', hits === 1, hits)

/* ---- 6. 多按一步会让进度归零，不能靠剩下的补上 ---- */
console.log('\n-- 多按一步 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
press(handler, 'ArrowUp')
press(handler, 'ArrowUp')
press(handler, 'ArrowDown')
press(handler, 'ArrowDown')
/* 这四下都对，进度走到第 4 步。下面多按一个 Down —— 序列第 5 步是 Left，
   不是 Down（Down 只有两个）。多出来的这一下必须让进度归零。 */
press(handler, 'ArrowDown')
press(handler, 'ArrowLeft')
press(handler, 'ArrowRight')
press(handler, 'ArrowLeft')
press(handler, 'ArrowRight')
press(handler, 'b')
press(handler, 'a')
check('多按一个 Down 之后不能靠剩下的补上', hits === 0, hits)

/* 换一种补法：多按之后**从头**再按一整串，应当命中。
   这条防的是「归零时把 index 归成了 1」这种 off-by-one ——
   那种 bug 会让用户永远差一步，且看不出原因。 */
hits = 0
handler = createKonami(() => {
  hits += 1
})
press(handler, 'ArrowUp')
press(handler, 'ArrowUp')
press(handler, 'ArrowDown')
press(handler, 'ArrowDown')
press(handler, 'ArrowDown')
for (const key of KONAMI_SEQUENCE) press(handler, key)
check('多按之后从头再按一整串仍然触发', hits === 1, hits)

/* ---- 7. 无关按键不推进进度 ---- */
console.log('\n-- 无关按键 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
for (const key of KONAMI_SEQUENCE.slice(0, 9)) press(handler, key)
press(handler, 'F5')
press(handler, 'Escape')
for (const key of KONAMI_SEQUENCE.slice(9)) press(handler, key)
check('中间夹了 F5 / ESC 之后不触发（进度已清零）', hits === 0, hits)

/* ---- 8. event.key 缺失 / 非法时不炸 ---- */
console.log('\n-- 防御 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
let threw = false
try {
  handler({})
  handler(null)
  handler({ key: null })
  handler({ key: 42 })
  handler()
} catch (error) {
  threw = true
  console.error(`  抛错：${error.message}`)
}
check('event 缺失或 key 非法时不抛错', !threw)
check('非法输入不会命中', hits === 0, hits)

/* ---- 9. 超时重置 ---- */
console.log('\n-- 间隔超时 --')
hits = 0
handler = createKonami(() => {
  hits += 1
})
const realNow = Date.now
try {
  /* 前九步在正常时间按完，最后一步「隔了三天」才按 —— 必须重新数，
     否则早上按三下、下午按七下也能触发。 */
  for (const key of KONAMI_SEQUENCE.slice(0, 9)) press(handler, key)
  let fake = realNow() + KONAMI_GAP_MS * 10
  Date.now = () => fake
  press(handler, KONAMI_SEQUENCE[9])
  check('隔太久之后不触发', hits === 0, hits)
} finally {
  Date.now = realNow
}

/* ---- 10. 回调不是函数时不炸 ---- */
console.log('\n-- 回调缺失 --')
let noCbThrew = false
try {
  const bare = createKonami()
  for (const key of KONAMI_SEQUENCE) bare({ key })
} catch (error) {
  noCbThrew = true
  console.error(`  抛错：${error.message}`)
}
check('createKonami() 不传回调也不炸', !noCbThrew)

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
} else {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exitCode = 1
}
