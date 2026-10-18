/**
 * 吸附逻辑纯函数级验证。
 *
 * lib/client.js 是浏览器 bundle，不能直接 import，所以这里用「源码抽取」
 * 的办法把 snapGeometry 及其依赖（clamp）取出来 eval，保证测的是**真代码**
 * 而不是复制品。client.js 一改，这个测试就会跟着变，不会漂移。
 *
 * 用法：node tools/snap-check.mjs
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
  grab(/var SNAP_THRESHOLD = \d+/, 'SNAP_THRESHOLD'),
  grab(/var SNAP_MS = \d+/, 'SNAP_MS'),
  grab(/function clamp\([\s\S]*?\n  \}/, 'clamp'),
  grab(/function snapGeometry\(next\) \{[\s\S]*?\n  \}/, 'snapGeometry'),
  grab(/function anchorBelow\([\s\S]*?\n  \}/, 'anchorBelow'),
]

// 提供一个可调的假视口。
const fakeRoot = { innerWidth: 1280, innerHeight: 800 }
const body = `${pieces.join('\n')}\nreturn { snapGeometry: snapGeometry, anchorBelow: anchorBelow, SNAP_THRESHOLD: SNAP_THRESHOLD, SNAP_MS: SNAP_MS }`
const factory = new Function('root', body)
const api = factory(fakeRoot)

/* ---------- 断言 ---------- */

let pass = 0
let fail = 0
const SIZE = 56

function check(name, coords, viewport, expected) {
  Object.assign(fakeRoot, viewport)
  const got = api.snapGeometry({ x: coords.x, y: coords.y, size: SIZE })
  const ok = got.x === expected.x && got.y === expected.y
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望 x=${expected.x} y=${expected.y}，实际 x=${got.x} y=${got.y}`)
  }
}

const W = 1280
const H = 800
const MAX_X = W - SIZE // 1224
const MAX_Y = H - SIZE // 744
const T = api.SNAP_THRESHOLD

console.log(`SNAP_THRESHOLD = ${T}, SNAP_MS = ${api.SNAP_MS}`)
console.log(`视口 ${W}x${H}，方块 ${SIZE}px，maxX=${MAX_X} maxY=${MAX_Y}`)
console.log('')

console.log('— 四条边各自吸附 —')
check('贴左：x=0', { x: 0, y: 300 }, { innerWidth: W, innerHeight: H }, { x: 0, y: 300 })
check('贴左：x=T 边界内', { x: T, y: 300 }, { innerWidth: W, innerHeight: H }, { x: 0, y: 300 })
check('不贴左：x=T+1', { x: T + 1, y: 300 }, { innerWidth: W, innerHeight: H }, { x: T + 1, y: 300 })
check('贴右：x=maxX', { x: MAX_X, y: 300 }, { innerWidth: W, innerHeight: H }, { x: MAX_X, y: 300 })
check('贴右：x=maxX-T 边界内', { x: MAX_X - T, y: 300 }, { innerWidth: W, innerHeight: H }, { x: MAX_X, y: 300 })
check('不贴右：x=maxX-T-1', { x: MAX_X - T - 1, y: 300 }, { innerWidth: W, innerHeight: H }, { x: MAX_X - T - 1, y: 300 })
check('贴上：y=0', { x: 500, y: 0 }, { innerWidth: W, innerHeight: H }, { x: 500, y: 0 })
check('贴上：y=T 边界内', { x: 500, y: T }, { innerWidth: W, innerHeight: H }, { x: 500, y: 0 })
check('贴下：y=maxY', { x: 500, y: MAX_Y }, { innerWidth: W, innerHeight: H }, { x: 500, y: MAX_Y })
check('贴下：y=maxY-T 边界内', { x: 500, y: MAX_Y - T }, { innerWidth: W, innerHeight: H }, { x: 500, y: MAX_Y })

console.log('')
console.log('— 两轴独立（角落同时吸附）—')
check('左上角', { x: 10, y: 10 }, { innerWidth: W, innerHeight: H }, { x: 0, y: 0 })
check('右下角', { x: MAX_X - 10, y: MAX_Y - 10 }, { innerWidth: W, innerHeight: H }, { x: MAX_X, y: MAX_Y })
check('左下角（x 左 + y 下）', { x: 10, y: MAX_Y - 10 }, { innerWidth: W, innerHeight: H }, { x: 0, y: MAX_Y })

console.log('')
console.log('— 中间自由区：完全不动 —')
check('正中', { x: 600, y: 400 }, { innerWidth: W, innerHeight: H }, { x: 600, y: 400 })
check('偏左但不在阈值内', { x: 100, y: 400 }, { innerWidth: W, innerHeight: H }, { x: 100, y: 400 })

console.log('')
console.log('— 越界一律夹回（不落盘坏坐标）—')
check('x 负数', { x: -50, y: 400 }, { innerWidth: W, innerHeight: H }, { x: 0, y: 400 })
check('x 超右', { x: 99999, y: 400 }, { innerWidth: W, innerHeight: H }, { x: MAX_X, y: 400 })
check('y 负数', { x: 600, y: -50 }, { innerWidth: W, innerHeight: H }, { x: 600, y: 0 })
check('y 超下', { x: 600, y: 99999 }, { innerWidth: W, innerHeight: H }, { x: 600, y: MAX_Y })

console.log('')
console.log('— 小视口：maxX/maxY 为 0 时不出现负值 —')
check('视口比方块还小', { x: 10, y: 10 }, { innerWidth: 40, innerHeight: 40 }, { x: 0, y: 0 })
check('视口等于方块', { x: 10, y: 10 }, { innerWidth: SIZE, innerHeight: SIZE }, { x: 0, y: 0 })

console.log('')
console.log('— 右键菜单 / 设置面板的展开方向（anchorBelow）—')

/* 面板固定在方块下方，横向自适应：
   贴右边缘 → 向左展开（用 right 锚定），贴左边缘 → 向右展开（left = 方块 x）。 */
function checkAnchor(name, geometry, panelWidth, viewport, expect) {
  Object.assign(fakeRoot, viewport)
  const got = api.anchorBelow(geometry, panelWidth)
  const left = got.left === null ? null : got.left
  const right = got.right === null ? null : got.right
  const ok = left === expect.left && right === expect.right
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望 left=${expect.left} right=${expect.right}，实际 left=${left} right=${right}`)
  }
}

