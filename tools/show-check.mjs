/**
 * 「同一时刻只播一场表演」的验证（用户 m18008 第 2 条）。
 *
 * 需求原文：上一个随机事件关闭前不能再点，除非 ESC 提前结束。
 *
 * 这套机制只有一个状态：`showRef`（正在播的表演数）。它出错的方式很少，
 * 但每一种都很难在界面上看出来：
 *   1. 计数漏减 → 方块永久点不动，用户只能重启
 *   2. 计数多减 → 演出还没结束就能再点，音乐和弹窗叠在一起
 *   3. 同一场被减两次 → 两条路同时来报收
 *
 * lib/client.js 是浏览器 bundle，不能 import，所以这里同样用「源码抽取」
 * 跑真代码。除纯函数级断言之外，另外几条是**静态**断言 —— 它们盯的是
 * 「四类表演是不是都接了收场信号」这种接线问题，靠跑是跑不出来的：
 * 漏接一路的表现是「那一类演出结束后方块还锁着」，只能靠真实点击复现。
 *
 * 用法：node tools/show-check.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/* ---------- 抽取 beginShow ---------- */

const beginMatch = source.match(/var beginShow = useCallback\(function \(\) \{[\s\S]*?\n    \}, \[\]\)/)
if (!beginMatch) {
  console.error('抽取失败：找不到 beginShow')
  process.exit(1)
}

