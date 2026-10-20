/**
 * 本地内容路径的行为测试。
 *
 * 为什么不能只靠 host-smoke：smoke 只验证「注册了路由 / 清单里有标记」，
 * 而这里要验证**真的能取出内容**，且内容符合契约。
 *
 * 做法：不去复现 lib/index.js 里的抽取逻辑（那样测的是我的理解，不是代码），
 * 改为直接测它依赖的三个数据源 + 不变量：
 *   1. 冷笑话库读得到、条数够、无脏数据
 *   2. 冷知识库同上
 *   3. 音频曲库的清单格式，且引用的文件真的在 lib/audio/ 里
 *
 * 「单击/长按各抽哪个池」的语义由 tools/host-smoke.mjs 对着真实事件表验证，
 * 不在这里复现 —— 那是最容易和实现分叉的地方。
 *
 * 用法：node tools/local-check.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadJokeLibrary } from '../lib/jokes.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/* --- 1. 冷笑话库 --- */
const { jokes, quips } = await loadJokeLibrary()
check('笑话库非空', jokes.length >= 100, `实际 ${jokes.length}`)
check('点评库非空', quips.length >= 10, `实际 ${quips.length}`)
check('笑话无空文本', jokes.every((j) => j.text.trim().length > 0))
check('笑话无英文标点', jokes.every((j) => !/[,;:!?]/.test(j.text)), jokes.find((j) => /[,;:!?]/.test(j.text))?.text?.slice(0, 40))
check('笑话有结构分类', jokes.every((j) => typeof j.form === 'string' && j.form.length > 0))
check('笑话文本无重复', new Set(jokes.map((j) => j.text)).size === jokes.length)
check('点评无重复', new Set(quips).size === quips.length)
// form 绝不能出现在正文里（否则会泄漏给用户）
check('正文不含 form 标注', jokes.every((j) => !j.text.includes(j.form)))

/* --- 2. 冷知识库 --- */
const triviaRaw = await readFile(path.join(root, 'lib', 'trivia-data.json'), 'utf8').catch(() => null)
check('trivia-data.json 存在', triviaRaw !== null)
if (triviaRaw) {
  const clean = triviaRaw.charCodeAt(0) === 0xfeff ? triviaRaw.slice(1) : triviaRaw
  let trivia = null
  try {
    trivia = JSON.parse(clean)
  } catch (error) {
    check('trivia-data.json 可解析', false, error.message)
  }
  if (Array.isArray(trivia)) {
    // 下限设为 100：种子数据只有 20 条时这里必须是红的 —— 它是在提醒
    // 「语料还没补全」，不是在报一个格式错误。
    check('冷知识条数 ≥ 100', trivia.length >= 100, `实际 ${trivia.length}`)
    check('冷知识每项有 text', trivia.every((t) => t && typeof t.text === 'string' && t.text.trim().length > 0))
    check('冷知识每项有 topic', trivia.every((t) => t && typeof t.topic === 'string' && t.topic.length > 0))
    check('冷知识文本无重复', new Set(trivia.map((t) => t.text)).size === trivia.length)
    check('冷知识单条 ≤ 120 字', trivia.every((t) => t.text.length <= 120), `最长 ${Math.max(...trivia.map((t) => t.text.length))}`)
    const topics = {}
    for (const t of trivia) topics[t.topic] = (topics[t.topic] ?? 0) + 1
    console.log('冷知识 topic 分布:', JSON.stringify(topics))
  } else if (trivia !== null) {
    check('trivia-data.json 是数组', false, typeof trivia)
  }
}

/* --- 3. 音频曲库 ---
   曲库清单是 `lib/audio-tracks.json`，音频文件放 `lib/audio/`。
   这里只查「清单格式对、引用的文件在」—— 清单**允许为空**（用户还没给清单），
   为空时事件会被 buildEvents 整个摘掉，那是正常状态，不是失败。
   所以下面用「清单为空就只打印一句」而不是断言条数下限。 */
const tracksRaw = await readFile(path.join(root, 'lib', 'audio-tracks.json'), 'utf8').catch(() => null)
check('audio-tracks.json 存在', tracksRaw !== null)
if (tracksRaw !== null) {
  const clean = tracksRaw.charCodeAt(0) === 0xfeff ? tracksRaw.slice(1) : tracksRaw
  let tracks = null
  try {
    tracks = JSON.parse(clean)
  } catch (error) {
    check('audio-tracks.json 可解析', false, error.message)
  }
  if (tracks !== null) {
    check('audio-tracks.json 是数组', Array.isArray(tracks), typeof tracks)
    if (Array.isArray(tracks)) {
      /* 文件名白名单必须与宿主 localAudioTracks() 和 /audio 路由**逐字一致**。
         三处任何一处放宽，都会让一个能被清单引用、却取不到（或取到了不该给的）
         文件溜进来。这里把规则抄一遍是有意的冗余：改规则时这里会红。 */
      const NAME_RE = /^[A-Za-z0-9_-]+\.(ogg|mp3)$/
      check(
        '曲库条目都有合法 file',
        tracks.every((t) => t && typeof t.file === 'string' && NAME_RE.test(t.file)),
        tracks.find((t) => !(t && typeof t.file === 'string' && NAME_RE.test(t.file)))?.file,
      )
      check('曲库文件名无重复', new Set(tracks.map((t) => t.file)).size === tracks.length)
      check(
        '曲库 title 若存在必须非空',
        tracks.every((t) => t.title === undefined || (typeof t.title === 'string' && t.title.trim().length > 0)),
      )
      if (tracks.length === 0) {
        console.log('曲库为空（清单还没给），音频事件会被整条摘掉 —— 这是正常状态')
      } else {
        const present = new Set(await readdir(path.join(root, 'lib', 'audio')).catch(() => []))
        const missing = tracks.map((t) => t.file).filter((f) => !present.has(f))
        check('曲库引用的文件都在 lib/audio/', missing.length === 0, `缺 ${JSON.stringify(missing)}`)
        console.log(`曲库 ${tracks.length} 条：${tracks.map((t) => t.title || t.file).join('、')}`)
      }
    }
  }
}

