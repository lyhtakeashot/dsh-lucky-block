// 用最小假 ctx 跑一遍 apply，尽早暴露宿主侧运行期错误（不依赖真实 DSH）。
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const mod = await import('../lib/index.js')
const calls = []
function fakeEvents() {
  const handlers = {}
  return {
    handlers,
    on(name, fn) { (handlers[name] ||= []).push(fn) },
    off() {},
  }
}
const ev = fakeEvents()
// webServer 只能通过 inject 属性拿到：真实宿主在 apply() 执行的那一刻还没把它
// 挂到 ctx 上，ctx.get('webServer') 会返回 null，路由就会静默不注册（→ /roll 405）。
// 这个假 ctx 故意不给 ctx.webServer，而是先断言 inject 列表里有它。
const webServerStub = {
  register(route) {
    calls.push(['route', route.path])
    return () => {}
  },
}
const ctx = {
  on: ev.on,
  inject: {},
  get(name) {
    if (name === 'webServer') return null // 模拟「apply 时还没就绪」
    if (name === 'connection') return { requestRejection() { return null } }
    if (name === 'agentPresets') return { async resolve() { return null } }
    return null
  },
  commands: {
    register(def) { calls.push(['command', def.name]); return () => {} },
  },
  effect(fn) { return fn() },
  logger: { info() {}, warn(...a) { calls.push(['warn', ...a]) }, error(...a) { calls.push(['error', ...a]) } },
}

const injectList = mod.default.inject
if (!injectList.includes('webServer')) {
  console.error(`FAIL  inject 缺少 webServer（当前: ${JSON.stringify(injectList)}）`)
  process.exit(1)
}
// inject 声明了就代表宿主会在 apply 前把它挂上来。
ctx.webServer = webServerStub

await mod.default.apply(ctx)
console.log('inject:', JSON.stringify(injectList))
console.log('registered:', JSON.stringify(calls.filter((c) => c[0] === 'route' || c[0] === 'command')))
const warns = calls.filter((c) => c[0] === 'warn')
console.log('warns:', warns.length, JSON.stringify(warns.slice(0, 5)))
console.log('events hooked:', Object.keys(ev.handlers))

const routeCount = calls.filter((c) => c[0] === 'route').length
if (routeCount !== 7) {
  console.error(
    `FAIL  期望注册 7 条路由（ping/roll/settings/save-settings/dice-prompt/sound/audio），实际 ${routeCount}`,
  )
  process.exit(1)
}

// 幸运方块注入
const q = { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }
const req = { questions: [q], agent: { id: 'session-test' } }
const hook = ev.handlers['user-questions/request'][0]
const answer = await hook(req, async () => ({ answers: [{ id: 'q1', selected: ['幸运方块'] }] }))
console.log('injected options:', JSON.stringify(req.questions[0].options))
console.log('rewritten answer:', JSON.stringify(answer))

/* ------------------------------------------------------------------ *
 * 视觉事件不碰 AI：这是本轮改动的核心不变量，必须被测试守住。
 *
 * 做法：直接测 rollDice 的「按 kind 分流」这一层。因为 rollDice 是闭包内部函数，
 * 这里改用可观测的行为断言 —— 通过 /ping 暴露的 events 清单 + 对 host 的
 * sessionController 调用计数。smoke 里没有真 host，所以退而验证事件清单里
 * kind 字段正确、且视觉事件没有 prompt（没有 prompt 就没有 AI 往返）。
 * ------------------------------------------------------------------ */

// 从 ping 路由的返回值里拿事件清单（走真实注册的 handler）。
const routes = new Map()
const realWebServer = {
  register(route) {
    routes.set(route.path, route)
    return () => {}
  },
}
const ctx2 = Object.assign({}, ctx, { webServer: realWebServer })
await mod.default.apply(ctx2)

