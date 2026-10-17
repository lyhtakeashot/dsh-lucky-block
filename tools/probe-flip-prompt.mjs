/**
 * 只验证「翻转后的人格块真的进了 agent 会话的 prompt」这一件事。
 *
 * 为什么要单独写：翻转测试里那次 roll 有 9/22 的概率抽到视觉事件（无会话），
 * 于是 prompt 级断言会被静默跳过 —— 测试报 ALL GREEN，但最关键的一条
 * 根本没跑。这里改成循环掷到抽中 agent 事件为止，把断言钉死。
 *
 * 用法：node tools/probe-flip-prompt.mjs <port>
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '19399'
const here = path.dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const stateFile = path.join(dshHome, 'plugins', 'dsh-lucky-block', 'persona-state.json')
const projDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
const token = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()
const base = `http://127.0.0.1:${port}`

let cookie = ''
async function handshake() {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0]
    if (pair.startsWith('dsh-auth')) cookie = pair
  }
  if (!cookie) throw new Error('拿不到 cookie')
}
async function api(p, init = {}) {
  const res = await fetch(`${base}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: base, cookie, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

let fail = 0
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) fail += 1
}

await handshake()

let saved = null
try { saved = readFileSync(stateFile, 'utf8') } catch { /* ok */ }
// 直接预置成「已翻转」，跳过计数过程。
writeFileSync(stateFile, `${JSON.stringify({ version: 1, diceCount: 60, flipped: true, mood: 'normal' }, null, 2)}\n`, 'utf8')

try {
  // 掷到抽中 agent 事件为止（视觉事件没会话，验不了 prompt）。
  let rv = null
  let promptText = null
  for (let attempt = 1; attempt <= 12 && !rv; attempt += 1) {
    const roll = await api('/dsh-lucky-block/roll', { method: 'POST', body: '{}' })
    const v = roll.json?.value
    if (!v) { check(false, 'roll 失败', JSON.stringify(roll.json?.error ?? '')); break }
    console.log(`      attempt ${attempt}: 事件=${v.eventId} session=${v.sessionId ?? '(视觉，无会话)'}`)
    if (!v.sessionId) continue
    rv = v
    check(typeof v.quip === 'string' && v.quip.length > 0, 'agent 事件也带 quip', JSON.stringify(v.quip))

    const target = `session-${String(v.sessionId).replace(/^session-/, '')}.json`
    /* 先等会话落盘（确认这个会话真的建起来了），再从宿主内存里取注入内容。
       注入内容不在投影缓存里 —— 长内容改走 system prompt 之后，投影缓存里
       只剩那一行用户消息（详见 probe-persona.mjs 头部的说明）。 */
    let userText = null
    for (let i = 0; i < 40; i += 1) {
      try {
        const raw = JSON.parse(readFileSync(path.join(projDir, target), 'utf8'))
        userText = raw?.record?.rows?.titleInput?.val?.first?.text ?? null
      } catch { /* 还没落盘 */ }
      if (userText) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const injected = await api(`/dsh-lucky-block/dice-prompt?sessionId=${encodeURIComponent(String(v.sessionId))}`)
    promptText = typeof injected.json?.value?.text === 'string' ? injected.json.value.text : null
  }

  if (!rv) {
    check(false, '12 次都没抽到 agent 事件（概率上极不可能，检查 drawEvent 权重）')
  } else {
    check(!!promptText, '拿到翻转态的系统提示内容')
    if (promptText) {
      check(promptText.includes('礼貌模式'), 'prompt 用了翻转后的「礼貌模式」人格')
      check(!/《[^》]{1,20}》|\b[A-Z][a-z]{3,}\b/.test(promptText), 'prompt 不含任何专名')
      check(!promptText.includes('你把每一次对话都当成一张待处理的工单'), 'prompt 不含默认人格的狠话')
      check(!/枪|哼歌|bum bum|干掉目标/.test(promptText), 'prompt 不含「武器」与「唱歌」元素')
      check(/礼貌|敬语|道歉|抱歉|不满意|请稍候/.test(promptText), 'prompt 体现礼貌腔')
      check(promptText.includes('以下是本次要做的事'), 'prompt 仍保留任务分隔标记')
      console.log('      --- 翻转态 prompt 的人格段 ---')
      console.log(promptText.split('\n').slice(0, 8).map((l) => `      | ${l}`).join('\n'))
    }
  }
} finally {
  try {
    if (saved === null) unlinkSync(stateFile)
    else writeFileSync(stateFile, saved, 'utf8')
    console.log('已复位 persona-state.json')
  } catch (e) {
    console.log('复位失败:', String(e?.message ?? e))
  }
}

console.log(fail === 0 ? '\nALL GREEN' : `\nFAILED ${fail}`)
process.exit(fail === 0 ? 0 : 1)
