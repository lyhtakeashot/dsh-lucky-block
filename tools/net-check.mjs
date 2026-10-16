// 网络连通性体检：npm registry 与 GitHub 各试 3 次，判断是持续断还是抖动。
// 只用 node https（PowerShell 的 Invoke-WebRequest 在本机 HTTPS 上有已知问题）。
import https from 'node:https'

const targets = [
  ['registry.npmjs.org', '/@linxin666%2Fdsh-client-ui-git-graph'],
  ['github.com', '/'],
]

function probe(host, path) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = https.request(
      {
        host,
        path,
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126' },
        timeout: 30000,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ ok: res.statusCode < 500, code: res.statusCode, ms: Date.now() - started }))
      },
    )
    req.on('error', (e) => resolve({ ok: false, code: e.code || e.message, ms: Date.now() - started }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, code: 'TIMEOUT', ms: Date.now() - started })
    })
    req.end()
  })
}

for (const [host, path] of targets) {
  for (let i = 1; i <= 3; i += 1) {
    const r = await probe(host, path)
    console.log(`${host} #${i}: ok=${r.ok} result=${r.code} ${r.ms}ms`)
  }
}
