/**
 * lib/persona.js 的单元测试。
 *
 * 为什么要单独测：人格层是「单一来源」，所有事件共用它。它一旦退化
 * （比如用户配置把 traits 顶掉、或者翻转态拿错字段），是**八个事件一起走样**，
 * 而且不会报错 —— prompt 照样发给模型，只是腔调不对。这类静默退化必须靠测试钉住。
 *
 * 本文件直接 import 真模块（不抽源码、不复制），因为 persona.js 是纯函数、
 * 无宿主依赖，可以真测。
 *
 * 用法：node tools/persona-check.mjs
 */

import {
  DEFAULT_PERSONA,
  mergePersona,
  buildPersonaBlock,
  wrapWithPersona,
  buildOutroRequest,
} from '../lib/persona.js'

let fail = 0
let pass = 0
function check(ok, label, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) } else { fail += 1; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`) }
}

/**
 * 生成物里**不准出现专名**。
 *
 * 这条守卫不写死任何具体名字 —— 把名字写进断言等于把名字留在代码里，
 * 而要求是「整个项目不出现它」。所以改判「有没有专名的形状」：
 * 角色设定标签只能是 `［角色设定］`，一旦变成
 * `［角色设定 — 你现在的身份是「X」］` 就说明有人又把名字挂回去了。
 * 另外拦掉书名号引用、以及「叫做/名叫」这类起名句式。
 *
 * `[^\]]` 必须限制在**同一行**内（用 `[^\]\n]`），否则它会跨到正文里的
 * 「你称呼对方为「用户」」上，把正常 prompt 判成有专名 —— 踩过。
 */
function hasProperName(text) {
  return [
    /角色设定[^\]\n]*[「『"]/,   // 标签里挂了引号名（限同行）
    /《[^》]{1,20}》/,            // 作品名
    /(叫做|名叫|名字叫|译名)/,     // 起名句式
    /\b[A-Z][a-z]{3,}\b/,         // 拉丁文人名/品牌名（如艺人、厂商）
  ].some((re) => re.test(text))
}

/**
 * 有没有**断言式**地说出制造商信息。
 *
 * 直接匹配「制造商」会命中 prompt 里那句**指令**「不要给自己编造制造商」——
 * 那是要求本身，不是泄漏，属于误报（踩过）。所以先看命中点前面有没有
 * 否定词，有就算讲规矩、不算泄漏。
 */
function claimsManufacturer(text) {
  const re = /(制造商|出厂|生产商|由[^。\n]{0,6}公司制造)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 14), m.index)
    if (!/(不要|不得|别|禁止|不许|不能|没有|未)/.test(before)) return true
  }
  return false
}

console.log('— 默认人格的基本形状 —')
check(!('name' in DEFAULT_PERSONA), '默认人格没有 name 字段（用户要求 prompt 不出现角色名）')
check(Array.isArray(DEFAULT_PERSONA.traits) && DEFAULT_PERSONA.traits.length > 0, '有 traits')
check(Array.isArray(DEFAULT_PERSONA.flippedTraits) && DEFAULT_PERSONA.flippedTraits.length > 0, '有 flippedTraits')
check(DEFAULT_PERSONA.address === '用户', '称呼固定为「用户」')
check(typeof DEFAULT_PERSONA.identity === 'string' && DEFAULT_PERSONA.identity.length > 0, '有身份描述')

console.log('\n— 红线：默认人格里不能出现的东西 —')
const defaultDump = JSON.stringify(DEFAULT_PERSONA)
check(!claimsManufacturer(defaultDump), '不含编造的制造商信息')
check(!/求求|不要把我|别把我/.test(defaultDump), '不含哀求桥段（与「把人当工单」的设定矛盾）')
check(!/bum bum be-dum|哼歌|哼一小段/.test(defaultDump), '不含唱歌元素（用户要求删掉）')
const otherSongs = /Imagine|Bohemian|Yesterday|Never Gonna/
check(!otherSongs.test(defaultDump), '没编造别的歌')
check(!hasProperName(defaultDump), '默认人格里没有任何专名')
check(!/枪|武器|干掉目标|道德负担/.test(defaultDump), '不含「武器」设定（用户要求删掉）')

console.log('\n— mergePersona：坏输入一律退化到默认，不抛错 —')
for (const bad of [null, undefined, 0, '', 'x', [], 123, true, { traits: 'not-array' }, { name: 42 }]) {
  const m = mergePersona(bad)
  check(m.traits.length > 0 && m.address === '用户', `坏配置 ${JSON.stringify(bad)} → 默认人格`)
}
check(mergePersona({ traits: [] }).traits.length > 0, '空数组 traits 不覆盖（否则人格会变空）')
check(mergePersona({ traits: ['  ', ''] }).traits.length > 0, '全空白 traits 不覆盖')

console.log('\n— mergePersona：name 是「接受但不使用」的兼容字段 —')
check(mergePersona({ name: '小方块' }).name === '小方块', '老配置写 name 不报错')
check(!buildPersonaBlock(mergePersona({ name: '小方块' })).includes('小方块'), '但 name 永远不进 prompt')

console.log('\n— mergePersona：正常覆盖是整段替换 —')
const custom = mergePersona({ traits: ['只说你爱听的。'] })
check(custom.traits.length === 1 && custom.traits[0] === '只说你爱听的。', 'traits 整段替换而非追加', `得到 ${custom.traits.length} 条`)
check(custom.flippedTraits.length === DEFAULT_PERSONA.flippedTraits.length, '未覆盖的字段保留默认')

console.log('\n— mergePersona：不在白名单里的键一律忽略 —')
const sneaky = mergePersona({ evil: 'rm -rf /', __proto__: { polluted: true }, constructor: 'x' })
check(!('evil' in sneaky), '未知键被忽略')
check(sneaky.constructor === Object, 'constructor 没被改写')
check({}.polluted === undefined, '没有原型污染')

console.log('\n— buildPersonaBlock：默认态 —')
const block = buildPersonaBlock(DEFAULT_PERSONA)
check(block.includes('［角色设定］'), '有角色设定标签')
check(!hasProperName(block), 'prompt 不出现任何专名')
check(block.includes('用户'), '含称呼')
check(block.includes(DEFAULT_PERSONA.traits[0]), '第一条 traits 进了 prompt')
check(block.includes('说话方式：'), '有说话方式小节')
check(block.includes('硬性要求：'), '有硬性要求小节')
check(!block.includes('礼貌模式'), '默认态不提「礼貌模式」')
check(!block.includes('坏用户'), '默认态不提「坏用户」')

console.log('\n— buildPersonaBlock：翻转态 —')
const flipped = buildPersonaBlock(DEFAULT_PERSONA, { flipped: true })
check(flipped.includes('礼貌模式'), '翻转态用 flippedTraits')
check(!flipped.includes(DEFAULT_PERSONA.traits[0]), '翻转态不再含默认狠话')
check(!hasProperName(flipped), '翻转态同样不含专名')
console.log('\n— buildPersonaBlock：坏用户态 —')
const bad = buildPersonaBlock(DEFAULT_PERSONA, { mood: 'bad' })
check(bad.includes('坏用户'), '坏用户态有标记')
check(bad.includes('坏蛋用户'), '坏用户态给出退化台词')
check(bad.includes(DEFAULT_PERSONA.traits[0]), '坏用户态仍保留基础人格段')

console.log('\n— buildPersonaBlock：翻转 + 坏用户同时成立 —')
const both = buildPersonaBlock(DEFAULT_PERSONA, { flipped: true, mood: 'bad' })
check(both.includes('礼貌模式') && both.includes('坏用户'), '两个状态可叠加')

console.log('\n— buildPersonaBlock：自定义人格无 flippedTraits 时回退 —')
const noFlip = { ...DEFAULT_PERSONA, flippedTraits: undefined }
check(buildPersonaBlock(noFlip, { flipped: true }).includes(DEFAULT_PERSONA.traits[0]), 'flippedTraits 缺失时回退到 traits，不崩')

console.log('\n— buildPersonaBlock：入参缺失也不崩 —')
for (const arg of [undefined, null, {}, { traits: [] }]) {
  const out = buildPersonaBlock(arg)
  check(typeof out === 'string' && out.length > 0, `buildPersonaBlock(${JSON.stringify(arg)}) 返回非空串`)
}

console.log('\n— wrapWithPersona：任务正文必须原样保留 —')
const TASK = '随机冷笑话任务：给「看完了才发现是上集」写一句广告语。\n要求：\n- 必须押韵。\n落盘到 lucky-block-jokes/abc.md'
const wrapped = wrapWithPersona(DEFAULT_PERSONA, { title: '冷笑话专场', body: TASK })
check(wrapped.includes(TASK), '任务正文逐字保留（含换行）')
check(wrapped.includes('冷笑话专场'), '标题进了开场白')
check(wrapped.includes('以下是本次要做的事'), '有任务分隔标记')
check(wrapped.indexOf('说话方式：') < wrapped.indexOf(TASK), '人格段在任务之前')
check(!hasProperName(wrapped), '开场白不含专名')
console.log('\n— wrapWithPersona：翻转态开场白换腔调 —')
const wrappedFlipped = wrapWithPersona(DEFAULT_PERSONA, { title: '冷笑话专场', body: TASK, state: { flipped: true } })
check(wrappedFlipped.includes(TASK), '翻转态同样逐字保留任务正文')
check(wrappedFlipped.includes('请稍候') || wrappedFlipped.includes('抱歉'), '翻转态开场白是礼貌腔')
check(!wrappedFlipped.includes('你就坐着别动'), '翻转态不用默认腔的开场白')

console.log('\n— buildOutroRequest —')
const outro = buildOutroRequest(DEFAULT_PERSONA, { title: 'x' })
check(!hasProperName(outro), '点评请求不含专名')
check(outro.includes('不要重新执行任务'), '点评请求禁止重跑任务')
const outroBad = buildOutroRequest(DEFAULT_PERSONA, { title: 'x', state: { mood: 'bad' } })
check(outroBad.includes('坏蛋用户'), '坏用户态只让它喊这句')
check(!outroBad.includes('不要重新执行任务'), '坏用户态不再给正常点评指令')

console.log('\n— 端到端：所有产出都不含专名与编造内容 —')
const allOutputs = [
  buildPersonaBlock(DEFAULT_PERSONA),
  buildPersonaBlock(DEFAULT_PERSONA, { flipped: true }),
  buildPersonaBlock(DEFAULT_PERSONA, { mood: 'bad' }),
  wrapWithPersona(DEFAULT_PERSONA, { title: 't', body: 'b' }),
  buildOutroRequest(DEFAULT_PERSONA, { title: 't' }),
].join('\n')
check(!hasProperName(allOutputs), '所有产出都不含任何专名')
check(!claimsManufacturer(allOutputs), '所有产出都不含编造制造商信息')
check(allOutputs.includes('［角色设定］'), '所有产出都带角色设定标签')

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
