/**
 * 设置面板端到端探针：验证 `sound` 开关真的能读能写，且面板拿得到事件清单。
 *
 * 用法：node tools/probe-settings.mjs [port]
 *
 * 为什么要单独测：
 *   - `settings()` 的返回形状改过好几次（新增 sound、删掉 localOnly/localizable），
 *     而客户端在 `openSettings` 里**立刻**用一个占位对象开面板、拿到真值再替换。
 *     如果宿主不返回 sound，客户端那行 `value.sound !== false` 会算成
 *     `undefined !== false` = true，看起来「一直开着」，用户关不掉。
 *   - `saveSettings()` 是读-改-写，新增字段最容易在这里被整份覆盖抹掉
 *     （config.json 里还有用户手写的 model/persona）。
 *   - 面板靠 `events[].trigger` 决定显示「单击」还是「长按」。字段没了面板会
 *     全显示成「长按」，而用户看不出这是错的。
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${PORT}`
const TOKEN = readFileSync(path.resolve(here, '..', 'docs', '.probe-token'), 'utf8').trim()

function request(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: Object.assign({ host: HOST }, headers || {}) },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const exchange = await request('GET', `/?token=${encodeURIComponent(TOKEN)}`)
const raw = exchange.status
// 从 set-cookie 拿不到（request 没收集 headers）——重来一次，这次收 headers。
function requestFull(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: Object.assign({ host: HOST }, headers || {}) },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const ex = await requestFull('GET', `/?token=${encodeURIComponent(TOKEN)}`)
const rawCookie = ex.headers['set-cookie']
const list = rawCookie === undefined ? [] : Array.isArray(rawCookie) ? rawCookie : [rawCookie]
const cookie = list.map((c) => String(c).split(';')[0]).join('; ')
if (!cookie) { console.error(`没拿到 cookie（exchange status=${raw}）`); process.exit(1) }

let fail = 0
const check = (ok, label, detail = '') => {
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? (ok ? ` (${detail})` : ` —— ${detail}`) : ''}`)
}

const H = { cookie, origin: `http://${HOST}`, 'content-type': 'application/json' }

const readSettings = async () => {
  const r = await requestFull('POST', '/dsh-lucky-block/settings', H, '{}')
  const j = JSON.parse(r.body)
  return j.value
}

const before = await readSettings()
check(typeof before.sound === 'boolean', 'settings() 返回 sound 布尔值', `sound=${before.sound}`)
check(typeof before.configPath === 'string' && before.configPath.length > 0, 'settings() 仍返回 configPath')

/* 「能不能调 AI」那个开关已经按用户要求删了（m09978）。这里做反向断言：
   字段要是回来了，客户端就会渲染出一堆点了没用的勾选框。
   真正决定调不调 AI 的现在是 trigger，所以顺带验它有没有暴露给面板。 */
