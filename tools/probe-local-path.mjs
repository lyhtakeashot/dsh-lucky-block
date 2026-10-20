/**
 * 本地内容路径端到端探针：验证「左键单击」抽到的事件真的零会话、零 token 地返回正文。
 *
 * 用法：node tools/probe-local-path.mjs [port]
 *
 * 为什么单独测（`probe-visual-ids.mjs` 已经会打印 `agent [joke] 新增会话=0`）：
 * 那个脚本只断言「没建会话」，**没断言返回了内容**。而本地路径最容易出的 bug 是
 * 「没建会话，但也没给内容」—— 用户点下去什么都不发生，看起来像插件坏了。
 * 所以这里断言 `localText` 非空、且确实是本地库里的话（逐条比对）。
 *
 * **不需要改配置**：以前要靠 config.json 里的 localOnly 把某个事件切成本地版，
 * 那个开关已经删了。现在「单击 = 本地」是结构性的，`POST {trigger:'click'}` 就够了。
 * 这让本探针变成纯只读 —— 失败也不会污染用户配置。
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`
const TOKEN = readFileSync(path.join(ROOT, 'docs', '.probe-token'), 'utf8').trim()

function request(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: Object.assign({ host: HOST }, headers || {}) },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

let fail = 0
const check = (ok, label, detail = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? (ok ? ` (${detail})` : ` —— ${detail}`) : ''}`)
}

const ex = await request('GET', `/?token=${encodeURIComponent(TOKEN)}`)
const rawCookie = ex.headers['set-cookie']
const list = rawCookie === undefined ? [] : Array.isArray(rawCookie) ? rawCookie : [rawCookie]
const cookie = list.map((c) => String(c).split(';')[0]).join('; ')
if (!cookie) { console.error('没拿到 cookie'); process.exit(1) }
const H = { cookie, origin: `http://${HOST}`, 'content-type': 'application/json' }

// 加载本地库，供逐条比对。
const jokesMod = await import('../lib/jokes.js')
const lib = await jokesMod.loadJokeLibrary()
const knownJokes = new Set(lib.jokes.map((j) => j.text))
check(knownJokes.size > 0, `本地笑话库已加载（${knownJokes.size} 条）`)

const triviaRaw = readFileSync(path.join(ROOT, 'lib', 'trivia-data.json'), 'utf8')
const triviaClean = triviaRaw.charCodeAt(0) === 0xfeff ? triviaRaw.slice(1) : triviaRaw
const knownTrivia = new Set(JSON.parse(triviaClean).map((t) => t.text))
check(knownTrivia.size > 0, `本地冷知识库已加载（${knownTrivia.size} 条）`)

const audioRaw = readFileSync(path.join(ROOT, 'lib', 'audio-tracks.json'), 'utf8')
const audioList = JSON.parse(audioRaw.charCodeAt(0) === 0xfeff ? audioRaw.slice(1) : audioRaw)
const audioTrackCount = Array.isArray(audioList) ? audioList.length : 0
check(audioTrackCount > 0, '曲库非空（audio 事件才会参与抽取）', `${audioTrackCount} 条`)

/* 单击池共 6 条（弹窗/蓝屏/抽签/冷知识/冷笑话/音频），其中 5 条必然出本地内容。
   音频随清单非空才参与抽取 —— 所以这里「撞不撞得到」是**随机**的，不能当硬断言。
   真正要守住的是：万一撞到 audio，它的 `audio` 字段必须是可播放的文件名。 */
const seen = { joke: 0, trivia: 0, fortune: 0 }
const textIds = new Set()
let sawJoke = false
let sawTrivia = false
let agentInClick = 0
let audioInClick = 0
let audioBad = 0