/* --- 4. 歌词时间轴 ---
   只对做了歌词的歌检查（现在只有 never-give-you-up）。三个必须同时成立才算对：
     1. 文件名与曲库里的 ogg 同名 —— 宿主按 `<文件名去掉后缀>.json` 去找，
        名字对不上就静默变成「这首歌没歌词」，界面上看不出来；
     2. `t` 严格递增且都落在片段时长内 —— 时间轴是**片段内**秒数，
        拿原曲 LRC 直接喂进来会整首错位（那段副歌是从原曲 100 秒处剪的）；
     3. 第一句不能晚于 5 秒 —— 晚了会出现「音乐在放、字幕半天不出来」。
   时长从 ogg 的 Vorbis 头部读太麻烦，这里用登记的期望时长。 */
const LYRICS = [
  // 片段 42 秒（原曲 100~142 秒的副歌），见 README 的音频来源说明
  { stem: 'never-give-you-up', seconds: 42 },
]
for (const entry of LYRICS) {
  const file = path.join(root, 'lib', 'lyrics', `${entry.stem}.json`)
  const raw = await readFile(file, 'utf8').catch(() => null)
  check(`歌词 ${entry.stem}.json 存在`, raw !== null)
  if (raw === null) continue
  let lines = null
  try {
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    lines = JSON.parse(clean)
  } catch (error) {
    check(`歌词 ${entry.stem}.json 可解析`, false, error.message)
    continue
  }
  check(`歌词 ${entry.stem}.json 是数组`, Array.isArray(lines), typeof lines)
  if (!Array.isArray(lines)) continue
  check(`歌词 ${entry.stem} 非空`, lines.length > 0, `${lines.length} 行`)
  check(
    `歌词 ${entry.stem} 每行都是 {t, text}`,
    lines.every((l) => l && Number.isFinite(l.t) && typeof l.text === 'string' && l.text.trim().length > 0),
  )
  check(`歌词 ${entry.stem} 的 t 从 0 开始不越界`, lines.every((l) => l.t >= 0 && l.t < entry.seconds), `片段 ${entry.seconds}s`)
  let ascending = true
  for (let i = 1; i < lines.length; i += 1) if (lines[i].t <= lines[i - 1].t) ascending = false
  check(`歌词 ${entry.stem} 的 t 严格递增`, ascending)
  check(`歌词 ${entry.stem} 第一句不晚于 5 秒`, lines.length > 0 && lines[0].t <= 5, `第一句 ${lines[0]?.t}s`)
  /* 不检查「文本无重复」：副歌本来就会把同一句唱两遍，
     这个断言会把一条正确的歌词文件判红。真正该管的是长度 ——
     歌词条宽 `min(80vw, 760px)`、17px 字号，一行大约放得下 55~60 个
     半角字符；超过了就会折成两行，而在底部它是从下往上顶的，
     两行会盖住更多画面。 */
  check(
    `歌词 ${entry.stem} 每行不超过 60 字符`,
    lines.every((l) => l.text.length <= 60),
    `最长 ${Math.max(...lines.map((l) => l.text.length))}`,
  )
  check(
    `歌词 ${entry.stem} 有对应的音频文件`,
    (await readdir(path.join(root, 'lib', 'audio')).catch(() => [])).some((f) => f.replace(/\.(ogg|mp3)$/i, '') === entry.stem),
  )
}

/* --- 5. 数据目录必须随包发布 ---
   `package.json` 的 `files` 是一份白名单：没写进去的目录**不会**进 npm 包。
   加 `lib/lyrics/` 时就是漏了这一条 —— 本地跑得好好的（源码目录里有文件），
   装到别人机器上就变成「每首歌都没歌词」，而且不报错。
   所以这里不逐个点名，而是扫 `lib/` 下所有**被运行时读取**的子目录，
   与 `files` 清单对照。 */
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const shipped = new Set(pkg.files ?? [])
const dataDirs = (await readdir(path.join(root, 'lib'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => `lib/${entry.name}`)
check('files 清单非空', shipped.size > 0)
for (const dir of dataDirs) {
  check(`数据目录 ${dir}/ 随包发布`, shipped.has(dir), `package.json 的 files 里没有它`)
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
