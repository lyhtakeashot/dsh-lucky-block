/**
 * 外观相关彩蛋与材质的检查（m01706）。
 *
 * 这一批三件事有一个共同点：**写错了不会报错，只会静默变成别的样子**。
 *   - splash 抽重复 / 抽出空串 → 方块旁边空着或两句一样，看起来像坏了；
 *   - 万圣节日期算错 → 一年只有一天能暴露，改天再看永远是对的；
 *   - 材质 ↔ 图案 ↔ 下拉框 ↔ 声音表，四张表里少配一处 → 选了圆石却是默认贴图，
 *     或者挖掘声还是石头声，而且要「真的去敲」才发现。
 * 所以这里测的是「四张表彼此对得上」，不是「好不好看」。
 *
 * 做法照 zoom-check 的老路子：从 lib/client.js 抽真源码跑，不是复制品。
 * 日期全部注入，不在万圣节那天也能跑。
 *
 * 用法：node tools/look-check.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
  }
}

function checkTrue(name, got) {
  check(name, Boolean(got), true)
}

function grab(re, label) {
  const m = clientSrc.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[0]
}

/* ---------- 抽真源码 ---------- */
/* 顺序不能乱：后面几段互相引用（splashPool 用 isHalloween，
   holidayFace 用 LOOK_DEFAULTS，materialSound 用 MATERIAL_SOUNDS）。 */
const pieces = [
  grab(/function clamp\(value, min, max\) \{[\s\S]*?\n  \}/, 'clamp'),
  grab(/var LOOK_DEFAULTS = \{[\s\S]*?\n  \}/, 'LOOK_DEFAULTS'),
  grab(/var LOOK_LIMITS = \{[\s\S]*?\n  \}/, 'LOOK_LIMITS'),
  grab(/function normalizeLook\(raw\) \{[\s\S]*?\n  \}/, 'normalizeLook'),
  grab(/var HALLOWEEN_MONTH = \d+[\s\S]*?function holidayFace\(look, date\) \{[\s\S]*?\n  \}/, '万圣节一段'),
  grab(/var SOUND_FILES = \{[\s\S]*?\n  \}/, 'SOUND_FILES'),
  grab(/var MATERIAL_SOUNDS = \{[\s\S]*?\n  \}/, 'MATERIAL_SOUNDS'),
  grab(/function materialSound\(face\) \{[\s\S]*?\n  \}/, 'materialSound'),
  grab(/var SPLASH_LINES = \[[\s\S]*?\n  \]/, 'SPLASH_LINES'),
  grab(/var HALLOWEEN_SPLASH = \[[\s\S]*?\n  \]/, 'HALLOWEEN_SPLASH'),
  grab(/function pickSplash\(rand, pool\) \{[\s\S]*?\n  \}/, 'pickSplash'),
  grab(/function nextSplash\(avoid, rand, pool\) \{[\s\S]*?\n  \}/, 'nextSplash'),
  grab(/function splashPool\(date\) \{[\s\S]*?\n  \}/, 'splashPool'),
  grab(/var FACE_TEXTURES = \{[\s\S]*?\n  \}/, 'FACE_TEXTURES'),
  grab(/var FACE_OPTIONS = \[[\s\S]*?\n  \]/, 'FACE_OPTIONS'),
]

const api = new Function(
  pieces.join('\n') +
    '\nreturn { clamp, LOOK_DEFAULTS, LOOK_LIMITS, normalizeLook, isHalloween, holidayFace,' +
    ' SOUND_FILES, MATERIAL_SOUNDS, materialSound, SPLASH_LINES, HALLOWEEN_SPLASH,' +
    ' pickSplash, nextSplash, splashPool, FACE_TEXTURES, FACE_OPTIONS }',
)()

const {
  LOOK_DEFAULTS,
  LOOK_LIMITS,
  normalizeLook,
  isHalloween,
  holidayFace,
  SOUND_FILES,
  MATERIAL_SOUNDS,
  materialSound,
  SPLASH_LINES,
  HALLOWEEN_SPLASH,
  pickSplash,
  nextSplash,
  splashPool,
  FACE_TEXTURES,
  FACE_OPTIONS,
} = api

/* ---------- 1. splash 文案 ---------- */

console.log('— 1. splash 文案 —')
checkTrue('至少 20 句（少于这个数，同一天里就会读到重复）', SPLASH_LINES.length >= 20)
checkTrue('每句都非空', SPLASH_LINES.every((s) => typeof s === 'string' && s.trim().length > 0))
checkTrue('每句不超过 14 个字符（方块 56px 宽，再长会横穿屏幕）', SPLASH_LINES.every((s) => s.length <= 14))
checkTrue('没有两句完全一样', new Set(SPLASH_LINES).size === SPLASH_LINES.length)
checkTrue('都不含换行（它是一行贴在方块旁边的小字）', SPLASH_LINES.every((s) => !/[\r\n]/.test(s)))

