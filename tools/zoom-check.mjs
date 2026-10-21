/**
 * 整页缩放幅度的边界测试（m01407）。
 *
 * 这个设置的特点是**写错不会报错**：写成 999 就是整页缩到看不见，
 * 写成 0 就是「抽到了缩水但什么都没发生」，写成 "abc" 就是静默回落。
 * 所以这里测的不是「功能好不好用」，而是「坏输入不会变成坏画面」。
 *
 * 做法照 config-check 的老路子：从 lib/index.js 抽真源码跑，不是复制品。
 *
 * 用法：node tools/zoom-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const indexSrc = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
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
  const m = indexSrc.match(re)
  if (!m) {
    console.error(`抽取失败：找不到 ${label}`)
    process.exit(1)
  }
  return m[0]
}

/* ---------- 常量：区间本身也是被测对象 ---------- */

const DEFAULTSrc = grab(/const ZOOM_PERCENT_DEFAULT = \d+/, 'ZOOM_PERCENT_DEFAULT')
const MINSrc = grab(/const ZOOM_PERCENT_MIN = \d+/, 'ZOOM_PERCENT_MIN')
const MAXSrc = grab(/const ZOOM_PERCENT_MAX = \d+/, 'ZOOM_PERCENT_MAX')
const ZOOM_PERCENT_DEFAULT = Number(DEFAULTSrc.split('=')[1])
const ZOOM_PERCENT_MIN = Number(MINSrc.split('=')[1])
const ZOOM_PERCENT_MAX = Number(MAXSrc.split('=')[1])

console.log('— 区间常量 —')
check('默认幅度是 20（m01407 之前的 15 被用户嫌小）', ZOOM_PERCENT_DEFAULT, 20)
check('下限 5：再小就看不出来了', ZOOM_PERCENT_MIN, 5)
check('上限 40：runZoom 的兜底夹子是 0.6~1.6，40 正好够到边界', ZOOM_PERCENT_MAX, 40)
checkTrue('默认值落在区间内（否则「不改」反而会被夹走）', ZOOM_PERCENT_DEFAULT >= ZOOM_PERCENT_MIN && ZOOM_PERCENT_DEFAULT <= ZOOM_PERCENT_MAX)

/* ---------- 抽真源码跑 ---------- */

const clampSrc = grab(/function clampZoomPercent\(value, fallback\) \{[\s\S]*?\n\}/, 'clampZoomPercent')
const configSrc = grab(/function zoomPercentConfig\(raw\) \{[\s\S]*?\n\}/, 'zoomPercentConfig')

const factory = new Function(
  'ZOOM_PERCENT_MIN',
  'ZOOM_PERCENT_MAX',
  'ZOOM_PERCENT_DEFAULT',
  `${clampSrc}\n${configSrc}\nreturn { clampZoomPercent, zoomPercentConfig }`,
)
const { clampZoomPercent, zoomPercentConfig } = factory(ZOOM_PERCENT_MIN, ZOOM_PERCENT_MAX, ZOOM_PERCENT_DEFAULT)

console.log('')
console.log('— clampZoomPercent：坏输入夹回合法值，而不是让整页消失 —')
check('0 夹到下限（0 = 缩没了，不是「关掉」）', clampZoomPercent(0, 20), 5)
check('负数是手滑，同样夹到下限', clampZoomPercent(-30, 20), 5)
check('3 夹到下限', clampZoomPercent(3, 20), 5)
check('41 夹到上限', clampZoomPercent(41, 20), 40)
check('999 夹到上限（手改 config.json 的典型手滑）', clampZoomPercent(999, 20), 40)
check('小数四舍五入到 23', clampZoomPercent(22.6, 20), 23)
check('字符串数字照吃（面板回读的就是字符串）', clampZoomPercent('30', 20), 30)
check('空串当「没填」，回落到 fallback 而不是 0→5', clampZoomPercent('', 20), 20)
check('null 回落', clampZoomPercent(null, 20), 20)
check('undefined 回落', clampZoomPercent(undefined, 20), 20)
check('NaN 回落', clampZoomPercent(Number.NaN, 20), 20)
check('纯文本回落', clampZoomPercent('abc', 20), 20)

