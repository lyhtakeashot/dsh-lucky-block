/**
 * 音频事件端到端探针：在**真实 dsh 进程**上验证三件事。
 *
 * 用法：node tools/probe-audio.mjs [port]
 *   令牌从 docs/.probe-token 读。
 *
 * 验什么：
 *   1. `/dsh-lucky-block/audio/<file>` 能把每一首歌真的发出来（Ogg 魔数 + 字节数）；
 *      路径穿越被拒；
 *   2. `settings()` 的清单里每一首歌都是**独立一条** `audio-<文件名>`，
 *      而不是一条笼统的 `audio`；
 *   3. 关掉其中一首之后，**它真的抽不到了，另外两首不受影响**。
 *
 * 第 3 条必须重启宿主才生效（事件的抽取池在 apply 时建好一次，
 * 这也是 README 里「改事件权重/开关要重启 dsh」的来源）。所以这个探针
 * 只验「写下开关之后 settings 认了」，并在结尾打印一条提醒 ——
 * 真验抽取池要靠重启后重跑，那种跨进程的验证塞不进一个脚本里。
 *
 * ⚠ 认证不是「把 token 塞进 cookie」：宿主只认 `GET /?token=<t>` 那次响应里
 * 下发的 Set-Cookie，而且 cookie 名是动态的 `dsh-auth-<hash>`。
 * 两个坑：① fetch 默认跟随 303 重定向，会把这枚 Set-Cookie 丢掉 → 必须
 * `redirect: 'manual'`；② 自己拼 cookie 名会一路 401，看起来像「路由没注册」。
 */
import { readFileSync } from 'node:fs'

const port = Number(process.argv[2] || 19399)
const HOST = `127.0.0.1:${port}`

let token
try {
  token = readFileSync(new URL('../docs/.probe-token', import.meta.url), 'utf8').trim()
} catch {
  console.error('读不到 docs/.probe-token —— 先启动克隆 profile 并把 token 写进去。')
  process.exit(1)
}

