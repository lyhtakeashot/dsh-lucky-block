/**
 * 材质检查：lib/textures/ 里的六张原版贴图 + 内联进 client.js 的那份副本。
 *
 * 为什么要单独一个脚本：上一版的「材质」是 CSS 拼的（四个 radial-gradient
 * 当石头斑点、四个圆当铆钉、三段渐变当 TNT），检查全都通过 —— 因为它检查的
 * 是「有没有写 backgroundImage」。长什么样，没有任何一条断言管得着。
 *
 * 这里改成真读像素：把 PNG 解开，算平均色和白色占比，按「这个方块应该长
 * 什么样」断言。它证明不了「好看」，但能证明「这是灰的圆石、棕的原木、
 * 亮的铁块、带白腰带的 TNT」，而不是一片莫名其妙的渐变。
 *
 * 附带一职：client.js 里的 FACE_TEXTURES 是这些 PNG 的 base64 副本，
 * 这里逐字节比对，改图不改表（或改表不改图）会当场红。
 *
 * 用法：
 *   node tools/texture-check.mjs           检查
 *   node tools/texture-check.mjs --emit    从 lib/textures/ 重新生成那张表
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEX_DIR = path.join(root, 'lib', 'textures')
const CLIENT = path.join(root, 'lib', 'client.js')

/* face id → 贴图文件名。两张不是 16×16 一帧的原图：
   命令方块是 16×64 四帧动画，留裁好的第一帧；南瓜用 carved_pumpkin
   （脸上有刻出来的眼睛和嘴），不是 pumpkin_side（那是没刻过的侧面）。
   两者的处理方式见 DESIGN.md §31。

   TNT 那张在 m02957 整个删掉了（用户「TNT 删掉吧」）：它是唯一一张
   「原版一按就碎」的脸，跟按住挖 1.4 秒的流程不合拍。 */
const FILES = {
  cobblestone: 'cobblestone.png',
  oak: 'oak_log.png',
  iron: 'iron_block.png',
  command: 'command_block.png',
  pumpkin: 'pumpkin.png',
}

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass += 1; console.log('PASS ' + label) } else {
    fail += 1
    console.log('FAIL ' + label + ' —— 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected))
  }
}
function checkTrue(label, ok, extra) {
  if (ok) { pass += 1; console.log('PASS ' + label) } else { fail += 1; console.log('FAIL ' + label + (extra ? ' —— ' + extra : '')) }
}

/** 最小 PNG 解码器：只吃本项目用得到的形态（位深 8、无隔行、类型 2/3/6）。
    不装依赖是因为这台机器上装不了（npm 被执行策略拦住），而这些图只有 16×16。 */
export function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG')
  let pos = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8) throw new Error('只支持 8 位，实际 ' + depth)
  if (interlace !== 0) throw new Error('不支持隔行')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]
    p += 1
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = prev[x]
      const upLeft = x >= channels ? prev[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const guess = left + up - upLeft
        const dl = Math.abs(guess - left)
        const du = Math.abs(guess - up)
        const dul = Math.abs(guess - upLeft)
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft
      }
      line[x] = value & 0xff
    }
    line.copy(prev)
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      if (colorType === 3) {
        const idx = line[x]
        pixels[o] = palette[idx * 3]
        pixels[o + 1] = palette[idx * 3 + 1]
        pixels[o + 2] = palette[idx * 3 + 2]
        pixels[o + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (colorType === 2) {
        pixels[o] = line[x * 3]
        pixels[o + 1] = line[x * 3 + 1]
        pixels[o + 2] = line[x * 3 + 2]
        pixels[o + 3] = 255
      } else {
        pixels[o] = line[x * 4]
        pixels[o + 1] = line[x * 4 + 1]
        pixels[o + 2] = line[x * 4 + 2]
        pixels[o + 3] = line[x * 4 + 3]
      }
    }
  }
  return { width, height, pixels }
}

