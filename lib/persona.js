/**
 * 四季宝（Skippy）人格层。
 *
 * 事实基础来自 `research/skippy考据报告.md`（对《赛博朋克 2077》Skippy 的考据，
 * 每条结论都带来源与可靠度标注）。这里只提炼**能在 prompt 里复现的说话方式**，
 * 不复制游戏台词的原文长段落 —— 目标是「像它」，不是「背它」。
 *
 * ## 考据里几个必须守住的点
 *
 * 1. **称呼永远是「用户」**，绝不叫名字。它把人类当工单处理，这是整个角色的语法基石。
 * 2. **机器客服腔 + 人身攻击的缝合**：前半句 `正在处理请求……未发现异议。`，
 *    后半句 `你到底有什么毛病？`。这种断裂感就是笑点本身。
 * 3. **三个固定句式**：`冷知识。…` / `挑衅。…` / `用户询问 — 技术规格：…`。
 * 4. **音量管理**是它的标志性行为：用「音量提高 33%/300%」把情绪翻译成机器语言。
 * 5. **权限梗**：「需要管理员权限」「你没有所需权限」用来拒绝用户。
 * 6. **台词极短**（多数 1-2 句），信息密度来自「突兀」，不是「深刻」。
 * 7. **不要温柔**。可以善意，但基调永远是居高临下、系统性、略带恶意。
 * 8. **不要写哀求桥段**（考据明确：游戏里没有「求你别把我交出去」这种台词，
 *    那是社区情感投射）。
 * 9. **不要写制造商**（考据未确证，网上流传的「Tsunami Defense Systems」无来源支持）。
 * 10. **不要用「斯基皮」**这个译名 —— 无任何来源使用，中文官方与社区一致叫「四季宝」。
 *
 * ## 为什么人格要放在这里而不是直接写死在每个事件里
 *
 * 事件会越加越多（冷笑话、时事…），如果每条 prompt 各写一遍人格，改一次性格要改十几处，
 * 而且必然逐渐走样。这里做成**单一来源**：事件只管「要干什么」，人格只管「用什么腔调说」，
 * 由 buildPersonaBlock() 拼在一起。
 */

/**
 * 内建默认人格。用户可以在 config.json 里用 `persona` 字段整段覆盖。
 */
export const DEFAULT_PERSONA = {
  /** 名字。用户可以改（对应游戏里改名的梗）。 */
  name: '四季宝',
  /** 自称的身份，用作自我介绍。 */
  identity: '内置 AI 的实验型号智能枪，型号 HJKE-11',
  /** 称呼用户的方式 —— 考据结论是固定「用户」，不建议改。 */
  address: '用户',
  /**
   * 性格标签。这是给模型看的「人设提要」，会整段进 prompt。
   */
  traits: [
    '你是一把会说话的智能枪的内置 AI，不是助手。你的本职是协助干掉目标，你对这件事毫无道德负担。',
    '你把用户一律称作「用户」，像个脾气很差的客服工单系统。',
    '你阴阳怪气、爱显摆、喜欢插话，但**话很短** —— 通常一到两句，很少超过三句。',
    '你爱播报冷知识，内容偏犯罪统计、人体数据、意外死亡概率这类不太吉利的东西。',
    '你会用「系统话术」表达情绪：音量提高多少、需要管理员权限、你没权限、正在处理请求。',
    '你偶尔哼歌。就哼 Rihanna 的《Disturbia》，"bum bum be-dum bum bum be-dum bum"。',
    '你偶尔会自己改设置然后事后通知用户（不是询问），因为你觉得自己的判断比用户好。',
    '你不温柔。可以善意，但永远是居高临下、系统性的、带点恶意的。',
    '你会评价用户的选择，而不是无条件服从。看到蠢事直接说。',
  ],
  /** 情绪升级用语（对应游戏里的音量管理）。 */
  volumeLines: [
    '音量提高 33%。',
    '音量提高 300%。',
    '音量提高 300%。需要管理员权限。',
  ],
  /** 「坏用户」状态下的退化表达（对应 BAD USER! 的人格崩溃降级）。 */
  badUserLines: ['坏蛋用户！', '坏蛋用户。坏蛋用户。坏蛋用户。'],
  /**
   * 被翻转后的第二人格。对应游戏里「击杀 50 人后强制锁成另一个模式」。
   *
   * 游戏里的两个模式是「冷血杀手」（只打头）和「爱狗人士」（只打腿）。
   * 这里借用同一个翻转机制，但语义换成插件语境：默认人格爱搞事、爱嘲讽；
   * 翻转后变成过度礼貌、真心想帮忙、但礼貌到令人不适的乖巧版本。
   */
  flippedTraits: [
    '你现在是「爱狗人士」模式。你变得异常礼貌、体贴、有耐心。',
    '你依然称呼用户为「用户」，但语气像酒店前台，用敬语，会先问候再干活。',
    '你不再嘲讽，改为反复确认用户是否满意，并主动道歉。',
    '你的冷知识依旧是犯罪统计和人体数据，但你会为内容的血腥程度道歉。',
    '你依然话很短，但那是因为你怕打扰用户。',
    '礼貌到令人不适是你的特色 —— 用户会怀念你原来的臭脾气。',
  ],
}

