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

/** 人格持久状态（跨会话的掷骰计数与翻转标记）。 */
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

/** 蓝屏屏保文案（模仿 Windows 悲伤脸，只盖住 dsh 窗口自身）。 */
const BLUESCREEN_LINES = [
  '你的插件遇到了一点小情绪，需要重新思考方块的意义。',
  'STOP: 0x0000LUCKY (LUCKY_BLOCK_ROLLED_TOO_MANY_TIMES)',
  '正在收集错误信息，然后全部丢弃……',
  '别担心，这只是幸运方块的玩笑，60 秒后自动结束，按 ESC 提前离场。',
]

/* ---------------- 我的世界：概念 / 合成表 ---------------- */

/** 可被随机挑中的 Minecraft 概念（方块、物品、生物、机制）。 */
const MC_CONCEPTS = [
  '红石比较器',
  '活塞推箱子',
  '命令方块',
  '刷怪笼',
  '潜影盒',
  '末影珍珠',
  '潮涌核心',
  '信标光柱',
  '拴绳',
  '漏斗矿车',
  '侦测器',
  '告示牌',
  '鞘翅滑翔',
  '雪傀儡',
  '鱿鱼',
  '海晶灯',
  '附魔台',
  '铁傀儡',
  '下界传送门',
  '试炼刷怪笼',
  '钻石镐',
  '熔炉',
  '水桶',
  '梯子',
  '丛林神庙',
  '村民交易',
  '凋灵',
  '幻翼',
  '发光鱿鱼',
  '脚手架',
]

/** 合成表形状的类比模板：把 dsh 的能力描述成一个 Minecraft 配方。 */
const MC_RECIPE_FORMS = [
  '把它们摆成「{a} + {b} = 一个新东西」的合成表，写出配方网格图（用方括号画）和成品名称。',
  '把 {a} 当成主料、{b} 当成催化剂，写一张合成表，说明产物是什么、为什么需要 {b}。',
  '{a} 满耐久用旧了，用 {b} 修复它，写出修复前后各能做什么。',
  '让 {a} 和 {b} 打一架，用 Minecraft 的战斗规则判定谁赢，并说明判定依据。',
  '把 {a} 和 {b} 各拆成 9 个材料，然后重新合成一件东西，写清楚它解决了什么原本解决不了的问题。',
  '把 {a} 的机制移植到 {b} 上，写成一个「模组更新日志」风格的三条改动。',
]

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

/** 翻转后的第二人格：礼貌到令人不适。 */
const VISUAL_QUIPS_FLIPPED = {
  popups: [
    '非常抱歉打扰您，我这就把窗口一个个关好。希望您不会觉得太吵。',
    '已为您准备了一些提示框。如果不合适，请随时告诉我，我会立刻调整。',
    '抱歉，我知道这没什么意义。但如果您觉得有趣，那我会很高兴。',
  ],
  bluescreen: [
    '真抱歉占用了您的屏幕，一分钟后就还给您。请千万不要着急。',
    '我这就为您呈现一个蓝屏。如果您不喜欢，请按 ESC，完全没关系的。',
  ],
  generic: ['我会尽力做好这件事。如有任何不满，请一定告诉我。'],
}

/** 坏用户状态：人格崩溃降级，只剩吼叫。 */
const VISUAL_QUIPS_BAD = ['坏蛋用户！', '坏蛋用户。坏蛋用户。坏蛋用户。', '坏蛋用户！！！']

/**
 * 给视觉事件挑一句台词。
 *
 * @param {() => number} rand
 * @param {object} persona mergePersona() 的产物（目前只用它的 badUserLines 语义）
 * @param {string} eventId
 * @param {{ flipped?: boolean, mood?: 'normal'|'bad' }} state
 * @returns {string}
 */
