// 快速从 app.asar 抽取文件：只读 header（前若干 MB），按需 seek 读取目标文件。
// 用法: node tools/asar-extract.mjs <路径正则> [输出目录]
import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.argv[2] === '--list' ? null : 'D:\\DeepSeek Harness\\resources\\app.asar'
const mode = process.argv[2]
const pattern = new RegExp(process.argv[3] || '.', 'i')
const outDir = process.argv[4] || 'research/asar'

const fd = fs.openSync(ASAR || 'D:\\DeepSeek Harness\\resources\\app.asar', 'r')
const head = Buffer.alloc(64)
fs.readSync(fd, head, 0, 64, 0)
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
    else if (pattern.test(p)) hits.push({ path: p, size: entry.size, offset: Number(entry.offset) })
  }
}
walk(header, '')

if (mode === '--list') {
  console.log(`matches: ${hits.length}`)
  for (const h of hits.slice(0, 80)) console.log(` ${h.path}  (${h.size}B)`)
} else {
  fs.mkdirSync(outDir, { recursive: true })
  let n = 0
  for (const h of hits) {
    if (h.size > 3_000_000) continue
    const buf = Buffer.alloc(h.size)
    fs.readSync(fd, buf, 0, h.size, offsetBase + h.offset)
    const dest = path.join(outDir, h.path.replace(/^\/+/, '').replace(/[/\\]/g, '__'))
    fs.writeFileSync(dest, buf)
    n += 1
    if (n <= 40) console.log(` -> ${dest} (${h.size}B)`)
  }
  console.log(`extracted ${n} file(s) to ${outDir}`)
}
fs.closeSync(fd)
