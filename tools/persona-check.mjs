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

console.log('— 默认人格的基本形状 —')
check(DEFAULT_PERSONA.name === '四季宝', '名字是「四季宝」')
check(Array.isArray(DEFAULT_PERSONA.traits) && DEFAULT_PERSONA.traits.length > 0, '有 traits')
check(Array.isArray(DEFAULT_PERSONA.flippedTraits) && DEFAULT_PERSONA.flippedTraits.length > 0, '有 flippedTraits')
check(DEFAULT_PERSONA.address === '用户', '称呼固定为「用户」')

console.log('\n— 考据红线：默认人格里不能出现的东西 —')
const defaultDump = JSON.stringify(DEFAULT_PERSONA)
check(!defaultDump.includes('斯基皮'), '不含无来源译名「斯基皮」')
check(!/Tsunami|Defense Systems|Militech/i.test(defaultDump), '不含未确证的制造商名')
check(!/求求|不要把我|别把我/.test(defaultDump), '不含哀求桥段（社区情感投射）')
check(!/Disturbia/.test(defaultDump) || /bum bum be-dum/.test(defaultDump), '哼歌只允许《Disturbia》那句')
const otherSongs = /Imagine|Bohemian|Yesterday|Never Gonna/
check(!otherSongs.test(defaultDump), '没编造别的歌')

console.log('\n— mergePersona：坏输入一律退化到默认，不抛错 —')
for (const bad of [null, undefined, 0, '', 'x', [], 123, true, { traits: 'not-array' }, { name: 42 }]) {
  const m = mergePersona(bad)
  check(m.name === '四季宝' && m.traits.length > 0, `坏配置 ${JSON.stringify(bad)} → 默认人格`)
}
check(mergePersona({ traits: [] }).traits.length > 0, '空数组 traits 不覆盖（否则人格会变空）')
check(mergePersona({ traits: ['  ', ''] }).traits.length > 0, '全空白 traits 不覆盖')
check(mergePersona({ name: '   ' }).name === '四季宝', '全空白 name 不覆盖')

console.log('\n— mergePersona：正常覆盖是整段替换 —')
const custom = mergePersona({ name: '小方块', traits: ['只说你爱听的。'] })
check(custom.name === '小方块', 'name 可覆盖')
check(custom.traits.length === 1 && custom.traits[0] === '只说你爱听的。', 'traits 整段替换而非追加', `得到 ${custom.traits.length} 条`)
check(custom.flippedTraits.length === DEFAULT_PERSONA.flippedTraits.length, '未覆盖的字段保留默认')

console.log('\n— mergePersona：不在白名单里的键一律忽略 —')
const sneaky = mergePersona({ evil: 'rm -rf /', __proto__: { polluted: true }, constructor: 'x' })
check(!('evil' in sneaky), '未知键被忽略')
check(sneaky.constructor === Object, 'constructor 没被改写')
check({}.polluted === undefined, '没有原型污染')

console.log('\n— buildPersonaBlock：默认态 —')
const block = buildPersonaBlock(DEFAULT_PERSONA)
check(block.includes('四季宝'), '含角色名')
check(block.includes('用户'), '含称呼')
check(block.includes(DEFAULT_PERSONA.traits[0]), '第一条 traits 进了 prompt')
check(block.includes('说话方式：'), '有说话方式小节')
check(block.includes('硬性要求：'), '有硬性要求小节')
check(!block.includes('爱狗人士'), '默认态不提「爱狗人士」')
check(!block.includes('坏用户'), '默认态不提「坏用户」')

console.log('\n— buildPersonaBlock：翻转态 —')
const flipped = buildPersonaBlock(DEFAULT_PERSONA, { flipped: true })
check(flipped.includes('爱狗人士'), '翻转态用 flippedTraits')
check(!flipped.includes(DEFAULT_PERSONA.traits[0]), '翻转态不再含默认狠话')
check(flipped.includes('四季宝'), '翻转态仍自称四季宝')

console.log('\n— buildPersonaBlock：坏用户态 —')
const bad = buildPersonaBlock(DEFAULT_PERSONA, { mood: 'bad' })
check(bad.includes('坏用户'), '坏用户态有标记')
check(bad.includes('坏蛋用户'), '坏用户态给出退化台词')
check(bad.includes(DEFAULT_PERSONA.traits[0]), '坏用户态仍保留基础人格段')

console.log('\n— buildPersonaBlock：翻转 + 坏用户同时成立 —')
const both = buildPersonaBlock(DEFAULT_PERSONA, { flipped: true, mood: 'bad' })
check(both.includes('爱狗人士') && both.includes('坏用户'), '两个状态可叠加')

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
check(wrapped.includes('四季宝'), '开场白带角色名')

console.log('\n— wrapWithPersona：翻转态开场白换腔调 —')
const wrappedFlipped = wrapWithPersona(DEFAULT_PERSONA, { title: '冷笑话专场', body: TASK, state: { flipped: true } })
check(wrappedFlipped.includes(TASK), '翻转态同样逐字保留任务正文')
check(wrappedFlipped.includes('请稍候') || wrappedFlipped.includes('抱歉'), '翻转态开场白是礼貌腔')
check(!wrappedFlipped.includes('你就坐着别动'), '翻转态不用默认腔的开场白')

console.log('\n— buildOutroRequest —')
const outro = buildOutroRequest(DEFAULT_PERSONA, { title: 'x' })
check(outro.includes('四季宝'), '点评请求带角色名')
check(outro.includes('不要重新执行任务'), '点评请求禁止重跑任务')
const outroBad = buildOutroRequest(DEFAULT_PERSONA, { title: 'x', state: { mood: 'bad' } })
check(outroBad.includes('坏蛋用户'), '坏用户态只让它喊这句')
check(!outroBad.includes('不要重新执行任务'), '坏用户态不再给正常点评指令')

console.log('\n— 端到端：人格块里不出现未确证内容 —')
const allOutputs = [
  buildPersonaBlock(DEFAULT_PERSONA),
  buildPersonaBlock(DEFAULT_PERSONA, { flipped: true }),
  buildPersonaBlock(DEFAULT_PERSONA, { mood: 'bad' }),
  wrapWithPersona(DEFAULT_PERSONA, { title: 't', body: 'b' }),
  buildOutroRequest(DEFAULT_PERSONA, { title: 't' }),
].join('\n')
check(!allOutputs.includes('斯基皮'), '所有产出都不含「斯基皮」')
check(!/Tsunami Defense Systems/i.test(allOutputs), '所有产出都不含未确证制造商')
check(allOutputs.includes('四季宝'), '所有产出都自称四季宝')

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILED'}  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
