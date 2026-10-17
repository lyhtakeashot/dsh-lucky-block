# dsh-whale-widget 自动吸附（snap）实现调研

调研对象：`C:\Users\lyh\.dsh\profiles\desktop\node_modules\dsh-whale-widget`
调研日期：2026-10-16

## 0. 包结构与「文件在哪」的坑

`lib/index.js`（265KB）是**宿主侧**代码，里面**没有**吸附逻辑。全文 `snap` 命中 22 处，
全是 `codexSnap`（Codex 会话扫描缓存）与 `svc.get(session)` 之类的无关变量。

`lib/accounting.mjs`（13KB）是记账模块，`snap` 命中 5 处全是 `observeBalance(ledger, snapshot)`
的 `snapshot` 参数，也无关。

**真正的吸附代码在前端单文件**：

```
C:\Users\lyh\.dsh\profiles\desktop\node_modules\dsh-whale-widget\assets\whale-widget.js  (1,142,585 B, 22320 行)
```

该文件是打包后的前端 bundle（含大段中文注释），由 `lib/index.js` 作为静态资源投给浏览器。
`Get-ChildItem` 列出的其他文件：`cordis.patch.yml`、`icon.png`、`package.json`、`PROVENANCE.md`、
`README.md`（58KB，含行为说明）、`assets/*`（音效/贴图/gif）。

> 教训：dsh 插件的「客户端」部分未必在 `lib/` 里；打包单文件插件的前端可能落在 `assets/`。

---

## 1. 吸附（snap）逻辑在哪

### 1.1 配置区块（`assets/whale-widget.js:14043-14142`）

原样代码：

```js
// assets/whale-widget.js:14043-14057
// —— 吸附与翻转自定义配置 ——
// mode: 'ratio' 比例吸附 / 'px' 绝对吸附 / 'off' 关闭（无吸附、无翻转，纯自由）
// ratio.L/T/R/B: 各边吸附区占视口宽/高的百分比（距各自边缘的宽度/高度）
// ratio.F: 翻转线距左侧的百分比（翻转区 = 翻转线左侧；约束 L <= F <= 100-R）
// px.L/T/R/B: 各边吸附区距各自边缘的像素；px.F: 翻转线距左侧的像素
// px.F 为 -1 表示该档从未初始化（首次切到绝对档时按当前视口半宽补默认值）
var SNAP_KEY = 'dshw-snap'
// 配置版本：v2 = 默认吸附区改为 上下15%、左右10%（旧 v1 默认 25%）；v3 = 上吸附默认改为 0（禁用）。
// 旧版本配置整档覆盖为新默认。
var SNAP_VER = 3
var SNAP_DEFAULTS = {
  mode: 'ratio',
  ratio: { L: 10, T: 0, R: 10, B: 15, F: 50 },
  px: { L: 80, T: 0, R: 80, B: 80, F: -1 }
}
```

### 1.2 阈值坐标换算（`assets/whale-widget.js:19149-19170`）—— 原样

```js
// 阈值坐标（px）：按当前配置计算四条吸附区边界与翻转线的屏幕坐标；'off' 返回全屏默认。
function snapBounds(vp) {
  var b = { L: 0, T: 0, R: vp.w, B: vp.h, F: vp.w / 2 }
  try {
    var cfg = snapConfig
    if (!cfg || cfg.mode === 'off') return b
    if (cfg.mode === 'px') {
      b.L = cfg.px.L
      b.T = cfg.px.T
      b.R = vp.w - cfg.px.R
      b.B = vp.h - cfg.px.B
      b.F = cfg.px.F
    } else {
      b.L = vp.w * cfg.ratio.L / 100
      b.T = vp.h * cfg.ratio.T / 100
      b.R = vp.w * (100 - cfg.ratio.R) / 100
      b.B = vp.h * (100 - cfg.ratio.B) / 100
      b.F = vp.w * cfg.ratio.F / 100
    }
  } catch (err) {}
  return b
}
```

### 1.3 判定函数（`assets/whale-widget.js:19171-19187`）—— 原样

```js
// 吸附判定。判定点：cx = 图像中心 x（左右吸附区 + 翻转线）；
// cyBox = 挂件盒中心 y（顶吸附区）；cyImg = 图像中心 y（底吸附区）。
// 返回 { zH:'left'|'right'|null, zV:'top'|'bottom'|null, flip:boolean }；'off' 全自由且不翻转。
function snapZones(cx, cyBox, cyImg, vp) {
  var out = { zH: null, zV: null, flip: false }
  try {
    var cfg = snapConfig
    if (!cfg || cfg.mode === 'off') return out
    var b = snapBounds(vp)
    out.flip = cx < b.F
    if (cx < b.L) out.zH = 'left'
    else if (cx > b.R) out.zH = 'right'
    if (cyBox < b.T) out.zV = 'top'
    else if (cyImg > b.B) out.zV = 'bottom'
  } catch (err) {}
  return out
}
```

### 1.4 落位 + 动画触发（`assets/whale-widget.js:19896-19942`）—— 原样

```js
function snapCheck() {
  if (!snapConfig || snapConfig.mode === 'off') return
  var rect = root.getBoundingClientRect()
  var vp = viewport()
  var w = rect.width, h = rect.height
  var left = rect.left, top = rect.top
  // 判定点：左右吸附/翻转 = 图像中心 x，下吸附 = 图像中心 y，上吸附 = 挂件盒中心 y
  var ac = artCenterAt(left, top, w, h, !!state.flip)
  var z = snapZones(ac.cx, top + h / 2, ac.cy, vp)
  var moved = false
  if (z.zH === 'left') {
    state.h = 'left'
    state.hOff = 0
    left = 0
    moved = true
  } else if (z.zH === 'right') {
    state.h = 'right'
    state.hOff = 0
    left = vp.w - w - rightGap()
    moved = true
  } else {
    state.h = null
    state.hOff = left
  }
  if (z.zV === 'top') {
    state.v = 'top'
    state.vOff = 0
    top = 0
    moved = true
  } else if (z.zV === 'bottom') {
    state.v = 'bottom'
    state.vOff = 0
    top = Math.max(0, vp.h - h)
    moved = true
  } else {
    state.v = 'bottom'
    state.vOff = Math.max(0, vp.h - top - h)
  }
  state.flip = z.flip
  if (moved) {
    state.left = left
    state.top = top
    settle()
  } else {
    express()
  }
}
```

（`snapCheck` 的两个调用点：`assets/whale-widget.js:7826`——吸附配置确认后立即重吸附；
`assets/whale-widget.js:19894`——关闭任意面板后重吸附。）

---

