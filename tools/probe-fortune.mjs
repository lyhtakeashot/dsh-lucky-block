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

/* ---------- 1. 事件清单里有 fortune，且是单击池里的 kind=local ---------- */

const ping = await post('/dsh-lucky-block/ping')
check(ping.status === 200, 'ping 返回 200')
const evs = ping.data?.value?.events || []
const fortuneEvent = evs.find((e) => e.id === 'fortune')
check(Boolean(fortuneEvent), '事件清单里有 fortune')
check(fortuneEvent?.kind === 'local', 'fortune 是 kind=local', `kind=${fortuneEvent?.kind}`)
/* 它必须在**单击**池：纯本地抽签、零 token，不该占长按的 AI 名额。 */
check(fortuneEvent?.trigger === 'click', 'fortune 是 trigger=click（左键单击，零 token）', `trigger=${fortuneEvent?.trigger}`)
/* 老字段 `local`（「能不能调 AI」勾选框）已删。这条是反向断言：
   它要是回来了，说明那个开关又长回来了。 */
check(!('local' in (fortuneEvent || {})), 'fortune 不再带 local 字段（localOnly 开关已删）', JSON.stringify(Object.keys(fortuneEvent || {})))

const settings = await post('/dsh-lucky-block/settings')
check(
  !('localizable' in (settings.data?.value || {})),
  '设置面板不再有可本地化清单（localOnly 开关已删）',
  JSON.stringify(Object.keys(settings.data?.value || {})),
)

/* ---------- 2. 掷到 fortune 为止，断言不建会话 + 文本正确 ---------- */

const FORTUNE_NAMES = ['鸿运齐天', '大吉', '中吉', '小吉', '顺', '平', '凶']

/* 用户要求每档五条签文。定义成常量而不是散落的字面量 5，
   这样「够不够 5 条」和「改成 3 条时这里要一起改」都只有一处。 */
const TEXTS_PER_TIER = 5

/* 「凶」的五条文案必须「转个身」，不能是诅咒。判据是**口吻**而不是某一句话：
   上一版钉死 `includes('你运气还挺好')`，五条一上就必然假失败。
   这几种转身方向都算数 ——
     ① 把不顺重新框成省事（「坑都提前踩完了」「好消息是它只来一次」）
     ② 把签本身判为无效（「今天的签算错了」「这签不作数」）—— 最彻底的一种，
        连「今天不顺」都不必成立，坏运气只存在于那个被判定为 bug 的结果里
     ③ 把倒霉换成稀有（「这一签的概率是 0.1%」「稀有款都这样」）—— 不解释也不取消
        后果，只是让抽到这个结果本身变成一件值得说的事
     ④ 把「不做」说成一种运气（「什么都不做就不会做错」）
   注意判据必须落在**把代价解释掉**这层语义上，不能只匹配转折词。
   定义成常量是刻意的：这个正则在文件里被两处用到（本次抽到的签、以及
   从源码里抠出来的全部五条），两处各写一份必然漂移 —— 事实上第一次实现
   就漂移了，一处有「别躲|躲不掉」另一处没有，于是同一句话一处 PASS 一处 FAIL。 */
const BAD_TONE_RE = /运气|走运|不会做错|好消息|只来一次|剩下的时间|算错|不作数|bug|稀有|难抽|坑都提前踩完/

/* 被用户否掉的写法在不在，是对「别偷偷改回去」的守卫，不是对文风的评判。
   三次被否的共同点：**坏事已经摆到用户眼前**，然后用一句轻的把它盖住。
     第一版：直接劝人（「往好处想」）
     第二版：先预告具体坏事（「多绕两个弯」「得重做」）
     第三版：换成假设句（「要是有什么没办成」）—— 语气软了，但失败仍在句子里
   用户的话是「我们的主要目的不是给用户添堵」—— 第一眼读到的必须是转身。
   所以这里拦的是「预告具体坏事」「假设一件坏事」「长辈式劝解」三类词，
   不是拦某个整句。 */
const NASTY_FORECAST_RE = /多绕|绕两个弯|得重做|必须重做|要重做第二遍|往好处想|别躲了|躲不掉|没办成|没做成|办砸/