check('注入 rand=0 时抽第一句', pickSplash(() => 0), SPLASH_LINES[0])
check('注入 rand≈1 时抽最后一句', pickSplash(() => 0.999999), SPLASH_LINES[SPLASH_LINES.length - 1])
check('rand 返回 1（越界）时回落到第一句', pickSplash(() => 1), SPLASH_LINES[0])
check('空池返回空串', pickSplash(() => 0, []), '')
checkTrue('200 次抽取都落在池内', new Set(Array.from({ length: 200 }, () => pickSplash(Math.random))).size <= SPLASH_LINES.length)

const avoided = SPLASH_LINES[0]
let repeatHit = 0
for (let i = 0; i < 300; i += 1) {
  if (nextSplash(avoided, Math.random, SPLASH_LINES) === avoided) repeatHit += 1
}
check('nextSplash 300 次都不等于上一句', repeatHit, 0)
check('池里只有一句时只能认重复', nextSplash('只有一句', () => 0, ['只有一句']), '只有一句')
/* rand 恒指正在被避开的那句：重试 8 次都撞，必须顺延，不能返回重复。 */
check('rand 死锁在 avoid 上时顺延到下一句', nextSplash(SPLASH_LINES[0], () => 0, SPLASH_LINES), SPLASH_LINES[1])
/* 上面那条测的是**兜底**（顺延），不是重试本身。真正的重试要喂一串 rand：
   第一次抽中 avoid，第二次抽中别的 —— 应当返回第二次抽中的那句，
   而不是顺延出来的固定下一句。没有重试的话这里会拿到 SPLASH_LINES[1]。 */
check(
  '撞上 avoid 会重新抽（不是直接顺延）',
  (() => {
    const second = Math.floor(SPLASH_LINES.length / 2)
    let call = 0
    const seq = () => {
      call += 1
      return call === 1 ? 0 : second / SPLASH_LINES.length + 1e-9
    }
    return nextSplash(SPLASH_LINES[0], seq, SPLASH_LINES)
  })(),
  SPLASH_LINES[Math.floor(SPLASH_LINES.length / 2)],
)

console.log('')
console.log('— 2. 万圣节的小字池 —')
checkTrue('万圣节额外句非空', HALLOWEEN_SPLASH.length >= 3)
checkTrue('额外句和常驻句不重复', HALLOWEEN_SPLASH.every((s) => SPLASH_LINES.indexOf(s) < 0))
checkTrue('原版的 OOoooOOOoooo! Spooky! 在池里', HALLOWEEN_SPLASH.some((s) => /Spooky/.test(s)))
check('平时就是常驻池', splashPool(new Date(2026, 4, 20)).length, SPLASH_LINES.length)
check('万圣节是两池相加', splashPool(new Date(2026, 9, 31)).length, SPLASH_LINES.length + HALLOWEEN_SPLASH.length)
check('取池不会改到常驻池（concat 出新数组）', SPLASH_LINES.length, 28)
checkTrue(
  '万圣节池里既有常驻句也有幽灵句',
  (() => {
    const pool = splashPool(new Date(2026, 9, 31))
    return pool.indexOf(SPLASH_LINES[0]) >= 0 && pool.indexOf(HALLOWEEN_SPLASH[0]) >= 0
  })(),
)

/* ---------- 3. 万圣节日期 ---------- */

console.log('')
console.log('— 3. 万圣节日期（一年只有一天能暴露，日期全部注入）—')
check('10 月 31 日', isHalloween(new Date(2026, 9, 31)), true)
check('10 月 30 日', isHalloween(new Date(2026, 9, 30)), false)
check('11 月 1 日', isHalloween(new Date(2026, 10, 1)), false)
check('9 月 31 日不存在（会进位成 10 月 1 日）', isHalloween(new Date(2026, 8, 31)), false)
check('当天 00:00 就算', isHalloween(new Date(2026, 9, 31, 0, 0, 0)), true)
check('当天 23:59 还算', isHalloween(new Date(2026, 9, 31, 23, 59, 59)), true)
check('次日 00:00 立刻结束', isHalloween(new Date(2026, 10, 1, 0, 0, 0)), false)
check('跨年不会误判（12 月 31 日）', isHalloween(new Date(2026, 11, 31)), false)