## 2. 逐条回答

### 2.1 判定阈值是多少像素？常量还是和尺寸/DPR 有关？

**不是硬编码常量，是「占视口百分比」或「绝对像素」二选一的可配置值**，默认走比例档。

- 默认档 `mode: 'ratio'`：
  - `L = 10`、`R = 10` → 左/右吸附区宽度 = **视口宽 × 10%**
  - `T = 0` → **上吸附默认关闭**（阈值 0，`cyBox < 0` 永不成立）
  - `B = 15` → 下吸附区高度 = **视口高 × 15%**
- 绝对档 `mode: 'px'`：默认 `L=80, R=80, B=80, T=0`，即左右下各 80**像素**。
- `mode: 'off'` 完全自由。

**和视口尺寸有关（比例档下线性相关），和设备像素比（DPR）无关** ——
全程只用 `window.innerWidth/innerHeight` 与 `getBoundingClientRect()`，
两者都是 CSS 像素，浏览器已处理缩放，代码里没有任何 `devicePixelRatio`。

阈值不是「离边缘多少 px」的直觉模型，而是**「吸附带宽度」**：
`b.L` 是左带的**右边界**，判据是 `cx < b.L`；`b.R` 是右带的**左边界**，判据是 `cx > b.R`。
即：默认左右各 10% 宽的条带，**判定点（图像中心 x）落进条带就吸附**。

用户可以自行改这套阈值：菜单 →「吸附与翻转」→「自定义」，弹出模态
（`openSnapModal` 在 `assets/whale-widget.js:7783`），
含一个 190px 见方的可视化预览框，四条带可见、可拖动分割线
（`startSnapLineDrag` 在 `assets/whale-widget.js:7717`，用 pointer 事件），
也可直接输入数字（`snapMakeNum` 在 `assets/whale-widget.js:7874`）。

### 2.2 松手时吸附还是拖动中实时吸附？有动画吗？

**松手时吸附（一次性判定），不是拖动中实时吸附。**

证据：`snapZones` / 吸附落位只在两处发生 ——
1. `endDrag()` 内部（`assets/whale-widget.js:21983-22012`），即 `pointerup` 之后；
2. `snapCheck()`（配置变更 / 面板关闭后重算）。

拖动过程中的 `onDocPointerMove`（`assets/whale-widget.js:21719-21731`）**只做 clamp**，
不改锚点、不判定吸附：

```js
// assets/whale-widget.js:21727-21730
state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
// v785：拖拽时就把"桌面端窗口控件带"排除在可移动范围外（顶边下限 = 叠层下沿）
state.top = clampWidgetTop(drag.origTop + dy, Math.max(0, drag.vp.h - drag.h))
express()
```

**有动画，用 CSS transition 做的，不是 JS 补间。**

`.dshwv-root` 的样式（`assets/whale-widget.js:563`，原样）：

```css
.dshwv-root{position:fixed;right:0;bottom:0;--dshw-scale:1;--dshw-base:clamp(122px,calc(min(250px,min(100vw,100vh) * 0.28) * var(--dshw-scale)),625px);width:var(--dshw-base);height:var(--dshw-base);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9999;font-family:inherit;transition:left .16s ease,top .16s ease,transform .3s ease}
```

→ **吸附动画：`left .16s ease, top .16s ease`；缓动函数 `ease`；时长 160ms。**
（`transform .3s ease` 是另一个用途，不是位移。）

拖动时通过 class 关掉过渡，避免跟手迟滞（`assets/whale-widget.js:569`，原样）：

```css
.dshwv-root.dshwv-dragging{cursor:grabbing;transition:none}
```

`root.classList.add('dshwv-dragging')` 在 pointerdown（`assets/whale-widget.js:21712`），
`root.classList.remove('dshwv-dragging')` 在 `endDrag`（`assets/whale-widget.js:21955`）。
所以**松手瞬间过渡恢复 → 下一次 express() 写 left/top 就是平滑吸附**。
另外 `express()` 用 `root.style.right = 'auto'` + `root.style.left = ...` 的成对写法
（`assets/whale-widget.js:19088-19090`），原因是 CSS 从 `right` 锚点切到 `left` 锚点时
无法过渡会闪一下（见 `assets/whale-widget.js:14015-14016` 的注释）。

### 2.3 吸附后坐标怎么算？

在 `snapCheck`（`assets/whale-widget.js:19896-19942`）里：

| 边 | 坐标 | 代码 |
|---|---|---|
| 左 | `left = 0` | `assets/whale-widget.js:19909` |
| 右 | `left = vp.w - w - rightGap()` | `assets/whale-widget.js:19914` |
| 上 | `top = 0` | `assets/whale-widget.js:19923` |
| 下 | `top = Math.max(0, vp.h - h)` | `assets/whale-widget.js:19928` |

**是考虑安全边距的 —— 但只有右边有，叫 `rightGap()`**（`assets/whale-widget.js:19021-19026`，原样）：

```js
function rightGap() {
  // 开关关闭：贴边（不避让滚动条）
  if (!scrollGapOn) return 0
  // 开启：用用户填写的像素；填 0 也贴边
  return scrollGapPx > 0 ? scrollGapPx : 0
}
```

默认 `scrollGapOn = false`、`scrollGapPx = 17`（`assets/whale-widget.js:19322-19323`），
即**默认就是硬贴边**，`rightGap()` 返回 0；开关打开才按像素避让（典型用途：避开滚动条）。

还有一条**顶部下限**，但这不是「吸附留白」，而是把它排除在桌面端窗口控件带之外
（`assets/whale-widget.js:13901-13928`，原样）：

```js
var DESKTOP_TITLEBAR_FALLBACK = 44 // 主进程 titleBarOverlay.height = 40，+4 余量
```
```js
// 挂件顶边的**下限**（0 = 不限制，普通浏览器就是 0）
function widgetTopMin() {
  try { return Math.max(0, desktopTitlebarBottom()) } catch (err) { return 0 }
}
// 把「挂件顶边」夹进可移动范围：[顶带下沿, 视口内上限]
function clampWidgetTop(v, maxT) {
  var min = widgetTopMin()
  var t = Number(v)
  if (!isFinite(t)) t = min
  var hi = Infinity
  if (maxT !== undefined && isFinite(Number(maxT))) hi = Math.max(min, Number(maxT))
  return Math.max(min, Math.min(t, hi))
}
```

`clampWidgetTop` 在**所有**写 `state.top` 的路径上都被调用（express 兜底
`assets/whale-widget.js:19094`、拖动 `:21729` / `:21982`、settle `:19129`/`:19133`/`:19136`、
锚点自愈 `:22039`）。普通浏览器里 `widgetTopMin() === 0`，行为与不加这条完全一致。