let pingValue = null
const pingRoute = routes.get('/dsh-lucky-block/ping')
if (pingRoute) {
  // 必须给合法的 host 头：selfRejection() 第一件事就是 new URL('http://' + headers.host)，
  // 缺了它会 catch 成 403（fail-closed），测试就会误判成「插件没注册路由」。
  const res = {
    statusCode: 0,
    body: null,
    writeHead() {},
    setHeader() {},
    end(text) { this.body = text },
  }
  await pingRoute.handler(
    { method: 'GET', url: '/dsh-lucky-block/ping', headers: { host: '127.0.0.1:19399' } },
    res,
  )
  try {
    pingValue = JSON.parse(res.body).value
  } catch { /* 忽略 */ }
}

if (!pingValue) {
  console.error('FAIL  拿不到 /ping 的事件清单')
  process.exit(1)
}

const evs = pingValue.events || []
console.log('events:', JSON.stringify(evs))

let visualFail = 0
const KNOWN_KINDS = new Set(['visual', 'agent', 'local'])
for (const e of evs) {
  if (e.kind === 'visual' && e.visual === null) {
    console.error(`FAIL  事件 ${e.id} 标为 visual 却没有 visual spec`)
    visualFail += 1
  }
  if (!KNOWN_KINDS.has(e.kind)) {
    console.error(`FAIL  事件 ${e.id} 的 kind 非法: ${e.kind}`)
    visualFail += 1
  }
}

const visualIds = evs.filter((e) => e.kind === 'visual').map((e) => e.id)
const agentIds = evs.filter((e) => e.kind === 'agent').map((e) => e.id)
const localIds = evs.filter((e) => e.kind === 'local').map((e) => e.id)
console.log('visual events:', JSON.stringify(visualIds))
console.log('agent events:', JSON.stringify(agentIds))
console.log('local text events:', JSON.stringify(localIds))

if (visualIds.length === 0) {
  console.error('FAIL  没有任何 visual 事件（popups/bluescreen 应该被标为 visual）')
  visualFail += 1
}
if (!visualIds.includes('bluescreen') || !visualIds.includes('popups')) {
  console.error('FAIL  bluescreen / popups 应为 visual')
  visualFail += 1
}
if (agentIds.length === 0) {
  console.error('FAIL  没有任何 agent 事件')
  visualFail += 1
}
/* 今日运气必须是 kind='local'：它没有 AI 版本，不该在投中时建会话。 */
if (!localIds.includes('fortune')) {
  console.error('FAIL  fortune 应为 kind=local（纯本地抽签，不调 AI）')
  visualFail += 1
}

/* ------------------------------------------------------------------ *
 * 单击 / 长按两条池子（用户 m09978）
 *
 * 这是本轮改动的核心不变量：**单击不花 token、长按才调 AI**。
 * 它有三条容易破的口子，全部在这里守住：
 *   1. 有事件漏写 trigger（→ drawEvent 里永远匹配不上，事件变成抽不到的死条目）
 *   2. 单击池里混进 kind='agent'（→ 手滑点一下就开新会话、烧 token）
 *   3. 长按池里混进本地事件（→ 用户按住等 AI，结果只弹个窗）
 * ------------------------------------------------------------------ */
const TRIGGERS = new Set(['click', 'hold'])
for (const e of evs) {
  if (!TRIGGERS.has(e.trigger)) {
    console.error(`FAIL  事件 ${e.id} 的 trigger 非法: ${JSON.stringify(e.trigger)}（只能是 click / hold）`)
    visualFail += 1
  }
}
const clickIds = evs.filter((e) => e.trigger === 'click').map((e) => e.id)
const holdIds = evs.filter((e) => e.trigger === 'hold').map((e) => e.id)
console.log('click pool:', JSON.stringify(clickIds))
console.log('hold pool:', JSON.stringify(holdIds))

