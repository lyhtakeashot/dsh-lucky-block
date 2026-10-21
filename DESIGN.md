# dsh-lucky-block 技术方案（调研结论 → 实现依据）

> 每条结论都标注了来源路径。工作目录：`D:\Desktop\VibeCoding\dsh幸运方块插件`

## 0. 目标与已确认的产品决策

- 包名 `dsh-lucky-block`，界面中文，插件在 dsh web + dsh desktop 双端工作。
- 功能 1「幸运方块选项」：AI 提问卡片的选项后追加 `幸运方块`；随机策略 = **借官方 `custom` 字段，让 AI 自己在下一步融合**（不插件内调 LLM）。
- 回滚：**仅限严格口令「回滚」**；回滚 = fork 成新会话并自动打开（`fork` 到提问卡片之前）。
- 功能 2「骰子按钮」：`shell.overlay` slot + 可拖动/可锁定/0.3s 防误触/锁定降存在感/六面骰子图标/位置持久化。
- 骰子事件：写论文、弹无意义窗口再有序关闭、蓝屏 60 秒、运气签、冷知识横幅、玩弄界面。
- 骰子新建会话 → DSH 默认工作区；AI 任务全自动放行（`approval` 不阻塞）。
- 安装：本地开发后由用户用内置 plugin_manager 手动装进 desktop profile。

## 1. 插件包结构（依据 dsh-literature / dsh-whale-widget）

第三方插件最小可用形态（两个成功样本佐证）：

```
dsh-lucky-block/
  package.json      # dsh.bundle.patch + dsh.client.inject + exports "./client"
  cordis.patch.yml  # - insert: [ {id: dsh-lucky-block, name: dsh-lucky-block} ]
  lib/index.js      # 宿主 Node 侧（真逻辑）
  lib/client.js     # 浏览器侧（cordis 客户端插件）
  icon.png
```

`package.json` 关键字段：

```json
{
  "name": "dsh-lucky-block",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "icon": "./icon.png",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-modules"] }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4" }
}
```

- `dsh.client.inject` = 声明的宿主侧依赖，客户端 cordis 才会把对应 service 放进 `ctx`。
  样本：`dsh-literature` 用 `dsh-client-runtime / dsh-client-connection / dsh-client-ui-sidebar / dsh-client-ui-settings / dsh-client-locale`；`dsh-better-sidebar` 用 `dsh-client-ui-slots / dsh-client-ui-conversation / dsh-client-modules`；`dsh-our-free-model` 用 `"inject": []` + `"immediately": true`（裸入口）。
- `dsh.client.platform: "web"`：客户端插件只在 web 侧加载（desktop 的 Electron 渲染层同样跑 web 产物）。whale-widget 避开这条走纯注入 script，是旧做法；**新做法用 client cordis 插件更干净**。
- 顶层 `icon`：宿主读成 data URL 塞进 `meta.icon`，必须正方形。
- 桌面端安装：`dsh plugin` CLI 拒绝 desktop profile（`profile "desktop" is managed exclusively by the Electron application`），必须走宿主内置 plugin_manager 工具，装完完全退出客户端再开。

## 2. 功能 1：幸运方块选项注入（宿主侧 waterfall）

### 2.1 注入点（零前端改动）
`user-questions/request` 是 **waterfall 钩子**：

```
'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
```
（来源 `research/session-api/catalog/events.txt:362-366`）

`request.questions[i].options` 就是官方卡片渲染的数据源（`dsh-client-ui-user-questions/lib/client.js:1757-1813` `answerQuestion` → `cards.ensure(sessionId, request.questions, callId)`）。
→ 插件 listener 做：

```js
ctx.on('user-questions/request', async (request, next) => {
  const answer = await next();   // 先让卡片渲染（也可在 next 前改 request）
  return answer;
});
```

注意：**waterfall 是「先到先改」还是「下游先跑」取决实现**；whale-widget 的经验是 `ctx.on` 注册的 listener 按激活序 append，waterfall 的 head listener 最先执行。安全做法：**在调用 next() 之前** 改写 `request.questions[*].options`（把幸运方块项 push 进去），再 `await next()`。这样官方 UI 天然渲染出该项，且完全不需要动客户端。

改写要求：
- 只对**普通选择题**追加；跳过 `intent !== undefined`（plan-review，会 `BAD_INTENT` 抛错，见 `dsh-user-questions/lib/types/index.js:315-321`）。
- 跳过 `multiSelect` 之外的场景可保留（多选题同样适用，融合描述写进 custom）。
- 追加的选项：`{ label: '幸运方块', description: '随机挑选/融合以下方案，然后可回滚' }`。
- 幂等：检测已含同名 label 则不重复 push（插件重载/嵌套 session 重入）。

### 2.2 识别并改写答案
`next()` 返回 `AskUserQuestionAnswer{ answers: AskUserQuestionAnswerItem[] }`，`AskUserQuestionAnswerItem{ id, selected: string[], custom? }` —— **selected 存的是 label 字符串**（`dash-user-questions` README）。

```js
const LUCKY = '幸运方块';
for (const item of answer.answers) {
  if (item.selected.includes(LUCKY)) {
    const others = item.selected.filter(l => l !== LUCKY);
    // 构造融合指令：写进 custom，AI 自己在下一步融合
    item.selected = others;             // 单选：custom 覆盖 selected；多选：custom 补充 selected
    item.custom = buildFusionPrompt(request, item.id, others);
  }
}
```
（custom 语义来源：`dash-user-questions` README「custom 对单选题覆盖 selected、对多选题补充 selected」）

**融合提示词模板**（中文，写入 custom）：
```
【幸运方块】用户选择了随机融合。请把以下选项融合成一个更优的新方案，不要逐个复述：
<逐个 label + 其原始 option.description>
要求：给出一个明确结论，不要反问。
```

### 2.3 记录回滚锚点
- 在改写答案前，从 waterfall 的 `this`（`Scoped<Agent>`）拿 agent → `ctx.remote.session` / `ctx.sessions.get(agent.session.id)`。
- 记录：`{ sessionId, callId, questionSeq }`，写入 `$DSH_HOME/lucky-block/state.json`。
- `questionSeq` 取：提问卡片出现前最后一个已落盘事件 seq。取法：监听 `session/event` 累计最新的 `user/message` 或 `assistant/message` seq；提问卡片本身不是事件（卡片是 UI 态，由 tool/call 的 `ask_user_question` 承载），所以锚点 = 该 tool/call 事件的前一个 seq。
  - 更稳的取法：在改写答案**之后立刻**记录当前 session 的 `lastEvent.seq`，回滚时用 `fork(source, boundary = toolCallSeq - 1)`，把提问那次 tool/call 一起抹掉。

### 2.4 执行「回滚」
触发：**严格口令「回滚」**（用户在任意输入框里只发这两个字）。

实现（宿主侧）：
```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'user/message') return;
  const text = extractText(event.data.message);
  if (text.trim() === '回滚') { void rollback(session, anchors); }
});
```
`rollback`：
```js
const anchor = anchors.get(session.id);
if (!anchor) return;
// host 侧 fork：boundary 是含端点的源事件 seq
const child = ctx.sessions.fork(anchor.source, anchor.boundary /* = toolCallSeq - 1 */);
```
但**客户端 UI 不会自动切到 child**。要用客户端侧 fork 才能导航：
`ctx.sessions.fork({ sessionId, atSeq, onCreated })`（客户端 service `SERVICE_API.json:242-254`，`atSeq` 省略=最新完成 turn 前缀）。

→ 最终实现：**客户端（browser）cordis 插件负责回滚**，因为只有客户端能 `.openSession()`。
宿主侧只负责：把「本会话有可回滚锚点 + 锚点 atSeq」通过 `ctx.reflect.provide` 或一条自定义 remote 暴露给客户端；客户端 hook `session/event`（客户端也有 session 事件投影）或在 composer 提交前拦截口令。

简化路径（**推荐**）：把口令检测也放在宿主侧，宿主发现口令时**不转发给 AI**，而是通过 `ctx.remote.session.control` / 自定义 slot 广播给客户端，让客户端执行 `ctx.sessions.fork(...)` + `ctx.uiWorkspace.openSession(childId)`。
→ 需要确认客户端能否"吞掉"这条 user message（否则口令也会进会话）。备选：宿主把口令改写成一个普通 turn（`/lucky-rollback` 命令形式），官方命令系统 `commands/run` 天然不进模型上下文（`catalog/services.txt:370`：command run/done 是直接 log-only append，no turn wraps them）。

**定稿：用官方命令 `/lucky-rollback` + 宿主侧命令执行 fork 后由客户端导航。** 口令「回滚」→ 客户端 composer 提交时替换为 `/lucky-rollback`。这是最不侵入的路线。命令注册：`ctx.commands` / `commands/change` 事件域（需再确认 commands API 形状，见 §6 待确认）。

## 3. 功能 2：骰子按钮（客户端 cordis + shell.overlay slot）

### 3.1 挂载点（依据 dsh-literature 实证）
`lib/client.js` 结尾：
```js
exports.inject = ["slots","locale"];
exports.apply = zC;
```
其中：
```js
let t = c.slots;
let s = () => t.inject("shell.overlay", () => t.register({ name:"shell.overlay", id:"dsh-literature", order:7, locale: Kg }, () => If(DC,{onClose:...})));
c.effect(() => s, "dsh-literature: overlay panel");
```
→ 骰子按钮：`ctx.slots.inject("shell.overlay", () => ctx.slots.register({name:"shell.overlay", id:"dsh-lucky-block", order:N}, () => DiceButton))`。

`slot.inject` 语义（`SERVICE_API.json:304-321`）：slot 已声明时同步跑 callback；未声明时在声明者 `register()` 里跑；插件 unload 自动 cascade。**这比自己注入 DOM 干净得多。**

### 3.2 组件能力
- 可拖动：pointer 事件 + 0.3s 长按判定才进入 drag；拖动用 `transform: translate()`，落点 `localStorage.setItem('lucky-dice-pos', ...)`（whale-widget 桌面端同样用 localStorage 键持久化位置）。
- 可锁定：锁定后 `opacity: 0.35; pointer-events: none` 于 drag 区域（点击仍触发），另有锁定开关按钮。
- 六面骰子图标：用 `@phosphor-icons/dice-*`（环境已有 `@phosphor-icons`），或内联 SVG 自绘 6 面点数（无依赖更稳，倾向内联 SVG）。
- 样式：`position: fixed` + z-index 3000（literature 面板实测 40 太低被宿主盖住，3000 安全）。

### 3.3 点击行为
点击 → `fetch('/api/dsh-lucky-block/roll')`（宿主路由，loopback only，同 `dsh-literature` 的 `/api/dsh-literature/*` 模式）→ 宿主：
1. 随机选一个事件定义；
2. 若是「AI 任务类」（写论文）：`ctx.remote.session.create({ workspaceId })` 拿到 sessionId，再 `ctx.remote.session.prompt({requestId, sessionId, mode:'steer', content:[{type:'text', text: 论文提示词}]})`；
3. 若「UI 事件类」：通过 remote/global 广播给客户端执行；
4. 返回 `{ type, title, sessionId? }`；客户端弹 toast 播报。

- workspaceId 取法：读 `$DSH_HOME/storages/workspace.json` 的 `global.defaultWorkspaceId`（已确认存在且稳定）。
- 新建会话后让客户端导航过去：`ctx.uiWorkspace.openSession(sessionId)`（客户端）；宿主 create 后需要通知客户端 —— 可让客户端在拿到 `sessionId` 后自己调 `openSession`，不需要宿主广播。

### 3.4 无人值守的审批
`ctx.approval.setPolicy(agent, 'never')`（`catalog/services.txt:208-222`，ApprovalPolicy = 'ask'|'never'）。
放置时机：会话创建后、第一次 prompt 前；或监听 `session/created` 对该会话 agent 设置。风险：`agent` 句柄生命周期；失败则 fail-closed（`request` 返回 'unavailable'），故**必须 try/catch 且不阻塞主流程**。

## 4. 骰子事件清单

> **这一节是最初的提案稿，id 早就变了，不要照着它读实现。**
> 实际事件以 `lib/index.js` 的 `buildEvents()` 为准，
> 跑 `node tools/list-events.mjs` 打印当前清单。
> 提案里的 `windows`/`bsod` 最终叫 `popups`/`bluescreen`；
> `fact` 被 `trivia` 的多种口味吸收，`mischief` 因为「改用户主题色」本质上会影响
> 别人的界面而放弃；`fortune` 后来补做了，但**做成了纯本地抽签**（`kind: 'local'`），
> 不调 AI —— 详见 §12。
> `mc-recipe`（我的世界概念合成）已按用户要求删除，见 §14。
> 现在是 **21 个事件、分两个池**（单击零成本 / 长按才花钱），见 §14 与 §17。

原始提案：

| id | 类型 | 实现位置 | 要点 |
|---|---|---|---|
| `paper` | AI 任务 | 宿主 | 随机词条库（学科×方法×对象）+ remote.session.create/prompt；全自动 approval |
| `windows` | UI | 客户端 | 8-15 个无意义小窗，打字机出现，反序关闭；纯 DOM |
| `bsod` | UI | 客户端 | 全屏 Win11 蓝屏样式（纯 CSS+DOM），十张脸随机一张，60s 自动结束，ESC 提前结束，z-index 高于一切但不覆盖已有 UI（独立 overlay 层） |
| `fortune` | UI | 客户端 | 「你已被幸运方块选中」+ 撒花，5s |
| `fact` | UI | 客户端 | 顶部随机冷知识横幅，可关 |
| `mischief` | UI | 客户端 | 随机切换主题色/字号，5s 后还原；或随机播放 whale-widget 音效 |

随机事件必须**可跳过/可退出**：ESC 或点击全局关闭层。严禁任何破坏性副作用（不写文件、不删数据、不改设置永久值——mischief 只改可还原项）。

## 5. 双端通道对照

| 能力 | Web | Desktop |
|---|---|---|
| 幸运方块注入 | 宿主 waterfall `user-questions/request`（同一份代码，天然双端） | 同左 |
| 骰子按钮挂载 | 客户端 cordis + `shell.overlay` slot | 客户端 cordis + `shell.overlay` slot |
| 宿主 HTTP 路由 | `ctx.webServer.register` | 同左 |
| 前端脚本注入（备用） | `ctx.webServer.tapIndex` | `webserver/index-inject` 内联 script 行 |

若选择客户端 cordis 路线，则 tapIndex/index-inject 都不需要。

## 6. 待确认（进入实现前最后一批，预计 3 个问题）

1. **官方命令系统**：`ctx.commands` 的形状（注册一个 `/lucky-rollback` 命令并让它在客户端 composer 可补全）。备选：不注册命令，客户端 composer 直接 hook 提交。
2. **会话事件在客户端的可见面**：客户端如何拿到"当前 session 的最后一条 user/message 文本"以检测口令（或完全由宿主检测并远程通知客户端 fork）。
3. **`shell.overlay` slot 的 props 契约**：register 的 component 收到什么参数（是否需要 children/close 句柄）。

## 7. 已知坑

- 读 utf-8 中文文件必须用 read 工具，PowerShell `Get-Content` 会乱码。
- asar 需要自写解析；官方包在 `app.asar.unpacked/dsh/node_modules`，不在 `app.asar/dsh`。
- 桌面端改宿主 `lib/index.js` 必须重启客户端；前端产物可热读取（whale-widget 的 mtime 缓存模式）。
- whale-widget 的 issue #154：`script-src` 注入行会 reject 掉 `__DSH_BOOT_READY__`，导致应用起不来；必须用内联 `script` 行。（仅在我们放弃 cordis 客户端路线时才相关）
- 卡片选项 label 是字符串匹配，务必保证「幸运方块」唯一且不被模型自行生成为选项名（检测用 Set + 精确等于）。
- `ctx.commands.register({ input: { hint: '' } })` 会抛 `command "x" input hint must not be empty`
  （`dsh-commands/lib/index.js:158` 的 `normalizeDefinition`）→ **register 抛错会中断整个 `apply()`**，
  后面注册 HTTP 路由的代码永远跑不到，表现为「按钮能点但 POST /roll 返回 405」。
  两个命令都不需要参数，所以直接不声明 `input`。
- `ctx.sessionController.prompt(request, signal)` 是**两个位置参数**，实现第一行就是
  `signal.throwIfAborted()`（`dsh-api-session-controller/lib/index.js:3096-3099`）。漏传 signal 会得到
  `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`，HTTP 层表现为 500。
  描述符（`lib/typert.remote-client.js:1244`）里的 `cancellation: { parameter: 'signal' }` 就是证据；
  而 `session/create` 的描述符没有该字段，所以 `create()` 不传也不炸。
  **不要**写 `prompt({ ...request, signal })` —— 宿主解构不到，仍是同一个错。

## 8. 后续迭代（四条改动）

### 8.1 气泡只留报错

原先气泡会写进度百分比、成功文案、新建的会话 ID。问题：有视觉表演的事件
（弹窗 / 蓝屏）自己就在演，气泡再写一遍是噪音；没表演的事件（冷知识 / 论文）
反馈在新会话内容里，气泡那句话也没人看。**现在只有出错才出气泡**。

同时把报错从「HTTP 500」这种不可行动的信息升级成**宿主翻译过的人话**：
宿主侧新增 `explainRollError(error)`（`lib/index.js`），按已知真实故障逐条映射 ——
`throwIfAborted`、ENOENT、EACCES/EPERM、workspace、session not found、
`model-unavailable`，认不出来兜底成「意外错误：<原始信息>」。响应体里
`error.message` 放人话、`error.detail` 留原始串，宿主日志照旧打完整堆栈。

客户端 `callHost` 优先取 `data.error.message`，拿不到才按状态码兜底
（401 登录过期 / 403 来源不被信任 / 405 插件未激活 / 404 插件已卸载），
**不再退化成 `HTTP <code>`**。气泡改为可换行（`whiteSpace: 'pre-wrap'`）、
点一下关掉 —— 说明可能是好几句，截成省略号等于白写。

### 8.2 骰子会话指定模型（默认关）

- 宿主 API：`ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`。
  `SessionCreateRequest` 只有 `{ workspaceId?, cwd?, sessionId?, agentPreset? }`，
  **没有模型字段**（`dsh-api-session-controller/lib/typert.host.js:192-202`）→ 只能「创建后切换」。
- **副作用（决定默认关）**：`selectModel` 成功后会把这次选择**异步写成 profile 全局默认模型**
  （`lib/index.js:720-748` 里的 `saveSelection`）。官方 README 也这么写。
  所以这不是「只影响骰子会话」的操作，开启即等于改默认模型。
- 服务不写进 `inject`：`selectModel` / `modelCatalog` 是较新的方法，老宿主可能没有；
  写进 inject 会在缺失时让**整个插件永不 apply**。改用 `ctx.get('sessionController')`
  懒查**方法**是否 `typeof === 'function'`，缺了就跳过。
- 校验**必须动态**：用 `modelCatalog().groups[].id`，不要硬编码 —— 实测 profile 配置里
  写的是 `workbuddy`，而会话投影缓存里是 `workbuddy-ai`。catalog 拿不到时放行（交给宿主判）。
- 配置位置：`$DSH_HOME/plugins/dsh-lucky-block/config.json` 的 `model` 字段。
  不用 cordis `Config` schema —— 本机同类插件（dsh-whale-widget / dsh-notify-me）
  都走自己读写 JSON 文件的路子，且 `schemastery` 不在插件可解析依赖里（实测
  `ERR_MODULE_NOT_FOUND`），少一个依赖少一处崩溃点。