/* 「转身方向」的标签，用来防**五条里有两条是同一个笑点**。
   这不是用户提的要求，是踩过之后补的：第 ③ 条（签算错了）和第 ④ 条
   （运气进程在后台重试）单看都合格，放在一起都是「系统自己出故障」，
   同一个方向讲了两遍，用户直接说「3,4 两条重复了」。
   所以每条必须命中且只命中一个标签 —— 命中 0 个说明没转身，
   命中 2 个说明这条同时用了两种写法，容易和别的条撞车。

   五个方向必须一一对应，所以「坑都提前踩完」和「只来一次」要拆成两个：
   它们读起来都是「往好处想」，但前者是把不顺换成省事（空间/代价），
   后者是把不顺换成有限（时间/次数）—— 换成五条时它们能各自撑一条。 */
const TURN_KINDS = [
  ['spared', /坑都提前踩完/], // ① 把不顺重新框成省事（代价维度）
  ['once', /只来一次/], // ② 把不顺重新框成有限（时间维度）
  ['voided', /算错|不作数/], // ③ 否定这个结果本身
  ['rare', /稀有|难抽/], // ④ 把倒霉换成稀有（收藏价值维度）
  ['inaction', /什么都不做/], // ⑤ 不作为即运气
]

/* 真的诅咒用词。「不顺」不在里面 —— 承认今天不顺恰恰是签「真」的地方，
   用户反感的是「你今天要倒霉」这种直接判死刑的写法。 */
const CURSE_RE = /倒霉|厄运|不祥|灾/

let hit = null
let rolls = 0
const seenNames = new Set()

while (rolls < 60 && !hit) {
  const before = listSessionIds()
  /* trigger: 'click' —— fortune 在单击池，长按池里只有 paper/news/invent。
     不带这个字段的话默认走 hold，永远掷不到 fortune，循环结束后会误报「抽不到」。 */
  const res = await post('/dsh-lucky-block/roll', { trigger: 'click' })
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
  // 注意：**不能只在「本次刚好抽到凶」时才断言** —— 凶只有 0.1%，
  // 靠掷骰子撞到它来验证，等于这条断言永远没跑过。
  // 所以下面无条件地从源码里把「凶」那一档的五条文案全检查一遍。
  if (name === '凶') {
    check(BAD_TONE_RE.test(text), '「凶」的正文反着写成「也不是坏事」')
    check(!CURSE_RE.test(text), '「凶」的正文没有真的诅咒用户')
    check(!NASTY_FORECAST_RE.test(text), '「凶」的正文不预告具体的坏事')
  } else {
    console.log(`  ----  本次抽到「${name}」，改从源码直接检查「凶」的五条文案`)
  }

  console.log('      --- localText 全文 ---')
  console.log(text.split('\n').map((l) => `      | ${l}`).join('\n'))
}

/* ---------- 2b. 一天只抽一次：当天再抽必须拿到同一签 ---------- */

/* 这条必须**真的再抽一次**来验证，不能只查状态文件 ——
   状态写对了但 rollDice 忘了读，表现依然是「每次都能重抽」，
   而那才是用户真正会遇到的 bug。
   为了不靠运气，这里先把状态文件清掉，让接下来这次必是「今日首次」。 */
const fortuneStatePath = path.join(dshHome, 'plugins', 'dsh-lucky-block', 'fortune-state.json')
let savedFortuneState = null
try {
  if (existsSync(fortuneStatePath)) savedFortuneState = readFileSync(fortuneStatePath, 'utf8')
  await (await import('node:fs/promises')).rm(fortuneStatePath, { force: true })
} catch (error) {
  console.error(`  清理旧状态失败（探针会不准）：${error?.message ?? error}`)
}

let first = null
let second = null
for (let i = 0; i < 60 && !(first && second); i += 1) {
  /* trigger: 'click' —— fortune 在单击池，长按池里只有 paper/news/invent。 */
  const res = await post('/dsh-lucky-block/roll', { trigger: 'click' })
  const value = res.data?.value
  if (!value || value.eventId !== 'fortune') continue
  if (!first) {
    first = value
    await new Promise((r) => setTimeout(r, 400))
    // 确认真的落了盘 —— 否则「第二次拿到同一签」可能只是巧合
    check(existsSync(fortuneStatePath), '抽完之后状态文件落盘了', fortuneStatePath)
  } else {
    second = value
  }
}

