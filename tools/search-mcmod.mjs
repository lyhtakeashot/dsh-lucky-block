// 解析 MC 百科搜索结果页，提取物品/Mod 条目链接。
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
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      .on('error', reject)
  })
}

fs.mkdirSync(OUT, { recursive: true })
// 其它幸运方块 mod 的条目页常有「相关物品」区直接露出方块贴图
const PAGES = [
  'https://www.mcmod.cn/class/2824.html',
  'https://www.mcmod.cn/class/20056.html',
  'https://www.mcmod.cn/class/17215.html',
]
const ALL = new Set()
for (const url of PAGES) {
  const html = (await get(url)).body
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim()
  console.log(`\n=== ${url} ${(html.length)}B  ${title.slice(0, 50)}`)
  const ids = [...new Set([...html.matchAll(/\/item\/(\d+)\.html/g)].map((m) => m[1]))]
  console.log('   item ids:', ids.slice(0, 40).join(' '))
  for (const id of ids) ALL.add(id)
  fs.writeFileSync(path.join(OUT, `page-${url.match(/\/(\d+)\.html/)[1]}.html`), html)
}
console.log('\nunion of all item ids:', [...ALL].sort((a, b) => a - b).join(' '))