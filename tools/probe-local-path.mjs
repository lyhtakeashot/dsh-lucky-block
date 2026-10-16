/**
 * 本地内容路径端到端探针：验证设置里勾了「不调用 AI」的事件真的零会话返回正文。
 *
 * 用法：node tools/probe-local-path.mjs [port]
 *
 * 为什么单独测（`probe-visual-ids.mjs` 已经会打印 `agent [joke] 新增会话=0`）：
 * 那个脚本只断言「没建会话」，**没断言返回了内容**。而本地路径最容易出的 bug 是
 * 「没建会话，但也没给内容」—— 用户点下去什么都不发生，看起来像插件坏了。
 * 所以这里断言 `localText` 非空、且确实是本地库里的话（逐条比对）。
 *
 * 副作用：会**临时**把 config.json 的 localOnly 改成 ["joke"]，结束时复原。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`
const TOKEN = readFileSync(path.join(ROOT, 'docs', '.probe-token'), 'utf8').trim()

const CONFIG = path.join('C:\\Users\\lyh\\.dsh', 'plugins', 'dsh-lucky-block', 'config.json')
const original = readFileSync(CONFIG, 'utf8')

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

try {
  // 只留 joke 在本地路径上，这样循环掷几次必然撞到它。
  const cfg = JSON.parse(original)
  cfg.localOnly = ['joke']
  // 用 JSON.stringify 写，**不带 BOM**（PowerShell 的 Set-Content 会加，那是另一个坑）。
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')

  // 加载本地库，供逐条比对。
  const jokesMod = await import('../lib/jokes.js')
  const lib = await jokesMod.loadJokeLibrary()
  const known = new Set(lib.jokes.map((j) => j.text))
  check(known.size > 0, `本地笑话库已加载（${known.size} 条）`)

  let seenLocal = 0
  let sawContent = false
  for (let i = 0; i < 24 && !sawContent; i++) {
    const r = await request('POST', '/dsh-lucky-block/roll', H, '{}')
    const j = JSON.parse(r.body)
    const v = j && j.value
    if (!v) { check(false, `第 ${i + 1} 次 roll 返回了 value`, r.body.slice(0, 200)); break }
    if (v.eventId !== 'joke') continue
    seenLocal += 1
    check(v.local === true, `joke 走本地路径（local=true）`, `local=${v.local}`)
    check(v.sessionId === null, 'joke 没建会话（sessionId=null）', `sessionId=${v.sessionId}`)
    check(v.createdNew === false, 'joke 没标记「新建了会话」', `createdNew=${v.createdNew}`)
    const text = typeof v.localText === 'string' ? v.localText : ''
    check(text.trim().length > 0, 'joke 返回了非空正文', `长度 ${text.length}`)
    if (text.trim().length > 0) {
      sawContent = true
      // 正文以「· 」开头（localPayload 的拼装格式），去掉后应与库里某一条对上。
      const body = text.replace(/^[·•\-\s]+/, '').trim()
      check(
        known.has(body) || [...known].some((k) => body.startsWith(k)),
        '返回的正文确实来自本地库（逐条比对）',
        `前 60 字：${body.slice(0, 60)}`,
      )
      console.log(`  正文预览：${text.slice(0, 120).replace(/\n/g, ' / ')}`)
    }
  }
  check(seenLocal > 0, `24 次内至少撞到一次 joke（实际 ${seenLocal} 次）`)
  check(sawContent, '拿到了本地正文')
} finally {
  // 无论成败都复原用户配置 —— 探针不能留下副作用。
  writeFileSync(CONFIG, original, 'utf8')
  console.log('\n配置已复原。')
}

console.log('')
if (fail > 0) { console.log(`!!! ${fail} 项未通过`); process.exit(1) }
console.log('ALL GREEN —— 本地内容路径真的零 token 返回了库里的内容。')
