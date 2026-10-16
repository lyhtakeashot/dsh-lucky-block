// 在 app.asar 里列出路径匹配的文件（asar header 是 pickle: u32=4, u32 headerPickleLen, u32 jsonLen, json）。
// 用法: node tools/asar-list.mjs <正则>
import fs from 'node:fs'

const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'
const pattern = new RegExp(process.argv[2] || '.', 'i')

const buf = fs.readFileSync(ASAR)
const jsonLen = buf.readUInt32LE(8)
const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'))
const offsetBase = 16 + buf.readUInt32LE(4)

const hits = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else if (pattern.test(p)) hits.push({ path: p, size: entry.size, offset: Number(entry.offset) })
  }
}
walk(header, '')
console.log(`matches: ${hits.length}`)
for (const h of hits.slice(0, 60)) console.log(` ${h.path}  (${h.size}B)`)
if (process.argv[3]) {
  const target = hits.find((h) => h.path.endsWith(process.argv[3]))
  if (!target) {
    console.log('no exact file to extract')
  } else {
    const start = offsetBase + target.offset
    fs.writeFileSync(process.argv[4] || 'research/asar-out.js', buf.slice(start, start + target.size))
    console.log(`extracted -> ${process.argv[4] || 'research/asar-out.js'}`)
  }
}
