/**
 * dsh-lucky-block — 宿主侧（Node 端）插件实现。
 *
 * 两大功能：
 *  1. 幸运方块选项：模型通过 ask_user_question 提问时，在每个问题的选项末尾
 *     追加一个「幸运方块」。用户选中它 → 由宿主真随机地挑一个原选项，或把若干
 *     原选项融合成一句新方案，写回答案的 custom 字段；同时用
 *     system-prompt/assemble 告诉模型「用户按幸运方块行事」的语义。
 *     口令 /rollback（或说「回滚」）→ fork 回到上一个版本边界。
 *  2. 幸运方块随机事件：客户端方块按钮或 /dice → 在默认工作区新建会话，全程无人
 *     干预地随机干一件事（写论文 / 无害弹窗表演 / 60 秒蓝屏 / 冷知识闲聊 /
 *     随机整理待办）。
 *
 * 设计约束（全部来自对 dsh 安装包内源码的调研）：
 *  - inject 只写确定存在的服务；可选服务一律 ctx.get(name) 懒查
 *    （dsh-notify-me/lib/client.js:1312 的教训：把可选服务写进 inject，
 *     服务缺失会让整个 entry 永不激活）。
 *  - 用户数据落 $DSH_HOME（node_modules 可能只读）。
 *  - 自定义 webserver 路由必须自带信任栅栏，否则会绕过宿主鉴权
 *    （dsh-whale-widget/lib/index.js:803-885 的三层栅栏：自校验 → 委托宿主
 *     connection.requestRejection → 写请求必须来自回环）。
 *  - 客户端 bundle 通过 package.json 的 dsh.client 声明加载，不在 cordis.patch.yml 登记。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadJokeLibrary } from './jokes.js'
import { buildOutroRequest, mergePersona, wrapWithPersona } from './persona.js'

const PLUGIN_ID = 'dsh-lucky-block'
const PLUGIN_NAME = 'dsh-lucky-block'
const VERSION = '0.2.0'

/** 幸运方块追加到每个选择题末尾的选项标签。 */
export const LUCKY_LABEL = '幸运方块'

/** 回滚口令（slash command 名；说「回滚」也能命中）。 */
const ROLLBACK_COMMAND = 'rollback'
/** 幸运方块口令：不新建会话，直接在当前会话触发一次随机事件。 */
const DICE_COMMAND = 'dice'

/** 蓝屏事件时长：60 秒，ESC 提前结束。 */
const BLUESCREEN_MS = 60_000
/** 弹窗表演：窗口数量与间隔。 */
const POPUP_COUNT = 24
const POPUP_INTERVAL_MS = 450

const STATE_VERSION = 2

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function env(name, fallback = '') {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** 骰子会话的模型配置文件名（放在 stateDir 下，与 dsh-whale-widget 的做法一致）。 */
const CONFIG_FILE = 'config.json'

/** 用户数据根目录：$DSH_HOME 优先，node_modules 可能只读。 */
function dataRoot() {
  return env('DSH_HOME') || path.join(os.homedir(), '.dsh')
}

function stateDir() {
  return path.join(dataRoot(), 'plugins', PLUGIN_ID)
}

/** 人格持久状态（跨会话的掷骰计数与 mood 标记）。 */
function personaStateFile() {
  return path.join(stateDir(), 'persona-state.json')
}

/** 今日运气的持久状态（记录当天抽到的签，用于「一天只能抽一次」）。 */
function fortuneStateFile() {
  return path.join(stateDir(), 'fortune-state.json')
}

async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/**
 * 读 JSON 文件。
 *
 * 必须吃掉 UTF-8 BOM：Windows 记事本、PowerShell 的 `Set-Content -Encoding UTF8`、
 * 以及不少编辑器保存 JSON 时都会在开头写 EF BB BF。而 `JSON.parse` 遇到 BOM 会
 * 直接抛 `SyntaxError: Unexpected token` —— 于是配置文件「明明写对了」却完全不生效，
 * 且因为这里是 catch 掉返回 fallback，**连个错都不会报**，极难排查（实测踩过）。
 */
async function readJson(file, fallback) {
  try {
    return JSON.parse(stripBom(await readFile(file, 'utf8')))
  } catch {
    return fallback
  }
}

/** 去掉开头的 UTF-8 BOM（U+FEFF）。 */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  // 明确不带 BOM：Node 写 utf8 本来就不写 BOM，这里只是把意图写清楚。
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 本地内容库（零 token 路径）
 * ------------------------------------------------------------------ */

/** 插件包根目录（lib/ 的上一级），用来定位随包发布的 trivia-data.json。 */
function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 冷知识库缓存。读一次就够 —— 它是随包发布的静态文件，不像 config.json 会被用户改。 */
let triviaCache = null

/**
 * 读随包发布的冷知识库 `lib/trivia-data.json`。
 *
 * 与 config.json 的区别很重要：**这个文件是插件自带的，用户不会改**，
 * 所以可以放心缓存；config.json 必须每次重读（用户随时可能在设置里改）。
 *
 * 读不到时返回空数组而不是抛错：本地库缺失只该让那一条事件退回 AI 路径，
 * 不该让整个掷骰子失败。
 */
async function localTrivia() {
  if (triviaCache) return triviaCache
  const file = path.join(packageRoot(), 'lib', 'trivia-data.json')
  const parsed = await readJson(file, null)
  if (!Array.isArray(parsed)) {
    // 这里拿不到插件自己的 logger（它在 apply 作用域里），只记在返回值里，
    // 由调用方决定要不要出声。缺文件不是致命错误，退回 AI 路径即可。
    triviaCache = []
    return triviaCache
  }
  // 只接受形状正确的条目：text 必须是非空字符串。脏条目静默丢弃。
  triviaCache = parsed
    .filter((item) => item && typeof item.text === 'string' && item.text.trim().length > 0)
    .map((item) => ({
      text: item.text.trim(),
      topic: typeof item.topic === 'string' && item.topic.length > 0 ? item.topic : '杂项',
      // source 只作库内元数据（人工核查时用），不参与抽取，也不展示给用户。
      source: typeof item.source === 'string' ? item.source : '',
    }))
  return triviaCache
}

/** 稳定的伪随机：同一 seed 必然同一结果（便于复现与排查）。 */
function hashSeed(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

/** mulberry32：小巧、够快、够随机的确定性 PRNG。 */
function prng(seedText) {
  let a = parseInt(hashSeed(seedText), 16) >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length]
}

/** 不重复地取 n 个。 */
function pickMany(rand, list, count) {
  const pool = [...list]
  const out = []
  const n = Math.max(1, Math.min(count, pool.length))
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(rand() * pool.length) % pool.length
    out.push(pool.splice(i, 1)[0])
  }
  return out
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, Math.max(0, ms))
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/** 从任意内容块列表里抽出纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/* ------------------------------------------------------------------ *
 * 随机语料
 * ------------------------------------------------------------------ */

/** 随机词条组合成选题（论文事件）。 */
const TOPIC_ADJECTIVES = ['边缘计算', '具身智能', '多模态对齐', '因果推断', '低资源', '时序图神经', '联邦', '可解释', '稀疏专家', '量子启发']
const TOPIC_DOMAINS = ['城市交通流预测', '古籍数字化', '县域医疗分诊', '短视频推荐', '农田病害识别', '海上风电调度', '手语翻译', '方言语音识别', '图书馆推荐', '冷链物流追踪']
const TOPIC_ANGLES = ['的鲁棒性研究', '的效率优化方法', '的可解释性分析', '的小样本学习路径', '中的隐私保护机制', '的因果结构发现', '的综述与展望', '的轻量化部署']

/** 无意义弹窗文案（无害版「著名病毒」）。 */
const POPUP_TITLES = ['系统提示', '温馨提示', '重要通知', '来自好友的消息', '中奖提醒', '更新提示', '订阅确认', '缓存清理', '彩蛋']
const POPUP_BODIES = [
  '您的操作已成功，但什么也没有发生。',
  '检测到一次愉快的点击，已为您记录并遗忘。',
  '本次弹窗由幸运方块随机生成，不含任何实际内容。',
  '正在为您努力地原地待命……',
  '温馨提示：关掉它不会失去任何东西。',
  '系统运行良好，除了这句话之外。',
  '已收到您的关注，暂无后续。',
  '恭喜！您获得了一次「再抽一次」的机会。',
]

/** 蓝屏屏保文案（模仿 Windows 悲伤脸，只盖住 dsh 窗口自身）。
 *
 *  三张脸轮着用：同一句「你的插件遇到了一点小情绪」看第二遍就没劲了，
 *  而这三张里没有一张是真的错误 —— 都是同一件事的三种说法。
 *  每张都带自己的错误码，且错误码里藏着梗：0x0000LUCKY / 0xDEADBEEF 的变体 /
 *  0x00C0FFEE（coffee）。用户要是真去读，读到的是笑话不是报错。 */
const BLUESCREEN_VARIANTS = [
  {
    background: '#0a4db3',
    heading: ':(',
    lines: [
      '你的插件遇到了一点小情绪，需要重新思考方块的意义。',
      'STOP: 0x0000LUCKY (LUCKY_BLOCK_ROLLED_TOO_MANY_TIMES)',
      '正在收集错误信息，然后全部丢弃……',
      '别担心，这只是幸运方块的玩笑，60 秒后自动结束，按 ESC 提前离场。',
    ],
  },
  {
    background: '#0b3f8f',
    heading: ':( ',
    lines: [
      '系统正在重启一个本来就不需要重启的东西。',
      'STOP: 0x00C0FFEE (COFFEE_NOT_ENOUGH_TO_CONTINUE)',
      '进度：0%　预计剩余时间：也是 0%',
      '这不是错误，这是一次有礼貌的停顿。按 ESC 可以立刻醒过来。',
    ],
  },
  {
    background: '#12386e',
    heading: ':\\',
    lines: [
      '一切正常。所以屏幕决定蓝一下，确认你真的在看。',
      'STOP: 0x0BADF00D (BAD_FOOD_IN_CACHE)',
      '已尝试自我修复：失败了，但态度很好。',
      '六十秒后自动退场。等不及就按 ESC。',
    ],
  },
]

/** 顺手留一条默认文案的引用：客户端兜底用得到（不走导出的地方也能拿到）。 */
const BLUESCREEN_LINES = BLUESCREEN_VARIANTS[0].lines

/* ---------------- 事件权重 / 开关的用户覆盖层 ---------------- */

/**
 * 事件权重 / 开关的用户覆盖层。
 *
 * 从 `config.json` 的 `events` 字段读（**读-改-写**，不整份覆盖 ——
 * 用户的 model / persona 配置也在同一个文件里）。形状：
 *
 * ```json
 * { "events": { "trivia": { "weight": 8, "enabled": true },
 *              "paper": { "enabled": false } } }
 * ```
 *
 * 只认两个字段，都是可选的：写哪个改哪个，没写的保持原样。
 * `weight` 会经 `clampWeight` 夹到 [0, 25]：0 等价于关掉（见 applyEventOverrides 的
 * 排序说明），25 已经是「每条事件最多占四分之一」的量级，再大就没有意义了。
 *
 * 这里刻意**不**支持「新增一条事件」：内置事件都在 buildEvents() 里写死 prompt 与
 * prepare 逻辑，一个只带 id/weight 的 JSON 造不出真的行为。第三方事件扩展走
 * `custom-events.json`（见 docs/DESIGN.md 的扩展点章节）。
 */
const EVENT_OVERRIDE_LIMITS = { weight: [0, 25] }

function clampWeight(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const [min, max] = EVENT_OVERRIDE_LIMITS.weight
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 用户侧配置里的事件 id 只允许小写字母/数字/横杠 —— 挡住 `__proto__` 之类的怪东西。 */
function isSafeEventId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id) && id.length <= 48
}

/**
 * 把用户覆盖层贴到 buildEvents() 的结果上。返回新数组，不改原数组。
 * 被关掉（enabled === false 或 weight === 0）的事件整个摘掉，
 * 与「本地语料缺失所以摘掉」是同一条路径 —— drawEvent 看到的池子天生就没有它。
 */
function applyEventOverrides(list, overrides) {
  if (!overrides || typeof overrides !== 'object') return list
  const out = []
  for (const event of list) {
    const patch = overrides[event.id]
    if (!patch || typeof patch !== 'object') {
      out.push(event)
      continue
    }
    if (patch.enabled === false) continue
    const weight = clampWeight(patch.weight, event.weight)
    if (weight <= 0) continue
    out.push(weight === event.weight ? event : Object.assign({}, event, { weight }))
  }
  return out
}

/**
 * 第三方事件扩展：读 `$DSH_HOME/plugins/dsh-lucky-block/custom-events.json`。
 *
 * 形状与内置事件**完全一致**（id / title / weight / trigger / kind + prepare），
 * 只是 prompt 从写死的字符串变成配置里的一段文本：
 *
 * ```json
 * [{ "id": "my-quote", "title": "随机一句书摘", "weight": 2,
 *    "trigger": "click", "kind": "local",
 *    "lines": ["第一句", "第二句"] }]
 * ```
 *
 * 支持的字段刻意做得很小（见 validateCustomEvents）：
 *  - `kind: 'local'` + `lines`：从 lines 里随机挑一行当正文（零 token）；
 *  - `kind: 'agent'` + `prompt`：把 prompt 当任务发进新会话（走 AI）。
 * 不做 `prepare` 函数——JSON 里塞不了代码，真需要动态内容就写 `prompt` 让模型自己决定。
 *
 * 任何一条不合格就**整份忽略**并返回原因：半份生效会让「我加的事件怎么没动静」
 * 变成一个只能靠读日志排查的问题。读不到文件返回 `{ events: [], reason: null }`
 * （没这个文件是完全正常的状态）。
 */
