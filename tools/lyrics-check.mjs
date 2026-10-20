/**
 * 歌词按时间取句的验证（用户 m18477「歌词只做 NGGYU 的」）。
 *
 * 为什么必须单独立一个工具：歌词错了**不会报错**，只会「慢了半句」
 * 或者「一直显示同一句」。这两件事在界面上都是「看着有点怪」，
 * 用户不会当成 bug 来报，我也没法靠点一下方块复现。
 *
 * lib/client.js 是浏览器 bundle，不能 import，所以用「源码抽取」把
 * lyricLine 连同它的两个闭包变量取出来跑真代码 —— 不复制逻辑，
 * 否则测的是我的理解而不是实现。
 *
 * 用两类输入：
 *   1. lib/lyrics/never-give-you-up.json 的真数据（对齐 42 秒片段）
 *   2. 手写的边界样本（空表、只一句、t 恰好等于当前时刻）
 *
 * 用法：node tools/lyrics-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const source = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ---------- 抽取 lyricLine ---------- */

const methodMatch = source.match(/lyricLine: function \(\) \{[\s\S]*?\n      \}/)
if (!methodMatch) {
  console.error('抽取失败：找不到 lyricLine')
  process.exit(1)
}

/**
 * 造一个「引擎」：把 lyricLine 装进一个带闭包变量的环境里跑。
 * 闭包变量 currentTrack / trackLyrics 由调用方每次重新赋值 ——
 * 真代码里它们就是 createSoundEngine() 作用域里的两个 var。
 */
function makeEngine() {
  const env = `
    var currentTrack = null
    var trackLyrics = null
    var api = { ${methodMatch[0]} }
    return {
      setTrack: function (audio, lyrics) { currentTrack = audio; trackLyrics = lyrics },
      setTime: function (s) { if (currentTrack) currentTrack.currentTime = s },
      line: function () { return api.lyricLine() },
    }
  `
  return new Function(env)()
}

const sample = JSON.parse(readFileSync(path.join(root, 'lib', 'lyrics', 'never-give-you-up.json'), 'utf8'))
  .map((l) => ({ t: l.t, text: l.text }))

/* ---- 1. 真数据：每一句都在它该出现的时候出现 ---- */

function lineAt(engine, seconds) {
  engine.setTrack({ currentTime: seconds }, sample)
  return engine.line()
}

const engine = makeEngine()

check('第一句之前没有歌词', lineAt(engine, 0) === null, String(lineAt(engine, 0)))
check('第一句到点出现', lineAt(engine, 2.5) === 'Never gonna give you up', String(lineAt(engine, 2.5)))
check('第二句到点换掉第一句', lineAt(engine, 4.6) === 'Never gonna let you down', String(lineAt(engine, 4.6)))
check('播到中段仍跟着走', lineAt(engine, 20) === 'Ooh-ooh, give you up', String(lineAt(engine, 20)))
check('接近结尾仍是最后一句', lineAt(engine, 41.5) === "We've known each other for so long", String(lineAt(engine, 41.5)))

/* 逐句核对：每句的起点应当正好是它的 t（+0.1 预判），
   而它的前一句应当一直显示到这一句之前。这是「错位」唯一能被量化的形式。 */
let aligned = true
for (const line of sample) {
  const at = lineAt(engine, line.t + 0.11)
  if (at !== line.text) {
    aligned = false
    console.error(`  对不齐：t=${line.t} 期望「${line.text}」实际「${at}」`)
    break
  }
}
check('每一句都在自己的时间点命中', aligned)

/* 预判窗口的边界：`+ 0.1` 意味着提前 0.1 秒切句。
   两边都盯住 —— 提前太多会显得字幕抢拍，没有预判又会慢半拍。 */
const second = sample[1]
check(
  't-0.05 时已经预判切到本句（预判生效）',
  lineAt(engine, second.t - 0.05) === second.text,
  String(lineAt(engine, second.t - 0.05)),
)
check(
  't-0.2 时仍是上一句（预判没提前更多）',
  lineAt(engine, second.t - 0.2) === sample[0].text,
  String(lineAt(engine, second.t - 0.2)),
)
check(
  't+0.11 时已切到本句（预判生效）',
  lineAt(engine, second.t + 0.11) === second.text,
  String(lineAt(engine, second.t + 0.11)),
)

/* ---- 2. 没有音轨 / 没有歌词时必须是 null ---- */

const empty = makeEngine()
check('没有音轨时返回 null', empty.line() === null, String(empty.line()))
empty.setTrack(null, sample)
check('音轨为 null 时返回 null', empty.line() === null, String(empty.line()))
empty.setTrack({ currentTime: 10 }, null)
check('这首歌没有歌词时返回 null', empty.line() === null, String(empty.line()))
empty.setTrack({ currentTime: 10 }, [])
check('歌词是空数组时返回 null', empty.line() === null, String(empty.line()))

/* ---- 3. currentTime 读不出来时不能抛 ---- */

const broken = makeEngine()
broken.setTrack({ currentTime: NaN }, sample)
check('currentTime 是 NaN 时退化成 0（不抛）', broken.line() === null, String(broken.line()))
broken.setTrack({}, sample)
check('currentTime 缺失时退化成 0（不抛）', broken.line() === null, String(broken.line()))
broken.setTrack({ currentTime: '12' }, sample)
check('currentTime 是字符串时按数字处理', broken.line() === 'Never gonna make you cry', String(broken.line()))

/* ---- 4. 单句样本 ---- */

const single = makeEngine()
single.setTrack({ currentTime: 0.5 }, [{ t: 0, text: 'only one' }])
check('只有一句时从头显示到尾', single.line() === 'only one', String(single.line()))
single.setTime(999)
check('超出最后一句的时间仍显示最后一句', single.line() === 'only one', String(single.line()))

/* ---- 5. 与宿主的契约：t 是片段内秒数 ---- */

const audioSeconds = 42
check(
  '所有歌词时间点都落在音频片段内',
  sample.every((l) => l.t >= 0 && l.t < audioSeconds),
  `片段 ${audioSeconds}s`,
)

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
