/**
 * 验证人格翻转（对应游戏里「击杀 50 人后强制切换模式」）。
 *
 * 直接改 persona-state.json 的 diceCount 到阈值前一格，再掷一次，
 * 断言：flipped 变 true、返回值带 flipped 标记、之后的人格块变礼貌。
 * 这样不必真掷 50 次（50 次会开 50 个会话，太脏）。
 *
 * 用法：node tools/probe-flip.mjs <port>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || '19399'
const here = path.dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const stateFile = path.join(dshHome, 'plugins', 'dsh-lucky-block', 'persona-state.json')
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

/* 把计数推到阈值前一格（默认 flipAfter=50 → 设 49） */
let saved = null
try { saved = readFileSync(stateFile, 'utf8') } catch { /* 可能还没建 */ }
writeFileSync(stateFile, `${JSON.stringify({ version: 1, diceCount: 49, flipped: false, mood: 'normal' }, null, 2)}\n`, 'utf8')
console.log('已把 diceCount 预置为 49（阈值 50）')

const roll = await api('/dsh-lucky-block/roll', { method: 'POST', body: '{}' })
const rv = roll.json?.value
check(roll.status === 200, 'roll 返回 200', JSON.stringify(roll.json?.error ?? ''))
check(rv?.flipped === true, '越过阈值的那次 roll 带 flipped 标记', JSON.stringify(rv?.flipped))
console.log('      事件 =', rv?.eventId, '| quip =', JSON.stringify(rv?.quip))

const ping = await api('/dsh-lucky-block/ping')
const p = ping.json?.value?.persona
check(p?.flipped === true, '翻转状态已持久化', JSON.stringify(p))
check(p?.diceCount === 50, 'diceCount = 50', String(p?.diceCount))

/* 再掷一次：这次是「已经是翻转态」，quip 应该是礼貌版而不是默认版 */
const roll2 = await api('/dsh-lucky-block/roll', { method: 'POST', body: '{}' })
const rv2 = roll2.json?.value
check(rv2?.flipped === undefined, '已翻转状态下不再重复报 flipped', JSON.stringify(rv2?.flipped))

/* 读回该会话的 prompt，断言用的是 flippedTraits（礼貌版） */
const projDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
if (rv?.sessionId) {
  const target = `session-${String(rv.sessionId).replace(/^session-/, '')}.json`
  let text = null
  for (let i = 0; i < 30; i += 1) {
    try {
      const raw = JSON.parse(readFileSync(path.join(projDir, target), 'utf8'))
      text = raw?.record?.rows?.titleInput?.val?.first?.text ?? null
    } catch { /* 还没落盘 */ }
    if (text) break
    await new Promise((r) => setTimeout(r, 500))
  }
  check(!!text, '拿到翻转态会话的 prompt')
  if (text) {
    check(text.includes('爱狗人士'), 'prompt 用了翻转后的「爱狗人士」人格')
    check(!text.includes('你对这件事毫无道德负担'), 'prompt 不再含默认人格的狠话')
    check(/礼貌|敬语|道歉|抱歉|不满意/.test(text), 'prompt 体现礼貌腔')
  }
}

/* 复位：删掉状态文件，别把用户的真实计数污染成 50 */
try {
  if (saved === null) {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(stateFile)
  } else {
    writeFileSync(stateFile, saved, 'utf8')
  }
  console.log('已复位 persona-state.json')
} catch (e) {
  console.log('复位失败（手工删一下）:', String(e?.message ?? e))
}

console.log(fail === 0 ? '\nALL GREEN' : `\nFAILED ${fail}`)
process.exit(fail === 0 ? 0 : 1)
