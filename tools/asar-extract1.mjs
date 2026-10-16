// Extract a single file from app.asar by its in-archive path.
// Usage: node tools/asar-extract1.mjs <archivePath> [outFile]
import fs from 'node:fs'
import path from 'node:path'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
const target = process.argv[2]
const out = process.argv[3]
if (!target) {
  console.error('usage: node tools/asar-extract1.mjs <archivePath> [outFile]')
  process.exit(2)
}

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const dataBase = 16 + head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(8)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const text = jsonBuf.toString('utf8')
const header = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1))

const parts = target.replace(/^\//, '').split('/')
let node = header
for (const part of parts) {
  node = node?.files?.[part]
  if (!node) {
    console.error(`not found: ${target} (failed at "${part}")`)
    process.exit(1)
  }
}
if (node.files) {
  console.error(`that is a directory: ${target}`)
  process.exit(1)
}
const size = Number(node.size)
const offset = Number(node.offset)
const buf = Buffer.alloc(size)
fs.readSync(fd, buf, 0, size, dataBase + offset)
fs.closeSync(fd)

if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf)
  console.log(`wrote ${size} bytes -> ${out}`)
} else {
  process.stdout.write(buf.toString('utf8'))
}