if (clickIds.length === 0 || holdIds.length === 0) {
  console.error('FAIL  单击池或长按池是空的（drawEvent 会抽不到事件）')
  visualFail += 1
}
/* 单击 = 零 token。任何 kind='agent' 的事件出现在单击池里都是成本泄漏。 */
for (const e of evs) {
  if (e.trigger === 'click' && e.kind === 'agent') {
    console.error(`FAIL  ${e.id} 在单击池里却是 kind=agent —— 手滑点一下就会开新会话烧 token`)
    visualFail += 1
  }
}
/* 长按 = 明确意图要等生成。本地事件放进来会让「按住 1.4 秒」白等。 */
for (const e of evs) {
  if (e.trigger === 'hold' && e.kind !== 'agent') {
    console.error(`FAIL  ${e.id} 在长按池里却不是 kind=agent（长按应该调 AI）`)
    visualFail += 1
  }
}
/* 具体归属：这些事件必须各自在对的池子里，否则用户的手感就变了。 */
for (const id of ['paper', 'news', 'todo-shuffle']) {
  if (!holdIds.includes(id)) {
    console.error(`FAIL  ${id} 应在长按池（它要调 AI）`)
    visualFail += 1
  }
}
for (const id of ['popups', 'bluescreen', 'fortune']) {
  if (!clickIds.includes(id)) {
    console.error(`FAIL  ${id} 应在单击池（零 token 本地事件）`)
    visualFail += 1
  }
}
/* 冷知识 / 冷笑话必须走本地库、待在单击池。它们曾经有 AI 版本，
   现在删了 —— 这条断言防止有人把 prepare 里的 prompt 加回来。 */
for (const id of ['trivia', 'joke']) {
  const ev = evs.find((e) => e.id === id)
  if (!ev) {
    console.error(`FAIL  事件清单里没有 ${id}`)
    visualFail += 1
  } else {
    if (ev.trigger !== 'click') {
      console.error(`FAIL  ${id} 应走单击（本地库，不调 AI），实际 trigger=${ev.trigger}`)
      visualFail += 1
    }
    if (ev.kind !== 'local') {
      console.error(`FAIL  ${id} 应为 kind=local，实际 ${ev.kind}`)
      visualFail += 1
    }
  }
}
/* Minecraft 合成表事件已按用户要求删除（m09978）。这条是反向断言：
   它会失败的唯一原因是有人把它加回来了。 */
if (evs.some((e) => e.id === 'mc-recipe')) {
  console.error('FAIL  mc-recipe 事件已按用户要求删除，不该再出现在清单里')
  visualFail += 1
}

if (visualFail > 0) process.exit(1)
console.log('visual/local split + trigger pools: OK')

/* ------------------------------------------------------------------ *
 * 本地内容库（零 token 路径）
 *
 * 守住三件事：
 *  1. 语料文件真的读得到、条数够（防止打包时漏了 jokes-data.json）
 *  2. 只有带 local.kinds 的事件才允许被勾成「不调用 AI」
 *  3. 本地内容不能泄漏内部字段（比如笑话的 form 分类）
 * ------------------------------------------------------------------ */

let localFail = 0

const jokesMod = await import('../lib/jokes.js')
const lib = await jokesMod.loadJokeLibrary()
console.log(`本地笑话库: jokes=${lib.jokes.length} quips=${lib.quips.length}`)
if (lib.jokes.length < 100) {
  console.error(`FAIL  本地笑话库条数过少（${lib.jokes.length}），jokes-data.json 可能没打包进来`)
  localFail += 1
}
if (lib.quips.length < 10) {
  console.error(`FAIL  本地点评条数过少（${lib.quips.length}）`)
  localFail += 1
}
// 语料里不允许出现英文标点（子代理明确提醒过 agent 产出会混入半角逗号）
const badPunct = lib.jokes.filter((j) => /[,;:!?]/.test(j.text))
if (badPunct.length > 0) {
  console.error(`FAIL  ${badPunct.length} 条笑话含英文标点，例如: ${badPunct[0].text.slice(0, 40)}`)
  localFail += 1
}

// 事件清单里不该再有「能不能调 AI」这类标记（那个开关已按用户要求删掉）
if (evs.some((e) => 'local' in e)) {
  console.error('FAIL  ping 的事件清单仍在暴露 local 标记（localOnly 开关已删，这个字段没有意义了）')
  localFail += 1
}