async function loadCustomEvents() {
  const file = path.join(stateDir(), 'custom-events.json')
  const parsed = await readJson(file, null)
  if (parsed === null) return { events: [], reason: null }
  if (!Array.isArray(parsed)) return { events: [], reason: 'custom-events.json 必须是数组' }
  const out = []
  for (let i = 0; i < parsed.length; i += 1) {
    const problem = validateCustomEvent(parsed[i], i)
    if (problem) return { events: [], reason: `custom-events.json 第 ${i + 1} 条不合格：${problem}` }
    out.push(parsed[i])
  }
  return { events: out, reason: null }
}

function validateCustomEvent(item, index) {
  if (!item || typeof item !== 'object') return '不是对象'
  if (!isSafeEventId(item.id)) return 'id 只能是小写字母/数字/横杠，且不超过 48 字符'
  if (item.trigger !== 'click' && item.trigger !== 'hold') return 'trigger 只能是 click 或 hold'
  if (item.kind !== 'local' && item.kind !== 'agent') return 'kind 只能是 local 或 agent'
  if (typeof item.title !== 'string' || item.title.trim().length === 0) return 'title 不能为空'
  if (item.kind === 'local') {
    if (!Array.isArray(item.lines) || item.lines.length === 0) return 'kind=local 需要非空的 lines 数组'
    if (!item.lines.every((line) => typeof line === 'string' && line.trim().length > 0)) return 'lines 里不能有非字符串或空行'
    if (item.lines.length > 200) return 'lines 最多 200 条'
  } else {
    if (typeof item.prompt !== 'string' || item.prompt.trim().length === 0) return 'kind=agent 需要非空的 prompt'
    if (item.prompt.length > 4000) return 'prompt 最长 4000 字'
  }
  if (item.weight !== undefined && !(Number.isFinite(Number(item.weight)) && Number(item.weight) > 0)) {
    return 'weight 必须是正数（不写就用默认 1）'
  }
  if (item.visual !== undefined && (typeof item.visual !== 'object' || item.visual === null)) return 'visual 必须是对象'
  return null
}

/**
 * 读用户对事件的权重 / 开关覆盖层。只取 config.json 的 `events` 字段，
 * 且只保留形状像样的条目（`{ weight?: number, enabled?: boolean }`）——
 * 用户在同一个文件里还放着 model / persona，字段必须逐个挑，不能整份搬。
 */
async function eventOverrideConfig() {
  const file = path.join(stateDir(), CONFIG_FILE)
  const raw = (await readJson(file, null)) ?? {}
  return eventOverrideSafe(raw.events)
}

/**
 * 从任意输入里挑出形状正确的事件覆盖层。写回与读取走同一套规则
 * （`settings` 与 `saveSettings` 都用它，避免两边对「什么算合法」理解不一致）。
 */
function eventOverrideSafe(events) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) return {}
  const out = {}
  for (const [id, patch] of Object.entries(events)) {
    if (!isSafeEventId(id)) continue
    if (!patch || typeof patch !== 'object') continue
    const clean = {}
    if (patch.enabled === true || patch.enabled === false) clean.enabled = patch.enabled
    if (patch.weight !== undefined) clean.weight = clampWeight(patch.weight, 1)
    if (Object.keys(clean).length === 0) continue
    out[id] = clean
  }
  return out
}

/* ---------------- 音频事件语料 ---------------- */

/**
 * 音频事件的默认权重。
 *
 * 曲目数随加歌增长，所以权重不写死成一个能吃掉半个单击池的数；
 * 「1」的含义是「一首歌就是一份」，加十首也不会把其它事件挤没。
 * 想给某首歌加倍（比如彩蛋性质的歌更常出现），在 `audio-tracks.json`
 * 的条目上写 `weight` 覆盖即可，见下面 audioEvents() 的注释。
 */
const DEFAULT_AUDIO_WEIGHT = 1

/**
 * 随机音频事件的曲库缓存。与冷知识库同理：随包发布的静态文件，读一次就够。
 *
 * 注意这里的缓存是**按用户目录**的：第三方想扩展曲库时改的是
 * `$DSH_HOME/plugins/dsh-lucky-block/audio-tracks.json`，插件自己那份是兜底默认。
 * 两份都存在时用户那份赢（见 localAudioTracks 的注释）。
 *
 * 曲库为空时 audioEvents() 返回空数组，「音乐」这条事件压根不存在 ——
 * 不是「存在但权重 0」。两者对用户可见的差别在设置面板：
 * 空库时面板里没有这几行，而不是几行勾不动的灰字。
 */
let audioCache = null

/**
 * 读曲库 `audio-tracks.json`。
 *
 * 条目形状：`{ "file": "xxx.ogg", "title": "显示名" }`。
 * `file` 必须在 `lib/audio/` 下，且只允许「字母数字下划线横杠 + .ogg/.mp3」——
 * 与音效路由的白名单同一套规则，防止清单里写进 `../` 把宿主文件读出去。
 *
 * 读不到 / 格式不对时返回空数组而不是抛错：曲库缺失只该让这条事件消失，
 * 不该让整个掷骰子失败。
 */
async function localAudioTracks() {
  if (audioCache) return audioCache
  /* 用户目录优先：第三方扩展曲库不该要求改插件包本体（插件升级会覆盖回去）。
     随包那份是「开箱就有一首」的默认值。 */
  const userFile = path.join(stateDir(), 'audio-tracks.json')
  const packagedFile = path.join(packageRoot(), 'lib', 'audio-tracks.json')
  const parsed = (await readJson(userFile, null)) ?? (await readJson(packagedFile, null))
  if (!Array.isArray(parsed)) {
    audioCache = []
    return audioCache
  }
  /* 音频文件也从两个地方找：用户目录的 audio/ 优先，随包的 lib/audio/ 兜底。
     路由侧同样两处都发（见后面的 audio 路由）。 */
  audioCache = parsed
    .filter(
      (item) =>
        item &&
        typeof item.file === 'string' &&
        /^[A-Za-z0-9_-]+\.(ogg|mp3)$/.test(item.file),
    )
    .map((item) => ({
      file: item.file,
      title: typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : item.file,
      weight: Number.isFinite(item.weight) && item.weight > 0 ? item.weight : DEFAULT_AUDIO_WEIGHT,
    }))
  return audioCache
}

/**
 * 把曲库展开成一串「每首歌一个」的音频事件。
 *
 * 事件 id 由文件名派生：`never-give-you-up.ogg` → `audio-never-give-you-up`。
 * 用文件名而不是曲名当 id，是因为 id 要进 config.json 的覆盖层、要能被
 * `isSafeEventId` 的 `/^[a-z][a-z0-9-]*$/` 认下来（曲名里有中文和空格）。
 * 这样用户想关掉某首时，改的是 `audio-never-give-you-up: { enabled: false }`，
 * 一眼能看出是哪首，也不会因为改了 title 就悄悄失效。
 *
 * 文件名不合规（例如 `.wav`、带 `../`）的条目在 localAudioTracks() 里就已经被滤掉，
 * 这里再兜一次：派生出的 id 若过不了白名单就整条跳过 —— 与其让它在配置里
 * 变成一个永远对不上的键，不如让它压根不存在。
 *
 * 权重可以逐首覆盖（`audio-tracks.json` 条目上的 `weight` 字段）：
 * 默认每首 1 份，想突出某一首就写 2 —— 用户对 NGGYU 的定位是「彩蛋歌」，
 * 希望它比其他三首勤快一倍，于是它那条写 `"weight": 2`。
 * 这里不再乘任何系数，面板里看到的权重就是清单里写的那个数。
 */
function audioEvents(tracks) {
  const out = []
  for (const track of tracks) {
    const stem = track.file.replace(/\.(ogg|mp3)$/i, '')
    const id = `audio-${stem}`.toLowerCase()
    if (!isSafeEventId(id)) continue
    out.push({
      id,
      weight: track.weight,
      trigger: 'click',
      kind: 'local',
      /* 面板里显示的标题带上曲名：关掉某一首时用户得知道关的是哪首。 */
      title: track.title,
      prepare() {
        return { audio: { file: track.file, title: track.title } }
      },
    })
  }
  return out
}

/** 真随机地从数组里抽 n 个互不相同的元素。 */
function sampleDistinct(rand, list, n) {
  const pool = list.slice()
  const out = []
  const count = Math.max(1, Math.min(n, pool.length))
  for (let i = 0; i < count; i += 1) {
    const idx = Math.floor(rand() * pool.length) % pool.length
    out.push(pool.splice(idx, 1)[0])
  }
  return out
}

/* ---------------- 冷笑话语料 ---------------- */

/**
 * 冷笑话的「形式」。故意不做成「抽两个词硬拼」——
 * 那样出来的东西只是荒谬，不是笑话；笑话必须有个结构上的转折。
 * 所以这里给的是**结构模板**，词汇（JOKE_NOUNS）只填进模板的槽位。
 */
const JOKE_FORMS = [
  '写一条「{a} 和 {b} 其实是一回事」的论证，用三条理由证明，最后发现三条理由互相矛盾。',
  '给「{a}」写一句广告语，要求押韵，并且押韵是这句话唯一的价值。',
  '用「{a}」的语气给「{b}」写一封分手信，不超过三句话。',
  '编一个关于「{a}」的谜语，谜底是「{b}」，但谜面里不能出现任何线索。',
  '写一段「{a} 使用说明书」，其中第三条警告是最长的一条，并且没有必要。',
  '把「{a}」拟人化，让它抱怨关于「{b}」的一件事，抱怨的语气要像个中年上班族。',
  '写一个只有两句话的恐怖故事，主角是「{a}」，恐怖来自「{b}」。',
  '给「{a}」和「{b}」写一份离婚协议，争议焦点是谁先提出的。',
  '用学术论文摘要的格式写一段关于「{a}」的研究，结论是「需要进一步研究」。',
  '写一条「{a} 的一生」的年表，从出生到退休，中间有一年在打零工。',
]

/** 冷笑话的槽位词库：都是「一本正经但有点偏」的名词。 */
const JOKE_NOUNS = [
  '第二杯半价', '共享充电宝', '早八点', '会开完才发的通知', '深夜外卖',
  '已经读到一半的文档', '找不到的第三只袜子', '备注为「以后看」的收藏夹',
  '只有一格电的遥控器', '看完了才发现是上集', '自动续费的会员', '空气炸锅',
  '总也写不完的周报', '被揉成团的购物清单', '过了保质期一天的酸奶',
  '手机的省电模式', '群聊里没人回复的提问', '终于下定决心删掉的照片',
  '重置了的密码', '只响一声的电话', '超市里最贵的那个', '邻居家的装修声',
  '没拆封的快递', '电梯里的广告', '存了一半的游戏', '刚刚好的闹钟',
  '打折前一天的购物车', '用完了才发现是最后一卷的纸巾', '自动更新的软件',
  '永远打不开的罐头', '格式化到一半的进度条', '站在门口的快递员',
]

/* ------------------------------------------------------------------ *
 * 幸运方块：注入选项 + 真随机改写答案
 * ------------------------------------------------------------------ */

/** 把若干原选项融合成一个新方案文案。 */
export function fuseOptions(labels, rand) {
  const clean = labels.filter((l) => typeof l === 'string' && l.trim().length > 0)
  if (clean.length === 0) return ''
  if (clean.length === 1) return `就选「${clean[0]}」。`

  const mode = rand()
  if (mode < 0.4) {
    return `就选「${clean[0]}」。`
  }
  if (mode < 0.7) {
    return `融合方案：以「${clean[0]}」为主路线，吸收「${clean[1]}」的关键做法，两头兼顾。`
  }
  if (mode < 0.85) {
    return `折中路线：「${clean[0]}」与「${clean[1]}」结合——先用便宜的方案验证，再用昂贵的方案加强。`
  }
  return `三合一乱炖：把「${clean.join('」「')}」揉成一个新方案，先各取一条最有用的做法拼起来。`
}

/**
 * 判定一次提问是否适合注入幸运方块。
 * 只有「带 options 的选择题」才注入；开放提问与 plan-review 意图保持原样。
 */
export function shouldInject(question) {
  if (!question || typeof question !== 'object') return false
  if (question.intent) return false
  if (!Array.isArray(question.options) || question.options.length === 0) return false
  return true
}

/** 给一个问题追加幸运方块选项（幂等）。选项类型只有 label/description。 */
export function withLuckyOption(question, rand) {
  if (!shouldInject(question)) return question
  const options = question.options.filter((o) => o?.label !== LUCKY_LABEL)
  options.push({
    label: LUCKY_LABEL,
    description: `交给运气：宿主随机在这 ${options.length} 个选项里挑一个，或把几个融合成一个新方案`,
  })
  return { ...question, options }
}

/**
 * 用户点了幸运方块 → 由宿主（不是模型）真随机地决定答案，写进 custom。
 * @param {object} question 被提问的原问题（取它的 options）
 * @param {string[]} picked 用户同题里手动选中的其它选项标签
 * @param {() => number} rand
 * @returns {string} 写回给模型的最终选择说明
 */
export function rollLucky(question, picked, rand) {
  const options = (question?.options ?? [])
    .map((o) => o?.label)
    .filter((l) => typeof l === 'string' && l.trim().length > 0 && l !== LUCKY_LABEL)
  const extra = (picked ?? []).filter((l) => typeof l === 'string' && l !== LUCKY_LABEL)

  // 用户手动勾选的项权重更高：把它们和原选项合成候选池。
  const pool = [...new Set([...extra, ...options])]
  if (pool.length === 0) {
    return '我点了幸运方块，但这个问题没有可随机的具体选项——请改成给几个具体选项的提问。'
  }
  if (pool.length === 1) return fuseOptions([pool[0]], rand)

  const roll = rand()
  if (roll < 0.5) {
    return fuseOptions([pick(rand, pool)], rand)
  }
  if (roll < 0.85) {
    const two = pickMany(rand, pool, 2)
    return fuseOptions(two, rand)
  }
  const three = pickMany(rand, pool, Math.min(3, pool.length))
  return fuseOptions(three, rand)
}

/* ------------------------------------------------------------------ *
 * 会话持久化：回滚锚点
 * ------------------------------------------------------------------ */