console.log('')
console.log('— 4. 该显示哪张脸 —')
check('默认外观 + 万圣节 → 南瓜', holidayFace({ face: 'lucky' }, new Date(2026, 9, 31)), 'pumpkin')
check('默认外观 + 平时 → 幸运方块', holidayFace({ face: 'lucky' }, new Date(2026, 4, 20)), 'lucky')
check('挑了原木 → 尊重用户（万圣节也不变）', holidayFace({ face: 'oak' }, new Date(2026, 9, 31)), 'oak')
check('挑了自定义图片 → 不动', holidayFace({ face: 'custom' }, new Date(2026, 9, 31)), 'custom')
check('关掉开关 → 万圣节也不变', holidayFace({ face: 'lucky', halloween: false }, new Date(2026, 9, 31)), 'lucky')
check('look 缺省（null）→ 幸运方块', holidayFace(null, new Date(2026, 9, 31)), 'pumpkin')
check('look 是空对象 → 万圣节变南瓜', holidayFace({}, new Date(2026, 9, 31)), 'pumpkin')
check('未知 face 原样返回，不炸', holidayFace({ face: 'weird' }, new Date(2026, 9, 31)), 'weird')

/* ---------- 5. 材质：四张表必须对得上 ---------- */

console.log('')
console.log('— 5. 材质清单（白名单 / 图案 / 下拉框 / 声音表）—')
const NEW_FACES = ['cobblestone', 'oak', 'iron']
checkTrue('白名单里有圆石、原木、铁块', NEW_FACES.every((f) => LOOK_LIMITS.faces.indexOf(f) >= 0))
check('白名单没有重复项', new Set(LOOK_LIMITS.faces).size, LOOK_LIMITS.faces.length)
check('下拉框的 id 与白名单逐项一致（顺序也一致）', FACE_OPTIONS.map((p) => p[0]), LOOK_LIMITS.faces)
check('下拉框每项都有中文名和英文名', FACE_OPTIONS.every((p) => p[1] && p[2]), true)
check('下拉框的中文名互不重复', new Set(FACE_OPTIONS.map((p) => p[1])).size, FACE_OPTIONS.length)

const TEXTURED_FACES = ['cobblestone', 'oak', 'iron', 'command', 'pumpkin']
check('每个「有原版材质」的方块都有一张内联贴图', TEXTURED_FACES.filter((f) => !FACE_TEXTURES[f]), [])
check('贴图表里没有白名单外的孤儿', Object.keys(FACE_TEXTURES).filter((f) => LOOK_LIMITS.faces.indexOf(f) < 0), [])
check('lucky 和 custom 不在贴图表里（一个用自己的默认图、一个用用户图片）',
  [!!FACE_TEXTURES.lucky, !!FACE_TEXTURES.custom], [false, false])
checkTrue('表里存的是裸 base64（拼成 data URI 的地方只有一处）',
  Object.values(FACE_TEXTURES).every((v) => typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v)))

console.log('')
console.log('— 6. 材质 → 声音 —')
check('圆石用石头声', materialSound('cobblestone'), 'stone')
check('原木用木头声', materialSound('oak'), 'wood')
check('铁块用金属声', materialSound('iron'), 'metal')
check('未知材质退回石头声', materialSound('mystery'), 'stone')
check('undefined 退回石头声', materialSound(undefined), 'stone')
check('声音表里没有白名单外的材质', Object.keys(MATERIAL_SOUNDS).filter((f) => LOOK_LIMITS.faces.indexOf(f) < 0), [])
check(
  '三组挖掘音互不相同（否则「对应材质」没意义）',
  new Set(['stone', 'wood', 'metal'].map((g) => SOUND_FILES[g].join(','))).size,
  3,
)
check('每个材质组都有对应的「挖穿」组', ['stone', 'wood', 'metal'].filter((g) => !SOUND_FILES[g + 'Break']), [])
checkTrue('石头组至少两段（单段循环听起来像卡带）', SOUND_FILES.stone.length >= 2)
checkTrue('木头组至少两段', SOUND_FILES.wood.length >= 2)
checkTrue('金属组至少一段', SOUND_FILES.metal.length >= 1)

const allFiles = new Set()
Object.keys(SOUND_FILES).forEach((k) => SOUND_FILES[k].forEach((f) => allFiles.add(f)))
checkTrue('清单里每个音频文件都真的在 lib/sounds/ 下', [...allFiles].every((f) => existsSync(path.join(root, 'lib', 'sounds', f))))
checkTrue('没有不存在的材质组被引用（materialSound 只返回三组之一）',
  ['cobblestone', 'oak', 'iron', 'lucky', 'custom', 'command', 'pumpkin']
    .map((f) => materialSound(f))
    .every((g) => Object.prototype.hasOwnProperty.call(SOUND_FILES, g) && Object.prototype.hasOwnProperty.call(SOUND_FILES, g + 'Break')))

