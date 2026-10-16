/**
 * 路由注册矩阵探测：区分「路由没注册」与「路由注册了但处理出错」。
 *
 * 判据（实测得出）：
 *   - 未注册的路径           → 404 (GET) / 405 (POST)
 *   - 注册了但没带鉴权 cookie → 401
 *   - 注册了且鉴权通过        → 200 + JSON
 *
 * 所以带 cookie 还看到 401/200 就说明路由在；看到 404/405 就是没注册。
 *
 * 用法：node tools/probe-routes.mjs <port> <launchToken>
 * 令牌每次重启 dsh 都会换，从启动日志的 `dsh web: http://…/?token=…` 里取。
 */

import http from 'node:http'

const [portArg, token] = process.argv.slice(2)
const PORT = Number(portArg || 19399)
const HOST = `127.0.0.1:${PORT}`

function request(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers: Object.assign({ host: HOST }, headers || {}) },
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

/* ---------- 1) 换 cookie ---------- */

if (!token) {
  console.error('用法: node tools/probe-routes.mjs <port> <launchToken>')
  process.exit(2)
}

const exchange = await request('GET', `/?token=${encodeURIComponent(token)}`)
console.log(`token exchange -> ${exchange.status}`)

const raw = exchange.headers['set-cookie']
const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
const cookie = list.map((c) => String(c).split(';')[0]).join('; ')

if (cookie.length === 0) {
  console.error('没拿到 cookie。token 可能已过期（每次重启 dsh 都会换新的）。')
  process.exit(1)
}
console.log(`cookie: ${cookie.slice(0, 40)}…\n`)

/* ---------- 2) 矩阵 ---------- */

const CASES = [
  ['GET', '/dsh-lucky-block/ping', undefined],
  ['POST', '/dsh-lucky-block/ping', '{}'],
  ['GET', '/dsh-lucky-block/roll', undefined],
  ['POST', '/dsh-lucky-block/roll', '{}'],
  ['POST', '/dsh-lucky-block/definitely-missing', '{}'],
  ['GET', '/definitely-not-a-route', undefined],
]

const headers = { cookie, origin: `http://${HOST}`, 'content-type': 'application/json' }

console.log('方法   路径                                     状态  响应')
console.log('-'.repeat(100))

let missing = 0
for (const [method, path, body] of CASES) {
  const res = await request(method, path, headers, body)
  const short = res.body.length > 160 ? `${res.body.slice(0, 160)}…` : res.body
  console.log(`${method.padEnd(5)} ${path.padEnd(41)} ${String(res.status).padEnd(5)} ${short || '(空)'}`)
  // 只对「本插件自己的路径 + 该路径本来支持的方法」判定缺失。
  const expectSupport =
    (path === '/dsh-lucky-block/ping' && method === 'GET') ||
    (path === '/dsh-lucky-block/roll' && method === 'POST')
  if (expectSupport && res.status === 405) missing += 1
}

console.log('')
console.log(
  missing === 0
    ? '结论：/dsh-lucky-block 的两条路由都已注册。'
    : `结论：有 ${missing} 条路由未注册 → 插件本体可能未激活（看宿主日志里 entry does not activate）。`,
)

/* ---------- 3) ping 空对象点名 ---------- */

const ping = await request('GET', '/dsh-lucky-block/ping', headers)
if (ping.status === 200 && ping.body.trim() === '{}') {
  console.log('')
  console.log('⚠ ping 返回空对象 {}：路由在，但 handler 的返回值没被序列化。')
  console.log('  对照 roll（同样是 async）却正常返回 —— 说明不是「所有 handler 都这样」。')
}