check(Boolean(first && second), '60 次内抽到 fortune 至少两次（用于验证不可重抽）')
if (first && second) {
  const firstName = first.localText?.match(/今日运气：(\S+)/)?.[1]
  const secondName = second.localText?.match(/今日运气：(\S+)/)?.[1]
  check(firstName === secondName, '当天第二次抽到同一档签', `第一次「${firstName}」第二次「${secondName}」`)
  check(
    second.localText?.includes('今天已经抽过了，明天再来吧'),
    '第二次抽提示「今天已经抽过了，明天再来吧」',
    (second.localText || '').split('\n').filter((l) => l.includes('已经抽过')).join(' / '),
  )
  check(second.fortuneRepeated === true, '第二次抽带 fortuneRepeated 标记')
  /* 这一轮开头已 rm 掉 fortune-state.json，所以「第一次」本该不带标记。
     但探针跑之前宿主可能已经写了今日签（用户在真 GUI 里抽过）——
     那时宿主读到的是已存在的状态，第一次就带标记。那种情况不是 bug，
     是老断言假设了「探针一定是今天第一个抽签的人」。
     改成：两条一致 + 第二次带标记，去覆盖两种排列。 */
  check(
    second.fortuneRepeated === true,
    '第二次抽一定带标记（第一次可带可不带）',
    `第一次=${String(first.fortuneRepeated)} 第二次=${String(second.fortuneRepeated)}`,
  )
  // 免责声明在两种情况下都必须还在 —— 提示语是**追加**，不是替换。
  check(second.localText?.includes('无科学依据'), '重复抽仍带「无科学依据」免责声明')
}

/* 复位：把探针动过的状态还给用户，别让用户的签被探针清掉。 */
try {
  const { writeFile } = await import('node:fs/promises')
  if (savedFortuneState !== null) {
    await writeFile(fortuneStatePath, savedFortuneState, 'utf8')
  } else {
    await (await import('node:fs/promises')).rm(fortuneStatePath, { force: true })
  }
} catch (error) {
  console.error(`  复位今日运气状态失败：${error?.message ?? error}`)
}

/* ---------- 3. 七档的权重分布（直接测抽取函数，不靠掷骰子碰运气）---------- */

/* 这里刻意**不用**「多掷几次 roll 看抽到几档」来验证：
   fortune 在事件池里只占 12%，掷 40 次期望只有 ~4.8 次命中，
   样本小到「只出 2 档」完全正常 —— 那样的断言测的是运气，不是代码。
   改成从 lib/index.js 抽出 FORTUNES 与 drawFortune 真跑 20 万次。 */
const src = readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
const arrStart = src.indexOf('const FORTUNES = [')
const arrEnd = src.indexOf('\n]', arrStart) + 2
const fnStart = src.indexOf('function drawFortune(rand)')
const fnEnd = src.indexOf('\n}', fnStart) + 2
/* drawFortune 现在把「挑哪句话」交给 withText —— 抽取时必须连着带出来，
   否则 new Function 里会报 withText is not defined，看起来像源码坏了。 */
const wtStart = src.indexOf('function withText(fortune, rand)')
const wtEnd = src.indexOf('\n}', wtStart) + 2
check(arrStart > 0 && fnStart > 0, '能从 lib/index.js 抽出 FORTUNES 与 drawFortune')
check(wtStart > 0, '能从 lib/index.js 抽出 withText')

