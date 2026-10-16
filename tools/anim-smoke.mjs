/**
 * 挖掘动画回归：不按 = 无裂纹；按住 = 10 帧逐级推进；到 1 碎裂。
 * 直接从 lib/client.js 取 crackStageIndex，避免测的是复制品。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0))
}

const from = src.indexOf('var DESTROY_STAGE_PX')
const to = src.indexOf('function crackRandom')
const stageBlock = src.slice(from, to)
const fnStart = src.indexOf('function crackStageIndex')
const fnEnd = src.indexOf('\n  }', fnStart) + 4
const fnSrc = src.slice(fnStart, fnEnd)

const stageCount = (stageBlock.match(/data:image\/png;base64,/g) || []).length
const { crackStageIndex } = new Function(
  'clamp',
  stageBlock + '\n' + fnSrc + '\nreturn { crackStageIndex }',
)(clamp)

const frame = (charge) => crackStageIndex(charge / 100)
const fails = []
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) fails.push(`${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} → ${JSON.stringify(actual)}`)
}

check('内联帧数', stageCount, 10)
check('静止（未按下）不渲染裂纹', frame(0), -1)

// 松手 / 拖动后 stopMining 会把进度归零，静止时必须立刻干净。
// （注意 1 是合法值：按下瞬间 chargeLevel 就是 1，见 onPointerDown。）
check('归零后无残留裂纹', crackStageIndex(0) === -1, true)

// 长按 1400ms、每 40ms 一 tick，模拟 onPointerDown/onPointerMove 的真实节拍。
let now = 1000
let charge = 0
const timeline = []
const started = now
charge = 1 // 按下瞬间
timeline.push(frame(charge))
let shattered = false
for (let tick = 1; tick <= 40 && !shattered; tick++) {
  now += 40
  const p = clamp((now - started) / 1400, 0, 1)
  charge = Math.round(p * 100)
  timeline.push(frame(charge))
  if (p >= 1) shattered = true
}
check('按住后出现裂纹', timeline[0] >= 0, true)
check('进度满时方块碎裂（结束挖掘）', shattered, true)
check('碎裂瞬间停在最后一帧', timeline[timeline.length - 1], 9)
check('帧号单调不减', timeline.every((f, i) => i === 0 || f >= timeline[i - 1]), true)
check('10 帧全部出现过', new Set(timeline.filter((f) => f >= 0)).size, 10)
check('每帧停留约 140ms', timeline.length, 36)

console.log(`\n帧序列: ${timeline.join(' ')}`)
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