// settings 路由必须能读出只读事件清单（面板用它显示「单击 / 长按」标签）
const settingsRoute = routes.get('/dsh-lucky-block/settings')
if (!settingsRoute) {
  console.error('FAIL  没有注册 /dsh-lucky-block/settings 路由')
  localFail += 1
} else {
  const res = {
    body: null,
    writeHead() {},
    setHeader() {},
    end(text) { this.body = text },
  }
  await settingsRoute.handler(
    { method: 'GET', url: '/dsh-lucky-block/settings', headers: { host: '127.0.0.1:19399' } },
    res,
  )
  let settings = null
  try {
    settings = JSON.parse(res.body).value
  } catch { /* 忽略 */ }
  if (!settings) {
    console.error('FAIL  settings 路由没返回可解析的 value')
    localFail += 1
  } else {
    /* 反向断言：localizable / localOnly 已被删除。留着它们的话客户端会以为
       还有东西可勾，而宿主根本不认这个字段。 */
    if ('localizable' in settings || 'localOnly' in settings) {
      console.error('FAIL  settings 仍在返回 localizable/localOnly（这两个字段已删）')
      localFail += 1
    }
    const items = settings.events || []
    const ids = items.map((x) => x.id)
    console.log('settings.events:', JSON.stringify(items))
    if (!ids.includes('trivia') || !ids.includes('joke')) {
      console.error('FAIL  settings.events 缺 trivia / joke')
      localFail += 1
    }
    /* 面板靠 trigger 决定显示「单击」还是「长按」。缺了它面板会全显示成「长按」。 */
    if (items.some((x) => !TRIGGERS.has(x.trigger))) {
      console.error('FAIL  settings.events 里有条目缺 trigger')
      localFail += 1
    }
    if (items.length !== evs.length) {
      console.error(`FAIL  settings.events(${items.length}) 与 ping.events(${evs.length}) 不一致`)
      localFail += 1
    }
  }
}

if (localFail > 0) process.exit(1)
console.log('local content path: OK')

/* ------------------------------------------------------------------ *
 * 音效路由（长按挖掘音 + 碎裂音，用户 m05448）
 *
 * 这一段的价值在于：音效链路的失败**全是静默的** —— 路由没注册、
 * 白名单太严、文件名写错，症状都只是浏览器控制台一条网络错误，
 * 用户听到的只是「没声音」。所以在宿主侧把路由真跑一遍。
 * ------------------------------------------------------------------ */