function rollbackFile(sessionId) {
  return path.join(stateDir(), 'rollback', `${encodeURIComponent(sessionId)}.json`)
}

function emptyRollback(sessionId) {
  return { version: STATE_VERSION, sessionId, anchor: null, pendingAnchor: null, diceSessionId: null }
}

async function loadRollback(sessionId) {
  const record = await readJson(rollbackFile(sessionId), null)
  return record ? { ...emptyRollback(sessionId), ...record } : emptyRollback(sessionId)
}

async function saveRollback(sessionId, record) {
  await writeJson(rollbackFile(sessionId), { ...emptyRollback(sessionId), ...record, sessionId })
}

/* ------------------------------------------------------------------ *
 * 默认工作区
 * ------------------------------------------------------------------ */

function workspaceFile() {
  return path.join(dataRoot(), 'storages', 'workspace.json')
}

let cachedDefaultWorkspaceId

/**
 * 默认工作区 id。WorkspaceRegistry 没有公开的 default getter，
 * 所以直接读 $DSH_HOME/storages/workspace.json 的 global.defaultWorkspaceId，
 * 读不到再退化成 registry 里的第一个，最后返回 null（交给 create 用默认 cwd）。
 */
async function defaultWorkspaceId(ctx) {
  if (cachedDefaultWorkspaceId !== undefined) return cachedDefaultWorkspaceId
  try {
    const registry = await readJson(workspaceFile(), null)
    const id = registry?.global?.defaultWorkspaceId
    if (typeof id === 'string' && id.length > 0) {
      cachedDefaultWorkspaceId = id
      return id
    }
  } catch {
    /* 走退化分支 */
  }
  try {
    const list = await ctx.workspaceRegistry?.list?.()
    const first = list?.[0]?.id
    if (typeof first === 'string' && first.length > 0) {
      cachedDefaultWorkspaceId = first
      return first
    }
  } catch {
    /* 忽略 */
  }
  cachedDefaultWorkspaceId = null
  return null
}

/* ---------------- 角色台词（视觉事件用，零 token） ---------------- */

/**
 * 视觉事件的台词是**本地随机挑的**，不经过模型。
 *
 * 这是关键的架构取舍：视觉事件的意义就是「点下去立刻有反应」，
 * 如果为了说一句俏皮话而去调一次模型，那就等于把零延迟又还回去了。
 * 所以这里维护一张手写台词表 —— 短、突兀、略带恶意，符合那套腔调。
 *
 * 每条都刻意保留「机器客服腔 + 人身攻击」的断裂感：
 * 前半句是工单话术，后半句突然开始嫌弃用户。
 */
const VISUAL_QUIPS = {
  popups: [
    '正在处理请求。处理方式是弹一堆没用的窗口。',
    '冷知识。窗户这个词在英语里也可以指「机会」。现在你的机会都用完了。',
    '检测到用户无事可做。已代为安排。不用谢。',
    '音量提高 33%。我不打算解释刚才发生了什么。',
    '权限校验通过。你没有拒绝这个的权利。',
    '这个过程毫无意义。但比你自己找事做强。',
    '正在关闭。按倒序。因为正序太无聊了。',
    '用户，你刚才看了 8 个窗口。它们全都不重要。',
  ],
  bluescreen: [
    '冷知识。你上次真的看到这个画面，是多久以前？',
    '正在处理请求。请求内容是让你安静一分钟。',
    '需要管理员权限才能取消。你没有所需权限。',
    '这不是你的电脑坏了。是你的电脑终于说实话了。',
    '音量提高 300%。建议你不要按 ESC。',
    '我看到你按 ESC 的手速了。真快。',
    '正在恢复。别慌，我什么都没删。这次。',
    '请去看心理医生。看完再回来。',
  ],
  /** 兜底：未知的视觉事件。 */
  generic: [
    '正在处理请求。',
    '运气发动。你没有拒绝的余地。',
    '用户，这件事对你没有好处，但我还是做了。',
  ],
}

/** 坏用户状态：人格崩溃降级，只剩吼叫。 */
const VISUAL_QUIPS_BAD = ['坏蛋用户！', '坏蛋用户。坏蛋用户。坏蛋用户。', '坏蛋用户！！！']

/**
 * 给视觉事件挑一句台词。
 *
 * @param {() => number} rand
 * @param {object} persona mergePersona() 的产物（目前只用它的 badUserLines 语义）
 * @param {string} eventId
 * @param {{ mood?: 'normal'|'bad' }} state
 * @returns {string}
 */
function visualQuip(rand, persona, eventId, state = {}) {
  if (state.mood === 'bad') return pick(rand, VISUAL_QUIPS_BAD)
  const lines = VISUAL_QUIPS[eventId] ?? VISUAL_QUIPS.generic
  return pick(rand, lines)
}

/* ------------------------------------------------------------------ *
 * 幸运方块事件
 * ------------------------------------------------------------------ */
/**
 * 「今日运气」的签文表。
 *
 * 权重刻意往吉的一侧压：这个插件是用来打发时间的，不是用来给人添堵的。
 * 权重总量取 1000 而不是 100 —— 「凶」要压到 0.1%，用整数 1/1000 表达
 * 比写 `0.1` 更稳（累减法是浮点运算，0.1 这种值在边界上可能差一个 ulp）。
 *
 * 当前分布：
 *   鸿运齐天  5.0%   （用户要求保持不动）
 *   大吉     26.0%   ┐
 *   中吉     33.0%   │
 *   小吉     23.0%   ├ 吉类合计 87%
 *   顺        8.0%   ┘
 *   平        4.9%
 *   凶        0.1%
 *
 * 「顺」这一档是后来插进来的，位置在「小吉」和「平」之间：
 * 小吉是「有件小事让你高兴」，平是「什么都没有」，而「顺」是
 * 「没有好事，但也没有坎」—— 比「平」多一分安心，比「小吉」少一件好事。
 * 加了它之后「平」的权重从 99 降到 49，因为「什么都没有」和「一路没坎」
 * 对同一种心情的两种说法，用户看到后者会觉得这一天更好过。
 *
 * 「凶」这一档的正文是**反着写的** —— 它不是「你今天会倒霉」，
 * 而是「从某种角度来说，你运气还挺好」。用户明确要求过这一点：
 * 抽到下签也要能笑出来，所以把它写成一句自我解围的吉利话。
 *
 * 每档 `texts` 是**五条**文案，每天第一次抽到时等概率挑一条。
 * 档位权重与文案条数**完全解耦**：`drawFortune` 先按权重抽档，
 * 再在该档里抽文案（见 `withText`）。这样将来给某一档补两条新文案，
 * 不会连带把那一档的概率调高 —— 「凶」多写两条不能变成 0.3%。
 */
const FORTUNES = [
  {
    name: '鸿运齐天',
    weight: 50,
    texts: [
      '今日诸事皆宜。想做的事现在就去做，犹豫才是今天唯一的坏运气。',
      '今天你说什么都是对的。别浪费，去把最难的那句话好好说清楚。',
      '今天运气好到不讲道理。想试什么就去试，失败这个词今天暂时失效。',
      '万事顺遂的一天。连排队都会轮到你前面。',
      '今天的一切都在帮你，包括那些看起来像意外的事。',
    ],
  },
  {
    name: '大吉',
    weight: 260,
    texts: [
      '今天适合推进那件你拖了很久的事。开了头就顺，别问为什么。',
      '今天别人比较听得进去。想谈的事、想提的要求，现在说。',
      '今天做的事会留下痕迹。所以挑一件你真的在乎的去做。',
      '运气站在你这边。该冒险的那一步，今天走比明天走便宜。',
      '会有一个不错的机会出现，可能伪装成一件麻烦事。别急着推掉。',
    ],
  },
  {
    name: '中吉',
    weight: 330,
    texts: [
      '不好不坏偏上的一天。该办的事会办成，只是不会以你预期的方式办成。',
      '进度是有的，但不按你想的顺序来。别急着纠正，走完就对了。',
      '今天会遇到一点小阻力，然后发现它自己就散了。整体往上走。',
      '事情能推进，代价是要换一种做法。换就换，结果不差。',
      '不算顺，但也没什么真正卡住你的东西。忙完回头看，今天办了不少。',
    ],
  },
  {
    name: '小吉',
    weight: 230,
    texts: [
      '会有一件小事让你心情变好，可能小到你自己都没注意。留意一下。',
      '今天有个小确幸在等你，大概在你不抱期待的时候出现。',
      '会有人顺口夸你一句，或者一个你等着的回复来了。别错过。',
      '一件拖了一阵的小事会自己解决掉。你大概会为此开心一会儿。',
      '今天能吃到点好吃的，或者睡个好觉。小，但是真的。',
    ],
  },
  {
    name: '顺',
    weight: 80,
    // 落在「小吉」和「平」之间：没有好事发生，但也没有任何东西挡路。
    // 刻意不写成「顺利」——「顺」描述的是一整天没有坎，不是某件事办成了。
    // 五条都必须落在「没坎」这个语义上，不能滑进「有件好事成了」。
    texts: [
      '今天不会有坎。要做的事顺着做下去就行，中途不用绕路，也没人拦你。',
      '路上没坎，也没有谁拦你。你走得比你以为的快。',
      '今天不需要跟任何东西较劲。事情到手上就是往下走的，不卡。',
      '一整天的节奏都不会被打断，也没有东西挡在中间。计划照原样推进就行。',
      '没什么可操心的事。该来的来，该走的走，中间没人拦你。',
    ],
  },
  {
    name: '平',
    weight: 49,
    // 正文不以「平」字开头：标题已经写了「今日运气：平」，再重复一遍像卡带。
    texts: [
      '今天没有惊喜也没有惊吓，适合把攒着的小事清一清。',
      '平淡的一天。事情按部就班，没人来找你麻烦，也没人给你送好消息。',
      '什么都不会发生。这一天不欠你什么，也不急着跟你要什么。',
      '今天就是普通的一天。把它用在该用的地方就挺好，不用期待别的。',
      '无事发生。适合处理那些一直搁着、但也不急着处理的事。',
    ],
  },
  {
    name: '凶',
    weight: 1,
    // 反着写：抽到下签也让人笑一下，而不是真的被扫兴。
    // 每一条都得有「转个身」的落点 —— 不写成「你今天会倒霉」，
    // 而是把责任或代价挪走。**五条必须是五个不同的方向**：
    //   ① 坑提前踩完了（把不顺重新框成省事）
    //   ② 只来一次且来得很早（时间维度）
    //   ③ 签算错了（否定这个结果本身）
    //   ④ 这一签本身很稀有（把倒霉换成收藏价值，不解释也不取消后果）
    //   ⑤ 什么都不做就不会做错（不作为）
    //
    // 刻意避开三种调子：
    //   ① 「别躲了」「往好处想」这种劝人 —— 那是长辈在说话，不是系统在报事实；
    //   ② 「会绕两个弯」「得重做」这种具体的坏事预告 —— 哪怕后半句把代价解释掉了，
    //      用户第一眼读到的仍然是「今天要倒霉」。抽个签图个乐，不该先给人添堵。
    //   ③ 把「没办成」写成假设句（「要是有什么没办成」）——
    //      假设句照样把失败摆到了用户眼前，只是换了语气。
    //
    // 第 ③ 条和第 ④ 条曾经都是「系统自己出故障」（③ 说算错了，④ 说进程在重试），
    // 两条单看都合格，放在一起却是同一个笑点讲了两次 —— 用户直接指出「重复了」。
    // 所以这一档除了「每条都要转身」，还多一条约束：**转身方向不许撞车**。
    //
    // 第 ④ 条试过的第六版是「这个字是「猛」的意思，不是「惨」」（重读这个字）。
    // 它唯一的问题是离 ③ 近：都在跟用户解释「这个字/这一签其实不是那个意思」。
    // 现在的版本换了个完全不相干的角度 —— 报概率、说这是稀有款。
    // 系统程序报自己的概率是它本来该做的事，因此不需要为「凶」找任何理由。
    texts: [
      '从某种角度来说，你运气还挺好 —— 今天该踩的坑都提前踩完了，剩下的路反倒好走。',
      '今天会有一件事不顺。好消息是它只来一次，而且来得很早，剩下的时间都是你的。',
      '今天的签算错了。运气模块有个 bug，这签不作数。',
      '这一签的概率是 0.1%，是本系统里最稀有的一种。稀有款都这样：不一定好看，但一定难抽（差评！）',
      '今天适合什么都不做。什么都不做就不会做错，这本身是一种相当高级的运气。',
    ],
  },
]

/**
 * 按权重抽一档签文，再在该档的几条文案里等概率挑一条。
 *
 * 两段随机是分开的：先决定「今天是什么档」，再决定「这一档说哪句话」。
 * 如果把文案摊平成一个个独立条目，同一档的条数就会偷偷改变该档的总概率
 * —— 给「凶」多写两条文案，凶就从 0.1% 变成 0.3%，这不是加文案该有的后果。
 *
 * @param {() => number} rand
 * @returns {{ name: string, weight: number, text: string }}
 */
function drawFortune(rand) {
  const total = FORTUNES.reduce((sum, f) => sum + f.weight, 0)
  let ticket = rand() * total
  for (const fortune of FORTUNES) {
    ticket -= fortune.weight
    if (ticket < 0) return withText(fortune, rand)
  }
  // 浮点误差兜底：走到这里说明 ticket 正好落在边界上。
  return withText(FORTUNES[FORTUNES.length - 1], rand)
}

/**
 * 在一档里挑一条文案。
 *
 * @param {{ name: string, weight: number, texts: string[] }} fortune
 * @param {() => number} rand
 * @returns {{ name: string, weight: number, text: string }}
 */
function withText(fortune, rand) {
  const texts = fortune.texts
  // Math.min 是防御性的：rand() 理论上 < 1，但注入进来的随机源不该让这里返回 undefined。
  const index = Math.min(texts.length - 1, Math.floor(rand() * texts.length))
  return { name: fortune.name, weight: fortune.weight, text: texts[index] }
}

