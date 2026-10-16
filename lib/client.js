/**
 * dsh-lucky-block — 客户端（浏览器）插件实现：可拖拽的幸运方块悬浮按钮。
 *
 * 形状严格对齐 dsh-notify-me 的 lib/client.js：
 *  - 通过 window.__ModuleLoader__.load({ id, factory }) 注册（dsh-client-modules 的静态 bundle 通道）；
 *  - 静态 bundle 可以安全 require("react") / require("react/jsx-runtime") —— 它们是 boot 时的
 *    seed 模块（PLATFORM_MODULES，research/plugin-arch/src/web-frontend-index.js:126）；
 *  - 用 ctx.get(name) 懒查宿主服务，绝不把可选服务写进 inject（否则整个 entry 永不激活）。
 *
 * 幸运方块按钮（我的世界「命令方块」外观：紫色立方体 + 像素斜面 + 中央问号）：
 *  - 挂 shell.overlay（frame 级 overlay chain，click-through，官方钦定的「全屏浮动层」座位）；
 *  - 可拖动（pointer 事件），可锁定（锁定后忽略拖动，右键菜单可解锁）；
 *  - 位置与锁定状态存 localStorage（键 dshLuckyBlock.block）；
 *  - 点击 → 让宿主在默认工作区开新会话并随机干一件事（POST /dsh-lucky-block/roll）。
 */