- 失败绝不影响掷骰子：`selectModel` 抛错只 `logger.warn`。

### 8.3 边缘吸附

- 常量：`SNAP_THRESHOLD = 48`（px）、`SNAP_MS = 160`（与 CSS transition 数值必须一致）。
- 纯函数 `snapGeometry(next)`：x/y **两轴独立**判定，中心离边 ≤ 阈值就吸该边，
  返回 `{x, y, snapped}`，全程 `Math.max(0, ...)` 兜底，视口尺寸**现取**（不缓存进 state，
  避免 resize 后用旧值）。
- **松手时一次性吸附**，拖动中不吸附（拖动只 clamp）—— 与 whale 一致
  （`whale-widget.js:21719-21731` vs `:21983-22012`）。
- **`state.moved` 守卫是核心**：`onPointerUp` / `onPointerCancel` / `onPointerLeave`
  三个事件绑到同一个 `endDrag`，没有这个标记的话鼠标滑出方块边缘（触发 pointerleave）
  就会误吸附。判定尺子与「取消挖掘」完全一致（`DRAG_THRESHOLD = 5`）。
- 三条脏事件守卫（对齐 whale 在 `pointercancel` 上的教训 —— 取消事件常报 `clientX/Y = 0`，
  照坐标收尾会算成「拖到左上角」并把坏坐标写进 localStorage）：
  `cancelled || 坐标非有限数 || 拖过却报 (0,0)` → 回原位、不吸附、**不落盘**。
- **锁定 = 连吸附也不做**：锁定态根本不建 dragState，`endDrag` 开头 `if (!state) return`
  自然短路，零额外代码，也符合「锁定位置」的字面语义。
- 动画：transition 在 `isDragging` 时为 `none`（拖动跟手），松手后恢复
  `left/top` 过渡 → 视觉上是滑过去而不是瞬移。
- 验证：`tools/snap-check.mjs`，**从 `client.js` 抽源码 eval**（不是复制品），
  22 个用例覆盖四边 / 角落 / 自由区 / 越界 / 小视口 / 视口缺失。改实现即改测试。

### 8.4 事件清单可自省

`tools/list-events.mjs` 从 `lib/index.js` 的 `buildEvents()` 正文里正则解析
id / weight / title，打印概率表。文档与代码不会漂移。

> 这个脚本第一版**静默漏掉了全部视觉事件**：它按「id/weight/title 三行相邻」的正则
> 切分，而给视觉事件加上 `kind` 字段后字段顺序变了，正则就不再匹配 —— 脚本没报错，
> 只是少输出两行。现在改成按顶层对象切分、逐字段取，**不假设字段顺序**。

## 9. 随机事件的人格层

掷骰子开出来的会话不是干巴巴的任务简报 —— 它带一个固定性格：机器客服口吻，
称呼用户永远是「用户」，用「音量提高 33%」表达情绪升级，讲人体数据的冷知识。

**刻意不提任何作品名、角色名或制造商。** 性格靠语气和句式传达就够了，靠名字反而变成
引用。这条是硬要求，`tools/persona-check.mjs` 与两个端到端探针都有断言盯着产出里
不含专名。

### 9.0 连守卫里也不写死那个名字

要求是「整个项目不出现它」，所以断言里也不能把名字写出来 —— 把名字写进测试等于把名字
留在代码库里。守卫改成判**专名的形状**（`hasProperName()`）：

- 角色设定标签只能是 `［角色设定］`，一旦变成 `［角色设定 — 你现在的身份是「X」］`
  就说明有人又把名字挂回去了；
- 一旦出现 `《…》` 书名号、或「叫做 / 名叫 / 译名」这类起名句式；
- 一旦出现拉丁文人名/品牌名（`\b[A-Z][a-z]{3,}\b`）。

两个踩过的误报都记在这一段里，因为它们都指向同一类错误 —— **守卫的判据比要求本身更宽**：

1. `角色设定[^\]]*[「『"]` 里的 `[^\]]` 会跨行匹配到正文的
   「你称呼对方为「用户」」，把正常 prompt 判成有专名。改成 `[^\]\n]` 限同行。
2. 判制造商用 `/(制造商|出厂|生产商)/` 会命中 prompt 里那句**指令**
   「不要给自己编造制造商」—— 那是规矩本身，不是泄漏。改成 `claimsManufacturer()`：
   先看命中点前 14 字内有没有否定词（不要/不得/别/禁止/不许/不能/没有/未），有就跳过。

顺带清掉的真实泄漏：默认人格原来有一条哼歌的 traits，写法是「就哼〈艺人名〉的〈作品名〉」
——它同时含艺人名和作品名，正是要求里要清的那类内容。

后来用户又提了一次：「枪」和「唱歌」这两个元素本身就是多余的。于是把它们整个删掉：
`identity` 从「一把会说话的枪的内置 AI」改成纯系统程序，traits 从 9 条减到 8 条
（去掉「智能枪/干掉目标/毫无道德负担」那条与哼歌那条）。理由：这套人格的价值全在
**说话方式**上（工单口吻、系统话术、冷知识、话短），不在「它是什么东西」上；挂一个
具体载体会让模型时不时冒出「我这把枪……」这种自述，而用户要的只是那个语气。

### 9.1 为什么单独一个 `lib/persona.js`

人格层是**纯函数**（进什么出什么，不碰 fs、不碰 ctx），所以能真 import 进单元测试。
`tools/persona-check.mjs` 有 63 条断言，测默认人格形状、覆盖语义、垃圾输入、
人格段拼装、任务正文保护。宿主侧那些函数全都依赖 ctx，只能抽源码 eval 或跑假 ctx。

### 9.2 三段式拼装

```
[人格开场]
——— 以下是本次要做的事（严格按这个执行，不要因为上面的角色设定而省略任何步骤）———
[原始任务正文]
```

**任务正文必须原样保留**：人格改写任务描述会让 agent 丢掉「落盘到某文件」这类硬要求。
中间那句分隔语是刻意的拐杖 —— 直接拼接时模型会把「角色扮演」当成主任务。
最后再挂一段收尾点评请求，让它在干完活之后用自己的口气说一两句。

### 9.3 状态机：只剩一个「坏用户」标记，没有第二人格

`$DSH_HOME/plugins/dsh-lucky-block/persona-state.json` 存 `{diceCount, mood}`。

`diceCount` 现在**只是统计数字**（显示在 `/ping` 里），不再驱动任何人格变化。
`mood` 只有一个可选值 `bad`（人格崩溃降级，只会重复「坏蛋用户」），默认 `normal`。

**曾经有过一个「掷满 N 次单向翻转成礼貌模式」的机制，已经整个删掉。**
用户的原话是「这只是个话唠系统」—— 一个人格从头到尾就够，多一个第二人格反而让它
显得像个有隐藏设定的角色，而不是一个碎嘴的系统程序。

删干净的地方：`DEFAULT_PERSONA.flippedTraits`、`buildPersonaBlock`/`wrapWithPersona`
的 `state.flipped` 分支、`VISUAL_QUIPS_FLIPPED`、`CHATTER_LINES_FLIPPED`、
配置项 `personaFlipAfter`、`flipThreshold()`、客户端那条「原模式停用」的播报。
向后兼容：老 `config.json` 里的 `personaFlipAfter` 与 `persona.flippedTraits` 会被
静默忽略（不报错、不崩、不进 prompt），老 `persona-state.json` 里的 `flipped:true`
也不再有任何效果。

`normalizePersona()` 是公开入口的兜底：`mergePersona` 有防御，但 `buildPersonaBlock`
早期没有，调用方直接传 config.json 原始值时会抛 `TypeError: traits is not iterable`。
异常发生在**会话创建之后**，症状是「骰子转了但什么都没发生」，极难排查。

### 9.4 主动插话（克制优先）

闲下来 25 分钟以上、当前没在干活时冒一句碎嘴。每条设计都往「少说」倒：

- **走「队列 + 轮询」而不是往会话里塞消息**。插话必须零副作用；一旦写进会话历史
  就成为上下文的一部分、会改变模型后续行为 —— 那就不是「旁边有人碎嘴」，
  而是「有人往对话里插了一句」。
- **正在干活就跳过这一轮且不消耗额度**。用户忙的时候不该因为运气不好撞上忙碌
  而被扣掉一次说话机会。
- `setTimeout` **递归**而不是 `setInterval`：后者长时间空闲后会攒一堆待触发事件。
- 间隔在 `[intervalMs, 2×intervalMs)` 之间随机，默认 25 分钟、一次运行最多 3 次。
- **插话一律不以「冷知识。」开头**。`trivia` 事件的正文是同一类内容，但两者出现的
  位置完全不同：正文在屏幕正中（一次一条、要你读完），插话贴在方块头顶（顺带一句、
  你可以不看）。共用同一个开头词，用户会把插话当成「冷知识又跑错地方了」——
  用户 m18008 第 1 条就是这么误判的。原本那两条原本是
  「冷知识。人类每天平均要说大约 16000 个词……」与「冷知识。人在完全安静的环境里……」
  改成了同义的统计口径（「系统统计：你今日发言量与人类平均日词汇量相比，低了 100%」/
  「环境噪音持续偏低。你现在能听见自己的血流声」），语气是系统报数，不是播报冷知识。

## 10. 本地语料库与「是否调用 AI」开关

用户要求（m05005）：冷笑话和冷知识存一份本地的，并在设置里选择是否调用 AI。

### 10.1 数据放 JSON 文件，不放 JS 字面量

初稿把手抄的笑话写成 `.js` 字符串字面量，**推翻了**：正文里有逗号、引号、书名号，
手抄进 JS 字符串极易在转义上出错。现在 `lib/jokes.js` 只做加载器，
数据在 `lib/jokes-data.json`（`JSON.parse` 之后无转义风险）。

`loadJokeLibrary()` 读失败时返回空库而**不抛错** —— 语料缺失只应让那一条事件出不了内容，
不该让整个掷骰子失败。（早期确实会「落回 AI 路径」，本地库删了就又去花钱；
后来 `trivia` / `joke` 变成纯本地事件，落回 AI 这条路本身就没了，
改成语料为空的事件在建表时就被摘掉。）

### 10.2 分流从「逐个事件开关」改成「两个池」

**演变过程**（三段，每一段都是被用户的某个反馈推着走）：

1. 最初所有事件挤一个池，`rollDice()` 末尾看一眼 `localOnly.has(event.id)`，
   命中了返回 `localText`、没命中走 AI。用户在设置面板里逐事件勾「不调用 AI」。
2. 后来发现这个开关本身是冗余的：冷知识和冷笑话**本来就有完整本地库**，
   给它们一个「要不要调 AI」的勾选框，等于让用户为一个不值得问的问题做决定。
3. 再后来用户（m09978）要求「单点不调 AI 的都是单点的，调 AI 的都是长按的」——
   这时才把「成本」和「触发方式」绑成一个概念。

现在的规则：`buildEvents()` 给每个事件打 `trigger: 'click' | 'hold'`。

| 池 | 事件 | 代价 |
| --- | --- | --- |
| `click` | popups / bluescreen / fortune / trivia / joke / `audio-<文件名>`（一首歌一条） | 零 token、零会话 |
| `hold` | paper / news / invent | 建会话、调模型 |

`rollDice(trigger)` 先用 `trigger` 过滤事件再按权重抽，
所以两边的概率**互为独立**：往单击池加十条音频不会稀释长按命中率。

理由：**单点是手滑也会发生的动作，不该有成本；长按是明确意图，才值得花 token。**

`local` 字段保留下来但**只作自描述与自检用**（`host-smoke.mjs` 反向断言它和
`trigger` 不矛盾），不再驱动任何行为；`localOnly` / `localizable` / `localPayload()`
已整段删除。老配置里留着 `localOnly` 不报错、被忽略 —— 但要有一个探针盯着它别复活。

### 10.3 settings 走读-改-写

`config.json` 是**手写与界面共用**的同一个文件（里面还有用户手写的 `model` / `persona`），
所以 `saveSettings()` 必须读-改-写，整份覆盖会抹掉手写字段。

客户端侧两个坑：`openSettings()` 必须**立刻用占位对象开面板**（等宿主往返那几十毫秒里
点「设置…」毫无反应，用户会以为按钮坏了）；`toggleSound` 乐观更新，
**落盘失败要回滚 UI**，否则用户以为已经保存成功了。
面板里的事件清单按 `events[].trigger` 显示「单击 / 长按」标签 ——
字段没了面板会全显示成「长按」，而用户看不出这是错的。

### 10.4 BOM 坑

`readJson` 早期直接用 `JSON.parse(text)`。而 PowerShell 的 `Set-Content -Encoding UTF8`
和 Windows 记事本保存 JSON 都会写 `EF BB BF`，`JSON.parse` 遇 BOM 抛
`SyntaxError: Unexpected token`，被 `catch` 吞掉返回 fallback ——
**配置写对了却完全不生效，且不报任何错**。现在所有读 JSON 的路径都过 `stripBom()`。

### 10.5 冷知识一次只给一条

`trivia` 最早一次抽 3 条排成 `· ` 列表，是沿用「讲三个冷知识」的旧口味。用户反馈
「一次出现三条有点太多了」之后改成**只抽一条**。

理由不是「三条不好」，而是**显示位置变了**：这三条现在渲染在屏幕中央那个半透明框里
（`broadcastText`），字数直接翻三倍，用户得站在原地读完才能继续 —— 那不是打发时间，
是被迫阅读。一条读完刚好一次呼吸，读着不过瘾就再点一下，成本几乎为零。

这条改动同时删掉了 `sampleDistinct()`（它唯一的调用点就是这里），`trivia` 现在
和 `joke` 一样只是 `pick(rand, trivia).text`。三个探针/断言跟着改：

- `tools/build-corpus-overview.mjs` 生成的 `lib/语料库总览.md` 里那句
  「掷骰子时随机抽 3 条一起讲」→「随机抽 1 条讲」，`--check` 会比对。
- `tools/probe-local-path.mjs` 的核对方式从「逐行剥前缀后再比对」改成
  **整段必须等于库里的某一条**，并额外断言没有换行、没有 `· ` 前缀 ——
  这样「悄悄改回三条」会立刻失败（三条拼起来永远不等于单条），
  而只检查「每一行都在库里」是拦不住的。

## 11. 长按挖掘音效

用户要求（m05448 / m05467）：长按给一个原版 Minecraft 挖掘音效，设置里可开关；
**循环声与碎裂声两种效果都要**。

### 11.1 为什么走宿主 HTTP 而不是内联

音效总共 142 KB（base64 后约 190 KB）。`lib/client.js` 是**每次页面启动都要下载**的
入口 bundle，为只在长按瞬间才用到的音效把它撑大 4 倍会拖慢每一次启动。

更重要的是：`lib/client.js` 由 dsh-client-modules 当作 **factory 形式的 CJS bundle**
加载（`__ModuleLoader__.load({ id, factory })`），**顶层 ESM `import` 根本不会被解析**。
所以「`import { DIG_SOUNDS } from './sounds-data.js'`」这条路从一开始就不通。
能走的路只有 `require.async('./client.xxx.js')` 惰性 chunk 或宿主 HTTP 路由，选了后者。

音效文件由宿主 prefix 路由 `/dsh-lucky-block/sound/<name>.ogg` 按需投放。

### 11.2 两个只有真机才暴露的坑

- **prefix 路由不能带尾斜杠**。webserver 的判据是
  `pathname !== prefix && !pathname.startsWith(prefix + '/')`
  （`dsh-host-webserver/lib/index.js:328`）。写 `.../sound/` 的话判据变成 `.../sound//`，
  永远匹配不上；写 `.../sound` 才能同时命中它自己和它下面的文件。
- **路径穿越靠白名单挡，不靠路径规范化**。只允许 `^[A-Za-z0-9_]+\.ogg$` ——
  `..%2f` 之类解码后带斜杠的直接不匹配，根本进不到 `path.join`。

### 11.3 播放用 Audio 元素而不是 AudioContext

给 URL 就响，不需要 `decodeAudioData` 的异步等待；每次 new 一个天然可重叠；
不用管 AudioContext 那个「页面切走再回来要重新 resume」的状态机。

挖掘声每 210ms 一个、4 个变体随机轮播（只听一个会明显「卡带」），同时最多 6 个
Audio 元素（播完自己摘出池子），页面切到后台自动静音。**所有失败一律静默** ——
音效是锦上添花，让它冒泡成红色报错气泡是本末倒置。

停止顺序：挖穿时**先 `stopMining()` 再播**。反过来这声碎裂会跟循环的
最后一声叠在一起，听感是「咚咔」粘连。

### 11.4 木镐耐久：碎裂声不该每次挖穿都响

用户 m19780：「不是每一次挖掘都要播放破碎镐子的声音，你去查一下 mc 里木镐的
挖掘次数有多少次，在达到次数上限后才会播放一次」。

这条需求点破的是一个**语义错误**，不只是频率问题。去 `sounds.json` 里对照一下：

| 原版事件 | 文件 | 什么时候响 |
| --- | --- | --- |
| `block.stone.break` | `dig/stone1-4` | 方块被敲碎 |
| `entity.item.break` | `random/break` | **手上一件工具用坏了** |

`lib/sounds/break.ogg` 来自 `random/break`，即 `entity.item.break` —— 它是「镐子报废」
的声音。原来每次挖穿都播它，等于每挖穿一个方块就报废一把镐子；而方块碎裂本身
反倒一直没有专属的音效（当时注释还写着「比 random/break 更贴方块被敲碎」，
把 `random/glass1-3` 混进来，但主音仍是 `random/break`）。

所以现在拆成两层，**两层都要有**：

| 时机 | 客户端方法 | 音效组 |
| --- | --- | --- |
| 每一次挖穿 | `playBreak()` | `block` = `glass1-3.ogg` |
| 每第 59 次挖穿（额外叠一声） | `playItemBreak()` | `item` = `break.ogg` |