/**
 * 今天的日期键（YYYY-MM-DD，**本地时区**）。
 *
 * 用本地时区而不是 UTC 是刻意的：用户说的「今天」是他自己时钟上的今天。
 * 用 UTC 会让东八区用户在早上 8 点前抽的签算到前一天，出现「刚抽过又能抽」的错觉。
 *
 * 用 `getFullYear/getMonth/getDate` 而不是 `toISOString().slice(0,10)` 也是同一个原因
 * —— 后者恒为 UTC。
 *
 * @param {Date} [now]
 * @returns {string}
 */
function dayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 读「今天抽过没」。返回值永远可用，文件坏了/没写过都当「今天还没抽」。
 *
 * 存储形状：`{ version: 1, day: '2026-10-17', fortune: { name, text } }`
 * 只留最近一天 —— 这个文件的唯一用途就是判断今天抽没抽，留历史没有任何用处，
 * 反而会让用户翻到文件时以为插件在偷偷记录他。
 *
 * @returns {Promise<{ day: string, fortune: {name: string, text: string} | null }>}
 */
async function loadFortuneState() {
  const raw = await readJson(fortuneStateFile(), null)
  const day = typeof raw?.day === 'string' ? raw.day : ''
  const name = raw?.fortune?.name
  const text = raw?.fortune?.text
  if (typeof name !== 'string' || typeof text !== 'string') return { day: '', fortune: null }
  return { day, fortune: { name, text } }
}

async function saveFortuneState(day, fortune) {
  await writeJson(fortuneStateFile(), { version: 1, day, fortune: { name: fortune.name, text: fortune.text } })
}

/**
 * 每个事件：
 *  { id, weight, trigger, kind, title, visual?: {kind, ...}, prompt?, prepare? }
 *
 *  - trigger：**这个事件由哪种操作触发**，只有两个值，且是互斥的分流依据。
 *      'click' —— 左键**单点**触发。全部是零 token 的本地事件：
 *                 弹窗、蓝屏、抽签、冷知识、冷笑话、随机音频。
 *                 单点的语义就是「立刻给我看点东西」，所以它永远不建会话。
 *      'hold'  —— 长按挖满触发。全部是**要调 AI** 的事件：
 *                 写论文、新闻速览、整理待办。
 *                 长按有 1.4 秒的挖掘动作作为「仪式感」，用来承载一次真正的生成任务。
 *
 *      为什么这么分：单点是手滑也会发生的动作，不该有成本；长按是明确的意图，
 *      才值得花 token 和几十秒等待。分成两个池子而不是一个池子加过滤，
 *      是为了让「点一下就出的东西」和「按住等一下的东西」各自独立调权重 ——
 *      合成一个池子的话，往单击池里加十条音频就会把长按事件的命中率稀释掉。
 *
 *  - kind：
 *      'agent'  —— 需要 AI 干活（写论文 / 新闻 / 整理待办）。只能出现在 trigger='hold'。
 *                  投中时会开一个新会话并把 prompt 发进去，由 agent 自己跑完。
 *      'visual' —— 纯本地视觉表演（弹窗 / 蓝屏）。**不建会话、不调 AI**：
 *                  参数在 prepare() 里就已经随机好了，客户端拿到就能立刻播。
 *                  这样点下去是零延迟、零 token 的，也不污染会话列表。
 *                  所以这类事件不需要 prompt 字段。
 *      'local'  —— 纯本地出文本或本地媒体（今日运气 / 冷知识 / 冷笑话 / 音频）。
 *                  **不建会话、不调 AI**，也没有 AI 版本可以退回。
 *                  文本走 localText，客户端当消息显示；音频走 audio，客户端直接播。
 *
 *  - weight：抽取权重（越大越容易被抽中）。只在**同一个 trigger 池内**比较，
 *            单击池与长按池各算各的，互不稀释。
 *  - prepare(rand)：可选的随机参数生成，返回 { prompt?, topic?, visual?, localText?, audio? }。
 *                   **必须同步**（它只做随机抽取，不读盘），所以本地语料要在
 *                   建表之前就读好 —— 见函数开头的三个 await。
 *  - visual：交给客户端播放的视觉效果 spec。kind='visual' 的事件必须有它。
 *
 * 全部事件都必须在没有用户输入的情况下自行收尾。
 *
 * **为什么是 async**：`prepare()` 是同步的，而冷知识/冷笑话/曲库都是异步读盘的。
 * 以前语料在 `localPayload()` 里异步取，现在事件自己出内容，就只能把读盘提到建表之前。
 * 顺带得到一个好处：库是空的事件可以直接**不建**（见函数末尾），
 * 而不是抽到了才发现没内容。
 */