check(!('localOnly' in before), 'settings() 不再返回 localOnly（开关已删）', JSON.stringify(Object.keys(before)))
check(!('localizable' in before), 'settings() 不再返回 localizable（开关已删）')
check(
  Array.isArray(before.events) && before.events.length > 0,
  'settings() 返回只读事件清单（面板用它显示单击/长按标签）',
  `events=${Array.isArray(before.events) ? before.events.length : typeof before.events}`,
)
if (Array.isArray(before.events)) {
  const badTrigger = before.events.filter((e) => e.trigger !== 'click' && e.trigger !== 'hold')
  check(badTrigger.length === 0, '事件清单里每条都有合法 trigger', JSON.stringify(badTrigger.map((e) => e.id)))
  const byId = new Map(before.events.map((e) => [e.id, e]))
  check(byId.get('paper')?.trigger === 'hold', 'paper 标为长按', `trigger=${byId.get('paper')?.trigger}`)
  check(byId.get('trivia')?.trigger === 'click', 'trivia 标为单击', `trigger=${byId.get('trivia')?.trigger}`)
  check(!byId.has('mc-recipe'), '事件清单里没有 mc-recipe（已按用户要求删除）')
  /* 面板的「恢复默认」要拿出厂权重作基准，所以 defaultWeight 必须每条都在。
     缺了它面板上那个按钮就只能恢复到「当前值」= 什么都没恢复。 */
  const missingDefault = before.events.filter((e) => typeof e.defaultWeight !== 'number')
  check(missingDefault.length === 0, '每条事件都带 defaultWeight（面板「恢复默认」要用）',
    JSON.stringify(missingDefault.map((e) => e.id)))
  const badWeights = before.events.filter((e) => typeof e.weight !== 'number' || e.weight < 0)
  check(badWeights.length === 0, '每条事件的覆盖后权重都是非负数', JSON.stringify(badWeights.map((e) => e.id)))
  /* 音频是一库一事件（`audio-<文件名>`），所以断言的是「至少有一条」，
     不是「有一条叫 audio 的」—— 后者在按曲目拆分之后永远为假。 */
  const audioIds = before.events.filter((e) => String(e.id).startsWith('audio-')).map((e) => e.id)
  check(audioIds.length > 0, '曲库非空时清单里有 audio-* 事件', JSON.stringify(audioIds))
  check(typeof before.eventOverrides === 'object' && before.eventOverrides !== null,
    'settings() 返回 eventOverrides（面板要区分「出厂」与「用户改过」）')
}

// 自定义事件扩展点：文件不存在是正常状态，字段仍要存在让面板能显示路径。
check(typeof before.customEventsPath === 'string' && before.customEventsPath.length > 0,
  'settings() 返回 customEventsPath', String(before.customEventsPath))
check(
  before.customEvents && typeof before.customEvents === 'object' && Array.isArray(before.customEvents.events),
  'settings() 返回 customEvents.events 数组',
  `events=${before.customEvents?.events?.length} reason=${JSON.stringify(before.customEvents?.reason)}`,
)

// 关掉，读回必须是 false
const off = await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({ sound: false }))
const offJson = JSON.parse(off.body)
check(offJson.ok === true, 'save-settings {sound:false} 成功', offJson.error ? offJson.error.message : '')
check(offJson.value && offJson.value.sound === false, 'save-settings 回显 sound=false', `value.sound=${offJson.value && offJson.value.sound}`)
const afterOff = await readSettings()
check(afterOff.sound === false, '读回 sound=false（真的落盘了）', `sound=${afterOff.sound}`)

// 关键：写 sound 不能把别的字段抹掉（读-改-写）
check(
  Array.isArray(afterOff.events) && afterOff.events.length === before.events.length,
  '写 sound 没有抹掉事件清单',
  `写前 ${before.events?.length} → 写后 ${afterOff.events?.length}`,
)
check(
  typeof afterOff.config === 'object' && afterOff.config !== null,
  '写 sound 后 config 仍可读（用户手写的 model/persona 还在）',
)

// 再打开，确认能双向切
await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({ sound: true }))
const afterOn = await readSettings()
check(afterOn.sound === true, '读回 sound=true（可以再开回来）', `sound=${afterOn.sound}`)

// 非法值不该把配置写坏：非布尔的 sound 应被忽略或强转，且不能让整个请求 500。
const bad = await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({ sound: 'yes-please' }))
check(bad.status === 200, '非法 sound 值不 500', `status=${bad.status}`)
const afterBad = await readSettings()
check(typeof afterBad.sound === 'boolean', '非法值之后 sound 仍是布尔值', `sound=${JSON.stringify(afterBad.sound)}`)

/* ---- 事件权重 / 开关覆盖层 ---- */
// 先记住原值，跑完要还原（探针不该把用户的事件配置留在改过的状态）。
const rawEvents = JSON.parse(JSON.stringify(before.eventOverrides ?? {}))