**判定点和落位点不是同一个点**，这点很关键（`artCenterAt`，`assets/whale-widget.js:19211-19216`，原样）：

```js
// 计算图像（鲸鱼 img 元素）的中心点：img 占挂件盒右下 59.45%（盒为正方形），
// 翻转时整个盒镜像，图像视觉中心随之翻到左侧。
// flipped=false → 图像在盒内右侧；flipped=true → 镜像后在盒内左侧。
function artCenterAt(left, top, w, h, flipped) {
  var iw = Math.max(1, w * 0.5945)
  var cx = flipped ? left + iw / 2 : left + w - iw / 2
  var cy = top + h - iw / 2
  return { cx: cx, cy: cy }
}
```

即：**因为素材不是铺满整个挂件盒（只占右下），所以判定用的是「图像视觉中心」，
而不是盒子中心；吸附落位再用盒子边界对齐屏幕边。**
判定点各自取哪个点的约定（`assets/whale-widget.js:19171-19173` 注释）：
- 左右吸附 + 翻转线 → 图像中心 `cx`
- 顶吸附 → 挂件盒中心 y `top + h/2`
- 底吸附 → 图像中心 y `cy`

### 2.4 只吸左右，还是四条边都吸？

**四条边都实现了，但默认只开三条（左右 + 下）。**

- 上：判定 `cyBox < b.T`，落位 `top = 0`。默认 `T = 0` ⇒ **默认禁用**（`px.F = -1` 那条注释也说明
  「v3 = 上吸附默认改为 0（禁用）」见 `assets/whale-widget.js:14050-14052`）。用户可调大 `T` 开启。
- 下：判定 `cyImg > b.B`，落位 `top = Math.max(0, vp.h - h)`。默认 `B = 15`（比例档）/ `80`（像素档），**默认开启**。
- 左：判定 `cx < b.L`，落位 `left = 0`。默认开启（10% / 80px）。
- 右：判定 `cx > b.R`，落位 `left = vp.w - w - rightGap()`。默认开启。

注意 y 轴两个分支的 `else` 语义**不对称**（`assets/whale-widget.js:19930-19933`）：

```js
  } else {
    state.v = 'bottom'
    state.vOff = Math.max(0, vp.h - top - h)
  }
```

水平 unpinned 时 `state.h = null`（表示「自由 x」），
垂直 unpinned 时却是 `state.v = 'bottom'` + `vOff = 距底距离`——
即**垂直方向永远有锚点（bottom 或 top），没有「自由 y」状态**；水平方向才有自由态。
这是它锚点模型的核心不对称，抄的时候要注意。

还有**翻转/朝向**联动，和吸附是一体的：`flip` 为 true 时整个挂件盒镜像，
让角色朝向屏幕内侧（`snapZones` 里 `out.flip = cx < b.F`；
`refreshFlip` 在 `assets/whale-widget.js:19191-19207` 规定
「贴左边必翻、贴右边必不翻」，自由摆放才按翻转线判）。

### 2.5 吸附和「锁定/固定」状态如何交互？

**whale-widget 没有「锁定」概念。**全文没有 lock/pin 之类的用户可见状态
（grep 命中的 `dshwv-*` 都没有锁定语义）。它的相关状态是**锚点**：

```js
// state.h: 'left' | 'right' | null   —— 水平锚点（null = 自由）
// state.hOff / state.vOff            —— 距该锚边的净距离（px）
// state.v: 'top' | 'bottom'
```

所以对你的问题：「锁定后还能不能拖动、能不能吸附」——**这个插件没有这个状态，
不能直接照抄，要你自己定义**。我的建议见第 5 节。

一个可以借鉴的相关点：`endDrag` 的 `clickAllowed && !drag.moved` 分支
（`assets/whale-widget.js:21971-21977`）——「没移动 = 当成点击，不算拖动」，
与你的 `DRAG_THRESHOLD = 5` 是同一种思路。

### 2.6 位置持久化

**存在 localStorage，键 `dshw-pos`，存的是「锚点 + 离边净距离」，不是绝对坐标。**
（`saveAnchorPos`，`assets/whale-widget.js:19417-19441`，原样）

```js
// 单独抽出：只写 localStorage 锚点（不碰尺寸设置）；applyAnchorPos / settle 自愈时也要用。
// v:2 = 净距离格式（剥离避让距离），v:1 旧格式含避让距离，恢复时废弃旧格式。
function saveAnchorPos() {
  try {
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var leftDist = isFinite(state.left) ? state.left : 0
    var rightDist = vp.w - leftDist - w
    var topDist = isFinite(state.top) ? state.top : 0
    var bottomDist = vp.h - topDist - h
    var hAnchor = leftDist <= rightDist ? 'left' : 'right'
    // issue #102：离边距离必须非负。挂件一旦被算到屏幕外，min(leftDist, rightDist) 就是负数，
    // 存进去会变成"永久坏锚点"，此后每次启动都复现（刷新也恢复不了）。
    var hDistRaw = Math.max(0, Math.round(Math.min(leftDist, rightDist)))
    var hDist = hAnchor === 'right' && scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw
    localStorage.setItem('dshw-pos', JSON.stringify({
      v: 2,
      hAnchor: hAnchor,
      hDist: hDist,
      vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
      vDist: Math.max(0, Math.round(Math.min(topDist, bottomDist)))
    }))
  } catch (err) {}
}
```

要点：
- **存的是归一化锚点**（`hAnchor`/`hDist`/`vAnchor`/`vDist`），不是 `left/top` 原始坐标。
- 存「`Math.min(leftDist, rightDist)`」= 取离**更近那条边**的距离，所以贴边时天然存 `0`。
- **存净距离**：右锚点且开了避让时，写盘前把 `rightGap()` 减掉（`hDist = hDistRaw - rightGap()`），
  读回时再加（见 `applyAnchorPos` 的 `effectiveRightDist`）。避免开关一变距离就漂。
- 带 `v: 2` 版本号，旧格式（v:1）直接废弃重算。
- 有 `Math.max(0, ...)` 兜底：**离边距离必须非负**，否则会变成「永久坏锚点」，
  每次启动都复现、刷新也救不回来（注释里的 issue #102，是个真实踩过的坑）。

**resize 处理**（`assets/whale-widget.js:22016-22054`，原样）：