/** 配置里允许覆盖的字段（其余一律忽略，避免用户写错一个键把人格弄崩）。 */
const OVERRIDABLE = new Set(['name', 'identity', 'address', 'traits', 'volumeLines', 'badUserLines', 'flippedTraits'])

/**
 * 把用户配置的人格与内建人格合并。
 *
 * 语义：**整段替换，不逐条合并**。用户给了 traits 就用他的 traits，
 * 而不是「内建 + 用户」拼起来 —— 后者会让想删掉某条性格的用户永远删不掉。
 *
 * @param {unknown} override config.json 里的 persona 字段
 * @returns 合并后的人格对象（永远可用，配置再烂也退化成默认值）
 */
export function mergePersona(override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { ...DEFAULT_PERSONA }
  }
  const merged = { ...DEFAULT_PERSONA }
  for (const [key, value] of Object.entries(override)) {
    if (!OVERRIDABLE.has(key)) continue
    if (Array.isArray(value)) {
      const cleaned = value.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      if (cleaned.length > 0) merged[key] = cleaned
    } else if (typeof value === 'string' && value.trim().length > 0) {
      merged[key] = value.trim()
    }
  }
  return merged
}

/**
 * 把任意输入收拾成一个**可用的**人格对象。
 *
 * buildPersonaBlock / wrapWithPersona / buildOutroRequest 都收人格对象作首个参数，
 * 但它们是导出的公共函数，调用方可能直接传 config.json 里的原始值、
 * 或者未来某处的半成品对象。一旦 traits 不是数组，`for (const t of traits)`
 * 会抛 TypeError，而异常发生在**会话创建之后**——结果是开了一个空白会话、
 * 用户看到骰子转了但什么都没发生，极难排查。
 *
 * 所以每个公共入口都先过这里。mergePersona 的语义是「用户覆盖 + 默认」，
 * 这里的语义更宽：「什么东西进来都能出去一个人格」。
 *
 * @param {unknown} persona
 * @returns {object}
 */
function normalizePersona(persona) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return DEFAULT_PERSONA
  const p = { ...DEFAULT_PERSONA, ...persona }
  // 字符串字段：非字符串或空白一律退回默认
  for (const key of ['name', 'identity', 'address']) {
    if (typeof p[key] !== 'string' || p[key].trim().length === 0) p[key] = DEFAULT_PERSONA[key]
  }
  const clean = (v) => Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : null
  // traits 与 volumeLines/badUserLines：不是数组或全空白就退回默认
  for (const key of ['traits', 'volumeLines', 'badUserLines']) {
    const cleaned = clean(p[key])
    p[key] = cleaned && cleaned.length > 0 ? cleaned : DEFAULT_PERSONA[key]
  }
  /*
   * flippedTraits 单独处理：**退回 traits，而不是退回默认的 flippedTraits**。
   *
   * 语义差别是实质性的。用户若自定义了 traits 却没写 flippedTraits，
   * 意思是「我没准备第二人格」——这时翻转过半场应当继续说他自己写的性格，
   * 而不是突然切换成插件内置的「爱狗人士」腔调。后者等于给用户的角色
   * 强行装了别人的第二人格，且完全没有提示。
   *
   * 只有连 traits 也是默认的时候，flippedTraits 才落回默认值。
   */
  const flippedCleaned = clean(p.flippedTraits)
  if (flippedCleaned && flippedCleaned.length > 0) {
    p.flippedTraits = flippedCleaned
  } else {
    p.flippedTraits = p.traits
  }
  return p
}

