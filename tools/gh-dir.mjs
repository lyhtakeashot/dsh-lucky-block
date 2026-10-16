// 列 GitHub 仓库某个目录的内容（contents API，返回 base64 解析成 PNG 文件）。
// 用法：
//   node tools/gh-dir.mjs <repo> <dir>
//   node tools/gh-dir.mjs alexsocha/luckyblock common/src/main/resources/game/assets/lucky/textures/block
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    u.protocol = 'https:'
    const req = https.request(
      u,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`))
            return
          }
          resolve(body)
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const [repo, dir] = process.argv.slice(2)
const outDir = path.resolve('research', 'tex', 'destroy')
fs.mkdirSync(outDir, { recursive: true })

const body = JSON.parse((await get(`https://api.github.com/repos/${repo}/contents/${dir}`)).toString('utf8'))
for (const item of body) {
  console.log(`${item.type === 'dir' ? 'D' : 'F'} ${item.name} ${item.size ?? ''}`)
  if (item.type !== 'file' || !/\.png$/i.test(item.name)) continue
  const file = JSON.parse((await get(item.url)).toString('utf8'))
  const buf = Buffer.from(file.content, 'base64')
  const dest = path.join(outDir, `${repo.replace('/', '_')}-${path.basename(dir)}-${item.name}`)
  fs.writeFileSync(dest, buf)
  console.log(`   -> ${dest} (${buf.length} bytes)`)
}