```js
// 窗口尺寸变化时：自由位置的鲸鱼按相对边框锚点重算（保持离边距离，窗口恢复原状即回原位）；
// 贴边吸附的鲸鱼走 settle()（保持贴边）
function applyAnchorPos() {
  try {
    var a = JSON.parse(localStorage.getItem('dshw-pos') || 'null')
    if (!a || a.v !== 2 || (a.hAnchor !== 'left' && a.hAnchor !== 'right') || typeof a.hDist !== 'number' ||
        (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') || typeof a.vDist !== 'number') return false
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var maxOffH = Math.max(0, vp.w - w)
    var maxOffV = Math.max(0, vp.h - h)
    // issue #102 自愈：非法距离（负数 = 存进去时挂件已在屏幕外；超出视口 = 窗口变小/脏数据）
    // 一律夹回合法范围并把修正结果落盘 —— 老用户中了脏数据也能自己恢复，无需手清 localStorage。
    var hDist = isFinite(a.hDist) ? clamp(a.hDist, 0, maxOffH) : 0
    var vDist = isFinite(a.vDist) ? clamp(a.vDist, 0, maxOffV) : 0
    var healed = (hDist !== a.hDist || vDist !== a.vDist)
    // 与加载恢复一致：锚点存净距离，右锚点按当前避让开关叠加
    var effectiveRightDist = a.hAnchor === 'right' ? hDist + (scrollGapOn ? rightGap() : 0) : hDist
    var l = a.hAnchor === 'left' ? hDist : vp.w - effectiveRightDist - w
    var t = a.vAnchor === 'top' ? vDist : vp.h - vDist - h
    state.left = clamp(l, 0, maxOffH)
    // v785：锚点自愈/恢复也要排除"窗口控件带"（这条路径不一定紧跟 express，所以就地夹）
    state.top = clampWidgetTop(clamp(t, 0, maxOffV), maxOffV)
    state.h = a.hAnchor
    // 净距离直接还给 hOff/vOff：settle() 对锚定状态从偏移量重算，
    // 若置 0 会把刚恢复的距离覆盖成贴边（issue #43）
    state.hOff = hDist
    state.v = a.vAnchor
    state.vOff = vDist
    refreshFlip()
    if (healed) { try { saveAnchorPos() } catch (err) {} }
    return true
  } catch (err) { return false }
}
window.addEventListener('resize', function () {
  if (state.h === null && state.v === null && applyAnchorPos()) return
  settle()
})
```

**resize 的纠正越界**由 `settle()`（`assets/whale-widget.js:19098-19148`）承担，
关键点是「**按锚点重算，而不是搬动 left/top**」+ **只在真的越界时才写盘**：

```js
  // 偏移确实越界（脏数据 / 视口变小）：先把偏移夹回合法范围再落盘，下次启动不再复现。
  // 只在真的越界时写，正常 resize 不会产生额外的 localStorage 写入。
  if (outOfRange) {
    if (state.h === 'right') state.hOff = clamp(state.hOff, 0, Math.max(0, vp.w - w - rightGap()))
    else if (state.h === 'left') state.hOff = clamp(state.hOff, 0, maxLAnchor)
    if (state.v === 'bottom') state.vOff = clamp(state.vOff, 0, Math.max(0, maxT - widgetTopMin()))
    else if (state.v === 'top') state.vOff = clamp(state.vOff, widgetTopMin(), maxT)
    try { saveAnchorPos() } catch (err) {}
  }
  refreshFlip()
```

`settle` 开头还有一条 **mid-drag resize** 特判（`assets/whale-widget.js:19102-19108`）：
拖动中窗口尺寸变了，就保持跟手位置，只 clamp。

### 2.7 拖拽实现

**pointer 事件全套，没用 mouse/touch 做拖拽。** 原样（`assets/whale-widget.js:21709-21731`）：

```js
  var vp = viewport()
  var rect = root.getBoundingClientRect()
  drag = { active: true, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, w: rect.width, h: rect.height, moved: false, vp: vp }
  root.classList.add('dshwv-dragging')
  pressDown()
  setWidgetCursor('grabbing')
  document.addEventListener('pointermove', onDocPointerMove, true)
  document.addEventListener('pointerup', onDocPointerUp, true)
  document.addEventListener('pointercancel', onDocPointerCancel, true)
```

- **没用 `setPointerCapture`**，而是在 `document` 上挂 **capture 阶段**的 `pointermove/pointerup/pointercancel`
  （第三个参数 `true`），`endDrag` 时成对移除（`assets/whale-widget.js:21951-21953`）。
  这是另一种同样可靠的「指针跑出元素也收得到事件」方案。
- 拖动起点用 `getBoundingClientRect()` 记录 `origLeft/origTop`，
  移动时 `origLeft + dx` 而不是累加，避免误差累积。
- **拖动时 clamp 到视口内**：`onDocPointerMove` 里 `clamp(..., 0, Math.max(0, drag.vp.w - drag.w))`。
- 拖动判定阈值：`var CLICK_SQ = 9`（`assets/whale-widget.js:350`），
  `if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true`（`assets/whale-widget.js:21723`）
  ⇒ **半径 3px 的平方距离比较**（省一次 `sqrt`）。你是 `Math.abs(dx) > 5` 的方形阈值，都行。
- 移动端额外补了 touch 层：因为挂件是 `pointer-events:none` 的穿透层，
  浏览器会把手指手势判成页面滚动并发 `pointercancel`，导致「手机上拖不动」。
  解决办法是只在「触摸起点命中挂件」的那一次手势上非 passive 地 `preventDefault`
  （`onDocTouchStart` 在 `assets/whale-widget.js:21819` 起，注释见 `:21783-21787`）。

### 2.8 值得借鉴的边界情况处理

1. **`pointercancel` 的 (0,0) 陷阱（issue #79 缺陷2）** —— 最值得抄的一条。原样
   （`assets/whale-widget.js:21956-21969`）：

```js
  // issue #79 缺陷2：pointercancel（Android 把手势判成页面滚动、或系统抢走手势时派发）的
  // clientX/clientY 常常是 0，而 endDrag 又是「按坐标收尾 + saveConfig() 落盘」——
  // 于是位移被算成"一口气拖到了 (0,0)"，归边判定吃进左上角，损坏锚点被写进 localStorage。
  // 0.3.2 的「非法距离自愈」只治负数 / 超出视口，救不回这个**合法的 (0,0)**，所以必须在这里拦住。
  // 处理：取消的手势一律回到按下前的位置、并且**不落盘**（取消不该提交位置）。
  var noCoord = (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number' ||
                 !isFinite(e.clientX) || !isFinite(e.clientY))
  var zeroBoth = (e && e.clientX === 0 && e.clientY === 0 && drag.moved)
  if (cancelled || noCoord || zeroBoth) {
    try { state.left = drag.origLeft; state.top = drag.origTop } catch (err) {}
    setWidgetCursor('')
    settle()
    return
  }
```

   三条判据：**显式 cancelled / 坐标非有限数 / 拖过却报 (0,0)** —— 任一命中就回原位且**不写 localStorage**。