async function request(path, headers = {}, body) {
  const res = await fetch(`http://${HOST}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: HOST, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {
    /* 音频等二进制响应留 buffer */
  }
  return { status: res.status, headers: res.headers, body: buf, json }
}

const exchange = await request(`/?token=${encodeURIComponent(token)}`)
const cookie = (exchange.headers.getSetCookie?.() ?? []).map((c) => String(c).split(';')[0]).join('; ')
if (cookie.length === 0) {
  console.error(`没拿到 cookie（token 过期？status=${exchange.status}）`)
  process.exit(1)
}

let fail = 0
const check = (ok, label, detail = '') => {
  /* 参数顺序写反时（label 和 boolean 换位）以前会静默通过 —— `ok` 收到
     非空字符串是真值，于是永远 PASS，标签位置印出一个 `true`。
     这类错误在输出里长得就只是「PASS true」，很容易被当成数据。 */
  if (typeof ok !== 'boolean') {
    console.error(`  BAD   check() 的第一个参数必须是布尔，收到 ${typeof ok}：${JSON.stringify(ok)}`)
    fail += 1
    return
  }
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` —— ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1. 清单：一首歌一条
 * ------------------------------------------------------------------ */

const settings = await request('/dsh-lucky-block/settings', { cookie })
check(settings.status === 200, 'settings 可读', `status=${settings.status}`)
const events = settings.json?.value?.events ?? []
const audioEvents = events.filter((e) => String(e.id).startsWith('audio-'))
check(audioEvents.length > 0, '清单里有 audio-* 事件', JSON.stringify(audioEvents.map((e) => e.id)))

/* 每条 audio-* 都得带 kind:'local' 和 trigger:'click' —— 组合错了的后果是
   「抽到了但它建了个会话」或「长按才放歌」，两种都很难在界面上看出来。 */
for (const ev of audioEvents) {
  check(ev.kind === 'local' && ev.trigger === 'click', `${ev.id} 是本地单击事件`, `${ev.kind}/${ev.trigger}`)
  check(ev.weight > 0, `${ev.id} 权重 > 0`, `weight=${ev.weight}`)
}
/* id 必须和 title 对得上，否则「关掉某一首」时用户不知道该关哪行。 */
check(
  audioEvents.every((e) => e.title && e.title.trim().length > 0 && !/^audio-/.test(e.title)),
  '每条 audio-* 都有可读的曲名（不是把 id 直接当标题）',
  JSON.stringify(audioEvents.map((e) => e.title)),
)

/* ------------------------------------------------------------------ *
 * 2. 文件真的能发出来
 * ------------------------------------------------------------------ */

const tracksRaw = readFileSync(new URL('../lib/audio-tracks.json', import.meta.url), 'utf8')
const tracks = JSON.parse(tracksRaw.charCodeAt(0) === 0xfeff ? tracksRaw.slice(1) : tracksRaw)
check(Array.isArray(tracks) && tracks.length > 0, 'lib/audio-tracks.json 非空', `${tracks.length} 条`)

for (const track of tracks) {
  /* 模拟浏览器 <audio> 的真实请求头：带 Referer/Sec-Fetch，由 cookie 认证。 */
  const res = await request(`/dsh-lucky-block/audio/${track.file}`, {
    cookie,
    referer: `http://${HOST}/`,
    'sec-fetch-dest': 'audio',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'same-origin',
    accept: 'audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.5',
  })
  /* Ogg 的魔数是 "OggS"。只认状态码不够 —— 路由把 JSON 错误体发回来时
     状态码也可能是 200，客户端表现是「播放器报错但界面没提示」。 */
  const magic = res.body.slice(0, 4).toString('latin1')
  check(
    res.status === 200 && magic === 'OggS' && res.body.length > 100000,
    `GET /audio/${track.file}`,
    `status=${res.status} magic=${JSON.stringify(magic)} bytes=${res.body.length} ct=${res.headers.get('content-type')}`,
  )
}

/* 穿越尝试在真 HTTP 层也必须被挡。 */
for (const evil of ['../config.json', '..%2fconfig.json', 'nope.ogg', 'song.exe']) {
  const res = await request(`/dsh-lucky-block/audio/${encodeURIComponent(evil)}`, { cookie })
  const magic = res.body.slice(0, 4).toString('latin1')
  const leaked = magic === 'OggS' || res.body.toString('utf8').includes('"model"')
  check(!leaked, `拒绝 ${JSON.stringify(evil)}`, `status=${res.status}`)
}

/* ------------------------------------------------------------------ *
 * 3. 能否单独关掉一首
 * ------------------------------------------------------------------ */

if (audioEvents.length >= 2) {
  /* 挑中间那条 —— 排除「实现其实是按前缀或按顺序砍的」这种巧合。 */
  const target = audioEvents[Math.floor(audioEvents.length / 2)]
  const original = settings.json?.value?.eventOverrides ?? {}

  const saved = await request('/dsh-lucky-block/save-settings', { cookie }, {
    events: Object.assign({}, original, { [target.id]: { enabled: false } }),
  })
  check(saved.status === 200, 'save-settings 成功', `status=${saved.status}`)

  const after = await request('/dsh-lucky-block/settings', { cookie })
  const afterMap = new Map((after.json?.value?.events ?? []).map((e) => [e.id, e]))
  check(afterMap.get(target.id)?.enabled === false, `关掉的是 ${target.id}`, JSON.stringify(afterMap.get(target.id) ?? null))

  /* 这里**不**断言 weight 变成 0。回显里的 `weight` 读的是
     `overrides[id].weight ?? e.weight`：客户端取消勾选时会额外写 `weight: 0`，
     所以面板路径下确实是 0；但只手写 `enabled: false` 时 weight 仍是出厂值。
     真正决定「摘不摘」的是 applyEventOverrides 里的 `patch.enabled === false`
     （tools/events-check.mjs 有对应断言），权重是并列条件不是必要条件。 */
  for (const ev of audioEvents.filter((e) => e.id !== target.id)) {
    const now = afterMap.get(ev.id)
    check(now && now.enabled !== false && now.weight > 0, `${ev.id} 不受影响（这才是「单独关」）`,
      `enabled=${now?.enabled} weight=${now?.weight}`)
  }

  /* 还原：探针不能给用户留下一首被关掉的歌。 */
  const restore = await request('/dsh-lucky-block/save-settings', { cookie }, { events: original })
  check(restore.status === 200, '还原覆盖层成功', `status=${restore.status}`)
  const final = await request('/dsh-lucky-block/settings', { cookie })
  const finalMap = new Map((final.json?.value?.events ?? []).map((e) => [e.id, e]))
  check(finalMap.get(target.id)?.enabled !== false, `${target.id} 已恢复`, JSON.stringify(finalMap.get(target.id) ?? null))
} else {
  console.log('  曲库不足两条，跳过「单独关一首」的验证')
}

/* ------------------------------------------------------------------ *
 * 4. 歌词随事件一起下来
 * ------------------------------------------------------------------ */

/* 直接指定要哪一条，不走抽签。音乐合计只占单击池 5%，带歌词的那首每次约
   0.83% —— 靠循环去碰就是拿运气当回归信号。反正要验的是「宿主有没有把歌词
   挂到事件上」，那件事和它出现的概率毫无关系。
   指定走的是和随机完全相同的下游（同一个 prepare、同一个 kind 分支），
   所以这里看到的 payload 就是真抽到时会看到的 payload。 */
const lyricHit = (await request('/dsh-lucky-block/roll', { cookie }, {
  trigger: 'click',
  event: 'audio-never-give-you-up',
})).json?.value?.audio ?? null
check(lyricHit !== null, '指定 audio-never-give-you-up 拿到了 audio payload', JSON.stringify(lyricHit))
if (lyricHit !== null) {
  check(lyricHit.file === 'never-give-you-up.ogg', '带歌词的是 never-give-you-up', lyricHit.file)
  check(lyricHit.lyrics.length >= 10, '歌词行数够', `${lyricHit.lyrics.length} 行`)
  check(
    lyricHit.lyrics.every((l) => Number.isFinite(l.t) && typeof l.text === 'string' && l.text.length > 0),
    '歌词每行都是 {t:number, text:string}',
    JSON.stringify(lyricHit.lyrics[0] ?? null),
  )
  check(
    lyricHit.lyrics.every((l, i) => i === 0 || l.t > lyricHit.lyrics[i - 1].t),
    '歌词时间轴严格递增',
  )
  check(lyricHit.lyrics[0].t <= 5, '歌词第一句在 5 秒内', `${lyricHit.lyrics[0].t}s`)
  /* 时间是**片段内**秒数：片段 42 秒，越界的话客户端会一路显示到结尾，
     表现为「歌停了字幕还挂在那儿」。 */
  check(
    lyricHit.lyrics.every((l) => l.t >= 0 && l.t < 42),
    '所有时间点落在 42 秒片段内',
    `最大 ${Math.max(...lyricHit.lyrics.map((l) => l.t))}s`,
  )
  console.log(`  拿到带歌词的那首：${lyricHit.title}（${lyricHit.lyrics.length} 行）`)

  /* 没做歌词的歌必须发 null，而不是空数组或一个假的空时间轴 ——
     客户端靠 Array.isArray 判断，两者在客户端没区别，但 null 更诚实。 */
  const plainHit = (await request('/dsh-lucky-block/roll', { cookie }, {
    trigger: 'click',
    event: 'audio-satisfied',
  })).json?.value?.audio ?? null
  check(plainHit !== null, '指定 audio-satisfied 拿到了 audio payload', JSON.stringify(plainHit))
  check(plainHit?.lyrics === null, '没做歌词的歌发的是 null', plainHit ? JSON.stringify(plainHit.lyrics) : 'payload 为空')
}

/* 指定不存在 / 不属于这一池的事件时必须报错，而不是静默抽一条别的 ——
   静默放行会让「我传了 event 却没按我说的来」变成只能靠猜的问题。 */
const bogus = await request('/dsh-lucky-block/roll', { cookie }, { trigger: 'click', event: 'no-such-event' })
check(bogus.status !== 200 && bogus.json?.ok === false, '指定不存在的事件被拒绝', `status=${bogus.status}`)
const wrongPool = await request('/dsh-lucky-block/roll', { cookie }, {
  trigger: 'click',
  event: 'paper',
})
check(wrongPool.status !== 200 && wrongPool.json?.ok === false, '指定另一个池子的事件被拒绝', `status=${wrongPool.status}`)

console.log('')
console.log('  注意：事件的抽取池在 apply 时建好一次，所以上面的开关**要重启 dsh 才影响抽取**。')
console.log('  跨重启的验证（关掉后 400 次单击里 0 命中）是手工做过的，脚本做不了进程重启。')

console.log(fail === 0 ? '\nALL GREEN —— 音频路由可用、每首歌独立可开关，歌词随事件一起下来。' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
