/**
 * 端到端探针：验证人格层真的生效、且 prompt 不出现角色名。
 *
 * 检查项：
 *   1. /ping 拿到的事件清单里有 joke / news，并且带 persona 状态与 chatter 字段；
 *   2. 掷骰子后，**新会话里实际发出的 prompt** 含人格段（不是我们自以为发了）；
 *   3. 视觉事件返回 quip（本地台词，零 token）；
 *   4. 人格计数确实递增。
 *
 * 判据是**会话投影缓存里的真实 prompt**，不是插件自己的返回值 ——
 * 后者只能证明我们想发什么，前者才能证明宿主真的把这段文字送进了模型。
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
check(!!pv?.persona && typeof pv.persona.flipAfter === 'number', 'ping 带 persona 状态', JSON.stringify(pv?.persona))
check('chatter' in (pv ?? {}), 'ping 带 chatter 字段', JSON.stringify(pv?.chatter))
console.log('      persona =', JSON.stringify(pv?.persona))

/* ---------- 2. 掷骰子，验证真实 prompt 含人格 ---------- */
const before = listProjections()
const roll = await api('/dsh-lucky-block/roll', { method: 'POST', body: '{}' })
const rv = roll.json?.value
check(roll.status === 200 && !!rv, 'roll 返回 200', JSON.stringify(roll.json?.error ?? ''))
console.log('      事件 =', rv?.eventId, '| 会话 =', rv?.sessionId, '| quip =', JSON.stringify(rv?.quip))

check(typeof rv?.quip === 'string' && rv.quip.length > 0, 'roll 返回角色台词 quip')

if (rv?.sessionId) {
  // 等会话投影落盘（异步写，别用固定 sleep 赌）
  const target = `session-${rv.sessionId.replace(/^session-/, '')}.json`
  let promptText = null
  for (let i = 0; i < 40; i += 1) {
    promptText = firstPromptOf(target)
    if (promptText) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const after = listProjections()
  const added = [...after].filter((f) => !before.has(f))
  console.log(`      新增投影 ${added.length} 个, 目标 ${target} 命中=${added.includes(target)}`)

  check(!!promptText, '拿到新会话的真实首条 prompt')
  if (promptText) {
    // 人格标记
    check(promptText.includes('［角色设定'), 'prompt 含人格段标题')
    check(!/《[^》]{1,20}》|\b[A-Z][a-z]{3,}\b/.test(promptText), 'prompt 不含任何专名')
    check(promptText.includes('用户'), 'prompt 用「用户」称呼')
    check(/冷知识|音量提高|权限/.test(promptText), 'prompt 含标志句式')
    check(promptText.includes('以下是本次要做的事'), 'prompt 含任务分隔标记')
    // 任务正文必须还在（人格不能把任务挤掉）。
    // 按**本次实际抽中的事件**挑对应标记，不要用一条宽松的大正则 ——
    // 那种写法会让「任务正文丢了但恰好匹配上别处的词」也判通过。
    const TASK_MARKERS = {
      paper: '随机题目',
      'mc-recipe': '随机抽到的两个 Minecraft 概念',
      trivia: '本轮题目',
      joke: '随机冷笑话任务',
      news: '做一期「时事新闻速览」',
      'todo-shuffle': '列出当前工作区最近修改的 5 个文件',
    }
    const marker = TASK_MARKERS[rv.eventId]
    if (marker === undefined) {
      check(false, `任务正文断言：未知事件 ${rv.eventId}，请把它的标记加进 TASK_MARKERS`)
    } else {
      check(promptText.includes(marker), `prompt 保留了 ${rv.eventId} 的任务正文`, `标记=${marker}`)
    }
    // 收尾点评请求也必须到位，否则只有人格在说话、没有结尾
    check(promptText.includes('最后一步'), 'prompt 含收尾点评请求')
    // 考据禁止项
    check(!/(制造商|出厂|生产商)/.test(promptText), 'prompt 未出现编造的制造商信息')
    console.log('      --- prompt 前 300 字 ---')
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
