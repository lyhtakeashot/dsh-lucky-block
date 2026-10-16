// List asar entries whose path matches a substring, with size/offset.
// Usage: node tools/asar-find.mjs <substring> [maxHits]
import fs from 'node:fs'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
const needle = process.argv[2]
const maxHits = Number(process.argv[3] ?? 40)
if (!needle) {
  console.error('usage: node tools/asar-find.mjs <substring> [maxHits]')
  process.exit(2)
}

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerPickleLen = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(8)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
fs.closeSync(fd)
const text = jsonBuf.toString('utf8')
const header = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1))

console.log(`headerPickleLen=${headerPickleLen} jsonLen=${jsonLen} dataBase=${16 + headerPickleLen}`)

let hits = 0
const stack = [[header, '']]
while (stack.length > 0 && hits < maxHits) {
  const [node, prefix] = stack.pop()
  if (!node || !node.files) continue
  for (const [name, entry] of Object.entries(node.files)) {
    const p = `${prefix}/${name}`
    if (entry.files) {
      stack.push([entry, p])
    } else if (p.includes(needle)) {
      console.log(`${p}\tsize=${entry.size}\toffset=${entry.offset}`)
      hits += 1
      if (hits >= maxHits) break
    }
  }
}
console.log(`[hits: ${hits}]`)
