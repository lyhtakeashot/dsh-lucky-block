/**
 * 端到端探针：「抽今日运气」必须真的走本地、不建会话、带免责声明。
 *
 * 为什么要单独一个脚本：
 * host-smoke 只验证「事件被标成 kind=local」这种静态事实，
 * 而这条事件的失败模式全是**运行期**的：
 *  - 抽中 fortune 却还是建了会话（分流写错位置）
 *  - 返回了 localText 但客户端不认（字段名对不上，见 DESIGN.md 记过的坑）
 *  - 免责声明漏了（写进每条签文而不是宿主拼接那一步，就会漏）
 *  - 六档里有几档永远抽不到（权重数组写错）
 *
 * 判定方式：跟踪**新增会话 id**，并让每次 roll 的返回值去认领。
 * 注意不能用「会话文件数量」当判据 —— agent 会话是异步落盘的，
 * 数文件会看到别的 roll 几百毫秒后才补上的记录（踩过）。
 *
 * 用法：node tools/probe-fortune.mjs <port>
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '19399'
const base = `http://127.0.0.1:${port}`
/* 必须用 fileURLToPath：工作目录名含中文时 `new URL().pathname` 是 percent-encoded
   的（dsh%E5%B9%B8...），手工拆字符串会拼出一个打不开的路径（踩过）。 */
