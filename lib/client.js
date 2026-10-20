/**
 * dsh-lucky-block — 客户端（浏览器）插件实现：可拖拽的幸运方块悬浮按钮。
 *
 * 形状严格对齐 dsh-notify-me 的 lib/client.js：
 *  - 通过 window.__ModuleLoader__.load({ id, factory }) 注册（dsh-client-modules 的静态 bundle 通道）；
 *  - 静态 bundle 可以安全 require("react") / require("react/jsx-runtime") —— 它们是 boot 时的
 *    seed 模块（见 dsh 安装包里 `web-frontend-index.js` 的 PLATFORM_MODULES）；
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
  /* 几何 + 外观都走同一个 localStorage 键。读的时候逐字段容错（见 normalizeLook / initialGeometry），
     写的时候整份覆盖 —— 用户改了哪个字段都只影响那一个，不会把别的设置清掉。 */
  var LS_KEY = 'dshLuckyBlock.block'
  var ROLL_PATH = '/dsh-lucky-block/roll'
  var PING_PATH = '/dsh-lucky-block/ping'
  /** 随机音频事件的曲库前缀（与挖掘音效的 SOUND_BASE 是两条不同的路由）。 */
  var AUDIO_BASE = '/dsh-lucky-block/audio/'

  /* ---------------- 方块外观：默认值与白名单 ----------------
     全部可在设置面板里改，用户没写过的字段用这里的默认值。
     上下限**必须**在客户端也挡一道：面板上的 input[type=range] 挡得住手滑，
     挡不住有人直接把 JSON 写坏（上一版 pointercancel 的教训：坏坐标落盘后
     每次刷新都复现，且没法在 UI 里发现）。 */
  var LOOK_DEFAULTS = {
    /* 边长像素。上限 128 是「别把 dsh 主界面糊住」的感知下限：
       再大就该考虑是不是该做成 dock 而不是悬浮按钮了。 */
    size: 56,
    /* 正面图案。'lucky' = 原版幸运方块面（唯一内联的贴图）；
       'command' / 'tnt' / 'pumpkin' 走 CSS 现画（见 facePattern）；
       'custom' 用 look.image = data URI 或 http(s) URL。 */
    face: 'lucky',
    /* face: 'custom' 时的图。data URI 或 http(s) 链接，其它一律忽略。 */
    image: '',
    /* 圆角像素。0 = 原版方块的硬直角。 */
    radius: 0,
    /* 边框颜色：'' 表示无边框。 */
    border: '',
    /* 边框宽度像素（border 非空时才生效）。 */
    borderWidth: 0,
    /* 投影：'' 表示无投影。 */
    shadow: '0 8px 20px rgba(0,0,0,.38)',
    /* 背景色（图案背后）。'transparent' = 跟随系统。 */
    background: 'transparent',
  }

  var LOOK_LIMITS = {
    size: [24, 128],
    radius: [0, 32],
    borderWidth: [0, 8],
    faces: ['lucky', 'command', 'tnt', 'pumpkin', 'custom'],
  }

  /**
   * 清洗一份 look 配置：未知字段丢掉、越界夹回、类型不对回退默认值。
   * 纯函数，不吃 React —— tools 里的单测直接抽 eval 它。
   */
  function normalizeLook(raw) {
    var out = {}
    for (var key in LOOK_DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(LOOK_DEFAULTS, key)) continue
      out[key] = LOOK_DEFAULTS[key]
    }
    if (!raw || typeof raw !== 'object') return out
    var num = LOOK_LIMITS.size
    var size = Number(raw.size)
    if (Number.isFinite(size)) out.size = clamp(Math.round(size), num[0], num[1])
    if (LOOK_LIMITS.faces.indexOf(raw.face) >= 0) out.face = raw.face
    var image = typeof raw.image === 'string' ? raw.image.trim() : ''
    /* 只认 data URI 和 http(s)。'file://'、'javascript:'、'blob:' 一律丢掉 ——
       blob: 在这个缓存域下不可用，file:// 会被 CSP 拦，两者都会让 <img> 裂开。 */
    if (/^data:image\//i.test(image) || /^https?:\/\//i.test(image)) out.image = image
    var num2 = LOOK_LIMITS.radius
    var radius = Number(raw.radius)
    if (Number.isFinite(radius)) out.radius = clamp(Math.round(radius), num2[0], num2[1])
    var border = typeof raw.border === 'string' ? raw.border.trim() : ''
    if (border.length <= 64) out.border = border
    var num3 = LOOK_LIMITS.borderWidth
    var bw = Number(raw.borderWidth)
    if (Number.isFinite(bw)) out.borderWidth = clamp(Math.round(bw), num3[0], num3[1])
    var shadow = typeof raw.shadow === 'string' ? raw.shadow.trim() : ''
    if (shadow.length <= 96) out.shadow = shadow
    var bg = typeof raw.background === 'string' ? raw.background.trim() : ''
    if (bg.length <= 48) out.background = bg
    return out
  }

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
    /* 挖掘循环的 4 个变体：原版就是随机轮播这几个，只听一个会明显「卡带」。
       对应 MC 的 `block.stone.hit`（`step/stone1-6`），这里用 `dig/stone1-4`。 */
    dig: ['dig1.ogg', 'dig2.ogg', 'dig3.ogg', 'dig4.ogg'],
    /* 方块被敲碎。对应 MC 的 `block.stone.break`（`dig/stone1-4`）；
       本地这组是从 `random/glass1-3` 来的，比 `random/break` 更贴「碎成渣」。 */
    block: ['glass1.ogg', 'glass2.ogg', 'glass3.ogg'],
    /* 工具耐久耗尽 —— 也就是「镐子碎了」。对应 MC 的 `entity.item.break`
       （`random/break`）。**这个不能每次挖穿都响**，见下面 PICKAXE_DURABILITY。 */
    item: ['break.ogg'],
  }

  /** 挖掘声两次之间的间隔。原版大概每 0.2 秒响一下，210ms 稍慢一点更耐听。 */
  var DIG_INTERVAL_MS = 210

  /** 同时存在的 Audio 元素上限，防止长按很久后元素越积越多。 */
  var MAX_VOICES = 6

  /* ---------------- 木镐耐久：碎裂声为什么不是每次都响 ----------------
   *
   * `break.ogg` 的来源是 `random/break`，在 MC 里挂在 `entity.item.break` 上 ——
   * 那是**手上一件工具用坏了**的声音，不是方块被敲碎的声音。原来每次挖穿都播它，
   * 等于每挖穿一个方块就报废一把镐子，而方块碎裂本身反倒没有专门的音。
   *
   * 木镐耐久：Java 版 59 点、基岩版 60 点（minecraft.wiki/w/Wooden_Pickaxe）。
   * 这里取 Java 版的 59 —— 本插件用 1.20.1 Java 版的原版 assets，两者该一致。
   *
   * 所以挖穿拆成两件事：
   *   ① 每一次都播「方块碎了」（block 组）；
   *   ② 每第 59 次**额外**播一声「镐子碎了」（item 组），然后换一把新镐子。
   * ② 是额外的、不是替代 —— 否则普通那 58 次挖穿会一声不响，那才是退化。
   *
   * 计数存 localStorage 而不是宿主的 state 文件：这纯粹是听觉上的连续性，
   * 和「你点了我多少次」那种要给用户看的真实数字不是一回事。放进宿主状态
   * 的话，每跑一次探针都会顺手改掉用户手上这把镐子的磨损度。
   * ---------------------------------------------------------------- */

  /** 一把木镐能挖几下（Java 版口径）。 */
  var PICKAXE_DURABILITY = 59

  /** 耐久存 localStorage 的键。与 LS_KEY（外观/位置）分开，两者生命周期不同。 */
  var LS_DURABILITY = 'dshLuckyBlock.pickaxe'

  function readDurability() {
    try {
      var n = Number(root.localStorage && root.localStorage.getItem(LS_DURABILITY))
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    } catch (e) {
      return 0
    }
  }

  function writeDurability(value) {
    try {
      if (root.localStorage) root.localStorage.setItem(LS_DURABILITY, String(value))
    } catch (e) {
      /* 隐私模式下 localStorage 不可用，忽略 —— 大不了这次刷新后镐子又是新的 */
    }
  }

  /**
   * 挖一下，返回这一下之后这把镐子的状态。
   *
   * 抽成不依赖任何音频对象的纯函数，好让它能被单独测（`tools/pickaxe-check.mjs`）：
   * 边界的 off-by-one（第 59 下坏还是第 60 下坏）是这类计数最容易错的地方。
   */
  function wearPickaxe(used) {
    var next = (Number.isFinite(used) && used > 0 ? Math.floor(used) : 0) + 1
    if (next >= PICKAXE_DURABILITY) return { used: 0, broke: true }
    return { used: next, broke: false }
  }

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
    /* 当前正在播的那首「事件音乐」。与 voices 分开记：
       voices 是所有短音效的池子（挖一下响一声，随时会被挤掉），
       这里只留 playTrack 起的那一个长音频，ESC 要停的是它。 */
    var currentTrack = null
    /* 这一首播完之后要叫醒谁。音乐也是一场「表演」，表演期间方块不该被再点，
       所以它必须有个收场信号 —— 自然播完（ended）和被掐断（haltTrack，ESC
       或换曲）都要发，否则插进去一次音乐就会把方块永久锁死。 */
    var trackEnd = null
    /* 当前这首歌的时间轴歌词（`[{ t, text }]`，t 是**片段内**秒数）。
       放引擎里而不是组件 state：它跟着音轨一起生灭，音轨停了歌词就该停，
       两边各存一份必然出现「歌停了歌词还在滚」。 */
    var trackLyrics = null

    /**
     * 放一个 URL。所有失败静默。
     *
     * `force` 用来绕开 enabled 开关 —— 随机音频事件播的是**内容**本身，
     * 不是音效；被「长按挖掘音效」那个开关顺手关掉的话，这条事件就变成
     * 「点了没反应」，而它在单击池里还占着一份权重。
     */
    function spawn(url, volume, force) {
      if (!force && !enabled) return null
      if (!url) return null
      if (typeof Audio !== 'function') return null
      // 页面在后台时不发声：用户切走了还一直响很烦，浏览器通常也会自己拦掉。
      if (typeof document !== 'undefined' && document.hidden) return null
      try {
        var audio = new Audio(url)
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

    function playFile(name, volume) {
      return spawn(SOUND_BASE + name, volume, false)
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
       * 方块被敲碎的一声。不受挖掘循环状态影响 ——
       * 它是「挖穿了」的报信人，即使循环因为拖走被掐断也该响。
       *
       * 这一声**每次挖穿都有**。原来这里播的是 `break.ogg`（= `random/break`
       * = 工具报废声），语义是错的，见上面木镐耐久那段注释。
       */
      playBreak: function () {
        playFile(pickSound('block', null))
      },
      /**
       * 镐子耐久耗尽的一声（`random/break`）。每挖穿 PICKAXE_DURABILITY 次
       * 才响一次，并且是**叠在** playBreak 上的额外一声，不是替代它。
       */
      playItemBreak: function () {
        playFile(pickSound('item', null))
      },
      /**
       * 播一段曲库里的音频（随机音频事件）。**不受音效开关影响** ——
       * 它播的是这条事件的内容，关掉挖掘音效不该让事件变成「点了没反应」。
       *
       * 同一时刻只留一首：新的一起就把上一首从**正中间**掐掉（不是淡出）。
       * 连点两下本该听到第二首，听到两首叠在一起的噪音属于事故。
       */
      playTrack: function (name, onEnd, lyrics) {
        if (typeof name !== 'string' || name.length === 0) {
          if (typeof onEnd === 'function') onEnd()
          return null
        }
        haltTrack()
        var audio = spawn(AUDIO_BASE + name, 1, true)
        if (!audio) {
          /* spawn 会因为几种「不算错误但也没有声音」的原因退回 null：
             页面在后台、环境里没有 Audio 构造、URL 被判非法。
             这时没有 `ended` 可等，必须当场收场，否则方块永远点不动。 */
          if (typeof onEnd === 'function') onEnd()
          return null
        }
        currentTrack = audio
        /* 歌词与音轨同生灭。用 `Array.isArray` 而不是只看真值：
           宿主那边没做歌词的歌发的是 null，别让一个畸形对象混进来。 */
        trackLyrics = Array.isArray(lyrics) && lyrics.length > 0 ? lyrics : null
        if (typeof onEnd === 'function') {
          trackEnd = onEnd
          if (typeof audio.addEventListener === 'function') {
            /* 自然播完。用 once 语义手动保证：回调里先把 trackEnd 摘掉，
               重复触发也不会叫第二遍。 */
            audio.addEventListener('ended', function () {
              var done = trackEnd
              trackEnd = null
              if (done) done()
            })
            /* 播放被拒（autoplay 策略、解码失败）时 `ended` 永远不会来。
               不接住这条路径，「浏览器不给放」就会变成「方块永久点不动」。 */
            audio.addEventListener('error', function () {
              var done = trackEnd
              trackEnd = null
              if (currentTrack === audio) currentTrack = null
              if (done) done()
            })
          } else {
            /* 没有事件能力（极老的浏览器 / 测试桩）：没人会来报信，
               立刻收场，别把方块锁在「有表演在播」的状态里。 */
            trackEnd = null
            onEnd()
          }
        }
        return audio
      },
      /**
       * 停掉当前音乐（ESC 用）。幂等，没在播时什么都不做。
       * 与 pause 的区别：这里连元素一起放开，再按 ESC 不会重复 pause 同一个东西。
       */
      stopTrack: function () {
        haltTrack()
      },
      hasTrack: function () { return currentTrack !== null },
      /**
       * 当前这一拍该显示哪一句歌词。没有歌词 / 还没到第一句时返回 null。
       *
       * 不给「订阅 + 回调」的用法，让调用方自己轮询：歌词两秒才换一句，
       * 200ms 轮一次就是十几次多余的 `currentTime` 读，代价可忽略；
       * 而回调式要在这个小引擎里再养一条事件总线，还得处理「订阅时音轨已经换了」。
       *
       * `+0.1` 是预判量：LRC 的时间戳标的是**这一句开口的瞬间**，
       * 但人眼读到字需要一两百毫秒，卡着点换会总觉得慢半拍。
       */
      lyricLine: function () {
        if (!currentTrack || !trackLyrics) return null
        var now = Number(currentTrack.currentTime) || 0
        var found = null
        for (var i = 0; i < trackLyrics.length; i += 1) {
          if (trackLyrics[i].t <= now + 0.1) found = trackLyrics[i].text
          else break
        }
        return found
      },
      dispose: function () {
        this.stopDig()
        haltTrack()
        for (var i = 0; i < voices.length; i++) {
          try { voices[i].pause(); voices[i].currentTime = 0 } catch (e) { /* 忽略 */ }
        }
        voices = []
      },
    }

    /* 真正的停播实现。命名与对外的 stopTrack 分开：对外那个是方法，
       同名的函数声明会被 this 遮蔽，读代码时容易看错调用的是哪个。 */
    function haltTrack() {
      var audio = currentTrack
      currentTrack = null
      /* 歌词跟着音轨一起停。不清的话，下一首没歌词的歌会继承上一首的歌词，
         而 lyricLine() 的 `currentTime` 是新的 —— 表现为「换了首歌，字幕还在
         滚上一首的词」。 */
      trackLyrics = null
      /* 掐断也是一种收场：把等在 trackEnd 上的那个回调叫起来。
         先摘再叫 —— 回调里可能又起一首新歌，那会写入新的 trackEnd。 */
      var done = trackEnd
      trackEnd = null
      if (audio) {
        try {
          audio.pause()
          audio.currentTime = 0
        } catch (e) {
          /* 忽略 */
        }
        /* 从 voices 里摘掉，别让它占着格子等下一个音效把它踢出去。 */
        var i = voices.indexOf(audio)
        if (i >= 0) voices.splice(i, 1)
      }
      if (done) done()
    }
  }

  /**
   * 计算右键菜单 / 设置面板的贴靠位置。
   *
   * 面板固定挂在方块「下方」（top = y + size + 6），所以横向必须自适应：
   *  - 方块右侧还放得下面板 → **向右展开**（`left` = 方块 x，最常见）；
   *  - 放不下（方块贴右边缘）→ **向左展开**，右边缘对齐方块右边缘。
   *
   * 用 `right` 而不是 `left` 来实现向左展开：这样面板宽度即使动态变化
   * （内容长短不一），右边缘始终锚在方块右边缘，不会出现「向左展开却溢出」。
   *
   * 返回值 `right` 是「面板右边缘距视口右侧的距离」—— 方块贴右边缘时它是 0，
   * 也就是面板右边缘与方块右边缘齐平，正是我们要的。
   * 唯一的约束是别探出左边界：`anchor` 最大只能到 `width - GUTTER - panelWidth`。
   * 面板比视口还宽时直接贴左边缘（能显示多少算多少，CSS 的 max-width 再兜一层）。
   *
   * @param geometry 当前方块几何 { x, y, size }
   * @param panelWidth 面板宽度（px）
   * @returns { left?: number, right?: number } 两者恰有一个非 null
   */  function anchorBelow(geometry, panelWidth) {
    var width = root.innerWidth || 1280
    var GUTTER = 8
    if (panelWidth >= width - GUTTER * 2) {
      return { left: 0, right: null }
    }
    // 向右展开放得下就用它 —— 这是最常见的情况，也最符合「菜单跟着方块」的直觉。
    if (geometry.x + panelWidth <= width - GUTTER) {
      return { left: geometry.x, right: null }
    }
    var anchor = width - (geometry.x + geometry.size)
    var maxAnchor = width - GUTTER - panelWidth
    if (anchor > maxAnchor) anchor = maxAnchor
    if (anchor < 0) anchor = 0
    return { left: null, right: anchor }
  }

  /* ---------------------------------------------------------------- *
   * 挖掘裂纹 + 破碎粒子：长按方块时逐级叠加原版裂纹帧，挖满后炸成像素碎片
   * ---------------------------------------------------------------- */

  /** 长按挖满所需时长（毫秒）。够长才不会误触。 */
  var BREAK_MS = 1400
  /** 位移超过这个像素数就判定为「拖动」而非「挖掘」。 */
  var DRAG_THRESHOLD = 5

  /**
   * 这一次 pointerup 算不算一次「单击」（纯函数，便于单测）。
   *
   * **第一条就是 `!press` 直接 false**，这是本函数存在的全部理由。
   * 曾经四条判定都写成「没有记录就放行」（`!press || ...`），看起来更宽容，
   * 实际把「这一轮按压我们根本没登记过」当成了合格：
   * onPointerDown 首行是 `if (event.button !== 0) return`，右键压根不进登记，
   * 于是右键松开时 press 为 null → 四条全真 → 既弹出菜单又抽一次随机事件。
   *
   * 正确语义是「只有我们登记过的左键按压才可能产生单击」，而不是
   * 「所有看起来没毛病的按压都产生单击」。前者是白名单，后者是黑名单。
   *
   * `event.button` 用 Number.isFinite 判断而不是直接 `!== 0`：
   * 某些合成事件不带 button（undefined），那不该被当成右键；
   * 真的报了非 0（右键 2、中键 1）才拒绝。
   */
  function isClickRelease(event, press, drag) {
    if (!press) return false
    if (event) {
      if (event.type !== 'pointerup') return false
      if (Number.isFinite(event.button) && event.button !== 0) return false
      if (press.pointerId !== event.pointerId) return false
    }
    if (press.fired === true) return false
    if (drag && drag.moved === true) return false
    return true
  }

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
    var look = normalizeLook(stored)
    var size = look.size
    var width = root.innerWidth || 1280
    var height = root.innerHeight || 800
    var fallback = { x: clamp(width - size - 24, 0, Math.max(0, width - size)), y: clamp(Math.floor(height * 0.28), 0, Math.max(0, height - size)), size: size, locked: false }
    if (!stored) return fallback
    return {
      x: clamp(Number(stored.x ?? fallback.x), 0, Math.max(0, width - size)),
      y: clamp(Number(stored.y ?? fallback.y), 0, Math.max(0, height - size)),
      size: size,
      locked: stored.locked === true,
      look: look,
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
  var LUCKY_BLOCK_FACE_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAKMGlDQ1BJQ0MgUHJvZmlsZQAAeJydlndUVNcWh8+9d3qhzTAUKUPvvQ0gvTep0kRhmBlgKAMOMzSxIaICEUVEBBVBgiIGjIYisSKKhYBgwR6QIKDEYBRRUXkzslZ05eW9l5ffH2d9a5+99z1n733WugCQvP25vHRYCoA0noAf4uVKj4yKpmP7AQzwAAPMAGCyMjMCQj3DgEg+Hm70TJET+CIIgDd3xCsAN428g+h08P9JmpXBF4jSBInYgs3JZIm4UMSp2YIMsX1GxNT4FDHDKDHzRQcUsbyYExfZ8LPPIjuLmZ3GY4tYfOYMdhpbzD0i3pol5IgY8RdxURaXky3iWyLWTBWmcUX8VhybxmFmAoAiie0CDitJxKYiJvHDQtxEvBQAHCnxK47/igWcHIH4Um7pGbl8bmKSgK7L0qOb2doy6N6c7FSOQGAUxGSlMPlsult6WgaTlwvA4p0/S0ZcW7qoyNZmttbWRubGZl8V6r9u/k2Je7tIr4I/9wyi9X2x/ZVfej0AjFlRbXZ8scXvBaBjMwDy97/YNA8CICnqW/vAV/ehieclSSDIsDMxyc7ONuZyWMbigv6h/+nwN/TV94zF6f4oD92dk8AUpgro4rqx0lPThXx6ZgaTxaEb/XmI/3HgX5/DMISTwOFzeKKIcNGUcXmJonbz2FwBN51H5/L+UxP/YdiftDjXIlEaPgFqrDGQGqAC5Nc+gKIQARJzQLQD/dE3f3w4EL+8CNWJxbn/LOjfs8Jl4iWTm/g5zi0kjM4S8rMW98TPEqABAUgCKlAAKkAD6AIjYA5sgD1wBh7AFwSCMBAFVgEWSAJpgA+yQT7YCIpACdgBdoNqUAsaQBNoASdABzgNLoDL4Dq4AW6DB2AEjIPnYAa8AfMQBGEhMkSBFCBVSAsygMwhBuQIeUD+UAgUBcVBiRAPEkL50CaoBCqHqqE6qAn6HjoFXYCuQoPQPWgUmoJ+h97DCEyCqbAyrA2bwAzYBfaDw+CVcCK8Gs6DC+HtcBVcDx+D2+EL8HX4NjwCP4dnEYAQERqihhghDMQNCUSikQSEj6xDipFKpB5pQbqQXuQmMoJMI+9QGBQFRUcZoexR3qjlKBZqNWodqhRVjTqCakf1oG6iRlEzqE9oMloJbYC2Q/ugI9GJ6Gx0EboS3YhuQ19C30aPo99gMBgaRgdjg/HGRGGSMWswpZj9mFbMecwgZgwzi8ViFbAGWAdsIJaJFWCLsHuxx7DnsEPYcexbHBGnijPHeeKicTxcAa4SdxR3FjeEm8DN46XwWng7fCCejc/Fl+Eb8F34Afw4fp4gTdAhOBDCCMmEjYQqQgvhEuEh4RWRSFQn2hKDiVziBmIV8TjxCnGU+I4kQ9InuZFiSELSdtJh0nnSPdIrMpmsTXYmR5MF5O3kJvJF8mPyWwmKhLGEjwRbYr1EjUS7xJDEC0m8pJaki+QqyTzJSsmTkgOS01J4KW0pNymm1DqpGqlTUsNSs9IUaTPpQOk06VLpo9JXpSdlsDLaMh4ybJlCmUMyF2XGKAhFg+JGYVE2URoolyjjVAxVh+pDTaaWUL+j9lNnZGVkLWXDZXNka2TPyI7QEJo2zYeWSiujnaDdob2XU5ZzkePIbZNrkRuSm5NfIu8sz5Evlm+Vvy3/XoGu4KGQorBToUPhkSJKUV8xWDFb8YDiJcXpJdQl9ktYS4qXnFhyXwlW0lcKUVqjdEipT2lWWUXZSzlDea/yReVpFZqKs0qySoXKWZUpVYqqoypXtUL1nOozuizdhZ5Kr6L30GfUlNS81YRqdWr9avPqOurL1QvUW9UfaRA0GBoJGhUa3RozmqqaAZr5ms2a97XwWgytJK09Wr1ac9o62hHaW7Q7tCd15HV8dPJ0mnUe6pJ1nXRX69br3tLD6DH0UvT2693Qh/Wt9JP0a/QHDGADawOuwX6DQUO0oa0hz7DecNiIZORilGXUbDRqTDP2Ny4w7jB+YaJpEm2y06TX5JOplWmqaYPpAzMZM1+zArMus9/N9c1Z5jXmtyzIFp4W6y06LV5aGlhyLA9Y3rWiWAVYbbHqtvpobWPNt26xnrLRtImz2WczzKAyghiljCu2aFtX2/W2p23f2VnbCexO2P1mb2SfYn/UfnKpzlLO0oalYw7qDkyHOocRR7pjnONBxxEnNSemU73TE2cNZ7Zzo/OEi55Lsssxlxeupq581zbXOTc7t7Vu590Rdy/3Yvd+DxmP5R7VHo891T0TPZs9Z7ysvNZ4nfdGe/t57/Qe9lH2Yfk0+cz42viu9e3xI/mF+lX7PfHX9+f7dwXAAb4BuwIeLtNaxlvWEQgCfQJ3BT4K0glaHfRjMCY4KLgm+GmIWUh+SG8oJTQ29GjomzDXsLKwB8t1lwuXd4dLhseEN4XPRbhHlEeMRJpEro28HqUYxY3qjMZGh0c3Rs+u8Fixe8V4jFVMUcydlTorc1ZeXaW4KnXVmVjJWGbsyTh0XETc0bgPzEBmPXM23id+X/wMy421h/Wc7cyuYE9xHDjlnIkEh4TyhMlEh8RdiVNJTkmVSdNcN24192Wyd3Jt8lxKYMrhlIXUiNTWNFxaXNopngwvhdeTrpKekz6YYZBRlDGy2m717tUzfD9+YyaUuTKzU0AV/Uz1CXWFm4WjWY5ZNVlvs8OzT+ZI5/By+nL1c7flTuR55n27BrWGtaY7Xy1/Y/7oWpe1deugdfHrutdrrC9cP77Ba8ORjYSNKRt/KjAtKC94vSliU1ehcuGGwrHNXpubiySK+EXDW+y31G5FbeVu7d9msW3vtk/F7OJrJaYllSUfSlml174x+6bqm4XtCdv7y6zLDuzA7ODtuLPTaeeRcunyvPKxXQG72ivoFcUVr3fH7r5aaVlZu4ewR7hnpMq/qnOv5t4dez9UJ1XfrnGtad2ntG/bvrn97P1DB5wPtNQq15bUvj/IPXi3zquuvV67vvIQ5lDWoacN4Q293zK+bWpUbCxp/HiYd3jkSMiRniabpqajSkfLmuFmYfPUsZhjN75z/66zxailrpXWWnIcHBcef/Z93Pd3Tvid6D7JONnyg9YP+9oobcXtUHtu+0xHUsdIZ1Tn4CnfU91d9l1tPxr/ePi02umaM7Jnys4SzhaeXTiXd272fMb56QuJF8a6Y7sfXIy8eKsnuKf/kt+lK5c9L1/sdek9d8XhyumrdldPXWNc67hufb29z6qv7Sern9r6rfvbB2wGOm/Y3ugaXDp4dshp6MJN95uXb/ncun572e3BO8vv3B2OGR65y747eS/13sv7WffnH2x4iH5Y/EjqUeVjpcf1P+v93DpiPXJm1H2070nokwdjrLHnv2T+8mG88Cn5aeWE6kTTpPnk6SnPqRvPVjwbf57xfH666FfpX/e90H3xw2/Ov/XNRM6Mv+S/XPi99JXCq8OvLV93zwbNPn6T9mZ+rvitwtsj7xjvet9HvJ+Yz/6A/VD1Ue9j1ye/Tw8X0hYW/gUDmPP8uaxzGQAAAjdJREFUeNqF072LXFUYBvDfuffOXWfWZMiuO6YQViz8KILVCmlFBDv/BwthBUFBS+0sk1ZLsbG0EVLYB9xWAmFBM7rJ4n5kNpPZzMedc47FHdysjW95zvOc5+PlhN8+Ws8iZc1aP6jWg7ofhDUsydMsRMqN9qysKdeCIjD5M6s2Xy9d//R307s79Dfo9ahKIGeaBWrKfHF2eKB7c8/k29dUxRUteXOLwY0WtByuwIm6SwoUBWnJ4gmbW6Z3d+Qiq8oSb73r+em+9KP/zvTgwzZT0aUX6b0s3DtV5Yh0TLFFeqS78QMYfr79L3n71lD3lZ9M/3qfhNjGKSqqUCLUpEccH7JxoTr44p1LLo5u3zf4coc8J5ISRQyIc5oJV6/53ylT62A2lpusKgLKNeILWJref8/Rd/steDzSfeOXyw+kAg2LOaja1pfU15kdMLhh8PGqzBX5+T6cnbEccz6RzqlC66vtAZZP2XyVvLgkPPj6gxaXZq16v1G+uKcIUPbRofcm1SblFTrXTM8+u1BPSHWLaxrGf1ue5lWEsE7W7jnUKzcd3f5Xtm/dNj3ZJWJ2zGjIaMT5UpxmRVEGiiX5MWm8st65vL5vfubxAx7u8+BQfPhMPl0QsyKFzL07nOwTR4QZaUQamZ7sXkQ4PebJUxTKTiFUpTKFNkL35l77H7od5s9aQkzkbPDJ28QZw0POGnESxVnW3/3D0a/bwuj7qzkgR0RiQ0CBuFpEVVM3gRzaLuZRXrT3/wAlgfXOpThi4AAAAABJRU5ErkJggg=='

  /**
   * CSS 现画的几种 Minecraft 方块面。为什么不全内联贴图：
   * 一张 16×16 PNG 的 data URI 约 1.2 KB，内联 5 张 ≈ 6 KB，对启动 bundle
   * 不痛不痒 —— 但 CSS 画的能跟着 `radius` / `border` 一起变形，贴图不行，
   * 而且用户可以直接改颜色。
   *
   * 每个图案返回给「正面那个 div」的内联样式（外层尺寸由调用方给）。
   */
  var FACE_PATTERNS = {
    command: {
      background: '#b46ac8',
      /* 四角暗像素块，模拟原版命令方块的立体感。 */
      boxShadow: 'inset 6px 6px 0 rgba(0,0,0,.16), inset -6px -6px 0 rgba(255,255,255,.14)',
      content: '?',
      fontSize: '0.5em',
      color: '#fff',
      fontWeight: 700,
      textAlign: 'center',
    },
    tnt: {
      background: 'linear-gradient(#c8392f 0 26%, #f2f2f2 26% 74%, #c8392f 74% 100%)',
      boxShadow: 'inset 0 0 0 2px rgba(0,0,0,.3)',
      content: 'TNT',
      fontSize: '0.3em',
      color: '#1a1a1a',
      letterSpacing: '1px',
      textAlign: 'center',
      lineHeight: '3.6em',
    },
    pumpkin: {
      background: 'linear-gradient(#e08a1e, #c4751a)',
      boxShadow: 'inset 0 0 0 2px rgba(120,60,0,.45)',
      content: '',
      textAlign: 'center',
    },
  }

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

  /**
   * 方块正面元素的 tag + props。抽出来是为了 tags 三元不至于把
   * 「用哪个 tag」和「用什么样式」搅在一起读。
   *
   * 返回 { tag, props }：
   *  - lucky / custom       → 'img'（像素硬边 + 缩放过渡；custom 缺图时退回 lucky）
   *  - command / tnt / ... → 'div'（CSS 图案，content 用 before 画）
   */
  function faceFace(geometry, isDragging) {
    var look = geometry.look || normalizeLook(null)
    var transform = isDragging ? 'scale(.92)' : 'scale(1)'
    var transition = 'transform .12s ease'
    if (look.face === 'custom' && look.image) {
      return {
        tag: 'img',
        props: {
          src: look.image,
          alt: '',
          draggable: false,
          style: Object.assign(luckyBlockFaceStyle(geometry.size), {
            transform: transform,
            transition: transition,
          }),
        },
      }
    }
    var pattern = FACE_PATTERNS[look.face]
    if (!pattern) {
      return {
        tag: 'img',
        props: {
          src: LUCKY_BLOCK_FACE_URI,
          alt: '',
          draggable: false,
          style: Object.assign(luckyBlockFaceStyle(geometry.size), {
            transform: transform,
            transition: transition,
          }),
        },
      }
    }
    return {
      tag: 'div',
      props: {
        draggable: false,
        /* CSS 图案的文字层：字号 / 字色 / 居中都在 pattern 里，
           这里只补上「撑满外层」和「不被选中」。 */
        style: Object.assign({}, pattern, {
          width: geometry.size + 'px',
          height: geometry.size + 'px',
          boxSizing: 'border-box',
          transform: transform,
          transition: transition,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          overflow: 'hidden',
        }),
      },
    }
  }

  /* 方块正面图案的展示名。只服务设置面板，不参与任何逻辑判断。 */
  var FACE_OPTIONS = [
    ['lucky', '幸运方块', 'Lucky block'],
    ['command', '命令方块', 'Command block'],
    ['tnt', 'TNT 方块', 'TNT'],
    ['pumpkin', '南瓜', 'Pumpkin'],
    ['custom', '自定义图片', 'Custom image'],
  ]

  /* 设置面板宽度。抽成常量是因为 anchorBelow() 的翻转判据要拿同一个数，
     两处各写一个 300 的话，改面板宽度时翻转阈值会悄悄失配
     （症状：方块贴右边缘时面板左侧露出一条缝，或者整块跑到视口外）。 */
  var PANEL_WIDTH = 320

  /** 面板里的分组标题。抽出来是为了下面三大块的长度对齐、读起来是平的。 */
  function panelGroup(title, children) {
    return h(
      'div',
      { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.12)' } },
      h('div', { style: { color: '#b9b9c8', fontWeight: 600, marginBottom: '6px' } }, title),
      children,
    )
  }

  /** 一行控件：标签在左，控件占满剩余宽度。 */
  function panelRow(label, control) {
    return h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' } },
      h('span', { style: { flex: '0 0 84px', color: '#b9b9c8' } }, label),
      control,
    )
  }

  /** 数值滑杆：旁边跟着当前值，否则用户拖动时看不到数字。 */
  function panelSlider(value, min, max, onChange) {
    return h(
      'span',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' } },
      h('input', {
        type: 'range',
        min: min,
        max: max,
        value: value,
        onChange: onChange,
        style: { flex: '1 1 auto' },
      }),
      h('span', { style: { flex: '0 0 34px', textAlign: 'right', color: '#fff' } }, String(value)),
    )
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
    /* 屏幕正中的「播报」文本：单击事件的正文（冷知识 / 冷笑话 / 今日运气）显示在这里，
       不再挤在方块头顶。与 quip 分开两个 state 是**故意**的 ——
       quip 还要继续承载方块的插话、俏皮话和音频标题，那些贴着头顶才自然；
       而事件正文可能有好几行，头顶 46vw 的小气泡读起来是受罪。
       复用同一个 state 会让「下一次插话把正文顶掉」，很难查。 */
    var broadcast = useState('')
    var centerText = broadcast[0]
    var setCenterText = broadcast[1]
    var broadcastTimer = useRef(0)
    /* 当前这段播报的「收场函数」。放 ref 是因为它有三个入口要共用：
       定时到点、ESC、点击遮罩 —— 还有第四个：被下一段正文顶掉。
       后者最容易被漏：顶掉时如果不把上一段的 onDone 叫醒，
       表演计数就永远回不到 0，方块从此点不动。 */
    var broadcastFinish = useRef(null)
    /* 正在播的表演**计数**。**不复用 isBusy**：isBusy 的语义是「请求在飞」，
       只覆盖 HTTP 那几百毫秒；表演（弹窗 / 蓝屏 / 音乐 / 居中播报）是十几秒到几分钟的事。
       两者混用会让「加载中」与「有演出」互相污染，排查时根本分不清。
       用计数而不是布尔：一次单击可能同时起两样（比如音乐 + 标题），
       任何一样结束都不该提前解锁，必须全部收场才放行下一次点击。
       用 ref 而不是 state：它只被事件回调读，不参与渲染，
       放 state 会让 onRoll 的闭包在每次计数变化时重建，还把 handler 全换一遍。 */
    var showRef = useRef(0)
    /* 当前该显示的歌词。与 centerText 分开：正文是「必须读完才能走」的东西，
       歌词是「一直在变」的陪衬，两者要能同时在场（用户点名要求歌词，
       但音乐事件的标题仍在头顶气泡里，正文框不该被歌词占用）。
       用 state 而不是直接读引擎：歌词要重渲染 DOM，必须走 React 的更新通道。 */
    var lyric = useState('')
    var lyricText = lyric[0]
    var setLyricText = lyric[1]
    var lyricTimer = useRef(0)
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
    /* 本轮按压的「归属」记录，用来把单击与长按分开：
       `{ pointerId, fired }`。挖满时 fired 置 true，松手时就不再算单击；
       反过来没挖满就松手，才是单击。放在 ref 而不是 miningRef 上，是因为
       挖满时 stopMining 会把 miningRef 清空，而 pointerup 还在后面。 */
    var pressRef = useRef(null)
    /* 音效引擎实例。用 ref 而不是 useMemo：它带可变内部状态（voices 池、
       定时器），必须跨渲染存活且只建一次。惰性建（第一次用才 new Audio），
       不在渲染期构造对象。 */
    var soundRef = useRef(null)
    if (!soundRef.current) soundRef.current = createSoundEngine()

    /* 两个 ESC 注销句柄（居中播报、当前音乐）。
       放 ref 而不是闭包变量：它们要在多次渲染之间存活，且 effect 的清理
       函数（只在挂载/卸载时跑）里要读得到最新值。 */
    var broadcastEscape = useRef(null)
    var trackEscape = useRef(null)

    /* 面板里的「外观草稿」。与 geometry.look 分开是**故意的**：
       geometry.look 是「已落盘、方块正在用」的外观，草稿是「用户在面板里拖到一半」的。
       两者混成一个 state 的话，用户拖动滑块就会看到方块一边拖一边变形，
       想撤销都找不到原来的值。草稿只在点「应用」时（下面 applyLook）才合进去。 */
    var draft = useState(null)
    var lookDraft = draft[0]
    var setLookDraft = draft[1]

    /* 科乐美秘技命中后的「金块」状态。
       放 state 而不是 ref：它要改变方块的颜色，必须走 React 的更新通道。
       到期自动复位（下面 konamiTimer），所以它不会永久留着 —— 一个永久的金块
       会让「彩蛋」变成「外观选项」，那是另一回事。 */
    var konamiGold = useState(false)
    var isGolden = konamiGold[0]
    var setIsGolden = konamiGold[1]
    var konamiTimer = useRef(0)

    var persist = useCallback(function (next) {
      setGeometry(next)
      writeStore({
        x: next.x,
        y: next.y,
        locked: next.locked,
        look: next.look || normalizeLook(readStore()),
      })
    }, [setGeometry])

    /**
     * 把面板草稿写回方块。localStorage 一份、geometry state 一份，两边都要更新
     * （geometry 是渲染的真源，localStorage 是跨会话的真源，只写一个会不一致）。
     * 故意**不**通过宿主 —— 外观纯粹是客户端自己的状态，
     * 绕一趟宿主会让「改个圆角」也要等一个 HTTP 往返。
     */
    var applyLook = useCallback(function (next) {
      var look = normalizeLook(next)
      setLookDraft(look)
      setGeometry(function (prev) {
        var merged = {
          x: prev.x,
          y: prev.y,
          size: look.size,
          locked: prev.locked,
          look: look,
        }
        /* 尺寸变大可能把方块挤出视口，重新夹一次再落盘。
           不复用 snapGeometry：那是「松手才吸一次」的逻辑，改尺寸时连续触发
           会把方块在还没停稳的时候反复挪位置。 */
        var width = root.innerWidth || 1280
        var height = root.innerHeight || 800
        merged.x = clamp(merged.x, 0, Math.max(0, width - merged.size))
        merged.y = clamp(merged.y, 0, Math.max(0, height - merged.size))
        writeStore({ x: merged.x, y: merged.y, locked: merged.locked, look: merged.look })
        return merged
      })
    }, [setLookDraft, setGeometry])

    /* 打开设置面板：向宿主取当前配置。
       失败就报错而不静默 —— 用户点了「设置」却什么都没出现会以为是插件坏了。 */
    var openSettings = useCallback(async function () {
      setMenuOpen(false)
      /* 立刻开面板（用 loading 占位）。如果等 fetch 回来才开，
         宿主往返那几十毫秒里点「设置…」是**没有任何反应**的，
         用户会以为按钮坏了、然后再点一次。 */
      setSettingsBusy(true)
      setSettingsOpen({ events: [], configPath: '', sound: true, config: null })
      /* 草稿用当前**已生效**的外观初始化，「恢复默认」才有意义 ——
         否则用户第一次打开面板，草稿是空的，改成半截想反悔都没有基准。 */
      setLookDraft(normalizeLook(readStore()))
      try {
        var data = await callHost('/dsh-lucky-block/settings', { method: 'POST' })
        if (data && data.ok === false) throw new Error((data.error && data.error.message) || '读取设置失败')
        var value = data && data.value ? data.value : { events: [], configPath: '', sound: true, config: null }
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
    }, [setMenuOpen, setSettingsOpen, setSettingsBusy, setError, setLookDraft])

    /**
     * 写事件权重 / 开关到宿主。走**整份替换**：用户在面板上看到的就是全量状态，
     * 把某条的权重删掉（回到默认）就等价于从这张表里少写一行。
     * 失败时面板**不**回滚（区别于 sound 开关的乐观更新）—— 列表十几行，
     * 逐个回滚既容易写错、又会把用户的其它改动一起冲掉；改为一句醒目报错，
     * 让用户自己看到哪几条没存上。
     */
    var saveEventOverrides = useCallback(
      async function (next) {
        if (!settingsOpen) return
        try {
          var res = await callHost('/dsh-lucky-block/save-settings', {
            method: 'POST',
            body: { events: next },
          })
          if (res && res.ok === false) throw new Error((res.error && res.error.message) || '保存失败')
          /* 用宿主回读的值刷新面板：它对每个字段都做了白名单清洗，
             用户写进去的脏值会被静默修正（而不是让面板显示一个没生效的数字）。 */
          if (res && res.value && res.value.events) {
            setSettingsOpen(Object.assign({}, settingsOpen, { eventOverrides: res.value.events }))
          }
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      },
      [settingsOpen, setSettingsOpen, setError],
    )

    /* 音效总开关。乐观更新 + 落盘失败回滚，和设置面板里的任何开关同一套路。 */
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

    /**
     * 登记一场正在进行的「表演」，返回幂等的收场函数。
     *
     * 为什么要有它：单击抽到的四类东西（弹窗、蓝屏、音乐、居中播报）都会在屏幕上
     * 停留十几秒到几分钟。这段时间里方块不该再被点 —— 一次「音乐 + 弹窗」同时
     * 发生，观感就成了事故现场（用户 m18008 第 2 条）。isBusy 护不住这段：
     * 它在 HTTP 返回的那一刻就复位了。
     *
     * 计数而非布尔：一次单击可能同时起几样（音乐 + 标题、蓝屏 + 台词），
     * 少一样收场不该就解锁。
     */
    var beginShow = useCallback(function () {
      showRef.current += 1
      var done = false
      return function endShow() {
        if (done) return
        done = true
        if (showRef.current > 0) showRef.current -= 1
      }
    }, [])

    /**
     * 起一条歌词轮询。没有歌词时什么都不做（也不登记 ESC —— 没有东西可关）。
     *
     * 为什么是轮询而不是 `timeupdate` 事件：`timeupdate` 一秒只发 4 次左右，
     * 且不同浏览器节奏不一；歌词本来两秒才换一句，200ms 轮一次的读开销
     * （`currentTime` 是个同步 getter）比维护一条事件订阅便宜得多。
     *
     * 为什么自己清：音轨可能被 ESC、被下一首歌、被组件卸载掐掉，三条路都不
     * 会主动通知这里。所以轮询每一拍都回头看 `hasTrack()` —— 音轨没了就自己收摊，
     * 不依赖任何外部调用方记得来关它。
     */
    var startLyricPoll = useCallback(function () {
      if (lyricTimer.current) {
        window.clearInterval(lyricTimer.current)
        lyricTimer.current = 0
      }
      var engine = soundRef.current
      if (!engine || !engine.hasTrack()) {
        setLyricText('')
        return
      }
      var tick = function () {
        var current = soundRef.current
        if (!current || !current.hasTrack()) {
          // 音轨已经没了（ESC / 换曲 / 播完）：收摊，别留一条空转的定时器。
          if (lyricTimer.current) {
            window.clearInterval(lyricTimer.current)
            lyricTimer.current = 0
          }
          setLyricText('')
          return
        }
        var next = current.lyricLine()
        setLyricText(next || '')
      }
      tick()
      lyricTimer.current = window.setInterval(tick, 200)
    }, [setLyricText])

    /**
     * 在屏幕正中播报一段文本（单击事件的正文）。
     * 半透明底 + 居中，长文本自动换行，最长可显示 30 秒。
     * 点 anywhere 也可以立刻关掉（见下面居中文本框的 onClick）。
     *
     * `onDone` 是**任何**方式收场都要走的：定时到点、ESC、点击、被下一段顶掉。
     * 表演阻塞（beginShow/endShow）靠它解锁，漏一条路就等于永久锁死方块。
     */
    var broadcastText = useCallback(function (text, ms, onDone) {
      if (typeof text !== 'string' || text.length === 0) return
      /* 上一段还没收场就先把它收掉（并叫醒它的 onDone），
         否则计数会残留 —— 连点两次就再也回不到 0。 */
      if (broadcastFinish.current) broadcastFinish.current()
      setCenterText(text)
      var finished = false
      function finish() {
        if (finished) return
        finished = true
        if (broadcastFinish.current === finish) broadcastFinish.current = null
        if (broadcastTimer.current) {
          window.clearTimeout(broadcastTimer.current)
          broadcastTimer.current = 0
        }
        if (broadcastEscape.current) {
          var unregister = broadcastEscape.current
          broadcastEscape.current = null
          unregister()
        }
        setCenterText('')
        if (typeof onDone === 'function') onDone()
      }
      /* 按 ESC 收掉这段正文。登记在「显示」这一侧而不是 onRoll 里：
         播报有多种来源（单击正文、音频标题），只有真显示了才该吞 ESC，
         否则点一次没内容的表演也会把 ESC 锁住 30 秒。 */
      broadcastEscape.current = registerEscape(finish)
      broadcastFinish.current = finish
      broadcastTimer.current = window.setTimeout(finish, Number(ms) > 0 ? Number(ms) : 30000)
    }, [setCenterText])

    // 组件消失时别让定时器对着已卸载的组件 setState。
    useEffect(function () {
      return function () {
        if (quipTimer.current) window.clearTimeout(quipTimer.current)
        if (broadcastTimer.current) window.clearTimeout(broadcastTimer.current)
        /* 歌词轮询也必须停：它每一拍都 setLyricText，组件没了还跑就是
           对着卸载的组件 setState（React 会警告，且这条 interval 不会被回收）。 */
        if (lyricTimer.current) window.clearInterval(lyricTimer.current)
        if (broadcastEscape.current) {
          broadcastEscape.current()
          broadcastEscape.current = null
        }
        if (trackEscape.current) {
          trackEscape.current()
          trackEscape.current = null
        }
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

    /* 科乐美秘技：挂在 window 的 keydown 上。
       为什么是 window 而不是方块节点：方块不一定有焦点（用户可能刚在输入框里
       打字），而这串指令的乐趣就在于「在任何地方按都能触发」。
       为什么不 preventDefault：方向键在 dsh 里可能用于移动光标 / 选会话，
       为一个彩蛋吃掉这些键不划算；而且彩蛋本来就该是「顺手用到的键」。 */
    useEffect(function () {
      var onKey = createKonami(function () {
        setIsGolden(true)
        say(t('你居然知道这个。', 'You actually knew that one.'), 3200)
        if (soundRef.current) soundRef.current.playBreak()
        if (konamiTimer.current) window.clearTimeout(konamiTimer.current)
        konamiTimer.current = window.setTimeout(function () {
          konamiTimer.current = 0
          setIsGolden(false)
        }, 4000)
      })
      root.addEventListener('keydown', onKey, true)
      return function () {
        root.removeEventListener('keydown', onKey, true)
        if (konamiTimer.current) window.clearTimeout(konamiTimer.current)
      }
    }, [say, setIsGolden])

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
            look: prev.look || normalizeLook(readStore()),
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
     * 掷一次骰子。`trigger` 决定宿主从哪个池里抽：
     *  - `'click'` 左键单点，纯本地事件（弹窗 / 蓝屏 / 抽签 / 冷知识 / 冷笑话 / 音频），零 token；
     *  - `'hold'` 长按挖满，会开新会话调 AI（论文 / 新闻 / 待办）。
     * 默认 `'click'`：键盘 Enter/Space 这类「轻按」不该花 token。
     */
    var onRoll = useCallback(async function (trigger) {
      if (isBusy) return
      /* 上一场还没收场就不再起新的（用户要求：同时出现音乐和弹窗太嘈杂）。
         这里必须**说一句话**而不是静默 return —— 静默会让人以为方块坏了。
         走 `say`（会自动消失的台词气泡）而不是 `setError`：这条是「等一下」的
         状态说明，不是需要用户点掉的错误；用报错气泡的话它会一直挂着，
         比上一场演出本身还碍事。 */
      if (showRef.current > 0) {
        say(t('别急。上一场还没收场，按 ESC 可以提前结束。', 'Not yet. The last show is still running - press ESC to end it.'))
        return
      }
      var pool = trigger === 'hold' ? 'hold' : 'click'
      setBusy(true)
      /* 头顶气泡**只**承载报错（用户要求：「头顶除了报错信息其他什么都不要出现」）。
         进度、成功、会话 ID 这些一律不往头顶写 —— 有视觉表演的事件自己会演出，
         没有视觉表演的事件由新会话的内容承担反馈。 */
      setError('')
      /* 本次单击开出的所有表演的收场函数。正常路径下它们各自等自己的收场信号；
         catch 分支里必须全部放掉 —— 已经 beginShow() 之后又抛错的话，那个
         endShow 永远等不到调用，方块会被永久锁住（只能重启 dsh 才好）。 */
      var begun = []
      try {
        var result = await callHost(ROLL_PATH, { method: 'POST', body: { trigger: pool } })
        var value = result && result.value ? result.value : null
        /* 有视觉表演的事件（弹窗 / 蓝屏）：直接在本地播放，与新会话并行。 */
        if (value && value.visual && typeof value.visual === 'object') {
          var visual = value.visual
          if (visual.kind === 'bluescreen') {
            /* 先登记再播放：蓝屏是异步演出，等它开演再登记会漏掉
               「已经开演但还没回到底部代码」的那几毫秒。 */
            var bluescreenEnd = beginShow()
            begun.push(bluescreenEnd)
            runBluescreen(
              Number(visual.durationMs) || 60000,
              Array.isArray(visual.lines) ? visual.lines : null,
              bluescreenEnd,
              /* 宿主抽好的那张脸。三个字段都可能是 undefined，
                 runBluescreen 内部逐项兜底。 */
              {
                background: visual.background,
                heading: visual.heading,
                lines: visual.lines,
              },
            )
          } else if (visual.kind === 'popups') {
            var popupsEnd = beginShow()
            begun.push(popupsEnd)
            runPopupShow(Number(visual.count) || 24, Number(visual.intervalMs) || 450, popupsEnd, {
              titles: visual.titles,
              bodies: visual.bodies,
            })
          } else if (visual.kind === 'runaway') {
            /* 动效三兄弟和上面两个的区别：它们**没有内容**，所以不产生台词、
               不产生正文，只在屏幕上动一下。收场函数必须挂在 beginShow 上，
               否则「上一场还没收场」会把方块锁到刷新为止。 */
            var runawayEnd = beginShow()
            begun.push(runawayEnd)
            runRunaway(nodeRef.current, Number(visual.durationMs) || 2600, runawayEnd)
          } else if (visual.kind === 'fake-cursor') {
            var cursorEnd = beginShow()
            begun.push(cursorEnd)
            runFakeCursor(Number(visual.count) || 5, Number(visual.durationMs) || 4200, cursorEnd)
          } else if (visual.kind === 'shake') {
            var shakeEnd = beginShow()
            begun.push(shakeEnd)
            runShake(Number(visual.durationMs) || 900, shakeEnd)
          }
        }
        /* 音频事件：宿主抽好了曲目，这里直接播。
           走 playTrack 而不是 playFile —— 它不受「挖掘音效」开关影响，
           因为这个开关管的是方块自己的动静，不是事件内容。 */
        if (value && value.audio && typeof value.audio.file === 'string' && value.audio.file.length > 0) {
          var musicEnd = beginShow()
          begun.push(musicEnd)
          if (soundRef.current) soundRef.current.playTrack(value.audio.file, musicEnd, value.audio.lyrics)
          else musicEnd()
          /* ESC 停音乐。只在真起了音轨时登记 —— 没声音可停的场合
             不该吞掉用户那一下 ESC。 */
          if (trackEscape.current) {
            trackEscape.current()
            trackEscape.current = null
          }
          if (soundRef.current && soundRef.current.hasTrack()) {
            trackEscape.current = registerEscape(function () {
              trackEscape.current = null
              if (soundRef.current) soundRef.current.stopTrack()
            })
          }
          if (typeof value.audio.title === 'string' && value.audio.title.length > 0) {
            say(value.audio.title)
          }
          /* 歌词滚起来。放在 say 之后：标题先出现，下一句话才接上字幕，
             顺序反过来的话第一秒会出现「字幕已经在滚、但不知道在放什么」。 */
          startLyricPoll()
        }
        /* 本地内容（冷知识 / 冷笑话 / 今日运气）：宿主直接抽好了正文，
           像聊天消息一样显示出来。
           走**屏幕居中**的播报框，不贴方块头顶 —— 这些正文动辄三行以上，
           头顶那个 46vw 的小气泡读起来是受罪（用户 m11192 的要求）。
           这条**必须在视觉之后**判断 —— 视觉事件的内容是演出来的，没有 text。 */
        if (value && typeof value.localText === 'string' && value.localText.length > 0) {
          var textEnd = beginShow()
          begun.push(textEnd)
          broadcastText(value.localText, 30000, textEnd)
        }
        /* 台词：视觉事件的俏皮话由宿主本地随机挑好（零 token），这里只负责显示。
           agent 事件也带一句 —— 方块先开口，会话那边再慢慢跑。 */
        if (value && typeof value.quip === 'string' && value.quip.length > 0) {
          say(value.quip)
        }
      } catch (error) {
        /* 出错就把这一轮登记过的表演全放掉。endShow 是幂等的，已经正常收场的
           再叫一次也不会重复扣减 —— 宁可提前解锁，也不要永久锁死。 */
        for (var bi = 0; bi < begun.length; bi += 1) begun[bi]()
        setError(`${t('方块启动失败', 'Block failed')}：${String((error && error.message) || error)}`)
      } finally {
        setBusy(false)
        setChargeLevel(0)
      }
    }, [isBusy, setBusy, setError, setChargeLevel, say, broadcastText, beginShow, startLyricPoll])

    /**
     * 按下即开始挖掘：不移动地按住 BREAK_MS 方块碎裂。
     * 位移一旦超过 DRAG_THRESHOLD 就取消挖掘转成拖动，
     * 这样「想把方块拖走」不会误触发随机事件。
     *
     * **单击与长按的区分**就在这里埋点：
     *  - 挖满 → 把 pressRef 的 fired 置 true 并触发 `onRoll('hold')`（调 AI 的那一池）；
     *  - 没挖满就松手 → endDrag 里看到 `fired === false` 且没拖过，
     *    触发 `onRoll('click')`（纯本地那一池）。
     * 两者互斥，所以一次按压最多只出一次事件。
     */
    var onPointerDown = useCallback(function (event) {
      if (event.button !== 0) return
      var node = nodeRef.current
      var rect = node ? node.getBoundingClientRect() : null
      var originX = event.clientX
      var originY = event.clientY

      /* 记下这一轮按压的归属。**不能**用 mining job 上的字段代替：
         挖满时 stopMining 会把 miningRef 清空，而 pointerup 还在后面。 */
      pressRef.current = { pointerId: event.pointerId, fired: false }

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

      // 锁定状态下同样允许长按与单击：锁定只是让它不碍事，不是禁用。
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
          /* 挖满了：这一轮按压已经出过事件，松手时不能再算一次单击。 */
          if (pressRef.current && pressRef.current.pointerId === job.pointerId) {
            pressRef.current.fired = true
          }
          stopMining()
          var node2 = nodeRef.current
          var rect2 = node2 ? node2.getBoundingClientRect() : rect
          if (rect2) shatterBlock(rect2)
          /* 方块碎裂声（用户要求「两种效果都要」的第二半）。
             注意顺序：**先 stopMining 再播** —— stopMining 会 stopDig，
             若反过来的话这声碎裂会跟循环的最后一声叠在一起，听感是「咚咔」粘连。
             也让后续的播放不受 stopDig 影响（它只认 enabled，不认循环状态）。 */
          var axe = wearPickaxe(readDurability())
          writeDurability(axe.used)
          if (soundRef.current) {
            soundRef.current.playBreak()
            /* 耐久耗尽：**叠一声**工具报废音，不是用它替代上一条。
               两声响在一起才像「方块碎了，镐子也废了」；只响后一声的话
               用户会以为方块没碎，而只响前一声则镐子永远用不坏。 */
            if (axe.broke) soundRef.current.playItemBreak()
          }
          onRoll('hold')
        }
      }, 40)

      try {
        node && node.setPointerCapture(event.pointerId)
      } catch (e) {
        /* 某些环境不支持 pointer capture，忽略 */
      }
    }, [geometry.locked, setDragging, setChargeLevel, stopMining, onRoll])

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
        var next = { x: rawX, y: rawY, size: prev.size, locked: prev.locked, look: prev.look || normalizeLook(readStore()) }
        writeStore({ x: next.x, y: next.y, locked: next.locked })
        return next
      })
    }, [geometry.size, setGeometry])

    var endDrag = useCallback(function (event) {
      var job = miningRef.current
      if (job && (!event || job.pointerId === event.pointerId)) stopMining()

      /* ---------------- 单击：与长按互斥的另一半 ---------------- */
      /* 判定规则全部收在 isClickRelease() 里，这里只负责执行它的结论。
         早期版本把这四条写成本地布尔量，且每条都是「没记录就放行」
         （`!press || ...`），于是右键松开时既弹菜单又抽一次事件 ——
         右键从未被 onPointerDown 登记，press 为 null 反而成了合格条件。
         现在第一条是 `if (!press) return false`，未登记=不可能是单击。
         必须放在下面 `if (!state) return` **之前**：锁定态根本不建 dragState，
         放后面会让锁定的方块点不动。 */
      var press = pressRef.current
      if (isClickRelease(event, press, dragState.current)) {
        pressRef.current = null
        onRoll('click')
      } else if (press && (!event || event.type === 'pointerup')) {
        pressRef.current = null
      }

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
        return { x: snapped.x, y: snapped.y, size: prev.size, locked: prev.locked, look: prev.look || normalizeLook(readStore()) }
      })
    }, [setDragging, stopMining, setGeometry, onRoll])

    // 卸载 / 组件消失时必须停掉挖掘定时器，否则会对着已销毁的组件 setState。
    useEffect(function () {
      return function () {
        stopMining()
        /* 音效引擎也要收摊：它自己管着一条 setInterval 和一堆 Audio 元素，
           不 dispose 的话组件没了声音还在响。 */
        if (soundRef.current) soundRef.current.dispose()
      }
    }, [stopMining])

    var look = geometry.look || normalizeLook(null)

    var style = mcBlockStyle(geometry.size, {
      left: `${geometry.x}px`,
      top: `${geometry.y}px`,
      cursor: geometry.locked ? 'pointer' : isDragging ? 'grabbing' : 'pointer',
      // 挖掘时整体轻微提亮（0~100 的挖掘进度）。
      filter: chargeLevel > 0 ? `brightness(${1 + (chargeLevel / 100) * 0.18})` : 'none',
      opacity: isBusy ? 0.85 : 1,
      /* 外观：圆角 / 边框 / 投影 / 底色。四条里哪一条是「关掉」都由用户
         用空串表达（'' = none），所以不能写 `look.shadow || default`，
         否则用户清空后一刷新默认值又回来了。 */
      borderRadius: look.radius ? `${look.radius}px` : undefined,
      border: look.border ? `${look.borderWidth}px solid ${look.border}` : 'none',
      boxShadow: look.shadow || 'none',
      background: look.background || 'transparent',
      transition: isDragging
        ? 'none'
        : `left ${SNAP_MS}ms ease, top ${SNAP_MS}ms ease, box-shadow .15s ease, opacity .15s ease, filter .12s linear`,
    })

    /* 金块：命中科乐美秘技后四秒内，方块整体镀一层金。
       用 filter 的 hue-rotate 而不是换贴图：换贴图要准备第二张 16×16 的图，
       而且用户自定义外观时那张图根本不适用（自定义图会盖掉默认贴图）。
       saturate + hue-rotate 作用在**任何**外观上都成立，包括用户自己的图。 */
    if (isGolden) {
      style.filter = [style.filter && style.filter !== 'none' ? style.filter : '', 'sepia(1) saturate(4.2) hue-rotate(-12deg) brightness(1.18)']
        .filter(Boolean)
        .join(' ')
      style.boxShadow = '0 0 26px rgba(255,198,66,.85), 0 8px 20px rgba(0,0,0,.38)'
    }

    // 裂纹随挖掘进度切到下一张原版 destroy_stage 帧（crackOverlay 里选帧，chargeLevel 为 0 时不渲染）。

    /* ---------------- 屏幕居中的播报框 ---------------- */
    /* 只承载**单击事件的正文**（冷知识 / 冷笑话 / 今日运气）。
       「高透明」的拿捏：底色 alpha 0.62 是既能读清白字、又不至于把背后的内容
       完全糊住的档位；再低（<0.5）白字在浅色主题下会读不清，再高就成实心弹窗了。
       不能做成实心模态框：用户要的是「顺便看见」，不是「必须先关掉它」。
       点击任意处可提前关掉 —— 三十秒足够读完，但不想等就该能立刻消失。 */
    var centerOverlay = centerText
      ? h(
          'div',
          {
            onClick: function () {
              /* 走同一个收场出口（finish）：定时器、ESC 登记、state、onDone
                 一起处理。只清 state 的话那条 ESC 回调还挂在登记表里，
                 之后每一次 ESC 都会被它吞掉，表演计数也不会减。 */
              if (broadcastFinish.current) broadcastFinish.current()
            },
            style: {
              position: 'fixed',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              /* 收下这层自己的点击，别让它穿透到背后的应用界面 ——
                 否则点「关闭播报」会顺手点到背后的输入框里。 */
              pointerEvents: 'auto',
              cursor: 'pointer',
              zIndex: 10000,
            },
          },
          h(
            'div',
            {
              style: {
                background: 'rgba(14,15,22,.62)',
                color: '#f2f2f6',
                border: '1px solid rgba(255,255,255,.14)',
                borderRadius: '12px',
                padding: '16px 22px',
                fontSize: '15px',
                lineHeight: '1.65',
                /* 正文里常有「· 」开头的列表和分段，保留换行才能读。 */
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxWidth: 'min(72vw, 640px)',
                maxHeight: '60vh',
                overflowY: 'auto',
                boxShadow: '0 12px 44px rgba(0,0,0,.45)',
                /* 轻微放大进场：让它看起来是「播报了一条」而不是「一直挂在那儿」。 */
                animation: 'lb-broadcast-in .18s ease',
              },
            },
            centerText,
          ),
        )
      : null

    /* 歌词条：屏幕底部居中，只在不放正文时出现。
       为什么是底部而不是方块头顶：先把位置分开，才不跟方块台词、居中正文抢眼睛；
       而且歌词在底部是所有人对「字幕」的既有预期，不用教。
       为什么 `pointerEvents: 'none'`：它一直在这儿滚，挡住任何点击都会变成
       「听歌的时候点不到按钮」。要关它是按 ESC（停音乐），不是点它。 */
    var lyricOverlay = lyricText && !centerText
      ? h(
          'div',
          {
            style: {
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: '6vh',
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 9997,
            },
          },
          h(
            'div',
            {
              style: {
                maxWidth: 'min(80vw, 760px)',
                padding: '6px 16px',
                borderRadius: '8px',
                background: 'rgba(10,11,18,.55)',
                color: '#f2f2f6',
                fontSize: '17px',
                fontWeight: 500,
                lineHeight: '1.5',
                letterSpacing: '.2px',
                textAlign: 'center',
                textShadow: '0 1px 3px rgba(0,0,0,.6)',
                wordBreak: 'break-word',
                /* 换句时轻微淡入：一句两秒，硬切会像在闪。 */
                animation: 'lb-lyric-in .22s ease',
              },
            },
            lyricText,
          ),
        )
      : null

    return h(
      'div',
      { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9998 } },
      centerOverlay,
      lyricOverlay,
      h(
        'div',
        {
          ref: nodeRef,
          role: 'button',
          tabIndex: 0,
          title: geometry.locked
            ? t(
                '幸运方块（已锁定，右键解锁；单击抽本地事件，长按挖开调 AI）',
                'Lucky block (locked, right-click to unlock; click for a local event, hold to mine)',
              )
            : t(
                '幸运方块（拖动移动；单击抽本地事件，长按挖开调 AI）',
                'Lucky block (drag to move; click for a local event, hold to mine)',
              ),
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
              /* 键盘「按一下」等价于左键单点 —— 走本地池，不开会话、不花 token。
                 要长按那一池，用鼠标按住方块，键盘做不到「按住」这个动作。 */
              onRoll('click')
            }
          },
        },
        /* ---------------- 方块正面 ---------------- */
        /* 用哪张看 face 设置：'lucky' 走内联贴图（<img>，像素硬边）；
           'custom' 走用户给的图（也是 <img>）；其余三种是 CSS 现画的 div，
           好处是能跟着 radius / border 一起变形（贴图做不到）。 */
        (function () {
          var face = faceFace(geometry, isDragging)
          return h(face.tag, face.props)
        })(),
        crackOverlay({ chargeLevel: chargeLevel }, geometry.size),
      ),
      menuOpen
        ? h(
            'div',
            {
              style: (function () {
                var a = anchorBelow(geometry, 160)
                return {
                  position: 'fixed',
                  top: `${geometry.y + geometry.size + 6}px`,
                  /* 贴右边缘时用 right 锚定（向左展开），否则 left 对齐方块。 */
                  left: a.left === null ? undefined : `${a.left}px`,
                  right: a.right === null ? undefined : `${a.right}px`,
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
                }
              })(),
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
              style: (function () {
                var a = anchorBelow(geometry, PANEL_WIDTH)
                return {
                  position: 'fixed',
                  top: `${geometry.y + geometry.size + 6}px`,
                  left: a.left === null ? undefined : `${a.left}px`,
                  right: a.right === null ? undefined : `${a.right}px`,
                  width: `${PANEL_WIDTH}px`,
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
                }
              })(),
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
            /* 音效总开关。面板里现在只剩这一个开关 ——
               以前下面还有一串「这个事件不调用 AI」的勾选框，已经删掉了：
               调不调 AI 现在由**触发方式**决定（单击=本地、长按=AI），
               再留一个开关会和触发方式打架。 */
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
            /* 触发方式说明。只读 —— 它解释的是「为什么单击和长按出来的东西不一样」，
               不是配置项，所以不做成勾选框。 */
            h(
              'div',
              { style: { color: '#b9b9c8', marginBottom: '8px' } },
              t(
                '左键单击：只出本地内容（弹窗、蓝屏、抽签、冷知识、冷笑话、音乐），零 token、瞬时返回。\n长按挖满：调用 AI 干活（写论文、新闻速览、发明个东西）。\n表演随时按 ESC 提前收场。',
                'Left click: local only (popups, blue screen, fortune, trivia, jokes, music) — zero tokens, instant.\nHold to mine: runs the model (paper, news, invent something).\nPress ESC to end any show early.',
              ),
            ),

            /* ---------------- ① 方块外观 ---------------- */
            panelGroup(
              t('方块外观', 'Block appearance'),
              /* 尺寸滑杆。改了会**立刻**改方块本体（不是等保存）——
                 滑块的语义就是「我现在看到的样子」，要用户再多点一次是不必要的摩擦。
                 位置若因尺寸变大被夹回视口内，见 applyLook 里的 clamp。 */
              panelRow(t('大小', 'Size'), (function () {
                var lim = LOOK_LIMITS.size
                return panelSlider(
                  lookDraft.size,
                  lim[0],
                  lim[1],
                  function (e) {
                    applyLook(Object.assign({}, lookDraft, { size: Number(e.target.value) }))
                  },
                )
              })()),
              panelRow(t('形状', 'Shape'), (function () {
                return h(
                  'select',
                  {
                    value: lookDraft.face,
                    onChange: function (e) {
                      applyLook(Object.assign({}, lookDraft, { face: e.target.value }))
                    },
                    style: { flex: '1 1 auto', background: '#20202c', color: '#fff', border: '1px solid rgba(255,255,255,.2)', borderRadius: '4px' },
                  },
                  FACE_OPTIONS.map(function (pair) {
                    return h('option', { key: pair[0], value: pair[0] }, t(pair[1], pair[2]))
                  }),
                )
              })()),
              panelRow(t('圆角', 'Corner'), (function () {
                var lim = LOOK_LIMITS.radius
                return panelSlider(
                  lookDraft.radius,
                  lim[0],
                  lim[1],
                  function (e) {
                    applyLook(Object.assign({}, lookDraft, { radius: Number(e.target.value) }))
                  },
                )
              })()),
              panelRow(t('描边', 'Border'), (function () {
                var lim = LOOK_LIMITS.borderWidth
                return panelSlider(
                  lookDraft.borderWidth,
                  lim[0],
                  lim[1],
                  function (e) {
                    var v = Number(e.target.value)
                    /* 宽度为 0 表示「不要描边」。颜色还没有时给一个可用的默认值，
                       否则用户先把宽度拖到 3 会毫无变化，看起来像滑杆坏了。 */
                    applyLook(
                      Object.assign({}, lookDraft, {
                        borderWidth: v,
                        border: v > 0 && !lookDraft.border ? '#ffffff' : lookDraft.border,
                      }),
                    )
                  },
                )
              })()),
              /* 颜色输入框。颜色**不在** normalizeLook 的白名单里（那里只认字符串长度），
                 这里让用户直接选，靠 <input type=color> 保证格式合法。 */
              panelRow(t('描边色', 'Color'), (function () {
                return h('input', {
                  type: 'color',
                  value: /^#[0-9a-f]{6}$/i.test(lookDraft.border) ? lookDraft.border : '#ffffff',
                  onChange: function (e) {
                    applyLook(Object.assign({}, lookDraft, { border: e.target.value, borderWidth: Math.max(1, lookDraft.borderWidth) }))
                  },
                  style: { flex: '1 1 auto', height: '22px', background: 'none', border: 'none' },
                })
              })()),
              panelRow(t('图片', 'Image'), (function () {
                return h('input', {
                  type: 'text',
                  placeholder: 'https://… 或 data:image/png;base64,…',
                  value: lookDraft.image,
                  onChange: function (e) {
                    var v = e.target.value.trim()
                    /* 只留白名单内的协议。这里**不**回退到默认值 ——
                       回退会让用户每次输错一个字符就看到整段消失，反而更烦躁。 */
                    applyLook(Object.assign({}, lookDraft, { image: v, face: v ? 'custom' : lookDraft.face }))
                  },
                  style: { flex: '1 1 auto', background: '#20202c', color: '#fff', border: '1px solid rgba(255,255,255,.2)', borderRadius: '4px', fontSize: '11px' },
                })
              })()),
              h(
                'div',
                { style: { color: '#7d7d8c', fontSize: '11px', marginTop: '4px' } },
                t(
                  '图片只接受 http(s) 链接或 data:image/…，粘贴后会自动切到「自定义图片」。',
                  'Images accept http(s) URLs or data:image/… only; pasting one switches the shape to Custom.',
                ),
              ),
              /* 恢复默认：把 LOOK_DEFAULTS 原样铺上去。走同一个 applyLook，
                 保证「恢复」和「手动改」经过的校验完全一致。 */
              h(
                'button',
                {
                  style: { marginTop: '6px', background: 'none', color: '#8fb0d0', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px' },
                  onClick: function () { applyLook(LOOK_DEFAULTS) },
                },
                t('恢复默认外观', 'Restore default appearance'),
              ),
            ),

            /* ---------------- ② 事件权重与开关 ---------------- */
            panelGroup(
              t('随机事件', 'Random events'),
              settingsBusy
                ? h('div', { style: { color: '#b9b9c8' } }, t('读取中…', 'Loading…'))
                : h(
                    'div',
                    null,
                    (settingsOpen.events || []).map(function (item) {
                      var current = (settingsOpen.eventOverrides && settingsOpen.eventOverrides[item.id]) || {}
                      return h(
                        'div',
                        {
                          key: item.id,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '4px 0',
                            opacity: current.enabled === false ? 0.45 : 1,
                          },
                        },
                        /* 开关。整行点不了 —— 行里还有滑杆，勾选框单独占一格更稳。 */
                        h('input', {
                          type: 'checkbox',
                          checked: current.enabled !== false,
                          title: t('是否启用', 'Enabled'),
                          onChange: function (e) {
                            var overrides = Object.assign({}, settingsOpen.eventOverrides)
                            var patch = Object.assign({}, overrides[item.id])
                            patch.enabled = e.target.checked
                            /* 关掉时把权重也置 0：宿主按 `weight <= 0` 判定「摘掉」，
                               两个字段都说同一件事，不会出现「权重还在但事件没了」的假象。 */
                            if (!e.target.checked) patch.weight = 0
                            else if (patch.weight === 0) delete patch.weight
                            overrides[item.id] = patch
                            setSettingsOpen(Object.assign({}, settingsOpen, { eventOverrides: overrides }))
                          },
                        }),
                        h(
                          'span',
                          {
                            style: {
                              flex: '1 1 auto',
                              color: item.trigger === 'click' ? '#8fd08f' : '#8fb0d0',
                            },
                            title: item.trigger === 'click' ? t('单击池', 'click pool') : t('长按池', 'hold pool'),
                          },
                          item.title + (item.custom ? t('（自定义）', ' (custom)') : ''),
                        ),
                        h('input', {
                          type: 'number',
                          min: 0,
                          max: 100,
                          step: 1,
                          value: current.weight ?? item.defaultWeight ?? item.weight,
                          onChange: function (e) {
                            var v = Number(e.target.value)
                            var overrides = Object.assign({}, settingsOpen.eventOverrides)
                            var patch = Object.assign({}, overrides[item.id])
                            /* 0 是留给「关掉」的，这里把负数也夹到 0，防止写坏。 */
                            if (!Number.isFinite(v) || v < 0) v = 1
                            patch.weight = Math.min(100, Math.round(v))
                            overrides[item.id] = patch
                            setSettingsOpen(Object.assign({}, settingsOpen, { eventOverrides: overrides }))
                          },
                          style: { width: '44px', background: '#20202c', color: '#fff', border: '1px solid rgba(255,255,255,.2)', borderRadius: '4px', fontSize: '11px' },
                        }),
                        h(
                          'span',
                          { style: { flex: '0 0 44px', color: '#7d7d8c', fontSize: '11px', textAlign: 'right' } },
                          item.trigger === 'click' ? t('单击', 'click') : t('长按', 'hold'),
                        ),
                      )
                    }),
                    h(
                      'div',
                      { style: { color: '#7d7d8c', fontSize: '11px', marginTop: '4px' } },
                      t(
                        '权重越大越容易抽到；0 = 关掉。保存后立刻生效。',
                        'Higher weight = more likely; 0 disables. Takes effect on save.',
                      ),
                    ),
                    h(
                      'button',
                      {
                        style: { marginTop: '6px', background: 'none', color: '#8fb0d0', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px' },
                        onClick: function () { saveEventOverrides(settingsOpen.eventOverrides || {}) },
                      },
                      t('保存事件设置', 'Save event settings'),
                    ),
                  ),
              /* 自定义事件文件。给出路径**和**读取结果 —— 用户加的事件没生效时，
                 「文件在哪、为什么没被读」是两个最需要答案的问题。 */
              settingsOpen.customEventsPath
                ? h(
                    'div',
                    {
                      style: {
                        marginTop: '8px',
                        padding: '6px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        background:
                          settingsOpen.customEvents && settingsOpen.customEvents.reason
                            ? 'rgba(200,80,80,.18)'
                            : 'rgba(90,120,180,.12)',
                        color: '#cfcfdd',
                        wordBreak: 'break-all',
                      },
                    },
                    t('自定义事件：', 'Custom events: '),
                    settingsOpen.customEventsPath,
                    h(
                      'div',
                      { style: { marginTop: '2px' } },
                      settingsOpen.customEvents && settingsOpen.customEvents.reason
                        ? t('⚠ 未生效：', '⚠ ignored: ') + settingsOpen.customEvents.reason
                        : t('已生效 ', 'loaded ') +
                          ((settingsOpen.customEvents && settingsOpen.customEvents.events || []).length) +
                          t(' 条（文件不存在就是没有自定义事件）', ' entry/entries (missing file = none)'),
                    ),
                  )
                : null,
            ),

            /* ---------------- ③ 扩展接口 ---------------- */
            /* 「保留接口」在这里落地成四段可编辑的 JSON。
               刻意不做成「读取 → 校验 → 写回」的编辑器：JSON 精度要求高，
               textarea 让用户直接粘贴反而更稳（不会出现面板格式化成半截）。

               每段都从宿主**取**当前的持久化内容：用户上一段写坏了的话，
               重新打开面板看到的还是那段坏内容，而不是被悄悄替换成默认值。 */
            panelGroup(
              t('扩展接口', 'Extension points'),
              (function () {
                var cfg = settingsOpen.config || {}
                var groups = [
                  ['persona', t('角色性格（persona.json 的字段）', 'Persona (same shape as persona.json)')],
                  ['prompts', t('提示词覆盖（事件 id → 完整提示词）', 'Prompt overrides (event id → full prompt)')],
                ]
                return groups.map(function (pair) {
                  return h(
                    'div',
                    { key: pair[0], style: { marginBottom: '8px' } },
                    h('div', { style: { color: '#b9b9c8', fontSize: '11px', marginBottom: '3px' } }, pair[1]),
                    h('textarea', {
                      value: JSON.stringify(cfg[pair[0]] ?? null, null, 2),
                      readOnly: true,
                      rows: 4,
                      spellCheck: false,
                      placeholder: '{}',
                      style: {
                        width: '100%',
                        boxSizing: 'border-box',
                        background: '#15151d',
                        color: '#cfcfdd',
                        border: '1px solid rgba(255,255,255,.14)',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontFamily: 'ui-monospace, monospace',
                        padding: '6px',
                        resize: 'vertical',
                      },
                    }),
                  )
                })
              })(),
              h(
                'div',
                { style: { color: '#7d7d8c', fontSize: '11px' } },
                t(
                  '这些字段直接写在配置文件的 JSON 里（与事件权重同一个文件）。这里只展示当前值，编辑请直接改文件 —— 见下面路径。',
                  'These live in the same config JSON as the event weights. This shows the current value; edit the file directly — see the path below.',
                ),
              ),
            ),

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

  /* ---------------------------------------------------------------- *
   * ESC 收尾登记表
   * ---------------------------------------------------------------- */

  /**
   * 正在进行的表演各自登记一个「立刻结束」的回调，按 ESC 时一次性全部执行。
   *
   * 为什么是**登记表**而不是「当前表演」单槽：一次单击可能同时起好几样东西
   * （蓝屏 + 台词、音乐 + 标题、长文本 + 气泡），它们彼此独立，ESC 要一并收掉。
   * 单槽会让后起的那一样把先起的挤掉，于是按了 ESC 还剩一个弹窗在屏幕上。
   *
   * 为什么按 ESC 只**吞掉**有登记的按键：没登记时直接放行，dsh 自己的 ESC
   * （关对话框、退出面板）照常工作。有登记时用捕获阶段 + stopPropagation
   * 拦下来，否则底层界面会跟着一起响应，一次按键关两层。
   *
   * 不登记的对象：方块头顶的小气泡。它只占右上角一小块、6 秒自己就消失，
   * 为它吞掉 ESC 会让用户在这 6 秒里关不掉 dsh 的任何东西 —— 那是拿大问题
   * 换小方便。
   */
  var escFinishers = []
  var escBound = false

  function onEscapeKey(event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return
    if (escFinishers.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    /* 先清空再执行：回调里可能又登记新的（比如立刻重播），
       不清空的话它们会被同一次按键顺手收掉。 */
    var pending = escFinishers.slice()
    escFinishers.length = 0
    for (var i = 0; i < pending.length; i += 1) {
      try {
        pending[i]()
      } catch (e) {
        /* 收尾失败没有任何补救手段，静默 */
      }
    }
  }

  /**
   * 登记一个 ESC 收尾回调，返回注销函数。
   * 表演自然结束时必须调用注销函数，否则它会一直挂在表里，
   * 让 ESC 一辈子被这一条（早已结束的）表演吞掉。
   */
  function registerEscape(finisher) {
    if (typeof finisher !== 'function') {
      return function () {}
    }
    if (!escBound) {
      escBound = true
      root.addEventListener('keydown', onEscapeKey, true)
    }
    escFinishers.push(finisher)
    var done = false
    return function unregister() {
      /* 幂等：同一个回调可能在「自然结束」和「ESC 掐断」两条路径上各被调一次，
         第二次不该再去 splice 一遍（那时数组可能已经换了内容）。 */
      if (done) return
      done = true
      var i = escFinishers.indexOf(finisher)
      if (i >= 0) escFinishers.splice(i, 1)
    }
  }

  /**
   * 弹窗表演：连弹 N 个无意义窗口，再按创建顺序倒序关掉。
   * 纯 DOM 覆盖层，不碰 window.open（浏览器会拦截），也不影响 dsh 其他插件。
   *
   * 三种皮轮流上：
   *  - `classic` 老式系统错误框（立体灰、标题栏蓝渐变、带「确定」按钮）——
   *    那种一台机器上同时弹出二十个、关一个又长出两个的年代感；
   *  - `win11` 现代通知卡（圆角、毛玻璃底、左侧图标条、右上角关闭叉）；
   *  - `plain` 朴素提示（原本那种）。
   * 为什么要换皮而不是全用同一种：二十四个长得一模一样的框，看成三秒就只剩
   * 「挡住屏幕了」这一个感受；三种交替才有「这台机器在闹脾气」的意思。
   * 皮的选择走**顺序轮转**（`index % 3`）而不是随机 —— 随机可能连出二十个
   * Win11 卡片，看起来像没做好，而不像巧合。
   *
   * 按 ESC 立刻收场：不等间隔、不等淡出动画，剩下的窗口一次全摘掉。
   * 让用户看完全程才准关，是把表演变成刑罚。
   */
  function runPopupShow(count, intervalMs, onDone, kinds) {
    var opened = []
    var index = 0
    var host = document.body
    /* 宿主把清单发过来了就用宿主的（文案与皮都在 lib/index.js 里配了一份），
       没发就退回本地这份兜底。这样以后加文案不用动客户端。 */
    var spec = kinds && typeof kinds === 'object' ? kinds : null
    var titles = (spec && Array.isArray(spec.titles) && spec.titles.length > 0 ? spec.titles : null) || [
      '系统提示',
      '温馨提示',
      '重要通知',
      '来自好友的消息',
      '中奖提醒',
      '更新提示',
      '订阅确认',
      '缓存清理',
      '彩蛋',
    ]
    var bodies = (spec && Array.isArray(spec.bodies) && spec.bodies.length > 0 ? spec.bodies : null) || [
      '您的操作已成功，但什么也没有发生。',
      '检测到一次愉快的点击，已为您记录并遗忘。',
      '本次弹窗由幸运方块随机生成，不含任何实际内容。',
      '正在为您努力地原地待命……',
      '温馨提示：关掉它不会失去任何东西。',
      '系统运行良好，除了这句话之外。',
      '已收到您的关注，暂无后续。',
      '恭喜！您获得了一次再抽一次的机会。',
    ]
    var KINDS = ['classic', 'win11', 'plain']

    /**
     * 造一个弹窗节点。三种皮共用外边距与定位，只换内里的骨架与配色，
     * 这样「关一个长两个」的节奏感在三种皮之间是一致的。
     */
    function makeNode(kind, title, body) {
      var node = document.createElement('div')
      node.className = 'dsh-lucky-popup'
      var left = 12 + Math.random() * Math.max(20, (root.innerWidth || 800) - 300)
      var top = 12 + Math.random() * Math.max(20, (root.innerHeight || 600) - 160)
      var width = kind === 'plain' ? 220 : 300

      if (kind === 'classic') {
        /* 老式错误框：外框立体（左上亮右下暗）、标题栏蓝渐变、底部带一个
           「确定」按钮。按钮不做功能 —— 演出的一部分是「连按都按不动」，
           给它 onClick 关窗反而破坏了这种无力感。 */
        node.style.cssText = [
          'position:fixed',
          `left:${left}px`,
          `top:${top}px`,
          `width:${width}px`,
          'background:#c0c0c0',
          'color:#000',
          "font:12px 'MS Sans Serif', Tahoma, SimSun, sans-serif",
          'border-top:2px solid #fff',
          'border-left:2px solid #fff',
          'border-right:2px solid #404040',
          'border-bottom:2px solid #404040',
          'box-shadow:0 6px 18px rgba(0,0,0,.35)',
          'z-index:100000',
          'opacity:0',
          'transition:opacity .12s ease',
        ].join(';')

        var bar = document.createElement('div')
        bar.textContent = title
        bar.style.cssText = [
          'background:linear-gradient(90deg,#000080,#1084d0)',
          'color:#fff',
          'font-weight:bold',
          'padding:3px 6px',
          'margin:2px',
          'display:flex',
          'justify-content:space-between',
          'align-items:center',
        ].join(';')
        var x = document.createElement('span')
        x.textContent = '×'
        x.style.cssText = 'background:#c0c0c0;color:#000;padding:0 4px;border:1px outset #fff'
        bar.appendChild(x)
        node.appendChild(bar)

        var msg = document.createElement('div')
        msg.style.cssText = 'padding:14px 12px 10px;display:flex;gap:10px;align-items:flex-start'
        var icon = document.createElement('span')
        icon.textContent = '!'
        icon.style.cssText =
          'flex:0 0 22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:#ffd700;color:#000;font-weight:bold;font-size:14px'
        msg.appendChild(icon)
        var text = document.createElement('span')
        text.textContent = body
        msg.appendChild(text)
        node.appendChild(msg)

        var foot = document.createElement('div')
        foot.style.cssText = 'display:flex;justify-content:center;padding:0 0 12px'
        var ok = document.createElement('span')
        ok.textContent = '确定'
        ok.style.cssText =
          'min-width:64px;text-align:center;padding:3px 10px;background:#c0c0c0;border:2px outset #fff'
        foot.appendChild(ok)
        node.appendChild(foot)
        return node
      }

      if (kind === 'win11') {
        /* 现代通知卡：圆角 + 半透明毛玻璃 + 左侧色条。
           backdrop-filter 在部分环境无效，所以底色不透明度留够（.92），
           退化时不至于变成一张读不清的透明纸。 */
        node.style.cssText = [
          'position:fixed',
          `left:${left}px`,
          `top:${top}px`,
          `width:${width}px`,
          'background:rgba(32,32,32,.92)',
          'color:#f3f3f3',
          'border:1px solid rgba(255,255,255,.12)',
          'border-left:3px solid #4cc2ff',
          'border-radius:10px',
          'padding:12px 14px 12px 16px',
          'box-shadow:0 12px 32px rgba(0,0,0,.45)',
          'backdrop-filter:blur(12px)',
          "-webkit-backdrop-filter:blur(12px)",
          'font:13px/1.55 "Segoe UI Variable", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif',
          'z-index:100000',
          'opacity:0',
          'transform:translateY(-6px)',
          'transition:opacity .14s ease, transform .14s ease',
        ].join(';')

        var closeX = document.createElement('span')
        closeX.textContent = '×'
        closeX.style.cssText =
          'position:absolute;top:6px;right:10px;opacity:.55;font-size:15px;line-height:1'
        node.appendChild(closeX)

        var app = document.createElement('div')
        app.textContent = title
        app.style.cssText = 'font-size:11px;letter-spacing:.04em;opacity:.62;margin-bottom:4px'
        node.appendChild(app)

        var headline = document.createElement('div')
        headline.textContent = body
        headline.style.cssText = 'font-size:13.5px;line-height:1.5'
        node.appendChild(headline)
        return node
      }

      /* plain：原本那种朴素框。 */
      node.textContent = `${title}\n${body}`
      node.style.cssText = [
        'position:fixed',
        `left:${left}px`,
        `top:${top}px`,
        `width:${width}px`,
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
      return node
    }

    function spawn() {
      if (stopped || index >= count) return closeNext()
      var i = index
      index += 1
      var kind = KINDS[i % KINDS.length]
      var node = makeNode(kind, titles[i % titles.length], bodies[i % bodies.length])
      host.appendChild(node)
      requestAnimationFrame(function () {
        node.style.opacity = '1'
        node.style.transform = kind === 'win11' ? 'translateY(0)' : kind === 'plain' ? 'scale(1)' : 'none'
      })
      opened.push(node)
      nextTimer = setTimeout(spawn, intervalMs)
    }

    function closeNext() {
      var node = opened.pop()
      if (!node) {
        unregister()
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

    /* ESC：停掉还在排队的 spawn，把剩下的窗口立刻摘掉（不走 90ms 淡出 ——
       淡出是给「表演正常收场」用的，中途掐断就该当场消失）。 */
    var nextTimer = 0
    var stopped = false
    var unregister = registerEscape(function () {
      stopped = true
      if (nextTimer) {
        clearTimeout(nextTimer)
        nextTimer = 0
      }
      while (opened.length > 0) {
        var node = opened.pop()
        if (node && node.parentNode) node.parentNode.removeChild(node)
      }
      if (typeof onDone === 'function') onDone()
    })

    spawn()
  }

  /**
   * 蓝屏屏保：全屏盖住 dsh 自己的窗口，60 秒或按 ESC 结束。
   * 只覆盖 dsh 页面自身，不碰系统、不碰其他插件。
   *
   * `opts` 里可以带宿主抽好的那张脸：`{ background, heading, lines }`。
   * 三个字段都可缺 —— 缺哪个就用本地兜底，所以宿主没升级也不会白屏。
   * 为什么要宿主抽：文案与配色属于「内容」，改一次就该生效，不该等客户端重新发版。
   */
  function runBluescreen(durationMs, lines, onDone, opts) {
    var face = opts && typeof opts === 'object' ? opts : {}
    var host = document.createElement('div')
    host.className = 'dsh-lucky-bluescreen'
    host.setAttribute('role', 'dialog')
    host.setAttribute('aria-modal', 'true')
    var background = typeof face.background === 'string' && face.background ? face.background : '#0a4db3'
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
    /* 表情符号是蓝屏的招牌：:( 是原版，:\\ 和 :( 的变体是这张脸自己的情绪。
       一律 96px / 300 字重 —— 它要占满半屏才像真的，小一号就变成提示框了。 */
    heading.textContent = typeof face.heading === 'string' && face.heading ? face.heading : ':('
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

    /* 走统一登记表，不再自己 addEventListener：(1) 与其它表演共用一条
       ESC 通路，一次按键把同一次单击起的几样东西一起收掉；(2) 自己监听
       在 CSS 层叠顺序之外，两条 onKey 同时接管会有先后手问题。 */
    var timer = 0
    var finished = false
    var unregister = registerEscape(finish)
    function finish() {
      if (finished) return
      finished = true
      unregister()
      clearTimeout(timer)
      if (host.parentNode) host.parentNode.removeChild(host)
      if (typeof onDone === 'function') onDone()
    }
    timer = setTimeout(finish, Math.max(1000, Number(durationMs) || 60000))
    return finish
  }

  /* ---------------------------------------------------------------- *
   * 动效类事件：方块跑掉 / 假光标 / 屏幕抖
   *
   * 这三个事件的共同点是**不产生任何内容** —— 没有文字、没有图片、没有声音，
   * 屏幕上就是动了一下。所以三条规矩：
   *  1. 必须极短（几秒内自己收场），否则「什么都没得到」会变成「浪费我一分钟」；
   *  2. 必须能被 ESC 立刻打断；
   *  3. 动完不能留下任何痕迹 —— 抽到它们的人得到的就是「什么都没有」，
   *     这是笑点本身，不是没做好。
   * ---------------------------------------------------------------- */

  /**
   * 方块自己跑掉：往对角线方向窜出去，停一下，再自己滑回原位。
   *
   * 用 transform 偏移而不是改 left/top：位置是 geometry 管的（拖拽、贴边、
   * 持久化都靠它），这里只是**临时**位移，动完原点不能变。改 left/top 会
   * 和拖拽 state 打架，还得自己算回去。
   *
   * transition 要存一份原值：方块平时的 style 里有贴边吸附用的
   * `transition: left .16s, top .16s`，直接覆盖会把那个效果弄没。
   */
  function runRunaway(block, durationMs, onDone) {
    var total = Math.max(800, Number(durationMs) || 2600)
    var finished = false
    var settle = 0
    var restore = 0
    var prevTransition = ''
    var unregister = registerEscape(finish)

    function finish() {
      if (finished) return
      finished = true
      unregister()
      clearTimeout(settle)
      clearTimeout(restore)
      if (block && block.style) {
        block.style.transition = prevTransition
        block.style.transform = ''
      }
      if (typeof onDone === 'function') onDone()
    }

    if (!block || typeof block.getBoundingClientRect !== 'function') {
      /* 拿不到方块节点就当场收场，而不是让登记表里挂一个永不执行的收场函数
         —— 那个会让方块永久锁死（后面每次点击都被「上一场还没收场」挡住）。 */
      finish()
      return finish
    }

    var rect = block.getBoundingClientRect()
    var width = root.innerWidth || 1280
    var height = root.innerHeight || 800
    var cx = rect.left + rect.width / 2
    var cy = rect.top + rect.height / 2
    /* 往**离它最远的那一角**窜 —— 往近处跑看不出「跑了」，只像抖了一下。 */
    var targetX = cx < width / 2 ? width - rect.width - 20 : 20
    var targetY = cy < height / 2 ? height - rect.height - 20 : 20
    var dx = Math.round(targetX - rect.left)
    var dy = Math.round(targetY - rect.top)
    var spin = dx >= 0 ? 16 : -16

    prevTransition = block.style.transition || ''
    block.style.transition = 'transform .32s cubic-bezier(.14,.9,.3,1.25)'
    block.style.transform = `translate(${dx}px, ${dy}px) rotate(${spin}deg)`

    /* 停留时长留出往返的动画时间：总时长是宿主给的，跑过去 + 滑回来都要装进去，
       否则「跑掉」这一下还没看清就结束了。 */
    settle = window.setTimeout(function () {
      if (finished) return
      block.style.transition = 'transform .46s cubic-bezier(.3,.8,.4,1)'
      block.style.transform = 'translate(0px, 0px) rotate(0deg)'
    }, Math.max(240, total - 620))
    restore = window.setTimeout(finish, total)
    return finish
  }

  /**
   * 屏幕上多出几个鼠标：几个假光标在屏幕上各处游走，几秒后消失。
   *
   * 不能靠 CSS 的 `cursor` 属性做 —— 那玩意儿只在指针真的悬停在元素上时才出现，
   * 而这块覆盖层是 click-through 的（`pointer-events:none`），永远不会被悬停。
   * 所以假光标必须**画出来**：一个背景是光标箭头的 div，用 left/top 移动。
   */
  function runFakeCursor(count, durationMs, onDone) {
    var total = Math.max(1200, Number(durationMs) || 4200)
    var host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:100005;overflow:hidden'
    document.body.appendChild(host)

    var width = root.innerWidth || 1280
    var height = root.innerHeight || 800
    var howMany = Math.max(1, Math.min(12, Math.round(Number(count) || 5)))
    var finished = false
    var timers = []
    var mover = []
    var unregister = registerEscape(finish)

    /* 一个白箭头 + 黑描边，就是最普通的那只箭头。
       用 data URI 内联，避免为了一个装饰去动资源路由。 */
    var ARROW = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">',
      '<path d="M4 2 L4 19.5 L9 14.6 L12.6 22.4 L15.9 20.9 L12.3 13.2 L19.2 13 Z" ',
      'fill="#ffffff" stroke="#101014" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    ].join('')
    var arrowUrl = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(ARROW)}")`

    function place(node, x, y) {
      node.style.left = `${Math.round(x)}px`
      node.style.top = `${Math.round(y)}px`
    }

    function finish() {
      if (finished) return
      finished = true
      unregister()
      for (var i = 0; i < timers.length; i += 1) window.clearTimeout(timers[i])
      for (var j = 0; j < mover.length; j += 1) window.clearInterval(mover[j])
      if (host.parentNode) host.parentNode.removeChild(host)
      if (typeof onDone === 'function') onDone()
    }

    for (var i = 0; i < howMany; i += 1) {
      var node = document.createElement('div')
      node.style.cssText = [
        'position:absolute',
        'width:24px',
        'height:24px',
        `background-image:${arrowUrl}`,
        'background-repeat:no-repeat',
        'background-size:contain',
        'opacity:0',
        'will-change:left,top',
        /* 每个假光标速度不一样 —— 同步移动一眼就能看出是同一个程序在动。 */
        `transition:left ${620 + Math.round(Math.random() * 520)}ms cubic-bezier(.4,0,.35,1), top ${680 + Math.round(Math.random() * 480)}ms cubic-bezier(.4,0,.35,1), opacity .22s ease`,
      ].join(';')
      place(node, Math.random() * Math.max(1, width - 24), Math.random() * Math.max(1, height - 24))
      host.appendChild(node)

      ;(function (el, delay) {
        timers.push(
          window.setTimeout(function () {
            if (finished) return
            el.style.opacity = '1'
            mover.push(
              window.setInterval(function () {
                if (finished) return
                place(el, Math.random() * Math.max(1, width - 24), Math.random() * Math.max(1, height - 24))
              }, 700 + Math.round(Math.random() * 420)),
            )
          }, delay),
        )
      })(node, i * 90)
    }

    /* 收场前先整体淡出，硬消失会像页面闪了一下。 */
    timers.push(
      window.setTimeout(function () {
        if (finished) return
        for (var k = 0; k < host.childNodes.length; k += 1) host.childNodes[k].style.opacity = '0'
      }, Math.max(260, total - 260)),
    )
    timers.push(window.setTimeout(finish, total))
    return finish
  }

  /**
   * 屏幕抖了一下：让 `document.body` 抖几百毫秒。
   *
   * 为什么抖动要挂在 body 而不是本插件的覆盖层：覆盖层里只有方块自己，
   * 抖它看起来就是「方块在抖」，那是另一个事件。要「屏幕抖了」就必须抖
   * 整个页面 —— 唯一能做到这件事、又不碰别人 DOM 结构的办法，就是给 body
   * 临时挂一个 class（动画结束后 class 撤掉，body 上不留任何 inline transform）。
   */
  function runShake(durationMs, onDone) {
    var total = Math.max(200, Number(durationMs) || 900)
    var body = document.body
    var finished = false
    var timer = 0
    var unregister = registerEscape(finish)

    function finish() {
      if (finished) return
      finished = true
      unregister()
      clearTimeout(timer)
      body.classList.remove('dsh-lucky-shaking')
      body.style.removeProperty('animation-duration')
      if (typeof onDone === 'function') onDone()
    }

    body.classList.add('dsh-lucky-shaking')
    /* 时长走 inline 覆盖，KV 对（动画名 + 时长）就不用为每种时长写一个 keyframes。 */
    body.style.setProperty('animation-duration', `${total}ms`)
    timer = window.setTimeout(finish, total)
    return finish
  }

  /* ---------------------------------------------------------------- *
   * 科乐美秘技
   *
   * `↑ ↑ ↓ ↓ ← → ← → B A`。1986 年《魂斗罗》输入这串能拿到 30 条命，
   * 之后四十年里它出现在几乎所有能按键的地方。
   *
   * 为什么做成彩蛋而不是随机事件：彩蛋的定义是**你得知道它才会出现**。
   * 放进事件池就成了随机掉落的装饰，抽到的人不知道自己在看什么；
   * 自己按出来的人会当场认出这是什么 —— 这个差别决定了它是「彩蛋」还是「特效」。
   *
   * 所以它不占任何权重，只在键盘上监听。整串输入必须连续、允许中间停顿
   * 一秒（人按键的节奏不一样），但太久就重新数。
   * ---------------------------------------------------------------- */
  var KONAMI_SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']
  /* 每一步之间的最大间隔。两秒足够慢慢按，又不至于「早上按了三下、
     下午再按七下」也算数。 */
  var KONAMI_GAP_MS = 2000

  /**
   * 返回一个 `keydown` 处理器，命中整串时调 `onHit`。
   *
   * 只认 `event.key`，不认 `keyCode`：`keyCode` 已被废弃，而且大写 B
   * （按着 Shift）的 keyCode 和小写 b 不同，会漏掉一半人。
   * `event.key` 在按 Shift 时是 `'B'`，所以统一 toLowerCase 再比。
   */
  function createKonami(onHit) {
    var index = 0
    var lastAt = 0
    return function (event) {
      var key = event && typeof event.key === 'string' ? event.key : ''
      if (key.length === 0) return
      var now = Date.now()
      /* 停太久就从头数。复位放在比较之前 —— 否则「停了三分钟再按最后一下」
         会接着旧进度命中。 */
      if (lastAt > 0 && now - lastAt > KONAMI_GAP_MS) index = 0
      lastAt = now
      var expected = KONAMI_SEQUENCE[index]
      /* 不匹配就判断能不能从头开始（用户可能想立刻重来）。
         一律 return，不 preventDefault —— 这串键里方向键在 dsh 里可能有用。 */
      if (key.toLowerCase() !== expected.toLowerCase()) {
        index = key.toLowerCase() === KONAMI_SEQUENCE[0].toLowerCase() ? 1 : 0
        return
      }
      index += 1
      if (index < KONAMI_SEQUENCE.length) return
      index = 0
      if (typeof onHit === 'function') onHit()
    }
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
      style.textContent = '.dsh-lucky-popup{animation:dshLuckyPop .14s ease}.dsh-lucky-bluescreen{animation:dshLuckyFade .18s ease}@keyframes dshLuckyPop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}@keyframes dshLuckyFade{from{opacity:0}to{opacity:1}}@keyframes lb-broadcast-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}@keyframes lb-lyric-in{from{opacity:0}to{opacity:1}}'
      /* 「屏幕抖了一下」：只有这个动效碰别人的东西（document.body），所以它单列一条。
         抖动用 translate3d 而不是 left/top —— 只有 transform 不触发布局，
         dsh 自己的界面在抖动期间不会重排；translate3d 还能让它走合成层。
         三下加减幅、结尾归零：抖完必须干净落在 transform:none 上，
         否则 body 会永久偏移 1~2px，那种 bug 极难看出来但会觉得「界面有点歪」。 */
      style.textContent +=
        'body.dsh-lucky-shaking{animation:dshLuckyShake 900ms cubic-bezier(.36,.07,.19,.97) both}' +
        '@keyframes dshLuckyShake{0%{transform:translate3d(0,0,0)}10%{transform:translate3d(-7px,3px,0) rotate(-.3deg)}' +
        '26%{transform:translate3d(6px,-4px,0) rotate(.28deg)}42%{transform:translate3d(-5px,2px,0)}' +
        '58%{transform:translate3d(4px,-2px,0)}74%{transform:translate3d(-2px,1px,0)}100%{transform:translate3d(0,0,0)}}'
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