/** 平均色 / 亮度 / 饱和度 / 近白像素占比。透明像素不算。 */
export function colorStats(img) {
  const n = img.width * img.height
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  let white = 0
  for (let i = 0; i < n; i += 1) {
    const pr = img.pixels[i * 4]
    const pg = img.pixels[i * 4 + 1]
    const pb = img.pixels[i * 4 + 2]
    if (img.pixels[i * 4 + 3] < 8) continue
    r += pr
    g += pg
    b += pb
    count += 1
    if (pr > 200 && pg > 200 && pb > 200) white += 1
  }
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    brightness: Math.round((r + g + b) / (3 * count)),
    spread: Math.round((Math.max(r, g, b) - Math.min(r, g, b)) / count),
    whiteRatio: Math.round((white / count) * 1000) / 1000,
  }
}

/** 亮度低于阈值的像素占比（透明像素不算）。用来认「刻出来的脸」：
    那张脸上有一片近黑色的眼睛和嘴，侧面皮上则一处暗部都没有。 */
export function darkRatio(img, threshold) {
  const n = img.width * img.height
  let dark = 0
  let count = 0
  for (let i = 0; i < n; i += 1) {
    if (img.pixels[i * 4 + 3] < 8) continue
    const v = 0.299 * img.pixels[i * 4] + 0.587 * img.pixels[i * 4 + 1] + 0.114 * img.pixels[i * 4 + 2]
    count += 1
    if (v < threshold) dark += 1
  }
  return count === 0 ? 0 : Math.round((dark / count) * 1000) / 1000
}

/* ---------- --emit：从磁盘重生成 client.js 那张表 ---------- */

const clientSrc = fs.readFileSync(CLIENT, 'utf8')
const tableMatch = /var FACE_TEXTURES = \{[\s\S]*?\n  \}/.exec(clientSrc)

if (process.argv.includes('--emit')) {
  const lines = Object.keys(FILES).map((face) => {
    const b64 = fs.readFileSync(path.join(TEX_DIR, FILES[face])).toString('base64')
    return "    " + face + ": '" + b64 + "',"
  })
  console.log('  var FACE_TEXTURES = {')
  console.log(lines.join('\n'))
  console.log('  }')
  process.exit(0)
}

console.log('— 1. 五个材质各有一张 16×16 的图 —')
const images = {}
for (const [face, file] of Object.entries(FILES)) {
  const full = path.join(TEX_DIR, file)
  if (!fs.existsSync(full)) { check(face + ' 的贴图文件在（' + file + '）', false, true); continue }
  const img = decodePng(fs.readFileSync(full))
  images[face] = img
  check(face + ' 是 16×16（原版贴图的尺寸）', [img.width, img.height], [16, 16])
}

console.log('')
console.log('— 2. 每张图的颜色说得通（这是从 CSS 仿制品换回原版的原因）—')
const stats = {}
for (const [face, img] of Object.entries(images)) {
  stats[face] = colorStats(img)
  console.log('  ' + face + ': ' + JSON.stringify(stats[face]))
}
checkTrue('圆石是中性灰（三通道几乎相等）', stats.cobblestone.spread <= 6, 'spread=' + stats.cobblestone.spread)
checkTrue('圆石不亮也不黑（亮度 100~160）', stats.cobblestone.brightness >= 100 && stats.cobblestone.brightness <= 160, 'brightness=' + stats.cobblestone.brightness)
checkTrue('原木是棕的（r > g > b，且 r-b ≥ 40）',
  stats.oak.r > stats.oak.g && stats.oak.g > stats.oak.b && stats.oak.r - stats.oak.b >= 40,
  JSON.stringify(stats.oak))
checkTrue('原木偏暗（亮度 60~110，不是被漂白过的木头）', stats.oak.brightness >= 60 && stats.oak.brightness <= 110, 'brightness=' + stats.oak.brightness)
checkTrue('铁块是亮灰（亮度 ≥ 200 且三通道几乎相等）',
  stats.iron.brightness >= 200 && stats.iron.spread <= 6, JSON.stringify(stats.iron))
