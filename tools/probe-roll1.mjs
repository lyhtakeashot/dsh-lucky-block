/**
 * 掷一次骰子并打印完整结果，用于端到端验证。
 *
 * 用法：node tools/probe-roll1.mjs <port>
 *   令牌从 docs/.probe-token 读（由启动脚本写入）。
 */

import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`
const TOKEN = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()

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

if (cookie.length === 0) {
  console.error('没拿到 cookie（token 过期？）')
  process.exit(1)
}

const roll = await request(
  'POST',
  '/dsh-lucky-block/roll',
  { cookie, origin: `http://${HOST}`, 'content-type': 'application/json' },
  '{}',
)

console.log(`roll -> ${roll.status}`)
try {
  console.log(JSON.stringify(JSON.parse(roll.body), null, 2))
} catch {
  console.log(roll.body)
}