2. **丢 pointerup 的自愈**（`assets/whale-widget.js:21920-21928`）：光标还在「拖动中」但
   `e.buttons === 0` 说明其实早松手了（例如松手时指针在窗口外），补一次 `endDrag` 收尾。
   ```js
   if (!e.buttons) { try { endDrag(e, true) } catch (err) {} ; return }
   ```

3. **脏数据自愈**（issue #102）：读取时把负数/越界距离夹回合法范围，
   并把修正结果**回写 localStorage**，老用户不用手清缓存就能自己恢复。

4. **版本化存储 + 旧档整体废弃**：`v: 2` / `SNAP_VER = 3`。
   改变默认值时直接升版本号、旧配置整档覆盖为新默认，**避免"用户存了旧默认值后被新默认值坑"**
   （`assets/whale-widget.js:14122-14129`）。

5. **只在真的越界时才写盘**，正常 resize 不产生额外 localStorage 写入（`assets/whale-widget.js:19138-19146`）。

6. **拖动中 resize 特判**（`assets/whale-widget.js:19102-19108`）：保持跟手，只 clamp。

7. **桌面端「窗口控件带」**：把可用顶部让出 `titleBarOverlay` 高度（Electron 外壳下），
   普通浏览器自动退化为 0，不影响。见 `desktopTitlebarBottom` / `clampWidgetTop`。

8. **多显示器 / DPR：没有任何处理。** 全程 `window.innerWidth/innerHeight` + `getBoundingClientRect()`，
   都是当前视口的 CSS 像素；跨显示器移动窗口时浏览器改 `innerWidth` 触发 resize，
   走同一套 `settle()` 逻辑。**没有用到 `screen.*` 或 `devicePixelRatio`**，也没有
   `window.screenX/screenY` 的多屏坐标换算 —— 因为它只需要在当前视口内贴边。

9. **极小窗口**：所有 `Math.max(0, vp.w - w)` / `Math.max(0, vp.h - h)` 都用 `Math.max(0, ...)` 兜底，
   窗口比挂件还小时坐标退化为 0，不会出现负坐标。

10. **`position: fixed` + 运行时切换 left/right 锚点会闪**：`express()` 必须成对写
    `right = 'auto'; left = '...'`，否则从 right 锚点切到 left 锚点时 CSS 无法过渡
    （注释见 `assets/whale-widget.js:14015-14016` 与 `:19088-19090`）。

### 2.9 吸附是可配置项吗？配置怎么读的？

**是可配置的，但配置只走 localStorage，完全不涉及 cordis config / 宿主侧。**

- 读取：`loadSnapConfig()`（`assets/whale-widget.js:14116-14134`），模块加载时立即执行
  （`loadSnapConfig()` 在 `assets/whale-widget.js:14142`）。
- 键名：`SNAP_KEY = 'dshw-snap'`（`assets/whale-widget.js:14049`）。
- 写入：`saveSnapConfig()`（`assets/whale-widget.js:14135-14141`），
  只在模态框点「确定」时调（`closeSnapModal(true)` → `assets/whale-widget.js:7809-7812`）。
- **UI 入口**：右上菜单 →「吸附与翻转」行 →「自定义」按钮
  （`snapRowLabel.textContent = '吸附与翻转'`，`assets/whale-widget.js:2178`；
  按钮 click → `openSnapModal()`，`assets/whale-widget.js:2184`）。
- 三档模式单选：`snapModeDefs`（`assets/whale-widget.js:7841`）对应
  `ratio` / `px` / `off`。
- **权限校验（`clampSnapKey` / `fixSnapConfig`）**：保证 `L <= F <= 100-R`、`T + B <= 100` 等约束，
  加载和确认时各跑一遍（`assets/whale-widget.js:14067-14115`）。

`configPayload()` 在 `assets/whale-widget.js:19380`，**不含任何 snap 字段**
（已 grep 确认 `snapConfig` 只出现在上述行，从不进 `configPayload`）。

---

## 3. 关键代码位置索引（whale-widget）

| 内容 | 位置 |
|---|---|
| 根元素 CSS（含 transition 160ms） | `assets/whale-widget.js:563` |
| 拖动中 `transition:none` | `assets/whale-widget.js:569` |
| 点击/拖动阈值 `CLICK_SQ = 9` | `assets/whale-widget.js:350` |
| 吸附配置常量与默认值 | `assets/whale-widget.js:14049-14057` |
| 单键钳制 `clampSnapKey` | `assets/whale-widget.js:14067-14087` |
| 整体修复 `fixSnapConfig` | `assets/whale-widget.js:14089-14115` |
| 载入 `loadSnapConfig` | `assets/whale-widget.js:14116-14134` |
| 保存 `saveSnapConfig` | `assets/whale-widget.js:14135-14141` |
| 桌面标题栏 `DESKTOP_TITLEBAR_FALLBACK` | `assets/whale-widget.js:13901` |
| `widgetTopMin` / `clampWidgetTop` | `assets/whale-widget.js:13917-13928` |
| `viewport()` | `assets/whale-widget.js:19015-19020` |
| `rightGap()` | `assets/whale-widget.js:19021-19026` |
| `express()`（写 left/top + flip class） | `assets/whale-widget.js:19087-19097` |
| `settle()`（resize/越界纠正 + 自愈写盘） | `assets/whale-widget.js:19098-19148` |
| `snapBounds()`（阈值→像素） | `assets/whale-widget.js:19149-19170` |
| `snapZones()`（判定） | `assets/whale-widget.js:19174-19187` |
| `refreshFlip()` | `assets/whale-widget.js:19191-19207` |
| `artCenterAt()`（判定点换算） | `assets/whale-widget.js:19211-19216` |
| 吸附配置入口（菜单行） | `assets/whale-widget.js:2176-2187` |
| `openSnapModal` / `closeSnapModal` | `assets/whale-widget.js:7783-7815` |
| `applySnapConfigNow` | `assets/whale-widget.js:7819-7827` |
| 模态 UI 构建（预览+输入） | `assets/whale-widget.js:7829-7920+` |
| 分割线拖动 `startSnapLineDrag` | `assets/whale-widget.js:7717-7758` |
| `configPayload()`（不含 snap） | `assets/whale-widget.js:19380` |
| `saveConfig()` | `assets/whale-widget.js:19405-19416` |
| `saveAnchorPos()` | `assets/whale-widget.js:19417-19441` |
| `snapCheck()`（松手/配置后落位） | `assets/whale-widget.js:19896-19942` |
| pointerdown 起点 | `assets/whale-widget.js:21709-21718` |
| `onDocPointerMove`（拖动 clamp，无吸附） | `assets/whale-widget.js:21719-21731` |
| 移动端 touch 接管说明 | `assets/whale-widget.js:21783-21839` |
| 丢 pointerup 自愈 | `assets/whale-widget.js:21920-21928` |
| `endDrag`（取消/无坐标/(0,0) 保护） | `assets/whale-widget.js:21948-22015` |
| `endDrag` 内吸附落位 | `assets/whale-widget.js:21983-22012` |
| `applyAnchorPos()`（resize 恢复+自愈） | `assets/whale-widget.js:22018-22050` |
| resize 监听 | `assets/whale-widget.js:22051-22054` |

