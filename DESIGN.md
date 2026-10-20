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
> 现在是 **13 个事件、分两个池**（单击零成本 / 长按才花钱），见 §14。

原始提案：

| id | 类型 | 实现位置 | 要点 |
|---|---|---|---|
| `paper` | AI 任务 | 宿主 | 随机词条库（学科×方法×对象）+ remote.session.create/prompt；全自动 approval |
| `windows` | UI | 客户端 | 8-15 个无意义小窗，打字机出现，反序关闭；纯 DOM |
| `bsod` | UI | 客户端 | 全屏 Win11 蓝屏样式（纯 CSS+DOM），三张脸随机一张，60s 自动结束，ESC 提前结束，z-index 高于一切但不覆盖已有 UI（独立 overlay 层） |
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

停止顺序：挖穿时**先 `stopMining()` 再 `playBreak()`**。反过来这声碎裂会跟循环的
最后一声叠在一起，听感是「咚咔」粘连。

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

五条「凶」都遵循这个口吻，但**不是同一个句式的五份复制**，分三种「转身」方向：

| 转身方式 | 例子 |
| --- | --- |
| 把不顺重新框成省事 | 「该踩的坑都提前踩完了，剩下的路反倒好走」 |
| 指出它只来一次 | 「好消息是它只来一次，而且来得很早」 |
| 指出绕路 / 重做的代价本身就小 | 「绕路不收费，代价只是时间」「坑你已经知道了」 |
| 把「不做」说成一种运气 | 「什么都不做就不会做错，这本身是一种相当高级的运气」 |

早期版本还有三条被换掉，原因都是**语气跑偏**而不是意思不对：

| 被换掉的写法 | 为什么不行 |
| --- | --- |
| 「运气差到这个程度，接下来只会往上走」 | 其实是劝人振作，是在给用户打气 |
| 「该躲的躲不掉，所以别躲了」 | 「别躲了」是命令句，长辈口吻 |
| 「往好处想，第二遍通常比第一遍快」 | 「往好处想」同样是在劝人 |

这三条的共同点是**在对用户提要求或给建议**，而这个插件的说话人是一个碎嘴的系统程序
—— 它只报事实、解释代价，不安慰、不劝告。一条劝告就足以把人设打散，
让人从「系统在播报」变成「有个东西在哄我」。
替换后的两条（「绕路不收费，代价只是时间」「坑你已经知道了」）都是把代价解释掉，
不对用户的行为提出任何期待。

所以 `probe-fortune.mjs` 对「凶」的断言是**正则匹配口吻**而不是钉死某一句话：
上一版写的是 `t.includes('你运气还挺好')`，五条文案一上就必然假失败。
判据改成「必须命中 `BAD_TONE_RE`（运气 / 不会做错 / 好消息 / 只来一次 /
剩下的时间 / 第二遍 / 绕路不收费 / 代价只是 / 坑你已经知道）里的一个」，
再用 `/倒霉|厄运|不祥|灾/` 反向确认没真的诅咒用户 —— 前者守「要转个身」，
后者守「别把负面词写进去」，两条都比钉一句话更经得起改文案。

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
现在单击池权重 20（含五首歌，NGGYU 是 2，其余各 1）、长按池权重 8，互不干扰。

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

### 14.4 客户端怎么区分两个动作

`pointerdown` 记起点与时间，原有挖掘逻辑照跑；
`pointerup` 时若**没挖满**（`p < 1`）且没移动，才算单击 —— 走 `roll('click')`。
挖满照旧走 `roll('hold')`。

键盘 Enter/Space 从「直接触发长按」改成「走单击」——
键盘没有「按住 1.4 秒」这个自然动作，而单击是零成本的，猜错的代价最小。

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

### 14.7 演出素材为什么变多样了（蓝屏三张脸、弹窗三种皮）

用户 m15360 第 5 条：「蓝屏屏保和弹窗表演都需要加点内容，
比如说蓝屏再加几张，弹窗表演也可以添加一点老式电脑的弹窗故障和 win11 的弹窗形式」。

**蓝屏**：`BLUESCREEN_VARIANTS` 三张脸（背景色 / 那个表情 / STOP 码都不同），
`prepare(rand)` 抽一张。三张的 STOP 码是有意思的：`0x0000LUCKY`（原有）、
`0x00C0FFEE (COFFEE_NOT_ENOUGH_TO_CONTINUE)`、`0x0BADF00D (BAD_FOOD_IN_CACHE)`。

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

### 15.8 权重上限 25 与「0 = 关掉」

`clampWeight()` 夹到 `[0, 25]`。25 是这个插件里「一条事件最多占四分之一」的量级
（总权重 25），再大就没有意义。

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



