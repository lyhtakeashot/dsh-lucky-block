/**
 * 端到端探针：骰子会话的用户消息必须**只有一行**，长任务正文走系统提示。
 *
 * 为什么需要这个脚本：
 * 用户明确抱怨过「点进骰子会话看到几百字的指令墙」。改成「一行用户消息 +
 * 系统提示注入」之后，有两种失败模式都是**静默**的：
 *
 *  1. 注入根本没生效 —— 用户消息确实只剩一行了，但 agent 也只看到那一行，
 *     回一句「好的，请问要做什么」就结束了。会话看起来"正常"，实际什么都没干。
 *  2. 注入时机错了 —— 比如先发消息再登记，第一轮装配拿不到正文。
 *
 * 所以这里必须同时断言两件事：**用户消息短** 且 **agent 真的把活干完了**。
 * 只断言前者会让 bug 1 一路绿灯（这正是「测试断言写窄了」的老坑）。
 *
 * 判定 agent 真干了活的方式：读会话投影缓存的 response 字段，
 * 断言它有实质内容（长度 + 含该事件的任务特征词），而不是只看它非空 ——
 * 「好的」也是非空的。
 *
 * 用法：node tools/probe-dice-prompt.mjs <port>
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '19399'
const base = `http://127.0.0.1:${port}`
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

const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const sessionsRoot = path.join(dshHome, 'sessions')
const cacheRoot = path.join(dshHome, 'storages', 'session_projcache', 'sessions')

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

/** 读会话投影缓存。会话 id 在缓存里带 `session-` 前缀。 */
function readProjection(sessionId) {
  const candidates = [sessionId, `session-${sessionId}`]
  for (const name of candidates) {
    const file = path.join(cacheRoot, `${name}.json`)
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* 还没写完整 */
    }
  }
  return null
}

/**
 * 每个 agent 事件在**真正干完活之后**的回复里应当出现的特征词。
 *
 * 刻意用具体的词而不是「长度 > 100」这种宽松判据：后者对
 * 「好的，我这就开始。请问要做什么？」这种敷衍回复同样成立。
 *
 * ⚠️ 这些词必须在**回复开头**就可能出现。因为投影缓存里的
 * `surface[].text` 与 `turnOutline.turns[].response` **都是预览字段**，
 * 实测截断在 80 字符左右（和 `turnOutline.turns[].prompt` 一样被截到 50-80）。
 * 一开始把阈值写成「长度 > 120」和只在中后段出现的词（如「参考文献」），
 * 结果对一个完全正常的回复报了两条 FAIL —— 是测试的错，不是插件的错。
 */
const DONE_MARKERS = {
  paper: /大纲|参考文献|背景|结论|摘要|章节|题目/,
  /* mc-recipe 事件已按用户要求删除（m09978），它的标记一起删。
     留着的话每掷一次都会多等 1.5 秒检查一个再也抽不到的事件。 */
  /* 冷知识现在只出本地库的现成条目，没有 flavor 之分了。
     标记仍然写宽一点：库里的话题横跨科学/人体/动物/日常/历史/语言/地理，
     而回复预览只截得到开头一小段。 */
  trivia: /冷知识|知识点|·|关于|说的是|其实|因为|所以/,
  joke: /笑点|笑话|包袱|段子|梗/,
  news: /新闻|来源|http|报道/i,
  'todo-shuffle': /文件|待办|紧急|修改|最近/,
}

let hit = null
let rolls = 0
while (rolls < 40 && !hit) {
  const before = listSessionIds()
  /* trigger: 'hold' —— 只有长按池（paper/news/todo-shuffle）会建会话。
     用默认值也行（默认就是 hold），但显式写出来是为了让「这个探针测的是长按池」
     这件事在代码里可见。 */
  const res = await post('/dsh-lucky-block/roll', { trigger: 'hold' })
  rolls += 1
  const value = res.data?.value
  if (!value) {
    console.error(`  roll 失败: ${JSON.stringify(res.data)}`)
    break
  }
  // 只关心会建会话的 agent 事件
  if (!value.sessionId) continue
  await new Promise((r) => setTimeout(r, 1500))
  const after = listSessionIds()
  const added = [...after].filter((id) => !before.has(id))
  hit = { value, added }
}

check(Boolean(hit), '40 次内抽到了会建会话的 agent 事件', `实际第 ${rolls} 次`)
if (!hit) {
  console.log('')
  console.log(`FAILED ${fail}`)
  process.exit(1)
}

