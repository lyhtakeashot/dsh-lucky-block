/**
 * 音效路由端到端探针：在**真实 dsh 进程**上验证 `/dsh-lucky-block/sound/<name>.ogg`。
 *
 * 用法：node tools/probe-sound.mjs [port]
 *   令牌从 docs/.probe-token 读。
 *
 * 为什么必须在真宿主上再测一遍（host-smoke 已经测过路由 handler 了）：
 * host-smoke 是直接调 handler 函数，**绕过了整个 HTTP 层**。真机上还可能栽在：
 *   - 认证中间件把静态文件也拦了（返回 303/401 而不是音频）；
 *   - `prefix` 路由的实际匹配（`pathname !== prefix && !startsWith(prefix + '/')`）
 *     与我读到的源码不符；
 *   - `origin` / `host` 校验（`selfRejection()`）对 <audio> 发出的请求判定不同 ——
 *     浏览器 <audio> 带的是 `Sec-Fetch-*` 而不是我们手写的 header。
 * 这三点都只在真 HTTP 上才暴露，所以这个探针不是冗余。
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`

let TOKEN
try {
  TOKEN = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()
} catch {
  console.error('读不到 docs/.probe-token —— 先启动克隆 profile 并把 token 写进去。')
  process.exit(1)
}

/** 发一个请求，**按二进制收**（音效是 ogg，不能当 utf8 读）。 */
function request(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: Object.assign({ host: HOST }, headers || {}) },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
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
if (cookie.length === 0) {
  console.error('没拿到 cookie（token 过期？）')
  process.exit(1)
}

let fail = 0
const check = (ok, label, detail = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? (ok ? ` (${detail})` : ` —— ${detail}`) : ''}`)
}

/* 三组音各验一个：dig = 挖掘循环（block.stone.hit）、
   glass = 方块碎裂（block.stone.break）、break = 镐子报废（entity.item.break）。
   第三组只在挖够 59 次后才会响，但文件本身必须一直可取 —— 否则第 59 下会静音。 */
const NAMES = ['dig1.ogg', 'dig2.ogg', 'dig3.ogg', 'dig4.ogg', 'glass1.ogg', 'break.ogg']
for (const name of NAMES) {
  // 模拟浏览器 <audio> 的真实请求头：带 Referer/Sec-Fetch，由 cookie 认证。
  const res = await request('GET', `/dsh-lucky-block/sound/${name}`, {
    cookie,
    referer: `http://${HOST}/`,
    'sec-fetch-dest': 'audio',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'same-origin',
    accept: 'audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.5',
  })
  const magic = res.body.slice(0, 4).toString('latin1')
  const bytes = res.body.length
  check(
    res.status === 200 && magic === 'OggS' && bytes > 1000,
    `GET /sound/${name}`,
    `status=${res.status} magic=${JSON.stringify(magic)} bytes=${bytes} ct=${res.headers['content-type']}`,
  )
}

// 穿越尝试在真 HTTP 层也必须被挡（这里不带 cookie 也无所谓，重点是不能吐文件）。
for (const evil of ['../config.json', 'dig1.mp3', 'nope.ogg']) {
  const res = await request('GET', `/dsh-lucky-block/sound/${encodeURIComponent(evil)}`, { cookie })
  const leaked = res.body.slice(0, 4).toString('latin1') === 'OggS' || res.body.toString('utf8').includes('"model"')
  check(!leaked, `拒绝 ${JSON.stringify(evil)}`, `status=${res.status}`)
}

// 缓存头必须带上，否则每 210ms 一次挖掘挖久了会一直打宿主。
const cached = await request('GET', '/dsh-lucky-block/sound/dig1.ogg', { cookie })
check(
  /max-age=\d+/.test(String(cached.headers['cache-control'] || '')),
  'Cache-Control 带 max-age',
  String(cached.headers['cache-control']),
)

console.log('')
if (fail > 0) {
  console.log(`!!! ${fail} 项未通过`)
  process.exit(1)
}
console.log('ALL GREEN —— 音效路由在真实宿主上可用。')