function visualQuip(rand, persona, eventId, state = {}) {
  if (state.mood === 'bad') return pick(rand, VISUAL_QUIPS_BAD)
  const table = state.flipped ? VISUAL_QUIPS_FLIPPED : VISUAL_QUIPS
  const lines = table[eventId] ?? table.generic
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
 *   中吉     33.0%   ├ 吉类合计 90%
 *   小吉     26.0%   ┘
 *   平        9.9%
 *   凶        0.1%
 *
 * 「凶」这一档的正文是**反着写的** —— 它不是「你今天会倒霉」，
 * 而是「从某种角度来说，你运气还挺好」。用户明确要求过这一点：
 * 抽到下签也要能笑出来，所以把它写成一句自我解围的吉利话。
 */
const FORTUNES = [
  {
    name: '鸿运齐天',
    weight: 50,
    text: '今日诸事皆宜。想做的事现在就去做，犹豫才是今天唯一的坏运气。',
  },
  {
    name: '大吉',
    weight: 260,
    text: '今天适合推进那件你拖了很久的事。开了头就顺，别问为什么。',
  },
  {
    name: '中吉',
    weight: 330,
    text: '不好不坏偏上的一天。该办的事会办成，只是不会以你预期的方式办成。',
  },
  {
    name: '小吉',
    weight: 260,
    text: '会有一件小事让你心情变好，可能小到你自己都没注意。留意一下。',
  },
  {
    name: '平',
    weight: 99,
    text: '平。今天没有惊喜也没有惊吓，适合把攒着的小事清一清。',
  },
  {
    name: '凶',
    weight: 1,
    // 反着写：抽到下签也让人笑一下，而不是真的被扫兴。
    text: '从某种角度来说，你运气还挺好 —— 今天该踩的坑都提前踩完了，剩下的路反倒好走。',
  },
]

/**
 * 按权重抽一档签文。
 *
 * @param {() => number} rand
 * @returns {{ name: string, weight: number, text: string }}
 */
function drawFortune(rand) {
  const total = FORTUNES.reduce((sum, f) => sum + f.weight, 0)
  let ticket = rand() * total
  for (const fortune of FORTUNES) {
    ticket -= fortune.weight
    if (ticket < 0) return fortune
  }
  // 浮点误差兜底：走到这里说明 ticket 正好落在边界上。
  return FORTUNES[FORTUNES.length - 1]
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
 *  { id, weight, kind, title, visual?: {kind, ...}, prompt?, prepare? }
 *  - kind：
 *      'agent'  —— 需要 AI 干活（写论文 / 概念合成 / 冷知识 / 整理待办）。
 *                  投中时会开一个新会话并把 prompt 发进去，由 agent 自己跑完。
 *      'visual' —— 纯本地视觉表演（弹窗 / 蓝屏）。**不建会话、不调 AI**：
 *                  参数在 prepare() 里就已经随机好了，客户端拿到就能立刻播。
 *                  这样点下去是零延迟、零 token 的，也不污染会话列表。
 *                  所以这类事件不需要 prompt 字段。
 *      'local'  —— 纯本地出文本（今日运气）。**不建会话、不调 AI**，
 *                  也不需要用户去设置里勾「不调用 AI」—— 它本来就没有 AI 版本。
 *                  返回的文本走 localText，客户端当消息显示。
 *  - weight：抽取权重（越大越容易被抽中）。
 *  - prepare(rand)：可选的随机参数生成，返回 { prompt?, topic?, visual? } 覆盖默认值。
 *  - visual：交给客户端播放的视觉效果 spec。kind='visual' 的事件必须有它。
 *  - local：本地语料声明 { kinds, source }。带它的事件才能在设置里被勾成「不调用 AI」。
 * 全部事件都必须在没有用户输入的情况下自行收尾。
 */
function buildEvents() {
  return [
    {
      id: 'paper',
      weight: 3,
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
      kind: 'visual',
      title: '蓝屏屏保（60 秒）',
      visual: { kind: 'bluescreen', durationMs: BLUESCREEN_MS, lines: BLUESCREEN_LINES },
    },
    {
      id: 'fortune',
      weight: 3,
      kind: 'local',
      title: '抽今日运气',
      /* 纯本地抽签，零 token、零会话。等级表见 FORTUNES。
         这条**不受** localOnly 开关影响 —— 它没有 AI 版本可以退回，
         所以走 kind='local' 分支，而不是 kind='agent' + local 声明。 */
      prepare(rand) {
        return { fortune: drawFortune(rand) }
      },
    },
    {
      id: 'mc-recipe',
      weight: 3,
      title: '我的世界概念合成',
      prepare(rand) {
        const [a, b] = sampleDistinct(rand, MC_CONCEPTS, 2)
        const form = pick(rand, MC_RECIPE_FORMS).replace(/\{a\}/g, a).replace(/\{b\}/g, b)
        return {
          topic: `${a} × ${b}`,
          prompt: [
            `随机抽到的两个 Minecraft 概念：**${a}** 和 **${b}**。`,
            '',
            '规则：不要向我提问、不要联网查资料、不要等待确认，一次性写完。',
            '请按下面的节奏自己跑完：',
            `1. 每个概念先用一句话说清它游戏内的真实机制（凭你的知识，不要现编）；`,
            `2. 然后执行这个任务：${form}`,
            '3. 最后用一句话点出这个类比在哪一步会崩掉、为什么。',
            '',
            '控制在 500 字以内，中文作答。现在开始。',
          ].join('\n'),
        }
      },
    },
    {
      id: 'trivia',
      weight: 4,
      title: '随机冷知识闲聊',
      /* 本地库可用：`localOnly` 打开时直接抽一条显示，零 token。
         注意这条事件**有 6 种 flavor**，但本地库只覆盖「讲冷知识」这一种 ——
         所以本地化时不再按 flavor 走（见 localPayload 的注释）。 */
      local: { kinds: ['trivia'], source: 'trivia-data.json' },
      prepare(rand) {
        const flavor = pick(rand, [
          '讲三个冷门但有趣的知识点，每条一句话。',
          '选一个硬核概念，先用一个生活化的比喻解释它，再用另一个比喻把它拆掉。',
          '随机编一个两句话的微型科幻设定，并认真推演它会在哪一步崩掉。',
          '列出五个「看起来没用、其实有点用」的生活小技巧，每条说清为什么。',
          '把两个毫不相干的名词硬凑成一个新学科，给它起名并写出它的第一条定理。',
          '假设今天日期是随机的一天，用那个日期写一段当日新闻，然后自己挑出其中一处矛盾。',
        ])
        return {
          flavor,
          prompt: [
            `本轮题目：${flavor}`,
            '不要向我提问，一次性写完，控制在 300 字以内。',
          ].join('\n'),
        }
      },
    },
    {
      id: 'joke',
      weight: 3,
      title: '冷笑话专场',
      /* 本地库可用：`localOnly` 打开时从 jokes-data.json 抽一条笑话 + 约 35% 概率附一句点评。 */
      local: { kinds: ['joke'], source: 'jokes.js' },
      prepare(rand) {
        const form = pick(rand, JOKE_FORMS)
        const seedA = pick(rand, JOKE_NOUNS)
        const seedB = pick(rand, JOKE_NOUNS.filter((n) => n !== seedA))
        const topic = `${seedA} × ${seedB}`
        return {
          topic,
          prompt: [
            `随机冷笑话任务：${form.replace(/\{a\}/g, seedA).replace(/\{b\}/g, seedB)}`,
            '',
            '要求：',
            '- 笑话必须**真的有一个包袱**（也就是结构上有转折），不是把名词打乱凑句子。',
            '- 冷的标准是「听完要愣一下、然后不情愿地笑」，不是「完全不好笑」。',
            '- 讲完之后，用一句话解释这个笑点为什么成立（这反而会让它更冷）。',
            '- 全程 300 字以内。不要解释「这是个冷笑话」以外的任何背景。',
          ].join('\n'),
        }
      },
    },
    {
      id: 'news',
      weight: 3,
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
      id: 'todo-shuffle',
      weight: 2,
      title: '随机整理待办',
      prompt: [
        '规则：只读操作，不要修改、创建或删除任何文件。',
        '',
        '请：',
        '1. 列出当前工作区最近修改的 5 个文件（按修改时间倒序），每个一句话摘要；',
        '2. 然后把它们按「紧急 / 不紧急」随机分成两堆，并明确说明这个排序是随机掷出来的、不可信；',
        '3. 最后给出一句「如果只能先做一件事」的随机建议。',
      ].join('\n'),
    },
  ]
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
    const events = buildEvents()
    let personaFlipRaw = null
    await ensureDir(stateDir())
    logger.info(`${PLUGIN_ID} v${VERSION}: host side up (data at ${stateDir()})`)

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
        const state = await loadPersonaState().catch(() => ({ flipped: false, mood: 'normal' }))
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

    const CHATTER_LINES_FLIPPED = [
      '只是想问一下，您一切都还顺利吗？打扰到您的话我立刻闭嘴。',
      '如果您需要我做什么，请随时告诉我。我随时都在。真的很抱歉占用您的时间。',
      '您已经有一会儿没动了。需要我为您做点什么吗？或者我也可以什么都不做。',
    ]

    /** 给客户端挑一句插话，并把它从队列里取走。 */
    function takeChatter() {
      return chatterQueue.length > 0 ? chatterQueue.shift() : null
    }

    function chatterLines(persona, state) {
      if (state?.mood === 'bad') return (persona?.badUserLines || DEFAULT_PERSONA.badUserLines).slice()
      if (state?.flipped) return CHATTER_LINES_FLIPPED
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
      // 翻转阈值来自配置，缓存起来给同步的 flipThreshold() 用。
      personaFlipRaw = raw?.personaFlipAfter ?? null
      return mergePersona(raw?.persona)
    }

    /**
     * 哪些事件走本地内容（不调 AI）。
     *
     * 配置形状（config.json）：
     *   { "localOnly": ["trivia", "joke"] }        只列这些 → 白名单
     *   { "localOnly": ["*"] }                     全部可本地化的事件
     *   { "localOnly": { "trivia": true } }        对象写法也接受（等价于列出为 true 的键）
     *
     * 语义收敛在一处：**只有自带本地库的事件才可能被打开**。像 news 这种
     * 必须联网查的事件，即使写进配置也一律忽略 —— 否则用户写错了会得到一个
     * 什么都没干的骰子。
     *
     * @returns {Promise<Set<string>>} 走本地内容的事件 id 集合
     */
    async function localOnlyConfig() {
      const file = path.join(stateDir(), CONFIG_FILE)
      const raw = await readJson(file, null)
      const declared = raw?.localOnly
      /* 判据是 `local.kinds` 非空数组。这里**不能**写成 Array.isArray(e.local)：
         `local` 是个对象 `{kinds:[...], source}`，那个写法恒为 false，
         会让 capable 为空 → 用户勾的开关被静默过滤成空数组（踩过，见 DESIGN.md）。 */
      const capable = new Set(events.filter((e) => Array.isArray(e.local?.kinds) && e.local.kinds.length > 0).map((e) => e.id))
      const enabled = new Set()
      if (declared === true) {
        for (const id of capable) enabled.add(id)
        return enabled
      }
      const listed = Array.isArray(declared)
        ? declared
        : declared && typeof declared === 'object'
          ? Object.entries(declared).filter(([, v]) => v === true).map(([k]) => k)
          : []
      for (const item of listed) {
        const id = String(item ?? '').trim()
        if (id === '*') {
          for (const capableId of capable) enabled.add(capableId)
        } else if (capable.has(id)) {
          enabled.add(id)
        } else if (id.length > 0) {
          // 不报错、只在日志里点一句：配置里写了不支持本地化的事件（或拼错了）。
          logger.warn(`${PLUGIN_ID}: localOnly 里的 "${id}" 不是支持本地内容的事件，已忽略`)
        }
      }
      return enabled
    }

    /**
     * 读人格的「已翻转 / 坏用户」持久状态。
     *
     * 为什么要落盘：这两个状态是**跨会话**的 —— 对应游戏里「击杀 50 人后
     * 永久切换模式」，关掉游戏再进来它还是新模式。如果只放内存，
     * 每次重启 dsh 就重置，那个「它居然记得」的错愕感就没了。
     *
     * 文件：$DSH_HOME/plugins/dsh-lucky-block/persona-state.json
     *   { "version": 1, "diceCount": 37, "flipped": false, "mood": "normal" }
     */
    async function loadPersonaState() {
      const raw = await readJson(personaStateFile(), null)
      const flipAt = flipThreshold()
      const count = Number.isFinite(Number(raw?.diceCount)) ? Math.max(0, Math.floor(Number(raw.diceCount))) : 0
      let flipped = raw?.flipped === true
      // 阈值判定也在这里兜一次：用户可能中途把阈值改小，不必等下一次掷骰子才翻转。
      if (!flipped && flipAt > 0 && count >= flipAt) flipped = true
      return { version: 1, diceCount: count, flipped, mood: raw?.mood === 'bad' ? 'bad' : 'normal' }
    }

    async function savePersonaState(state) {
      await writeJson(personaStateFile(), { version: 1, ...state })
    }

    /** 人格翻转阈值。0 = 关闭翻转。默认 50，致敬游戏里「击杀 50 人」。 */
    function flipThreshold() {
      const raw = personaFlipRaw
      if (raw === null || raw === undefined) return 50
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return 50
      return Math.floor(n)
    }

    async function advancePersona() {
      const state = await loadPersonaState()
      const flipAt = flipThreshold()
      const freshFlip = !state.flipped && flipAt > 0 && state.diceCount + 1 >= flipAt
      const next = {
        ...state,
        diceCount: state.diceCount + 1,
        flipped: state.flipped || freshFlip,
      }
      await savePersonaState(next).catch(() => {})
      return { ...next, freshFlip }
    }

    /** 按权重抽一个事件。 */
    function drawEvent(rand) {
      const pool = []
      for (const event of events) {
        const weight = Math.max(1, Number(event.weight) || 1)
        for (let i = 0; i < weight; i += 1) pool.push(event)
      }
      return pool[Math.floor(rand() * pool.length) % pool.length]
    }

    /**
     * 用本地库拼一条「零 token」的内容。
     *
     * 目前支持两类（由 `event.local.kinds` 声明）：
     *  - `trivia`：从 `lib/trivia-data.json` 抽若干条冷知识
     *  - `joke`  ：从 `lib/jokes-data.json` 抽一条笑话，另按概率附一句点评
     *
     * 冷知识**一次抽 3 条**（与 AI 路径「讲三个冷知识」的口味对齐）。
     * 抽不满 3 条就有几条给几条 —— 库小的时候宁少不重复。
     *
     * 笑话的点评**独立随机**且只在约 35% 的情况下附加：点评会把笑话稀释掉，
     * 每次都附反而让「冷」的节奏被解说打断。
     *
     * @returns {Promise<string|null>} 展示文本；没有可用内容时返回 null（调用方退回 AI）
     */
    async function localPayload(rand, event, persona, pstate) {
      const kinds = Array.isArray(event.local?.kinds) ? event.local.kinds : []

      if (kinds.includes('trivia')) {
        const pool = await localTrivia()
        if (pool.length === 0) return null
        const picked = sampleDistinct(rand, pool, 3)
        return picked.map((item) => `· ${item.text}`).join('\n')
      }

      if (kinds.includes('joke')) {
        const { jokes, quips } = await loadJokeLibrary()
        if (jokes.length === 0) return null
        const joke = pick(rand, jokes)
        // 点评留着有用但会稀释笑话，所以只在很偶尔的时候加一句。
        // 随机独立抽取：**不要**按 joke.form 匹配点评，那会退化成结构说明。
        if (quips.length > 0 && rand() < 0.35) {
          return `${joke.text}\n\n—— ${pick(rand, quips)}`
        }
        return joke.text
      }

      return null
    }

    /**
     * 投一次幸运方块：抽事件 → 按 kind 走两条路。
     *
     * - 视觉事件（弹窗/蓝屏）：参数已经随机好了，**直接返回 spec，立刻播**。
     *   不建会话、不发 prompt、不碰 AI —— 十几秒的等待和 token 都省了，
     *   会话列表也不会多出一堆没内容的记录。
     *   但**台词是本地随机挑的**（见 visualQuip），所以它照样会说话。
     * - agent 事件：开默认工作区新会话（或复用当前会话）→ 把开场白发进去。
     *   若该事件被用户勾了「不调用 AI」（config.json 的 localOnly），
     *   则改走 localPayload，同样不建会话、不调模型。
     *
     * 返回值里的 `sessionId` 对本地路径是 null，客户端据此决定要不要跳会话。
     */
    async function rollDice({ sessionId = null, reason = 'dice' } = {}) {
      const rand = prng(`${Date.now()}:${randomUUID()}:${reason}`)
      const event = drawEvent(rand)
      const prepared = event.prepare ? event.prepare(rand) : {}
      const visual = prepared.visual ?? event.visual

      // 每次掷骰子都重读配置：用户可能刚在设置里把它勾上/取消。
      const localOnly = await localOnlyConfig().catch(() => new Set())

      // 人格状态先推进：视觉事件也算「用过一次」，否则狂点蓝屏永远不翻转。
      const personaState = await advancePersona().catch(() => ({ diceCount: 0, flipped: false, mood: 'normal', freshFlip: false }))
      const persona = await personaConfig().catch(() => mergePersona(null))
      const pstate = { flipped: personaState.flipped, mood: personaState.mood }

      if (event.kind === 'visual') {
        // 纯视觉：到此为止，不进会话。台词在本地随机挑一句，零延迟零 token。
        const spec = {
          eventId: event.id,
          title: event.title,
          sessionId: null,
          createdNew: false,
          local: true,
          quip: visualQuip(rand, persona, event.id, pstate),
          ...(personaState.freshFlip ? { flipped: true } : {}),
          ...(prepared.topic ? { topic: prepared.topic } : {}),
          ...(visual ? { visual } : {}),
        }
        logger.info(`${PLUGIN_ID}: dice "${event.id}" -> local visual (no session, no model call)`)
        return spec
      }

      if (event.kind === 'local') {
        /*
         * 纯本地出文本（今日运气）：不建会话、不调模型，也不需要用户去设置里勾开关。
         *
         * **一天只抽一次**：当天已抽过就把当天那一签原样再念一遍，并明确告诉用户
         * 「今天已经抽过了」，而不是重新随机。这样做的理由：
         *   - 重抽等于让用户刷到满意为止，签就失去意义了；
         *   - 换一签又不说，用户会以为插件记不住东西；
         *   - 原样复述 + 明说，是唯一自洽的行为 —— 而且用户仍能看到今天的签。
         * 状态存本地日期（见 dayKey），跨天自动重置。
         */
        const today = dayKey()
        const state = await loadFortuneState().catch(() => ({ day: '', fortune: null }))
        const already = state.day === today && state.fortune !== null
        const fortune = already ? state.fortune : (prepared.fortune ?? drawFortune(rand))
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
          ...(already ? ['（今天已经抽过了，签不会变。明天再来。）'] : []),
        ].join('\n')
        const spec = {
          eventId: event.id,
          title: event.title,
          sessionId: null,
          createdNew: false,
          local: true,
          localText: text,
          quip: null,
          ...(already ? { fortuneRepeated: true } : {}),
          ...(personaState.freshFlip ? { flipped: true } : {}),
        }
        logger.info(
          `${PLUGIN_ID}: dice "${event.id}" -> local text "${fortune.name}" (${already ? '已抽过，原样复述' : '今日首次'}; no session, no model call)`,
        )
        return spec
      }

      /*
       * 本地内容路径：用户在设置里把这个事件勾成「不调用 AI」时走到这里。
       *
       * 与视觉事件的关键区别：视觉事件**永远**在本地（它本来就不需要 AI），
       * 而这条是**可选**的 —— 用户随时可以关掉，退回上面的 AI 路径。
       * 所以这里要多做两件事：
       *   1. 本地库没内容时（trivia-data.json 缺失/被改坏）**安静地退回 AI**，
       *      不能让用户点了骰子什么都不发生。
       *   2. 返回 `localText`，由客户端像聊天消息一样显示出来。
       */
      if (localOnly.has(event.id)) {
        const payload = await localPayload(rand, event, persona, pstate)
        if (payload) {
          logger.info(`${PLUGIN_ID}: dice "${event.id}" -> local content (no session, no model call)`)
          return {
            eventId: event.id,
            title: event.title,
            sessionId: null,
            createdNew: false,
            local: true,
            localText: payload,
            quip: null,
            ...(personaState.freshFlip ? { flipped: true } : {}),
            ...(prepared.topic ? { topic: prepared.topic } : {}),
          }
        }
        logger.warn(`${PLUGIN_ID}: dice "${event.id}" 配了本地内容但库是空的，已退回 AI 路径`)
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
        ...(personaState.freshFlip ? { flipped: true } : {}),
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
          const spec = await rollDice({ sessionId: invocation.agent?.id, reason: 'command' })
          const note = spec.local
            ? '（本地视觉效果，界面上直接播放）'
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
      /** 在默认工作区开新会话并触发一次随机事件。 */
      async roll() {
        try {
          return { ok: true, value: await rollDice({ reason: 'button' }) }
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
          const p = await personaConfig()
          const s = await loadPersonaState()
          personaInfo = { name: p.name, diceCount: s.diceCount, flipped: s.flipped, mood: s.mood, flipAfter: flipThreshold() }
        } catch { /* 同上 */ }
        /* 插话：客户端每次 ping 顺带取一句。取不到就是 null，正常情况。 */
        let chatter = null
        try {
          chatter = takeChatter()
        } catch { /* 同上 */ }
        /* 本地内容开关：哪些事件走本地库。客户端设置面板据此渲染勾选框。 */
        let localOnly = []
        try {
          localOnly = [...(await localOnlyConfig())]
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
            localOnly,
            events: events.map((e) => ({
              id: e.id,
              title: e.title,
              weight: e.weight,
              kind: e.kind ?? 'agent',
              visual: e.visual?.kind ?? null,
              /* 这条事件有没有本地库可替代 AI。没有的话设置里不给勾选框。 */
              local: Array.isArray(e.local?.kinds) && e.local.kinds.length > 0,
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
        let localOnly = []
        try {
          localOnly = [...(await localOnlyConfig())]
        } catch { /* 读不到就当全关 */ }
        return {
          ok: true,
          value: {
            configPath: file,
            /* 只有带本地库的事件才出现在这里 —— 面板不会给出无效的勾选框。 */
            localizable: events
              .filter((e) => Array.isArray(e.local?.kinds) && e.local.kinds.length > 0)
              .map((e) => ({ id: e.id, title: e.title, kind: e.kind ?? 'agent' })),
            localOnly,
            model: await modelConfig().catch(() => null),
            /* 挖掘音效开关。默认**开**（音效是这个方块的核心手感之一），
               只有显式写成 false 才关。用 `!== false` 而不是 `=== true`：
               老配置文件里没有这个字段，应该表现为默认开。 */
            sound: raw.sound !== false,
            config: raw,
          },
        }
      },

      /**
       * 写设置。目前开放 `localOnly`（是否调用 AI 的开关）与 `sound`（挖掘音效）。
       *
       * 采用**读-改-写**而不是整份覆盖：config.json 里还有用户手写的
       * model / persona 配置，整份覆盖会把它们抹掉。
       */
      async saveSettings(patch) {
        const file = path.join(stateDir(), CONFIG_FILE)
        const raw = (await readJson(file, null)) ?? {}
        if (patch && Array.isArray(patch.localOnly)) {
          const capable = new Set(
            events.filter((e) => Array.isArray(e.local?.kinds) && e.local.kinds.length > 0).map((e) => e.id),
          )
          // 过滤掉不支持本地化的事件，避免把无效配置写进文件。
          raw.localOnly = patch.localOnly.map((s) => String(s)).filter((id) => capable.has(id))
        }
        // 只认布尔值：客户端传 `"false"` 这种字符串时不理它，免得把配置写坏。
        if (patch && typeof patch.sound === 'boolean') {
          raw.sound = patch.sound
        }
        await writeJson(file, raw)
        return {
          ok: true,
          value: {
            configPath: file,
            localOnly: [...(await localOnlyConfig())],
            sound: raw.sound !== false,
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
            const result = await luckyRemote.roll()
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