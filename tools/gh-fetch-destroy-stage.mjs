// 下载原版 MC 方块的 10 张挖掘裂纹贴图 destroy_stage_0..9.png。
// 用法：node tools/gh-fetch-destroy-stage.mjs
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REPO = 'PixiGeko/Minecraft-default-assets'
const DIR = 'assets/minecraft/textures/block'

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
            reject(new Error(`HTTP ${res.statusCode} ${url}`))
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

const outDir = path.resolve('research', 'tex', 'destroy-stage')
fs.mkdirSync(outDir, { recursive: true })

for (let i = 0; i < 10; i += 1) {
  const file = `destroy_stage_${i}.png`
  const json = JSON.parse(
    (await get(`https://api.github.com/repos/${REPO}/contents/${DIR}/${file}`)).toString('utf8'),
  )
  const buf = Buffer.from(json.content, 'base64')
  fs.writeFileSync(path.join(outDir, file), buf)
  console.log(`${file} ${buf.length} bytes`)
}
