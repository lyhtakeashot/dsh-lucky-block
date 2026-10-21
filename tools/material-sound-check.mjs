// 校验「材质 → 声音」这条映射是不是真的对应上了。
// 用法：node tools/material-sound-check.mjs
//
// 为什么值得单独一个脚本（2026-10-21，用户 m02630 的原话）：
//   「原木和铁块的声音不对，一个用成了铁砧，原木的我没听出来，你检查一下 sound 是不是下错了」
// 当时 SOUND_FILES 里 wood = [wood_click, pop]（UI 点击音）、metal = [anvil_land]
// （铁砧落地音）。这两件事**任何现有测试都抓不到**：文件在、名字对、白名单放行、
// verify-sounds 全绿 —— 唯一能发现它的是耳朵，而耳朵不在 CI 里。
//
// 所以这里把「什么材质该用什么采样」写成可证伪的断言：
//   - 材质组里不许再出现凑数音（anvil_* / wood_click / pop / click / break.ogg）；
//   - 木头必须是 dig/wood 采样，金属必须是 copper 采样；
//   - 挖穿那一下复用同材质的采样（原版 `block.<材质>.break` 就是这么排的）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js')
const SOUNDS_DIR = path.join(ROOT, 'lib', 'sounds')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` —— ${detail}` : ''}`)
}

const source = fs.readFileSync(CLIENT_FILE, 'utf8')

/* ---------------- 1. 把六个材质组抠出来 ---------------- */
console.log('== SOUND_FILES 分组 ==')
const groups = {}
for (const name of ['stone', 'wood', 'metal', 'stoneBreak', 'woodBreak', 'metalBreak']) {
  const re = new RegExp(`\\b${name}: \\[([^\\]]*)\\]`)
  const m = re.exec(source)
  groups[name] = m ? [...m[1].matchAll(/'([A-Za-z0-9_]+\.ogg)'/g)].map((x) => x[1]) : null
  check(groups[name] !== null && groups[name].length > 0, `抽到了 ${name} 组`, m ? m[1].trim() : '没匹配到')
}

const all = Object.values(groups).flat().filter(Boolean)
check(all.length > 0, `六个材质组合计 ${all.length} 条采样`)

/* ---------------- 2. 每组的采样必须「够轮播」 ---------------- */
console.log('\n== 轮播数量 ==')
// 一段采样连着响就是「卡带」。原版每种材质四段，这里最宽也只让金属两段。
for (const name of ['stone', 'wood', 'metal']) {
  const list = groups[name]
  check(list !== null && list.length >= 2, `${name} 组至少两段（否则连着响同一个）`, list ? `${list.length} 段` : '无')
}
// 收尾音可以只有一段（一次挖穿只响一下），但不能为空。
for (const name of ['stoneBreak', 'woodBreak', 'metalBreak']) {
  const list = groups[name]
  check(list !== null && list.length >= 1, `${name} 组非空`)
}

/* ---------------- 3. 材质组里不许再有「凑数音」 ---------------- */
console.log('\n== 凑数音（这次回归的原始动机） ==')
// anvil_*：铁砧落地是「重物砸地」，金属方块是「敲铁」—— 用户当场听出来了。
// wood_click / pop / click：UI 点击音，是「原木没听出来」的原因。
// break.ogg：random/break 在 MC 里挂 entity.item.break（工具坏了），不是方块碎裂。
const filler = ['anvil_land.ogg', 'anvil_break.ogg', 'anvil_use.ogg', 'wood_click.ogg', 'pop.ogg', 'click.ogg', 'break.ogg']
for (const name of ['stone', 'wood', 'metal', 'stoneBreak', 'woodBreak', 'metalBreak']) {
  const list = groups[name] || []
  const bad = list.filter((f) => filler.includes(f))
  check(bad.length === 0, `${name} 组里没有凑数音`, bad.join(', '))
}

/* ---------------- 4. 每种材质必须用「自己的」采样 ---------------- */
console.log('\n== 材质 ↔ 采样族 ==')
const familyOf = (list) => {
  const kinds = new Set()
  for (const f of list || []) {
    if (/^dig\d/.test(f)) kinds.add('stone')
    else if (/^wood\d/.test(f)) kinds.add('wood')
    else if (/^metal_/.test(f)) kinds.add('metal')
    else kinds.add('other:' + f)
  }
  return kinds
}
const stoneKinds = familyOf(groups.stone)
const woodKinds = familyOf(groups.wood)
const metalKinds = familyOf(groups.metal)
check(stoneKinds.size === 1 && stoneKinds.has('stone'), '石头组全是 dig/stone 采样', [...stoneKinds].join(','))
check(woodKinds.size === 1 && woodKinds.has('wood'), '木头组全是 dig/wood 采样', [...woodKinds].join(','))
check(metalKinds.size === 1 && metalKinds.has('metal'), '金属组全是 copper 采样（metal_*）', [...metalKinds].join(','))

/* ---------------- 5. 挖穿那一下复用同材质 ---------------- */
console.log('\n== 挖穿音 ↔ 挖掘音 ==')
// 原版 `block.<材质>.break` 用的就是该材质的 dig/<材质>N，所以两组名字应该完全一致。
const sameSet = (a, b) => a && b && a.length === b.length && [...a].sort().join() === [...b].sort().join()
check(sameSet(groups.stone, groups.stoneBreak), 'stoneBreak 复用 stone 组（原版就是这么排的）')
check(sameSet(groups.wood, groups.woodBreak), 'woodBreak 复用 wood 组')
check(
  groups.metal !== null && groups.metalBreak !== null && groups.metalBreak.every((f) => /^metal_break\d/.test(f)),
  'metalBreak 用的是金属碎裂采样（metal_break*）',
  (groups.metalBreak || []).join(','),
)

/* ---------------- 6. 磁盘上真的有这些文件 ---------------- */
console.log('\n== 磁盘 ↔ 清单 ==')
const onDisk = fs.readdirSync(SOUNDS_DIR)
for (const name of [...new Set(all)].sort()) {
  const p = path.join(SOUNDS_DIR, name)
  const ok = onDisk.includes(name) && fs.readFileSync(p).slice(0, 4).toString('latin1') === 'OggS'
  check(ok, `${name} 存在于 lib/sounds/ 且是真 Ogg`)
}

/* ---------------- 7. 材质表本身 ---------------- */
console.log('\n== MATERIAL_SOUNDS ==')
const mapBody = /var MATERIAL_SOUNDS = \{([\s\S]*?)\n  \}/.exec(source)
check(mapBody !== null, '抽到了 MATERIAL_SOUNDS')
if (mapBody) {
  check(/cobblestone:\s*'stone'/.test(mapBody[1]), '圆石 → stone')
  check(/oak:\s*'wood'/.test(mapBody[1]), '原木 → wood')
  check(/iron:\s*'metal'/.test(mapBody[1]), '铁块 → metal')
}

/* ---------------- 8. 南瓜是木头音色，TNT 根本没有挖掘循环 ---------------- */
// m02865 用户两句话：
//   「TNT 在游戏里是一挖就破的，在这里就别加了吧」
//   「南瓜的音效完全不对，你去查查」
// 查下来的事实：
//   - 原版南瓜是 `SoundType.WOOD`。镜像里有 `block/pumpkin/`，但只有 `carve1-2`
//     （剪刀刻南瓜的声音），不是方块被挖的声音 —— 所以南瓜该跟橡木同组。
//   - 原版 TNT 硬度 0，一按就碎，没有挖掘循环，所以它不该出现在 MATERIAL_SOUNDS 里，
//     也不该走 charge 流程。
console.log('\n== 南瓜与 TNT ==')
const mapText = mapBody ? mapBody[1] : ''
check(/pumpkin:\s*'wood'/.test(mapText), '南瓜 → wood（原版南瓜是木头音色，与橡木同组）', mapText.trim())
check(!/tnt:/.test(mapText), 'TNT 不在 MATERIAL_SOUNDS 里（它没有挖掘循环）', mapText.trim())
check(/oak:\s*'wood'/.test(mapText) && /pumpkin:\s*'wood'/.test(mapText), '南瓜与原木真的是同一组（都是 wood）')

const downBody = /var onPointerDown = useCallback\(function \(event\) \{([\s\S]*?)\n    \}, \[/.exec(source)
check(downBody !== null, '抽到了 onPointerDown')
if (downBody) {
  const body = downBody[1]
  const branch = /if \(digFace === 'tnt'\) \{([\s\S]*?)\n      \}/.exec(body)
  check(branch !== null, "TNT 有独立的 instant 分支（if (digFace === 'tnt')）")
  if (branch) {
    const inner = branch[1]
    check(/shatterBlock\(rect\)/.test(inner), 'TNT 一按下就碎（shatterBlock）')
    check(/playBreak\(digFace\)/.test(inner), 'TNT 碎的时候照常播碎裂声')
    check(/onRoll\('hold'\)/.test(inner), 'TNT 碎完仍然走长按那一池事件（碎 = 一次长按）')
    check(/\breturn\b/.test(inner), 'TNT 分支在碎完之后就返回，不进下面的 charge 流程')
    check(!/startDig/.test(inner), 'TNT 不播挖掘循环音（一挖就破，没有循环）')
    check(!/wearPickaxe/.test(inner), 'TNT 不扣镐子耐久（原版挖硬度 0 的方块不掉耐久）')
    check(
      body.indexOf("if (digFace === 'tnt')") < body.indexOf('setChargeLevel(1)'),
      'TNT 分支在「开始计分」之前 —— 它压根不该进入 charge',
    )
    check(body.indexOf('setDragging(true)') < body.indexOf("if (digFace === 'tnt')"), 'TNT 分支排在拖拽登记之后（按住一拖仍然能拖走）')
  }
}

console.log('')
if (fail > 0) {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exit(1)
}
console.log(`ALL GREEN  pass=${pass} fail=${fail} —— 材质、采样族、凑数音三者都对得上。`)