checkTrue('命令方块是暖色金属（r > g > b）', stats.command.r > stats.command.g && stats.command.g > stats.command.b, JSON.stringify(stats.command))
/* TNT 那张在 m02957 删掉了，这两条断言随之删除 —— 不是放宽，
   是那个 face 已经不在白名单里，再断言一张不存在的图只会变成噪音。 */
checkTrue('南瓜是橙的（r ≥ 140，g 在 70~120，b ≤ 40）',
  stats.pumpkin.r >= 140 && stats.pumpkin.g >= 70 && stats.pumpkin.g <= 120 && stats.pumpkin.b <= 40,
  JSON.stringify(stats.pumpkin))
/* 正面南瓜（carved_pumpkin）和侧面的南瓜皮最能区分的一点就是那张脸：
   刻出来的眼睛和嘴是近黑色的一整片，占三成左右像素；侧面皮上一个暗像素都没有
   （实测最暗 75/255）。所以这条断言真的在替用户检查「换的是不是有脸的那张」，
   而不是在查「橙不橙」—— 两张都是橙的。 */
const pumpkinDark = darkRatio(images.pumpkin, 60)
checkTrue('南瓜有刻出来的脸（亮度 < 60 的像素 ≥ 15%，侧面皮是 0）',
  pumpkinDark >= 0.15, 'darkRatio=' + pumpkinDark)
checkTrue('五张图两两不同（不是同一张复制了五遍）', (() => {
  const keys = Object.entries(images).map(([face, img]) => face + ':' + img.pixels.toString('base64'))
  return new Set(keys).size === keys.length
})())

console.log('')
console.log('— 3. client.js 里的内联副本与磁盘上的图逐字节一致 —')
checkTrue('client.js 里有 FACE_TEXTURES 表', Boolean(tableMatch))
if (tableMatch) {
  const table = {}
  for (const m of tableMatch[0].matchAll(/\n {4}([A-Za-z-]+): '([A-Za-z0-9+/=]+)',/g)) table[m[1]] = m[2]
  check('表里正好五个材质', Object.keys(table).sort(), Object.keys(FILES).sort())
  for (const [face, file] of Object.entries(FILES)) {
    const b64 = fs.readFileSync(path.join(TEX_DIR, file)).toString('base64')
    check(face + ' 的内联副本与 lib/textures/' + file + ' 一致', table[face] === b64, true)
  }
}

console.log('')
console.log('— 4. 每个形状都真的有一张图 —')
const lookLimits = /faces: \[([^\]]*)\]/.exec(clientSrc)
const faceIds = lookLimits ? lookLimits[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean) : []
check('白名单读到了七个形状（TNT 删掉之后：lucky + 五张材质 + custom）', faceIds.length, 7)
check('除 lucky / custom 外，每个形状都在 FACE_TEXTURES 里',
  faceIds.filter((f) => f !== 'lucky' && f !== 'custom' && !Object.prototype.hasOwnProperty.call(FILES, f)), [])
const luckyUri = /var LUCKY_BLOCK_FACE_URI = 'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(clientSrc)
checkTrue('幸运方块的默认贴图也在（内联 data URI）', Boolean(luckyUri))
if (luckyUri) {
  const lucky = decodePng(Buffer.from(luckyUri[1], 'base64'))
  check('幸运方块贴图也是 16×16', [lucky.width, lucky.height], [16, 16])
}
checkTrue('绘制走 faceFace，且不再有 CSS 图案表（FACE_PATTERNS 已删）',
  /function faceFace\(geometry, isDragging\)/.test(clientSrc) && !/FACE_PATTERNS/.test(clientSrc))

console.log('')
if (fail === 0) console.log('ALL GREEN  pass=' + pass + ' fail=0')
else { console.log('FAILED  pass=' + pass + ' fail=' + fail); process.exitCode = 1 }