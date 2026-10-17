/**
 * 判定性验证：视觉事件不建会话、不调 AI。
 *
 * 这个脚本的存在理由是一次**误判**：最早用「会话缓存文件数」当信号，结果视觉事件
 * 老是被判失败。查下来是信号本身被污染 —— agent 事件也是同一循环里抽的，而它的
 * 会话是**异步**落盘的，于是视觉事件那一步会「看到」别的 agent 事件稍后补上的文件。
 * 会话数不是可信判据。
 *
 * 改成直接跟踪**新出现的会话 id**：每次掷完等 1.5s（够新会话落盘），列出目录，
 * 把「这次新冒出来的 id」记下来。若某个新 id 恰好等于某次 roll 返回的 sessionId，
 * 就认领它（说明那是 agent 事件建的）；反之若出现「没有任何 roll 认领的新会话」，
 * 才是真的视觉事件偷偷建了会话。
 *
 * 注意：无人认领的会话也可能是**别的会话**（用户在别的工作区同时干活）恰好此刻落盘。
 * 所以脚本只报告不武断 —— 看到 unclaimed 时要人工看一眼那个会话的 cwd 与首条消息，
 * 确认是不是本插件产生的。
 *
 * 2026-10-17 起循环里轮转 click / hold 两个池：视觉事件全归了左键单击
 * （用户 m09978 的分流），只打默认的 hold 池永远抽不到它们。
 *
 * 实测结论（2026-10-16）：连续 6 次视觉事件（popups/bluescreen）全部
 * `local=true sessionId=null 新增会话=0`；唯一一个 unclaimed 会话经查
 * cwd 指向用户另一个工作区、内容是无关的联网考据，与本插件无关。
 *
 * 用法：node tools/probe-visual-ids.mjs <port>
 */

import { readFileSync, readdirSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`
const TOKEN = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()
const SESSION_DIR = 'C:\\Users\\lyh\\.dsh\\storages\\session_projcache\\sessions'

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

const exchange = await request('GET', `/?token=${encodeURIComponent(TOKEN)}`)
const raw = exchange.headers['set-cookie']
const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
const cookie = list.map((c) => String(c).split(';')[0]).join('; ')
const HEADERS = { cookie, origin: `http://${HOST}`, 'content-type': 'application/json' }

const listSessions = () =>
  new Set(readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')))

const ping = await request('GET', '/dsh-lucky-block/ping', HEADERS)
const visualIds = (JSON.parse(ping.body).value?.events || [])
  .filter((e) => e.kind === 'visual')
  .map((e) => e.id)
console.log(`visual 事件: ${JSON.stringify(visualIds)}\n`)

const known = listSessions()
const claimed = new Set() // 被某次 roll 返回的 sessionId 认领过的新会话
const unclaimed = new Set() // 冒出来但没有任何 roll 认领 —— 这才是异常
let visualChecked = 0
let failures = 0

/* 两个池都打：**视觉事件全在 click 池**（popups/bluescreen 现在归左键单点），
   而 agent 事件全在 hold 池。只打一个池就只能验到一半，而且
   `/roll` 不传 trigger 时默认走 hold，视觉事件会永远抽不到。
   轮转着打还能顺带让 agent 事件继续贡献「认领新会话」这条交叉验证。 */
const TRIGGERS = ['click', 'hold']

for (let i = 0; i < 60 && visualChecked < 6; i += 1) {
  const trigger = TRIGGERS[i % TRIGGERS.length]
  const roll = await request(
    'POST',
    '/dsh-lucky-block/roll',
    HEADERS,
    JSON.stringify({ trigger }),
  )
  if (roll.status !== 200) {
    failures += 1
    continue
  }
  const value = JSON.parse(roll.body).value
  const isVisual = visualIds.includes(value.eventId)

  // 给新会话一点时间落盘（agent 事件是异步建会话的）。
  await new Promise((r) => setTimeout(r, 1500))
  const now = listSessions()
  const fresh = [...now].filter((id) => !known.has(id))
  for (const id of fresh) {
    known.add(id)
    if (value.sessionId && id === value.sessionId) claimed.add(id)
    else unclaimed.add(id)
  }

  if (isVisual) {
    visualChecked += 1
    const problems = []
    if (value.local !== true) problems.push(`local=${JSON.stringify(value.local)}`)
    if (value.sessionId !== null) problems.push(`sessionId=${JSON.stringify(value.sessionId)}`)
    if (!value.visual) problems.push('无 visual spec')
    if (value.createdNew !== false) problems.push(`createdNew=${JSON.stringify(value.createdNew)}`)
    if (problems.length > 0) {
      failures += 1
      console.log(`  FAIL  [${value.eventId}] ${problems.join('; ')}`)
    } else {
      console.log(`  PASS  [${value.eventId}] local=true sessionId=null visual=${value.visual.kind} 新增会话=${fresh.length}`)
    }
  } else {
    console.log(
      `  ${trigger === 'click' ? 'click' : 'hold'} [${value.eventId}] 新增会话=${fresh.length} 认领=${fresh.includes(value.sessionId) ? 'yes' : 'no'}`,
    )
  }
}

console.log('')
console.log(`验证视觉事件 ${visualChecked} 次`)
console.log(`新会话 ${claimed.size} 个已被 roll 返回值认领；${unclaimed.size} 个无人认领`)
if (unclaimed.size > 0) {
  console.log(`无人认领的会话: ${JSON.stringify([...unclaimed])}`)
  console.log('请人工确认这些会话不是本插件建的（看 cwd 与首条用户消息）：')
  console.log('  node -e "const j=require(\'C:/Users/lyh/.dsh/storages/session_projcache/sessions/<id>.json\').record;console.log(j.identity.cwd, j.rows.titleInput?.val?.first?.text?.slice(0,80))"')
}

// 判据：每次视觉事件的 payload 正确 + 没有任何**由某个视觉事件那一步**产生的会话。
// unclaimed 只提示、不直接判失败，因为它可能是别的工作区同时在跑的会话。
if (failures > 0) {
  console.error('FAIL  视觉事件的返回 payload 不符合预期')
  process.exit(1)
}
if (unclaimed.size > 0) {
  console.log('')
  console.log('注意：有无人认领的会话，需人工核对后再下结论（见上面的检查命令）。')
}
console.log('ALL GREEN  视觉事件的 payload 全部正确（local=true, sessionId=null, 带 visual spec）')
