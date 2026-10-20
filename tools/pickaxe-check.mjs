// 木镐耐久的边界测试（用户 m19780：不是每次挖穿都要响「镐子碎了」）。
//
// 为什么要单独测这一条：它是插件里唯一一个**跨会话累计**的计数器，而且是
// off-by-one 的经典地形 —— 「第 59 下坏」和「第 60 下坏」都读得通，写错了
// 不会有任何报错，只会让那把镐子永远用不坏（或者每两下就坏一次）。
// 人耳听不出来，只能靠断言。
//
// 做法与 escape-check / konami-check 一致：从 lib/client.js 里把真代码抠出来，
// 用 new Function 跑，而不是复制一份实现 —— 复制的副本会和真代码各自演化。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
function check(ok, label, detail) {
  if (typeof ok !== 'boolean') {
    console.error(`  BAD   check() 的第一个参数必须是布尔，收到 ${typeof ok}（标签：${label}）`)
    fail += 1
    return
  }
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}`)
  }
}

/* ---------------- 抽取真代码 ---------------- */

const durMatch = /var PICKAXE_DURABILITY = (\d+)/.exec(source)
check(durMatch !== null, '抽到了 PICKAXE_DURABILITY 常量')
if (!durMatch) {
  process.exit(1)
}

const fnStart = source.indexOf('function wearPickaxe(used) {')
check(fnStart >= 0, '抽到了 wearPickaxe 函数')
if (fnStart < 0) {
  process.exit(1)
}
/* 结束位置：函数体是 4 空格缩进，收尾那行是 2 空格 + `}`。
   注意 `'\n  }'` 只有 4 个字符，`+ 4` 才把 `}` 收进来；写成 `+ 3` 会得到一个
   少了右括号的函数体，报的错是 `Unexpected token ')'`（看起来像 new Function 坏了）。 */
const fnEnd = source.indexOf('\n  }', fnStart) + 4
const fnSource = source.slice(fnStart, fnEnd)

const wear = new Function(
  `var PICKAXE_DURABILITY = ${durMatch[1]};\n${fnSource}\nreturn wearPickaxe`,
)()

/* ---------------- 常量本身 ---------------- */

check(
  Number(durMatch[1]) === 59,
  '耐久是 Java 版的 59（不是基岩版的 60）',
  `实际 ${durMatch[1]}`,
)

/* ---------------- 计数推进 ---------------- */
// 模拟连挖一整套：从 0 开始挖 59 下，只在最后一下报 broke。
let used = 0
let breaks = 0
let firstBreakAt = 0
for (let i = 1; i <= 59; i += 1) {
  const out = wear(used)
  used = out.used
  if (out.broke) {
    breaks += 1
    if (firstBreakAt === 0) firstBreakAt = i
  }
}
check(breaks === 1, '连挖 59 下只坏一次', `实际 ${breaks} 次`)
check(firstBreakAt === 59, '第 59 下才坏（不是第 58 下也不是第 60 下）', `实际第 ${firstBreakAt} 下`)
check(used === 0, '坏掉之后耐久归零', `实际 ${used}`)

/* 坏掉那一下不能把计数留在 59 或变成 60 —— 归零必须是「新镐子」而不是「负一点」。 */
const rightAfter = wear(0)
check(rightAfter.broke === false && rightAfter.used === 1, '换新镐子后第一下不算坏', JSON.stringify(rightAfter))

/* ---------------- 第二把镐子 ---------------- */
// 换新镐子之后还得再挖 59 下才坏第二次：不能因为「刚坏过」就永久免疫。
let second = 0
let secondBreakAt = 0
let secondUsed = 0
for (let i = 1; i <= 59; i += 1) {
  const out = wear(secondUsed)
  secondUsed = out.used
  if (out.broke) {
    second += 1
    if (secondBreakAt === 0) secondBreakAt = i
  }
}
check(second === 1 && secondBreakAt === 59, '第二把镐子同样是第 59 下坏', `坏 ${second} 次，第 ${secondBreakAt} 下`)

/* ---------------- 脏输入 ---------------- */
// localStorage 里的东西可能是任何字符串（用户手改过、别的版本写过、隐私模式下读出来是 null）。
// 这些都不该让镐子变成「永不磨损」或者「每下都坏」。
/* 58.9 不放进这一组：它不是脏数据，而是「快坏了的镐子」。
   取整成 58 再加一正好到 59，本来就该坏 —— 它在下面单独钉住。 */
const dirty = [
  [null, 'null'],
  [undefined, 'undefined'],
  [NaN, 'NaN'],
  [-5, '-5'],
  ['abc', "'abc'"],
  [Infinity, 'Infinity'],
]
for (const [value, label] of dirty) {
  const out = wear(value)
  check(
    out.broke === false && out.used >= 1 && out.used <= 59,
    `脏输入 ${label} 被当成一次正常磨损`,
    JSON.stringify(out),
  )
}

/* 58.9 抹平之后是 58，加一是 59 → 应当坏。这条单独钉住「小数先取整再加」。 */
const floatOut = wear(58.9)
check(floatOut.broke === true, '58.9 取整成 58 之后再加一，正好坏', JSON.stringify(floatOut))

/* ---------------- 存储键 ---------------- */
// 键名与外观键不同：改方块大小时不该顺手把镐子修好。
const lsKeyMatch = /var LS_DURABILITY = '([^']+)'/.exec(source)
check(lsKeyMatch !== null, '抽到了 LS_DURABILITY 键名')
check(
  lsKeyMatch !== null && lsKeyMatch[1] !== 'dshLuckyBlock.block',
  '耐久键与外观键（dshLuckyBlock.block）分开',
  `实际 ${lsKeyMatch && lsKeyMatch[1]}`,
)

/* ---------------- 与音效的接线 ---------------- */
// 光有计数不算数：坏了要真的响，不坏就不能响。这两句是「实现」而不是「数据」，
// 所以按源码匹配而不是跑函数 —— 跑函数需要整个音频引擎。
check(
  /if \(axe\.broke\) soundRef\.current\.playItemBreak\(\)/.test(source),
  '耐久耗尽时才播镐子碎裂声（受 axe.broke 守卫）',
)
check(
  /soundRef\.current\.playBreak\(\)\n\s*\/\* 耐久耗尽/.test(source) ||
    /playBreak\(\)[\s\S]{0,600}if \(axe\.broke\) soundRef\.current\.playItemBreak\(\)/.test(source),
  '方块碎裂声每次都有（playBreak 不在 broke 守卫里）',
)
check(
  !/if \(axe\.broke\) soundRef\.current\.playBreak\(\)/.test(source),
  'playBreak 没有被错写进 broke 守卫里',
)

/* ---------------- 音效分组不串台 ---------------- */
// 这条守的是本段改动的**原始动机**：playBreak 原来播的就是 break.ogg（= 镐子报废声），
// 只要有人把分组改回去，「每次挖穿都响镐子碎裂」就悄悄回来了，且不会触发其它测试。
const groupBlock = /block: \[([^\]]*)\]/.exec(source)
const groupItem = /item: \[([^\]]*)\]/.exec(source)
check(groupBlock !== null && groupItem !== null, '抽到了 block / item 两个音效分组')
check(
  groupBlock !== null && !/break\.ogg/.test(groupBlock[1]) && /glass/.test(groupBlock[1]),
  '方块碎裂组用的是 glass*.ogg，不是 break.ogg',
  `实际 ${groupBlock && groupBlock[1].trim()}`,
)
check(
  groupItem !== null && /break\.ogg/.test(groupItem[1]),
  '镐子报废组才是 break.ogg',
  `实际 ${groupItem && groupItem[1].trim()}`,
)

const breakBody = /playBreak: function \(\) \{([\s\S]*?)\n      \}/.exec(source)
check(breakBody !== null, '抽到了 playBreak 函数体')
check(
  breakBody !== null && /pickSound\('block'/.test(breakBody[1]),
  'playBreak 播的是 block 组',
  breakBody ? breakBody[1].trim() : '',
)

console.log('')
if (fail > 0) {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exit(1)
}
console.log(`ALL GREEN  pass=${pass} fail=${fail}`)