const here = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function check(ok, label, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label}${extra ? `  (${extra})` : ''}`)
  }
}

const tokenFile = path.join(here, '..', 'docs', '.probe-token')
if (!existsSync(tokenFile)) {
  console.error('找不到 docs/.probe-token，先启动克隆 profile 并抓 token')
  process.exit(1)
}
const token = readFileSync(tokenFile, 'utf8').trim()

const r0 = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = (r0.headers.get('set-cookie') || '').split(';')[0]
const headers = {
  cookie,
  origin: base,
  'content-type': 'application/json',
  host: `127.0.0.1:${port}`,
}

async function post(p, body = {}) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

/* 会话目录：$DSH_HOME/sessions/<转义后的工作区路径>/<sessionId>/ */
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const sessionsRoot = path.join(dshHome, 'sessions')

function listSessionIds() {
  const ids = new Set()
  if (!existsSync(sessionsRoot)) return ids
  for (const wsDir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!wsDir.isDirectory()) continue
    const wsPath = path.join(sessionsRoot, wsDir.name)
    for (const s of readdirSync(wsPath, { withFileTypes: true })) {
      if (s.isDirectory()) ids.add(s.name)
    }
  }
  return ids
}

/* ---------- 1. 事件清单里有 fortune，且是 kind=local ---------- */

const ping = await post('/dsh-lucky-block/ping')
check(ping.status === 200, 'ping 返回 200')
const evs = ping.data?.value?.events || []
const fortuneEvent = evs.find((e) => e.id === 'fortune')
check(Boolean(fortuneEvent), '事件清单里有 fortune')
check(fortuneEvent?.kind === 'local', 'fortune 是 kind=local', `kind=${fortuneEvent?.kind}`)
check(fortuneEvent?.local === false, 'fortune 不声明 local 语料（不该出现在设置面板）', `local=${fortuneEvent?.local}`)

const settings = await post('/dsh-lucky-block/settings')
const localizable = (settings.data?.value?.localizable || []).map((x) => (typeof x === 'string' ? x : x?.id))
check(!localizable.includes('fortune'), '设置面板的可本地化清单里没有 fortune', `清单=${JSON.stringify(localizable)}`)

/* ---------- 2. 掷到 fortune 为止，断言不建会话 + 文本正确 ---------- */

const FORTUNE_NAMES = ['鸿运齐天', '大吉', '中吉', '小吉', '平', '凶']

let hit = null
let rolls = 0
const seenNames = new Set()

while (rolls < 60 && !hit) {
  const before = listSessionIds()
  const res = await post('/dsh-lucky-block/roll', {})
  rolls += 1
  const value = res.data?.value
  if (!value) {
    console.error(`  roll 失败: ${JSON.stringify(res.data)}`)
    break
  }
  if (value.eventId === 'fortune') {
    // 给它一点时间，若真建了会话，文件会落下来
    await new Promise((r) => setTimeout(r, 1200))
    const after = listSessionIds()
    const added = [...after].filter((id) => !before.has(id))
    hit = { value, added }
    seenNames.add(value.localText?.match(/今日运气：(\S+)/)?.[1] || '')
  }
}

check(Boolean(hit), '60 次内抽到了 fortune', `实际第 ${rolls} 次`)

if (hit) {
  const { value, added } = hit
  check(value.sessionId === null, 'fortune 的 sessionId 是 null', `sessionId=${value.sessionId}`)
  check(value.createdNew === false, 'fortune 没有标记新建会话', `createdNew=${value.createdNew}`)
  check(value.local === true, 'fortune 标记为 local')
  check(added.length === 0, 'fortune 没有产生任何新会话', `新增 ${added.length} 个`)

  const text = value.localText
  check(typeof text === 'string' && text.length > 0, 'fortune 返回了非空 localText', `长度 ${text?.length}`)

  const name = text?.match(/今日运气：(\S+)/)?.[1]
  check(FORTUNE_NAMES.includes(name), '签文档位合法', `抽到「${name}」`)

  // 免责声明是硬要求：漏了就等于把随机数当命理讲。
  check(text?.includes('无科学依据'), 'localText 带「无科学依据」免责声明')
  check(text?.includes('仅供参考'), 'localText 带「仅供参考」')

  // 「凶」必须反着写，不能是诅咒。
  // 注意：**不能只在「本次刚好抽到凶」时才断言** —— 凶只有 5%，
  // 靠掷骰子撞到它来验证，等于这条断言绝大多数时候根本没跑。
  // 所以下面无条件地从源码里把「凶」那一档取出来单独检查。
  if (name === '凶') {
    check(text.includes('你运气还挺好'), '「凶」的正文反着写成「你运气还挺好」')
    check(!/倒霉|厄运|不祥|灾/.test(text), '「凶」的正文没有真的诅咒用户')
  } else {
    console.log(`  ----  本次抽到「${name}」，改从源码直接检查「凶」的文案`)
  }

  console.log('      --- localText 全文 ---')
  console.log(text.split('\n').map((l) => `      | ${l}`).join('\n'))
}

/* ---------- 3. 六档的权重分布（直接测抽取函数，不靠掷骰子碰运气）---------- */

/* 这里刻意**不用**「多掷几次 roll 看抽到几档」来验证：
   fortune 在事件池里只占 12%，掷 40 次期望只有 ~4.8 次命中，
   样本小到「只出 2 档」完全正常 —— 那样的断言测的是运气，不是代码。
   改成从 lib/index.js 抽出 FORTUNES 与 drawFortune 真跑 20 万次。 */
const src = readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
const arrStart = src.indexOf('const FORTUNES = [')
const arrEnd = src.indexOf('\n]', arrStart) + 2
const fnStart = src.indexOf('function drawFortune(rand)')
const fnEnd = src.indexOf('\n}', fnStart) + 2
check(arrStart > 0 && fnStart > 0, '能从 lib/index.js 抽出 FORTUNES 与 drawFortune')

if (arrStart > 0 && fnStart > 0) {
  const draw = new Function(`${src.slice(arrStart, arrEnd)}\n${src.slice(fnStart, fnEnd)}\nreturn drawFortune`)()
  // 固定种子的 LCG：可复现，不依赖 Math.random
  let seed = 20261017
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const N = 200000
  const tally = {}
  for (let i = 0; i < N; i += 1) {
    const f = draw(rand)
    tally[f.name] = (tally[f.name] || 0) + 1
  }
  const pct = {}
  for (const [k, v] of Object.entries(tally)) pct[k] = (v / N) * 100
  console.log('      档位分布:', Object.entries(pct).map(([k, v]) => `${k} ${v.toFixed(1)}%`).join(' / '))

  check(Object.keys(tally).length === FORTUNE_NAMES.length, '六档都能抽到', `实测 ${Object.keys(tally).length} 档`)

  const luckyPct = ['鸿运齐天', '大吉', '中吉', '小吉'].reduce((s, k) => s + (pct[k] || 0), 0)
  check(luckyPct > 60, '吉类合计明显偏高（不给人添堵）', `吉类 ${luckyPct.toFixed(1)}%`)

  const badPct = pct['凶'] || 0
  check(badPct > 0 && badPct < 10, '「凶」有但很少', `凶 ${badPct.toFixed(1)}%`)

  /* 无条件检查「凶」的文案本身：靠掷骰子撞到 5% 的那一档来验证，
     等于这条断言绝大多数时候根本没跑（上一版就是这样，被静默跳过）。 */
  const fortunes = new Function(`${src.slice(arrStart, arrEnd)}\nreturn FORTUNES`)()
  const bad = fortunes.find((f) => f.name === '凶')
  check(Boolean(bad), 'FORTUNES 里有「凶」这一档')
  if (bad) {
    check(bad.text.includes('你运气还挺好'), '「凶」的文案反着写成「你运气还挺好」', bad.text.slice(0, 20) + '…')
    check(!/倒霉|厄运|不祥|灾/.test(bad.text), '「凶」的文案没有真的诅咒用户')
  }
  /* 免责声明必须由宿主拼接，而不是写在每条签文里 ——
     写进签文的话，将来新增一档忘了抄就漏了。 */
  check(!fortunes.some((f) => f.text.includes('无科学依据')), '免责声明不写在签文里（由宿主统一追加）')
}

console.log('')
if (fail === 0) {
  console.log('ALL GREEN —— 今日运气是纯本地抽签，零会话、零 token、带免责声明。')
  process.exit(0)
}
console.log(`FAILED ${fail}`)
process.exit(1)