const body = `
var showRef = { current: 0 }
var useCallback = function (fn) { return fn }
${beginMatch[0]}
return { beginShow: beginShow, showRef: showRef }
`
const api = new Function(body)()

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.error(`  FAIL  ${label} —— 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
  }
}

function checkTrue(label, actual) {
  check(label, actual === true, true)
}

/* ---- 1. 基本增减 ---- */

console.log('-- 开一场、收一场 --')
check('初始没有表演在播', api.showRef.current, 0)
const endA = api.beginShow()
check('开一场后计数是 1', api.showRef.current, 1)
endA()
check('收场后回到 0', api.showRef.current, 0)

/* ---- 2. 重复收场只算一次 ---- */

console.log('-- 同一场不会减两次 --')
const endB1 = api.beginShow()
const endB2 = api.beginShow()
check('两场同时播时计数是 2', api.showRef.current, 2)
endB1()
check('收掉一场还剩 1', api.showRef.current, 1)
endB1()
check('再收一次同一场还剩 1（幂等）', api.showRef.current, 1)
endB2()
check('两场都收完回到 0', api.showRef.current, 0)

/* ---- 3. 不会减成负数 ---- */

console.log('-- 计数不会被减成负数 --')
const endC = api.beginShow()
endC()
endC()
endC()
check('多叫几次仍是 0 而不是负数', api.showRef.current, 0)
checkTrue('计数没有变成负数', api.showRef.current >= 0)

/* ---- 4. 多次往返后仍能归零 ---- */

console.log('-- 反复使用后仍能归零 --')
const ends = []
for (let i = 0; i < 5; i += 1) ends.push(api.beginShow())
check('五场同时播', api.showRef.current, 5)
for (let i = 0; i < ends.length; i += 1) ends[i]()
check('全部收完归零', api.showRef.current, 0)

/* ---- 5. 阻塞判据写对了 ---- */

console.log('-- 点方块时的阻塞判据 --')
checkTrue(
  'onRoll 里有「已有表演就不开新的」的早退',
  /if \(showRef\.current > 0\) \{/.test(source),
)
checkTrue(
  '早退时给出提示而不是静默 return',
  /showRef\.current > 0\) \{\s*\n\s*say\(/.test(source),
)
checkTrue(
  '提示走会自动消失的台词气泡，不是要用户点掉的报错',
  !/showRef\.current > 0\) \{\s*\n\s*setError\(/.test(source),
)
checkTrue(
  '提示里告诉用户可以用 ESC 提前结束',
  /上一场还没收场[\s\S]{0,80}ESC/.test(source),
)

/* ---- 5b. 报错要说出「哪条事件」---- */
/* 用户报过「有个单击事件会冒出方块启动失败」，而十二个动效里挑一个是没法查的。
   宿主本来就给了 eventId，报错时带上它，复现一次就够。 */

console.log('-- 报错能定位到事件 --')
checkTrue(
  'value 在 try 之外声明（catch 里才看得见）',
  /var value = null\s*\n\s*try \{/.test(source),
)
checkTrue(
  '报错前先算出「出事的是谁」',
  /String\(value\.eventId \|\| \(value\.visual && value\.visual\.kind\) \|\| ''\)/.test(source),
)
checkTrue(
  '括号里带事件名，而不是只有「方块启动失败」',
  /'（' \+ where \+ '）'/.test(source),
)

/* ---- 6. 四类表演都接了收场信号（接线断言） ---- */

console.log('-- 四类表演都接了收场信号 --')
checkTrue('蓝屏演出接了收场', /var bluescreenEnd = beginShow\(\)/.test(source))
checkTrue('蓝屏把收场函数传给了 runBluescreen', /runBluescreen\([\s\S]{0,400}bluescreenEnd/.test(source))
checkTrue('弹窗演出接了收场', /var popupsEnd = beginShow\(\)/.test(source))
checkTrue('弹窗把收场函数传给了 runPopupShow', /runPopupShow\([\s\S]{0,200}popupsEnd/.test(source))
checkTrue('音乐接了收场', /var musicEnd = beginShow\(\)/.test(source))
checkTrue('音乐把收场函数传给了 playTrack', /playTrack\(value\.audio\.file, musicEnd[,)]/.test(source))
checkTrue('没起音轨时立刻收场', /else musicEnd\(\)/.test(source))
checkTrue('居中播报接了收场', /var textEnd = beginShow\(\)/.test(source))
checkTrue('居中播报把收场函数传给了 broadcastText', /broadcastText\(value\.localText, 30000, textEnd\)/.test(source))
/* 动效三兄弟（m19279）。它们比前几类更容易漏接 —— 因为「方块跑掉」「抖一下」
   看起来都是一瞬间的事，很容易觉得「不用收场吧」。但 beginShow 是按次计数的，
   开了不收，方块就永远停在「上一场还没收场」的状态里。 */
checkTrue('动效：方块跑掉接了收场', /var runawayEnd = beginShow\(\)/.test(source))
checkTrue('动效：方块跑掉把收场传给了 runRunaway', /runRunaway\([\s\S]{0,200}runawayEnd\)/.test(source))
checkTrue('动效：假光标接了收场', /var cursorEnd = beginShow\(\)/.test(source))
checkTrue('动效：假光标把收场传给了 runFakeCursor', /runFakeCursor\([\s\S]{0,200}cursorEnd\)/.test(source))
checkTrue('动效：屏幕抖接了收场', /var shakeEnd = beginShow\(\)/.test(source))
checkTrue('动效：屏幕抖把收场传给了 runShake', /runShake\([\s\S]{0,160}shakeEnd\)/.test(source))
/* 第二轮动效（m00160：停电 / 假警报 / 掀桌）。它们比前三个更容易漏接 ——
   前三个是「一瞬间的事」，一眼能看出演完了；这三个里停电有 8 秒、
   假警报中间还有一段什么都不发生的静默，很容易让人觉得「这么久应该不用管了」。
   但 beginShow 是按次计数的，漏接一样会把方块永久锁住。 */
checkTrue('动效：停电接了收场', /var blackoutEnd = beginShow\(\)/.test(source))
checkTrue('动效：停电把收场传给了 runBlackout', /runBlackout\([\s\S]{0,160}blackoutEnd\)/.test(source))
checkTrue('动效：假警报接了收场', /var alarmEnd = beginShow\(\)/.test(source))
checkTrue('动效：假警报把收场传给了 runFalseAlarm', /runFalseAlarm\([\s\S]{0,160}alarmEnd\)/.test(source))
checkTrue('动效：掀桌接了收场', /var flipEnd = beginShow\(\)/.test(source))
checkTrue('动效：掀桌把收场传给了 runTableFlip', /runTableFlip\([\s\S]{0,160}flipEnd\)/.test(source))
checkTrue('动效：黄油手接了收场', /var butterEnd = beginShow\(\)/.test(source))
checkTrue('动效：黄油手把收场传给了 runButterFingers', /runButterFingers\([\s\S]{0,160}butterEnd\)/.test(source))
/* 第三轮动效（m00793：彩虹 / 缩水 / 巨人 / 低重力）—— 四个事件、三个函数
   （缩水和巨人共用 runZoom，方向由 spec.factor 决定）。 */
checkTrue('动效：彩虹接了收场', /var raveEnd = beginShow\(\)/.test(source))
checkTrue('动效：彩虹把收场传给了 runRave', /runRave\([\s\S]{0,160}raveEnd\)/.test(source))
checkTrue('动效：缩放接了收场', /var zoomEnd = beginShow\(\)/.test(source))
checkTrue('动效：缩放把收场传给了 runZoom', /runZoom\([\s\S]{0,160}zoomEnd\)/.test(source))
checkTrue('动效：低重力接了收场', /var gravityEnd = beginShow\(\)/.test(source))
checkTrue('动效：低重力把收场传给了 runLowGravity', /runLowGravity\([\s\S]{0,160}gravityEnd\)/.test(source))
/* 停电会盖住整个屏幕，所以它必须**吃掉**点击（pointer-events:auto）。
   放点击穿透过去的话，用户会在看不见的界面上点到真的会后悔的按钮。 */
checkTrue('停电吃掉了点击（不是 click-through）', /function runBlackout\([\s\S]{0,600}'pointer-events:auto'/.test(source))
/* 三个动效函数自己也要能被 ESC 打断，并且**每条收场路径都要调 onDone**。
   `finish()` 是它们唯一的出口，所以这里断的是「finish 里有 onDone 且被登记过」。 */
for (const fnName of ['runRunaway', 'runFakeCursor', 'runShake', 'runBlackout', 'runFalseAlarm', 'runTableFlip', 'runButterFingers', 'runRave', 'runZoom', 'runLowGravity']) {
  const re = new RegExp(`function ${fnName}\\([\\s\\S]*?\\n  \\}`)
  const fnMatch = source.match(re)
  checkTrue(`动效 ${fnName} 抽得到`, Boolean(fnMatch))
  if (fnMatch) {
    const fnBody = fnMatch[0]
    checkTrue(`动效 ${fnName} 登记了 ESC 收场`, /registerEscape\(finish\)/.test(fnBody))
    checkTrue(`动效 ${fnName} 收场时调了 onDone`, /typeof onDone === 'function'\) onDone\(\)/.test(fnBody))
    checkTrue(`动效 ${fnName} 收场时撤了 ESC 登记`, /unregister\(\)/.test(fnBody))
  }
}
/* 每一个挂上去的动画类都必须有对应的 @keyframes。少一条不会报错 ——
   元素只是不动，而且只在抽中那条事件的那 0.3 秒里「什么都没发生」，
   是最难复现、也最容易被当成「这次随机到了静默事件」的一类 bug。 */
const ANIMATION_PAIRS = [
  ['dsh-lucky-blackout-out', 'dshLuckyBlackoutOut'],
  ['dsh-lucky-alarm-in', 'dshLuckyAlarmIn'],
  ['dsh-lucky-alarm-payoff', 'dshLuckyAlarmPayoff'],
  ['dsh-lucky-flip-in', 'dshLuckyFlipIn'],
  ['dsh-lucky-flip-out', 'dshLuckyFlipOut'],
  ['dsh-lucky-unflip-in', 'dshLuckyUnflipIn'],
  ['dsh-lucky-butter-back', 'dshLuckyButterBack'],
  ['dsh-lucky-rave', 'dshLuckyRave'],
  ['dsh-lucky-low-gravity', 'dshLuckyLowGravity'],
]
for (const [cls, keyframes] of ANIMATION_PAIRS) {
  checkTrue(`${cls} 有对应的 @keyframes ${keyframes}`, source.includes(`@keyframes ${keyframes}{`))
  checkTrue(`${cls} 真的被挂到元素上了`, source.includes(`'${cls}'`))
}
/* 假警报那颗跳动的圆点走 inline style（`animation:` 写在 cssText 里），
   不走 class —— 所以它验证的是名字本身。 */
checkTrue('假警报的圆点用了 dshLuckyAlarmDot', source.includes('dshLuckyAlarmDot'))
/* 黄油手：掉下去的是**复制品**（走 inline animation，没有 class），
   原节点靠一个 class 藏起来 —— 三件事必须各自成立：
   有那组 keyframes、复制品真的挂上了它、藏原节点走的是 class（能被 finish 摘掉）。 */
checkTrue('黄油手有 @keyframes dshLuckyButterFall', source.includes('@keyframes dshLuckyButterFall{'))
checkTrue('黄油手的复制品挂上了 dshLuckyButterFall', source.includes('dshLuckyButterFall ${fallMs}ms'))
checkTrue('黄油手用 class 藏原节点（不是 inline style）', /classList\.add\('dsh-lucky-butter-hidden'\)/.test(source))
/* 包含块红线（m00576 的第二个结论）：整页级的 transform / filter 一旦挂到
   body 或 documentElement 上，所有 position:fixed 的后代都会改以它为包含块 ——
   缩水、彩虹这类「整页特效」全都踩在这里，而它只在缩放/旋转时才会显形。
   这条断言守的是「以后也别忘了」。已知的例外是 body 抖动：
   它走 class + translate3d keyframes，是纯平移，不做包含块缩放，且结尾归零。 */
checkTrue(
  '没有任何动效给 body / documentElement 直接挂 transform 或 filter',
  !/(body|documentElement)\.style\.(transform|filter|willChange|perspective)\s*=/.test(source),
)
/* 缩水 / 巨人是这条红线唯一的**合法出口**：`zoom` 不在会重建包含块的
   属性列表里（它改的是布局尺度，fixed 后代跟着一起缩，正是要的画面）。
   所以这里正面钉住它 —— 将来谁把它「优化」成 transform: scale()，
   这条会红，而上面那条红线也会红。 */
checkTrue('缩水 / 巨人走 zoom 而不是 transform（zoom 不重建包含块）', /root\.style\.zoom = String\(factor\)/.test(source))
/* 彩虹的覆盖层必须**穿透点击**。它演的只是「世界换了颜色」，
   不是「现在不能操作」（那是停电的活）。挡住点击就变成另一件事了。 */
checkTrue('彩虹的覆盖层不挡点击', /function runRave\([\s\S]{0,1200}'pointer-events:none'/.test(source))
/* 低重力必须走 `translate` 而不是 `transform`：方块的 transform 正被忙闲态
   和弹回动画占着，写 transform 会把它们顶掉（而 find 不出来 —— 只是不动）。 */
checkTrue('低重力用 translate 属性而不是 transform', /@keyframes dshLuckyLowGravity\{[^}]*translate:/.test(source))

/* ---- 7. 每一条收场路径都会叫 onDone ---- */

console.log('-- 每一种收场方式都会解锁 --')
checkTrue(
  '右侧控件（音乐）自然播完会报收场',
  /addEventListener\('ended'/.test(source),
)
checkTrue(
  '音乐被掐断也会报收场',
  /* 窗口给到 1200 而不是刚好够：haltTrack 里是注释说明 + 摘 trackLyrics + 摘
     trackEnd + pause + 从 voices 摘掉，四步之间随时可能再加一条注释。
     窗口贴着实际长度写的话，下次谁加两行注释就会变成假红。 */
  /function haltTrack\(\)[\s\S]{0,1200}if \(done\) done\(\)/.test(source),
)
checkTrue(
  '播报的定时到点会解锁',
  /window\.setTimeout\(finish,/.test(source),
)
checkTrue(
  '播报被下一段顶掉会解锁',
  /if \(broadcastFinish\.current\) broadcastFinish\.current\(\)/.test(source),
)
checkTrue(
  '点击遮罩走的是同一个收场出口',
  /onClick: function \(\) \{[\s\S]{0,300}broadcastFinish\.current\)/.test(source),
)
checkTrue(
  '蓝屏的 ESC 与定时都走 finish',
  /var unregister = registerEscape\(finish\)[\s\S]{0,400}timer = setTimeout\(finish/.test(source),
)

/* ---- 8. 没有把 isBusy 当表演状态用 ---- */

console.log('-- 表演状态没和请求状态混用 --')
checkTrue(
  'showRef 是 ref 而不是 state（不该触发重渲染）',
  /var showRef = useRef\(0\)/.test(source),
)
checkTrue(
  '阻塞判据读的是 showRef 而不是 isBusy',
  /if \(showRef\.current > 0\)/.test(source),
)

/* ---- 9. 出错路径也要解锁 ---- */

console.log('-- 演出中途抛错不会把方块永久锁死 --')
checkTrue(
  'onRoll 里收集了本轮开出的表演',
  /var begun = \[\]/.test(source),
)
checkTrue(
  /* 断言的是**两者相等**，不是某个写死的数字。
     原来这里写 `=== 4`（弹窗/蓝屏/音乐/居中播报），加三个动效事件后就成了假红 ——
     而写死数字的断言在每加一场表演时都会再红一次，红到最后就会被改成
     「只要大于 0 就行」，那时它已经不验任何东西了。
     相等关系才是真正要守的：**开出去几场，就必须收回几场**。
     少收一场 = 出错时那场永远释放不了 = 方块永久锁死。 */
  '开出的每一场表演都进了 begun（开的场数 == 收的场数）',
  (source.match(/= beginShow\(\)/g) ?? []).length === (source.match(/begun\.push\(/g) ?? []).length,
)
checkTrue(
  'catch 分支会放掉它们',
  /catch \(error\) \{[\s\S]{0,300}begun\[bi\]\(\)/.test(source),
)

/* ---- 10. 音乐起不来时也能解锁 ---- */

console.log('-- 音乐起不来时方块不会锁死 --')
checkTrue(
  'spawn 返回 null 时立刻收场',
  /if \(!audio\) \{[\s\S]{0,400}onEnd\(\)/.test(source),
)
checkTrue(
  '名字为空时立刻收场',
  /typeof name !== 'string' \|\| name\.length === 0\) \{[\s\S]{0,120}onEnd\(\)/.test(source),
)
checkTrue(
  '播放失败（error 事件）也报收场',
  /addEventListener\('error'/.test(source),
)

console.log('')
if (fail === 0) {
  console.log(`ALL GREEN  pass=${pass} fail=0`)
} else {
  console.error(`FAILED  pass=${pass} fail=${fail}`)
  process.exitCode = 1
}
