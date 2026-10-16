// 从 mcasset.cloud 镜像下载 Minecraft 1.20.1 原版音效到 lib/sounds/。
//
// 再生成命令（在仓库根目录执行）：
//   node tools/build-sounds.mjs            # 已存在且字节数 > 0 的 .ogg 会跳过
//   node tools/build-sounds.mjs --force    # 强制重新下载全部音效
//
// 音效来源：Minecraft 1.20.1 原版 assets（https://assets.mcasset.cloud/1.20.1/assets/minecraft/sounds/）
// 版权归 Mojang Studios 所有；此处仅作本地开发期素材镜像，正式运行时插件不依赖网络。
//
// ## 为什么只产出 .ogg，不再生成 lib/sounds-data.js
// 早期版本把音效转成 base64 data URI 写进一个 JS 模块，让客户端 `import`。
// 这条路**走不通**：`lib/client.js` 由 dsh-client-modules 当作 factory 形式的
// CJS bundle 加载（`__ModuleLoader__.load({ id, factory })`），顶层 ESM `import`
// 根本不会被解析。而就算能 import，190 KB 的 base64 会塞进**每次页面启动都要
// 下载**的入口 bundle —— 音效只在用户长按方块那一瞬间才需要，不值得。
//
// 现在音效由宿主按需发放：prefix 路由 `/dsh-lucky-block/sound/<name>.ogg`
// 读 lib/sounds/ 下的原始文件（见 lib/index.js）。所以本脚本的职责收敛成
// 「把 .ogg 下载到位」，额外产物为零。
//
// 设计约束：
//   - 幂等：同一份输入重复运行，lib/sounds/ 逐字节一致。
//   - 不使用 node:child_process（本机 DSH 沙箱下 spawnSync/execFileSync 会 EPERM）。
//   - 写文件统一用 fs.writeFileSync(path, buf)，不经过文本编码，自然没有 BOM 问题。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOUNDS_DIR = path.join(ROOT, 'lib', 'sounds')
const CDN = 'https://assets.mcasset.cloud/1.20.1/assets/minecraft/sounds/'

const FORCE = process.argv.includes('--force')

// 音效清单：local 为落盘文件名，remote 为 CDN 相对路径。
const MANIFEST = [
  // 挖掘循环音（4 个变体，游戏里随机轮播才有「连续挖掘」的手感）
  { local: 'dig1.ogg', remote: 'dig/stone1.ogg' },
  { local: 'dig2.ogg', remote: 'dig/stone2.ogg' },
  { local: 'dig3.ogg', remote: 'dig/stone3.ogg' },
  { local: 'dig4.ogg', remote: 'dig/stone4.ogg' },
  // 方块碎裂：random/glass1-3 是真正的玻璃碎裂音，比 random/break 更贴「方块被敲碎」
  { local: 'break.ogg', remote: 'random/break.ogg' },
  { local: 'glass1.ogg', remote: 'random/glass1.ogg' },
  { local: 'glass2.ogg', remote: 'random/glass2.ogg' },
  { local: 'glass3.ogg', remote: 'random/glass3.ogg' },
  // 放置 / 弹出 / 开箱类
  { local: 'pop.ogg', remote: 'random/pop.ogg' },
  { local: 'click.ogg', remote: 'random/click.ogg' },
  { local: 'wood_click.ogg', remote: 'random/wood_click.ogg' },
  { local: 'orb.ogg', remote: 'random/orb.ogg' },
  { local: 'levelup.ogg', remote: 'random/levelup.ogg' },
  { local: 'anvil_land.ogg', remote: 'random/anvil_land.ogg' },
  { local: 'explode1.ogg', remote: 'random/explode1.ogg' },
  { local: 'fizz.ogg', remote: 'random/fizz.ogg' },
]

async function fetchBinary(url) {
  const res = await fetch(url)
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => {})
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

fs.mkdirSync(SOUNDS_DIR, { recursive: true })

const downloaded = []
const skipped = []
const failed = []

for (const item of MANIFEST) {
  const dest = path.join(SOUNDS_DIR, item.local)
  const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0
  if (!FORCE && existing > 0) {
    skipped.push({ ...item, bytes: existing })
    continue
  }
  try {
    const buf = await fetchBinary(CDN + item.remote)
    fs.writeFileSync(dest, buf)
    downloaded.push({ ...item, bytes: buf.length })
  } catch (e) {
    failed.push({ ...item, error: e.message })
  }
}

// 读取落盘的 .ogg，校验 OggS 魔数与体积（体积为 0 的「下载成功」其实是被
// CDN 返回的 HTML 错误页，必须在构建期拦住，否则坏文件会被当作好文件跳过）。
function inspect(file) {
  const buf = fs.readFileSync(file)
  if (buf.length === 0) throw new Error(`${file} 为空文件`)
  if (buf.slice(0, 4).toString('latin1') !== 'OggS') {
    throw new Error(`${file} 不是 Ogg 文件（魔数 ${JSON.stringify(buf.slice(0, 4).toString('latin1'))}）`)
  }
  return { bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 12) }
}

const missing = MANIFEST.filter((m) => !fs.existsSync(path.join(SOUNDS_DIR, m.local)))
if (missing.length > 0) {
  throw new Error(`缺少音效文件：${missing.map((m) => m.local).join(', ')}`)
}

const loaded = new Map()
for (const item of MANIFEST) {
  loaded.set(item.local, inspect(path.join(SOUNDS_DIR, item.local)))
}

// 报告
console.log(`CDN: ${CDN}`)
console.log(`模式: ${FORCE ? '强制重新下载' : '增量（跳过已存在）'}`)
console.log(`新下载 ${downloaded.length} 个，跳过 ${skipped.length} 个，失败 ${failed.length} 个`)
for (const d of downloaded) console.log(`  [下载] ${d.local.padEnd(16)} <- ${d.remote.padEnd(24)} ${d.bytes}B`)
for (const s of skipped) console.log(`  [跳过] ${s.local.padEnd(16)} <- ${s.remote.padEnd(24)} ${s.bytes}B`)
for (const f of failed) console.log(`  [失败] ${f.local.padEnd(16)} <- ${f.remote.padEnd(24)} ${f.error}`)

const total = [...loaded.values()].reduce((n, i) => n + i.bytes, 0)
console.log(`\nlib/sounds/ 共 ${loaded.size} 个文件，合计 ${total} 字节`)
for (const item of MANIFEST) {
  const info = loaded.get(item.local)
  console.log(`  ${item.local.padEnd(16)} ogg=${String(info.bytes).padStart(6)}B  sha256:${info.sha}`)
}

if (failed.length > 0) process.exitCode = 1