(function (root) {
  'use strict'

  var NS = 'dsh-lucky-block'
  var LS_KEY = 'dshLuckyBlock.block'
  var ROLL_PATH = '/dsh-lucky-block/roll'
  var PING_PATH = '/dsh-lucky-block/ping'

  /* 懒查宿主服务：cordis 只解析 inject 里声明的 ctx.<name>，
     直接读未声明的属性会抛 "cannot get property X without inject"；
     ctx.get() 走 reflector store、无 inject 要求，是唯一可靠的懒查。 */
  var rootCtx = null

  function lookupService(name) {
    if (!rootCtx || typeof rootCtx.get !== 'function') return null
    try {
      var svc = rootCtx.get(name)
      return svc || null
    } catch (e) {
      return null
    }
  }

  function t(zh, en) {
    var locale = lookupService('locale')
    try {
      if (locale && typeof locale.translate === 'function') {
        var hit = locale.translate(NS, zh)
        if (typeof hit === 'string' && hit.length > 0) return hit
      }
      if (locale && typeof locale.t === 'function') {
        var hit2 = locale.t(NS, zh)
        if (typeof hit2 === 'string' && hit2.length > 0) return hit2
      }
    } catch (e) {
      /* 退化到默认文案 */
    }
    return zh
  }

  function readStore() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(LS_KEY)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (e) {
      return null
    }
  }

  function writeStore(value) {
    try {
      if (root.localStorage) root.localStorage.setItem(LS_KEY, JSON.stringify(value))
    } catch (e) {
      /* 隐私模式下 localStorage 不可用，忽略 */
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /* ---------------------------------------------------------------- *
   * 挖掘音效：原版《我的世界》的挖石头声与碎裂声
   *
   * 音效二进制随包放在 lib/sounds/，由宿主路由
   * `/dsh-lucky-block/sound/<name>.ogg` 按需提供（见 lib/index.js 的 prefix 路由）。
   * **不内联成 data URI**：整个音效库约 190 KB，而 lib/client.js 是启动时就要
   * 下载的入口 bundle —— 为了用户可能永远不触发的音效把启动体积撑大 4 倍不值得。
   *
   * 用户要求（m05467）两种效果都要：长按期间**循环**放挖掘声 + 挖穿时**额外**响一声。
   * 设置面板里可以整体关掉（config.json 的 sound 字段，见 lib/index.js settings 路由）。
   * ---------------------------------------------------------------- */

  /** 宿主音效路由前缀，必须与 lib/index.js 注册的 prefix 路由一致。 */
  var SOUND_BASE = '/dsh-lucky-block/sound/'

  /** 音效清单，名字必须与 lib/sounds/ 下的文件名一致（宿主按白名单发文件）。 */
  var SOUND_FILES = {
    /* 挖掘循环的 4 个变体：原版就是随机轮播这几个，只听一个会明显「卡带」。 */
    dig: ['dig1.ogg', 'dig2.ogg', 'dig3.ogg', 'dig4.ogg'],
    break: ['break.ogg'],
  }

  /** 挖掘声两次之间的间隔。原版大概每 0.2 秒响一下，210ms 稍慢一点更耐听。 */
  var DIG_INTERVAL_MS = 210

  /** 同时存在的 Audio 元素上限，防止长按很久后元素越积越多。 */
  var MAX_VOICES = 6

  /** 挑一段音。`avoid` 是上一次用过的，尽量不连着放同一个。 */
  function pickSound(group, avoid) {
    var list = SOUND_FILES[group]
    if (!list || list.length === 0) return null
    if (list.length === 1) return list[0]
    var name = list[Math.floor(Math.random() * list.length)]
    // 撞上了就顺延一个：比重新抽更快，也不会死循环。
    if (name === avoid) name = list[(list.indexOf(name) + 1) % list.length]
    return name
  }

  /**
   * 建一个音效引擎，一个实例管一条挖掘循环。
   *
   * 用 Audio 元素而不是 AudioContext：给 URL 就响，不需要 decodeAudioData 的
   * 异步等待；每次 new 一个天然可重叠；也没有 AudioContext 那个「页面切走再
   * 回来要重新 resume」的状态机。
   *
   * 所有失败一律静默 —— 音效是锦上添花，让它冒泡成报错气泡是本末倒置。
   */
  function createSoundEngine() {
    var enabled = true
    var timer = null
    var voices = []
    var lastDig = null

    function playFile(name, volume) {
      if (!enabled || !name) return null
      if (typeof Audio !== 'function') return null
      // 页面在后台时不发声：用户切走了还一直响很烦，浏览器通常也会自己拦掉。
      if (typeof document !== 'undefined' && document.hidden) return null
      try {
        var audio = new Audio(SOUND_BASE + name)
        audio.volume = typeof volume === 'number' ? volume : 1
        try { audio.preload = 'auto' } catch (e) { /* 忽略 */ }
        var p = audio.play()
        if (p && typeof p.catch === 'function') p.catch(function () { /* 静默 */ })
        voices.push(audio)
        while (voices.length > MAX_VOICES) {
          var old = voices.shift()
          try { old.pause(); old.currentTime = 0 } catch (e) { /* 忽略 */ }
        }
        // 播完自己摘出池子，否则池子会被已结束的元素占满。
        if (typeof audio.addEventListener === 'function') {
          audio.addEventListener('ended', function () {
            var i = voices.indexOf(audio)
            if (i >= 0) voices.splice(i, 1)
          })
        }
        return audio
      } catch (e) {
        return null
      }
    }

    return {
      setEnabled: function (next) {
        enabled = !!next
        if (!enabled) this.stopDig()
      },
      isEnabled: function () { return enabled },
      /**
       * 开始挖掘循环。幂等（先 stop 再起）。
       * 「按下立刻就响」是刻意的：游戏的挖掘音也是按下即出，
       * 等 210ms 才出声会让人以为按钮没反应。
       */
      startDig: function () {
        if (!enabled) return
        this.stopDig()
        lastDig = pickSound('dig', lastDig)
        playFile(lastDig)
        timer = setInterval(function () {
          lastDig = pickSound('dig', lastDig)
          playFile(lastDig)
        }, DIG_INTERVAL_MS)
      },
      stopDig: function () {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
      },
      /**
       * 碎裂的一声。不受挖掘循环状态影响 ——
       * 它是「挖穿了」的报信人，即使循环因为拖走被掐断也该响。
       */
      playBreak: function () {
        playFile(pickSound('break', null))
      },
      dispose: function () {
        this.stopDig()
        for (var i = 0; i < voices.length; i++) {
          try { voices[i].pause(); voices[i].currentTime = 0 } catch (e) { /* 忽略 */ }
        }
        voices = []
      },
    }
  }

  /* ---------------------------------------------------------------- *
   * 挖掘裂纹 + 破碎粒子：长按方块时逐级叠加原版裂纹帧，挖满后炸成像素碎片
   * ---------------------------------------------------------------- */

  /** 长按挖满所需时长（毫秒）。够长才不会误触。 */
  var BREAK_MS = 1400
  /** 位移超过这个像素数就判定为「拖动」而非「挖掘」。 */
  var DRAG_THRESHOLD = 5

  /**
   * 边缘吸附：松手时若方块某条边离屏幕对应边 ≤ SNAP_THRESHOLD 像素，就贴上去。
   * 阈值取 48px —— 大约一个方块半径再多一点，够「靠近就吸」又不至于抢走自由摆放。
   * 参考实现：dsh-whale-widget/assets/whale-widget.js:19149-19187（它的阈值是可配置
   * 的带宽比例，默认左/右 10%、下 15%、上 0；我们简化成固定像素、四边都吸）。
   */
  var SNAP_THRESHOLD = 48
  /** 吸附动画时长，必须与下面 mcBlockStyle 的 transition 数值一致。 */
  var SNAP_MS = 160

  /**
   * 计算吸附后的坐标（纯函数，两轴各自独立判定）。
   * 以方块「中心」到屏幕边缘的距离为准，离哪条边近就吸哪条。
   *
   * 注意：这里刻意不读 React state，视口尺寸每次现取，避免 resize 后用到旧值。
   * 参考：whale 用 artCenterAt() 取视觉中心而非盒子中心（:19211-19216），
   * 我们方块是正方形，直接用盒子中心即可。
   */
  function snapGeometry(next) {
    var width = root.innerWidth || 1280
    var height = root.innerHeight || 800
    var size = next.size
    var maxX = Math.max(0, width - size)
    var maxY = Math.max(0, height - size)

    var x = clamp(next.x, 0, maxX)
    var y = clamp(next.y, 0, maxY)
    var snapped = false

    // 左 / 右
    if (x <= SNAP_THRESHOLD) {
      x = 0
      snapped = true
    } else if (maxX - x <= SNAP_THRESHOLD) {
      x = maxX
      snapped = true
    }
    // 上 / 下
    if (y <= SNAP_THRESHOLD) {
      y = 0
      snapped = true
    } else if (maxY - y <= SNAP_THRESHOLD) {
      y = maxY
      snapped = true
    }
    return { x: x, y: y, snapped: snapped }
  }

  /* 原版方块挖掘裂纹帧 destroy_stage_0..9（16x16，透明底），已内联为 data URI。
     素材：PixiGeko/Minecraft-default-assets @ latest
       assets/minecraft/textures/block/destroy_stage_{0..9}.png
     手写脚本内联，勿手改这一段。 */
  var DESTROY_STAGE_PX = 16
  var DESTROY_STAGE_URIS = ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAIElEQVR42mP4z4gfMgxHBbb/CSiY/R+qBFMBQslwDCgAHzABvNmXYu8AAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAALUlEQVR42mP4z4gfMgw2Bbb/KVUw+z9ICRCjKkBXMhufAoh+vApmoysYCkENAFNeA+Djx0xsAAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAANklEQVR42mP4z4gfMtBZge1/yhXAaDALU8FsoARIejYQoitAKIFJYipAWEOJAoQFON0wAHEBAAC3BtrwrtWzAAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAR0lEQVR42mP4z4gfMlBbge1/DAWo0rMJKUAm4QoQ0hDB2UAaahZCAUQCJAW2CAhxOHI2XC9WBTC7yVcAdhw+BbOxhQPtIwsAsa8LCE9CBPsAAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAUklEQVR42qWRWwrAMAgE04PtSeew048SbEOxlCCo4OD6GB69jd9AbIFIB0SsHvEFuHueQIxXCWNJjWqOGGe+zIAzRtxYswdibO+AiJ8SrMD2N08OdxBIgvkBfwAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAACVBMVEX///+bm5s9PT3bVE0VAAAAAXRSTlMBN+Ho8AAAAD5JREFUeNpjQAIcC4AEWwCQ4FTQYGDoUJjCwLBCyoGBKUwVKMQ4gYGBhaEBKKsAIrQcgMRUEMshAaRZAGIGADQ2B/h60oH7AAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAACVBMVEX///+bm5s9PT3bVE0VAAAAAXRSTlMBN+Ho8AAAAEVJREFUeNoFwLENQEAAAMAjIgwgEdVXIqb4Eb5Sq03xJaWE/ktjCiDAWNAmXGHhDA/fFNXbTF/ddDnT7AVrwpup40FlAH584Qm0R4DSRgAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAACVBMVEX///+bm5s9PT3bVE0VAAAAAXRSTlMBN+Ho8AAAAFBJREFUeNpjgIAFICICSHKxBSgwsHZqaDAwdKhMY2BYIeXIwBSmxsDAqTiJgYFjQmMDA0vCAgcGBq0oBgaFqa0MDFIOWQwMrA1TGxgYHBwcAO7uDi9dP4c5AAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAACVBMVEX///+bm5s9PT3bVE0VAAAAAXRSTlMBN+Ho8AAAAFhJREFUeNpjYOBwYGFgWsLRwKAYsSSBQYotQIFBtVNDg0GgQ2UaA8MKKUcGpjA1BgZOxUkMDBwTGjsYWhIWpDAkaEUpMChMbRVgkHLIAsoumLqAgSWgIQIAgUIRus1A1UkAAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAgMAAABinRfyAAAACVBMVEX///+bm5s9PT3bVE0VAAAAAXRSTlMBN+Ho8AAAAFlJREFUeNpj4ODwaGFgW8LRwKAYsSSBQYotQIFhaaeGBkNAh8o0BoYVUo4Mi8LUGBgiFScxMXBMaOxkaElYkMKQoBWlwKAwtVWKQcohi5WBc8HUBQwcAQ0RAAFXFBQ8Tu5rAAAAAElFTkSuQmCC',
  ]

  /**
   * 固定种子的 PRNG：碎片每次爆都长得一样（同一次触发内稳定），不会闪。
   */
  function crackRandom(seed) {
    var s = seed >>> 0
    return function () {
      s = (s + 0x6d2b79f5) >>> 0
      var t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /**
   * 取当前挖掘进度该显示的裂纹帧。
   * progress ∈ (0,1] → 10 帧的序号（0..9；进度到 1 时停在第 9 帧，方块随即碎掉）。
   * progress <= 0 返回 -1 = 不渲染。原版第 0 帧本身是「中心一个像素小点」，
   * 所以没按住的时候必须整个 overlay 都不存在，否则静止的方块上会永远挂着一个点。
   * 素材没加载时同样返回 -1（无裂纹），不抛错。
   */
  function crackStageIndex(progress) {
    var p = clamp(Number(progress) || 0, 0, 1)
    if (p <= 0) return -1
    if (DESTROY_STAGE_URIS.length === 0) return -1
    return Math.min(DESTROY_STAGE_URIS.length - 1, Math.floor(p * DESTROY_STAGE_URIS.length))
  }

  /**
   * 一帧裂纹的 <img>（原版 destroy_stage 贴图，透明底，直接盖在方块面上）。
   * progress ∈ [0,1] 映射到 10 帧；素材缺失或 progress<=0 时返回 null（不渲染裂纹）。
   */
  function crackOverlay(props, size) {
    var idx = crackStageIndex(props.chargeLevel / 100)
    if (idx < 0) return null
    return h('img', {
      src: DESTROY_STAGE_URIS[idx],
      alt: '',
      'aria-hidden': true,
      draggable: false,
      style: Object.assign(luckyBlockFaceStyle(size), {
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        filter: 'drop-shadow(0 0 1px rgba(0,0,0,.55))',
      }),
    })
  }

  /**
   * 方块破碎：一次白光闪 + 一圈像素碎片向外炸开。
   * 纯 DOM，不依赖任何图片；700ms 后自行清理。
   */
  function shatterBlock(rect, onDone) {
    var host = document.body
    var cx = rect.left + rect.width / 2
    var cy = rect.top + rect.height / 2
    var size = Math.max(24, Math.min(rect.width, rect.height))
    var rnd = crackRandom(0xb16b1e)

    var flash = document.createElement('div')
    flash.style.cssText = [
      'position:fixed',
      `left:${cx - size * 0.9}px`,
      `top:${cy - size * 0.9}px`,
      `width:${size * 1.8}px`,
      `height:${size * 1.8}px`,
      'border-radius:50%',
      'background:radial-gradient(circle, rgba(255,255,255,.95) 0%, rgba(255,226,150,.55) 45%, rgba(255,226,150,0) 70%)',
      'pointer-events:none',
      'z-index:100010',
      'animation:dsh-lucky-flash .28s ease-out forwards',
    ].join(';')
    if (!root.__dshLuckyFlashStyle) {
      var style = document.createElement('style')
      style.textContent =
        '@keyframes dsh-lucky-flash{from{opacity:1;transform:scale(.5)}to{opacity:0;transform:scale(1.5)}}' +
        '@keyframes dsh-lucky-shard{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot))}}'
      document.head.appendChild(style)
      root.__dshLuckyFlashStyle = true
    }
    host.appendChild(flash)
    setTimeout(function () {
      if (flash.parentNode) flash.parentNode.removeChild(flash)
    }, 320)

    var palette = ['#f6de41', '#f6bf21', '#e0690b', '#fff7ec', '#f6e75a']
    var shards = 26
    for (var i = 0; i < shards; i += 1) {
      var shard = document.createElement('div')
      var px = Math.round(2 + rnd() * (size / 12))
      var angle = (i / shards) * Math.PI * 2 + rnd() * 0.5
      var dist = size * (0.5 + rnd() * 1.1)
      shard.style.cssText = [
        'position:fixed',
        `left:${cx}px`,
        `top:${cy}px`,
        `width:${px}px`,
        `height:${px}px`,
        `background:${palette[Math.floor(rnd() * palette.length)]}`,
        'pointer-events:none',
        'z-index:100011',
        `transform:translate(-50%,-50%)`,
        `--dx:${Math.cos(angle) * dist}px`,
        `--dy:${Math.sin(angle) * dist + size * 0.35}px`,
        `--rot:${Math.round((rnd() - 0.5) * 720)}deg`,
        `animation:dsh-lucky-shard ${520 + Math.round(rnd() * 320)}ms cubic-bezier(.2,.7,.4,1) forwards`,
      ].join(';')
      host.appendChild(shard)
      setTimeout(
        (function (node) {
          return function () {
            if (node.parentNode) node.parentNode.removeChild(node)
          }
        })(shard),
        900,
      )
    }
    if (typeof onDone === 'function') setTimeout(onDone, 700)
  }

  function initialGeometry() {
    var stored = readStore()
    var size = 56
    var width = root.innerWidth || 1280
    var height = root.innerHeight || 800
    var fallback = { x: clamp(width - size - 24, 0, Math.max(0, width - size)), y: clamp(Math.floor(height * 0.28), 0, Math.max(0, height - size)), size: size, locked: false }
    if (!stored) return fallback
    return {
      x: clamp(Number(stored.x ?? fallback.x), 0, Math.max(0, width - size)),
      y: clamp(Number(stored.y ?? fallback.y), 0, Math.max(0, height - size)),
      size: size,
      locked: stored.locked === true,
    }
  }

  /* ---------------------------------------------------------------- *
   * 幸运方块按钮组件
   * ---------------------------------------------------------------- */

  // React 只能在 __ModuleLoader__ 的 factory 内部取（IIFE 顶层没有 require），
  // 所以这里只声明壳，赋值发生在 factory 里（见文件末尾）。
  var React = null
  var h = null
  var useState = null
  var useEffect = null
  var useRef = null
  var useCallback = null

  function bindReact(require) {
    try {
      React = require('react') || null
      h = React && React.createElement ? React.createElement : null
    } catch (e) {
      React = null
    }
    useState = React ? React.useState : null
    useEffect = React ? React.useEffect : null
    useRef = React ? React.useRef : null
    useCallback = React ? React.useCallback : null
    return !!React
  }

  /**
   * 与宿主通信：优先 fetch 自定义路由。
   * 错误信息取宿主给的 data.error.message（宿主已翻译成人话），
   * 拿不到才退回 HTTP 状态码 —— 否则用户只会看到「HTTP 500」这种无从下手的提示。
   */
  async function callHost(path, options) {
    var response = await fetch(path, {
      method: (options && options.method) || 'POST',
      headers: { 'content-type': 'application/json' },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    })
    var text = await response.text()
    var data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (e) {
      data = { raw: text }
    }
    if (!response.ok) {
      var reason =
        (data && data.error && (data.error.message || data.error.detail)) ||
        (data && data.message) ||
        ''
      if (reason) throw new Error(String(reason))
      /* 401/403 是宿主的鉴权/信任栅栏拦下的，不是插件坏了 —— 说清楚，
         免得用户以为插件崩了。405 通常意味着插件本体没激活。 */
      if (response.status === 401) throw new Error(t('宿主拒绝了请求（未登录或登录已过期），刷新页面后重试。', 'Host denied the request (not signed in or session expired). Refresh and retry.'))
      if (response.status === 403) throw new Error(t('宿主拒绝了请求（来源不被信任）。', 'Host denied the request (untrusted origin).'))
      if (response.status === 405) throw new Error(t('插件没有注册这个接口，通常是插件本体未激活：重启 dsh 后再试。', 'This route is not registered — the plugin likely did not activate. Restart dsh.'))
      if (response.status === 404) throw new Error(t('找不到插件接口：插件可能已卸载。', 'Plugin route not found — it may have been uninstalled.'))
      throw new Error(`HTTP ${response.status}`)
    }
    return data
  }

  // 幸运方块贴图：直接使用 Minecraft 幸运方块 mod 的方块面贴图（16x16），
  // 由 tools/build-block-face.py 从原版材质生成，结果以 data URI 内联。
  // 这是贴图本身（不是 mod 图标），所以像素硬边、四角白点、白问号全都在。
  // 用 data URI 内联：不依赖外部图片文件，随便缩放；
  // image-rendering: pixelated 保证放大后依然是硬边像素而不是糊掉的插值。
  var LUCKY_BLOCK_FACE_PX = 16
  var LUCKY_BLOCK_FACE_URI = 'data:image/png;base64,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'

  /** 方块正面图的 <img> 样式：正方形、像素硬边、不参与文本选中。 */
  function luckyBlockFaceStyle(size) {
    return {
      width: size + 'px',
      height: size + 'px',
      imageRendering: 'pixelated',
      WebkitImageRendering: 'pixelated',
      display: 'block',
      userSelect: 'none',
    }
  }

  function mcBlockStyle(size, extra) {
    return Object.assign(
      {
        position: 'fixed',
        width: size + 'px',
        height: size + 'px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        userSelect: 'none',
        touchAction: 'none',
        zIndex: 9999,
        background: 'transparent',
        boxShadow: '0 8px 20px rgba(0,0,0,.38)',
        border: 'none',
        pointerEvents: 'auto',
      },
      extra || {},
    )
  }

  function LuckyBlock(props) {
    var geo = useState(initialGeometry)
    var geometry = geo[0]
    var setGeometry = geo[1]
    var dragging = useState(false)
    var isDragging = dragging[0]
    var setDragging = dragging[1]
    var busy = useState(false)
    var isBusy = busy[0]
    var setBusy = busy[1]
    var tip = useState('')
    var error = tip[0]
    var setError = tip[1]
    /* 角色台词气泡。与 error 是**两个独立的气泡**：
       error 是红底、可点击关闭、常驻到用户点掉；
       台词是深色、几秒后自动消失、不抢镜。混用一个 state 会导致
       「台词把报错顶掉」或「报错被定时器清空」这类难查的串扰。 */
    var speech = useState('')
    var quip = speech[0]
    var setQuip = speech[1]
    var quipTimer = useRef(0)
    var charge = useState(0)
    var chargeLevel = charge[0]
    var setChargeLevel = charge[1]
    var menu = useState(false)
    var menuOpen = menu[0]
    var setMenuOpen = menu[1]
    /* 设置面板：null = 关闭；否则是宿主 /settings 返回的 value。 */
    var panel = useState(null)
    var settingsOpen = panel[0]
    var setSettingsOpen = panel[1]
    var panelBusy = useState(false)
    var settingsBusy = panelBusy[0]
    var setSettingsBusy = panelBusy[1]
    var dragState = useRef(null)
    var nodeRef = useRef(null)
    var miningRef = useRef(null)
    /* 音效引擎实例。用 ref 而不是 useMemo：它带可变内部状态（voices 池、
       定时器），必须跨渲染存活且只建一次。惰性建（第一次用才 new Audio），
       不在渲染期构造对象。 */
    var soundRef = useRef(null)
    if (!soundRef.current) soundRef.current = createSoundEngine()

    var persist = useCallback(function (next) {
      setGeometry(next)
      writeStore({ x: next.x, y: next.y, locked: next.locked })
    }, [setGeometry])

    /* 打开设置面板：向宿主取当前配置。
       失败就报错而不静默 —— 用户点了「设置」却什么都没出现会以为是插件坏了。 */
    var openSettings = useCallback(async function () {
      setMenuOpen(false)
      /* 立刻开面板（用 loading 占位）。如果等 fetch 回来才开，
         宿主往返那几十毫秒里点「设置…」是**没有任何反应**的，
         用户会以为按钮坏了、然后再点一次。 */
      setSettingsBusy(true)
      setSettingsOpen({ localizable: [], localOnly: [], configPath: '', sound: true })
      try {
        var data = await callHost('/dsh-lucky-block/settings', { method: 'POST' })
        if (data && data.ok === false) throw new Error((data.error && data.error.message) || '读取设置失败')
        var value = data && data.value ? data.value : { localizable: [], localOnly: [], configPath: '', sound: true }
        setSettingsOpen(value)
        /* 音效开关是**跨会话**的设置，读到就立刻应用到这个引擎实例上，
           否则用户改完设置得刷新页面才生效。 */
        if (soundRef.current) soundRef.current.setEnabled(value.sound !== false)
      } catch (e) {
        setSettingsOpen(null)
        setError(String((e && e.message) || e))
      } finally {
        setSettingsBusy(false)
      }
    }, [setMenuOpen, setSettingsOpen, setSettingsBusy, setError])

    /* 音效总开关。乐观更新 + 落盘失败回滚，和 toggleLocalOnly 同一套路。 */
    var toggleSound = useCallback(async function () {
      if (!settingsOpen) return
      var next = !(settingsOpen.sound !== false)
      setSettingsOpen(Object.assign({}, settingsOpen, { sound: next }))
      // 界面立刻生效，不等宿主往返。
      if (soundRef.current) soundRef.current.setEnabled(next)
      try {
        var data = await callHost('/dsh-lucky-block/save-settings', { method: 'POST', body: { sound: next } })
        if (data && data.ok === false) throw new Error((data.error && data.error.message) || '保存设置失败')
        if (data && data.value && typeof data.value.sound === 'boolean') {
          setSettingsOpen(Object.assign({}, settingsOpen, { sound: data.value.sound }))
          if (soundRef.current) soundRef.current.setEnabled(data.value.sound)
        }
      } catch (e) {
        // 落盘失败：界面与引擎都改回去，否则用户以为已经保存成功了。
        setSettingsOpen(Object.assign({}, settingsOpen, { sound: !next }))
        if (soundRef.current) soundRef.current.setEnabled(!next)
        setError(String((e && e.message) || e))
      }
    }, [settingsOpen, setSettingsOpen, setError])

    /* 勾选/取消某个事件的「不调用 AI」。乐观更新 + 落盘失败回滚，
       这样点击立刻有反馈（宿主往返要几十毫秒）。 */
    var toggleLocalOnly = useCallback(async function (eventId) {
      if (!settingsOpen) return
      var current = Array.isArray(settingsOpen.localOnly) ? settingsOpen.localOnly : []
      var next = current.indexOf(eventId) >= 0
        ? current.filter(function (id) { return id !== eventId })
        : current.concat([eventId])
      var previous = current
      setSettingsOpen(Object.assign({}, settingsOpen, { localOnly: next }))
      try {
        var data = await callHost('/dsh-lucky-block/save-settings', { method: 'POST', body: { localOnly: next } })
        if (data && data.ok === false) throw new Error((data.error && data.error.message) || '保存设置失败')
        if (data && data.value) setSettingsOpen(Object.assign({}, settingsOpen, { localOnly: data.value.localOnly }))
      } catch (e) {
        // 落盘失败：把界面改回去，否则用户以为已经保存成功了。
        setSettingsOpen(Object.assign({}, settingsOpen, { localOnly: previous }))
        setError(String((e && e.message) || e))
      }
    }, [settingsOpen, setSettingsOpen, setError])

    /* 让方块开口说一句。自动消失，可被下一句打断（重开计时器）。 */
    var say = useCallback(function (text, ms) {
      if (typeof text !== 'string' || text.length === 0) return
      if (quipTimer.current) window.clearTimeout(quipTimer.current)
      setQuip(text)
      quipTimer.current = window.setTimeout(function () {
        quipTimer.current = 0
        setQuip('')
      }, Number(ms) > 0 ? Number(ms) : 6000)
    }, [setQuip])

    // 组件消失时别让定时器对着已卸载的组件 setState。
    useEffect(function () {
      return function () {
        if (quipTimer.current) window.clearTimeout(quipTimer.current)
      }
    }, [])

    /* 主动插话：定期问一次宿主「有话说吗」。
       宿主那边管着「间隔多久 / 一天最多几次 / 用户是否在忙」的全部策略，
       这里只做最笨的轮询与展示 —— 客户端不该持有任何判断逻辑，
       否则以后想调克制程度就得改两个地方。 */
    useEffect(function () {
      var stopped = false
      var timer = 0
      var POLL_MS = 60_000
      function poll() {
        if (stopped) return
        callHost(PING_PATH, { method: 'GET' })
          .then(function (result) {
            if (stopped) return
            var value = result && result.value ? result.value : null
            if (value && typeof value.chatter === 'string' && value.chatter.length > 0) {
              say(value.chatter)
            }
          })
          .catch(function () {
            /* 宿主没就绪 / 网络抖动都无所谓，插话本来就不重要 */
          })
          .then(function () {
            if (!stopped) timer = window.setTimeout(poll, POLL_MS)
          })
      }
      timer = window.setTimeout(poll, POLL_MS)
      return function () {
        stopped = true
        if (timer) window.clearTimeout(timer)
      }
    }, [say])

    // 窗口尺寸变化时把按钮拉回可视区域。
    useEffect(function () {
      function onResize() {
        setGeometry(function (prev) {
          var width = root.innerWidth || 1280
          var height = root.innerHeight || 800
          var next = {
            x: clamp(prev.x, 0, Math.max(0, width - prev.size)),
            y: clamp(prev.y, 0, Math.max(0, height - prev.size)),
            size: prev.size,
            locked: prev.locked,
          }
          if (next.x !== prev.x || next.y !== prev.y) writeStore({ x: next.x, y: next.y, locked: next.locked })
          return next
        })
      }
      root.addEventListener('resize', onResize)
      return function () {
        root.removeEventListener('resize', onResize)
      }
    }, [setGeometry])

    /** 立刻停下挖掘（松手 / 拖动 / 卸载），并清掉定时器与挖掘音。 */
    var stopMining = useCallback(function () {
      var job = miningRef.current
      if (!job) return
      miningRef.current = null
      if (job.timer) clearInterval(job.timer)
      // 挖掘声必须跟着停：裂纹消失了还在「咚咚咚」会很出戏。
      if (soundRef.current) soundRef.current.stopDig()
      setChargeLevel(0)
    }, [setChargeLevel])

    /**
     * 按下即开始挖掘：不移动地按住 BREAK_MS 方块碎裂。
     * 位移一旦超过 DRAG_THRESHOLD 就取消挖掘转成拖动，
     * 这样「想把方块拖走」不会误触发随机事件。
     */
    var onPointerDown = useCallback(function (event) {
      if (event.button !== 0) return
      var node = nodeRef.current
      var rect = node ? node.getBoundingClientRect() : null
      var originX = event.clientX
      var originY = event.clientY

      if (!geometry.locked) {
        dragState.current = {
          pointerId: event.pointerId,
          offsetX: rect ? event.clientX - rect.left : 0,
          offsetY: rect ? event.clientY - rect.top : 0,
          /* 起点坐标：用来判断「真的拖动过」。
             endDrag 同时挂在 pointerup/pointercancel/pointerleave 三个事件上，
             没有这个标记的话鼠标滑出方块边缘就会误触发吸附。
             用的尺子与「取消挖掘」完全一致（DRAG_THRESHOLD），保证语义统一。 */
          originX: rect ? rect.left : geometry.x,
          originY: rect ? rect.top : geometry.y,
          moved: false,
        }
        setDragging(true)
      }

      // 锁定状态下同样允许长按：锁定只是让它不碍事，不是禁用。
      var started = Date.now()
      var job = {
        pointerId: event.pointerId,
        timer: null,
        originX: originX,
        originY: originY,
      }
      job.checkMove = function (ev) {
        if (miningRef.current !== job) return
        if (
          Math.abs(ev.clientX - originX) > DRAG_THRESHOLD ||
          Math.abs(ev.clientY - originY) > DRAG_THRESHOLD
        ) {
          stopMining()
        }
      }
      miningRef.current = job
      // 按下这一刻就把进度顶到第 0 帧（不为 0），否则要等第一个 40ms tick 才出现第一个小点。
      setChargeLevel(1)
      /* 挖掘音从按下这一刻就开始循环（用户要求「长按期间循环放」）。
         放在 setChargeLevel 之后、timer 之前：音效和裂纹是同一起点，
         而且这里同步出声，没有等一个 tick 的延迟。 */
      if (soundRef.current) soundRef.current.startDig()
      job.timer = setInterval(function () {
        if (miningRef.current !== job) return
        var p = clamp((Date.now() - started) / BREAK_MS, 0, 1)
        setChargeLevel(Math.round(p * 100))
        if (p >= 1) {
          stopMining()
          var node2 = nodeRef.current
          var rect2 = node2 ? node2.getBoundingClientRect() : rect
          if (rect2) shatterBlock(rect2)
          /* 碎裂声（用户要求「两种效果都要」的第二半）。
             注意顺序：**先 stopMining 再 playBreak** —— stopMining 会 stopDig，
             若反过来的话这声碎裂会跟循环的最后一声叠在一起，听感是「咚咔」粘连。
             也让 playBreak 不受 stopDig 影响（它只认 enabled，不认循环状态）。 */
          if (soundRef.current) soundRef.current.playBreak()
          onRoll()
        }
      }, 40)

      try {
        node && node.setPointerCapture(event.pointerId)
      } catch (e) {
        /* 某些环境不支持 pointer capture，忽略 */
      }
    }, [geometry.locked, setDragging, setChargeLevel, stopMining])

    var onPointerMove = useCallback(function (event) {
      var job = miningRef.current
      if (job && job.pointerId === event.pointerId) job.checkMove(event)
      var state = dragState.current
      if (!state || state.pointerId !== event.pointerId) return
      var width = root.innerWidth || 1280
      var height = root.innerHeight || 800
      var rawX = clamp(event.clientX - state.offsetX, 0, Math.max(0, width - geometry.size))
      var rawY = clamp(event.clientY - state.offsetY, 0, Math.max(0, height - geometry.size))
      // 超过阈值才算「真的拖动过」——只有真拖过才允许松手时吸附。
      if (
        !state.moved &&
        (Math.abs(rawX - state.originX) > DRAG_THRESHOLD || Math.abs(rawY - state.originY) > DRAG_THRESHOLD)
      ) {
        state.moved = true
      }
      setGeometry(function (prev) {
        if (prev.x === rawX && prev.y === rawY) return prev
        var next = { x: rawX, y: rawY, size: prev.size, locked: prev.locked }
        writeStore({ x: next.x, y: next.y, locked: next.locked })
        return next
      })
    }, [geometry.size, setGeometry])

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

      /* ---------------- 边缘吸附 ---------------- */
      /* 只有「真的拖动过」才吸附。守卫三条（对齐 dsh-whale-widget 在
         pointercancel 上的教训：取消事件常报 clientX/Y = 0，
         若照坐标收尾会算成「拖到左上角」并把坏坐标写进 localStorage）：
           1. 取消了（pointercancel）→ 回原位、不吸附、不落盘；
           2. 拖过却报 (0,0) → 视为脏事件，同样不理会；
           3. 压根没拖过（moved=false，例如刚按下就松手、或鼠标滑出边缘
              触发的 pointerleave）→ 保持原位。
         锁定态根本不会建 dragState，所以上面 `if (!state) return` 已经把
         「锁定 = 不吸附」自然实现了，无需额外代码。 */
      if (!state.moved) return
      var cancelled = !!(event && event.type === 'pointercancel')
      var noCoord = !!(event && (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)))
      var zeroBoth = !!(event && event.clientX === 0 && event.clientY === 0)
      if (cancelled || noCoord || zeroBoth) return

      setGeometry(function (prev) {
        var snapped = snapGeometry(prev)
        if (snapped.x === prev.x && snapped.y === prev.y) return prev
        writeStore({ x: snapped.x, y: snapped.y, locked: prev.locked })
        return { x: snapped.x, y: snapped.y, size: prev.size, locked: prev.locked }
      })
    }, [setDragging, stopMining, setGeometry])

    // 卸载 / 组件消失时必须停掉挖掘定时器，否则会对着已销毁的组件 setState。
    useEffect(function () {
      return function () {
        stopMining()
        /* 音效引擎也要收摊：它自己管着一条 setInterval 和一堆 Audio 元素，
           不 dispose 的话组件没了声音还在响。 */
        if (soundRef.current) soundRef.current.dispose()
      }
    }, [stopMining])

    var onRoll = useCallback(async function () {
      if (isBusy) return
      setBusy(true)
      /* 头顶气泡**只**承载报错（用户要求：「头顶除了报错信息其他什么都不要出现」）。
         进度、成功、会话 ID 这些一律不往头顶写 —— 有视觉表演的事件自己会演出，
         没有视觉表演的事件由新会话的内容承担反馈。 */
      setError('')
      try {
        var result = await callHost(ROLL_PATH, { method: 'POST', body: {} })
        var value = result && result.value ? result.value : null
        /* 有视觉表演的事件（弹窗 / 蓝屏）：直接在本地播放，与新会话并行。 */
        if (value && value.visual && typeof value.visual === 'object') {
          var visual = value.visual
          if (visual.kind === 'bluescreen') {
            runBluescreen(
              Number(visual.durationMs) || 60000,
              Array.isArray(visual.lines) ? visual.lines : null,
              null,
            )
          } else if (visual.kind === 'popups') {
            runPopupShow(Number(visual.count) || 24, Number(visual.intervalMs) || 450, null)
          }
        }
        /* 本地内容（用户在设置里关掉了这个事件的 AI 调用）：
           宿主直接抽好了正文，像聊天消息一样显示出来。
           这条**必须在视觉/台词之后**判断 —— 视觉事件也带 local:true，
           但它的内容是演出来的，没有 text。 */
        if (value && typeof value.localText === 'string' && value.localText.length > 0) {
          say(value.localText, 30000)
        }
        /* 台词：视觉事件的俏皮话由宿主本地随机挑好（零 token），这里只负责显示。
           agent 事件也带一句 —— 方块先开口，会话那边再慢慢跑。 */
        if (value && typeof value.quip === 'string' && value.quip.length > 0) {
          say(value.quip)
        }
        /* 人格刚刚翻转（掷够 50 次）：用一次告示，对应游戏里那句
           「我已协助你击杀超过 50 人……感谢。」的错愕感。 */
        if (value && value.flipped) {
          window.setTimeout(function () {
            say(t(
              '操作完成。已协助你掷出超过 50 次。冷血杀手模式停用。从现在起，只有爱狗人士模式可用。感谢。',
              'Operation complete. You have rolled more than 50 times. Stone Cold Killer mode deactivated. From this point on, only Puppy-Loving Pacifist is available. Thank you.',
            ))
          }, 2600)
        }
      } catch (error) {
        setError(`${t('方块启动失败', 'Block failed')}：${String((error && error.message) || error)}`)
      } finally {
        setBusy(false)
        setChargeLevel(0)
      }
    }, [isBusy, setBusy, setError, setChargeLevel, say])

    var style = mcBlockStyle(geometry.size, {
      left: `${geometry.x}px`,
      top: `${geometry.y}px`,
      cursor: geometry.locked ? 'pointer' : isDragging ? 'grabbing' : 'pointer',
      // 挖掘时整体轻微提亮（0~100 的挖掘进度）。
      filter: chargeLevel > 0 ? `brightness(${1 + (chargeLevel / 100) * 0.18})` : 'none',
      opacity: isBusy ? 0.85 : 1,
      transition: isDragging
        ? 'none'
        : `left ${SNAP_MS}ms ease, top ${SNAP_MS}ms ease, box-shadow .15s ease, opacity .15s ease, filter .12s linear`,
    })

    // 裂纹随挖掘进度切到下一张原版 destroy_stage 帧（crackOverlay 里选帧，chargeLevel 为 0 时不渲染）。

    return h(
      'div',
      { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9998 } },
      h(
        'div',
        {
          ref: nodeRef,
          role: 'button',
          tabIndex: 0,
          title: geometry.locked
            ? t('幸运方块（已锁定，右键解锁；长按挖掘触发）', 'Lucky block (locked, right-click to unlock; hold to mine)')
            : t('幸运方块（拖动移动 / 长按挖掘触发）', 'Lucky block (drag to move / hold to mine)'),
          style: style,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onPointerLeave: endDrag,
          onContextMenu: function (event) {
            event.preventDefault()
            setMenuOpen(function (prev) {
              return !prev
            })
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onRoll()
            }
          },
        },
        h(
          'img',
          {
            src: LUCKY_BLOCK_FACE_URI,
            alt: '',
            draggable: false,
            style: Object.assign(luckyBlockFaceStyle(geometry.size), {
              transform: isDragging ? 'scale(.92)' : 'scale(1)',
              transition: 'transform .12s ease',
            }),
          },
        ),
        crackOverlay({ chargeLevel: chargeLevel }, geometry.size),
      ),
      menuOpen
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                left: `${geometry.x}px`,
                top: `${geometry.y + geometry.size + 6}px`,
                pointerEvents: 'auto',
                background: 'rgba(20,20,28,.96)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,.14)',
                borderRadius: '10px',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                fontSize: '12px',
                zIndex: 9999,
                minWidth: '132px',
              },
            },
            h(
              'button',
              {
                style: menuItemStyle,
                onClick: function () {
                  persist({ x: geometry.x, y: geometry.y, size: geometry.size, locked: !geometry.locked })
                  setMenuOpen(false)
                },
              },
              geometry.locked ? t('解锁（可拖动）', 'Unlock (draggable)') : t('锁定位置', 'Lock position'),
            ),
            h(
              'button',
              {
                style: menuItemStyle,
                onClick: function () {
                  var width = root.innerWidth || 1280
                  var height = root.innerHeight || 800
                  var next = { x: clamp(width - geometry.size - 24, 0, Math.max(0, width - geometry.size)), y: clamp(Math.floor(height * 0.28), 0, Math.max(0, height - geometry.size)), size: geometry.size, locked: geometry.locked }
                  persist(next)
                  setMenuOpen(false)
                },
              },
              t('回到默认位置', 'Reset position'),
            ),
            h(
              'button',
              {
                style: menuItemStyle,
                onClick: openSettings,
              },
              t('设置…', 'Settings…'),
            ),
          )
        : null,
      /* 台词气泡：角色在说话。位置让开报错气泡（报错优先级更高，
         它贴得更近、且要常驻到用户点掉）。几秒后自己消失。 */
      quip
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                left: `${geometry.x}px`,
                top: `${error ? geometry.y - 92 : geometry.y - 34}px`,
                /* 不吃鼠标事件：它只是说话，不该挡住底下任何东西的可点击区域。
                   想让它立刻消失点方块本身就行（下一次发言会重开计时器）。 */
                pointerEvents: 'none',
                background: 'rgba(18,18,24,.94)',
                color: '#e8e8f0',
                border: '1px solid rgba(160,160,200,.32)',
                borderRadius: '8px',
                padding: '6px 9px',
                fontSize: '12px',
                lineHeight: '1.45',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxWidth: '46vw',
                zIndex: 9999,
                boxShadow: '0 6px 20px rgba(0,0,0,.35)',
                transition: 'opacity .18s ease',
              },
            },
            quip,
          )
        : null,
      error
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                left: `${geometry.x}px`,
                top: `${geometry.y - 34}px`,
                /* 报错可以点掉：宿主给的说明可能有好几句，用户看完想让它消失。 */
                pointerEvents: 'auto',
                cursor: 'pointer',
                background: 'rgba(74,18,22,.96)',
                color: '#fff',
                border: '1px solid rgba(255,140,140,.42)',
                borderRadius: '8px',
                padding: '6px 9px',
                fontSize: '12px',
                lineHeight: '1.45',
                /* 允许换行：宿主已经把人话写在里面了，截断成省略号等于白写。
                   宽度上限 60vw，避免长文本糊住半个屏幕。 */
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxWidth: '60vw',
                zIndex: 9999,
                boxShadow: '0 6px 20px rgba(0,0,0,.35)',
              },
              onClick: function () {
                setError('')
              },
              title: t('点击关闭', 'Click to dismiss'),
            },
            `⚠ ${error}\n${t('（点击关闭）', '(click to dismiss)')}`,
          )
        : null,
      /* 设置面板：方块右键菜单 → 设置… 打开。
         面板贴在方块旁边，点空白处关闭。 */
      settingsOpen
        ? h(
            'div',
            {
              style: {
                position: 'fixed',
                left: `${Math.min(geometry.x, Math.max(0, (root.innerWidth || 1280) - 320))}px`,
                top: `${geometry.y + geometry.size + 6}px`,
                width: '300px',
                maxHeight: '70vh',
                overflowY: 'auto',
                pointerEvents: 'auto',
                background: 'rgba(20,20,28,.98)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,.16)',
                borderRadius: '10px',
                padding: '10px 12px',
                fontSize: '12px',
                lineHeight: '1.5',
                zIndex: 9999,
                boxShadow: '0 10px 30px rgba(0,0,0,.5)',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
              h('strong', null, t('幸运方块设置', 'Lucky block settings')),
              h(
                'button',
                {
                  style: { all: 'unset', cursor: 'pointer', padding: '0 4px', color: '#aaa' },
                  onClick: function () { setSettingsOpen(null) },
                  title: t('关闭', 'Close'),
                },
                '✕',
              ),
            ),
            /* 音效总开关。放在事件列表**上面**：它是全局手感设置，
               而下面那一串是逐事件的 AI 开关，层级不同，混在一起会让人
               以为音效也是个「事件」。 */
            h(
              'label',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px',
                  marginBottom: '8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: settingsOpen.sound !== false ? 'rgba(90,120,180,.16)' : 'transparent',
                },
              },
              h('input', {
                type: 'checkbox',
                checked: settingsOpen.sound !== false,
                onChange: function () { toggleSound() },
              }),
              h('span', null, t('长按挖掘音效', 'Mining sound effects')),
              h(
                'span',
                { style: { marginLeft: 'auto', color: '#8a8a99', fontSize: '11px' } },
                t('循环挖掘声 + 碎裂声', 'looping dig + break'),
              ),
            ),
            h(
              'div',
              { style: { color: '#b9b9c8', marginBottom: '8px' } },
              t('勾选的事件不再调用 AI，直接从本地语料库取内容（零 token、瞬时返回）。', 'Checked events skip the model and read from the local corpus instead (zero tokens, instant).'),
            ),            settingsBusy
              ? h('div', { style: { color: '#b9b9c8' } }, t('读取中…', 'Loading…'))
              : (settingsOpen.localizable || []).length === 0
                ? h('div', { style: { color: '#b9b9c8' } }, t('没有可本地化的事件。', 'No localizable events.'))
                : (settingsOpen.localizable || []).map(function (item) {
                    var on = (settingsOpen.localOnly || []).indexOf(item.id) >= 0
                    return h(
                      'label',
                      {
                        key: item.id,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '5px 6px',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          background: on ? 'rgba(90,160,90,.16)' : 'transparent',
                        },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: on,
                        onChange: function () { toggleLocalOnly(item.id) },
                      }),
                      h('span', null, item.title),
                      on
                        ? h('span', { style: { marginLeft: 'auto', color: '#8fd08f' } }, t('本地', 'local'))
                        : null,
                    )
                  }),
            h(
              'div',
              { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.12)', color: '#8a8a99', wordBreak: 'break-all' } },
              t('配置文件：', 'Config: '),
              settingsOpen.configPath || '—',
            ),
          )
        : null,
    )
  }

  var menuItemStyle = {
    all: 'unset',
    cursor: 'pointer',
    padding: '5px 8px',
    borderRadius: '6px',
    textAlign: 'left',
    color: '#fff',
  }

  /* ---------------------------------------------------------------- *
   * 弹窗表演 + 蓝屏屏保（由宿主会话里的消息驱动）
   * ---------------------------------------------------------------- */

  /**
   * 弹窗表演：连弹 N 个无意义窗口，再按创建顺序倒序关掉。
   * 纯 DOM 覆盖层，不碰 window.open（浏览器会拦截），也不影响 dsh 其他插件。
   */
  function runPopupShow(count, intervalMs, onDone) {
    var opened = []
    var index = 0
    var host = document.body
    var titles = ['系统提示', '温馨提示', '重要通知', '来自好友的消息', '中奖提醒', '更新提示', '订阅确认', '缓存清理', '彩蛋']
    var bodies = [
      '您的操作已成功，但什么也没有发生。',
      '检测到一次愉快的点击，已为您记录并遗忘。',
      '本次弹窗由幸运方块随机生成，不含任何实际内容。',
      '正在为您努力地原地待命……',
      '温馨提示：关掉它不会失去任何东西。',
      '系统运行良好，除了这句话之外。',
      '已收到您的关注，暂无后续。',
      '恭喜！您获得了一次再抽一次的机会。',
    ]

    function spawn() {
      if (index >= count) return closeNext()
      var i = index
      index += 1
      var node = document.createElement('div')
      node.className = 'dsh-lucky-popup'
      node.textContent = `${titles[i % titles.length]}\n${bodies[i % bodies.length]}`
      node.style.cssText = [
        'position:fixed',
        `left:${12 + Math.random() * Math.max(20, (root.innerWidth || 800) - 260)}px`,
        `top:${12 + Math.random() * Math.max(20, (root.innerHeight || 600) - 140)}px`,
        'width:220px',
        'padding:12px 14px',
        'background:#f2f2f2',
        'color:#111',
        'border:1px solid #b9b9b9',
        'border-radius:6px',
        'box-shadow:0 8px 20px rgba(0,0,0,.28)',
        'font:13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
        'white-space:pre-wrap',
        'z-index:100000',
        'opacity:0',
        'transform:scale(.96)',
        'transition:opacity .12s ease, transform .12s ease',
      ].join(';')
      host.appendChild(node)
      requestAnimationFrame(function () {
        node.style.opacity = '1'
        node.style.transform = 'scale(1)'
      })
      opened.push(node)
      setTimeout(spawn, intervalMs)
    }

    function closeNext() {
      var node = opened.pop()
      if (!node) {
        if (typeof onDone === 'function') onDone()
        return
      }
      node.style.opacity = '0'
      node.style.transform = 'scale(.96)'
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node)
        closeNext()
      }, 90)
    }

    spawn()
  }

  /**
   * 蓝屏屏保：全屏盖住 dsh 自己的窗口，60 秒或按 ESC 结束。
   * 只覆盖 dsh 页面自身，不碰系统、不碰其他插件。
   */
  function runBluescreen(durationMs, lines, onDone) {
    var host = document.createElement('div')
    host.className = 'dsh-lucky-bluescreen'
    host.setAttribute('role', 'dialog')
    host.setAttribute('aria-modal', 'true')
    var background = '#0a4db3'
    host.style.cssText = [
      'position:fixed',
      'inset:0',
      `background:${background}`,
      'color:#fff',
      "font:16px/1.6 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif",
      'display:flex',
      'flex-direction:column',
      'justify-content:center',
      'padding:8vh 10vw',
      'z-index:200000',
      'pointer-events:auto',
    ].join(';')

    var heading = document.createElement('div')
    heading.textContent = ':('
    heading.style.cssText = 'font-size:96px;font-weight:300;margin-bottom:24px'
    host.appendChild(heading)

    var list = Array.isArray(lines) && lines.length > 0 ? lines : ['你的插件遇到了一点小情绪。']
    for (var i = 0; i < list.length; i += 1) {
      var p = document.createElement('div')
      p.textContent = list[i]
      p.style.cssText = 'margin:6px 0'
      host.appendChild(p)
    }

    var foot = document.createElement('div')
    foot.style.cssText = 'margin-top:28px;opacity:.85;font-size:13px'
    foot.textContent = '按 ESC 提前结束，否则 60 秒后自动关闭。'
    host.appendChild(foot)

    document.body.appendChild(host)

    var finished = false
    function finish() {
      if (finished) return
      finished = true
      root.removeEventListener('keydown', onKey, true)
      clearTimeout(timer)
      if (host.parentNode) host.parentNode.removeChild(host)
      if (typeof onDone === 'function') onDone()
    }
    function onKey(event) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault()
        event.stopPropagation()
        finish()
      }
    }
    root.addEventListener('keydown', onKey, true)
    var timer = setTimeout(finish, Math.max(1000, Number(durationMs) || 60000))
    return finish
  }

  /* ---------------------------------------------------------------- *
   * 入口
   * ---------------------------------------------------------------- */

  function activate(ctx) {
    rootCtx = ctx

    var inject = ['slots']
    var styleInjected = false

    function ensureStyles() {
      if (styleInjected) return
      styleInjected = true
      var style = document.createElement('style')
      style.textContent = '.dsh-lucky-popup{animation:dshLuckyPop .14s ease}.dsh-lucky-bluescreen{animation:dshLuckyFade .18s ease}@keyframes dshLuckyPop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}@keyframes dshLuckyFade{from{opacity:0}to{opacity:1}}'
      document.head.appendChild(style)
    }

    ctx.effect(function () {
      // 幸运方块挂在 shell.overlay：全屏浮动层、click-through、additive。
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-lucky-block',
            order: 50,
            label: t('幸运方块', 'Lucky block'),
          },
          function () {
            ensureStyles()
            return React ? React.createElement(LuckyBlock, null) : null
          },
        )
      })
      return function () {
        /* 反注册由 slots 自己负责 */
      }
    })

    // 暴露调试 API（与 dsh-notify-me 的 window.__dshNotifyMe 一致的做法）。
    try {
      root.__dshLuckyBlock = {
        ping: function () {
          return callHost(PING_PATH, { method: 'GET' })
        },
        roll: function () {
          return callHost(ROLL_PATH, { method: 'POST', body: {} })
        },
        popups: function (count, intervalMs) {
          return new Promise(function (resolve) {
            runPopupShow(count || 24, intervalMs || 450, resolve)
          })
        },
        bluescreen: function (durationMs, lines) {
          return new Promise(function (resolve) {
            runBluescreen(durationMs || 60000, lines, resolve)
          })
        },
        version: '0.1.0',
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  // 与 dsh-notify-me 完全一致的加载形状。
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return
  root.__ModuleLoader__.load({
    id: NS,
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      bindReact(require)

      exports.inject = ['slots']
      exports.apply = activate
      return module.exports
    },
  })
})(typeof window !== 'undefined' ? window : globalThis)