/* ---------- 7. normalizeLook 认识新字段 ---------- */

console.log('')
console.log('— 7. 落盘清洗（老配置里没有新字段）—')
const fresh = normalizeLook(null)
check('默认开小字', fresh.splash, true)
check('默认开万圣节', fresh.halloween, true)
check('显式关小字', normalizeLook({ splash: false }).splash, false)
check('显式关万圣节', normalizeLook({ halloween: false }).halloween, false)
check('字符串 "false" 不算关（只有布尔 false 算）', normalizeLook({ splash: 'false' }).splash, true)
check('新材质能存下', normalizeLook({ face: 'oak' }).face, 'oak')
check('铁块也能存下', normalizeLook({ face: 'iron' }).face, 'iron')
check('白名单外的 face 回退默认', normalizeLook({ face: 'diamond' }).face, 'lucky')

/* ---------- 8. 接线 ---------- */

console.log('')
console.log('— 8. 接线（抽源码断言，防止只写了一半）—')
checkTrue('faceFace 走 holidayFace（不是直接读 look.face）', /var face = holidayFace\(look\)/.test(clientSrc))
checkTrue('取图用的是 holidayFace 的结果', /else if \(FACE_TEXTURES\[face\]\) src = 'data:image\/png;base64,' \+ FACE_TEXTURES\[face\]/.test(clientSrc))
checkTrue('按下挖掘时把材质传给 startDig', /startDig\(digFace\)/.test(clientSrc))
checkTrue('挖穿时把材质传给 playBreak', /playBreak\(digFace\)/.test(clientSrc))
checkTrue('digFace 也过一遍 holidayFace（南瓜那天声音跟着变）', /var digFace = holidayFace\(geometry\.look, new Date\(\)\)/.test(clientSrc))
checkTrue('引擎按材质取组', /var group = materialSound\(face\)/.test(clientSrc))
checkTrue('挖穿音按「材质 + Break」拼组名', /pickSound\(materialSound\(face\) \+ 'Break', null\)/.test(clientSrc))
checkTrue('小字渲染是绝对定位、不吃点击', /pointerEvents: 'none',[\s\S]{0,120}animation: 'dshLuckySplash/.test(clientSrc))
checkTrue('小字有脉动动画的 keyframes', /@keyframes dshLuckySplash\{from\{transform:rotate\(-6deg\) scale\(1\)\}/.test(clientSrc))
checkTrue('小字只在没有台词/报错时出现', /look\.splash && splashText && !quip && !error/.test(clientSrc))
checkTrue('每次抽完换一句（onRoll 里调 rollSplash）', /rollSplash\(\)\n\s+setBusy\(true\)/.test(clientSrc))
checkTrue('抽小字时按当天取池', /nextSplash\(splashRef\.current, Math\.random, splashPool\(new Date\(\)\)\)/.test(clientSrc))
checkTrue('面板有小字开关', /方块旁边的黄色小字/.test(clientSrc))
checkTrue('面板有万圣节开关', /万圣节（10\/31）自动变南瓜/.test(clientSrc))
checkTrue('两个开关都走 applyLook 落盘（不是只改 state）',
  (clientSrc.match(/applyLook\(Object\.assign\(\{\}, lookDraft, \{ (splash|halloween): e\.target\.checked \}\)\)/g) || []).length, 2)

/* ---------- 9. 面板底部的自述行 ---------- */

console.log('')
console.log('— 9. 「这一份客户端」自述行（用来自检加载的是哪一版）—')
checkTrue('有这一行', /这一份客户端：形状 /.test(clientSrc))
checkTrue('形状数由 FACE_OPTIONS 自己算（不写死）',
  /this build[\s\S]{0,80}FACE_OPTIONS\.length/i.test(clientSrc) || /这一份客户端：形状 '\s*\+\s*\n\s*FACE_OPTIONS\.length/.test(clientSrc) || /' \+ FACE_OPTIONS\.length/.test(clientSrc))
checkTrue('事件数按 trigger 现算', /\(e\.trigger \|\| 'click'\) !== 'hold'/.test(clientSrc))
checkTrue('长按数按 trigger 现算', /return e\.trigger === 'hold'/.test(clientSrc))
checkTrue('自述行不用任何硬编码的「22」「8」', !/形状 8 种/.test(clientSrc) && !/事件 22 /.test(clientSrc))

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)