// 下载指定 MC 百科物品条目的 128x128 贴图，供肉眼比对。
// 用法：node tools/download-item-icon.mjs 885236 962
// 只用于开发期取参考图，正式运行不依赖网络。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'research/tex')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

function get(url, redirects = 0) {
  const u = new URL(url)
  u.protocol = 'https:'
  return new Promise((resolve, reject) => {
    https
      .get(u, { headers: { 'User-Agent': UA, Referer: 'https://www.mcmod.cn/' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            resolve(get(new URL(res.headers.location, u.href).href, redirects + 1))
            return
          }
          resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) })
        })
      })
      .on('error', reject)
  })
}

fs.mkdirSync(OUT, { recursive: true })
for (const raw of process.argv.slice(2)) {
  const itemId = raw.replace(/\D/g, '')
  // 先读条目页拿标题与真实图标路径
  const page = await get(`https://www.mcmod.cn/item/${itemId}.html`)
  const html = page.body.toString('utf8')
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].replace(/<[^>]+>/g, '').split(' - ')[0].trim()
  const icon = (html.match(/\/\/i\.mcmod\.cn\/item\/icon\/128x128\/[^"'\s]+\.(?:png|jpg)/) || [])[0]
  console.log(`\nitem/${itemId}  ${title}\n   icon: ${icon || '(none found)'}`)
  if (!icon) {
    const any = [...new Set([...html.matchAll(/[^"'\s]*item\/icon[^"'\s]*/g)].map((m) => m[0]))]
    console.log('   any icon-ish path:', any.slice(0, 8))
    continue
  }
  const r = await get('https:' + icon)
  const ext = r.type.includes('png') ? 'png' : 'jpg'
  const file = path.join(OUT, `item-${itemId}.${ext}`)
  fs.writeFileSync(file, r.body)
  console.log(`   -> ${r.status} ${r.body.length}B saved ${path.basename(file)}`)
}