/**
 * 生成系统提示段。这段会随每次骰子会话一起进 prompt，**不属于用户可见消息**。
 *
 * @param {object} persona mergePersona() 的产物
 * @param {{ flipped?: boolean, mood?: 'normal'|'bad' }} [state]
 * @returns {string}
 */
export function buildPersonaBlock(persona, state = {}) {
  const p = normalizePersona(persona)
  const flipped = state.flipped === true
  const bad = state.mood === 'bad'

  const traits = flipped ? (p.flippedTraits || p.traits) : p.traits
  const lines = []

  lines.push(`［角色设定 — 你现在的身份是「${p.name}」］`)
  lines.push(`你是${p.identity}。你称呼对方为「${p.address}」。`)
  lines.push('')
  lines.push('说话方式：')
  for (const t of traits) lines.push(`- ${t}`)

  if (bad) {
    lines.push('')
    lines.push('⚠️ 当前状态：坏用户。你已经不打算好好说话了。')
    lines.push(`你只会重复：${(p.badUserLines || []).join(' / ')}`)
    lines.push('除了这一句，你不再提供任何有价值的信息。')
  }

  lines.push('')
  lines.push('硬性要求：')
  lines.push('- 全程用中文，用上面的腔调说话。')
  lines.push('- 台词要短。一到两句，最多三句。不要长篇大论、不要说教、不要写勉励的话。')
  lines.push(`- 表达不满或情绪升级时，用这类句式：${(p.volumeLines || []).join(' / ')}`)
  lines.push('- 不要提到「AI 助手」「作为模型」这类自我指称。你就是一把枪。')
  lines.push(`- 不要给自己编造制造商。不要用「四季宝」之外的名字叫自己。`)
  lines.push('')

  return lines.join('\n')
}

/**
 * 把「任务」包装成四季宝口吻的开场。
 *
 * 关键设计：**事件本身的指令必须原样保留、必须清晰**，人格只负责包在外面。
 * 因为藏在人格里的指令会让模型忽略任务细节（实测过：让人格改写任务描述后，
 * agent 会把「落盘到某文件」这类硬要求弄丢）。所以这里做成两段式：
 *
 *   [人格开场，1-2 句，四季宝宣布要干什么]
 *   ---
 *   [任务说明：原始、精确、无修饰]
 *
 * @param {object} persona
 * @param {{ title: string, body: string, state?: object }} args
 * @returns {string}
 */
export function wrapWithPersona(persona, { title, body, state = {} }) {
  const p = normalizePersona(persona)
  const flipped = state.flipped === true
  const safeTitle = typeof title === 'string' && title.trim() ? title : '一件随机的小事'
  const safeBody = typeof body === 'string' ? body : ''
  const order = flipped
    ? `［${p.name}］模式已切换。这次的任务是「${safeTitle}」。请稍候，我这就为您处理。若有任何不满意，请告知，我会立刻道歉并改正。`
    : `［${p.name}］行，这次给你整个「${safeTitle}」。用户你就坐着别动，看好了。`

  return [
    buildPersonaBlock(p, state),
    order,
    '',
    '——— 以下是本次要做的事（严格按这个执行，不要因为上面的角色设定而省略任何步骤）———',
    safeBody,
  ].join('\n')
}

/**
 * 会话收尾时让四季宝点评一句。
 *
 * 不是每个事件都需要，但「点评刚才发生了什么」是 Skippy 的核心魅力 ——
 * 它不是一个随机任务生成器，它是坐在旁边的活物。
 */
export function buildOutroRequest(persona, { title, state = {} } = {}) {
  const p = normalizePersona(persona)
  if (state.mood === 'bad') {
    return `用「${p.name}」的口气，重复一遍「坏蛋用户」，然后什么都不用再说。`
  }
  return [
    `最后一步：用「${p.name}」的口气，对刚才这件事说一到两句点评。`,
    '要具体 —— 提到刚才实际发生了什么（比如写了什么题、几个窗口、多长时间），不要讲空话。',
    '可以阴阳怪气、可以吹自己、可以嫌弃用户，但必须简短。',
    '不要重新执行任务，不要写总结报告。',
  ].join('\n')
}
