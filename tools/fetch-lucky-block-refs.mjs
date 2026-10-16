// 抓取 MC 百科幸运方块页面，找出真正的物品贴图链接。
// 只用于开发期取参考图，正式运行不依赖网络。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'research/tex')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Referer: 'https://www.mcmod.cn/class/294.html' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            resolve(get(new URL(res.headers.location, url).href, redirects + 1))
            return
          }
          resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body })
        })
      })
      .on('error', reject)
  })
}

const page = await get('https://www.mcmod.cn/class/294.html')
const html = page.body.toString('utf8')
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'class294.html'), html)
console.log('class294.html len', html.length)

const links = [...new Set([...html.matchAll(/href="([^"]*(?:item|post)\/\d+\.html[^"]*)"/g)].map((m) => m[1]))]
console.log('item/post links:', links.slice(0, 30).join('\n'))

const ids = ['962', '954', '189129', '62548', '52', '960', '963', '1012', '7311']
for (const id of ids) {
  const r = await get(`https://www.mcmod.cn/item/${id}.html`)
  const html2 = r.body.toString('utf8')
  const title = (html2.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, `item ${id}`])[1].replace(/<[^>]+>/g, '').trim()
  const pics = [...new Set([...html2.matchAll(/src="(\/\/i\.mcmod\.cn\/item\/[^"]+)"/g)].map((m) => m[1]))]
  console.log(`\n=== item/${id}  ${title}`)
  console.log('   pics:', pics.length)
  for (const p of pics.slice(0, 6)) console.log('     ', p)
  if (pics.length > 0) {
    fs.writeFileSync(path.join(OUT, `item-${id}.html`), html2)
  }
}