console.log('')
console.log('— zoomPercentConfig：缺省即默认，不写盘 —')
check('完全没有 zoom 字段', zoomPercentConfig({}), { shrinkPercent: 20, growPercent: 20 })
check('空对象', zoomPercentConfig({}), { shrinkPercent: 20, growPercent: 20 })
check('null 整份', zoomPercentConfig(null), { shrinkPercent: 20, growPercent: 20 })
check('zoom 是数字（不是对象）', zoomPercentConfig({ zoom: 30 }), { shrinkPercent: 20, growPercent: 20 })
check('zoom 是数组', zoomPercentConfig({ zoom: [30, 40] }), { shrinkPercent: 20, growPercent: 20 })
check('zoom 里多出来的字段被忽略', zoomPercentConfig({ zoom: { shrinkPercent: 30, growPercent: 25, fancy: true } }), { shrinkPercent: 30, growPercent: 25 })
/* 两个方向互不影响：用户只想调大缩水、放大幅度该保持原值 —— 
   这也是「为什么不是一个共享的幅度」的直接证据。 */
check('只写 shrinkPercent 时 growPercent 仍是默认', zoomPercentConfig({ zoom: { shrinkPercent: 35 } }), { shrinkPercent: 35, growPercent: 20 })
check('只写 growPercent 时 shrinkPercent 仍是默认', zoomPercentConfig({ zoom: { growPercent: 38 } }), { shrinkPercent: 20, growPercent: 38 })

console.log('')
console.log('— 接线：配置必须真的走到 spec 里 —')
checkTrue(
  '缩水事件用的是配置里的 shrinkPercent',
  /factor: 1 - zoomPercent\.shrinkPercent \/ 100/.test(indexSrc),
)
checkTrue(
  '变大事件用的是配置里的 growPercent',
  /factor: 1 \+ zoomPercent\.growPercent \/ 100/.test(indexSrc),
)
checkTrue(
  'buildEvents 读到了 config.json 的 zoom',
  /const zoomPercent = zoomPercentConfig\(\(await readJson\(path\.join\(stateDir\(\), CONFIG_FILE\), null\)\) \?\? \{\}\)/.test(indexSrc),
)
checkTrue('settings 把生效值交给面板', /zoom: zoomPercentConfig\(raw\)/.test(indexSrc))
checkTrue(
  'saveSettings 落盘前先夹一遍',
  /raw\.zoom = zoomPercentConfig\(Object\.assign\(\{\}, raw, \{ zoom: patch\.zoom \}\)\)/.test(indexSrc),
)
checkTrue(
  '缩放幅度变了也要重建事件池（spec 是建表时烘进去的）',
  /if \(eventsTouched \|\| zoomChanged\)/.test(indexSrc),
)

console.log('')
console.log('— 假 DOM 之外的那一半：面板接线 —')
checkTrue('面板有「整页缩放幅度」这一组', /t\('整页缩放幅度', 'Page zoom amount'\)/.test(clientSrc))
checkTrue('面板只在读到生效值后才画这一组（占位期间不显示假数字）', /settingsOpen\.zoom\s*\n\s*\?\s*panelGroup\(/.test(clientSrc))
checkTrue(
  '保存走同一个 save-settings，且只发 zoom',
  /callHost\('\/dsh-lucky-block\/save-settings', \{ method: 'POST', body: \{ zoom: next \} \}\)/.test(clientSrc),
)
checkTrue('客户端自己也夹 5~40（不等宿主往返就能回显合法值）', /Math\.max\(5, Math\.min\(40, Math\.round\(n\)\)\)/.test(clientSrc))
checkTrue(
  '面板文案说清「只影响两条事件」',
  /只影响「整页缩水」和「整页变大」两条事件/.test(clientSrc),
)

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)