---

## 4. 我的插件（dsh-lucky-block）现状

文件：`D:\Desktop\VibeCoding\dsh幸运方块插件\lib\client.js`（886 行）

现状要点：
- 定位：`position: fixed` + 内联 `left: ${geometry.x}px, top: ${geometry.y}px`
  （`lib/client.js:521-529` 的 `style`，经 `mcBlockStyle` 见 `lib/client.js:308-328`）。
  **只用 left/top，没有 right/bottom**，所以不存在 whale 那个「切锚点会闪」的问题。
- 尺寸固定 `size = 56`（`lib/client.js:229`），无缩放，无 DPR 处理。
- 状态：`geometry = { x, y, size, locked }`（`initialGeometry`，`lib/client.js:227-240`）。
- 持久化：`localStorage` 键 `dshLuckyBlock.block`，
  存 `{ x, y, locked }`（`writeStore`，`lib/client.js:68-74`；`persist`，`lib/client.js:353-356`）。
- 阈值：`DRAG_THRESHOLD = 5`，`BREAK_MS = 1400`（`lib/client.js:85-87`）。
- 拖拽：pointer + `setPointerCapture`（`lib/client.js:443-447` 捕获，
  `lib/client.js:475-480` 释放），拖动时 `clamp` 到视口（`lib/client.js:457-458`）。
- **`endDrag`（`lib/client.js:467-481`）目前只做收尾：停挖掘、清 `dragState`、`setDragging(false)`、释放 capture。**
  **完全没有落位逻辑** → 这就是要插入吸附的地方。
- resize 处理已在 `lib/client.js:359-378`，用 `clamp` 把 x/y 拉回视口。
- 锁定：`geometry.locked` 为 true 时 `onPointerDown` **不建 `dragState`**
  （`lib/client.js:401-408`），但**仍然启动挖掘计时器**（`lib/client.js:410-441`，注释：「锁定只是让它不碍事，不是禁用」）。

**关键约束：拖动超过 5px 会 `stopMining()`（`lib/client.js:418-426`）。**
所以吸附判定绝不能放在 `onPointerMove` 里（会与挖掘取消逻辑搅在一起），
**必须放在 `endDrag`（`onPointerUp` / `onPointerCancel`）里，且要能区分「拖动结束」与「点击结束」。**

还有一个现有的坑：`lib/client.js:548-550` 把 `onPointerUp`、`onPointerCancel`、`onPointerLeave`
**三个事件全都绑到同一个 `endDrag`**。`onPointerLeave` 会在指针离开元素时触发
（虽然有 pointer capture 时通常不会丢，但 React 的合成事件仍可能派发），
如果直接在 `endDrag` 里无条件吸附，**鼠标滑出方块边缘就会吸附**。
必须加「真的拖动过」的判据（下面用 `state.moved` 解决）。

另外 `lib/client.js:544-546` 的 `title` 文案会根据 `geometry.locked` 变化，
如果要加「吸附开关」菜单项，注意菜单里已有「锁定位置」「回到默认位置」两项
（`lib/client.js:600-624`）。

---

## 5. 针对 `lib/client.js` 的具体改动方案

> 说明：以下是**建议**，本次调研未改动 `lib/` 下任何文件。

### 改动 1：新增吸附阈值常量（`lib/client.js:87` 之后）

```js
  /** 位移超过这个像素数就判定为「拖动」而非「挖掘」。 */
  var DRAG_THRESHOLD = 5
+
+  /* 自动吸附：方块中心距任一边 < 该阈值即吸附到该边。
+     用「距边距离」而非「吸附带宽度」，语义更直观
+     （whale 用的是带宽模型，见 research/snap/whale-widget-snap.md §2.1）。
+     取值应 >= size/2 + 余量，否则方块已经贴边时中心仍进不了判定区，
+     会出现「明明贴边了却不吸附」的错觉。size = 56 → 建议 40~56。 */
+  var SNAP_THRESHOLD = 48
+  /** 吸附动画时长（ms）。必须与 lib/client.js:528 的 CSS transition 一致。 */
+  var SNAP_MS = 160
```

### 改动 2：新增纯函数 `snapGeometry`（插在 `initialGeometry` 之前，`lib/client.js:226` 附近）

```js
  /* ---------------------------------------------------------------- *
+   * 自动吸附：判定方块中心离哪条边最近，近到 SNAP_THRESHOLD 以内就吸过去
+   * ---------------------------------------------------------------- */
+
+  /**
+   * 计算吸附后的坐标。x / y 两轴**独立**判定，所以可以只吸一边。
+   * 判定点用「方块中心」、落位用「方块边界」—— 两者分离，
+   * 与 whale 的 artCenterAt 思路一致（研究笔记 §2.3）。
+   *
+   * @param {{x:number,y:number,size:number}} geo 松手时的几何
+   * @returns {{x:number,y:number,snapped:boolean}} snapped = 是否吸上了
+   */
+  function snapGeometry(geo) {
+    var width = root.innerWidth || 1280
+    var height = root.innerHeight || 800
+    var size = geo.size
+    var maxX = Math.max(0, width - size)
+    var maxY = Math.max(0, height - size)
+
+    var centerX = geo.x + size / 2
+    var centerY = geo.y + size / 2
+
+    var dLeft = centerX
+    var dRight = width - centerX
+    var dTop = centerY
+    var dBottom = height - centerY
+
+    var x = geo.x
+    var y = geo.y
+    var snapped = false
+
+    var minH = Math.min(dLeft, dRight)
+    if (minH <= SNAP_THRESHOLD) {
+      x = dLeft <= dRight ? 0 : maxX
+      snapped = true
+    }
+
+    var minV = Math.min(dTop, dBottom)
+    if (minV <= SNAP_THRESHOLD) {
+      y = dTop <= dBottom ? 0 : maxY
+      snapped = true
+    }
+
+    return { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY), snapped: snapped }
+  }
```

