/**
 * 采样宿主的模型目录，确认「骰子会话指定模型」该用什么 provider/model 名。
 *
 * 为什么需要它：profile 的 cordis.patch.yml 里写的是 `workbuddy`，而会话投影缓存里
 * 实际记录的是 `workbuddy-ai` —— 命名不一致，**不能硬编码**。真实可用清单只能从
 * 宿主的 modelCatalog 里读。
 *
 * 用法：node tools/probe-models.mjs <port> <launchToken>
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

const exchange = await request('GET', `/?token=${encodeURIComponent(token)}`)
const raw = exchange.headers['set-cookie']
const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
const cookie = list.map((c) => String(c).split(';')[0]).join('; ')
if (cookie.length === 0) {
  console.error('没拿到 cookie，token 可能过期了')
  process.exit(1)
}

/* 模型目录走宿主的 RPC 通道。桌面/网页端用 POST /api 调 remote 服务；
   这里用插件自己的 ping 顺带暴露的信息做交叉验证即可 ——
   真正的目录枚举留给需要时再补。 */
const ping = await request('GET', '/dsh-lucky-block/ping', {
  cookie,
  origin: `http://${HOST}`,
})
console.log('ping:', ping.status)
try {
  const parsed = JSON.parse(ping.body)
  console.log(JSON.stringify(parsed, null, 2))
} catch {
  console.log(ping.body.slice(0, 800))
}