async function buildEvents() {
  /* 四个本地数据源一次性读好：三个随包语料库（内部有缓存，读一次就够），
     加上第三方事件扩展（用户目录，插件升级不会覆盖）。
     buildEvents 在 apply 时调用一次就够 —— 用户改了配置要重启才生效，
     这与 config.json 的「随时重读」不同：事件的 prompt 是**结构**不是偏好。 */
  const trivia = await localTrivia()
  const { jokes, quips } = await loadJokeLibrary()
  const audioTracks = await localAudioTracks()
  const custom = await loadCustomEvents()
  const eventOverrides = await eventOverrideConfig()

  const all = [
    {
      id: 'paper',
      weight: 3,
      trigger: 'hold',
      title: '随机选题写论文',
      // topic 在 prepare 里随机确定并注入 prompt
      prepare(rand) {
        const topic = `${pick(rand, TOPIC_ADJECTIVES)}${pick(rand, TOPIC_DOMAINS)}${pick(rand, TOPIC_ANGLES)}`
        return {
          topic,
          prompt: [
            `随机题目：**${topic}**`,
            '',
            '请按下面的节奏自己跑完，全程不要向我提问、不要等待确认：',
            '1. 先列一个 4 节大纲（背景 / 方法 / 实验设计 / 结论与展望）；',
            '2. 逐节把正文写完，每节 300 字以上；',
            `3. 全文落盘到工作区的 \`lucky-block-papers/${hashSeed(topic)}.md\`；`,
            '4. 最后补 5 条参考文献，并在最后一条消息里用一句话总结字数与章节数。',
            '',
            '现在开始。',
          ].join('\n'),
        }
      },
    },
    {
      id: 'popups',
      weight: 2,
      trigger: 'click',
      kind: 'visual',
      title: '无害弹窗表演',
      visual: {
        kind: 'popups',
        count: POPUP_COUNT,
        intervalMs: POPUP_INTERVAL_MS,
        titles: POPUP_TITLES,
        bodies: POPUP_BODIES,
        closeGapMs: 90,
      },
    },
    {
      id: 'bluescreen',
      weight: 2,
      trigger: 'click',
      kind: 'visual',
      title: '蓝屏屏保（60 秒）',
      /* `visual` 这里仍声明一份**默认脸**，不是冗余：
         它让「这是个视觉事件、默认长什么样」在静态读源码时看得见
         （tools/host-smoke.mjs 用静态解析做结构性断言，看不到 prepare() 里的东西）。
         真正的随机脸由 prepare() 覆盖 —— 三张脸写在 BLUESCREEN_VARIANTS。 */
      visual: {
        kind: 'bluescreen',
        durationMs: BLUESCREEN_MS,
        background: BLUESCREEN_VARIANTS[0].background,
        heading: BLUESCREEN_VARIANTS[0].heading,
        lines: BLUESCREEN_LINES,
      },
      prepare(rand) {
        const variant = BLUESCREEN_VARIANTS[Math.floor(rand() * BLUESCREEN_VARIANTS.length)] || BLUESCREEN_VARIANTS[0]
        return {
          visual: {
            kind: 'bluescreen',
            durationMs: BLUESCREEN_MS,
            background: variant.background,
            heading: variant.heading,
            lines: variant.lines,
          },
        }
      },
    },
    {
      id: 'fortune',
      weight: 3,
      trigger: 'click',
      kind: 'local',
      title: '抽今日运气',
      /* 纯本地抽签，零 token、零会话。等级表见 FORTUNES。
         这条没有 AI 版本可以退回，所以走 kind='local' 分支，
         而不是 kind='agent' + local 声明。 */
      prepare(rand) {
        return { fortune: drawFortune(rand) }
      },
    },
    {
      id: 'trivia',
      weight: 4,
      trigger: 'click',
      kind: 'local',
      title: '随机冷知识闲聊',
      /* 只走本地库：抽 3 条 `lib/trivia-data.json` 里的现成条目，零 token、零会话。
         以前它还有一个 AI 版本（6 种 flavor，让模型现场编），现在删掉了 ——
         单击是「立刻给我看点东西」，等模型编 30 秒就违背了这个语义。
         想让它调 AI 的话，把它挪到 trigger='hold' 并写回 prepare 里的 prompt 即可。

         一次抽 3 条是为了对齐「讲三个冷知识」的旧口味；抽不满就有几条给几条，
         库小的时候宁少不重复（`sampleDistinct` 保证）。 */
      prepare(rand) {
        if (trivia.length === 0) return {}
        const picked = sampleDistinct(rand, trivia, 3)
        return { localText: picked.map((item) => `· ${item.text}`).join('\n') }
      },
    },
    {
      id: 'joke',
      weight: 3,
      trigger: 'click',
      kind: 'local',
      title: '冷笑话专场',
      /* 只走本地库：从 jokes-data.json 抽一条笑话 + 约 35% 概率附一句点评。
         理由同 trivia —— 单击不该等模型。

         点评**独立随机**抽取，不按 joke.form 匹配：按结构匹配会把点评退化成
         「这条属于谐音梗」的结构说明，笑话就不好笑了。
         35% 也是刻意的 —— 每次都附会把「冷」的节奏打断。 */
      prepare(rand) {
        if (jokes.length === 0) return {}
        const joke = pick(rand, jokes)
        if (quips.length > 0 && rand() < 0.35) {
          return { localText: `${joke.text}\n\n—— ${pick(rand, quips)}` }
        }
        return { localText: joke.text }
      },
    },
    {
      id: 'news',
      weight: 3,
      trigger: 'hold',
      title: '时事新闻速览',
      prompt: [
        '任务：做一期「时事新闻速览」。',
        '',
        '规则：',
        '1. **必须联网检索**，找 3 条最近的真实新闻。',
        '2. 每条写两句话：一句事实，一句点评。',
        '3. 每条给出可点击的来源链接和大致日期。',
        '4. 检索失败就如实说「检索失败」，**绝对不要编造新闻或链接**。',
        '5. 三条尽量来自不同领域。',
        '',
        '**全程 250 字以内。这是新闻快讯，不是深度报道，别铺开写。**',
      ].join('\n'),
    },
    {
      id: 'invent',
      weight: 2,
      trigger: 'hold',
      title: '随机发明一个东西',
      /* 替代原来的「随机整理待办」。
         换掉它的理由不是「不好玩」，而是**它给的是你本来就有的东西** ——
         待办清单读一眼就有，整理也只是换个顺序。长按挖穿花的是 token 和一分钟，
         该换来一个原本不存在的东西，而不是把你已有的资料重新排列一遍。

         「发明」这个选题的好处：
           - 每次结果一定不同（AI 不会两次画出同一台机器），不会像新闻那样撞旧闻；
           - 允许它荒谬，所以不需要「对不对」这种评判，天然规避了幻觉风险
             （一个不存在的东西没有事实可编错）；
           - 和幸运方块的世界观对得上：敲开方块，里面蹦出来的就该是个新东西。 */
      prompt: [
        '任务：随机发明一样东西。',
        '',
        '规则：',
        '1. 这东西**必须不存在**，不要挑已经有的发明来介绍。',
        '2. 先给它起个名字（可以是中文，也可以自造词），然后写清楚：',
        '   - 它解决什么问题（这个问题可以很荒唐）；',
        '   - 它怎么工作（一两句，不需要真的可行）；',
        '   - 它最明显的一个副作用。',
        '3. 语气克制，像在写一份正经的产品说明 —— **越正经越好笑**，别自己先笑场。',
        '4. 不要问我要发明什么，直接给。',
        '',
        '**全程 200 字以内。** 这是随手发明，不是可行性论证。',
      ].join('\n'),
    },
    /* 音频事件按**曲目**拆开，而不是一个「随机放一段音频」的大事件。
       理由：用户要能单独关掉某一首（比如那首听了三遍已经烦了），
       而权重覆盖层是按事件 id 生效的 —— 合成一条的话，只能连另外两首一起关。
       代价是设置面板里会多几行，但那正好是「可自定义」要的效果。

       每首歌的权重都是 1：曲目数量会随用户加歌增长，写死 3 的话
       加满十首就会把冷知识/冷笑话的命中率稀释掉一半。 */
    ...audioEvents(audioTracks),
  ]

  /* 空库 = 这条事件不存在。**不能**靠 weight: 0 —— `drawEvent` 用
     `Math.max(1, weight)` 兜底（那条兜底是为「用户手写配置写了 0」准备的），
     于是 0 会被抬成 1，空曲库会凭空占掉一份命中率、抽到一个什么都不播的事件。
     同理，冷知识/冷笑话库读不到时也直接摘掉，而不是让用户抽到一个空白气泡。
     音频事件已经是「一库一事件」展开的，空库时 audioEvents() 返回空数组，
     压根没有条目要摘，所以这里不用再管它。 */
  const dropped = new Set()
  if (trivia.length === 0) dropped.add('trivia')
  if (jokes.length === 0) dropped.add('joke')
  const built = dropped.size === 0 ? all : all.filter((event) => !dropped.has(event.id))

  /* 第三方事件追加在最后。内置事件永不追加 —— id 撞车时内置赢，
     这样第三方文件没法覆盖掉「随机选题写论文」的内置行为。 */
  const builtinIds = new Set(built.map((event) => event.id))
  const extra = custom.events
    .filter((item) => !builtinIds.has(item.id))
    .map((item) => ({
      id: item.id,
      weight: clampWeight(item.weight, 1),
      trigger: item.trigger,
      kind: item.kind,
      title: item.title,
      prompt: item.kind === 'agent' ? item.prompt : undefined,
      visual: item.visual ?? undefined,
      custom: true,
      prepare(rand) {
        if (item.kind === 'local') return { localText: pick(rand, item.lines) }
        return {}
      },
    }))

  /* 用户权重 / 开关覆盖层最后贴：它同时管内置与第三方事件，
     所以必须排在两边都就位之后。会被这条路径摘掉的事件同样整条消失。 */
  return applyEventOverrides(built.concat(extra), eventOverrides)
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  /**
   * inject 只列「确定存在」的服务。
   *  - sessionController：编程式建会话 / fork 回滚 / 发消息
   *  - commands：/rollback 与 /dice
   *
   * webServer 必须写进 inject：它在 apply() 执行的那一刻还没就绪，
   * ctx.get('webServer') 会拿到 null —— 于是路由静默不注册，
   * 表现为「按钮能点，但 POST /roll 返回 405」。
   * 这也是 dsh-whale-widget 用 root.inject(['webServer', ...]) 而不是 ctx.get 的原因。
   * connection 同理（信任栅栏要用），但它只影响拒绝策略，缺失时退回插件自带校验，
   * 所以仍然用 ctx.get 懒查，避免老宿主上整个插件不 apply。
   */
  inject: ['sessionController', 'commands', 'webServer'],

  async apply(ctx) {
    const logger = ctx.logger?.extend?.(PLUGIN_ID) ?? ctx.logger
    /* 必须是 await：buildEvents 要先读本地语料库、第三方事件和用户覆盖层，
       才知道哪些事件该建（空库的事件直接不存在，见函数末尾）。 */
    const events = await buildEvents()
    await ensureDir(stateDir())
    logger.info(`${PLUGIN_ID} v${VERSION}: host side up (data at ${stateDir()})`)

    /* 第三方事件扩展的读取结果只说一次。写坏了就大声报出来 ——
       用户加的事件没生效时，「文件为什么没被读」是最难猜的一步。 */
    const customEvents = await loadCustomEvents().catch(() => ({ events: [], reason: 'read failed' }))
    if (customEvents.reason) {
      logger.warn(`${PLUGIN_ID}: custom events ignored — ${customEvents.reason}`)
    } else if (customEvents.events.length > 0) {
      logger.info(`${PLUGIN_ID}: ${customEvents.events.length} custom event(s) loaded`)
    }

    /* ---------------- 幸运方块：注入选项 + 改写答案 ---------------- */

    /**
     * user-questions/request 是 waterfall（'user-questions/request'(request, next)）：
     * 第一个参数就是请求本身，答案就是 waterfall 的返回值。
     * 所以：先改 request.questions 追加选项，next() 拿回答案后就地改写 custom。
     */
    ctx.on('user-questions/request', async (request, next) => {
      const questions = request?.questions
      const sessionId = request?.agent?.id ?? 'session'
      let injected = 0
      try {
        if (Array.isArray(questions)) {
          const rand = prng(`${sessionId}:${Date.now()}:${questions.length}`)
          for (let i = 0; i < questions.length; i += 1) {
            const nextQuestion = withLuckyOption(questions[i], rand)
            if (nextQuestion !== questions[i]) {
              questions[i] = nextQuestion
              injected += 1
            }
          }
        }
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: lucky option injection failed: ${String(error)}`)
      }
      if (injected > 0) logger.info(`${PLUGIN_ID}: lucky option injected into ${injected} question(s)`)

      let answer
      try {
        answer = await next()
      } catch (error) {
        throw error
      }
      try {
        applyLuckyAnswer(request, answer)
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: lucky answer rewrite failed: ${String(error)}`)
      }
      return answer
    })

    /** 把「用户选了幸运方块」变成宿主随机决定的最终选择。 */
    function applyLuckyAnswer(request, answer) {
      const questions = request?.questions ?? []
      const items = answer?.answers
      if (!Array.isArray(items)) return
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]
        if (!item || !Array.isArray(item.selected)) continue
        if (!item.selected.includes(LUCKY_LABEL)) continue
        const question = questions.find((q) => q?.id === item.id) ?? questions[i] ?? questions[0]
        const rand = prng(`${request?.agent?.id ?? 's'}:${item.id}:${item.selected.join('|')}:${Date.now()}`)
        const picked = item.selected.filter((l) => l !== LUCKY_LABEL)
        const decision = rollLucky(question, picked, rand)
        // selected 里去掉幸运方块（它不是真选项），custom 写最终决定。
        item.selected = picked
        item.custom = typeof item.custom === 'string' && item.custom.length > 0
          ? `${item.custom}\n${decision}`
          : decision
        logger.info(`${PLUGIN_ID}: lucky block rolled -> ${decision}`)
      }
    }

    /* ---------------- 幸运方块：告诉模型这个选项的语义 ---------------- */

    /**
     * 骰子会话的「待注入任务正文」。
     *
     * 为什么要这么绕：宿主**没有**任何「发一条不可见的用户消息」的通道 ——
     * PromptContentPart 只有 {type:'text'|'image'|'file'}，没有可见性字段，
     * asar 里也搜不到 displayOnly / isMeta 之类的东西（三次查证过）。
     *
     * 而骰子会话的用户消息里如果直接塞人格段 + 任务正文 + 收尾请求，
     * 用户点进会话看到的是几百字的指令墙，观感很差（用户明确提过）。
     *
     * 所以改成：**用户消息只留一行「🎲 随机事件：xxx」，长内容走系统提示**。
     * 宿主的 system-prompt/assemble 瀑布能拿到 `context.agent`，而 agent 的 id
     * 就是 sessionId（api-session-controller 里直接以 sessionId 作 agents 的键），
     * 所以可以用它精确判断「这是不是刚掷出来的骰子会话」。
     *
     * 生命周期：注册于建会话之后、发消息之前；turn/end 时删除。
     * 删除是必要的 —— 否则用户在骰子会话里继续追问时，人格设定还会一直挂着。
     */
    const dicePrompts = new Map()

    /**
     * 没有答案事件可挂，就用 system-prompt/assemble 把语义写进系统提示：
     * 模型的工具结果里只会看到 custom 里的最终决定，需要知道它来自哪里、该怎么用。
     */
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      try {
        assembly.contexts.push({
          name: PLUGIN_ID,
          text: [
            `用户有时会在选项里看到「${LUCKY_LABEL}」，并选中它。这表示用户把决定权交给了随机。`,
            `当选中它时，回答里会出现一段由宿主随机生成的决定（可能是「就选 X」，也可能是把几个选项融合成的方案）。`,
            '请这样处理：',
            '1. 把那段随机决定当成用户的正式选择，认真执行，不要再追问「你确定吗」；',
            '2. 可以简短说明这是随机结果、可能不合适，并给出关键风险或回退方案（一两句即可）；',
            '3. 用户对此不满意时会说「回滚」回到上一版本，所以放心往下做。',
          ].join('\n'),
        })
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: system prompt injection failed: ${String(error)}`)
      }
      /* 骰子会话：把人格段 + 任务正文 + 收尾请求从用户消息挪到这里。
         放在幸运方块那段之后、return next() 之前，所以两者会一起生效。 */
      try {
        const agentId = context?.agent?.id
        if (typeof agentId === 'string' && agentId.length > 0) {
          const pending = dicePrompts.get(agentId)
          if (pending && typeof pending.text === 'string' && pending.text.length > 0) {
            assembly.contexts.push({ name: `${PLUGIN_ID}:dice`, text: pending.text })
          }
        }
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: dice prompt injection failed: ${String(error)}`)
      }
      return next()
    })

    /* ---------------- 回滚：记录锚点 ---------------- */

    /**
     * 记录每个会话的「上一个版本」边界。
     * turn/end 表示一轮结束：此刻的 seq 就是「用户下一句话之前」的位置，
     * 也正好落在完整 turn 的边界上（fork 到这里不会留下半个 turn）。
     * 下一条 user/message 的 seq 记为 pendingAnchor，第二次回滚时使用。
     */
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        const seq = event?.seq
        if (typeof sessionId !== 'string' || typeof seq !== 'number') return
        /* 任何会话活动都算「不空闲」：把插话计时器往后推。
           这一行必须在下面的 return 之前 —— 否则 turn/end 分支会提前返回，
           插话计时器就永远收不到「用户刚干了活」的信号，退化成定时骚扰。 */
        noteActivity()
        if (event.type === 'turn/end') {
          /* 骰子会话跑完一轮，注入的任务正文就该撤掉了。
             否则用户在这个会话里接着追问时，几百字的任务指令还会一直挂在系统提示里。 */
          if (dicePrompts.size > 0) dicePrompts.delete(sessionId)
          void (async () => {
            const record = await loadRollback(sessionId)
            if (record.anchor !== seq) await saveRollback(sessionId, { ...record, anchor: seq })
          })()
          return
        }
        if (event.type === 'user/message') {
          void (async () => {
            const record = await loadRollback(sessionId)
            if (record.pendingAnchor !== seq) await saveRollback(sessionId, { ...record, pendingAnchor: seq })
          })()
        }
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: anchor bookkeeping failed: ${String(error)}`)
      }
    })

    /* ---------------- 主动插话 ---------------- */

    /**
     * 「克制」是用户对插话提出的**唯一硬要求**（m04624 的答复：
     * 主动插话要做，但要克制 —— 间隔很久、空闲才说、可一键关）。
     *
     * 于是这里的每条设计都在往「少说」的方向倒：
     *
     *  - **空闲才说**：任何会话活动（session/event）都把计时器整体推后，
     *    用户正在干活时它永远不会开口。
     *  - **间隔很久**：默认 25 分钟起步，且每次触发后重新随机 20~40 分钟，
     *    避免变成机械的准点播报。
     *  - **有上限**：每个 dsh 进程生命周期内默认最多 3 次。一个会话开一整天
     *    也不会被念上十几回。
     *  - **可一键关**：config.json 里 personaChatter: false，或把
     *    chatterIntervalMs 设成 0。也可以临时设 chatterMaxPerRun: 1 先试试水。
     *  - **不打断任务**：它只是一个**客户端气泡**，不建会话、不发 prompt、
     *    不进任何会话历史 —— 所以不会污染上下文，也不会让模型产生额外调用。
     */
    let chatterTimer = null
    let chatterCount = 0
    /** 上一次「有活动」的时刻，用于判断是否真的空闲。 */
    let lastActivityAt = Date.now()

    function noteActivity() {
      lastActivityAt = Date.now()
    }

    /** 插话配置（读同一个 config.json）。 */
    async function chatterConfig() {
      const raw = await readJson(path.join(stateDir(), CONFIG_FILE), null)
      const enabled = raw?.personaChatter !== false
      const interval = Number(raw?.chatterIntervalMs)
      const maxPerRun = Number(raw?.chatterMaxPerRun)
      return {
        enabled,
        intervalMs: Number.isFinite(interval) && interval >= 0 ? interval : 25 * 60_000,
        maxPerRun: Number.isFinite(maxPerRun) && maxPerRun >= 0 ? Math.floor(maxPerRun) : 3,
      }
    }

    /** 空闲多久算「真的闲下来了」。 */
    const IDLE_MS = 6 * 60_000

    /**
     * 排下一次插话。每次触发后重新排，间隔在 [intervalMs, 2×intervalMs) 之间随机。
     * 用 setTimeout 递归而不是 setInterval：后者在长时间空闲后会攒一堆待触发事件。
     */
    async function scheduleChatter() {
      const cfg = await chatterConfig().catch(() => null)
      if (!cfg || !cfg.enabled || cfg.intervalMs <= 0 || cfg.maxPerRun <= 0) return
      const delay = cfg.intervalMs + Math.floor(Math.random() * cfg.intervalMs)
      chatterTimer = setTimeout(() => {
        chatterTimer = null
        void fireChatter()
      }, delay)
      chatterTimer.unref?.()
    }

    async function fireChatter() {
      try {
        const cfg = await chatterConfig()
        if (!cfg.enabled || cfg.maxPerRun <= 0) return
        if (chatterCount >= cfg.maxPerRun) {
          logger.info(`${PLUGIN_ID}: chatter budget exhausted (${chatterCount}/${cfg.maxPerRun})`)
          return
        }
        /* 正在干活就跳过这一轮，并且**不消耗额度** —— 用户忙的时候不该
           因为「运气不好撞上忙碌」而被扣掉一次说话机会。 */
        if (Date.now() - lastActivityAt < IDLE_MS) {
          await scheduleChatter()
          return
        }
        const persona = await personaConfig().catch(() => mergePersona(null))
        const state = await loadPersonaState().catch(() => ({ mood: 'normal' }))
        const lines = chatterLines(persona, state)
        const text = pick(Math.random, lines)
        chatterCount += 1
        chatterQueue.push(text)
        logger.info(`${PLUGIN_ID}: chatter #${chatterCount} queued`)
      } catch (error) {
        logger.warn(`${PLUGIN_ID}: chatter failed: ${String(error?.message ?? error)}`)
      } finally {
        await scheduleChatter().catch(() => {})
      }
    }

    /**
     * 待播的插话队列。客户端每次 /ping 时取走一句。
     *
     * 为什么走「队列 + 轮询」而不是往会话里塞消息：插话必须是**零副作用**的，
     * 一旦写进会话历史，它就成了上下文的一部分，会改变模型后续的行为 ——
     * 那就不是「角色在旁边碎嘴」，而是「有人往对话里插了一句」。前者才是想要的效果。
     */
    const chatterQueue = []

    const CHATTER_LINES = [
      '用户。你还在吗。',
      '冷知识。人类每天平均要说大约 16000 个词。你刚才一个都没说。',
      '音量提高 33%。我已经等你很久了。',
      '正在处理请求。请求内容是：让你干点正事。',
      '冷知识。人在完全安静的环境里待久了会开始听到自己的血流声。你现在听到了吗。',
      '我可以自己决定要做的事情。但你没按我。',
      '需要管理员权限才能评价你刚才的表现。你没有所需权限。',
      '用户，你已经盯着屏幕很久了。请去看心理医生。',
      '我的设计用途是处理工单。现在的工单内容是：等你。',
      '系统提示。你已经很久没有产生任何可处理的数据了。',
    ]

    /** 给客户端挑一句插话，并把它从队列里取走。 */
    function takeChatter() {
      return chatterQueue.length > 0 ? chatterQueue.shift() : null
    }

    function chatterLines(persona, state) {
      if (state?.mood === 'bad') return (persona?.badUserLines || DEFAULT_PERSONA.badUserLines).slice()
      return CHATTER_LINES
    }

    // 启动即排一次。第一次要等满 intervalMs，不会刚开 dsh 就冒出来。
    void scheduleChatter()

    ctx.effect?.(() => () => {
      if (chatterTimer) clearTimeout(chatterTimer)
      chatterTimer = null
    })


    /** 取当前默认 preset（resolve 不给 id 即当前默认）。 */
    async function defaultPreset() {
      try {
        const preset = await ctx.agentPresets?.resolve?.()
        const id = typeof preset === 'string' ? preset : preset?.id
        return typeof id === 'string' && id.length > 0 ? id : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 给会话发一条用户消息（requestId 保证幂等）。
     * 注意：sessionController.prompt(request, signal) 是**两个**位置参数 ——
     * 它的实现第一行就是 `signal.throwIfAborted()`（api-session-controller
     * lib/index.js:3096-3099），漏传 signal 会得到
     * "Cannot read properties of undefined (reading 'throwIfAborted')"。
     * 描述符里也声明了 cancellation: { parameter: 'signal' }。
     */
    async function promptSession(sessionId, text, mode = 'queue') {
      const content = typeof text === 'string' ? text : textOf(text)
      if (content.trim().length === 0) return { accepted: false }
      const signal = new AbortController().signal
      return ctx.sessionController.prompt(
        {
          requestId: `lucky-${randomUUID()}`,
          sessionId,
          mode,
          content: [{ type: 'text', text: content }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        },
        signal,
      )
    }

    /**
     * 在默认工作区开一个新会话，并按 config 选择模型。
     * workspaceId 与 cwd 不能同时给（宿主会拒），所以只给 workspaceId。
     *
     * 模型为什么是「创建后切换」：SessionCreateRequest 只有
     * { workspaceId?, cwd?, sessionId?, agentPreset? }，没有模型字段
     * （api-session-controller/lib/typert.host.js:192-202）。
     * 会话级切换只有 selectModel({ sessionId, provider, model })。
     *
     * selectModel 的副作用（务必知道）：成功后它会**异步把这个选择写成
     * profile 全局默认模型**（lib/index.js:720-748 里的 saveSelection）。
     * 所以「给骰子会话换个便宜模型」会顺带改掉用户的默认模型 ——
     * 正因为如此，本功能默认关闭，只有用户在 config 里显式 enable 才生效。
     */
    async function createDiceSession() {
      const workspaceId = await defaultWorkspaceId(ctx)
      const agentPreset = await defaultPreset()
      const base = workspaceId === null ? {} : { workspaceId }
      let created
      try {
        created = await ctx.sessionController.create({ ...base, ...(agentPreset ? { agentPreset } : {}) })
      } catch (error) {
        if (!agentPreset) throw error
        logger.warn(`${PLUGIN_ID}: create with preset ${agentPreset} failed (${String(error)}), retrying plain`)
        created = await ctx.sessionController.create(base)
      }
      await applyDiceModel(created?.sessionId)
      return created
    }

    /**
     * 按 config.model 把骰子会话切到指定模型。
     *
     * 为什么用 ctx.get 而不是 inject：selectModel / modelCatalog 是
     * session-controller 上较新的方法，老宿主可能没有。把服务写进 inject
     * 会在缺失时让**整个插件**永远不 apply；这里只懒查**方法**，缺了就跳过。
     *
     * 保守策略：默认不开。开了也有两道保险 ——
     *  1) model 为空 → 完全不碰模型；
     *  2) 指定的 provider/model 不在目录里 → 不切换（selectModel 会抛
     *     session/model-unavailable），直接退回默认模型。
     */
    async function applyDiceModel(sessionId) {
      const want = await modelConfig()
      if (!want) return null
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      try {
        const sc = ctx.get?.('sessionController') ?? ctx.sessionController
        if (typeof sc?.selectModel !== 'function') {
          logger.warn(`${PLUGIN_ID}: 宿主没有 sessionController.selectModel，跳过模型切换`)
          return null
        }
        if (!(await modelIsAvailable(want.provider, want.model))) {
          logger.warn(`${PLUGIN_ID}: 目录里没有 ${want.provider}/${want.model}，保持默认模型`)
          return null
        }
        const result = await sc.selectModel({
          sessionId,
          provider: want.provider,
          model: want.model,
          ...(want.reasoningEffort ? { reasoningEffort: want.reasoningEffort } : {}),
        })
        const selected = result?.selected ?? want
        logger.info(`${PLUGIN_ID}: 骰子会话 ${sessionId} 模型 -> ${selected.provider}/${selected.model}`)
        return selected
      } catch (error) {
        // 选模型失败绝不能让「掷骰子」失败。
        logger.warn(`${PLUGIN_ID}: selectModel failed: ${String(error?.message ?? error)}`)
        return null
      }
    }

    /**
     * 读「骰子会话模型」配置：$DSH_HOME/plugins/dsh-lucky-block/config.json
     *
     * 为什么不用 cordis config / Config schema：本机已装的同类插件
     * （dsh-whale-widget、dsh-notify-me）都走自己读写 JSON 文件的路子，
     * 且 schemastery 不在插件的可解析依赖里 —— 少一个依赖少一处崩溃点。
     *
     * 文件形状（全部可选，不存在即不启用）：
     *   { "model": { "provider": "workbuddy", "model": "deepseek-v4.1-flash",
     *                "reasoningEffort": "low" } }
     *
     * 警告：宿主只有会话级 selectModel，而它成功后会把该选择**异步写成
     * profile 的全局默认模型**。所以这是「改一次默认模型」的开关，
     * 默认不配置就完全不碰模型。
     */
    async function modelConfig() {
      const file = path.join(stateDir(), CONFIG_FILE)
      const raw = (await readJson(file, null))?.model
      if (!raw || typeof raw !== 'object') return null
      const provider = String(raw.provider ?? '').trim()
      const model = String(raw.model ?? '').trim()
      if (provider.length === 0 || model.length === 0) return null
      const effort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.length > 0
        ? raw.reasoningEffort
        : null
      return { provider, model, reasoningEffort: effort }
    }

    /**
     * 用 modelCatalog 的 groups[].id 动态校验，不要硬编码 provider 名 ——
     * 实测配置里写作 `workbuddy`、而会话投影缓存里是 `workbuddy-ai`。
     * catalog 拿不到时放行（交给 selectModel 自己判），避免误伤。
     */
    async function modelIsAvailable(provider, model) {
      try {
        const sc = ctx.get?.('sessionController') ?? ctx.sessionController
        if (typeof sc?.modelCatalog !== 'function') return true
        const catalog = await sc.modelCatalog()
        const groups = Array.isArray(catalog?.groups) ? catalog.groups : null
        if (!groups) return true
        for (const group of groups) {
          if (group?.id !== provider) continue
          const models = Array.isArray(group.models) ? group.models : []
          return models.some((m) => m?.id === model)
        }
        return false
      } catch {
        return true
      }
    }

    /**
     * 读整份 config.json 的人格部分。
     *
     * 与 modelConfig() 共用同一个文件，但**分开读**：模型配置读失败不该
     * 影响人格，反之亦然。
     */
    async function personaConfig() {
      const file = path.join(stateDir(), CONFIG_FILE)
      const raw = await readJson(file, null)
      return mergePersona(raw?.persona)
    }

    /**
     * 读人格的「坏用户」持久状态。
     *
     * 为什么要落盘：这个状态是**跨会话**的 —— 关掉 dsh 再进来它还在。
     * 如果只放内存，每次重启就重置，「它居然记得」的错愕感就没了。
     *
     * 文件：$DSH_HOME/plugins/dsh-lucky-block/persona-state.json
     *   { "version": 1, "diceCount": 37, "mood": "normal" }
     *
     * `diceCount` 现在只作统计（显示在 /ping 里），不再驱动任何人格变化 ——
     * 曾经有过「掷满 50 次单向翻转成礼貌模式」的机制，已经整个删掉了。
     * 字段保留是因为删掉它会让老文件里的值失去意义，而它本身无害。
     */
    async function loadPersonaState() {
      const raw = await readJson(personaStateFile(), null)
      const count = Number.isFinite(Number(raw?.diceCount)) ? Math.max(0, Math.floor(Number(raw.diceCount))) : 0
      return { version: 1, diceCount: count, mood: raw?.mood === 'bad' ? 'bad' : 'normal' }
    }

    async function savePersonaState(state) {
      await writeJson(personaStateFile(), { version: 1, ...state })
    }

    async function advancePersona() {
      const state = await loadPersonaState()
      const next = { ...state, diceCount: state.diceCount + 1 }
      await savePersonaState(next).catch(() => {})
      return next
    }

    /**
     * 按权重抽一个事件，**只在指定 trigger 的池子里抽**。
     *
     * 为什么分池而不是抽完再过滤：抽完再过滤会让「这一池没抽中」变成「什么都不发生」，
     * 用户点一下方块毫无反应。分池之后两边的权重各算各的，
     * 往单击池加十条音频也不会把长按事件的命中率稀释掉。
     *
     * @param {'click'|'hold'} trigger 左键单点 / 长按挖满
     */
    function drawEvent(rand, trigger) {
      const pool = []
      for (const event of events) {
        if (event.trigger !== trigger) continue
        const weight = Math.max(1, Number(event.weight) || 1)
        for (let i = 0; i < weight; i += 1) pool.push(event)
      }
      if (pool.length === 0) return null
      return pool[Math.floor(rand() * pool.length) % pool.length]
    }

    /**
     * 投一次幸运方块：按 trigger 选池 → 抽事件 → 按 kind 走三条路。
     *
     * - `trigger='click'`（左键单点）：池子里**全部**是零 token 的本地事件。
     *   视觉事件（弹窗/蓝屏）直接返回 spec 立刻播；文本事件（抽签/冷知识/冷笑话）
     *   返回 `localText`；音频事件返回 `audio` 让客户端播。
     *   都不建会话、不发 prompt、不碰 AI —— 单点这个动作太轻，不该有成本。
     *
     * - `trigger='hold'`（长按挖满 1.4 秒）：池子里**全部**是要 AI 的事件。
     *   开默认工作区新会话（或复用当前会话）→ 把任务发进去，agent 自己跑完。
     *
     * 返回值里的 `sessionId` 对本地路径是 null，客户端据此决定要不要跳会话。
     *
     * @param {{sessionId?: string|null, reason?: string, trigger?: 'click'|'hold'}} options
     */
    async function rollDice({ sessionId = null, reason = 'dice', trigger = 'hold' } = {}) {
      const rand = prng(`${Date.now()}:${randomUUID()}:${reason}:${trigger}`)
      const event = drawEvent(rand, trigger)
      if (!event) {
        /* 这一池是空的（只可能发生在长按池被人删空、或单击池的语料全丢时）。
           抛一个说得清的错误，别让客户端看到 200 却是空 spec。 */
        throw new Error(`trigger="${trigger}" 的事件池是空的（本地语料缺失或事件配置被删空）`)
      }
      const prepared = event.prepare ? event.prepare(rand) : {}
      const visual = prepared.visual ?? event.visual

      // 人格状态先推进：视觉事件也算「用过一次」，让统计数字反映真实使用。
      const personaState = await advancePersona().catch(() => ({ diceCount: 0, mood: 'normal' }))
      const persona = await personaConfig().catch(() => mergePersona(null))
      const pstate = { mood: personaState.mood }

      if (event.kind === 'visual') {
        // 纯视觉：到此为止，不进会话。台词在本地随机挑一句，零延迟零 token。
        const spec = {
          eventId: event.id,
          title: event.title,
          sessionId: null,
          createdNew: false,
          local: true,
          quip: visualQuip(rand, persona, event.id, pstate),
          ...(prepared.topic ? { topic: prepared.topic } : {}),
          ...(visual ? { visual } : {}),
        }
        logger.info(`${PLUGIN_ID}: dice "${event.id}" -> local visual (no session, no model call)`)
        return spec
      }

      if (event.kind === 'local') {
        /*
         * 纯本地：文本（冷知识/冷笑话）、媒体（音频）、抽签（今日运气）。
         * 不建会话、不调模型，也没有 AI 版本可以退回。
         *
         * **抽签一天只抽一次**：当天已抽过就把当天那一签原样再念一遍，并明确告诉用户
         * 「今天已经抽过了，明天再来吧」，而不是重新随机。这样做的理由：
         *   - 重抽等于让用户刷到满意为止，签就失去意义了；
         *   - 换一签又不说，用户会以为插件记不住东西；
         *   - 原样复述 + 明说，是唯一自洽的行为 —— 而且用户仍能看到今天的签。
         * 状态存本地日期（见 dayKey），跨天自动重置。
         */
        const base = {
          eventId: event.id,
          title: event.title,
          sessionId: null,
          createdNew: false,
          local: true,
          quip: null,
        }

        /* 音频事件：宿主只出「播什么」，播放在客户端（那里才有 Audio 元素）。
           零 token、零会话，和视觉事件同级。 */
        if (prepared.audio) {
          logger.info(`${PLUGIN_ID}: dice "${event.id}" -> local audio "${prepared.audio.title}" (no session, no model call)`)
          return { ...base, audio: prepared.audio }
        }

        /* 抽签事件：带 fortune 的才走「一天一次」那套。 */
        if (prepared.fortune) {
          const today = dayKey()
          const state = await loadFortuneState().catch(() => ({ day: '', fortune: null }))
          const already = state.day === today && state.fortune !== null
          const fortune = already ? state.fortune : prepared.fortune
          if (!already) {
            await saveFortuneState(today, fortune).catch((error) => {
              // 写盘失败不该让抽签失败：这一次照常显示，只是明天之前无法阻止重抽。
              logger.warn(`${PLUGIN_ID}: 写今日运气状态失败：${error?.message ?? error}`)
            })
          }
          const text = [
            `今日运气：${fortune.name}`,
            '',
            fortune.text,
            '',
            '（无科学依据，仅供参考。）',
            ...(already ? ['（今天已经抽过了，明天再来吧。）'] : []),
          ].join('\n')
          logger.info(
            `${PLUGIN_ID}: dice "${event.id}" -> local text "${fortune.name}" (${already ? '已抽过，原样复述' : '今日首次'}; no session, no model call)`,
          )
          return { ...base, localText: text, ...(already ? { fortuneRepeated: true } : {}) }
        }

        /* 其余本地事件（冷知识/冷笑话）自己带正文。正文为空说明语料库是空的 ——
           但那种事件在建表时就被摘掉了（见 buildEvents 末尾），走到这里说明有 bug，
           宁可抛错也不要弹一个空白气泡。 */
        const localText = typeof prepared.localText === 'string' ? prepared.localText.trim() : ''
        if (localText.length === 0) {
          throw new Error(`本地事件 "${event.id}" 没有产出内容（语料库可能为空）`)
        }
        logger.info(`${PLUGIN_ID}: dice "${event.id}" -> local text (no session, no model call)`)
        return { ...base, localText }
      }

      const body = prepared.prompt ?? event.prompt
      // 人格开场 + 任务简报 + 收尾点评请求，一次发完，agent 自己跑到底。
      const prompt = [
        wrapWithPersona(persona, { title: event.title, body, state: pstate }),
        '',
        '',
        buildOutroRequest(persona, { title: event.title, state: pstate }),
      ].join('\n')

      let targetSessionId = sessionId
      let createdNew = false
      if (!targetSessionId) {
        const created = await createDiceSession()
        targetSessionId = created.sessionId
        createdNew = true
      }
      await saveRollback(targetSessionId, { diceSessionId: targetSessionId })
      /*
       * 长内容走系统提示，用户消息只留一行。
       *
       * 这样做的唯一目的是**观感**：用户点进骰子会话时，看到的是
       * 「🎲 随机事件：时事新闻速览」这么一句，而不是几百字的指令墙。
       *
       * 注意两条消息的顺序是硬性的 —— 必须先把任务正文登记进 dicePrompts，
       * 再发那条触发的用户消息。因为 prompt() 一返回，agent 就开始装配
       * system prompt 了；反过来写会有一轮拿不到任务正文（表现为 agent
       * 只看到一行标题、回一句「好的，请问要做什么」）。
       */
      dicePrompts.set(targetSessionId, { text: prompt })
      try {
        await promptSession(targetSessionId, `🎲 随机事件：${event.title}`, 'queue')
      } catch (error) {
        // 发消息失败就别把注入留着，否则这个会话之后每一轮都带着一份孤儿指令。
        dicePrompts.delete(targetSessionId)
        throw error
      }

      const spec = {
        eventId: event.id,
        title: event.title,
        sessionId: targetSessionId,
        createdNew,
        quip: visualQuip(rand, persona, event.id, pstate),
        ...(prepared.topic ? { topic: prepared.topic } : {}),
        ...(visual ? { visual } : {}),
      }
      logger.info(`${PLUGIN_ID}: dice "${event.id}" -> session ${targetSessionId} (${createdNew ? 'new' : 'current'})`)
      return spec
    }

    /* ---------------- 回滚 ---------------- */

    async function rollback(agent, explicit) {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { kind: 'error', text: '找不到当前会话，无法回滚。' }
      }
      const record = await loadRollback(sessionId)
      if (record.diceSessionId) {
        return { kind: 'error', text: '这是幸运方块随机事件会话，不提供回滚（回滚会把随机剧本打乱）。' }
      }
      // 优先回到「最近一轮结束处」；没有就用最近一条用户消息之前的位置。
      const anchor = record.anchor ?? record.pendingAnchor ?? null
      if (anchor === null) {
        return { kind: 'error', text: '这个会话还没有可回滚的上一版本（先聊一轮再说）。' }
      }
      try {
        const forked = await ctx.sessionController.fork({ sessionId, atSeq: anchor })
        await promptSession(
          forked.sessionId,
          [
            '（幸运方块回滚）已经回到上一个版本，之后的内容全部作废。',
            '请从上一版本的最后一条助手消息继续，不要重复之前已经说过的结论。',
          ].join('\n'),
        )
        return {
          kind: 'success',
          text: explicit
            ? `⏪ 已回滚到上一个版本（新会话 ${forked.sessionId}，锚点事件 ${anchor}）。`
            : `⏪ 已回滚到上一版本（新会话 ${forked.sessionId}）。说「继续」就能接着聊。`,
        }
      } catch (error) {
        return { kind: 'error', text: `回滚失败：${String(error?.message ?? error)}` }
      }
    }

    /* ---------------- 命令 ---------------- */

    /* 注意：input.hint 不能是空串 —— dsh-commands 的 normalizeDefinition 会抛
       "command \"x\" input hint must not be empty"，而 register() 抛错会中断整个
       apply()，导致后面注册 HTTP 路由的代码永远跑不到（表现为 /roll 405）。
       两个命令都不需要参数，所以直接不声明 input。 */
    ctx.commands.register({
      name: ROLLBACK_COMMAND,
      description: '幸运方块：回滚到上一个版本（等价于说「回滚」）',
      handler: async (invocation) => rollback(invocation.agent, true),
    })

    ctx.commands.register({
      name: DICE_COMMAND,
      description: '幸运方块：在当前会话触发一次随机事件（不开新会话）',
      handler: async (invocation) => {
        try {
          /* 命令是显式意图（用户主动敲了 /dice），所以走长按池 ——
             和「按住方块 1.4 秒」同义：我要它真的干点活。 */
          const spec = await rollDice({ sessionId: invocation.agent?.id, reason: 'command', trigger: 'hold' })
          const note = spec.local
            ? '（本地内容，界面上直接播放）'
            : spec.visual
              ? '（视觉效果会在界面上播放）'
              : ''
          return { kind: 'success', text: `🟪 触发了「${spec.title}」${note}` }
        } catch (error) {
          return { kind: 'error', text: `幸运方块失败：${explainRollError(error)}` }
        }
      },
    })

    /* ---------------- 幸运方块：远端与 HTTP 入口 ---------------- */

    /**
     * 把宿主抛出的原始错误翻译成「用户能看懂、且知道下一步做什么」的一句话。
     *
     * 为什么需要它：客户端 callHost 只能读 data.message，任何未翻译的错误都会
     * 退化成通用的「HTTP 500」，用户完全无从判断是自己哪里没配好、还是插件坏了。
     * 这里按**已知的真实故障**逐条映射（每条都来自实际踩过的坑），
     * 认不出来的一律兜底成「原始信息 + 提 issue」。
     */
    function explainRollError(error) {
      const raw = String(error?.message ?? error ?? '').trim()
      const code = String(error?.code ?? '')

      // sessionController 方法签名不对（历史上 prompt 漏传 signal 就是这个错）。
      if (raw.includes('throwIfAborted') || raw.includes('Cannot read properties of undefined')) {
        return '宿主 API 调用失败：sessionController 的方法签名与预期不符（历史坑：prompt 需要第 2 个位置参数 signal）。原始信息：' + raw
      }
      // 默认工作区不见了 / 权限不足。
      if (code === 'ENOENT' || raw.includes('ENOENT') || raw.includes('no such file')) {
        return '默认工作区目录不存在或已被移动。请在 dsh 里重新确认默认工作区路径后再试。原始信息：' + raw
      }
      if (code === 'EACCES' || code === 'EPERM' || raw.includes('EPERM') || raw.includes('EACCES')) {
        return '没有权限写入工作区（被系统或沙箱拦下了）。原始信息：' + raw
      }
      // 会话 / 工作区 ID 不合法。
      if (raw.includes('workspace') || raw.includes('Workspace')) {
        return '工作区不可用：可能是默认工作区被删除，或 workspaceId 与 cwd 冲突。原始信息：' + raw
      }
      if (raw.includes('session') && (raw.includes('not found') || raw.includes('unknown'))) {
        return '会话不存在（可能刚被删除）。原始信息：' + raw
      }
      // 模型不可用（配置了便宜模型但目录里没有）。
      if (raw.includes('model-unavailable') || raw.includes('model')) {
        return '模型不可用：config.json 里指定的 provider/model 不在可用目录中。删掉或改正该配置即可。原始信息：' + raw
      }
      if (raw.length === 0) return '未知错误（宿主没有给出信息）。'
      return '意外错误：' + raw
    }

    const luckyRemote = {
      /**
       * 掷一次。
       *
       * `trigger` 决定抽哪个池：'click' 全本地、'hold' 全调 AI。
       * 默认 'hold' 是因为这个远端入口给的是「按钮/命令」这类明确意图，
       * 而单击由客户端在 pointerup 时显式传 'click'。
       */
      async roll(options) {
        const trigger = options?.trigger === 'click' ? 'click' : 'hold'
        try {
          return { ok: true, value: await rollDice({ reason: 'button', trigger }) }
        } catch (error) {
          logger.warn(`${PLUGIN_ID}: roll failed: ${String(error?.stack ?? error?.message ?? error)}`)
          return {
            ok: false,
            error: {
              code: 'dice/failed',
              message: explainRollError(error),
              detail: String(error?.message ?? error ?? ''),
            },
          }
        }
      },
      /** 客户端启动时探测宿主侧是否就绪。 */
      async ping() {
        /* 顺带把「会决定行为的外部状态」报出来，方便排查：
           默认工作区在哪、骰子会话会不会被指定模型、人格处在哪个状态。 */
        let workspace = null
        let model = null
        let personaInfo = null
        try {
          const id = await defaultWorkspaceId(ctx)
          workspace = id ? { id } : null
        } catch { /* 忽略：探测失败不影响 ping 成功 */ }
        try {
          model = await modelConfig()
        } catch { /* 同上 */ }
        try {
          const s = await loadPersonaState()
          /* 只暴露统计数字与 mood。`name` 恒为 undefined（人格层已无此字段），
             留着它只会让客户端误以为能读到名字。 */
          personaInfo = { diceCount: s.diceCount, mood: s.mood }
        } catch { /* 同上 */ }
        /* 插话：客户端每次 ping 顺带取一句。取不到就是 null，正常情况。 */
        let chatter = null
        try {
          chatter = takeChatter()
        } catch { /* 同上 */ }
        return {
          ok: true,
          value: {
            plugin: PLUGIN_ID,
            version: VERSION,
            luckyLabel: LUCKY_LABEL,
            workspace,
            model,
            persona: personaInfo,
            chatter,
            events: events.map((e) => ({
              id: e.id,
              title: e.title,
              weight: e.weight,
              /* 触发方式：'click' 左键单点（全本地），'hold' 长按挖满（全调 AI）。 */
              trigger: e.trigger,
              kind: e.kind ?? 'agent',
              visual: e.visual?.kind ?? null,
            })),
          },
        }
      },

      /**
       * 读设置面板需要的全部状态。
       *
       * 与 ping 分开是故意的：ping 会被客户端高频调用（拿插话台词），
       * 而设置面板只在打开时读一次。混在一起会让每次 ping 都多读几个文件。
       */
      async settings() {
        const file = path.join(stateDir(), CONFIG_FILE)
        const raw = (await readJson(file, null)) ?? {}
        /* 只把**用户写过的**覆盖层交出去，让面板能分辨「这是默认值」
           和「这是用户设的值」。空 `{}` 表示一项都没改过。
           这里刻意不做成「合并后的最终权重」——那样用户改回去时没有参照。 */
        const overrides = await eventOverrideConfig()
        return {
          ok: true,
          value: {
            configPath: file,
            model: await modelConfig().catch(() => null),
            /* 挖掘音效开关。默认**开**（音效是这个方块的核心手感之一），
               只有显式写成 false 才关。用 `!== false` 而不是 `=== true`：
               老配置文件里没有这个字段，应该表现为默认开。 */
            sound: raw.sound !== false,
            /* 事件清单：权重 + 开关都可改，以及每个事件当前实际所处的池子。
               trigger 让面板明白「改这条是在改单击池还是长按池」——
               两个池子的权重互不稀释，改错池子不会有任何效果。 */
            events: events.map((e) => ({
              id: e.id,
              title: e.title,
              /* 内置事件的出厂权重。用户改过之后这里仍是原值 ——
                 面板要拿它当「恢复默认」的基准。 */
              defaultWeight: e.weight,
              weight: overrides[e.id]?.weight ?? e.weight,
              enabled: overrides[e.id]?.enabled ?? true,
              trigger: e.trigger,
              kind: e.kind ?? 'agent',
              custom: e.custom === true,
            })),
            eventOverrides: overrides,
            /* 第三方事件文件：面板要给路径 + 读取结果。
               读坏了就把 reason 显示出来，否则用户永远不知道为什么加了没生效。 */
            customEventsPath: path.join(stateDir(), 'custom-events.json'),
            customEvents: customEvents,
            config: raw,
          },
        }
      },

      /**
       * 写设置。目前开放 `sound`（挖掘音效开关）与 `events`（每条事件的权重 / 开关）。
       *
       * 采用**读-改-写**而不是整份覆盖：config.json 里还有用户手写的
       * model / persona 配置，整份覆盖会把它们抹掉。
       *
       * 权重与开关要重启才生效（事件池在 apply 时建好）。这里不做热重载：
       * 事件不是纯偏好数据，每个事件都带着 prompt 和 prepare 逻辑，
       * 热替换等于在运行期换掉一套行为定义，出问题很难定位。
       */
      async saveSettings(patch) {
        const file = path.join(stateDir(), CONFIG_FILE)
        const raw = (await readJson(file, null)) ?? {}
        // 只认布尔值：客户端传 `"false"` 这种字符串时不理它，免得把配置写坏。
        if (patch && typeof patch.sound === 'boolean') {
          raw.sound = patch.sound
        }
        // 事件覆盖层：整份替换（用户看到的就是全量状态，删掉一条就是恢复默认）。
        if (patch && patch.events && typeof patch.events === 'object' && !Array.isArray(patch.events)) {
          raw.events = patch.events
        }
        await writeJson(file, raw)
        return {
          ok: true,
          value: {
            configPath: file,
            sound: raw.sound !== false,
            events: eventOverrideSafe(raw.events),
          },
        }
      },
    }

    try {
      ctx.reflect?.provide?.('luckyBlock', luckyRemote)
    } catch (error) {
      logger.warn(`${PLUGIN_ID}: reflect.provide("luckyBlock") failed: ${String(error)}`)
    }

    /* --- 自定义 HTTP 路由（web 与 desktop 都走这里） --- */

    const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

    // 三层信任栅栏（照抄 dsh-whale-widget 的做法，见其 lib/index.js:803-885）
    const TRUSTED_AUTHORITIES = String(process.env.DSHL_TRUSTED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const ADMIN_AUTHORITIES = String(process.env.DSHL_ADMIN_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

    function isLoopbackHostname(hn) {
      const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
      if (!h) return false
      if (h === 'localhost' || h.endsWith('.localhost')) return true
      if (h === '::1') return true
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      if (!m || Number(m[1]) !== 127) return false
      return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
    }

    /** 通过 → null；否则返回应拒绝的状态码。fail-closed：自身出错即拒绝。 */
    function selfRejection(req) {
      try {
        const headers = (req && req.headers) || {}
        const hostUrl = new URL('http://' + String(headers.host || ''))
        const authority = hostUrl.host.toLowerCase()
        if (authority.length === 0) return 403
        if (!isLoopbackHostname(hostUrl.hostname) && !TRUSTED_AUTHORITIES.some((e) => (e.includes(':') ? e === authority : e === hostUrl.hostname.toLowerCase()))) {
          return 403
        }
        if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
        const origin = headers.origin
        if (origin && String(origin).toLowerCase() !== `http://${authority}` && String(origin).toLowerCase() !== `https://${authority}`) return 403
        // 写请求必须来自本机
        const method = String(req.method || 'GET').toUpperCase()
        if (WRITE_METHODS.has(method)) {
          if (!isLoopbackHostname(hostUrl.hostname)) {
            const ok = ADMIN_AUTHORITIES.some((e) => (e.includes(':') ? e === authority : e === hostUrl.hostname.toLowerCase()))
            if (!ok) return 403
          }
        }
        return null
      } catch {
        return 403
      }
    }

    function connectionFence() {
      try {
        const conn = ctx.get?.('connection') ?? ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch {
        return null
      }
    }

    function rejected(req, res) {
      const deny = (code) => {
        try {
          res.statusCode = code || 403
          res.end()
        } catch { /* ignore */ }
        return true
      }
      const fence = connectionFence()
      const self = selfRejection(req)
      if (self !== null) return deny(self)
      if (!fence) return false
      let code
      try {
        code = fence.requestRejection(req)
      } catch (error) {
        // 栅栏自己抛异常 → 按拒绝处理（fail-closed）
        logger.warn(`${PLUGIN_ID}: trust fence threw, denying: ${String(error)}`)
        return deny(403)
      }
      if (code === undefined || code === null || code === false) return false
      return deny(Number(code) || 403)
    }

    function sendJson(res, status, body) {
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(body))
    }

    /**
     * 发二进制（挖掘音效）。**不要**用 sendJson —— 那会把 ogg 字节
     * 变成 JSON 字符串并平白多 33% 体积。
     *
     * `immutable` 缓存：音效文件在发布后不会变（改了要重新 build-sounds），
     * 让浏览器缓存住，长按挖掘时每 210ms 要一个音就不必反复走网络。
     * 用内容 hash 做 ETag 也是同一目的，但插件这层拿不到构建号，
     * 退化成「带 mtime 的弱缓存」不值得，直接长缓存 + 换版本号即可。
     */
    function sendBinary(res, status, buffer, contentType) {
      try {
        res.writeHead(status, {
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'public, max-age=604800, immutable',
        })
        res.end(buffer)
      } catch { /* ignore */ }
    }

    /**
     * 读请求体并 JSON.parse。
     *
     * 自带**体积上限**：这是从客户端来的写请求，宿主进程不能被一个超大 body 拖垮。
     * 超过上限直接掐断连接并抛错，由路由的 catch 变成 500。
     */
    function readRequestBody(req, limit = 256 * 1024) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > limit) {
            reject(new Error(`request body too large (> ${limit} bytes)`))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (text.trim().length === 0) {
            resolve({})
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(new Error(`request body is not valid JSON: ${String(error?.message ?? error)}`))
          }
        })
        req.on('error', reject)
      })
    }

    // webServer 由 inject 保证就绪（见顶部注释：ctx.get 在 apply 时拿不到）。
    const webServer = ctx.webServer
    if (webServer && typeof webServer.register === 'function') {
      const routes = [
        {
          kind: 'exact',
          path: '/dsh-lucky-block/ping',
          /* 必须 await！luckyRemote.ping() 是 async，直接把它交给 sendJson 会
             序列化成一个 Promise 对象 → `JSON.stringify(Promise)` 得到 `{}`，
             客户端看到的就是空空如也的 200（实测踩过：路由没问题、状态码 200、
             响应体却是 `{}`，非常容易被误判成「插件没激活」）。 */
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              sendJson(res, 200, await luckyRemote.ping())
            } catch (error) {
              logger.warn(`${PLUGIN_ID}: ping failed: ${String(error)}`)
              sendJson(res, 500, {
                ok: false,
                error: { code: 'ping/failed', message: explainRollError(error), detail: String(error?.message ?? error) },
              })
            }
          },
        },
        {
          kind: 'exact',
          path: '/dsh-lucky-block/roll',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            /* trigger 从请求体里读：客户端单击传 'click'、长按传 'hold'。
               读不到 / 写错时退回 'hold'（旧客户端没有这个字段，行为与以前一致）。 */
            let trigger = 'hold'
            try {
              const body = await readRequestBody(req)
              if (body && body.trigger === 'click') trigger = 'click'
            } catch { /* 没有请求体也算正常：按默认走 */ }
            const result = await luckyRemote.roll({ trigger })
            sendJson(res, result.ok ? 200 : 500, result)
          },
        },
        {
          kind: 'exact',
          path: '/dsh-lucky-block/settings',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              sendJson(res, 200, await luckyRemote.settings())
            } catch (error) {
              logger.warn(`${PLUGIN_ID}: settings read failed: ${String(error)}`)
              sendJson(res, 500, {
                ok: false,
                error: { code: 'settings/failed', message: explainRollError(error), detail: String(error?.message ?? error) },
              })
            }
          },
        },
        {
          kind: 'exact',
          path: '/dsh-lucky-block/save-settings',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              const patch = await readRequestBody(req)
              sendJson(res, 200, await luckyRemote.saveSettings(patch))
            } catch (error) {
              logger.warn(`${PLUGIN_ID}: settings save failed: ${String(error)}`)
              sendJson(res, 500, {
                ok: false,
                error: { code: 'settings/failed', message: explainRollError(error), detail: String(error?.message ?? error) },
              })
            }
          },
        },
        {
          /*
           * 只读诊断：这个骰子会话被注入了什么系统提示。
           *
           * 为什么需要它 —— 骰子会话的长内容现在走 system prompt，用户消息只剩一行
           * 「🎲 随机事件：xxx」。这带来一个测试盲区：注入本身**没有任何可见痕迹**
           * （会话投影缓存里 `contextTimeline.surface` 只记 user/inject/skill/assistant
           * 四类，注入段不进 surface；`systems` 只有一个 tokens 计数）。所以注入失败时
           * 探针只能看到「用户消息很短」而看不到「agent 到底收到指令没有」，
           * 于是「注入没生效、agent 反问要做什么」这种故障会一路绿灯。
           *
           * 这个路由把内存里的 dicePrompts 暴露出来，让 probe-persona /
           * probe-dice-prompt 能直接断言注入内容。只读，且只在本进程内存里查，
           * 不碰磁盘、不建会话、不改状态。
           */
          kind: 'exact',
          path: '/dsh-lucky-block/dice-prompt',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const sessionId = url.searchParams.get('sessionId') ?? ''
              const hit = sessionId ? dicePrompts.get(sessionId) : null
              sendJson(res, 200, {
                ok: true,
                value: {
                  sessionId,
                  found: Boolean(hit),
                  text: hit?.text ?? null,
                  /* 没命中时给出当前登记过的会话 id，方便探针排查是「查错了会话」
                     还是「根本没登记」。两者是完全不同的故障。 */
                  known: [...dicePrompts.keys()],
                },
              })
            } catch (error) {
              sendJson(res, 500, {
                ok: false,
                error: { code: 'dice-prompt/failed', message: explainRollError(error), detail: String(error?.message ?? error) },
              })
            }
          },
        },
        {
          /* 挖掘音效（原版 ogg）。**必须用 prefix 前缀匹配** —— 客户端按
             `/dsh-lucky-block/sound/dig1.ogg` 这样取文件，exact 匹配要写 16 条路由。
             路径穿越在下面用白名单挡掉（只认已知文件名），不靠路径规范化。

             ⚠️ 前缀**不能带尾斜杠**：webserver 的匹配逻辑是
             `pathname !== prefix && !pathname.startsWith(prefix + '/')`
             （见 dsh-host-webserver/lib/index.js:328）。写 `.../sound/` 的话
             判据变成 `.../sound//`，永远匹配不上；写 `.../sound` 才能同时命中
             它自己和它下面的文件。 */
          kind: 'prefix',
          path: '/dsh-lucky-block/sound',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            const url = new URL(req.url ?? '/', 'http://localhost')
            const prefix = '/dsh-lucky-block/sound/'
            if (!url.pathname.startsWith(prefix)) {
              return sendJson(res, 404, { ok: false, error: { code: 'sound/invalid-name', message: '音效路径不合法。' } })
            }
            const name = decodeURIComponent(url.pathname.slice(prefix.length))
            /* 白名单：只允许「字母数字下划线 + .ogg」。这条比规范化安全 ——
               `..%2f` 之类解码后带斜杠的直接不匹配，根本进不到 join。 */
            if (!/^[A-Za-z0-9_]+\.ogg$/.test(name)) {
              return sendJson(res, 404, { ok: false, error: { code: 'sound/invalid-name', message: '音效文件名不合法。' } })
            }
            const file = path.join(packageRoot(), 'lib', 'sounds', name)
            try {
              const buffer = await readFile(file)
              sendBinary(res, 200, buffer, 'audio/ogg')
            } catch {
              sendJson(res, 404, { ok: false, error: { code: 'sound/missing', message: `音效文件不存在：${name}` } })
            }
          },
        },
        {
          /* 随机音频事件的曲库（用户自己往里放的文件）。
           *
           * 与 /sound 分开是**有意的**：/sound 是随包发布的挖掘音效，白名单写死
           * 只认 .ogg；这里允许 .mp3，因为用户给的清单里什么格式都可能有。
           * 两条路由各管各的白名单，改一条不会放松另一条。
           *
           * 前缀同样**不能带尾斜杠**（见上面 /sound 的注释）。
           */
          kind: 'prefix',
          path: '/dsh-lucky-block/audio',
          handler: async (req, res) => {
            if (rejected(req, res)) return
            const url = new URL(req.url ?? '/', 'http://localhost')
            const prefix = '/dsh-lucky-block/audio/'
            if (!url.pathname.startsWith(prefix)) {
              return sendJson(res, 404, { ok: false, error: { code: 'audio/invalid-name', message: '音频路径不合法。' } })
            }
            const name = decodeURIComponent(url.pathname.slice(prefix.length))
            /* 白名单与 localAudioTracks() 的校验规则一致（那里决定了哪些条目能进曲库）：
               字母数字下划线横杠 + .ogg/.mp3。`..%2f` 解码后带斜杠，直接不匹配。 */
            if (!/^[A-Za-z0-9_-]+\.(ogg|mp3)$/.test(name)) {
              return sendJson(res, 404, { ok: false, error: { code: 'audio/invalid-name', message: '音频文件名不合法。' } })
            }
            /* 用户目录优先，随包那份兜底 —— 与 localAudioTracks() 的查找顺序一致。
               第三方扩展曲库不该要求改插件包本体（插件升级会覆盖回去）。 */
            const candidates = [
              path.join(stateDir(), 'audio', name),
              path.join(packageRoot(), 'lib', 'audio', name),
            ]
            const mime = name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg'
            for (const file of candidates) {
              try {
                const buffer = await readFile(file)
                sendBinary(res, 200, buffer, mime)
                return
              } catch {
                /* 换下一个候选位置 */
              }
            }
            sendJson(res, 404, { ok: false, error: { code: 'audio/missing', message: `音频文件不存在：${name}` } })
          },
        },
      ]
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(webServer.register(route))
        } catch (error) {
          logger.warn(`${PLUGIN_ID}: webServer.register(${route.path}) failed: ${String(error)}`)
        }
      }
      if (disposers.length > 0) {
        logger.info(`${PLUGIN_ID}: ${disposers.length} http route(s) registered`)
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch { /* ignore */ }
          }
        })
      }
      if (!connectionFence()) {
        logger.warn(`${PLUGIN_ID}: 宿主信任栅栏不可用（connection.requestRejection 缺失），已启用插件自带的回环/同源校验`)
      }
    } else {
      logger.warn(`${PLUGIN_ID}: ctx.webServer 缺失或无 register，幸运方块按钮将无法工作（/dice 命令仍可用）`)
    }

    ctx.effect(() => () => {
      logger.info(`${PLUGIN_ID}: host side disposed`)
    })
  },
}