### 改动 3：拖动时记录「真的移动过」（`lib/client.js:402-406`）

现有：

```js
        dragState.current = {
          pointerId: event.pointerId,
          offsetX: rect ? event.clientX - rect.left : 0,
          offsetY: rect ? event.clientY - rect.top : 0,
        }
```

改为：

```js
        dragState.current = {
          pointerId: event.pointerId,
          offsetX: rect ? event.clientX - rect.left : 0,
          offsetY: rect ? event.clientY - rect.top : 0,
+          originX: event.clientX,
+          originY: event.clientY,
+          moved: false,
        }
```

并在 `lib/client.js:457` 前后（`onPointerMove` 里）打标记：

```js
      var x = clamp(event.clientX - state.offsetX, 0, Math.max(0, width - geometry.size))
      var y = clamp(event.clientY - state.offsetY, 0, Math.max(0, height - geometry.size))
+      // 与挖掘取消同一把尺子：超过 DRAG_THRESHOLD 才算「拖动过」，
+      // 这样 onPointerLeave 误触发时不会把「没动过」的方块吸走。
+      if (
+        Math.abs(event.clientX - state.originX) > DRAG_THRESHOLD ||
+        Math.abs(event.clientY - state.originY) > DRAG_THRESHOLD
+      ) {
+        state.moved = true
+      }
      setGeometry(function (prev) {
```

### 改动 4（核心）：在 `endDrag` 里做吸附落位

现有（`lib/client.js:467-481`）：

```js
    var endDrag = useCallback(function (event) {
      var job = miningRef.current
      if (job && (!event || job.pointerId === event.pointerId)) stopMining()
      var state = dragState.current
      if (!state) return
      if (event && state.pointerId !== event.pointerId) return
      dragState.current = null
      setDragging(false)
      var node = nodeRef.current
      try {
        node && node.releasePointerCapture(state.pointerId)
      } catch (e) {
        /* 忽略 */
      }
    }, [setDragging, stopMining])
```

改为：

```js
    var endDrag = useCallback(function (event) {
      var job = miningRef.current
      if (job && (!event || job.pointerId === event.pointerId)) stopMining()
      var state = dragState.current
      if (!state) return
      if (event && state.pointerId !== event.pointerId) return
      dragState.current = null
      setDragging(false)
      var node = nodeRef.current
      try {
        node && node.releasePointerCapture(state.pointerId)
      } catch (e) {
        /* 忽略 */
      }
+
+      /* 吸附只在「真的拖动过、且是正常抬手」时执行：
+         - state.moved 为 false（没超过 DRAG_THRESHOLD）→ 当作点击/误触，不吸附，
+           否则 onPointerLeave（lib/client.js:550 也绑了本函数）会把没动过的方块吸走；
+         - pointercancel 的 clientX/clientY 常为 0（Android 把手势判成页面滚动时），
+           以此落位会算出「被拖到左上角」并把损坏坐标写进 localStorage
+           （whale 的 issue #79 缺陷2 正是这个坑，见研究笔记 §2.8 第 1 条）。 */
+      var cancelled = !event || event.type === 'pointercancel'
+      var noCoord =
+        !event ||
+        typeof event.clientX !== 'number' ||
+        typeof event.clientY !== 'number' ||
+        !isFinite(event.clientX) ||
+        !isFinite(event.clientY)
+      var zeroBoth = !!event && event.clientX === 0 && event.clientY === 0
+      if (cancelled || noCoord || zeroBoth || !state.moved) return
+
+      setGeometry(function (prev) {
+        var next = snapGeometry(prev)
+        // 只在坐标真的变了才写盘，避免纯拖动但没吸附时也产生一次无用写入
+        if (next.x === prev.x && next.y === prev.y) return prev
+        var out = { x: next.x, y: next.y, size: prev.size, locked: prev.locked }
+        writeStore({ x: out.x, y: out.y, locked: out.locked })
+        return out
+      })
    }, [setDragging, stopMining, setGeometry])
```

注意 `endDrag` 的依赖数组要把 `setGeometry` 加进去（原为 `[setDragging, stopMining]`）。

### 改动 5：给吸附加动画（`lib/client.js:528`）

现有：

```js
      transition: isDragging ? 'none' : 'box-shadow .15s ease, opacity .15s ease, filter .12s linear',
```

改为：

```js
      transition: isDragging
        ? 'none'
-        : 'box-shadow .15s ease, opacity .15s ease, filter .12s linear',
+        : `left ${SNAP_MS}ms ease, top ${SNAP_MS}ms ease, box-shadow .15s ease, opacity .15s ease, filter .12s linear`,
```

要点：
- **拖动中必须是 `transition: none`**（现状已正确），否则方块会「黏糊糊」跟不上指针。
  松手后 `isDragging` 变 false、过渡恢复 → 下一次 render 写入的新 `left/top` 即平滑吸附。
  这与 whale 用 `dshwv-dragging` 关过渡是同一手法（研究笔记 §2.2）。
- 缓动 `ease`、时长 160ms，与 whale 一致（whale 为 `left .16s ease,top .16s ease`）。
- **不要**在拖动时给 `left/top` 加 transition 却又用 rAF 逐帧写坐标 —— 会互相打架。

### 改动 6（可选）：吸附成功的视觉反馈

若想在吸附时加一点「啪」的提示，请**新开一个 state**（例如 `snapFlash`），
**不要复用 `chargeLevel`** —— 它被挖掘逻辑独占（`lib/client.js:343-345`、
`lib/client.js:386`/`:429`/`:433`/`:517`）。

### 改动 7：resize 时保持贴边（`lib/client.js:359-378`）

现有 resize 只做 `clamp`，窗口变大后原本贴边的方块会「离边漂开」。若希望**贴边状态在 resize 后保持**：

**做法 A（轻量）**：不改存储格式，resize 时若方块原本贴边就按新尺寸重新贴同一条边。
需要跨 render 记住旧视口尺寸（用一个 ref 最干净）：