const soundRoute = routes.get('/dsh-lucky-block/sound')
let soundFail = 0
const soundCheck = (ok, label, detail = '') => {
  if (!ok) soundFail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` —— ${detail}` : ''}`)
}

/** 造一个能收二进制响应的假 res（sendBinary 用的是 writeHead + end(Buffer)）。 */
function makeBinaryRes() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    setHeader() {},
    end(payload) { this.body = payload },
  }
}

console.log('\n-- 音效路由 --')
if (!soundRoute) {
  soundCheck(false, '注册了 /dsh-lucky-block/sound 前缀路由')
} else {
  soundCheck(true, '注册了 /dsh-lucky-block/sound 前缀路由')
  soundCheck(soundRoute.kind === 'prefix', '路由 kind 是 prefix', `实际 ${soundRoute.kind}`)
  soundCheck(
    typeof soundRoute.path === 'string' && !soundRoute.path.endsWith('/'),
    '路由前缀不带尾斜杠',
    `实际 ${soundRoute.path}`,
  )

  const soundNames = ['dig1.ogg', 'dig2.ogg', 'dig3.ogg', 'dig4.ogg', 'break.ogg']
  for (const name of soundNames) {
    const res = makeBinaryRes()
    await soundRoute.handler(
      { method: 'GET', url: `/dsh-lucky-block/sound/${name}`, headers: { host: '127.0.0.1:19399' } },
      res,
    )
    const buf = Buffer.isBuffer(res.body) ? res.body : null
    const magic = buf ? buf.slice(0, 4).toString('latin1') : null
    soundCheck(
      res.status === 200 && magic === 'OggS',
      `GET /sound/${name} 返回 200 + OggS`,
      `status=${res.status} magic=${JSON.stringify(magic)}`,
    )
    soundCheck(
      res.headers && res.headers['Content-Type'] === 'audio/ogg',
      `/sound/${name} Content-Type 是 audio/ogg`,
      `实际 ${res.headers && res.headers['Content-Type']}`,
    )
  }

  // 路径穿越必须被挡住 —— 这是这条路由唯一的安全边界。
  // 逐个真的打一次，不靠「正则看起来对」。
  const evil = ['../config.json', '..%2fconfig.json', 'dig1.ogg%2f..%2f..%2fconfig.json', 'dig1.mp3', 'nope.ogg']
  for (const name of evil) {
    const res = makeBinaryRes()
    await soundRoute.handler(
      { method: 'GET', url: `/dsh-lucky-block/sound/${name}`, headers: { host: '127.0.0.1:19399' } },
      res,
    )
    // 404 是「文件不存在」，500 绝不该出现（说明抛到了 handler 外面）。
    // 更要紧的是 body 不能是文件内容。
    const leaked = Buffer.isBuffer(res.body) && res.body.slice(0, 4).toString('latin1') === 'OggS'
    soundCheck(!leaked, `拒绝非法文件名 ${JSON.stringify(name)}`, `status=${res.status}`)
  }

  // 不带文件名的裸前缀访问也不该 500。
  const bare = makeBinaryRes()
  await soundRoute.handler(
    { method: 'GET', url: '/dsh-lucky-block/sound', headers: { host: '127.0.0.1:19399' } },
    bare,
  )
  soundCheck(bare.status !== 200 || !Buffer.isBuffer(bare.body), '裸前缀访问不返回音频')

  // 磁盘上应该有 16 个文件（4 挖掘 + 1 碎裂 + 3 玻璃 + 8 其它）。
  const soundsDir = new URL('../lib/sounds/', import.meta.url)
  const list = await readdir(fileURLToPath(soundsDir))
  const oggs = list.filter((f) => f.endsWith('.ogg'))
  soundCheck(oggs.length >= 5, `lib/sounds/ 至少有 5 个 .ogg`, `实际 ${oggs.length}`)
  console.log(`  lib/sounds/ 共 ${oggs.length} 个 .ogg`)
}

if (soundFail > 0) process.exit(1)
console.log('sound route: OK')

/* ------------------------------------------------------------------ *
 * 音频事件路由（用户 m09978：随机播放一段音频）
 *
 * 与 /sound 分开测，因为它是**用户自己往里放文件**的那条链路：
 * 清单在 lib/audio-tracks.json、文件在 lib/audio/、路由在 /audio。
 * 三处任何一处对不上，症状都只是「抽到了但没声音」—— 静默失败。
 * 现在曲库还是空的（用户过段时间给清单），所以这里**允许为空**，
 * 但格式与安全边界必须现在就立住。
 * ------------------------------------------------------------------ */

const audioRoute = routes.get('/dsh-lucky-block/audio')
let audioFail = 0
const audioCheck = (ok, label, detail = '') => {
  if (!ok) audioFail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` —— ${detail}` : ''}`)
}

