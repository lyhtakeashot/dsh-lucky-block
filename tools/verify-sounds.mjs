// 校验挖掘音效整条链路：lib/sounds/*.ogg 是真 Ogg、宿主路由的白名单能放行它们、
// 且客户端 lib/client.js 里写死的文件名与磁盘一一对应。
// 用法：node tools/verify-sounds.mjs
//
// 为什么值得单独一个脚本：音效这一层的失败模式**全是静默的**。
//   - 文件缺失      → 宿主 404 → 浏览器控制台一条网络错误 → 用户只听到「没声音」；
//   - 文件名写错    → 同上（客户端根本不 import 任何东西，没有编译期检查）；
//   - 白名单太严    → 同上，而且看起来「代码明明写了」。
// 没有这个脚本时，这三件事都只能在浏览器里靠耳朵发现。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOUNDS_DIR = path.join(ROOT, 'lib', 'sounds')
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js')
const HOST_FILE = path.join(ROOT, 'lib', 'index.js')

const problems = []
const check = (ok, label, detail = '') => {
  if (!ok) problems.push(detail ? `${label} —— ${detail}` : label)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` —— ${detail}` : ''}`)
}

/* ---------------- 1. 磁盘上的 .ogg 必须都是真 Ogg ---------------- */
console.log('== 磁盘文件 ==')
const onDisk = fs.readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.ogg')).sort()
check(onDisk.length > 0, `lib/sounds/ 有 .ogg 文件（${onDisk.length} 个）`)
let totalBytes = 0
for (const name of onDisk) {
  const buf = fs.readFileSync(path.join(SOUNDS_DIR, name))
  totalBytes += buf.length
  const magic = buf.slice(0, 4).toString('latin1')
  check(
    magic === 'OggS' && buf.length > 1000,
    `${name} 是真 Ogg（${buf.length}B，sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 12)}）`,
    `魔数=${JSON.stringify(magic)}`,
  )
}
console.log(`  合计 ${totalBytes} 字节`)

/* ---------------- 2. 客户端引用的文件名必须都在磁盘上 ---------------- */
console.log('\n== 客户端清单 ↔ 磁盘 ==')
const clientSrc = fs.readFileSync(CLIENT_FILE, 'utf8')

// 从 SOUND_FILES 字面量里抽出所有 '...ogg' 文件名（双引号单引号都可能）。
const blockStart = clientSrc.indexOf('var SOUND_FILES = {')
check(blockStart >= 0, 'client.js 里有 SOUND_FILES 清单')
let clientNames = []
if (blockStart >= 0) {
  const blockEnd = clientSrc.indexOf('\n  }', blockStart)
  const block = clientSrc.slice(blockStart, blockEnd > 0 ? blockEnd : blockStart + 1200)
  clientNames = [...new Set([...block.matchAll(/'([A-Za-z0-9_]+\.ogg)'/g)].map((m) => m[1]))].sort()
}
check(clientNames.length > 0, `从 SOUND_FILES 解析出文件名（${clientNames.length} 个）`)
for (const name of clientNames) {
  check(onDisk.includes(name), `客户端引用的 ${name} 存在于 lib/sounds/`)
}

/* ---------------- 3. 宿主白名单必须放行这批文件名 ---------------- */
console.log('\n== 宿主路由 ↔ 文件名 ==')
const hostSrc = fs.readFileSync(HOST_FILE, 'utf8')

// 宿主用正则做白名单。把它抠出来真跑一遍，而不是「看着像对」。
// 源码里是字面量 /^[A-Za-z0-9_]+\.ogg$/，这里从文本中提取 pattern 再构造 RegExp。
const wl = hostSrc.match(/if\s*\(\s*!\/([^\n]+?)\/[a-z]*\.test\(name\)\s*\)/)
check(wl !== null, 'index.js 里有文件名白名单正则')
if (wl) {
  const re = new RegExp(wl[1])
  for (const name of (clientNames.length ? clientNames : onDisk)) {
    check(re.test(name), `白名单放行 ${name}`)
  }
  // 反向：必须挡住路径穿越与非法扩展名。这是这条路由唯一的安全边界。
  for (const bad of ['../config.json', '..%2fconfig.json', 'dig1.ogg/../secret', 'dig1.mp3', 'a b.ogg', '', '.ogg']) {
    check(!re.test(bad), `白名单拦住 ${JSON.stringify(bad)}`)
  }
}

// 路由前缀不能带尾斜杠（webserver 的判据是 `prefix + '/'`，带了就永远匹配不上）。
console.log('\n== 路由前缀 ==')
const prefixDecl = hostSrc.match(/kind:\s*'prefix',\s*\n\s*path:\s*'([^']+)'/)
check(prefixDecl !== null, 'index.js 里注册了 prefix 路由')
if (prefixDecl) {
  const p = prefixDecl[1]
  check(!p.endsWith('/'), `prefix 路由 "${p}" 不带尾斜杠`)
  check(p === '/dsh-lucky-block/sound', `prefix 路由是 /dsh-lucky-block/sound`, `实际 ${p}`)
}

// 客户端拼 URL 的前缀必须与宿主路由一致，否则每个音效都 404。
const baseDecl = clientSrc.match(/var SOUND_BASE = '([^']+)'/)
check(baseDecl !== null, 'client.js 里有 SOUND_BASE')
if (baseDecl && prefixDecl) {
  const expected = prefixDecl[1] + '/'
  check(baseDecl[1] === expected, `SOUND_BASE 与路由前缀一致（${expected}）`, `客户端是 ${baseDecl[1]}`)
}

/* ---------------- 4. 设置面板必须有音效开关 ---------------- */
console.log('\n== 设置开关 ==')
check(/toggleSound/.test(clientSrc), 'client.js 有 toggleSound')
check(/长按挖掘音效/.test(clientSrc), '设置面板里有音效开关文案')

console.log('')
if (problems.length) {
  console.log(`!!! 发现 ${problems.length} 个问题：`)
  for (const p of problems) console.log('  - ' + p)
  process.exitCode = 1
} else {
  console.log('ALL GREEN —— 音效文件、客户端清单、宿主白名单三者一致。')
}
