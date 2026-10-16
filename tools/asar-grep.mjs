// 在 app.asar 原始字节里扫描字符串（不解析 header，快）。
// 用途：定位某个实现所在的源码片段。用法: node tools/asar-grep.mjs <字符串> [上下文字节数]
import fs from 'node:fs'

const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'
const needle = Buffer.from(process.argv[2] || 'requestRejection', 'utf8')
const ctx = Number(process.argv[3] || 400)
const maxHits = Number(process.argv[4] || 5)

const fd = fs.openSync(ASAR, 'r')
const CHUNK = 8 * 1024 * 1024
const buf = Buffer.alloc(CHUNK + needle.length)
let pos = 0
let carry = 0
let hits = 0

while (hits < maxHits) {
  const read = fs.readSync(fd, buf, carry, CHUNK, pos)
  if (read <= 0) break
  const total = carry + read
  let from = 0
  while (hits < maxHits) {
    const at = buf.subarray(from, total).indexOf(needle)
    if (at < 0) break
    const abs = pos - carry + at
    const s = Math.max(0, at - ctx)
    const e = Math.min(total, at + needle.length + ctx)
    console.log(`\n===== hit @${abs} =====`)
    console.log(buf.subarray(s, e).toString('utf8').replace(/\0/g, '.'))
    hits += 1
    if (hits >= maxHits) break
    from = at + needle.length
  }
  // 保留尾部 needle.length 字节与下一块拼接，避免跨块漏匹配
  carry = needle.length
  buf.copy(buf, 0, total - carry, total)
  pos += read
}
console.log(`\n[hits: ${hits}]`)
fs.closeSync(fd)
