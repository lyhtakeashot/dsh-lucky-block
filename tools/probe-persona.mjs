/**
 * 端到端探针：验证人格层真的生效、且 prompt 不出现角色名。
 *
 * 检查项：
 *   1. /ping 拿到的事件清单里有 joke / news，并且带 persona 状态与 chatter 字段；
 *   2. 掷骰子后，**骰子会话实际收到的系统提示**含人格段与任务正文；
 *   3. 用户消息本身只有一行（长内容不再糊在用户眼前）；
 *   4. 视觉事件返回 quip（本地台词，零 token）；
 *   5. 人格计数确实递增。
 *
 * ⚠️ 判据来源变过一次，值得记住为什么。
 * 原来这里读会话投影缓存的 `titleInput.val.first.text`（首条用户消息）来做内容断言。
 * 后来骰子会话的长内容改走 system prompt，用户消息只剩一行「🎲 随机事件：xxx」，
 * 于是这 5 条断言全部报 FAIL —— 但插件其实完全正常。
 *
 * 更要紧的是**投影缓存里查不到注入内容**：`contextTimeline.surface` 只记
 * user/inject/skill/assistant 四类，注入段不进 surface；`systems` 只有一个 tokens 计数。
 * 也就是说「注入没生效」和「注入生效了」在磁盘上长得一模一样。
 * 所以宿主新增了只读的 `/dsh-lucky-block/dice-prompt` 路由把内存里的注入文本暴露出来，
 * 这个探针改从那里取内容，同时保留「用户消息只有一行」的断言。
 *
 * 用法：node tools/probe-persona.mjs <port>
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '19399'
/* 必须用 fileURLToPath：工作目录名里有中文，import.meta.url 里的路径是
   percent-encoded 的（dsh%E5%B9%B8...），手工拆字符串会拼出打不开的路径。 */
const here = path.dirname(fileURLToPath(import.meta.url))
const token = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()
const base = `http://127.0.0.1:${port}`

let cookie = ''
async function handshake() {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const sc = res.headers.getSetCookie?.() ?? []
  for (const c of sc) {
    const pair = c.split(';')[0]
    if (pair.startsWith('dsh-auth')) cookie = pair
  }
  if (!cookie) throw new Error('拿不到 auth cookie')
}