const MENU_W = 160
const PANEL_W = 300
checkAnchor('方块贴右：菜单向左展开', { x: 1224, y: 700, size: SIZE }, MENU_W, { innerWidth: W, innerHeight: H }, { left: null, right: 0 })
checkAnchor('方块贴右：300px 面板也向左展开', { x: 1224, y: 700, size: SIZE }, PANEL_W, { innerWidth: W, innerHeight: H }, { left: null, right: 0 })
checkAnchor('方块贴左：菜单向右展开', { x: 0, y: 300, size: SIZE }, MENU_W, { innerWidth: W, innerHeight: H }, { left: 0, right: null })
checkAnchor('方块中间：向右展开', { x: 500, y: 300, size: SIZE }, MENU_W, { innerWidth: W, innerHeight: H }, { left: 500, right: null })
checkAnchor('距右边界刚好够：向右展开', { x: 1000, y: 300, size: SIZE }, MENU_W, { innerWidth: W, innerHeight: H }, { left: 1000, right: null })
checkAnchor('差一点就溢出：翻转向左', { x: 1130, y: 300, size: SIZE }, MENU_W, { innerWidth: W, innerHeight: H }, { left: null, right: W - 1186 })
checkAnchor('小视口：向左展开也不出界', { x: 160, y: 300, size: SIZE }, PANEL_W, { innerWidth: 320, innerHeight: H }, { left: null, right: 320 - 8 - PANEL_W })
checkAnchor('窄视口：被迫向右展开', { x: 0, y: 300, size: SIZE }, PANEL_W, { innerWidth: 200, innerHeight: H }, { left: 0, right: null })

console.log('')
console.log('— 视口缺失时回退到 1280x800，不抛错 —')
check('innerWidth 为 0', { x: 10, y: 10 }, { innerWidth: 0, innerHeight: 0 }, { x: 0, y: 0 })

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