console.log('\n-- 音频事件路由 --')
if (!audioRoute) {
  audioCheck(false, '注册了 /dsh-lucky-block/audio 前缀路由')
} else {
  audioCheck(true, '注册了 /dsh-lucky-block/audio 前缀路由')
  audioCheck(audioRoute.kind === 'prefix', '路由 kind 是 prefix', `实际 ${audioRoute.kind}`)
  audioCheck(
    typeof audioRoute.path === 'string' && !audioRoute.path.endsWith('/'),
    '路由前缀不带尾斜杠（带尾斜杠永远匹配不上）',
  )

  /* 与 /sound 同一套穿越用例，外加 .mp3 —— 这条路由**允许** mp3，
     所以 `dig1.mp3` 在这里应该是「文件不存在」而不是「文件名非法」，
     但两者都是 404，判据仍然是「没有把内容吐出来」。 */
  const evilAudio = [
    '../config.json',
    '..%2fconfig.json',
    'song.mp3%2f..%2f..%2fconfig.json',
    'nope.ogg',
    'nope.mp3',
    'song.exe',
  ]
  for (const name of evilAudio) {
    const res = makeBinaryRes()
    await audioRoute.handler(
      { method: 'GET', url: `/dsh-lucky-block/audio/${name}`, headers: { host: '127.0.0.1:19399' } },
      res,
    )
    const leaked =
      Buffer.isBuffer(res.body) &&
      (res.body.slice(0, 4).toString('latin1') === 'OggS' || res.body.slice(0, 3).toString('latin1') === 'ID3')
    audioCheck(!leaked, `拒绝非法/不存在的音频 ${JSON.stringify(name)}`, `status=${res.status}`)
  }

  const bareAudio = makeBinaryRes()
  await audioRoute.handler(
    { method: 'GET', url: '/dsh-lucky-block/audio', headers: { host: '127.0.0.1:19399' } },
    bareAudio,
  )
  audioCheck(bareAudio.status !== 200 || !Buffer.isBuffer(bareAudio.body), '裸前缀访问不返回音频')

  /* 清单与文件的一致性：曲库为空是正常状态，非空则每个文件都得真在。
     这条不能省 —— 用户填了清单却没放文件时，症状就是「点了没声音」。 */
  const tracksRaw = await readFile(new URL('../lib/audio-tracks.json', import.meta.url), 'utf8').catch(() => null)
  audioCheck(tracksRaw !== null, 'lib/audio-tracks.json 存在')
  if (tracksRaw !== null) {
    let tracks = null
    try {
      tracks = JSON.parse(tracksRaw.charCodeAt(0) === 0xfeff ? tracksRaw.slice(1) : tracksRaw)
    } catch (error) {
      audioCheck(false, 'lib/audio-tracks.json 可解析', error.message)
    }
    if (Array.isArray(tracks)) {
      /* 音频事件是**一库一事件**（`...audioEvents(tracks)` 展开），
         所以判据从「有没有一条叫 audio 的事件」变成「`audio-` 前缀的条数对不对」。
         数对不上通常意味着源文件的 audioEvents() 和这里的展开规则漂移了。 */
      const audioIds = evs.map((e) => e.id).filter((id) => id.startsWith('audio-'))
      if (tracks.length === 0) {
        console.log('  曲库为空 → 没有任何音频事件，这是正常状态')
        audioCheck(audioIds.length === 0, '空曲库时没有 audio-* 事件')
      } else {
        audioCheck(
          audioIds.length === tracks.length,
          `曲库 ${tracks.length} 条时 audio-* 事件也是 ${tracks.length} 个`,
          `实际 ${audioIds.length} 个：${JSON.stringify(audioIds)}`,
        )
        const present = new Set(await readdir(fileURLToPath(new URL('../lib/audio/', import.meta.url))).catch(() => []))
        const missing = tracks.map((t) => t && t.file).filter((f) => typeof f === 'string' && !present.has(f))
        audioCheck(missing.length === 0, '曲库引用的文件都在 lib/audio/', `缺 ${JSON.stringify(missing)}`)
      }
    } else if (tracks !== null) {
      audioCheck(false, 'lib/audio-tracks.json 是数组', typeof tracks)
    }
  }
}

if (audioFail > 0) process.exit(1)
console.log('audio route: OK')

/* ------------------------------------------------------------------ *
 * 人格层
 * ------------------------------------------------------------------ */

const persona = await import('../lib/persona.js')
let personaFail = 0

// 1. 默认人格必须完整可用
// 注意：字段清单里**没有 `name`** —— 用户要求 prompt 里不出现任何角色名，
// 所以人格层整个不带名字（`mergePersona` 仍接受 `name` 覆盖以兼容老 config，只是不透出）。
const def = persona.mergePersona(null)
for (const key of ['identity', 'address', 'traits', 'volumeLines', 'badUserLines']) {
  const v = def[key]
  const ok = Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.length > 0
  if (!ok) {
    console.error(`FAIL  默认人格缺字段 ${key}`)
    personaFail += 1
  }
}
// 翻转机制已整个删掉（用户要求：它只是个话唠系统，不该有第二人格）
if ('flippedTraits' in def) {
  console.error('FAIL  人格层不该再有 flippedTraits')
  personaFail += 1
}
if (!(def.name === undefined || typeof def.name === 'string')) {
  console.error('FAIL  name 若存在必须是字符串')
  personaFail += 1
}
if (def.address !== '用户') {
  console.error(`FAIL  默认称呼应为「用户」，实际 ${def.address}`)
  personaFail += 1
}

