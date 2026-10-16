// 下载 MC 百科上疑似幸运方块本体的 128x128 图标，供肉眼比对。
// 只用于开发期取参考图，正式运行不依赖网络。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'research/tex')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

const CANDIDATES = [
  'https://i.mcmod.cn/item/icon/128x128/18/189129.png?v=10',
  'https://i.mcmod.cn/item/icon/128x128/6/62548.png?v=14',
  'https://i.mcmod.cn/item/cover/20251012/1760213813_2_NCwh.jpg@170x115.jpg',
]

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Referer: 'https://www.mcmod.cn/' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            resolve(get(new URL(res.headers.location, url).href, redirects + 1))
            return
          }
          resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) })
        })
      })
      .on('error', reject)
  })
}

fs.mkdirSync(OUT, { recursive: true })
for (const url of CANDIDATES) {
  const r = await get(url)
  const slug = url.match(/\/([^/]+)\.(\w+)\?/)[1] + '-' + url.match(/\/(\d+)\/\d+\./)[1]
  const ext = r.type.includes('png') ? 'png' : r.type.includes('jpeg') || r.type.includes('jpg') ? 'jpg' : 'bin'
  const file = path.join(OUT, `ref-${slug}.${ext}`)
  fs.writeFileSync(file, r.body)
  // 嗅探真实魔数：站点经常 .jpg 实际返回 png
  const magic = [...r.body.slice(0, 4)].map((b) => b.toString(16)).join(' ')
  console.log(`${url}\n  -> ${r.status} ${r.type} ${r.body.length}B magic=${magic} saved ${path.basename(file)}`)
}