// 写一条合法的：把 trivia 权重改成 6。
const w = await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({
  events: { trivia: { weight: 6 } },
}))
const wJson = JSON.parse(w.body)
check(wJson.ok === true, 'save-settings {events} 成功', wJson.error ? wJson.error.message : '')
check(wJson.value?.events?.trivia?.weight === 6, '宿主回显洗过的权重',
  `value.events.trivia=${JSON.stringify(wJson.value?.events?.trivia)}`)
const afterW = await readSettings()
check(afterW.eventOverrides?.trivia?.weight === 6, '读回权重=6（真的落盘了）',
  `eventOverrides=${JSON.stringify(afterW.eventOverrides)}`)
const triviaRow = (afterW.events ?? []).find((e) => e.id === 'trivia')
check(triviaRow?.weight === 6, '事件清单里的覆盖后权重跟着变（面板读的是这个）',
  `weight=${triviaRow?.weight}`)
check(triviaRow?.defaultWeight !== 6, 'defaultWeight 保持出厂值不被覆盖',
  `defaultWeight=${triviaRow?.defaultWeight}`)

// 写一条关掉的：weight 0 等价于 enabled:false。
await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({
  events: { joke: { weight: 0 } },
}))
const afterOff2 = await readSettings()
check(afterOff2.eventOverrides?.joke?.weight === 0, 'weight 0 落盘（= 关掉这条事件）',
  `eventOverrides.joke=${JSON.stringify(afterOff2.eventOverrides?.joke)}`)

// 脏值必须被静默修正，而不是 500 或把配置写坏。
const dirty = await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({
  events: {
    joke: { weight: 1e9, note: 'x', __proto__: { weight: 3 } },
    Joke: { weight: 5 },
    my_event: { weight: 5 },
    nope_id: { weight: 5 },
    trivia: { enabled: 'yes' },
  },
}))
check(dirty.status === 200, '脏 events 值不 500', `status=${dirty.status}`)
const afterDirty = await readSettings()
const ov = afterDirty.eventOverrides ?? {}
check(!('Joke' in ov), '大写 id 被丢掉', JSON.stringify(Object.keys(ov)))
check(!('my_event' in ov), '下划线 id 被丢掉')
check(!('enabled' in (ov.trivia ?? {})), '非布尔 enabled 被丢掉', JSON.stringify(ov.trivia))
check(!('note' in (ov.joke ?? {})), '多余字段被丢掉', JSON.stringify(ov.joke))
const jokeWeight = ov.joke?.weight
/* 上限读的是 events-check 同款的常量来源（宿主 EVENT_OVERRIDE_LIMITS），
   不写死数字：2019 那次是 25，为了把音乐压到 5% 抬到了 100，
   写死会让这条断言在抬上限时变成假红。 */
const WEIGHT_CAP = 100
check(typeof jokeWeight === 'number' && jokeWeight === WEIGHT_CAP, `超大权重夹到上限 ${WEIGHT_CAP}`, `weight=${jokeWeight}`)
// 关键：脏值不能让配置退化成「什么都不剩」或把 model/persona 抹掉。
check(Object.keys(ov).length > 0, '脏值清洗后仍保留合法条目', JSON.stringify(Object.keys(ov)))
check(typeof afterDirty.config === 'object' && afterDirty.config !== null,
  '脏值写完后 config 仍可读（model/persona 没被抹掉）')

// 还原。整份替换语义：写 {} 就等于「全部恢复默认」。
await requestFull('POST', '/dsh-lucky-block/save-settings', H, JSON.stringify({ events: rawEvents }))
const afterRestore = await readSettings()
check(
  JSON.stringify(afterRestore.eventOverrides ?? {}) === JSON.stringify(rawEvents),
  '跑完事件覆盖层还原成进来时的样子',
  `原来 ${JSON.stringify(rawEvents)} → 现在 ${JSON.stringify(afterRestore.eventOverrides ?? {})}`,
)

console.log('')
if (fail > 0) { console.log(`!!! ${fail} 项未通过`); process.exit(1) }
console.log('ALL GREEN —— 设置面板的 sound 开关、事件权重/开关覆盖层都可读可写，且不破坏其它字段。')