// 2. 用户配置覆盖：整段替换语义
const overridden = persona.mergePersona({ identity: '一个不说话的进程。', traits: ['只说一句话。'], bogus: 1, traits2: [] })
if (overridden.identity !== '一个不说话的进程。') {
  console.error('FAIL  identity 未被覆盖')
  personaFail += 1
}
if (overridden.traits.length !== 1) {
  console.error(`FAIL  traits 应整段替换为 1 条，实际 ${overridden.traits.length}`)
  personaFail += 1
}
if (overridden.bogus !== undefined) {
  console.error('FAIL  未知字段 bogus 不该被合并进来')
  personaFail += 1
}
// 被忽略的空数组不该把默认值清空（否则人格会变成「无性格」）
const emptied = persona.mergePersona({ traits: [], volumeLines: ['   '] })
if (emptied.traits.length !== def.traits.length) {
  console.error('FAIL  空 traits 不该清空默认人格')
  personaFail += 1
}
// 垃圾输入必须退化成默认值，不能抛
for (const junk of [42, 'x', [], true]) {
  const m = persona.mergePersona(junk)
  if (m.identity !== def.identity) {
    console.error(`FAIL  mergePersona(${JSON.stringify(junk)}) 未退化成默认人格`)
    personaFail += 1
  }
}

// 3. 人格块内容：正常/坏用户两条分支都要出东西
const normalBlock = persona.buildPersonaBlock(def, {})
const badBlock = persona.buildPersonaBlock(def, { mood: 'bad' })
for (const [label, block] of [['normal', normalBlock], ['bad', badBlock]]) {
  if (typeof block !== 'string' || block.length < 40) {
    console.error(`FAIL  ${label} 人格块过短`)
    personaFail += 1
  }
}
// 传 flipped 不再有任何效果 —— 机制已删，这里守住「别偷偷长回来」
if (persona.buildPersonaBlock(def, { flipped: true }) !== normalBlock) {
  console.error('FAIL  flipped 参数不该再改变人格块')
  personaFail += 1
}
if (!badBlock.includes('坏蛋用户')) {
  console.error('FAIL  坏用户态应包含「坏蛋用户」')
  personaFail += 1
}
if (!normalBlock.includes('用户')) {
  console.error('FAIL  正常人格块应使用「用户」称呼')
  personaFail += 1
}
// 人格块绝不能泄漏编造内容或任何专名（制造商 / 作品名 / 拉丁文人名）
if (/(制造商是|出厂|生产商|由.{0,6}公司制造)|《[^》]{1,20}》|\b[A-Z][a-z]{3,}\b/.test(normalBlock)) {
  console.error('FAIL  人格块出现编造内容或专名')
  personaFail += 1
}

// 4. 包装器：任务正文必须原样保留（这是最容易写错的地方 ——
//    人格改写任务描述会让 agent 丢掉「落盘到某文件」这类硬要求）
const marker = '落盘到 lucky-block-papers/deadbeef.md'
const wrapped = persona.wrapWithPersona(def, { title: '随机选题写论文', body: marker })
if (!wrapped.includes(marker)) {
  console.error('FAIL  wrapWithPersona 丢掉了任务正文')
  personaFail += 1
}
if (!wrapped.includes('随机选题写论文')) {
  console.error('FAIL  wrapWithPersona 没带上事件标题')
  personaFail += 1
}

// 5. 收尾请求
const outro = persona.buildOutroRequest(def, { title: '随机冷知识闲聊' })
if (typeof outro !== 'string' || outro.length < 20) {
  console.error('FAIL  buildOutroRequest 返回值异常')
  personaFail += 1
}
const outroBad = persona.buildOutroRequest(def, { title: 'x', state: { mood: 'bad' } })
if (!outroBad.includes('坏蛋用户')) {
  console.error('FAIL  坏用户态的收尾应只重复「坏蛋用户」')
  personaFail += 1
}

if (personaFail > 0) process.exit(1)
console.log('persona layer: OK')

