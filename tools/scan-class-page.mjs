// 从已抓取的百科页里找幸运方块相关链接，避免 PowerShell 引号地狱。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(ROOT, 'research/tex/class294.html'), 'utf8')

// 页面上「幸运方块」四个字附近的所有链接
const seen = new Set()
const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g
for (const m of html.matchAll(re)) {
  const text = m[2].replace(/<[^>]+>/g, '').trim()
  if (!text) continue
  if (!/幸运|方块|Lucky/i.test(text)) continue
  const key = m[1] + text
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`${m[1]}\n    -> ${text.slice(0, 60)}`)
}

// 页面里所有出现的 i.mcmod.cn/item/ 或 /item/ 数字 id
const ids = [...new Set([...html.matchAll(/(?:\/item\/(\d+)\.html|item\/icon\/[^\d]*(\d+)\/(\d+)\.png)/g)].map((m) => m[1] || m[2]))]
console.log('\nall item ids on page:', ids.join(' '))