const { value, added } = hit
const sessionId = value.sessionId
console.log(`  ----  事件 ${value.eventId}「${value.title}」→ 会话 ${sessionId}`)
check(added.length >= 1, 'agent 事件真的新建了会话', `新增 ${added.length} 个`)

/* ---------- 1. 用户消息只有一行 ---------- */

/* 等会话把首条用户消息写进投影缓存。agent 跑完一轮才落盘，所以要轮询。
 *
 * 超时给到 3 分钟：paper 事件要写一整篇论文，实测能跑好几分钟。
 * 一开始只等 40 秒，抽到 paper 时就报「拿到 agent 的回复 长度 0」——
 * 是等得太短，不是插件没干活。 */
let projection = null
let firstText = null
let responseText = null
for (let i = 0; i < 120; i += 1) {
  projection = readProjection(sessionId)
  /* 注意：**不能用 turnOutline.turns[0].prompt** —— 那是预览字段，
     被截断到 50 字符（踩过，会得到「人格在、任务全丢」的假报错）。
     完整的首条用户消息在 titleInput.val.first.text。 */
  firstText = projection?.record?.rows?.titleInput?.val?.first?.text ?? null
  responseText = projection?.record?.rows?.turnOutline?.val?.turns?.[0]?.response ?? null
  if (firstText && responseText) break
  await new Promise((r) => setTimeout(r, 1500))
}

check(typeof firstText === 'string' && firstText.length > 0, '拿到首条用户消息', `长度 ${firstText?.length}`)

if (typeof firstText === 'string') {
  console.log(`      --- 用户消息全文（${firstText.length} 字）---`)
  console.log(firstText.split('\n').map((l) => `      | ${l}`).join('\n'))

  /* 这是本次改动的核心断言：用户消息必须是**一行短句**。 */
  check(!firstText.includes('\n'), '用户消息只有一行（没有换行）', `换行数 ${firstText.split('\n').length - 1}`)
  check(firstText.length <= 40, '用户消息很短', `${firstText.length} 字（上限 40）`)
  check(firstText.includes('🎲'), '用户消息带骰子标记')
  check(firstText.includes(value.title), '用户消息里写着事件名')

  /* 反向断言：长内容**不该**出现在用户消息里。 */
  check(!firstText.includes('［角色设定］'), '用户消息不含人格段')
  check(!firstText.includes('以下是本次要做的事'), '用户消息不含任务分隔标记')
  check(!firstText.includes('最后一步'), '用户消息不含收尾点评请求')
}

/* ---------- 2. agent 真的把活干完了（证明系统提示注入生效）---------- */

check(typeof responseText === 'string' && responseText.length > 0, '拿到 agent 的回复', `长度 ${responseText?.length}`)

if (typeof responseText === 'string') {
  /* 只断言非空是不够的：「好的，请问要做什么？」也是非空。
     注入失效时的典型表现就是这种敷衍回复。
     但阈值不能设高 —— 投影里的回复是**预览**，实测截断在 80 字符左右，
     所以这里只要「超过一句话的长度」就够，真正的判据是下面的特征词。 */
  check(responseText.length > 50, '回复有实质内容（不是敷衍一句）', `${responseText.length} 字（预览截断，非全文）`)
  const marker = DONE_MARKERS[value.eventId]
  if (marker === undefined) {
    check(false, `未知事件 ${value.eventId}，请把特征词加进 DONE_MARKERS`)
  } else {
    check(marker.test(responseText), `回复里有 ${value.eventId} 的任务特征`, `匹配 ${marker}`)
  }
  check(!/请问(你|您)?(想|要)(我)?做(什么|点)什么/.test(responseText), '回复没有反问「要做什么」（注入失效的典型症状）')

  /* 最硬的证据：用户消息里**根本没有**任务正文，而 agent 回复里
     出现了只可能来自任务正文的专有名词。这才是「系统提示注入真的生效」的证明。 */
  const leaked = [DONE_MARKERS[value.eventId]]
    .filter(Boolean)
    .map((re) => responseText.match(re)?.[0])
    .filter(Boolean)
  check(leaked.length > 0, '回复里出现了任务正文才有的词（证明系统提示注入生效）', leaked.join('/'))

  console.log('      --- 回复开头 ---')
  console.log(responseText.slice(0, 160).split('\n').map((l) => `      | ${l}`).join('\n'))
}

console.log('')
if (fail === 0) {
  console.log('ALL GREEN —— 骰子会话的用户消息只有一行，任务正文走系统提示且真的被执行了。')
  process.exit(0)
}
console.log(`FAILED ${fail}`)
process.exit(1)