/* 新事件必须存在（用户明确要求「冷笑话、时事新闻」） */
for (const id of ['joke', 'news']) {
  if (!evs.some((e) => e.id === id)) {
    console.error(`FAIL  缺少事件 ${id}`)
    process.exit(1)
  }
}
const totalWeight = evs.reduce((s, e) => s + (Number(e.weight) || 0), 0)
console.log(`events total: ${evs.length}, weight ${totalWeight}`)
console.log('joke/news present: OK')

/* ------------------------------------------------------------------ *
 * 文档/自省工具与运行期清单必须一致
 *
 * 这条守的是一个真实踩过的坑：tools/list-events.mjs 曾用「id/weight/title
 * 三行相邻」的正则去解析源码，加了 kind 字段之后它静默漏掉了全部视觉事件 ——
 * 输出看起来完全正常，只是少两行。这里强制两者对齐，让漂移在 CI 里就爆掉。
 * ------------------------------------------------------------------ */
const { execFileSync } = await import('node:child_process')
let listed = []
try {
  const out = execFileSync(process.execPath, ['tools/list-events.mjs'], { encoding: 'utf8' })
  listed = out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    /* 只认真实数据行。数据行的形状是：id / 类型 / 权重 / 概率 / 说明，
       所以**第三列必须是数字**。这条判据能一次挡掉两种伪命中：
       · 表头行 `id 类型 权重 概率 说明` —— `id` 是合法的 `[a-z0-9-]+`、列数也够，
         不加数字校验会被当成一个 id 为 "id" 的事件（踩过，报的是
         「解析到 9 个事件，运行期有 8 个」这种驴唇不对马嘴的错）。
       · 分隔线行 `---------…` —— 单独用 `/^[a-z0-9-]+$/` 是放行连字符的。 */
    .filter((cols) => cols.length >= 5 && /^[a-z0-9-]+$/.test(cols[0]) && /^\d+$/.test(cols[2]))
    /* 三种类型都要认：曾经写成 `cols[1] === '视觉' ? 'visual' : 'agent'`，
       把 kind=local 的事件（今日运气 / 冷知识 / 冷笑话）全当成 agent，
       于是「本地事件必须零 token」这条不变量对它们静默失效。 */
    .map((cols) => ({
      id: cols[0],
      kind: cols[1] === '视觉' ? 'visual' : cols[1] === '本地' ? 'local' : 'agent',
      weight: Number(cols[2]),
    }))
} catch (error) {
  const raw = String(error?.message ?? error)
  if (raw.includes('EPERM')) {
    /* DSH 的 Windows 文件沙箱禁止子进程用管道捕获输出（node spawnSync 默认
       stdio:'pipe' 会 EPERM）。这是沙箱边界、不是代码错误，所以跳过而不是判失败 ——
       否则本地一跑就是红的，测试会被当成噪音然后被无视。
       想真跑这一步就用 `node tools/list-events.mjs` 单独看，或让整个 smoke 在沙箱外跑。 */
    console.log('list-events 一致性检查：SKIP（子进程管道被沙箱拦下，EPERM）')
    listed = null
  } else {
    console.error(`FAIL  跑不通 tools/list-events.mjs: ${raw}`)
    process.exit(1)
  }
}

if (listed) {
  if (listed.length !== evs.length) {
    console.error(`FAIL  list-events 解析到 ${listed.length} 个事件，运行期有 ${evs.length} 个`)
    process.exit(1)
  }
  for (const e of evs) {
    const l = listed.find((x) => x.id === e.id)
    if (!l) {
      console.error(`FAIL  list-events 漏掉了事件 ${e.id}`)
      process.exit(1)
    }
    if (l.kind !== e.kind) {
      console.error(`FAIL  事件 ${e.id} 的 kind 不一致: 工具=${l.kind} 运行期=${e.kind}`)
      process.exit(1)
    }
    if (l.weight !== (Number(e.weight) || 0)) {
      console.error(`FAIL  事件 ${e.id} 的 weight 不一致: 工具=${l.weight} 运行期=${e.weight}`)
      process.exit(1)
    }
  }
  console.log(`list-events 与运行期一致: OK (${listed.length} 个事件)`)
}


