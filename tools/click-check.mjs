// 单击判定的边界测试（User said (m19957)：「为什么现在右键也是触发短按」）。
//
// 这是一个**已经发生过**的回归：四条判定原本都写成「没有记录就放行」
// （`!press || ...`），而 onPointerDown 首行 `if (event.button !== 0) return`
// 意味着右键从不登记。于是右键松开时 press 为 null，四条全真 → 既弹菜单
// 又抽一次随机事件。现场看不出来（菜单确实弹了），只有数一下「右键点三下
// 应该抽 0 次」才发现多抽了三次。
//
// 所以这里的重点不是「左键能触发」——那从来没错过——而是
// **「没登记过的按压一次都不能触发」**，包括右键、中键、以及 pointerId 对不上。
//
// 做法与 escape-check / konami-check / pickaxe-check 一致：从 lib/client.js
// 抠真代码用 new Function 跑，而不是复制一份实现。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(ok, label, detail) {
  if (typeof ok !== 'boolean') {
    console.error(`  BAD   check() 的第一个参数必须是布尔，收到 ${typeof ok}（标签：${label}）`)
    fail += 1
    return
  }
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}`)
  }
}

/* ---------------- 抽取真代码 ---------------- */

const fnStart = source.indexOf('function isClickRelease(event, press, drag) {')
check(fnStart >= 0, '抽到了 isClickRelease 函数')
if (fnStart < 0) {
  process.exit(1)
}
const fnEnd = source.indexOf('\n  }', fnStart) + 4
const fnSource = source.slice(fnStart, fnEnd)
const isClickRelease = new Function(`${fnSource}\nreturn isClickRelease`)()

/* 造事件与按压记录的小工具，避免每条断言都手写对象。 */
function up(extra) {
  return Object.assign({ type: 'pointerup', button: 0, pointerId: 7 }, extra)
}
function pressOf(extra) {
  return Object.assign({ pointerId: 7, fired: false }, extra)
}

/* ---------------- 1. 右键：这是本次要修的 bug ---------------- */

check(
  isClickRelease(up({ button: 2 }), pressOf(), null) === false,
  '右键松开不触发单击（button=2）',
)
check(
  isClickRelease(up({ button: 1 }), pressOf(), null) === false,
  '中键松开不触发单击（button=1）',
)
/* 上面的两条只在 press 存在时才走到 button 判断；真正的现场是 press 为 null
   （右键根本没登记），这一条才是 bug 的原始形状。 */
check(
  isClickRelease(up({ button: 2 }), null, null) === false,
  '右键松开且从未登记 → 不触发（原始 bug 形状）',
)
check(
  isClickRelease(up({ button: 0 }), null, null) === false,
  '左键松开但从未登记 → 也不触发（未登记一律不认）',
)

/* ---------------- 2. 正常单击：不能因为修 bug 把它弄丢了 ---------------- */

check(isClickRelease(up(), pressOf(), null) === true, '普通左键单击触发')
check(
  isClickRelease(up(), pressOf(), { moved: false }) === true,
  'dragState 存在但没移动过，仍算单击（按钮锁定态/未锁定态都要能点）',
)

/* ---------------- 3. 其余四条否决条件 ---------------- */

check(
  isClickRelease(Object.assign(up(), { type: 'pointercancel' }), pressOf(), null) === false,
  'pointercancel 不触发',
)
check(
  isClickRelease(Object.assign(up(), { type: 'pointerleave' }), pressOf(), null) === false,
  'pointerleave 不触发（鼠标滑出边缘还没松手）',
)
check(
  isClickRelease(up(), pressOf({ fired: true }), null) === false,
  '已挖满（fired=true）不再触发单击',
)
check(
  isClickRelease(up(), pressOf(), { moved: true }) === false,
  '拖动过（moved=true）不触发单击',
)
check(
  isClickRelease(up({ pointerId: 9 }), pressOf(), null) === false,
  'pointerId 对不上不触发（多指/多设备串台）',
)

/* ---------------- 4. 缺 event 的两条调用路径 ---------------- */

check(isClickRelease(null, pressOf(), null) === true, '没有 event 时按登记记录判定（仍算单击）')
check(isClickRelease(null, null, null) === false, '没有 event 也没有登记时不触发')
check(isClickRelease(up(), pressOf(), undefined) === true, 'drag 传 undefined 不抛错，按没拖过处理')

/* ---------------- 5. button 缺失的合成事件 ---------------- */

/* 某些合成/测试事件不带 button。不能把它当成右键而拒绝——
   真实浏览器里 pointerup 一定有 button，但探针与单测里常常没有。 */
check(
  isClickRelease(Object.assign(up(), { button: undefined }), pressOf(), null) === true,
  'button 缺失（非有限数）按左键处理',
)

/* ---------------- 6. 源码层面：不能再退回「没记录就放行」 ---------------- */

check(
  /if \(!press\) return false/.test(fnSource),
  'isClickRelease 第一道判定是「没登记就不认」',
)
check(
  !/!press \|\|/.test(fnSource),
  '源码里不存在 `!press ||` 这种宽容写法',
)
check(
  /Number\.isFinite\(event\.button\) && event\.button !== 0/.test(fnSource),
  'button 判定用 Number.isFinite 守卫',
)

/* ---------------- 7. endDrag 真的用了它 ---------------- */

const endStart = source.indexOf('var endDrag = useCallback')
const endBody = endStart >= 0 ? source.slice(endStart, endStart + 2600) : ''
const clickAt = endBody.indexOf('if (isClickRelease(event, press, dragState.current))')
/* 这里不能用 `indexOf('if (!state) return')` —— 上面那段注释里为了说明
   「为什么必须放在它之前」，原样引用了这句代码，搜到的会是注释里的副本。
   只认真正缩进 6 空格的那一行代码。 */
const guardAt = endBody.search(/\n {6}if \(!state\) return/)
check(
  clickAt >= 0 && guardAt >= 0 && clickAt < guardAt,
  '单击判定在 `if (!state) return` 之前（锁定态才点得动）',
  `click=${clickAt} guard=${guardAt}`,
)
check(
  /isClickRelease\(event, press, dragState\.current\)/.test(endBody),
  'endDrag 用 isClickRelease 判定，而不是自己拼布尔量',
)
check(
  !/var notMoved = !dragState\.current/.test(endBody),
  'endDrag 里不再有 `!dragState.current` 式的宽容判定',
)

console.log('')
console.log(fail === 0 ? `ALL GREEN  pass=${pass} fail=${fail}` : `FAILURES  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