for (let i = 0; i < 60 && !(sawJoke && sawTrivia); i++) {
  const r = await request('POST', '/dsh-lucky-block/roll', H, JSON.stringify({ trigger: 'click' }))
  const j = JSON.parse(r.body)
  const v = j && j.value
  if (!v) { check(false, `第 ${i + 1} 次 roll 返回了 value`, r.body.slice(0, 200)); break }

  /* 核心不变量：**单击永远不建会话**。任何一条单击事件建了会话都是成本泄漏，
     而且是用户完全没预期的那种（他只是点了一下）。 */
  if (v.sessionId !== null) {
    agentInClick += 1
    check(false, `单击事件 ${v.eventId} 建了会话（不该发生）`, `sessionId=${v.sessionId}`)
  }

  const id = v.eventId
  if (id in seen) seen[id] += 1
  if (v.localText) textIds.add(id)
  /* 音频事件随清单非空才参与抽取，而且是**一库一事件**（id 形如 `audio-<文件名>`）。
     撞不到是常态（曲库通常就那么几首），撞到了才要验「给了可播放的文件、且标题非空」。
     所以「撞到 0 次」不能算 FAIL。 */
  if (typeof id === 'string' && id.startsWith('audio-')) {
    audioInClick += 1
    const ok = Boolean(v.audio && typeof v.audio.file === 'string' && v.audio.file.length > 0)
      && Boolean(v.audio && typeof v.audio.title === 'string' && v.audio.title.length > 0)
    if (!ok) audioBad += 1
    check(ok, `${id} 返回了可播放的文件信息`,
      v.audio ? `${v.audio.title} → ${v.audio.file}` : '没有 audio 字段')
  }

  if (id === 'joke' && !sawJoke) {
    const text = String(v.localText || '')
    check(text.trim().length > 0, 'joke 返回了非空正文', `长度 ${text.length}`)
    if (text.trim().length > 0) {
      sawJoke = true
      /* 正文是「笑话正文」或「笑话正文\n\n—— 点评」。点评是独立随机抽的，
         所以只比对笑话那一段是否在库里。 */
      const head = text.split('\n\n')[0].trim()
      check(
        knownJokes.has(head) || [...knownJokes].some((k) => head.startsWith(k)),
        'joke 的正文确实来自本地库（逐条比对）',
        `前 60 字：${head.slice(0, 60)}`,
      )
      console.log(`  joke 预览：${text.slice(0, 100).replace(/\n/g, ' / ')}`)
    }
  }

  if (id === 'trivia' && !sawTrivia) {
    const text = String(v.localText || '').trim()
    check(text.length > 0, 'trivia 返回了非空正文', `长度 ${text.length}`)
    if (text.length > 0) {
      sawTrivia = true
      /* 一次只给一条（用户反馈三条一起出现字太多）。这里不按行拆，直接整段比对：
         整段必须等于库里的某一条，这样「悄悄改回三条」会立刻被这条断言拦下 ——
         三条拼起来永远不等于单条。 */
      check(knownTrivia.has(text), 'trivia 的正文就是本地库里的某一条（不是拼接）', `前 60 字：${text.slice(0, 60)}`)
      check(!text.includes('\n'), 'trivia 只给一条（没有换行拼多条）', `实际 ${text.split('\n').length} 行`)
      check(!/^[·•\-]\s/.test(text), 'trivia 没有列表前缀（不再是多条列表）')
      console.log(`  trivia 预览：${text.slice(0, 80)}`)
    }
  }
}

check(sawJoke, `60 次单击内撞到 joke（实际 ${seen.joke} 次）`)
check(sawTrivia, `60 次单击内撞到 trivia（实际 ${seen.trivia} 次）`)
check(agentInClick === 0, '单击池里没有任何事件建过会话', `${agentInClick} 次违规`)
check(textIds.size > 0, '至少有一条单击事件返回了文本', `实际 ${JSON.stringify([...textIds])}`)
check(audioBad === 0, 'audio 事件（若被抽到）必须带回可播放的文件信息', `违规 ${audioBad} 次`)
if (audioInClick === 0) {
  console.log(`  音频事件 0 次命中（曲库 ${audioTrackCount} 条，撞不到是常态，不算失败）`)
}

/* 反向：长按池必须**建会话**。只测单击不建会话的话，一个「所有事件都不建会话」
   的坏实现也能全绿 —— 那样长按就彻底废了，而本探针看不出来。 */
const hold = await request('POST', '/dsh-lucky-block/roll', H, JSON.stringify({ trigger: 'hold' }))
const holdJson = JSON.parse(hold.body)
const holdValue = holdJson && holdJson.value
check(Boolean(holdValue), '长按 roll 返回了 value', hold.body.slice(0, 200))
if (holdValue) {
  check(
    ['paper', 'news', 'invent'].includes(holdValue.eventId),
    `长按抽到的是 AI 事件（实际 ${holdValue.eventId}）`,
  )
  check(
    typeof holdValue.sessionId === 'string' && holdValue.sessionId.length > 0,
    '长按建了会话（sessionId 非空）',
    `sessionId=${holdValue.sessionId}`,
  )
  check(holdValue.createdNew === true, '长按标记了「新建了会话」', `createdNew=${holdValue.createdNew}`)
  console.log(`  长按事件：${holdValue.eventId} → 会话 ${holdValue.sessionId}`)
}

console.log('')
if (fail > 0) { console.log(`!!! ${fail} 项未通过`); process.exit(1) }
console.log('ALL GREEN —— 单击零会话返回本地内容，长按建会话调 AI。')
