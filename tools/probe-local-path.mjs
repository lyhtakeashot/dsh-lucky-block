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

/* 单击池共 6 条（弹窗/蓝屏/抽签/冷知识/冷笑话/音频），其中 4 条必然出本地内容
   —— 音频现在抽不到（清单为空）。60 次里撞不到 joke 的概率极低，
   撞不到冷知识更低 —— 两条都要撞到才算真的验过。 */
const seen = { joke: 0, trivia: 0, fortune: 0 }
const textIds = new Set()
let sawJoke = false
let sawTrivia = false
let agentInClick = 0
let audioInClick = 0

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
  /* 音频事件现在抽不到（清单是空的），真抽到了说明有人已经填了清单 —— 那时要验的
     是「给了音频字段、且有对应文件」，而不是现在的「事件不该出现」。 */
  if (id === 'audio') {
    audioInClick += 1
    check(
      Boolean(v.audio && v.audio.file && v.audio.title),
      'audio 事件返回了可播放的文件信息',
      v.audio ? `${v.audio.title} → ${v.audio.file}` : '没有 audio 字段',
    )
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
    const text = String(v.localText || '')
    check(text.trim().length > 0, 'trivia 返回了非空正文', `长度 ${text.length}`)
    if (text.trim().length > 0) {
      sawTrivia = true
      /* trivia 是 3 条以「· 」开头的列表。逐行剥掉前缀后，每行都该在库里。 */
      const rows = text.split('\n').map((line) => line.replace(/^[·•\-\s]+/, '').trim()).filter(Boolean)
      check(rows.length > 0, `trivia 至少给了一条（实际 ${rows.length} 条）`)
      const allKnown = rows.every((row) => knownTrivia.has(row))
      check(allKnown, 'trivia 的每一条都来自本地库（逐条比对）', allKnown ? '' : `可疑：${rows.find((r) => !knownTrivia.has(r))?.slice(0, 50)}`)
      console.log(`  trivia 预览：${rows[0]?.slice(0, 80)}`)
    }
  }
}

check(sawJoke, `60 次单击内撞到 joke（实际 ${seen.joke} 次）`)
check(sawTrivia, `60 次单击内撞到 trivia（实际 ${seen.trivia} 次）`)
check(agentInClick === 0, '单击池里没有任何事件建过会话', `${agentInClick} 次违规`)
check(textIds.size > 0, '至少有一条单击事件返回了文本', `实际 ${JSON.stringify([...textIds])}`)
check(audioInClick === 0, '清单为空时 audio 事件不参与抽取（现在不该被抽到）', `实际 ${audioInClick} 次`)

/* 反向：长按池必须**建会话**。只测单击不建会话的话，一个「所有事件都不建会话」
   的坏实现也能全绿 —— 那样长按就彻底废了，而本探针看不出来。 */
const hold = await request('POST', '/dsh-lucky-block/roll', H, JSON.stringify({ trigger: 'hold' }))
const holdJson = JSON.parse(hold.body)
const holdValue = holdJson && holdJson.value
check(Boolean(holdValue), '长按 roll 返回了 value', hold.body.slice(0, 200))
if (holdValue) {
  check(
    ['paper', 'news', 'todo-shuffle'].includes(holdValue.eventId),
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