async function api(pathName, init = {}) {
  const res = await fetch(`${base}${pathName}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: base,
      cookie,
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

/* ---------- 会话投影缓存的位置 ---------- */
const projDir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh'), 'storages', 'session_projcache', 'sessions')

function listProjections() {
  try { return new Set(readdirSync(projDir)) } catch { return new Set() }
}

/**
 * 读出某个会话投影里「第一轮用户消息」的实际文本。
 *
 * ⚠️ 关键陷阱：`turnOutline.turns[0].prompt` 是**预览字段，被截断到 50 字符**
 * （实测形如「［角色设定］ 你的身份是…」，后面带省略号）。
 * 拿它做内容断言会得到「人格在、任务全丢」的假报错。
 * 完整文本在 `titleInput.val.first.text`。
 */
function firstPromptOf(file) {
  try {
    const raw = JSON.parse(readFileSync(path.join(projDir, file), 'utf8'))
    const rows = raw?.record?.rows
    const full = rows?.titleInput?.val?.first?.text
    if (typeof full === 'string' && full.length > 0) return full
    const turns = rows?.turnOutline?.val?.turns
    if (Array.isArray(turns) && turns[0]?.prompt) return String(turns[0].prompt)
    return null
  } catch {
    return null
  }
}

let fail = 0
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) fail += 1
}

await handshake()
console.log('handshake OK')

/* ---------- 1. ping ---------- */
const ping = await api('/dsh-lucky-block/ping')
const pv = ping.json?.value
check(ping.status === 200 && !!pv, 'ping 返回 200')
const ids = (pv?.events ?? []).map((e) => e.id)
check(ids.includes('joke'), '事件清单含 joke', JSON.stringify(ids))
check(ids.includes('news'), '事件清单含 news')
check(!!pv?.persona && typeof pv.persona.diceCount === 'number', 'ping 带 persona 统计', JSON.stringify(pv?.persona))
check(!('flipped' in (pv?.persona ?? {})), 'ping 不再暴露翻转状态（机制已删）')
check('chatter' in (pv ?? {}), 'ping 带 chatter 字段', JSON.stringify(pv?.chatter))
console.log('      persona =', JSON.stringify(pv?.persona))

/* ---------- 2. 掷骰子，验证真实 prompt 含人格 ---------- */
const before = listProjections()
/*
 * 必须循环，不能指望第一次就抽到 agent 事件。
 * 单击池 5 条里有 3 条不建会话（popups 14% / bluescreen 14% / fortune 21%，
 * 合计 49%）—— 但这个探针要的是**会建会话**的，所以用 trigger:'hold'：
 * 长按池 3 条全是 agent，一掷一个准。
 * 以前这里不带 trigger，于是近一半的尝试落在单击池上白跑一圈。
 */
let rv = null
let attempts = 0
for (; attempts < 12 && !rv; attempts += 1) {
  const roll = await api('/dsh-lucky-block/roll', { method: 'POST', body: JSON.stringify({ trigger: 'hold' }) })
  const v = roll.json?.value
  if (roll.status !== 200 || !v) {
    check(false, 'roll 返回 200', JSON.stringify(roll.json?.error ?? ''))
    break
  }
  console.log(`      attempt ${attempts + 1}: 事件=${v.eventId} 会话=${v.sessionId ?? '(不建会话)'} quip=${JSON.stringify(v.quip)}`)
  if (v.sessionId) rv = v
}
check(!!rv, '12 次内抽到了会建会话的事件', `实际第 ${attempts} 次`)

if (rv) {
  check(typeof rv.quip === 'string' && rv.quip.length > 0, 'roll 返回角色台词 quip', JSON.stringify(rv.quip))

  /* ---------- 2b 先做：趁 turn/end 还没清掉登记，立刻取注入文本 ---------- */

  /* 这里**必须先取、再等投影**，顺序反了就永远取不到。
     turn/end 分支会 `dicePrompts.delete(sessionId)` —— 那是刻意的（否则用户
     在这个会话里追问时，几百字的任务指令会一直挂在系统提示里）。所以这条
     登记只在「agent 正在跑这一轮」期间存在；投影缓存要等整轮结束才落盘，
     等它出现时登记早就没了，探针会拿到 known=[] 并且看起来像「没注入」。
     上一版就是这么写的，第一次跑就 FAIL。 */
  let iv = null
  for (let i = 0; i < 20; i += 1) {
    const injected = await api(`/dsh-lucky-block/dice-prompt?sessionId=${encodeURIComponent(rv.sessionId)}`)
    if (injected.json?.value?.found === true) {
      iv = injected.json.value
      break
    }
    // 还没登记上就短暂等一下；roll 已经返回说明 set() 早于 promptSession()，通常是立刻有。
    await new Promise((r) => setTimeout(r, 250))
  }
  const promptText = typeof iv?.text === 'string' ? iv.text : null
  check(!!iv, '宿主登记了这个骰子会话的注入内容（turn/end 之后会被清掉，所以立刻取）')

  // 等会话投影落盘（异步写，别用固定 sleep 赌）
  const target = `session-${rv.sessionId.replace(/^session-/, '')}.json`
  let userText = null
  for (let i = 0; i < 40; i += 1) {
    userText = firstPromptOf(target)
    if (userText) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const after = listProjections()
  const added = [...after].filter((f) => !before.has(f))
  console.log(`      新增投影 ${added.length} 个, 目标 ${target} 命中=${added.includes(target)}`)

  /* ---------- 2a. 用户消息只剩一行 ---------- */
  check(!!userText, '拿到新会话的首条用户消息')
  if (userText) {
    console.log('      用户消息 =', JSON.stringify(userText))
    check(!userText.includes('\n'), '用户消息只有一行', `换行 ${userText.split('\n').length - 1} 个`)
    check(userText.length <= 40, '用户消息很短（长内容没糊到用户眼前）', `${userText.length} 字`)
    check(!userText.includes('［角色设定'), '用户消息不含人格段')
    check(!userText.includes('以下是本次要做的事'), '用户消息不含任务正文')
  }

  /* ---------- 2b. 系统提示里才是真正的指令 ---------- */
  if (promptText) {
    // 人格标记
    check(promptText.includes('［角色设定'), '系统提示含人格段标题')
    check(!/《[^》]{1,20}》|\b[A-Z][a-z]{3,}\b/.test(promptText), '系统提示不含任何专名')
    check(promptText.includes('用户'), '系统提示用「用户」称呼')
    check(/冷知识|音量提高|权限/.test(promptText), '系统提示含标志句式')
    check(promptText.includes('以下是本次要做的事'), '系统提示含任务分隔标记')
    // 任务正文必须还在（人格不能把任务挤掉）。
    // 按**本次实际抽中的事件**挑对应标记，不要用一条宽松的大正则 ——
    // 那种写法会让「任务正文丢了但恰好匹配上别处的词」也判通过。
    // mc-recipe 事件已按用户要求删除（m09978），它的标记一起删。
    const TASK_MARKERS = {
      paper: '随机题目',
      trivia: '本轮题目',
      joke: '随机冷笑话任务',
      news: '做一期「时事新闻速览」',
      invent: '随机发明一样东西',
      /* 以下四条是 m19279 新加的长按事件。标记一律取**正文里的第一句任务话**，
         不能取标题 —— 标题本来就由包装层写进系统提示，拿它当标记等于
         「标题还在就算通过」，而这四条要验的是正文有没有被挤掉。 */
      novel: '用这三个词写一篇短篇小说',
      absurd: '写一小段荒诞对话小剧场',
      rebuttal: '立一个论点，然后亲手反驳它',
      manual: '写一份毫无用处的说明书',
    }
    const marker = TASK_MARKERS[rv.eventId]
    if (marker === undefined) {
      check(false, `任务正文断言：未知事件 ${rv.eventId}，请把它的标记加进 TASK_MARKERS`)
    } else {
      check(promptText.includes(marker), `系统提示保留了 ${rv.eventId} 的任务正文`, `标记=${marker}`)
    }
    // 收尾点评请求也必须到位，否则只有人格在说话、没有结尾
    check(promptText.includes('最后一步'), '系统提示含收尾点评请求')
    // 不允许**断言式**地说出制造商信息。
    // 注意不能直接匹配「制造商」三个字：prompt 里本来就有一句指令
    // 「不要给自己编造制造商」，那是规矩本身，不是泄漏（persona-check 里踩过同一个坑）。
    // 判据：命中点前 14 字内出现否定词就算讲规矩。
    const manufacturerHits = [...promptText.matchAll(/(制造商|出厂|生产商)/g)]
      .filter((m) => !/(不要|不得|别|禁止|不许|不能|没有|未)/.test(promptText.slice(Math.max(0, m.index - 14), m.index)))
    check(manufacturerHits.length === 0, '系统提示未出现编造的制造商信息',
      manufacturerHits.length ? `命中 ${manufacturerHits.length} 处` : '')
    console.log('      --- 系统提示前 300 字 ---')
    console.log(promptText.slice(0, 300).split('\n').map((l) => `      | ${l}`).join('\n'))
  }
}

/* ---------- 3. 人格计数递增 ---------- */
const ping2 = await api('/dsh-lucky-block/ping')
const p2 = ping2.json?.value?.persona
check((p2?.diceCount ?? 0) > (pv?.persona?.diceCount ?? -1),
  'diceCount 递增', `${pv?.persona?.diceCount} -> ${p2?.diceCount}`)

console.log(fail === 0 ? '\nALL GREEN' : `\nFAILED ${fail}`)
process.exit(fail === 0 ? 0 : 1)