```js
      function onResize() {
+        var lastW = lastViewport.current.w
+        var lastH = lastViewport.current.h
+        lastViewport.current = { w: root.innerWidth || 1280, h: root.innerHeight || 800 }
        setGeometry(function (prev) {
          var width = root.innerWidth || 1280
          var height = root.innerHeight || 800
+          var size = prev.size
+          // 用「上一次的视口」判断 resize 前是否贴边
+          var prevMaxX = Math.max(0, lastW - size)
+          var prevMaxY = Math.max(0, lastH - size)
+          var wasLeft = prev.x === 0
+          var wasRight = prevMaxX > 0 && prev.x >= prevMaxX
+          var wasTop = prev.y === 0
+          var wasBottom = prevMaxY > 0 && prev.y >= prevMaxY
+          var x = clamp(prev.x, 0, Math.max(0, width - size))
+          var y = clamp(prev.y, 0, Math.max(0, height - size))
+          if (wasLeft) x = 0
+          else if (wasRight) x = Math.max(0, width - size)
+          if (wasTop) y = 0
+          else if (wasBottom) y = Math.max(0, height - size)
+          var next = { x: x, y: y, size: size, locked: prev.locked }
-          var next = {
-            x: clamp(prev.x, 0, Math.max(0, width - prev.size)),
-            y: clamp(prev.y, 0, Math.max(0, height - prev.size)),
-            size: prev.size,
-            locked: prev.locked,
-          }
          if (next.x !== prev.x || next.y !== prev.y) writeStore({ x: next.x, y: next.y, locked: next.locked })
          return next
        })
      }
```
外加 `var lastViewport = useRef({ w: root.innerWidth || 1280, h: root.innerHeight || 800 })`
（在 `lib/client.js:349-351` 那几个 ref 旁边）。

**做法 B（彻底，对齐 whale 的锚点模型）**：存储升级为
`{x, y, locked, anchorH: 'left'|'right'|null, anchorV: 'top'|'bottom'|null, v: 2}`，
resize 时按锚点重算。要改的写盘点共 4 处：`lib/client.js:355`（`persist`）、
`:370`（resize 自愈）、`:462`（拖动中）、`:605`/`:619`（菜单，走 `persist` 只传 `{x,y,locked}`）。
**建议第二阶段再做**；先做改动 1–5，resize 保持现状或做法 A。

### 与现有逻辑的冲突检查

| 现有逻辑 | 位置 | 是否冲突 | 处理 |
|---|---|---|---|
| 5px 阈值取消挖掘 | `lib/client.js:418-426` | 不冲突 | 吸附在 `endDrag`；`onPointerMove` 只多打一个 `moved` 标记，不动取消逻辑 |
| 长按 1.4s 挖掘 | `lib/client.js:430-441` | 不冲突 | 挖满先 `stopMining()` 再 `shatterBlock()` + `onRoll()`；此时没拖动，`state.moved` 为 false → 不吸附 |
| 锁定后不可拖动 | `lib/client.js:401-408` | **需决策** | 见下 |
| `onPointerLeave` 也绑 `endDrag` | `lib/client.js:550` | **会冲突** | 用 `state.moved` 挡住；只有真拖过才吸附 |
| `setPointerCapture` | `lib/client.js:443-447` | 不冲突 | 吸附在 release 之后执行 |
| 右键/双击锁定 | `lib/client.js:551-556`、`:600-610` | 不冲突 | 走 `persist`，不经过 `endDrag` |
| resize clamp | `lib/client.js:359-378` | 见改动 7 | 可选增强 |

### 锁定与吸附的交互：需要你拍板

whale 没有锁定态，这个语义得自己定。三种选择：

1. **锁定后吸附照旧、只是不能拖** —— 但锁定根本没有 `dragState`
   （`lib/client.js:401` 只在 `!geometry.locked` 时建），
   所以 `endDrag` 会在 `lib/client.js:471` 就 `return`，
   **天然不会触发吸附**。要让它照旧吸附就得让锁定态也能拖动，自相矛盾。
2. **锁定后连吸附都不做** = 上面自然结果，**零额外代码**。
   这也最符合「锁定位置」的字面语义。
3. **加一个独立的「自动吸附」菜单开关**（像 whale 的 `mode: 'off'`）。
   若要做，建议把 `SNAP_THRESHOLD` 也做成可调，存 localStorage 键如 `dshLuckyBlock.snap`，
   并像 whale 那样带版本号（`v: 1`），避免以后改默认值坑到老用户。
   菜单插入点在 `lib/client.js:611-624`（「回到默认位置」按钮之后）。

**推荐：先按选择 2（零额外代码）把吸附做好；用户若想关，再加选择 3 的开关。**

### 一个容易踩的坑：`snapGeometry` 要读实时视口

`snapGeometry` 里的 `root.innerWidth/innerHeight` 是**当场读取**的，不从 state 取 ——
这与 `onPointerMove`（`lib/client.js:455-456`）和 `initialGeometry`（`lib/client.js:230-231`）一致。
**不要**把 width/height 缓存进 state（做法 A 里的 `lastViewport` 只用于「判断 resize 前是否贴边」，
不做几何计算），否则跨屏拖动 / 缩放会用到过期尺寸。

---

## 6. 一页速查（TL;DR）

| 问题 | 答案 |
|---|---|
| 吸附代码在哪 | `assets/whale-widget.js`（**不是** `lib/index.js`） |
| 判定阈值 | 比例档默认 左10% / 右10% / 下15% / **上0（禁用）**；像素档默认 80/80/80/0；可配置 |
| 阈值性质 | 视口比例的**吸附带宽**，非固定 px；**与 DPR 无关** |
| 何时吸附 | **松手时**（`endDrag` / `snapCheck`），拖动中只 clamp |
| 动画 | CSS `transition: left .16s ease, top .16s ease`；拖动时 `transition:none` |
| 落位坐标 | 左 `0`；右 `vp.w - w - rightGap()`；上 `0`；下 `vp.h - h` |
| 安全边距 | 只有右边有 `rightGap()`，默认 0（硬贴边）；另有一条桌面标题栏下限 `clampWidgetTop` |
| 吸几条边 | 四边都有，默认开三条（左右下） |
| 锁定交互 | **whale 无锁定概念**，需自行定义（推荐：锁定 = 不吸附） |
| 持久化 | localStorage `dshw-pos`，存**锚点 + 离边净距离**，带 `v: 2` |
| resize | `applyAnchorPos` 按锚点重算；`settle` 纠正越界且**仅在越界时写盘** |
| 拖拽 | pointer 事件 + `document` capture 监听（**无** `setPointerCapture`）；拖动中 clamp |
| 拖拽阈值 | `CLICK_SQ = 9`（半径 3px 的平方距离） |
| 可配置 | 是；localStorage `dshw-snap` + 菜单「吸附与翻转→自定义」模态；**不进 cordis config** |
| 最值得抄的边界处理 | `pointercancel` 的 (0,0) 陷阱；丢 pointerup 自愈；脏数据自愈回写；存储版本号 |