59 取自[木镐的耐久](https://minecraft.wiki/w/Wooden_Pickaxe)：Java 版 59、基岩版 60。
选 Java 版是因为本插件整套音效都来自 1.20.1 Java 版 assets —— 数值和素材该是同一个来源。

三个实现判断：

- **叠加而不是替代**。第 59 下如果只响 `break.ogg`，用户会以为方块没碎；如果只响
  碎裂音，镐子就永远用不坏。「方块碎了 + 镐子也废了」两声同时响，才是原版挖坏一把镐的样子。
- **计数存 localStorage（`dshLuckyBlock.pickaxe`），不进宿主 state 文件**。它纯粹是
  听觉连续性，和「你点了我 217 次」那种要给用户看的真实数字不是一回事。放进宿主状态的
  话，每跑一次端到端探针都会顺手磨掉用户手上这把镐子的耐久。
- **计数逻辑抽成纯函数 `wearPickaxe(used)`**。它跨会话累计、又是 off-by-one 的经典地形
  （第 59 下坏还是第 60 下坏都读得通），写错了不会有任何报错，人耳也听不出来 ——
  `tools/pickaxe-check.mjs` 用 `new Function` 跑真代码，钉住「第 59 下才坏」「坏完归零」
  「第二把镐子同样是 59 下」与六种脏输入（`null`/`undefined`/`NaN`/负数/`'abc'`/`Infinity`）。

顺带一个守卫：`playBreak()` 不能再播 `break.ogg`，否则这条改动会被一次「看起来无害的
回退」抹掉而不触发任何测试。`pickaxe-check.mjs` 里有一条断言就是照着这个写的。


## 12. 语料扩充与「去掉角色名」

用户要求（m06388 / m06444）：冷笑话和冷知识都要扩充，**现在的冷笑话不好笑**；
新闻 prompt 不要提角色名、且太长要缩短；**全插件 prompt 不再出现角色名**。

### 12.1 「不提名字」的实现方式是删掉 `name` 字段

`DEFAULT_PERSONA.name` 被整个删掉，而不是把字符串换成别的。理由：只要标签里还有
`［角色设定 — 你现在的身份是「X」］`，X 只要是个专名就等于还在提名字；换成代词又会
让模型的输出里冒出「我」这种自称，读起来像助手而不是一个系统程序。

保留**向后兼容**：老 `config.json` 里写了 `persona.name` 也不会报错，只是被忽略
（`OVERRIDABLE` 里不再有 `name`）。`persona-check.mjs` 有四条断言盯着产出里不含旧名。

### 12.2 拆字式为什么不成立（决定了扩充方向）

原库 170 条里「拆字式」12 条 —— 把成语/词的两个字拆开反问（「他一手包办。我说那你
另一只手呢？」）。诊断结论：**这是纯语法操作，没有场景、没有洞察、没有情绪回落**，
凑再多也不会好笑。用户据此选择**删掉拆字式，把条数分给别的类型**。

扩充的三批按用户选的方向补齐（各 65 条）：**荒谬逻辑**（开头很正经、结尾发现不对）、
**反向解读**（先给结论再拆掉）、**机器视角**（系统口吻处理人类事务）。加上原有的
谐音梗 33 / 一句话反转 33 / 人类行为观察 26 / 逻辑错位 23 / 一本正经的胡说八道 23 /
思考式冷段子 20，合计 **353 条**。

### 12.3 合并器必须防止「回退陷阱」

冷知识库曾经同时存在两个生成器（`research/build-final.mjs` 与 `tools/build-trivia.mjs`），
各自带一份数据 —— 跑哪个就变成哪个版本。实测跑「看起来更权威」的那个**反而把 447 条
回退到 435 条，静默丢掉另一边的改写**。

现在的纪律：**运行库是唯一事实来源**。`tools/merge-trivia.mjs` / `merge-jokes.mjs`
读运行库 + 候选文件合并后写回，别的生成器一律不再运行。两个合并器都支持 `--check`
只体检不写盘。

后来清理时把 `tools/build-trivia.mjs` 也删了：它依赖
`research/trivia-candidates.mjs`，而 `research/` 整个目录是子代理从 DSH 安装包里解出的
第三方源码（42 MB），已连同该目录一起清掉。合并职责现在只由 `merge-trivia.mjs` 承担 ——
**两个能写同一个文件的脚本，迟早会有一个把库写回旧版本。**

删掉那 42 MB 之前，把里面**手写的**东西捞了出来放进 `docs/research-notes/`（约 200 KB）：
考据报告、语料来源清单、以及合并器的候选 JSON。两个合并器现在按
`docs/research-notes/` → `research/` 的顺序找候选文件（前者在仓库里、后者只是本地后备），
所以删掉 `research/` 之后 `--check` 依然能把候选全认出来（实测：笑话三批各 65 条全判「跨批重复」、
冷知识两批 185/198 条全判「重复」，即已全部合并过）。
**候选文件是存档，不是事实来源** —— 保留它们是为了让「这批语料当初是什么」可追溯，
而不是为了让谁再跑一次合并。

`tools/merge-trivia.mjs` 里有两处值得记的细节：

- **`NEGATION` 白名单里必须有「不是」**，不能只写「不是真的」。中文辟谣句最常见形态是
  「X 不是 Y，而是 Z」（「玻璃不是流动的液体，而是非晶态固体」），只写「不是真的」会
  把这一整类当成讹传打出来 —— 实测误报过一次。
- 伪冷知识黑名单**只负责挑出来给人看，不自动拒绝**。库里有一批条目本身就是辟谣，
  那种必须留下，否则读者只记得讹传。

### 12.4 语料总览改成脚本生成

`lib/语料库总览.md` 原本是手工抄的，于是每次扩充立刻过期 ——
**过期文档比没有文档更坏**，后来读它的人会拿旧数字去核对新数据然后怀疑数据错了。
现在由 `tools/build-corpus-overview.mjs` 从运行库生成，`--check` 模式用于回归时
校验它没过期。该文件**不进 npm 包**（`package.json` 的 `files` 里没有它）——
它是给人看的 145 KB 文档，不是运行时需要的。

## 13. 「抽今日运气」：第三种事件类型

用户要求：加一条抽运气的随机事件（鸿运齐天 / 大吉 / 中吉 / 小吉 / 平 / 凶），
**吉类概率调高**，**「凶」要写成「从某种角度来说，你运气还挺好」**，
全程标注「无科学依据，仅供参考」，**不用调 AI，就是单纯抽奖**。

### 13.1 为什么新增 `kind: 'local'` 而不是复用现有两种

已有的两种都不合适：

- `kind: 'agent'` + `local` 语料声明 —— 那是「有 AI 版本、但可以被关掉」的语义。
  抽运气**没有 AI 版本**，如果走这条路，设置面板会多出一个「是否调用 AI」的勾选框，
  而它勾不勾都一样。**给用户一个点了没有任何变化的开关，比不给更糟。**
- `kind: 'visual'` —— 那是「播放视觉表演」，客户端会去读 `visual` spec 来演。
  抽运气没有表演，它输出的是一段文本。

所以加了第三种：`kind: 'local'` = **纯本地出文本，不建会话、不调模型、
也不进设置面板的开关清单**。`rollDice()` 里它排在 `visual` 分支之后、
`localOnly` 分支之前，直接构造 `localText` 返回，客户端已有的
`say(value.localText, 30000)` 那条路就能显示，**客户端一行没改**。

`host-smoke.mjs` 补了一条反向断言：**`kind: 'local'` 的事件不许同时声明
`local` 语料**，否则它就会跑进 settings 的可本地化清单里，重新造出那个无效开关。

### 13.2 权重为什么这么分

第一版是六档合计 100：鸿运齐天 5 / 大吉 20 / 中吉 25 / 小吉 20 / 平 25 / 凶 5
（吉类 70%，平 25%，凶 5%）。用户看过后要求再压：**「凶」降到 0.1%、「平」也嫌高、
三个小吉类都调高，鸿运齐天不动**。

现在是**七档**合计 1000：鸿运齐天 50 / 大吉 260 / 中吉 330 / 小吉 230 /
**顺 80** / 平 49 / 凶 1。即 **吉类 87%、顺 8%、平 4.9%、凶 0.1%**。

第五档「顺」是后来补的（用户 m15360 第 1 条：「加一条『顺』在『小吉』和『平』之间」）。
三档的语义是这样区分的：

| 档 | 语义 |
| --- | --- |
| 小吉 | **有件小事让你高兴** |
| 顺 | **没有好事，但也没有坎** —— 要做的事顺着做下去就行，中途不用绕路 |
| 平 | **什么都没有** |

所以「顺」比「平」多一分安心、「比小吉」少一件好事，落在两者之间是对的。
权重也照着这个位置给：小吉 23% > 顺 8% > 平 4.9%。
平从 99 让到 49，是因为有了「顺」之后，「什么都没有」这个最空的档不该还占近一成。

两点实现细节：

- **总量取 1000 而不是 100**，是为了能用整数 `1` 表达 0.1%。抽签用的是累减法
  （`ticket -= weight`），拿 `0.1` 这种值参与浮点累减，在边界上可能差一个 ulp；
  全整数则不会。
- 权重表一旦改动，`probe-fortune.mjs` 里那几条分布断言必须跟着改 ——
  它们现在是「吉类 ≥ 85%」「凶 < 0.3%」「平 < 15%」「鸿运齐天 5%±1.5」
  「顺比小吉少见」「顺比平常见」，用的是区间和相对关系而不是精确值，
  这样微调权重不用每次都改测试，但真的写错（比如凶又变回 5%、或者顺被塞到小吉前面）
  一定会红。

理由写在代码注释里了，这里再记一遍：**这个插件是用来打发时间的，不是用来给人添堵的。**
抽签这种东西的乐趣在于「有点准」，而不是「被诅咒」，所以分布必须明显偏吉。

### 13.2.1 每档五条签文，以及为什么要两段随机

用户后来又提了一条（m17159 第 1 条）：「每种的签文都来 5 种」。
所以现在每档挂一个 `texts` 数组，五条；抽签分两步：

```js
function drawFortune(rand) {
  // 第一步：按权重定档（和以前完全一样）
  for (const fortune of FORTUNES) {
    ticket -= fortune.weight
    if (ticket < 0) return withText(fortune, rand)   // 第二步：档内挑一条
  }
}
```

**为什么不把 35 条文案摊平成一个数组、每条带自己的权重？**
表面上看那样更直接 —— 抽 35 个条目里的一个，抽到什么就是什么。但它会悄悄
把「文案条数」变成「档位概率」：给「凶」多写两条，凶就从 0.1% 涨到 0.3%；
哪天有人觉得「大吉」的文案写得好、多抄三条，大吉也会跟着涨。
**加文案和改概率是两个完全不同意图的改动，不能让前者意外造成后者。**
两段随机之后，`weight` 与 `texts.length` 互不影响，各自改各自的。

代价是每档 `texts` 条数必须一致（否则档内每句话的概率不等），所以
`probe-fortune.mjs` 有一条 `TEXTS_PER_TIER = 5` 的逐档断言，还有一条
「给 drawFortune 喂 5000 个连续随机数，每一档的五条文案都抽得到」——
后者防的是「某条文案写错位置、永远抽不到」（比如被塞进一个没被遍历的地方）。

分布实测（20 万次，`drawFortune` 真跑）：鸿运齐天 5.8% / 大吉 25.5% / 中吉 34.2% /
小吉 21.9% / 顺 7.5% / 平 5.1% / 凶 0.11%，吉类合计 94.8%。

### 13.3 「凶」是反着写的

下签的正文不是「你今天会倒霉」，而是：

> 从某种角度来说，你运气还挺好 —— 今天该踩的坑都提前踩完了，剩下的路反倒好走。

这不是文案上的小聪明，而是**唯一能让下签不被讨厌的写法**：它承认了「今天不太顺」
（所以签是真的），但把同一件事重新框成好处（所以人不会扫兴）。
直接写凶兆会让用户觉得被冒犯 —— 他点什么不好，非要点开一个说他今天倒霉的东西。

五条「凶」都遵循这个口吻，但**不是同一个句式的五份复制** —— 每一条走一个不同的方向：

| 方向 | 例子 |
| --- | --- |
| 把不顺重新框成省事（代价维度） | 「该踩的坑都提前踩完了，剩下的路反倒好走」 |
| 把不顺重新框成有限（时间维度） | 「好消息是它只来一次，而且来得很早」 |
| 否定这个结果本身 | 「今天的签算错了。运气模块有个 bug，这签不作数」 |
| 把倒霉换成稀有（收藏价值维度） | 「这一签的概率是 0.1%，是本系统里最稀有的一种。稀有款都这样：不一定好看，但一定难抽（差评！）」 |
| 不作为即运气 | 「什么都不做就不会做错，这本身是一种相当高级的运气」 |

## 一条隐性约束：转身方向不许撞车

前四条定下来之后出现了第五个问题，而且是**光看单条永远发现不了的那一种**：
「签算错了」和「运气进程在后台重试」两条单看都合格 —— 不劝人、不预告坏事、
不写假设句，标准全都满足。但放在一起读，它们的笑点是同一个：
**「系统自己出故障了」**。

用户的原话只有七个字：

> 3,4 两条重复了

所以这一档除了「每条都要转身」，还多了一条约束：**方向不许撞车**。
被换掉的「运气进程在后台重试」就是死在这里 —— 它自己没问题，
但和第 3 条撞了同一个笑点。

换成「这个字是「猛」的意思，不是「惨」」之后，它连「否定这个结果」都不需要了：
它换的是「凶」这个字的含义，而不是它的真假。**但这一版也没留下** ——
用户指出它和「签算错了」还是在跟用户解释同一件事（「这个字/这一签其实不是那个意思」），
换的只是措辞。最终定稿换了完全不相干的角度：报概率，说这是稀有款。
系统程序报自己的概率是它本来该做的事，因此它连「为『凶』找个理由」都不用做。

这条约束在代码注释里写成五个编号方向（spared / once / voided / rare / inaction），
`probe-fortune.mjs` 里有一一对应的 `TURN_KINDS` 标签表：
每条必须命中**且只命中一个**标签（0 个说明没转身，2 个说明这条同时用了两种写法、
容易和别的条撞车），五条的标签还必须互不相同。
这条测试守的不是文风，是**「同一个笑点不能讲两遍」这个可验证的事实**。

## 被换掉的写法，以及它们错在哪

写了八版才定稿，前七版都被否掉了。把失败记录留下来，因为它们的错法各不相同 ——
尤其是最后两条，它们证明了「照着上一条的教训写」也可能再错一次。

| 被换掉的写法 | 为什么不行 |
| --- | --- |
| 「运气差到这个程度，接下来只会往上走」 | 其实是劝人振作，是在给用户打气 |
| 「该躲的躲不掉，所以别躲了」 | 「别躲了」是命令句，长辈口吻 |
| 「往好处想，第二遍通常比第一遍快」 | 「往好处想」同样是在劝人 |
| 「今天的事会比你预计的多绕两个弯。绕路不收费，代价只是时间」 | **先预告了一件具体的坏事** |
| 「今天有一件事得重做。至少第二遍会比第一遍快」 | 同上：先说「得重做」 |
| 「今天这个日子挑得不好。要是有什么没办成，那不算你的。这不叫安慰，这叫归因」 | **把「没办成」当假设写了进去**，失败仍然出现在句子里 |
| 「今天的运气进程在后台重试。你不用管它，明天它就恢复正常了」 | 单看合格，但**和「签算错了」撞了同一个笑点**（系统出故障） |
| 「今天很凶。这个字是「猛」的意思，不是「惨」」 | 单看合格，但**和「签算错了」是同一个动作**：都在解释「这一签/这个字其实不是那个意思」 |

前三条的共同点是**在对用户提要求或给建议**，而这个插件的说话人是一个碎嘴的系统程序
—— 它只报事实、解释代价，不安慰、不劝告。一条劝告就足以把人设打散，
让人从「系统在播报」变成「有个东西在哄我」。

中间两条的错法更隐蔽：它们**确实是「把代价解释掉」的写法**，格式完全符合前三条失败后
总结出来的规律，所以第一版重写时就是这么写的。但它们仍然是错的，因为用户第一眼读到的是
**「今天要绕两个弯」「今天得重做」**——具体的坏事已经落到他头上了，后面那句「代价不大」
只是补救。用户的原话：

> 我们的主要目的不是给用户添堵

于是判据补了一维：**不预告具体的坏事**。当时换成了归因式写法
（「要是有什么没办成，那不算你的。这不叫安慰，这叫归因」），
用「倒霉的是日子、不是用户」来满足这一维 —— 结果还是被否了。

倒数第二条最值得记：**假设句不是转身**。「要是有什么没办成」看起来是在替用户免责，
但「没办成」这三个字已经出现在用户眼前了，他只是被邀请去想象那个失败。
语气软了，画面还在。真正干净的写法是让那件事**根本不必存在** ——
把签本身判为无效（「今天的签算错了，运气模块有个 bug，这签不作数」），
坏运气就只存在于那个被判定为 bug 的结果里，跟用户这个人的一天没有关系。
这也是「碎嘴的系统程序」这个设定最占便宜的地方：它可以把自己的输出判成故障。

最后两条的教训是**换掉一条不等于换对一个方向**：新写的那些自己完全合格，
问题出在它和已有的第 3 条是同一个笑点。「后台重试」和「这个字是猛不是惨」都死在这里 ——
单条审查永远发现不了这个，只有把五条并排读才看得出来。
「重读这个字」失败得尤其值得记：它是一个**看起来很独立的写法**（换的是字义不是真假），
但把两条并排一读就发现，它和「签算错了」做的是同一个动作 —— 都在跟用户解释
「它其实不是那个意思」。撞车的从来不是题材，而是**动作**。
定稿最后选了「报概率」：系统程序报自己的概率不需要解释任何东西，
所以它连「做同一个动作」的机会都没有。

这也是为什么约束最终写进了测试而不是只写在注释里。

### 这条判据是怎么变成测试的

`probe-fortune.mjs` 对「凶」的断言是**正则匹配口吻**而不是钉死某一句话：
上一版写的是 `t.includes('你运气还挺好')`，五条文案一上就必然假失败。

现在是四组并列的检查：

| 常量 | 守的东西 |
| --- | --- |
| `BAD_TONE_RE` | 必须命中一个「转身」的标志词（运气 / 算错 / 不作数 / bug / 稀有 / 难抽 / 坑都提前踩完 …） |
| `CURSE_RE` | `倒霉 / 厄运 / 不祥 / 灾` 一个都不能出现 |
| `NASTY_FORECAST_RE` | 被否掉的三类写法（预告具体坏事 + 假设一件坏事 + 长辈式劝解）不能偷偷改回来 |
| `TURN_KINDS` | 五条走五个不同方向，每条命中且只命中一个标签 |

前三组是**对历史教训的守卫，不是对文风的评判**：它们列的全是被用户明确否掉的词
（`多绕 / 绕两个弯 / 得重做 / 往好处想 / 别躲了 / 躲不掉 / 没办成 / 没做成 / 办砸`），
作用是在以后改文案时立刻提醒「这个坑踩过了」，而不是试图用正则判断一句话是否温柔。
正则判断不了温柔，但能拦住已知的坑 —— 这四类错法各被否过一次，
说明「读着像不像好意」是判断不出来的，只能逐条积累反例。

第四组和前两组性质不同：它守的是一个**结构性事实**（方向不重复），
所以能写成确定的断言，不用担心误判。

### 13.4 免责声明是硬要求

每条签文末尾固定追加 `（无科学依据，仅供参考。）`，写在**宿主拼文本那一步**，
而不是写进每一条 `FORTUNES` 的 `texts` 里 —— 后者只要有人新增一档（或新增一条文案）
忘了抄就漏了。`probe-fortune.mjs` 有一条对应断言：遍历全部 35 条签文，
确认没有一条自己带着「无科学依据」。

### 13.5 一天只抽一次

用户要求「今天抽过就不变」，并且要明确告诉用户「今天已经抽过了」。
状态记在 `$DSH_HOME/plugins/dsh-lucky-block/fortune-state.json`：
`{ version: 1, day: '2026-10-17', fortune: { name, text } }`。

几个决定：

- **存签文本身，不存种子**。存种子听起来更优雅（「同一个随机源重放一遍」），
  但种子方案依赖 `drawFortune` 的算法永远不变；一旦以后调权重或加档位，
  昨天抽的「大吉」今天会变成「平」，用户会觉得这插件在耍他。
- **`day` 用本地时区的 `YYYY-MM-DD`**，不用 UTC。用户说「今天」，指的是他自己那一天。
  用 UTC 会让东八区的用户在早上 8 点前抽到的是「昨天」的签。
- **跨天不删旧状态，直接覆盖**。判据是 `state.day === today()`，
  不等就重抽并覆盖，不需要清理逻辑。
- **「已经抽过」的提示也走 `localText`**，拼在原签文后面，并带一个
  `fortuneRepeated: true` 标记 —— 客户端可以据此决定要不要换个语气，
  探针也靠它区分「第一次抽」和「重复抽」。

  > 探针踩过的坑：原断言写的是「第一次抽**不带** `fortuneRepeated`」，
  > 它假设了探针一定是今天第一个抽签的人。可宿主里可能已经有用户当天在 GUI
  > 里抽过的签，于是探针的「第一次」也是重复抽 → FAIL，而插件完全正常。
  > 判据已改成「两条一致 + 第二次带标记」，覆盖两种排列。

### 13.6 长内容走系统提示，用户消息只留一行

骰子事件开出来的会话，用户消息现在只有 `🎲 随机事件：时事新闻速览` 这么一行，
人格设定和任务正文通过 `system-prompt/assemble` 钩子注入。

**为什么不是「发一条不显示的消息」**：宿主根本没有这个能力。
`PromptContentPart` 只有 `text` / `image` / `file` 三种（`dsh-api-session-controller`
的 `typert.host.js`），`SessionPromptRequest` 也只有 `requestId` / `sessionId` /
`mode` / `content` / `clientTimeZone`，没有任何可见性字段；asar 里 grep
`displayOnly`、`isMeta` 都是 0 命中；会话投影里 `titleInput.val.first` 只有 `{seq, text}`。
所以只能「不发」，不能「发了但藏起来」。

实现要点：

- `dicePrompts` 是个 `Map<sessionId, {text}>`，进程内存里活着。
  agent 的 `id` **就是** sessionId（`ctx.agents.get(sessionId)` 直接以它作键），
  所以钩子里用 `context.agent?.id` 就能判断这是不是骰子会话。
- **顺序是硬性的**：先 `dicePrompts.set()`，再 `promptSession()`。
  反过来的话 `prompt()` 一返回 agent 就开始装配 system prompt 了，
  第一轮会拿不到任务正文 —— 表现为 agent 只看到一行标题、回一句「好的，请问要做什么」。
- `promptSession` 抛错时要 `dicePrompts.delete()`，否则这个会话之后每一轮
  都带着一份孤儿指令。

**这带来一个测试盲区，值得单独记一笔**：注入内容在磁盘上**没有任何痕迹**。
`contextTimeline.surface` 只记 user / inject / skill / assistant 四类，注入段不进 surface；
`systems` 只有一个 tokens 计数。也就是说「注入没生效」和「注入生效了」在投影缓存里
长得一模一样。所以新增了一个只读路由 `/dsh-lucky-block/dice-prompt?sessionId=...`
把内存里的注入文本暴露出来，让 `probe-persona` / `probe-dice-prompt`
能直接断言注入内容。没命中时它还会返回 `known`（当前登记过的会话 id 列表），
用来区分「查错了会话」和「根本没登记」—— 这是两种完全不同的故障。

## 14. 单击/长按分流，删掉 mc-recipe

用户要求（m09978）：

> 1. 把我的世界的相关合成表随机事件删掉，我需要加点其他随机事件，比如随机音频播放，
>    用什么音乐我过段时间给你清单
> 2. 将左键单点（非长按）的功能和长按的功能区分开，不调用 ai 的是单点的，
>    调用 ai 的是长按的

### 14.1 删 mc-recipe，并说明为什么

删掉的不只是事件定义（`lib/index.js` 里 ~23 行），还有两个常量：
`MC_CONCEPTS`（30 个 Minecraft 概念）和 `MC_RECIPE_FORMS`（6 条合成表模板）。
删常量的理由和删事件一样：**事件没了，语料就该跟着没**，留着就是死代码。

那一等一的理由是这个事件本身和整个插件的定位不合：
插件叫「幸运方块」靠的是那张方块贴图，而不是 Minecraft 的内容。
留着一条「从 Minecraft 里挑两个东西揉一揉」的事件，
会让插件显得像某个 Minecraft mod 的周边，而不是一个通用的随机事件骰子。

顺带清掉测试里的痕迹（`DONE_MARKERS` / `TASK_MARKERS` 的 mc-recipe 项）——
留着的话每掷一次都会白等 1.5 秒检查一个再也抽不到的事件。

### 14.2 两个池而不是一个池加过滤

`trigger: 'click' | 'hold'` 打在事件定义上，`rollDice(trigger)` 先过滤再抽。

分两个池而不是「一个池 + 运行时过滤」，是为了让**两边的权重独立**：
如果只有一个池，往单击池加十条音频就会把长按事件的命中率一起稀释。
现在单击池权重 120（含五首歌，NGGYU 是 2，其余各 1）、长按池权重 16（七个事件），互不干扰。
单击池那 120 是被「音乐合计只占 5%」反推出来的：五首合计 6 份，
非音乐十七条按各自分量摊到 114（6:6:5:5:5:4:4:4:4:3:3:3:3:18:21:16:4）。
**注意这个总数是硬约束**：以后加单击事件时必须从现有事件里挪权重，
不能直接挂一个新的上去 —— 直接加就等于悄悄把音乐占比从 5% 降到 4.x%，
而这件事在界面上完全看不出来。
（m00160 加停电 / 假警报 / 掀桌的 12 份就是这么挪出来的：popups 14→11、
bluescreen 14→11、fortune 20→18、trivia 27→25、joke 20→18，合计正好 12，
总数仍是 120。挑这两个「最吵的」先动，是因为新的三个和它们争的是同一件事：打断你。）
（m00576 加手滑的 4 份继续从同一处挪：popups 11→9、bluescreen 11→9。
两次都动同一对，不是偷懒 —— 它们是池子里唯一「纯打扰」的两个，
而动效事件和它们抢的正是同一块屏幕注意力；从冷知识或抽签里挪才是错的。）
（m00793 又加彩虹 / 缩水 / 变大 / 低重力的 12 份，还是四笔账里的第三笔：
popups 9→6、bluescreen 9→6、trivia 25→21、joke 18→16。
前两个继续让，是因为动效本来就该由最吵的那两个出份子；
后两个这次也让了 —— 动效已经到 55/114，再全从两个「纯打扰」身上抽，
它们会掉到 3 份以下（2.5%），变成池子里的稀有彩蛋而不是「常见的烦人」。
两笔账各自留在事件定义上方的注释里，改权重前请先读那两段（见 `lib/index.js`
里 blackout 上方的账本）。）

（`/roll` 不传 `trigger` 时默认 `'hold'`，因为「长按」是这个按钮原本的语义。）

### 14.3 音频事件：一首歌一条

包里带五首（`lib/audio/`）：`never-give-you-up.ogg`（42 秒副歌）、
`whos-ready-for-tomorrow.ogg`（112 秒）、`stay-at-your-house.ogg`（241 秒）、
`my-shot.ogg`（328 秒）、`satisfied.ogg`（330 秒）。

- `lib/audio-tracks.json` 是清单；**一首歌展开成一条事件**（`audioEvents(tracks)`），
  不是「随机放一段音频」的大事件。
- 事件 id 由文件名派生：`stay-at-your-house.ogg` → `audio-stay-at-your-house`。
- 填 `[{"file": "xxx.ogg", "title": "显示名", "weight": 2}]` + 文件丢进 `lib/audio/`，
  事件自动出现。
- 文件名白名单 `/^[A-Za-z0-9_-]+\.(ogg|mp3)$/` —— 防目录穿越。
- 宿主新增 `/dsh-lucky-block/audio/<file>` 路由（和 `/sound/` 同一套写法）。

**清单一首都没有时不该留下一个空事件**：`audioEvents()` 返回空数组，整类事件
压根不存在，而不是「抽到了但播不了」—— 后者的表现是用户点了没反应，比不列出来更糟。

#### 14.3.1 为什么按曲目拆开，而不是一条「随机放音频」

用户要能**单独关掉某一首**（听腻了那首、或者某一首不想在办公室放）。
覆盖层是按事件 id 生效的，所以合成一条「随机放一段音频」的话，
勾掉它等于五首一起没了 —— 那正好把「可自定义」变成「全有或全无」。

用**文件名**而不是曲名派生 id，因为 id 要进 `config.json` 的 `events` 覆盖层，
还得过 `isSafeEventId` 的 `/^[a-z][a-z0-9-]*$/`（曲名里有中文、空格、冒号，过不了）。
顺带的好处：改了 `title` 不会让覆盖配置悄悄失效。

每首歌权重默认 **1** 而不是照抄原来的 3：曲目数会随加歌增长，
权重写 3 的话加到十首就吃掉单击池一半的概率，冷知识和冷笑话会被挤到边角。
`localAudioTracks()` 读清单里的可选 `weight` 字段，缺省或非正数时退回
`DEFAULT_AUDIO_WEIGHT = 1`；`audioEvents()` 用 `track.weight` 建事件。
包里的 `never-give-you-up` 写了 `"weight": 2` —— 用户明确要求它比别的更常出现，
给候选方向后选了「更常出现」而不是「更少见」。

代价是设置面板会多几行。这是刻意的 —— 面板本来就要能看出「哪条事件关着」。

#### 14.3.2 为什么「打进插件包」而不是联网

音乐随 npm 包发布：

- 运行期不依赖网络，断网、内网、代理环境下都一致；
- 没有「这个 CDN 挂了 / 版权方下架了」这种不可控因素；
- 只有一个请求，浏览器原生缓存。

代价是包体积。**Never Gonna Give You Up 只放副歌，其余四首是完整版**
（用户 m15360 第 8 条明确要求）。完整版确实把包从 2 MB 撑到 12 MB，也把
「随手点一下」变成三四分钟的停留 —— 但**单击池十种表演全都能按 ESC 立刻停**，
停留时长不再是硬绑定：想听完就听完，不想听按一下就走。
包里唯一保留副歌的那首，是因为用户明确说了「除了 NGGYU 其他音乐都要完整版」。

现在五首共 ~12 MB（Vorbis q2，44.1kHz 立体声）：632 KB + 1.4 MB + 2.8 MB + 3.8 MB + 3.6 MB。

切法：`ffmpeg -i src -ss 26 -c:a libvorbis -q:a 2 -ac 2 -ar 44100 out.ogg`。
`-ss` 放在 `-i` **之后**是精确定位，放最前面是快速 seek（可能落在非关键帧上，
听感上有轻微的啪声）。找高潮/静音边界用的是自写的 RMS 分桶脚本
（`tools/.loudest.mjs`，`-i` 后接 2 秒窗口），`ffmpeg -af astats=metadata=1:reset=N` 不行 ——
`reset` 的单位是**采样数**不是秒，出来的窗口数和时长完全对不上。

四首完整版各自的切法（都是为了去掉首尾静音，曲子本身没动）：

| 曲目 | 处理 | 理由 |
| --- | --- | --- |
| Who's Ready for Tomorrow | `-to 112` | 原 116.2 秒，尾部 4 秒是 -43/-81dB 静音 |
| Stay at Your House | `-to 241` | 原 246.7 秒，242 秒后跌到 -30/-61dB |
| My Shot | 不切 | 原 328.6 秒，首尾都是正常声音 |
| Satisfied | `-ss 26` | 原 356.4 秒，前 26 秒是 -65dB 的黑胶底噪（黑胶转录音源） |

`I Really Want to Stay at Your House` 早前那版取的是 58–95 秒（全曲唯一一段
持续 -9dB 的副歌，其余段落都在 -15dB 上下）。用户要求完整版后改用整段，
那段副歌仍然留在里面 —— 好听的部分没丢，只是前后文也回来了。

#### 14.3.3 曲库有两份位置，用户目录优先

`localAudioTracks()` 先读 `$DSH_HOME/plugins/dsh-lucky-block/audio-tracks.json`，
读不到再退回随包的 `lib/audio-tracks.json`；`/dsh-lucky-block/audio/<file>`
路由按同样顺序找文件。

理由：第三方想扩展曲库时改的是自己的配置，不是插件包本体 ——
插件一升级，包里的 `lib/audio/` 就整个被覆盖回去，用户加的歌全没了。

#### 14.3.4 歌词：只做一首，靠轮询取句

用户 m18477：「歌词的功能实现不了吗，实现不了跟我说」→ 澄清后定为
「只做 NGGYU 的」。技术上没有任何新通道：音频已经由
`/dsh-lucky-block/audio/<file>` 投放到页面里，`createSoundEngine()` 手里
握着那个 `<audio>` 元素，`currentTime` 随时可读 —— 缺的只是一份时间轴。

三条设计判断：

1. **时间轴是「片段内秒数」**。包里那首是原曲 100~142 秒的副歌，
   直接把网上的 LRC 粘进来会整首错位。确认偏移的办法不是听，是算：
   下载全长 MV，两边都转成 8kHz 单声道 PCM，做能量包络的归一化互相关，
   得到 best offset = 100.00 秒、相关 0.9958。这个数字写进了
   `lib/lyrics/never-give-you-up.json` 旁边的注释里 —— 换歌时得重做这一遍。
2. **轮询而不是 `timeupdate`**。歌词两秒才换一句，200ms 读一次
   `currentTime`（同步 getter，无 IO）比维护一条事件订阅便宜；
   而且订阅式还要处理「订阅时音轨已经换了」这种时序问题。
   轮询每拍都回头查 `hasTrack()` —— 音轨被 ESC、被下一首、被卸载掐掉时，
   定时器自己收摊，不依赖任何外部调用方记得来关它。
3. **提前 0.1 秒切句**。LRC 的时间戳标的是「这一句开口的瞬间」，
   但人眼读到字要一两百毫秒，卡着点换会总觉得慢半拍。
   `tools/lyrics-check.mjs` 把 `t-0.05`（已切）和 `t-0.2`（还没切）
   两个边界都钉住了 —— 以后谁把这个数改成 1，测试会红。

### 14.4 客户端怎么区分两个动作

`pointerdown` 记起点与时间，原有挖掘逻辑照跑；
`pointerup` 时若**没挖满**（`p < 1`）且没移动，才算单击 —— 走 `roll('click')`。
挖满照旧走 `roll('hold')`。

键盘 Enter/Space 从「直接触发长按」改成「走单击」——
键盘没有「按住 1.4 秒」这个自然动作，而单击是零成本的，猜错的代价最小。

#### 那条判定必须是白名单，不能是黑名单

早前这四条判定写成了「没记录就放行」：

```js
var samePointer = !press || !event || press.pointerId === event.pointerId
var notFired   = !press || press.fired !== true
var notMoved   = !dragState.current || dragState.current.moved !== true
```

读起来宽容，实际是把「这一轮按压我们根本没见过」也当成了合格。
而 `onPointerDown` 首行是 `if (event.button !== 0) return` —— **右键从不登记**，
所以右键松开时 `press` 是 `null`，三条全真，于是右键既弹出菜单、又抽一次随机事件。
用户先发现的是这件事（m19957），代码自己不会报错。

现在判定收在一个纯函数 `isClickRelease(event, press, drag)` 里，
第一条就是 `if (!press) return false`：**只有我们登记过的按压才可能产生单击**。
`endDrag` 只负责执行它的结论，不再自己拼布尔量。

`event.button` 用 `Number.isFinite(event.button) && event.button !== 0` 而不是直接
`!== 0`：合成事件可能不带 `button`，那不该被当成右键；
真的报了 2（右键）或 1（中键）才拒绝。

`tools/click-check.mjs`（22 条）把这一条钉住，其中最重要的一条是
「右键松开且从未登记 → 不触发（原始 bug 形状）」——
只测「左键能触发」是不够的，那从来没错过。

### 14.5 测试上跟着变的地方

`/roll` 的默认 trigger 是 `'hold'`，所以**所有想抽单击池事件的探针都必须显式传
`{trigger: 'click'}`**，否则循环跑满也抽不到、最后误报「抽不到 fortune」。
`probe-fortune.mjs` 就是这么修的（第一版 FAIL 过一轮）。

反向断言也加了：`host-smoke.mjs` 检查 `localOnly` / `localizable` 没复活、
`mc-recipe` 没复活、`trigger` 与 `kind` 不矛盾。

### 14.6 ESC 提前结束：登记表而不是单槽

单击池的十种表演全都能被一次 ESC 收掉（音乐、蓝屏、弹窗、居中长文）。
实现是 `registerEscape(finisher)` 返回一个幂等的 `unregister()`，
全局 `keydown`（捕获阶段）把登记表里的回调全跑一遍然后清空。

**为什么是表而不是「当前表演」单槽**：一次单击可能同时起好几样 ——
蓝屏带方块台词、音乐带标题、长文带气泡。单槽会让后起的把先起的挤掉，
先起的那样就再也关不掉了（比如音乐在放，蓝屏的台词却关了音乐）。

**为什么没登记时必须放行**：`escFinishers.length === 0` 时直接 `return`，
不 `preventDefault`。dsh 自己用 ESC 关会话、关面板，插件没有正在表演的东西时
拦截 ESC 等于把用户困住。这是「只在有自己的东西可关的时候才接管」的通用原则。

**方块头顶的小气泡故意不登记**：它只占屏幕一角、6 秒自己消失。
为它吞掉 ESC，会让用户在那 6 秒里关不掉 dsh 的任何东西 —— 收益远小于代价。

**为什么清空在回调之前**：先把 `escFinishers.length = 0` 再逐个执行，
否则某个 finisher 里新登记的项会被同一次按键顺手收掉。

### 14.6.1 同一时刻只播一场表演

用户 m18008 第 2 条：「在上一个随机事件关闭前，不能再次点击，不然同时出现音乐和弹窗
会显得有点嘈杂，除非 ESC 提前结束。」

**为什么 `isBusy` 护不住这件事**：那个标记的语义是「HTTP 请求在飞」，`finally` 里
在 `callHost` 返回的那一刻就复位了 —— 几百毫秒。而弹窗要弹二十几个（十几秒）、
蓝屏 60 秒、音乐最长 330 秒、居中播报 30 秒。这四类演出全部发生在 `isBusy` 已经
变回 `false` 之后，所以那时候方块仍然可以点，连点两次就是「音乐 + 弹窗」同时上演。

**为什么是计数不是布尔**：一次单击可能同时起两样（蓝屏 + 方块台词、音乐 + 标题）。
用布尔的话，先收场的那样会把 `false` 写回去，后一样还在屏幕上却又可以点了。
`beginShow()` 返回一个幂等的 `endShow`，只有计数归零才解锁；`endShow` 第二次调用
什么都不做，因为「同一场被两条路同时报收」是常态（定时到了又按了 ESC）。

**为什么是 `useRef` 不是 `useState`**：它只被回调（`onRoll`、各类 `onDone`）读，
不参与渲染。放 state 会让每次开演/收场都触发一次无意义的重渲染，而没有重渲染
改变的界面 —— 唯一可见的变化是「能不能点」，那由阻塞判据在按下时读 ref 决定。

**四类表演都必须有收场信号**，漏一路的后果是方块永久点不动，只能重启 dsh：

| 表演 | 自然收场 | 提前收场 |
|---|---|---|
| 弹窗 | 最后一个窗口淡出后 `closeNext()` 走到 `!node` | ESC（立刻摘节点，不走淡出） |
| 蓝屏 | 到点 `setTimeout(finish)` | ESC |
| 音乐 | `ended` 事件 | ESC；被下一首顶掉；`error` 事件 |
| 居中播报 | 定时到点 | ESC；点击遮罩；被下一段正文顶掉 |

其中三条是**补出来的**，都属「原本不需要、加了串行就必须有」：
`playTrack` 原来没有 `onEnd`；`haltTrack` 掐断时没人报信；
`broadcastText` 被下一段顶掉时上一段的 `onDone` 不会叫。
最后这条最隐蔽 —— 它只在「一次单击里既有音频又有正文」时才会漏，
而那时候计数会多留一个，看起来像随机的「偶尔点不动」。

**出错路径也要解锁**：`beginShow()` 之后如果抛错，那个 `endShow` 永远等不到调用。
所以 `onRoll` 用一个 `begun` 数组收着本轮开出的所有收场函数，`catch` 里全部放掉
（`endShow` 幂等，正常收过场的再叫一次无害）。宁可提前解锁，也不要永久锁死。

**`spawn()` 退回 null 时也要当场收场**：页面在后台、环境里没有 `Audio` 构造、
URL 被判非法 —— 这些情况都没有 `ended` 可等。`audio.play()` 被 autoplay 策略
拒绝时更糟：`play()` 返回的 Promise reject 被静默吞掉，`ended` 永远不来。

**为什么提示写在头顶**：头顶平时只用来说报错，而「现在点不动」正好是种状态说明。
静默 `return` 会让用户以为方块坏了 —— 用户看不到任何反馈，只会多点几下。

### 14.7 演出素材为什么变多样了（蓝屏十张脸、弹窗三种皮）

用户 m15360 第 5 条：「蓝屏屏保和弹窗表演都需要加点内容，
比如说蓝屏再加几张，弹窗表演也可以添加一点老式电脑的弹窗故障和 win11 的弹窗形式」。

**蓝屏**：`BLUESCREEN_VARIANTS` 十张脸（背景色 / 表情 / STOP 码都不同），
`prepare(rand)` 抽一张。最初只有三张，m01108 用户说「还是有点少」加到十张 ——
蓝屏的权重虽然已经压到 6，但它一次占屏 60 秒，是池子里**最占时间**的表演：
三张脸平均掷三次就重样，而重样的那 60 秒比不演还难熬。加一张的成本只是一段字符串，
收益是整段 60 秒不重复。
十张的 STOP 码全是可读的梗：`0x0000LUCKY` / `0x00C0FFEE`（coffee）/ `0x0BADF00D`（bad food）/
`0x0BADC0DE`（bad code）/ `0x0DEFACED`（defaced）/ `0x0D15EA5E`（disease）/
`0x0DEAD10CC`（dead lock）/ `0x0CAFEBABE`（cafe babe）/ `0x0BAADF00D`（bad food 的第二种吃法）/
`0x0BA5EBA11`（baseball）。

**十张脸的硬约束**（`tools/bluescreen-check.mjs` 99 条断言钉着）：表情 / 背景色 / STOP 码 /
首句四者两两不重复，每张恰好四行、必有一行 `STOP:`、末行必留 ESC、必说清时长（60 秒 / 六十秒），
表情必须是 1~4 个可见 ASCII 字符（96px 下缺字的符号会变成豆腐块）。
这条检查抓到的第一件事就是**它自己**：原来的第二张脸写的是 `':( '`（多一个尾空格），
屏幕上和第一张完全一样 —— 十张脸里有两张是同一张脸，用户看到的还是少。已改成 `-_-`。
**靠空格区分等于没区分**，所以检查里不许表情带空格。

**关键实现细节**：事件定义里**同时保留静态 `visual` 和 `prepare(rand)`**。
静态那份不是冗余 —— `tools/host-smoke.mjs` 做的是静态源码解析，
看不见 `prepare()` 里生成的东西，删了静态那份会直接报
`FAIL  事件 bluescreen 标为 visual 却没有 visual spec`。
`prepare()` 的返回值在运行时覆盖静态值。

**弹窗**：`makeNode(kind, ...)` 三种皮 —— `classic`（Win95 灰底立体边框 + 蓝渐变标题栏
+ 黄底 `!` 图标 + 按不动的「确定」按钮）、`win11`（深色毛玻璃通知卡 + 左侧蓝色竖条）、
`plain`（原本的朴素框）。

皮的选择是 `KINDS[i % KINDS.length]` **顺序轮转**，不是随机：
随机可能连出二十个 Win11 卡片，看起来像没做好（用户会以为是 bug），
而不是像巧合。轮转保证一眼看到三种皮的对比，这正是「加点内容」想达到的效果。

`classic` 那个「确定」按钮**故意不绑 onClick** —— 「连按都按不动」是演出的一部分，
真要关掉就按 ESC（见 §14.6）。

### 14.8 为什么删掉「随机整理待办」，换成「随机发明一个东西」

用户说「整理待办这个没必要，然后想点新的点子」。
换掉它的理由不是「不好玩」，而是**它给的是你本来就有的东西** ——
待办清单读一眼就有，整理也只是换个顺序。
长按挖穿花的是 token 和一分钟，该换来一个原本不存在的东西。

选「发明」的三个理由：

1. **每次结果必不同** —— AI 不会两次画出同一台机器，不像新闻可能撞旧闻；
2. **允许它荒谬，所以不需要「对不对」这种评判** —— 一个不存在的东西没有事实
   可编错，天然规避了幻觉风险（这是选题时最看重的一条：长按事件里最容易出错的
   就是「AI 一本正经地说错事」，发明把这个问题从根上绕开了）；
3. **和幸运方块的世界观对得上** —— 敲开方块，里面蹦出来的就该是个新东西。

## 15. 设置面板：方块外观 / 事件权重 / 扩展接口

用户要求「这个插件的全部功能（至少大多数）都是用户可以自定义的，要保留接口」。
落成三块面板 + 一个自定义事件文件。

### 15.1 外观为什么不走宿主

`applyLook()` 只写客户端 state 和 localStorage，不发 HTTP。

方块长什么样纯粹是客户端的渲染状态，绕一趟 HTTP 往返对「改个圆角」是不必要的摩擦；
而且宿主要在配置里塞 `size` / `radius` / `shadow` 这些**字符串化的 CSS 值**，
就得开始解析和校验用户随手贴的一段 CSS —— 那是个没有底的洞。

改尺寸时 `x/y` 要 clamp 回视口内，但**不能复用 `snapGeometry()`**：
那是「松手才吸一次」的逻辑，尺寸滑杆拖动时连续触发会让方块反复挪位。

### 15.2 四个内建图案，其中三个是 CSS 画的

`face` 有 `lucky`（内联贴图）/ `command` / `tnt` / `pumpkin` / `custom`（用户图）五个值。
后三个用 CSS 现画而不是再找三张贴图，理由：

- CSS 图案能跟着 `radius` / `borderWidth` 一起变形，贴图不行；
- 用户之后能直接改颜色（贴图的配色是死的）；
- 少三份 base64，`lib/client.js` 是每次页面启动都要下载的入口。

渲染走 `faceFace(geometry)` 返回 `{tag, props}`，调用处一行 `h(face.tag, face.props)`。

### 15.3 外观草稿是独立 state

`lookDraft` 与 `geometry.look` 分开：前者是用户拖到一半的值，后者是已落盘、
方块正在用的值。混成一个 state 会让用户一边拖一边看到方块变形，且想撤销没有基准。

「恢复默认」走的是同一个 `applyLook(LOOK_DEFAULTS)`，保证「恢复」和「手动改」
经同一套 `normalizeLook()` 校验。

### 15.4 事件覆盖层的顺序：内置 → 第三方 → 用户

`buildEvents()` 的数据流刻意排成这个次序：

1. **内置事件**（`buildEvents()` 前半）—— prompt 和 prepare 都在代码里写死；
   音频事件在这一步由 `audioEvents()` 按曲库展开成 N 条；
2. **摘掉语料为空的**（joke / trivia）—— 音频不需要这一步，空曲库
   `audioEvents()` 本来就返回空数组；
3. **追加第三方事件**（`custom-events.json`）—— id 撞车时内置赢；
4. **贴用户覆盖层**（`config.json` 的 `events`）。

第三步放在第四步之前，是为了让用户能同时管内置和第三方事件；
第三步里内置赢，是因为一个只带 id/weight 的 JSON 造不出真的内置行为 ——
否则用户可以「把论文事件改成一个玩笑」，而那个 prompt 根本不是他写的那段。

### 15.5 事件写坏一条就整份忽略

`validateCustomEvent()` 对每条醒查 7 类字段（id / trigger / kind / title /
`lines` 或 `prompt` / weight / visual），**任何一条不合格就整份忽略**并返回
`custom-events.json 第 N 条不合格：<原因>`。

半份生效会让「我加的事件怎么没动静」变成一个只能靠读日志排查的问题。
原因显示在设置面板底部（红底 ⚠），文件不存在是正常状态（显示「0 条」）。

刻意不开放 `kind: 'visual'`：视觉事件的播放逻辑（弹窗、蓝屏）是客户端代码，
第三方塞一个 `visual` 对象进来，宿主要么忽略它（用户以为没生效）、
要么执行一堆它没写的播放协议。

### 15.6 保存事件设置用宿主回读的值刷新面板

`saveEventOverrides()` 成功后用 `res.value.events` 覆盖本地列表。
宿主对每个字段都做了白名单清洗，脏值被静默修正 ——
如果让面板继续显示用户刚输入的那个数字，用户会看到一个「保存成功但没生效」的数字。

失败**不**回滚（区别于音效开关的乐观更新）：列表十几行，
逐个字段回滚既容易写错，又会把其它已经改好的行一起冲掉。

### 15.7 扩展接口区是只读的

`persona` / `prompts` 两段只读显示当前值。刻意不做成编辑器：

- JSON 精度要求高，textarea 让用户直接粘贴整段更稳；
- 这里显示的是宿主回传的当前值 —— 上一段写坏了重新打开看到的还是那段坏内容，
  而不是被悄悄换成默认值（静默改写用户数据比不让编辑更危险）。

### 15.8 权重上限 100 与「0 = 关掉」

`clampWeight()` 夹到 `[0, 100]`。

上限原本是 25（当时单击池总权重 25，「一条事件最多占四分之一」）。
后来用户要求「音乐总概率 5% 左右」（m18477）：五首音乐合计 6 份，
要让它们只占 5%，非音乐五条就得落在 16~33 这一档。上限卡在 25 的话，
面板上填的 33 会被静默夹回 25 —— 用户看到的数字和实际生效的不一致，
而面板是这个池子唯一能改权重的地方。于是上限抬到 100。

`0` 不是异常值，是**用户显式表达「关掉」**：面板勾掉复选框时会把权重同时写 0，
两个字段说同一件事，不会出现「权重还在但事件没了」的假象。

`fallback` 参数是「事件本来的权重」，**不是下限** —— 否则用户写 0 想关掉事件，
会被悄悄抬成 1，然后看到一条关了却还在抽的事件。

### 15.9 单测里踩到的坑：正则抠源码会抠出半截函数

`tools/events-check.mjs` 要从 `lib/index.js` 抽 6 个纯函数来跑断言。
第一版用正则 `/function xxx\([\s\S]*?\n  \}/`，`applyEventOverrides` 里的
`for` 块收尾 `}` 和函数自己的收尾 `}` **缩进完全相同**（都是两空格），
正则停在第一个两空格 `}` —— 抠出来的是**前半截**。
测试照样跑，于是测的是半截代码，还一路绿灯。

改成 `grabBlock()`：从函数头往后数大括号，深度归零处就是真收尾，与缩进无关。
外加两道自检（每段 `{`/`}` 配平 + 每段单独过一遍 `new Function`），
截断会在加载阶段就炸，而不是拖到断言阶段输出一堆看不懂的 FAIL。

**这条对所有「从源码抽片段」的测试都适用** —— `snap-check.mjs` 抽吸附函数时
也要走同一套，否则改一次缩进就能让测试悄悄变成测别的函数。

## 16. 测试哲学：概率离线验，内容形状用指定事件

用户 m19010 问：「为什么不在测试的时候临时把出现概率调到 100%，直到模块完成，
再将概率回调？如果已经完善了，应该不用每次都测一遍概率吧。」

两个问题指向同一件事：**测试不该靠运气**。

### 16.1 三类断言分开，各用各的办法

| 断言种类 | 手段 | 该不该每次跑 |
|---|---|---|
| 权重合计、档位齐全、事件参数不矛盾 | `host-smoke.mjs` 静态解析源码 | 该，免费 |
| 签文分布（凶 0.1%、吉类 87%、每档五条） | `probe-fortune.mjs` 抠出 `drawFortune` 离线跑 20 万次 | 该，0.5 秒 |
| 某条事件的 payload 长什么样（歌词、音频、蓝屏十张脸） | `/roll` 带 `event` 指定，一次命中 | 该，改前必须 |
| 「抽取概率对不对」 | 不测 | 不测 —— 测它等于重算一遍除法 |

### 16.2 为什么不用「临时把概率调到 100%」

- 要改 `config.json`，**就会留下忘了还原的状态**；
- 生产路径为了测试多出一个分支，那个分支平时不跑，腐坏了没人知道。

改成请求体里的 `event` 参数就没有这两个问题：不落任何状态、不开分支
（它走的完全是生产路径的下游）。

### 16.3 显式事件不是「测试后门」

它的第一个用户是用户自己 —— 想连看五次蓝屏、想听听某首歌、想验某个自定义事件
配得对不对，都该能直接指定。把它做成只对测试开放的隐藏入口，就等于承认
「这条路径平时没人走」，那它迟早会坏。

### 16.4 踩过的坑

- `probe-audio` 原来用 `ROLL_LIMIT = 800` 反复点去碰 0.83% 的那首歌，
  300 次时真的失败过一次 —— **样本量不够时，随机性会冒充回归信号**。
- `probe-visual-ids` 原来靠随机撞 6 次视觉事件，撞到哪条也随机，
  「同一条断言今天验 popups、明天验 bluescreen」。
- `probe-local-path` 的随机循环原本「撞到 joke 和 trivia 就提前退出」，
  导致覆盖面取决于运气；现在固定 40 次只验不变量（零会话、无 agent 事件），
  正文断言全部改用指定事件。

## 17. 第二波事件：动效、自述、四个新长按

用户 m19279 说「还有什么好玩的随机事件」「感觉玩法还是不够多」，选了四类：
让屏幕动起来、关于插件自己的事、长按新点子（去掉假事故报告）、科乐美秘技。

### 17.1 三个动效：不产生内容的表演必须极短

`runaway`（方块窜到最远那角再滑回，2.6 秒）、`fake-cursor`（五只假光标游走，4.2 秒）、
`shake`（整页抖 0.9 秒）三者的共性是**一句话都不说**。这条共性是它们的设计约束：

- **必须极短**。冷知识可以停 30 秒，因为读它需要时间；动效一秒就读完了，多留一秒是浪费。
- **必须能被 ESC 立刻打断**。理由同上：没有内容可供拒绝，用户唯一想做的就是让它停。
- **不能做成现有事件的附属动效**。曾考虑「冷知识 30% 概率附带抖动」，
  否决理由：那样冷知识就有三成概率什么字都没出现，用户会以为是 bug。

实现上的两个坑（都写在 `lib/client.js` 注释里）：

- `runaway` 用 `transform: translate(...) rotate(...)` 而不是改 `left/top` ——
  位置由 `geometry` state 管，改 `left/top` 会和拖拽、贴边吸附打架。
  但 `transform` 用完必须还原 `prevTransition`，否则会弄掉吸附用的
  `transition: left .16s, top .16s`，之后方块贴边就不再"吸"过去。
- `fake-cursor` 不能靠 CSS 的 `cursor` 属性 —— 覆盖层是 `pointer-events: none`，
  永远不会被悬停，`cursor` 自然也不显示。只能用真的 `div` + 内联 SVG 箭头图片。
- `shake` 抖的是 `document.body` 而不是插件的覆盖层。抖覆盖层等于「方块在抖」，
  那是另一个事件（"方块自己跑掉"已经负责那件事）。动画最后一帧必须归零，
  否则 `body` 会永久偏移一两像素 —— 这种错极难看出来，只会让人说「界面有点歪」。

后来加的 `blackout` / `false-alarm` / `table-flip`（见 §19）仍然受这三条约束，
但各自又对「极短」或「能打断」破了一条 —— 破得有理由，都写在 §19 里。

### 17.2 自述事件：念真数字，所以计数必须先于取内容

`pedigree`（使用记录自述）念三行：点了多少次（其中几次长按）、从哪天算起第几天、
以及按长按比例三选一的一句评价。它**不需要 AI**，但需要真实计数。

为此 `persona-state.json` 从「只存当天」扩成累计：`clicks` / `holds` / `since`。
老状态文件没有这些字段时，`clicks` / `holds` 归零、`since` 取今天 ——
**没有依据的日期比没有日期更容易被当成 bug**，所以宁可当它是今天开始的。

顺序是硬性的：`advancePersona()` 必须在 `event.prepare()` **之前**。
否则它念的数是「不含这一次」的，而状态文件里已经是「含这一次」的 ——
用户看到 216、文件里 217，这一条就成了整个插件里唯一说谎的地方。
代价是 `prepare()` 抛错时计数已经加了，这个代价可以接受（计数多一次不会有人发现，
但报错一个假数字会）。

这也改了 `prepare` 的签名：`prepare(rand, personaState)`。第二个参数是这次 roll
之后的完整状态快照，避免每个事件自己去读盘。

### 17.3 短篇小说：三个不相干的词就是情节

`novel` 从 `lib/novel-words.json`（约 105 个词）里随机抽三个，要求三个词都真的参与情节。

**为什么是三个而不是一个**：一个词（"台风"）会写成散文或随想；
三个互不相干的词（"冰箱 / 遗嘱 / 台风"）**必须编出一个故事**才能同时用上 ——
约束本身就是情节，不需要再写一句"要有情节"。

**为什么词必须是具体名词**：`local-check.mjs` 有一条断言禁止
`/(感|性|主义|状态|意识|概念|本质|意义)$/` 结尾的词。
抽象词不需要冲突就能塞进任何句子（"他感到了孤独"），
具体词不行（"他手里的假牙"要求一个场景）。词库的 `note` 另记了一条约束：
同一条里不许出现两个同场景的词，否则第三个词会被它们吸进去，故事自动变成那两个词的。

### 17.4 三个新长按事件的共同选法：都要有一个可验证的形状

`absurd`（荒诞小剧场）、`rebuttal`（自我反驳）、`manual`（无用说明书）
各自都规定了**格式**而不只是"写点什么"：

| 事件 | 硬格式 | 为什么 |
| --- | --- | --- |
| absurd | 两个角色、带角色名、像剧本 | 不规定就会写成一段散文，「那个东西遵守自己的逻辑」就看不出来了 |
| rebuttal | 先立论点说圆 → 明确写出「这个说法有问题」→ 反驳 → 不给新结论 | 最后一条是关键：给了新结论就变成"正反两面看问题"，那是最没有意思的收尾 |
| manual | 分条目带编号、有「注意事项」和「常见问题」 | 格式是笑点的载体 —— 内容荒唐但形式严谨才叫幽默，反过来只是胡说 |

这三条也因此给了 `probe-dice-prompt.mjs` 可写的特征词
（`novel` 找人称与叙事词、`absurd` 找冒号、`rebuttal` 找转折词、`manual` 找编号与"注意事项"）。
**标记要贴结构而不是贴结论** —— 这条教训来自 `invent`：原来只写「副作用」一个词，
实测回复里它被预览截断成「副作」，于是一条完全正确的回复报了 FAIL。

### 17.5 科乐美秘技：彩蛋不占权重，也不吞按键

`↑ ↑ ↓ ↓ ← → ← → B A`，连按触发方块变金四秒 + 一声碎裂音 + 一句「你居然知道这个」。

三条设计判断：

1. **不占事件池权重**。彩蛋是"我按出来的"，随机事件是"它自己蹦出来的"。
   把彩蛋放进池子里，它就变成了一个会被随机触发的普通事件，而"知道这个指令"
   这件事本身的价值就没了。
2. **一律不 `preventDefault`**。方向键在 dsh 里可能有用（选择历史消息、移动光标），
   为了一个彩蛋吞掉用户的按键，代价远大于收益。
3. **挂 `window` 而不是方块节点**。用户可能在输入框里打字时顺手按出来，
   而这正是这串指令的乐趣所在：它不属于任何一棵 DOM 树。

状态机用 `event.key` 而不是 `keyCode`（后者已废弃，且按住 Shift 时两者不一致），
比较前统一 `toLowerCase()`，所以大写 `B` `A` 也算。
停超过 2 秒进度清零 —— 否则早上按三下、下午按七下也能触发。

`tools/konami-check.mjs` 用源码抽取跑了 17 条断言。它值得单独存在的原因是：
这段代码**没有任何输出**，"按错了没反应"和"按对了也没反应"在界面上长得一样。

## 18. 设置保存即生效：重建事件池，而不是重启

### 18.1 问题在哪里

事件池在 `apply()` 里建好一次就再也没变过：

```js
const events = await buildEvents()
```

于是用户改一个权重、关掉一条事件，都必须重启 dsh。这不是 dsh 的限制 ——
`apply()` 只跑一次是插件模型，但**池子本身是纯数据**，什么时候重建都行。

用户的原话是「为什么每次都要重启才能得到重新设置后的效果，不能直接出现吗」。

### 18.2 改法

`apply()` 里把 `const events` 换成可变的模块级变量 + 一个重建函数：

```js
let events = []
async function rebuildEvents(reason = null) {
  events = await buildEvents()   // 只在成功后才赋值
  ...
}
await rebuildEvents()
```

`saveSettings` 在写完盘之后，**只有 patch 里带 `events` 时**才重建。

三个判断：

1. **只在改事件时重建。** 只改音效开关时重建等于白读四个语料库
   （冷知识 818 条、笑话 353 条 + 30 条点评、五首歌、词库），
   而 `sound` 是客户端读到之后自己应用到播放引擎实例上的，宿主侧无事可做。
2. **`rebuildEvents` 先算再赋。** `events = await buildEvents()` 里的赋值发生在
   右侧求值之后，`buildEvents()` 抛错时 `events` 还是旧的 ——
   不会出现「一半新一半旧」的池子。
3. **失败要把话说出来。** 写盘成功但重建失败时返回 `ok: false` 并带上原因，
   而不是假装成功：用户会看到「设置已写入，但事件池重建失败」，
   而不是「面板上改了、抽出来还是旧的」这种只能靠猜的问题。

### 18.3 由此冒出来的两个副产品

**`defaultWeight` 必须在贴覆盖层之前记。** `applyEventOverrides` 会把
`weight` 换成覆盖后的值，不先记出厂值就永久丢了：用户把某条调到 6，
面板上的「恢复默认」会恢复到 6 —— 等于什么都没恢复。

**面板必须列 `allEvents` 而不是 `events`。** 这是改热重载时**改出来的一个真回归**：

`settings()` 原本拿 `events`（已贴过覆盖层）去列清单，而关掉的事件在
`applyEventOverrides` 里被整条摘掉。于是「在面板上关掉一条」= 「那条从面板上消失」，
用户再也打不开它。而「关掉」这个动作本来就是在面板上做的。

修法是在 `buildEvents()` 的返回值上挂一份没贴覆盖层的完整清单：

```js
const live = applyEventOverrides(marked, eventOverrides)
live.allEvents = marked
return live
```

`settings()` 列 `events.allEvents ?? events`，回显的 `enabled` / `weight`
仍从 `overrides` 取。`probe-settings.mjs` 有两条互补断言钉住它：
关掉之后**仍在面板里**（`weight = 0`），但**已不在运行期池里** ——
两条一起才说明「关掉」既不是「删掉」也不是「只是标个记但照抽不误」。

顺带一个判据的修正：只手写 `{ weight: 0 }` 时回显的 `enabled` 仍是 `true`
（`enabled` 字段根本没被写过）。断言要看 `weight === 0` 而不是 `enabled === false`，
否则会把一种合法的关法判成坏的。「关掉」有两个并列条件，
`applyEventOverrides` 里是 `patch.enabled === false` 与 `weight <= 0` 各走各的。

### 18.4 探针也要对付「用户关掉了东西」

改完热重载之后，`probe-settings` / `probe-audio` / `probe-fortune` /
`probe-local-path` / `probe-persona` 一口气红了——**不是代码坏了**，
是这些探针打的是真实宿主，而用户已经把 fortune / trivia / joke / news
等事件全关掉了。关掉的事件在 `buildEvents` 里就被摘掉，于是：

- 「事件清单含 joke」直接不成立；
- `event: 'joke'` 变成「没有 id 为 joke 的事件」，报出来的却是「指定 joke 拿得到 value」；
- `probe-fortune` 连 fortune 都指定不到，5 条断言全红。

这和 `host-smoke` 那个坑同源。区别是 host-smoke 打本地 import，能把
`DSH_HOME` 指到临时空目录；探针打的是真实宿主，只能**备份 + 清空 + 还原**。

统一模式（五个探针一致）：

```js
const userEvents = (await api('/dsh-lucky-block/settings')).json?.value?.eventOverrides ?? {}
await api('/dsh-lucky-block/save-settings', { method: 'POST', body: JSON.stringify({ events: {} }) })
// ... 跑断言 ...
await api('/dsh-lucky-block/save-settings', { method: 'POST', body: JSON.stringify({ events: userEvents }) })
```

还原那一句放在**唯一的收尾处**，不塞进各条分支 —— 探针里有好几处提前
`process.exit`，漏一处就把用户的配置留在清空态，他重启后会发现
「我关掉的事件全回来了」，而且不知道是谁干的。

教训一句话：**探针不能假设用户没动过设置**。默认状态是代码的性质，
当前设置是用户的性质，验代码就得先把用户那层摘掉。

## 19. 第三波动效：停电、假警报、掀桌（m00160）

用户从「网上能查到的彩蛋」清单里挑了第一组（R.E.P.O. 幸运方块 mod 的 Blackout /
False Alarm、Google 表单的掀桌）。三个都是**屏幕级别的玩笑**，都不产生内容，
所以仍然落在 §17.1 的约束下 —— 但它们各自又多破了一条老规矩，
而每条破例都换来了别的东西。

### 19.1 停电：唯一一个故意违反「必须极短」的

8 秒（`BLACKOUT_MS`）。§17.1 说动效超过一秒都是浪费，这里的例外有明确边界：

- **时长本身就是内容**。「黑了这么久而你居然还在等」是这个事件的全部笑点。
  短于 6 秒只会像闪了一下（为什么不是 bug 都看不出来），超过 10 秒则真的会有人去关窗口。
- **遮罩必须吃掉点击**（`pointer-events: auto`）。这是和 `fake-cursor` 完全相反的选择：
  同样是一层全屏 `div`，假光标不能吃点击（它是来陪你的），停电必须吃点击
  （看不见的界面上乱点，代价远高于什么都不做）。
- **z-index 100004**：压在弹窗 / 蓝屏（100000）和假光标（100005）之上，
  但**在方块（100010）之下** —— 停电时方块必须还亮着，否则「只剩它自己还在」
  这个画面就不成立，事件退化成一块黑布。
- ESC 立刻恢复供电，和另外五个动效一致。

### 19.2 假警报：梗在两段之间那 2.6 秒

文案成对写（`FALSE_ALARM_LINES` 里每项都是 `{ suspense, payoff }`）。
只写一半就会退化成「普通的提示条」—— 而这个事件的名字叫假警报，它必须
**先真的让人等一会儿**，然后才说没有。

- 悬念段有一颗跳动的圆点（inline `animation`），收尾时圆点停下、变灰、
  左边框也变灰 —— 视觉上「泄气」，这是不用文字也能读懂的收场信号。
- **时长分配是硬约束**，写进 `host-smoke`：`suspenseMs ≥ 1500`，
  且 `durationMs - suspenseMs ≥ 600`（不然那句「没有东西」还没看清就没了）。
- 两条弯路记在这儿：`animation` 的 `both` 会把 keyframes 的 forwards 状态留着，
  收尾时直接设内联 `opacity: 0` 会被它盖掉 —— 必须先 `remove` 掉那个类再设透明度。
  另一条：任何「跳动 + 等待」的组合都会被读成加载中，所以收尾文案必须直说
  「没有东西」，不能指望用户自己反应过来。

### 19.3 掀桌：不转整个页面

原型是 Google 表单那个彩蛋：标题写 `(╯°□°）╯︵ ┻━┻`，表单整个转 360°，
然后标题变成 `┬─┬ノ(゜-゜ノ)`。这里**只保留了颜文字那半，砍掉了转页面**：

- `transform` 挂在 `body` 上会给所有 `position: fixed` 的后代重建包含块，
  DSH 的浮层（包括方块自己）会跟着错位 —— 那是真 bug，不是玩笑。
  `filter` 同理（这也是「彩虹 / 缩水」那一类一直没做的原因）。
- 笑点因此从「页面转」换成「两个颜文字的前后反转」：先砸下来一张，
  停一下，再换回扶起来的那张。
- 两张脸叠在一个 `height: 0` 的容器里绝对定位 —— 换脸的那一刻容器高度不会变，
  否则整行字幕会先跳一下再稳住，看起来像没对齐。
- 等宽字体是必须的：`(╯°□°）` 和 `┬─┬ノ` 在比例字体里宽度不同，
  翻回来的桌子会「歪」，笑点立刻变成排版事故。

### 19.4 检查脚本这次多盯了什么

- `host-smoke`：三个新事件必须 `kind: 'visual'`；spec 字段逐个点名
  （`blackout.durationMs`、`false-alarm` 的四个字段、`table-flip` 的 `flip/unflip`）；
  时长边界（停电 ≥ 5000，另两个 ∈ (0, 6000]）；假警报两段时长的关系。
- 为了让这些断言读得到 spec，`/ping` 多了一个 `visualSpec` 字段。
  原先只有 `visual: 'blackout'`（一个 kind 字符串），**读不到 `durationMs`** ——
  那种形状下所有断言都会因为「字段是 undefined」而假绿。
- `show-check`：三条 `beginShow` 接线、停电吃掉点击、六个 `run*` 的收场纪律
  （`registerEscape` / `onDone()` / `unregister()`），以及**每个挂上去的动画类
  都有对应的 `@keyframes`**。最后这条是因为：keyframes 少一条不会报错，
  元素只是不动，而且只在抽中那条事件的那零点几秒里「什么都没发生」——
  和「这次随机到静默事件」完全分不清。
- 两个新断言都做了**故意改坏**验证：把 `suspenseMs` 改成 900、把
  `@keyframes dshLuckyFlipOut` 的名字改错，都必须变红。不红就是没验到。
- 新增 `tools/visual-run-check.mjs`。前两个脚本都是「读源码 / 看结构」，
  它们证不了 `runBlackout` **跑起来**不会炸（变量名写错、`this` 用错、
  定时器忘了进数组，正则一条都看不出来）。这个脚本用最小假 DOM
  （会解析 `cssText`、`className` 与 `classList` 共用一份数据）+ 假定时器
  （能按时间线推进、能问「还剩几个没跑」）把三个函数真的执行一遍：
  60 条断言覆盖每一拍的中间状态、ESC 掐断、二次 ESC 不重复收场，
  以及收场之后「层删了 / 登记表空了 / 定时器队列空了」这三件事。
  它的敏感度也验过：把 `runBlackout` 里的 `unregister()` 删掉，立刻变红。
  （后来三轮动效把它涨到 176 条：手滑 22 条、彩虹 / 缩水 / 变大 / 低重力 81 条，
  ESC 一节从四场扩到七场 —— 见 §21.3 与 §23.5。）

## 20. 设置面板分页：两个池分开算账（m00494）

用户报的是「单击和长按放到同一页还是乱序，不是很好用」。拆开看是两件事，
而且第二件比第一件重要。

### 20.1 混排真正坏掉的是**分母**

原来的列表是 `settingsOpen.events` 平铺，每行尾注两个字「单击 / 长按」。
顺序本身其实不是随机的 —— 它是 `buildEvents()` 的拼装顺序 —— 但对用户来说
就是乱的，因为没有**可预期的规则**。

但比顺序更麻烦的是：那张表算不出占比。单击池 120 份、长按池 16 份，
宿主是**分池抽**的（`trigger` 决定从哪个池里抽）。混在一个分母里，
长按事件会显示成 0.x% —— 那既不是它的真实概率，也没法用来判断。
两个池分开算账之后，每一页的分母就是它自己池子的权重合计，占比才成立。

### 20.2 排序按出厂权重，占比按当前权重

这两件事必须在不同的字段上做，否则面板会自我打架：

- **行序**用 `defaultWeight`。用当前权重排序的话，用户在输入框里改一个数字，
  那一行立刻跳到别处 —— 正在编辑的那一行从手指底下跑掉，比乱序更难受。
- **占比**用当前权重。它回答的是「下一次点方块，抽中它的概率是多少」，
  用出厂权重算就是撒谎。

排序是 `defaultWeight` 降序、并列按 id，所以行序是确定的：
同一份配置任何时候打开面板，看到的是同一个顺序。

### 20.3 两个字段说同一件事，就在一处折平

`enabled: false` 与 `weight: 0` 都是「关掉」，宿主按 `weight <= 0` 摘事件。
分组函数里把它们统一折成 `weight = 0`：面板上的数字、占比、池子里的真实概率
是同一个数，不会出现「勾掉了但显示 4」或者「占比 3.3% 却永远抽不到」。

被跳过的情况只有一种：**没有 id 的行**。而没有 `trigger` 的行走单击页 ——
宁可多一行让人看得见，也不要一行凭空消失。

### 20.4 `tools/panel-check.mjs`

纯函数，所以直接抽源码跑，33 条断言钉的都是「悄悄坏掉也不会报错」的地方：
长按事件漏进单击页（分母就错了）、改权重导致跳位、`0/0` 产生 `NaN` 占比、
负权重 / 字符串权重 / `enabled:false + weight:9` 这类脏数据。
另外四条是**接线断言**：面板确实调了 `groupEventsForPanel`、两个页签都在、
分页状态挂在 `settingsOpen.eventTab` 上，以及旧的平铺 `.map` 已经删掉
（同一个列表不可能既分页又平铺，留着它迟早有人改错那一份）。

敏感度也验过：把排序反过来、把占比分母写死成 136，7 条断言立刻变红。

## 21. 第四波动效：手滑（黄油手）（m00576）

源头是 R.E.P.O. 那个幸运方块 Mod 的 `Butter Fingers`：手里的东西掉了。
搬到浏览器里立刻遇到一个翻译问题 —— **这里没有「手」**。
所以掉的对象只能是方块自己：它从你手里滑出去，直直掉出屏幕，再被捡回来。

### 21.1 掉下去的是复制品，原节点只是藏起来

第一反应是给方块本身挂一个掉落动画，但方块是 React 管的节点：`left/top` 来自
`geometry`，外观来自 `look`，拖拽中途还挂着 `transition:none`。把它挪出屏幕再放回来，
下一次渲染就会跟它打架（React 只知道自己的 props，不知道我们动过 style）。

所以分两半：`block.cloneNode(true)` 出来的那份掉下去，原节点挂一个
`.dsh-lucky-butter-hidden { visibility: hidden }` 藏 0.9 秒，然后摘掉 class 再弹一下。

- **为什么 `visibility` 而不是 `opacity: 0`**：方块自己的 `transition` 里就有
  `opacity .15s`（忙闲态用的），用 opacity 会先淡出 150ms 才开始掉，看着像两段。
  `visibility` 不在任何过渡列表里，是瞬时的。
- **为什么 `visibility` 而不是删节点**：React 手里那份引用还在，删掉就是让它去操作
  一个不在文档里的节点。藏是它唯一允许的静默态。
- **藏的反面只有一个回收点**：`finish()`。所以 ESC 掐断、自然结束、节点缺失兜底，
  三条路都必须摘掉那个 class。漏了不会报错，只会让方块从屏幕上消失到刷新为止 ——
  visual-run-check 里专门有一条断言钉它（见 21.3）。

复制品必须**按屏幕坐标**重新定位（`getBoundingClientRect()`），不能沿用
`geometry.x/y`：拖到一半时两者并不一致，而这里要的正是「此刻它在哪」。
`z-index: 100004` —— 在方块本体（100010）之下，所以掉下去的副本不会盖住
还站在原地的那块；同时高于页面内容。

### 21.2 三段用比例，不用毫秒

```
fallMs   = round(total * 0.56)   // 掉
bounceMs = round(total * 0.26)   // 弹回来
剩下的 18%                        // 收场
```

宿主改 `durationMs` 时三段一起缩放，不用改三个常数。掀桌也是这个写法。

掉落曲线是加速的（`cubic-bezier(.42,0,.9,.55)`），不是匀速：匀速看着像
「元素被移走了」，加速才像「掉下去」。整段动画里最要紧的是**第 12% 那一帧反向抬手**
（`translateY(-14px) rotate(-9deg)`）—— 没有它，方块是凭空开始下坠的，
像被删除；有了它，才像手没夹住。

### 21.3 检查脚本抓到的两件事

写完先跑 `visual-run-check`，红了两条，两条都是真问题：

1. **`clearTimeout` 写成了裸调用**。这个文件里所有多定时器的收场都是
   `window.clearTimeout(...)`（3081 / 3211 / 3291 / 3382 行），我漏了 `window.`。
   浏览器里裸调用照样能用，所以**这条永远不会在真机上暴露** —— 但在假 DOM 里，
   `window` 是注入的对象，裸调用落到 Node 的全局函数上，一个定时器都没撤掉，
   断言直接报「ESC 后定时器全撤 → 实际 3，期望 0」。
   这正是「真跑一遍」和「正则看一眼」的分界线。
2. 我拿 `cssText` 断言 `z-index`，但那一行是逐条赋值（`clone.style.zIndex = ...`），
   假 DOM 里 `cssText` 不包含它。改断言，不改实现 —— 实现没问题，是断言选错了字段。

故意改坏的敏感度验证：把 `finish()` 里的 `classList.remove('dsh-lucky-butter-hidden')`
删掉，`黄油手：ESC 后方块没被留在不可见状态 —— 实际 true，期望 false` 立刻变红。

## 22. 整页特效的包含块红线：剩下四个为什么先不做（m00576）

用户当时问「顺便把剩下几个验证一下」，指的是清单里还没做的四个：
低重力 / 彩虹 Rave / 缩水 / 巨人。它们的共同点是**看起来都得动整个页面**，
而「动整个页面」在浏览器里有一个很硬的坑。

### 22.1 触发条件

按 CSS 规范，一个元素只要满足下列任一条，就会成为 `position: fixed` 后代的包含块：

- `transform` 不是 `none`
- `filter` 不是 `none`
- `perspective` / `backdrop-filter` 不是 `none`
- `contain` 含 `layout` / `paint` / `strict` / `content`
- `will-change` 指定了上面任意一项

也就是说，`body { transform: ... }` 一旦生效，**所有 `position: fixed` 的后代都会
改以 body 为包含块**。纯平移（body 抖动）几乎看不出来，因为 body 的盒子和视口
基本重合；但**缩放和旋转会立刻显形**：fixed 元素跟着缩、跟着转、位置按 body 的
尺寸重新算，dsh 自己的浮层（本插件方块、通知、菜单）全都会错位。

`zoom` 不在这个列表里 —— 这是关键区别，见下面缩水那一条。

### 22.2 逐个体检

| 事件 | 直觉实现 | 结论 | 安全做法 |
| --- | --- | --- | --- |
| 彩虹 Rave | `body { filter: hue-rotate(90deg) }` | ✗ 踩坑 | 全屏 `position:fixed` 覆盖层 + `mix-blend-mode: overlay`（或半透明彩带），覆盖层自己是 fixed，不碰任何别人 |
| 缩水 / 巨人 | `body { transform: scale(.8) }` | ✗ 踩坑 | `document.documentElement.style.zoom = 0.8`：`zoom` **不创建包含块**，整页按比例缩、fixed 元素跟着缩，正是「页面缩水」的效果。Chromium（Electron / dsh 桌面端）原生支持 |
| 低重力 | 没有对应物 | △ 要降级 | 浏览器里没法给别人的布局加物理。「低重力」只能落在**方块自己**身上：拖拽阻尼变大、松手后缓慢下滑一段再停。属于拖拽逻辑改动，和包含块无关 |

补充两条实操注意：

- `zoom` 会改变 `getBoundingClientRect()` 的坐标系。方块拖拽逻辑读的就是它，
  所以缩放期间如果同时拖方块，坐标要换算；最省事的约束是**缩放只在非拖拽时触发**，
  或者干脆退到「只缩放方块自己」（`node.style.transform = 'scale(.7)'`，零风险，效果弱）。
- 全屏 `backdrop-filter` 在弱 GPU 上可能掉帧。彩虹如果做，优先「半透明渐变条 +
  `mix-blend-mode`」（走合成层，便宜），`backdrop-filter` 作备选。

结论：三个可做（彩虹 / 缩水 / 巨人），一个要改目标（低重力）。
按用户「先做一，做完一再看」的节奏，这一轮只留档，不动手。

### 22.3 把规则钉进检查脚本

这种坑的特点是**只在缩放/旋转时才显形**，而且以后很可能被重新引入。
所以 `show-check.mjs` 里加了一条结构性守卫：

```js
!/(body|documentElement)\.style\.(transform|filter|willChange|perspective)\s*=/.test(source)
```

它拦的是「直接给 body / documentElement 逐条赋这些属性」这种写法。
已知的例外是 body 抖动：它走 class + `translate3d` keyframes，是纯平移、
结尾归零，且不做缩放，所以不在这条断言的射程内。

## 23. 第五波动效：彩虹、缩水、变大、低重力（m00792）

用户看完 §22 的体检表后说「先把彩虹 / 缩水 / 巨人 / 重力做了吧」。
四个事件一起进，但**没有一个真的去碰 body 的 `transform` / `filter`** ——
§22 的那条红线没有为了「做出来」而松，反而是四个各走了一条绕路。

### 23.1 彩虹：颜色长在遮罩自己身上

一层 `position:fixed; inset:0; z-index:100004; pointer-events:none;
mix-blend-mode:overlay` 的 `div`，背景是一条 7 段的线性渐变（品红→紫→蓝→青绿→
黄→橙→回品红），`background-size:300% 100%` + 2600ms 无限循环地推 `background-position`。

- **不用 `body{filter:hue-rotate()}`**：那会重建 body 的包含块（§22），而且
  `hue-rotate` 把所有颜色一起拧到同一个色相 —— 那不是「世界换了颜色」，
  那是「显示器坏了」。
- **不用 `backdrop-filter`**：§22 记过它在弱 GPU 上掉帧。
- `mix-blend-mode` 落在**层自己**身上，所以它需要一个「底」才能混：底就是它下面的
  真实页面。这正是想要的 —— 文字、方块、面板都还在，只是被染了色。
- `pointer-events:none`：彩虹演的是「世界变了颜色」，不是「现在不能操作」。
  后者是停电。
- 一层 `transition:opacity .34s` 淡入淡出，`total-340` 时把 opacity 压回 0。
  颜色硬切进来会像 bug，硬切回去会像闪了一下 —— 两头都要淡。

**它和方块的层级关系是刻意的**：方块本体 `z-index:100010`，遮罩 100004。
彩虹盖住整个世界，唯独不盖住幸运方块 —— 那块方块是这个插件的主角，
它跑到彩虹底下就变成一张普通贴纸了。

### 23.2 缩水 / 变大：`zoom`，不是 `transform`，也不是 `scale`

两个事件共用 `kind:'zoom'`，方向由 `spec.factor` 决定（默认 0.8 / 1.2，
来自配置里的两个百分比 —— 后来被 m01407 做成了设置项，见 §25）。
客户端只有一个 `runZoom(visual, block, onDone)`。

- `documentElement.style.zoom = String(factor)`。**`zoom` 不在「会重建包含块」的
  属性列表里** —— 它改的是布局尺度，`position:fixed` 的后代跟着一起缩，
  而且缩放后的坐标量出来仍然自洽。这是 §22 那张表里唯一标「△ 可以」的那条，
  现在用上了。
- 夹在 0.6~1.6：`0.5` 以下整页没法用，`1.6` 以上按钮会被挤出视口。
  `factor` 缺失或 `<=0` 回落到 1（「什么都没发生」永远比「缩没了」安全）。
- **缩放期间方块禁止拖动**（`pointerEvents:'none'`）：坐标系变了，
  拖一下就会把 `left/top` 写歪，收场后方块会停在一个没人点过的地方。
- 收场还原 `previousZoom` 与 `previousPointer` —— 不是一律清空。
  宿主或别的插件可能已经设过 zoom，清空等于把别人的设置一起吃掉。
- 刻意不做过渡：`transition: zoom` 在 Chromium 上不生效（zoom 不是可动画属性），
  硬切反而更贴合「整页被谁拧了一下」的荒诞感。
- 和彩虹相反，它**挡得住点击吗？** 挡不住也不打算挡 —— 它只有 3 秒，
  而且缩放中点击仍然落在正确的元素上（zoom 一起缩了坐标系）。挡了就变成停电的重复。

### 23.3 低重力：只动方块，用 `translate` 不用 `transform`

`spec.durationMs = 3400`，`block.classList.add('dsh-lucky-low-gravity')` +
inline `animation-duration`。

- 关键帧：0% 原位 → 18% 抬 2vh → 46% 抬 6vh → 58/70/82% 三次越来越小的横向晃 →
  92% 回 6vh → 100% 归零。
- **走独立的 `translate` 属性**（`@keyframes{translate:0 -6vh}`）而不是 `transform`：
  方块自己的 `transform` 正被忙闲态（`translate3d` 跑位）和弹回动画占着，
  写 `transform` 会静默顶掉它们 —— 不报错，只是方块不听话了。
- 飘多高用 `vh` 写死，不问屏幕要像素：`vh` 天生按比例，
  也顺便躲开「zoom 正在跑时 `getBoundingClientRect()` 不准」——
  这是上一轮黄油手必须量 `rect` 留下的隐患，低重力刻意避开。
- 100% 必须归零，否则 `classList.remove` 那一瞬间会跳回原位。
- `both` 填充：抬起来的姿势要一直保持到动画结束，不能过了 50% 就自己滑回去。

### 23.4 账：动效到 55/120

四个事件各 3 份 = 12，来源四笔：popups 9→6、bluescreen 9→6、trivia 25→21、
joke 18→16（§14.2 也记了这一笔）。动效合计 55/114 ≈ 48%。
这条线是刻意的：**表演不该超过一半**。下次再加动效，请先从动效里挪。

### 23.5 检查脚本

- `show-check`（125 条）：六个分发接线断言、`runRave/runZoom/runLowGravity`
  进 `registerEscape` 循环、两对动画名、以及三条正面断言 ——
  `root.style.zoom = String(factor)`（zoom 的存在本身要钉住）、
  彩虹层的 `pointer-events:none`、低重力关键帧里的 `translate:`。
- `host-smoke`：四个 id 进「必须存在的 visual」、`factor` 进必填字段、
  时长 ≤6000ms、`shrink` 的 factor 必须 <1 且 `giant` 必须 >1（方向写反了，
  用户只会看见「放大了一下」，事件的意义就反了）、区间夹在 0.6~1.6。
- `visual-run-check`（176 条）：三节新测试。彩虹测到「`total-340` 时 opacity
  已回 0 但层还在」这一帧（先淡出再删层，顺序写反会看到一帧硬切）；
  缩放测到「原来就有 zoom 时还原成原值而不是清空」；低重力测到
  `total-1` 时还在飘、`total` 时类与 inline 时长双双收回。
  ESC 一节从四个动效扩到七个，并新增两条残骸断言：
  **整页不许被留在缩放状态里**、**方块不许被留在动画状态里**。

假 DOM 这次补了一处保真度问题：浏览器里「没设过的内联属性」读出来是空串，
Node 里是 `undefined`。`runZoom` 是「记下原值再还原」的写法，
这个差别会让「还原成空串」被读成 `"undefined"` —— 测试误报，真机正常。
`makeEl` 因此按浏览器语义把 `zoom / pointerEvents / animationDuration /
transition / opacity` 预置成 `''`（照浏览器来，不照 JS 来）。

## 24. 真机 bug：`nodeRef is not defined`（m01307）

### 24.1 用户报的原话

> 方块启动失败（giant）：nodeRef is not defined
> 方块启动失败（shrink）：nodeRef is not defined

两条都指向同一件事：上一轮（§23）新加的整页缩放，一抽到就炸。报错里的
`（shrink）` / `（giant）` 是前一个提交 `978cdb4` 才加上的事件名 —— 在那之前
用户能报的只有「有个单击事件会冒出方块启动失败」，十二个动效里挑一个，
等于没报。**报错文案的定位价值，通常比错误本身更重要。**

### 24.2 根因：一个名字只在组件里存在

- `runZoom` 和其他 `run*` 一样写在**模块作用域**（2 空格缩进那群函数里），
  而它内部写了 `var block = nodeRef.current`；
- `nodeRef` 是组件里的 `var nodeRef = useRef(null)`（`lib/client.js:1158`），
  模块作用域根本没有这个名字 → `ReferenceError`；
- 第二个入口同样中招：调试 API `zoom(factor, durationMs)` 也调
  `runZoom({...}, resolve)`，想让跑起来时同样没有 block。

修法是把节点**当参数递进去**，和 `runRunaway` / `runButterFingers` /
`runLowGravity` 保持同一个约定：

```js
runZoom(visual, block, onDone)                       // 模块作用域只吃参数
runZoom(visual, nodeRef.current, zoomEnd)            // 组件里取 ref 再递
```

### 24.3 为什么 176 条真执行检查全绿

`tools/visual-run-check.mjs` 用 `new Function(...)` 把抽出来的函数体拼起来跑，
而它当时多注了一个参数 `nodeRef`（因为 `runZoom`「看起来需要它」）。于是模块
作用域里凭空多出一个 `nodeRef`，那个不存在的变量被测试替身补上了 ——
检查当然全绿。一句话教训：**测试替身不许替实现圆谎**。

### 24.4 两边都堵

- `visual-run-check`：`session()` 不再注入 `nodeRef`，并把这条理由写在代码里
  （谁想加回去会先读到）。真读它就会直接 `ReferenceError` 崩掉 ——
  比「安静的绿」好得多。
- `show-check` 新增一节「动效函数不越界读组件变量」：把 12 个 `run*` 的函数体
  抽出来逐个扫组件作用域名单（`nodeRef / showRef / soundRef / quipTimer /
  lyricTimer / broadcast(Finish|Escape|Timer) / setError / setBusy / setQuip /
  setCenterText / beginShow / startLyricPoll / broadcastText / say`），命中就把
  名字写进 FAIL 文案。show-check 128 → 140 条。

### 24.5 敏感度：两种失败形态都验过

把 `var block2 = nodeRef.current` 加回 `runZoom`：

- `show-check` → `FAIL 动效 runZoom 只吃参数、不读组件变量（发现 nodeRef）`
  （139/140）；
- `visual-run-check` → 直接抛 `ReferenceError: nodeRef is not defined`，退出码 1。

已还原，恢复 140 / 176 全绿。

### 24.6 顺带记下的一条规矩

模块作用域的函数只吃参数，组件作用域的东西（ref、setState、`say`、`beginShow`）
一律由调用方递进来。这条规矩以前是口头约定，现在是 `show-check` 里 12 条断言。

## 25. 缩放幅度做成设置项（m01407）

### 25.1 用户的原话

> 变大变小的幅度太小了，这个可以作为设置里的调节项吗

一句话里两件事：默认值不对（15% 在 2K 屏上要盯一眼才看得出），
以及**这个参数不该由我拍**。两件都照办。

### 25.2 为什么这个参数放开、别的时长不放开

动效的时长我一律写死（0.9s、1.6s、3s、4.8s、8s、60s），幅度却改成了设置项，
区别不在「哪个更好改」，而在用户有没有判断依据：

- 时长是导演的节奏。用户觉得 3 秒长还是短，没有参照也没法比较，
  改两次之后放弃的概率比满意高；
- 幅度可比较（缩到 80% 就是 80%）、有边界（缩到 0 界面就没了）、
  一眼能验（保存后点一次方块就看见）。**它是这套动效里唯一一个
  用户能直接说出口、也能自己验证的参数**，所以它值得一个输入框。

默认值同时从 15 提到 20 —— 用户说小，那就是小，不需要再论证。

### 25.3 为什么是**两个**数字，不是一个「幅度」

缩水和放大不对称。缩 40% 只是「小了一号」；放 40% 会把标题栏挤出屏幕、
逼出横向滚动条、把代码块的字挤到换行。一个共享的幅度会强迫用户
在「缩水想调猛」和「放大想保守」之间二选一 —— 而这两种偏好同时存在
才是常态。字段因此是 `zoom.shrinkPercent` / `zoom.growPercent`，
区间都是 5~40，互不影响（`zoom-check` 专门测了「只给一个，另一个保持默认」）。

上限 40 不是保守：`runZoom` 里的兜底夹子就是 `0.6~1.6`，40 正好够到边界；
再放开，界面就从「方块搞了个恶作剧」变成「这个应用坏了」。

### 25.4 与事件覆盖层的三点不同

1. **不是 per-event 的**。缩水和变大共用 `kind: 'zoom'`，幅度是一条共享的
   审美参数；做成每事件一份，用户很容易给两条写出互相矛盾的数字。
2. **读取即修正，不拒绝**。`clampZoomPercent` 把 `0`→5、`999`→40、
   `"abc"`/`null`→默认，和 `clampWeight` 同一套写法。它防的不是手滑，
   是一份手改坏的 `config.json` 让整页缩到看不见。空串单独处理：
   `Number('') === 0` 会把「清空输入框」读成「缩 5%」，那是错的，应当回落。
3. **spec 是建表时烘进去的**。客户端只认 `factor` 这个数字，所以保存幅度
   必须重建事件池 —— 重建条件是 `eventsTouched || zoomChanged`，
   少了后半句就是「保存了、面板也变了、这次抽到的还是老幅度」。

### 25.5 面板：保存按钮，而不是即时保存

数字输入框每敲一个键都会 `onChange`，边打字边落盘等于把 `1`、`10`、`100`
都写进 `config.json`。所以它和事件权重一样要点「保存缩放幅度」。
但保存后**立刻拿宿主的回读值刷新面板**：用户把 999 写进去，面板当场跳回 40，
旁边那行「整页缩到 80%」也跟着变 —— 比「保存了但没变化」诚实。
面板上直接写效果（「整页缩到 80%」），不让用户自己做减法。

### 25.6 `tools/zoom-check.mjs`（35 条）

从 `lib/index.js` 抽真源码跑 `clampZoomPercent` 与 `zoomPercentConfig`，覆盖：
区间常量本身（默认 20 落在 5~40 内）、`0`/负数/`3`/`41`/`999`/小数/字符串数字/
空串/`null`/`undefined`/`NaN`/`"abc"` 逐项、`zoom` 不是对象或数组、
多出来的字段被忽略、两个方向互不影响；再加接线断言：两条事件的
`factor` 确实由百分比算出、`buildEvents` 真的读了 config、
`settings` 交出生效值、落盘前夹一遍、`eventsTouched || zoomChanged` 会重建，
以及面板侧的 `save-settings { zoom }` 与「只影响两条事件」的文案。

敏感度：把 shrink 的 `1 - zoomPercent.shrinkPercent / 100` 改成 `1 + …`，
`zoom-check` 红一条（接线断言），`host-smoke` 同时红
`FAIL shrink 的 factor=1.2 不是缩小` —— 两条独立的路都指向同一个错。
已还原。

## 26. 右键方块收起设置面板（m01549）

### 26.1 用户的原话

> 添加一个功能，保存更改后，右键方块，可以直接关闭设置界面

要求的是「改完之后有个顺手的出口」。原来的出口只有面板右上角那个 `✕`，
而面板贴在方块正下方、高度 `70vh` —— 用户改完最后一行时，鼠标就在方块附近，
要收起来却得横移到面板顶端去找一个 8 像素的字。这个距离就是全部问题。

### 26.2 做法：右键的含义**看面板开没开**

```
onContextMenu:
  preventDefault()
  if (settingsOpen) { setSettingsOpen(null); setMenuOpen(false); return }
  setMenuOpen(prev => !prev)
```

- 面板开着 → 右键 = 收面板。面板没开 → 右键 = 开关菜单（原行为）。
- 收面板时**顺手把菜单关掉**：否则 `menuOpen` 可能还留着 `true`，
  下次右键会先「收菜单」看起来像没反应。
- 分支里 `return`，不继续往下翻菜单 —— 两件事在同一个判断里互斥，
  不是「两个都执行」。
- 收面板**不看** `settingsBusy`：保存是后台请求，关面板不会取消它，
  失败也会走 `setError` 在方块上方冒出来。为了一个 200ms 的请求
  让右键失灵，只会让用户以为坏了。

### 26.3 顺手删掉的一句假话

面板容器上的注释原先写着「点空白处关闭」，但那个功能从来没实现过
（全文件没有对应的 `pointerdown` 监听）。留着它比没有更糟：下一个读代码的人
会以为外面那圈点击是安全的，然后照着这个假设去写新东西。现在注释写的是
真实的三个事实：✕、再右键一次方块、保存不自动收。

### 26.4 `show-check` 的第 11 节（146 条）

`onContextMenu` 的函数体被整段抽出来单独断言，不看「文件里出现过某句话」：
`preventDefault` 还在、`if (settingsOpen)` 分支里 `setSettingsOpen(null)`、
紧跟 `setMenuOpen(false)`、分支以 `return` 结束、没开面板时仍然翻转菜单、
判据是 `settingsOpen` 本身而不是 `settingsBusy` 之类的替身。

敏感度：把 `if (settingsOpen)` 改成 `if (false)` → 红两条
（`面板开着时收起面板`、`判定用的是 settingsOpen 本身…`）。已还原。

## 27. 保存按钮的回执（m01627）

### 27.1 用户的原话

> 保存键要做点反馈，不然用户无法得知是否按下

问题不在渲染，在**时间**：从点下去到宿主回包有几十毫秒，旧版按钮在这段里
一个字都不变。用户唯一的判断依据是手指下面那行字有没有动静；
没有动静，就只有一个解释 —— 没按上。于是再点一次，再点一次。

还有第二个洞：**成功之后按钮也不变**。落盘成功和「压根没按」长得一模一样，
这比按下没反应更糟 —— 用户已经开始怀疑自己了。

### 27.2 四态而不是三态

`panelSaveButton(kind, idleLabel, flash, onClick)`：

| 状态 | 文案 | 颜色 | 可点 |
| --- | --- | --- | --- |
| 待命 | 原标签 | 链接蓝 `#8fb0d0` | ✓ |
| 保存中 | 保存中… | 灰 `#8a8a99`、`opacity .6` | ✗（`disabled`） |
| 已保存 | 已保存 ✓ | 绿 `#8fd08f` | ✓ |
| 保存失败 | 保存失败 | 红 `#e08a8a` | ✓（好重试） |

- **`saving` 必须 `disabled`**：连点两次没有意义，第二次只会写出同一份草稿；
  而且第二个请求回来会把第一个的回执覆盖掉，看起来像闪了一下。
- **`saving` 的 `cursor` 必须跟着变 `default`**：留着 `pointer` 是种谎话，
  用户会以为还能点。
- **`ok` / `fail` 不是常驻状态**，只闪 1.8 秒。回执回答的是「刚刚那一下成了」，
  不是「现在处于已保存状态」；常驻会让「已保存」变成一句谁也不再看的背景文字。

### 27.3 回执放在哪里：`settingsOpen.saveFlash`

`{ key: 'events' | 'zoom', status: 'saving' | 'ok' | 'fail' }`，存在面板状态里，
不开新的 `useState`：

- 面板一关就该跟着消失。`setSettingsOpen(null)` 之后 timer 里那句
  `prev ? … : prev` 什么都不做，天然收场；
- `key` 让**两个按钮互不串台** —— 保存缩放的绿勾不会跑到事件按钮上。

### 27.4 两个必须用函数式更新的地方

1. 保存成功后刷新面板（`eventOverrides` / `zoom`）**不能**用闭包里的
   `settingsOpen`：那是点击那一刻的快照，整体替换会把刚点亮的 `saveFlash`
   一起冲掉 —— 回执闪一下就没。改用 `setSettingsOpen(prev => …)`。
2. `flashSave` 自己也是 `prev => …`，这样「saving → ok」不会互相覆盖。

另外两个 timer 细节：新回执要 `clearTimeout` 掉上一个（否则旧 timer 会在
1.8 秒后「隔空熄灯」），重开面板时也要撤掉遗留的 timer。

### 27.5 为什么错误详情不放进按钮

按钮只回答「这一下有没有成」；`保存失败` 后面不跟原因。原因（宿主原文、
哪个事件）继续走方块上方的错误气泡 —— 那是它该在的地方，而且可以点掉。
把长错误塞进一个 11px 的行内文字里，等于把两个问题混成一个。

### 27.6 `tools/save-feedback-check.mjs`（35 条）

抽 `panelSaveButton` 的真源码，用假 `h()`（只记 tag/props/children）与假 `t()`
（直接回中文）跑四个状态，断言每个状态的文案 / 颜色 / `disabled` / `cursor` /
`opacity`；再验两个按钮的 `key` 互不串台、`onClick` 原样透传；最后是接线断言：
`saving` 在 `callHost` **之前**点亮、`ok`/`fail` 各就各位、两处刷新面板都是
函数式更新、回执带 `key`、1.8 秒的 timer 存在且会被新回执撤掉、重开面板撤
遗留 timer、两个按钮都真的走 `panelSaveButton` 并接上 `saveFlash`。

敏感度：把 `disabled: status === 'saving'` 改成 `disabled: false` →
`FAIL 保存中禁用（连点两次没有意义）`。已还原。

## 28. 外观三件事：小字、材质与材质音效、万圣节（m01706）

### 28.1 用户的原话

> 方块种类多加点，比如圆石，原木，铁块，对应的音频也对应一下

（同一条答复里还选了「splash 一句」+「节日彩蛋」。）

三件事的共同点：**没有一件是「新事件」**。它们都不进事件池、不占权重、
不花 token，只改变「你已经抽到的那一下」长什么样、听起来是什么。所以这一节
记的不是事件设计，而是**外观这一层的边界**。

### 28.2 splash：为什么不能「渲染时随机」

小字挂在方块容器里、`bottom:100%` 贴左上，斜 6°、900ms 脉动一次
（原版实测每秒两次；这里放慢到 0.9s 一次来回，幅度只有 9%，再快就抢注意力了）。

关键的一条：**抽句子的时机是「每次抽完事件」，不是「每次渲染」**。
React 组件在拖动、窗口尺寸变化、`chargeLevel` 每次 40ms 跳动时都会重渲染；
把随机放进渲染里，小字会随手指拖动疯狂换句，看起来像故障。
所以有 `splashRef` 存上一句、`rollSplash()` 只在 `onRoll` 里被调一次，
并且 `rollSplash` 进了 `onRoll` 的依赖数组。

不重样靠 `nextSplash(avoid, rand, pool)`：最多重试 8 次，仍撞上就**顺延一格**。
顺延这一手很重要 —— 池子只有一句（或 `rand` 死锁）时，重试永远拿同一个结果，
没有顺延就会写出一个死循环，或者干脆返回重复值。

空池的语义也踩过一次：`pool && pool.length ? pool : SPLASH_LINES` 会让
「传一个空数组」悄悄退回默认池。改成 `Array.isArray(pool) ? pool : SPLASH_LINES`
之后，空数组 = 空串（调用方要能表达「今天没有小字」）。

文案 28 句，全部是**关于这个插件自己的真话**（「拈来主义」「零 token！」
「灵感来自某个 mod」）。上限 14 字：方块宽 56px，再长会横穿屏幕。

### 28.3 三种新材质：四张表必须对得上

加一个 face 要同时改四处，缺一处就是「选了圆石却是默认贴图」或「挖掘声还是石头声」：

| 表 | 作用 | 漏改的症状 |
| --- | --- | --- |
| `LOOK_LIMITS.faces` | 落盘白名单 | 选完刷新回到幸运方块 |
| `FACE_PATTERNS` | CSS 现画的图案 | 选了没反应（退回内联贴图） |
| `FACE_OPTIONS` | 设置面板下拉框 | 面板里根本没有这一项 |
| `MATERIAL_SOUNDS` | 材质 → 声音组 | 外观是铁块，敲起来是石头 |

`tools/look-check.mjs` 就是钉这四张表的：`FACE_OPTIONS` 的 id 序列必须与
`LOOK_LIMITS.faces` **逐项相等**（顺序也相等，否则下拉框顺序和白名单悄悄错开），
`FACE_PATTERNS` 不许有白名单外的孤儿，`MATERIAL_SOUNDS` 的键必须都在白名单里。

图案本身全部是 CSS（没有新素材）：
- 圆石：`#7a7a7a` 底 + 四个 `radial-gradient` 斑点，`backgroundSize: 28px 28px`
  平铺。用 px 不用 % —— 百分比在 24px 的小方块上会糊成一团。
- 原木：`#8a6335` 底 + 两道 `repeating-linear-gradient(90deg …)` 竖纹 +
  左右两侧压暗（原版原木侧面就是中间亮、两侧收暗）。
- 铁块：`#c9cbd1` 底 + 一道 160° 高光 + 四角四颗铆钉（铆钉半径用 **%**，
  要跟着方块尺寸一起缩放）。

面板里这三种排在「幸运方块」之后、「命令方块」之前：它们是**换皮**，
不是换个性。

### 28.4 声音：为什么按材质分了组，又为什么收尾只分两种

原版每种方块都有自己的 `block.<材质>.hit` 一组音。我们素材只有 16 个文件，
所以按「敲上去的手感」分三组：

| 材质 | 循环 | 收尾 |
| --- | --- | --- |
| 圆石（及所有其余脸） | `dig1-4` 轮播 | `break.ogg` |
| 原木 | `wood_click` / `pop` 交替 | `break.ogg` |
| 铁块 | `anvil_land` | `anvil_land` |

两处刻意的取舍：

1. **石头和木头收尾共用 `break.ogg`**。它们的区别在 210ms 的循环里已经给足了，
   收尾再硬分两段就是「为了不同而不同」——而且手上没有第二个合适的碎裂声。
2. **金属收尾单独用 `anvil_land`**。铁块敲碎了如果播玻璃碎，那一下会直接毁掉
   「这是金属」的错觉，比循环音不匹配更刺耳。

`playBreak(face)` 保留「没有 face 就播 `block`（玻璃）组」的老分支：
科乐美秘技那声奖励叮走的就是它，那里根本没有材质可言。

### 28.5 万圣节：三条边界

来源是 Minecraft 的万圣节彩蛋（那天生成的僵尸 22.5% 戴雕刻南瓜、splash 变
"OOoooOOOoooo! Spooky!"）。核心不是「有南瓜贴图」（本来就有），
而是**用户什么都没做，它自己变了**。

1. 只在**本地日期** 10 月 31 日生效。用 `new Date()` 的 month/day，不是 UTC —
   用户在哪个时区，就该按哪个时区过节。
2. **只在用户没挑过外观时**生效：`face === 'lucky'` 才变南瓜。挑了原木/铁块的人
   是明确表达了「我要这个外观」，彩蛋不该顶掉它。这条也让「南瓜日」不会
   毁掉出口：想保住幸运方块，随便挑个材质就行。
3. 面板里有开关（`look.halloween`）。默认开 —— 它一年只生效一天。

日期全部注入（`isHalloween(date)` / `holidayFace(look, date)`），所以检查脚本
在 4 月也能跑；否则这个功能一年只有一天能验。

### 28.6 `tools/look-check.mjs`（88 条）与三次故意改坏

抽 15 段真源码（clamp / LOOK_DEFAULTS / LOOK_LIMITS / normalizeLook /
万圣节一段 / SOUND_FILES / MATERIAL_SOUNDS / materialSound / SPLASH_LINES /
HALLOWEEN_SPLASH / pickSplash / nextSplash / splashPool / FACE_PATTERNS /
FACE_OPTIONS），拼成 `new Function` 跑：

- 文案：≥20 句、非空、≤14 字、不重复、不含换行；注入 `rand` 抽首句/末句、
  `rand` 返回 1 时回落首句、空池返回空串、300 次 `nextSplash` 不重样、
  池只有一句时只能认重复、`rand` 死锁时顺延。
- 日期：10/31 是、10/30 不是、11/1 不是、`new Date(2026, 8, 31)` 进位成 10/1 不是、
  当天 00:00 与 23:59 都算、次日 00:00 立刻结束、12/31 不误判。
- 该显示哪张脸：默认+万圣节→南瓜、默认+平时→幸运、挑了 oak→oak（万圣节也不变）、
  custom→custom、开关关→不变、`null` 不炸、未知 face 原样返回。
- 四张表：白名单无重复、下拉框序列与白名单逐项相等、图案无孤儿、
  `lucky`/`custom` 不走图案、圆石平铺、原木竖纹且 r>g>b、铁块浅灰且四颗铆钉、
  三组声音互不相同、每组都有对应的 `Break` 组、每个 `.ogg` 真的在磁盘上。
- 清洗：老配置里没有新字段 → `splash`/`halloween` 默认 true、只有布尔 `false` 算关。
- 接线：`holidayFace` 真的被 `faceFace` 和 `digFace` 用到、`startDig(digFace)`、
  `playBreak(digFace)`、`materialSound(face)`、`'Break'` 拼接、小字绝对定位
  不吃点击、小字只在没有台词/报错时出现、两个开关都走 `applyLook`。

三次故意改坏（都已还原、都已复绿）：

| 改坏 | 结果 |
| --- | --- |
| `while (text === avoid …)` 改成 `while (false && …)` | 起初 **没红** —— 因为兜底的「顺延一格」把它盖住了。补了一条喂序列 `rand` 的断言（第一次抽中 avoid、第二次抽中别的，要求返回第二次那句）之后才红 |
| `getDate() === HALLOWEEN_DAY` 改成 `=== 30` | 9 条红（两池相加、10/31、10/30、当天 00:00/23:59、三条 holidayFace） |
| `oak: 'wood'` 改成 `oak: 'stone'` | 1 条红（原木用木头声） |

第一条是这一节最值钱的教训：**兜底会把 bug 藏起来**。测试要问的不是
「最终结果对不对」，而是「这条兜底有没有把主路径的坏掉掩盖过去」。

### 28.7 顺带被改旧的检查

`tools/pickaxe-check.mjs` 里三条断言因为 `playBreak` 有了 `face` 参数而失效
（它原来按 `playBreak: function () {` 抽函数体）。这不是放宽断言，是**接线本身变了**：
改成按 `playBreak(digFace)` 匹配守卫关系，并把「playBreak 函数体」那两条拆成
「没有材质时仍播 block 组」+「有材质时播 `<材质>Break` 组」—— 两条分支都是
必须存在的语义，少一条就意味着某类调用点一响就是错的声音（22 → 26 条）。

## 29. 面板底部的自述行：让「你看到的是哪一版」自己说话（m02066）

### 29.1 起因

用户报「设置里没有形状这个下拉框」。查过的事实：

- `C:\Users\lyh\.dsh\profiles\desktop\node_modules\dsh-lucky-block` 是 Junction，
  指向本仓库；`lib/client.js` 213083 字节、当天 11:13，`圆石` 在文件里；
- 宿主服务端路由需要鉴权（401），拿不到它实际吐出去的那份 bundle；
- 浏览器（Chromium）的 `Code Cache` 里能搜到 `FACE_OPTIONS`，但搜不到
  `MATERIAL_SOUNDS` / `dshLuckySplash` / `cobblestone` —— 说明**那份缓存是旧的**，
  但代码缓存会被内容哈希自动作废，它证明不了「现在加载的是哪一版」。

问题在于：这三条证据都只能证明「磁盘上是新的」，**证明不了「浏览器里跑的是新的」**。
而「加载了旧包」和「加载了新包但渲染坏了」在用户那头看起来一模一样。

### 29.2 做法：把「这份代码认识什么」印在面板上

面板底部加一行：

> 这一份客户端：形状 8 种，事件 22 单击 / 7 长按

三个数**全部由当前加载的代码自己算**：`FACE_OPTIONS.length`、
`settingsOpen.events` 按 `trigger` 现数。不写死任何版本号，也不读 package.json ——
版本号可以忘改，而「这份代码认识几个形状」是它自己知道的。

于是它变成一次自检：写 5 种 = 浏览器在跑旧包；写 8 种但下拉框里没有圆石 =
那才是渲染问题。**同样是「看不到」，两种病因分开报。**

### 29.3 为什么不用版本号

版本号要人维护。这个项目已经因为「提交信息、README、DESIGN 三处都要同步改」
吃过几次亏（§14.2 的权重账就是例子）。版本号还会回答错问题：
`0.2.0` 可能是同一个版本号下的第 12 次改动。**数量由代码自己数，是唯一不会过期的写法。**

### 29.4 检查

`tools/look-check.mjs` 加了第 9 节 5 条（88 → 93）：这行存在、形状数走
`FACE_OPTIONS.length`、两个计数都按 `trigger` 现算、不许出现硬编码的
「形状 8 种」。最后那条防的是「顺手把数字写死」，写死之后它就是一句装饰。

## 30. 分组的子行被静默吃掉：`panelGroup` 只收了一个参数（m02268）

### 30.1 自述行立了功，但也把方向指反了

§29 那行自述加上之后，用户回了一句关键的话：面板底部「形状」后面写的是 **8**。
于是「浏览器在跑旧包」这个假设当场被推翻 —— 同一份代码既算出 8 种形状，
又渲染不出形状下拉框。**自检行把病因从「加载」指向了「渲染」。**

### 30.2 真正的原因

```js
function panelGroup(title, children) {           // 只收第二个参数
  return h('div', {...}, h('div', {...}, title), children)
}
```

而「方块外观」那一组是这样调的：

```js
panelGroup(
  t('方块外观', 'Block appearance'),
  panelRow(t('大小', 'Size'), ...),      // ← 只有这一行进了 children
  panelRow(t('形状', 'Shape'), ...),     // ← 从第二个参数起，全部被忽略
  panelRow(t('圆角', 'Corner'), ...),
  ...
)
```

JS 不会为多余的实参报错，React 也不知道有行没被传进来。结果就是：
**外观组只剩「大小」一行，其余静默消失，控制台一声不响。**
用户从 10-18 起就看不到形状下拉框，报的「设置里没有形状」一直是对的。

另外三个分组（整页缩放幅度 / 随机事件 / 扩展接口）是**把子行装进一个数组**或
装进一个 IIFE 的返回值里传的，所以它们一直是好的 —— 坏的那一组恰好是
唯一按参数摊开写的一组。这种「同一个函数、两种调用风格、只有一种被支持」
的情况，静态检查（源码里每一行都在）完全看不出来。

### 30.3 改法：两种写法都收

```js
function panelGroup(title) {
  var rows = []
  for (var i = 1; i < arguments.length; i += 1) {
    var arg = arguments[i]
    if (Array.isArray(arg)) rows = rows.concat(arg)
    else if (arg !== null && arg !== undefined && arg !== false) rows.push(arg)
  }
  return h.apply(null, ['div', {...}, h('div', {...}, title)].concat(rows))
}
```

两个细节是刻意的：

- **用 `apply` 摊成多个孩子，而不是塞一个数组**。React 要求数组里的元素有 `key`，
  而这些行本来就不是列表（没有 key）。摊开写就绕开了这条要求。
- **`null` / `false` 直接跳过**。面板里有 `settingsOpen.zoom ? panelGroup(...) : null`
  这类条件组，宽松一点比让调用方逐个判断更不容易出错。

### 30.4 检查：真跑一遍、数孩子个数

`tools/panel-check.mjs` 加第 6 节（33 → 43 条）。抽 `panelGroup` 的真源码，
喂一个假 `h`（`{ tag, props, children }`），然后数孩子：

- 摊成参数：`panelGroup('T','a','b')` 必须有 3 个孩子（标题 + a + b）；
- 装进数组：`panelGroup('T',['a','b'])` 同样 3 个；
- 混写：`panelGroup('T','a',['b','c'])` → `a,b,c` 顺序不乱；
- 空位：`panelGroup('T',null,false,'x')` → 只剩 `x`；
- 静态兜底：定义里必须出现 `arguments.length`、「形状」行必须紧跟「大小」行、
  面板必须还是四个分组。

敏感度：把循环上限从 `arguments.length` 改成 `2`（精确复现旧 bug），
5 条断言变红（`摊成参数的子行全部渲染 —— 实际 2，期望 3` 等）；改回后 43 条全绿。

### 30.5 教训

「源码里明明有」不等于「界面上会有」。凡是**渲染路径上的收集逻辑**（分组、
列表、槽位），静态断言只能证明原料在场，必须真跑一遍数产出。
这也是本项目第二次栽在同一类坑上（第一次是 §24 的 `nodeRef`：测试替身替实现圆了谎）。




