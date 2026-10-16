// 从 app.asar 提取某个包目录下的文件（按 offset 直接 seek，不整体解析超大 header）。
// 用法: node tools/asar-pkg.mjs <包路径片段> [输出目录]
import fs from 'node:fs'
import path from 'node:path'

const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'
const needle = process.argv[2]
const outDir = process.argv[3] || 'research/asar'

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerPickleLen = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(8)
const offsetBase = 16 + headerPickleLen

const headerBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, headerBuf, 0, jsonLen, 16)
const header = JSON.parse(headerBuf.toString('utf8'))

const hits = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else if (p.includes(needle)) hits.push({ path: p, size: entry.size, offset: Number(entry.offset) })
  }
}
walk(header, '')

fs.mkdirSync(outDir, { recursive: true })
let n = 0
for (const h of hits) {
  if (h.size > 2_000_000) continue
  const buf = Buffer.alloc(h.size)
  fs.readSync(fd, buf, 0, h.size, offsetBase + h.offset)
  const dest = path.join(outDir, h.path.replace(/^\/+/, '').replace(/[/\\]/g, '__'))
  fs.writeFileSync(dest, buf)
  n += 1
  console.log(`${dest}  (${h.size}B)`)
}
console.log(`extracted ${n}/${hits.length}`)
fs.closeSync(fd)
