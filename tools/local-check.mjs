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

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'} pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