if (arrStart > 0 && fnStart > 0 && wtStart > 0) {
  const draw = new Function(
    `${src.slice(arrStart, arrEnd)}\n${src.slice(fnStart, fnEnd)}\n${src.slice(wtStart, wtEnd)}\nreturn drawFortune`,
  )()
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

  /* 「七档都能抽到」这条断言在「凶」被压到 0.1% 之后就不成立了 ——
     20 万次里期望只有 200 次，虽然大概率仍能抽到，但它不再是稳定断言。
     改成直接检查每一档的 weight 都 > 0（这才是「抽得到」的真实条件），
     而分布是否合理交给下面的百分比断言。 */
  const fortunes = new Function(`${src.slice(arrStart, arrEnd)}\nreturn FORTUNES`)()
  check(fortunes.length === FORTUNE_NAMES.length, '档位数正确', `${fortunes.length} 档`)
  check(fortunes.every((f) => f.weight > 0), '每一档的权重都 > 0（都抽得到）')

  /* 「顺」是后插进来的一档，位置在「小吉」和「平」之间。
     顺序本身是有含义的：数组顺序 = 从好到坏的排列，下面的吉类合计
     也是靠「前四档」这个位置来判断的，所以顺序错了会连带算错。 */
  check(
    fortunes.map((f) => f.name).join('/') === FORTUNE_NAMES.join('/'),
    '档位顺序是 鸿运齐天→大吉→中吉→小吉→顺→平→凶',
    fortunes.map((f) => f.name).join(' / '),
  )

  const luckyPct = ['鸿运齐天', '大吉', '中吉', '小吉', '顺'].reduce((s, k) => s + (pct[k] || 0), 0)
  check(luckyPct > 85, '吉类（含「顺」）合计 ≥ 85%（不给人添堵）', `吉类 ${luckyPct.toFixed(1)}%`)

  /* 「顺」夹在「小吉」和「平」之间，这既是位置要求也是概率要求：
     它应该比「小吉」少见，但比「平」常见。断两边的相对大小，
     不断绝对值 —— 绝对值将来调整权重时会变，大小关系才是设计意图。
     注意这里直接取 pct['平']，「平」的百分比变量在本段之后才声明。 */
  const shunPct = pct['顺'] || 0
  const smallPct = pct['小吉'] || 0
  const flatRawPct = pct['平'] || 0
  check(shunPct < smallPct, '「顺」比「小吉」少见', `顺 ${shunPct.toFixed(1)}% < 小吉 ${smallPct.toFixed(1)}%`)
  check(shunPct > flatRawPct, '「顺」比「平」常见', `顺 ${shunPct.toFixed(1)}% > 平 ${flatRawPct.toFixed(1)}%`)

  /* 「顺」的文案不能是「顺利」「一帆风顺」这类「事情成了」的写法 ——
     它描述的是「没有障碍」，不是「有好事发生」，否则和小吉就没区别了。
     每档五条，逐条检查，不是只看第一条。 */
  const shun = fortunes.find((f) => f.name === '顺')
  check(Boolean(shun), 'FORTUNES 里有「顺」这一档')
  if (shun) {
    const shunTexts = shun.texts || []
    check(shunTexts.length === TEXTS_PER_TIER, '「顺」正好五条文案', `${shunTexts.length} 条`)
    const noObstacle = /坎|没.{0,4}拦|不卡|没.{0,4}挡|不会被打断|没.{0,4}操心|不需.{0,4}较劲/
    const slipsIntoSmall = /成功|办成|顺利|惊喜|好消息|机会|运气好/
    for (const [i, t] of shunTexts.entries()) {
      check(noObstacle.test(t), `「顺」第 ${i + 1} 条讲的是「没有坎」而不是「有好事」`, t.slice(0, 24) + '…')
      check(!slipsIntoSmall.test(t), `「顺」第 ${i + 1} 条没有滑进「小吉」的语义`, t.slice(0, 24) + '…')
    }
  }

  /* 「凶」的目标是 ~0.1%。抽样估计的误差必须容得下：
     p=0.001、N=200000 → 期望 200 次，标准差约 14 次，即 ±0.007 个百分点。
     所以给一个宽松但有意义的上限 0.3%：真按 5% 实现的话这里必然失败。 */
  const badPct = pct['凶'] || 0
  check(badPct < 0.3, '「凶」被压到 0.1% 量级', `凶 ${badPct.toFixed(3)}%`)

  /* 「平」也要求明显低于吉类：用户说「平」的概率也太高了。 */
  const flatPct = pct['平'] || 0
  check(flatPct < 15, '「平」不超过 15%', `平 ${flatPct.toFixed(1)}%`)

  /* 鸿运齐天用户明确说「不用调」，保持 5%。 */
  const jackpotPct = pct['鸿运齐天'] || 0
  check(Math.abs(jackpotPct - 5) < 1.5, '「鸿运齐天」保持约 5%', `鸿运齐天 ${jackpotPct.toFixed(1)}%`)

  /* ---------- 3b. 每档五条文案的结构断言 ---------- */

  /* 用户明确要求「每种的签文都来 5 种」。这条断言必须逐档数，不能只看总数
     —— 七档加起来 35 条、但某一档只有 3 条，用户照样会觉得被敷衍。 */
  for (const f of fortunes) {
    const n = Array.isArray(f.texts) ? f.texts.length : 0
    check(n === TEXTS_PER_TIER, `「${f.name}」正好五条文案`, `${n} 条`)
  }
  check(
    fortunes.every((f) => Array.isArray(f.texts) && f.texts.every((t) => typeof t === 'string' && t.trim().length > 0)),
    '每档的每条文案都是非空字符串',
  )
  /* 同一档内不能有重复文案 —— 复制粘贴时最容易犯，而且看起来像「没写够」。 */
  for (const f of fortunes) {
    const list = f.texts || []
    check(new Set(list).size === list.length, `「${f.name}」的五条文案互不重复`)
  }
  /* 跨档也不能重复：相同的一句话不可能既是「大吉」又是「中吉」。 */
  const allTexts = fortunes.flatMap((f) => f.texts || [])
  check(new Set(allTexts).size === allTexts.length, '全部签文没有跨档重复', `共 ${allTexts.length} 条`)

  /* 权重与文案条数解耦：这是本次改动最容易踩的坑。
     如果哪天有人把 texts 摊平进 FORTUNES，档位概率就会被条数改变 ——
     给「凶」多写两条文案，凶就从 0.1% 变成 0.3%。 */
  const expectedWeightTotal = 1000
  check(
    fortunes.reduce((s, f) => s + f.weight, 0) === expectedWeightTotal,
    '档位权重合计仍是 1000（五条文案不改档位概率）',
    fortunes.reduce((s, f) => s + f.weight, 0),
  )

  /* 每档内五条都应该真的抽得到：给 drawFortune 喂连续随机数，
     收集该档出现的所有文案，必须覆盖全部五条。 */
  const covered = {}
  for (let i = 0; i < 5000; i += 1) {
    const f = draw(rand)
    covered[f.name] = covered[f.name] || new Set()
    covered[f.name].add(f.text)
  }
  for (const f of fortunes) {
    if (f.name === '凶') continue // 0.1%，5000 次里可能抽不到这一档
    const got = covered[f.name]?.size ?? 0
    check(got === (f.texts || []).length, `「${f.name}」的五条文案都抽得到`, `覆盖 ${got} 条`)
  }

  /* 无条件检查「凶」的五条文案本身：靠掷骰子撞到那一档来验证，
     等于这条断言绝大多数时候根本没跑（上一版就是这样，被静默跳过）。 */
  const bad = fortunes.find((f) => f.name === '凶')
  check(Boolean(bad), 'FORTUNES 里有「凶」这一档')
  if (bad) {
    /* 「凶」不能真的诅咒用户。反向检查的是「口吻」，不是某个固定短语——
       上一版钉死「你运气还挺好」，换一条文案就假失败。
       正则复用上面的 BAD_TONE_RE / CURSE_RE，两处各写一份必然漂移。 */
    for (const [i, t] of (bad.texts || []).entries()) {
      check(BAD_TONE_RE.test(t), `「凶」第 ${i + 1} 条反着写成「也不是坏事」`, t.slice(0, 24) + '…')
      check(!CURSE_RE.test(t), `「凶」第 ${i + 1} 条没有真的诅咒用户`, t.slice(0, 24) + '…')
      /* 这一条守的是「别偷偷改回被否掉的写法」，不是评判文风。
         被否的三版分别死于劝人、预告具体坏事、把失败写成假设句，
         用户的话是「我们的主要目的不是给用户添堵」。 */
      check(!NASTY_FORECAST_RE.test(t), `「凶」第 ${i + 1} 条不预告具体的坏事`, t.slice(0, 24) + '…')
    }

    /* 转身方向不许撞车。这条约束来自一次实际被否的稿子：
       「签算错了」和「运气进程在后台重试」单看都对，放在一起都是
       「系统自己出故障」，同一个笑点讲了两遍 —— 用户的原话是「3,4 两条重复了」。
       只数数量不够（两条不同文案、同一个方向），必须按方向归类后再比。 */
    const kinds = (bad.texts || []).map((t) => TURN_KINDS.filter(([, re]) => re.test(t)).map(([k]) => k))
    kinds.forEach((hits, i) => {
      check(hits.length === 1, `「凶」第 ${i + 1} 条只用一个转身方向`, hits.length ? `命中 ${hits.join(' + ')}` : '一个都没命中')
    })
    const used = kinds.flat()
    check(
      new Set(used).size === used.length,
      '「凶」五条的转身方向互不重复（同一个笑点不能讲两遍）',
      `用到 ${used.join(' / ')}`,
    )
  }
  /* 免责声明必须由宿主拼接，而不是写在每条签文里 ——
     写进签文的话，将来新增一档忘了抄就漏了。 */
  check(!fortunes.some((f) => (f.texts || []).some((t) => t.includes('无科学依据'))), '免责声明不写在签文里（由宿主统一追加）')
}

console.log('')
if (fail === 0) {
  console.log('ALL GREEN —— 今日运气是纯本地抽签，零会话、零 token、带免责声明。')
  process.exit(0)
}
console.log(`FAILED ${fail}`)
process.exit(1)
