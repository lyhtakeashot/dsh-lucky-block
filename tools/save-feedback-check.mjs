/**
 * 保存按钮的三态反馈（m01627）。
 *
 * 这条需求是「用户无法得知是否按下」—— 本质不是渲染问题，是**状态机**问题：
 * 待命 / 保存中 / 已保存 / 保存失败，四态各自必须给出不一样的外观。
 * 所以这里把 `panelSaveButton` 抽出来跑真代码，逐个状态验它到底画了什么。
 *
 * 假 h() 只做一件事：把 tag / props / children 记下来，不碰 DOM。
 * 假 t() 直接回中文 —— 断言要验的是「哪个状态配哪句话」，
 * 不是翻译对不对（双语对不对由 screen 上的实际观感裁决）。
 *
 * 用法：node tools/save-feedback-check.mjs
 */

import { readFileSync } from 'node:fs'
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

const m = clientSrc.match(/function panelSaveButton\(kind, idleLabel, flash, onClick\) \{[\s\S]*?\n  \}/)
if (!m) {
  console.error('抽取失败：找不到 panelSaveButton')
  process.exit(1)
}

const h = (tag, props, ...children) => ({ tag, props, children })
const t = (zh) => zh
const factory = new Function('h', 't', `${m[0]}\nreturn panelSaveButton`)
const panelSaveButton = factory(h, t)

const IDLE = '保存事件设置'

/** 画一次，把按钮上真正能被看见的三样东西取出来。 */
function render(flash) {
  const el = panelSaveButton('events', IDLE, flash, () => {})
  return {
    label: el.children[0],
    disabled: el.props.disabled,
    color: el.props.style.color,
    cursor: el.props.style.cursor,
    opacity: el.props.style.opacity,
  }
}

console.log('— 待命：没有回执时是原样 —')
check('四种状态之外的默认文案不变', render(null).label, IDLE)
check('默认颜色是链接蓝', render(null).color, '#8fb0d0')
check('默认可点', render(null).disabled, false)
check('默认可点（cursor 是 pointer）', render(null).cursor, 'pointer')
check('默认不透明', render(null).opacity, 1)

console.log('')
console.log('— 保存中：必须看得出「按到了、正在进行」—')
check('文案变成「保存中…」', render({ key: 'events', status: 'saving' }).label, '保存中…')
check('保存中禁用（连点两次没有意义）', render({ key: 'events', status: 'saving' }).disabled, true)
check('禁用的 cursor 不能还是 pointer（那是种谎话）', render({ key: 'events', status: 'saving' }).cursor, 'default')
check('保存中压暗，和可点状态区分开', render({ key: 'events', status: 'saving' }).opacity, 0.6)
check('保存中不是成功色', render({ key: 'events', status: 'saving' }).color !== '#8fd08f', true)

console.log('')
console.log('— 已保存：落盘成功必须和「什么都没发生」长得不一样 —')
check('文案是「已保存 ✓」', render({ key: 'events', status: 'ok' }).label, '已保存 ✓')
check('成功用绿（不是默认蓝）', render({ key: 'events', status: 'ok' }).color, '#8fd08f')
check('成功后可以再保存', render({ key: 'events', status: 'ok' }).disabled, false)
check('成功后 cursor 回到 pointer', render({ key: 'events', status: 'ok' }).cursor, 'pointer')

console.log('')
console.log('— 保存失败：失败不能只是「回到原样」—')
check('文案是「保存失败」', render({ key: 'events', status: 'fail' }).label, '保存失败')
check('失败用红', render({ key: 'events', status: 'fail' }).color, '#e08a8a')
check('失败后仍可重试', render({ key: 'events', status: 'fail' }).disabled, false)

console.log('')
console.log('— 两个按钮共用一套回执，但互不串台 —')
check('缩放按钮不吃事件按钮的回执', panelSaveButton('zoom', '保存缩放幅度', { key: 'events', status: 'ok' }, () => {}).children[0], '保存缩放幅度')
check('事件按钮不吃缩放按钮的回执', panelSaveButton('events', IDLE, { key: 'zoom', status: 'ok' }, () => {}).children[0], IDLE)
check('missing flash（undefined）等同待命', panelSaveButton('events', IDLE, undefined, () => {}).children[0], IDLE)

console.log('')
console.log('— 点击真的接上了 —')
let clicked = 0
const bt = panelSaveButton('events', IDLE, null, () => { clicked += 1 })
bt.props.onClick()
check('onClick 原样透传', clicked, 1)

console.log('')
console.log('— 接线：四个状态各自在正确的地方被点亮 —')
/* saving 必须在**发请求之前**：放在 await 之后等于没反馈。 */
checkTrue(
  '事件保存：请求前点亮 saving',
  /flashSave\('events', 'saving'\)[\s\S]{0,200}callHost\('\/dsh-lucky-block\/save-settings'/.test(clientSrc),
)
checkTrue('事件保存：成功后点亮 ok', /flashSave\('events', 'ok'\)/.test(clientSrc))
checkTrue('事件保存：失败后点亮 fail', /flashSave\('events', 'fail'\)/.test(clientSrc))
checkTrue(
  '缩放保存：请求前点亮 saving',
  /flashSave\('zoom', 'saving'\)[\s\S]{0,200}callHost\('\/dsh-lucky-block\/save-settings'/.test(clientSrc),
)
checkTrue('缩放保存：成功后点亮 ok', /flashSave\('zoom', 'ok'\)/.test(clientSrc))
checkTrue('缩放保存：失败后点亮 fail', /flashSave\('zoom', 'fail'\)/.test(clientSrc))

/* 回执靠 `prev` 合并，不能拿点击那一刻的快照 —— 否则「ok」刚点亮就被
   同一次响应里的 setSettingsOpen（用旧快照整体替换）抹回待命。 */
checkTrue(
  '事件保存刷新面板用函数式更新（否则回执被冲掉）',
  /setSettingsOpen\(function \(prev\) \{\s*\n\s*return prev \? Object\.assign\(\{\}, prev, \{ eventOverrides: res\.value\.events \}\) : prev/.test(clientSrc),
)
checkTrue(
  '缩放保存刷新面板用函数式更新',
  /setSettingsOpen\(function \(prev\) \{\s*\n\s*return prev \? Object\.assign\(\{\}, prev, \{ zoom: res\.value\.zoom \}\) : prev/.test(clientSrc),
)
checkTrue('回执带 key，两个按钮互不串台', /saveFlash: \{ key: key, status: status \}/.test(clientSrc))
checkTrue('ok / fail 1.8 秒后回待命（一次性回执，不是常驻状态）', /}, 1800\)/.test(clientSrc))
checkTrue('新的回执会撤掉上一个 timer（否则旧 timer 会隔空熄灯）', /function \(key, status\) \{\s*\n\s*if \(saveFlashTimer\.current\) window\.clearTimeout\(saveFlashTimer\.current\)/.test(clientSrc))
checkTrue('重开面板时也撤掉遗留 timer', /if \(saveFlashTimer\.current\) \{\s*\n\s*window\.clearTimeout\(saveFlashTimer\.current\)/.test(clientSrc))
checkTrue('事件按钮真的走 panelSaveButton，并接上 saveFlash', /panelSaveButton\('events', t\('保存事件设置', 'Save event settings'\), settingsOpen\.saveFlash/.test(clientSrc))
checkTrue('缩放按钮真的走 panelSaveButton，并接上 saveFlash', /panelSaveButton\('zoom', t\('保存缩放幅度', 'Save zoom amount'\), settingsOpen\.saveFlash/.test(clientSrc))

console.log('')
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)