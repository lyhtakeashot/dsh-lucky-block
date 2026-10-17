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
> 实际是 9 个事件，见 README 的概率表。

原始提案：

| id | 类型 | 实现位置 | 要点 |
|---|---|---|---|
| `paper` | AI 任务 | 宿主 | 随机词条库（学科×方法×对象）+ remote.session.create/prompt；全自动 approval |
| `windows` | UI | 客户端 | 8-15 个无意义小窗，打字机出现，反序关闭；纯 DOM |
| `bsod` | UI | 客户端 | 全屏 Win11 蓝屏样式（纯 CSS+DOM），60s 自动结束，ESC 提前结束，z-index 高于一切但不覆盖已有 UI（独立 overlay 层） |
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
（去掉「智能枪/干掉目标/毫无道德负担」那条与哼歌那条），翻转态的「爱狗人士」改成中性的
「礼貌模式」。理由：这套人格的价值全在**说话方式**上（工单口吻、系统话术、冷知识、话短），
不在「它是什么东西」上；挂一个具体载体会让模型时不时冒出「我这把枪……」这种自述，
而用户要的只是那个语气。

### 9.1 为什么单独一个 `lib/persona.js`

人格层是**纯函数**（进什么出什么，不碰 fs、不碰 ctx），所以能真 import 进单元测试。
`tools/persona-check.mjs` 有 62 条断言，测默认人格形状、覆盖语义、垃圾输入、
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

### 9.3 状态机与单向翻转

`$DSH_HOME/plugins/dsh-lucky-block/persona-state.json` 存 `{diceCount, flipped, mood}`。
掷满 `flipAfter`（默认 **50**，致敬游戏里「击杀 50 人」）次后 `flipped` 置真，
人格段换成 `flippedTraits`（礼貌版）。**翻转单向不可逆** —— 游戏里玩家也拦不住。

`normalizePersona()` 是公开入口的兜底：`mergePersona` 有防御，但 `buildPersonaBlock`
早期没有，调用方直接传 config.json 原始值时会抛 `TypeError: traits is not iterable`。
异常发生在**会话创建之后**，症状是「骰子转了但什么都没发生」，极难排查。

`flippedTraits` 缺失时退回 **`p.traits`** 而不是内置礼貌版：用户自定义了 traits 却没写
`flippedTraits`，意思是「我没准备第二人格」，这时该继续说他自己写的性格，而不是
突然给他装上别人的第二人格 —— 而且完全没有提示。

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

`loadJokeLibrary()` 读失败时返回空库而**不抛错** —— 语料缺失只应让那一条事件退回 AI，
不该让整个掷骰子失败。

### 10.2 分流点在宿主，客户端只展示

`rollDice()` 现在有三条路径，顺序要紧：

1. **视觉**（`event.kind === 'visual'`）→ 返回 `visual` spec，不建会话、不调模型；
2. **本地**（`localOnly.has(event.id)` 且 `localPayload()` 拿到了内容）→ 返回
   `localText`，同样零 token；
3. **AI** → 建会话、发人格化 prompt。

本地分支拿不到内容时 `logger.warn` 并**落回 AI 路径**，而不是返回空内容。
设置面板可以勾的事件只有 `localizable`（= 自带本地库的），且 `saveSettings()`
写盘前会用这个集合再过滤一次 —— 面板不会给出无效勾选框，手改配置也一样被拦住。

### 10.3 settings 走读-改-写

`config.json` 是**手写与界面共用**的同一个文件（里面还有用户手写的 `model` / `persona`），
所以 `saveSettings()` 必须读-改-写，整份覆盖会抹掉手写字段。

客户端侧两个坑：`openSettings()` 必须**立刻用占位对象开面板**（等宿主往返那几十毫秒里
点「设置…」毫无反应，用户会以为按钮坏了）；`toggleLocalOnly` / `toggleSound` 乐观更新，
**落盘失败要回滚 UI**，否则用户以为已经保存成功了。

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

现在是合计 1000：鸿运齐天 50 / 大吉 260 / 中吉 330 / 小吉 260 / 平 99 / 凶 1。
即 **吉类 90%、平 9.9%、凶 0.1%**。

两点实现细节：

- **总量取 1000 而不是 100**，是为了能用整数 `1` 表达 0.1%。抽签用的是累减法
  （`ticket -= weight`），拿 `0.1` 这种值参与浮点累减，在边界上可能差一个 ulp；
  全整数则不会。
- 权重表一旦改动，`probe-fortune.mjs` 里那几条分布断言必须跟着改 ——
  它们现在是「吉类 ≥ 85%」「凶 < 0.3%」「平 < 15%」「鸿运齐天 5%±1.5」，
  用的是区间而不是精确值，这样微调权重不用每次都改测试，但真的写错（比如凶又变回 5%）
  一定会红。

理由写在代码注释里了，这里再记一遍：**这个插件是用来打发时间的，不是用来给人添堵的。**
抽签这种东西的乐趣在于「有点准」，而不是「被诅咒」，所以分布必须明显偏吉。

### 13.3 「凶」是反着写的

下签的正文不是「你今天会倒霉」，而是：

> 从某种角度来说，你运气还挺好 —— 今天该踩的坑都提前踩完了，剩下的路反倒好走。

这不是文案上的小聪明，而是**唯一能让下签不被讨厌的写法**：它承认了「今天不太顺」
（所以签是真的），但把同一件事重新框成好处（所以人不会扫兴）。
直接写凶兆会让用户觉得被冒犯 —— 他点什么不好，非要点开一个说他今天倒霉的东西。

### 13.4 免责声明是硬要求

每条签文末尾固定追加 `（无科学依据，仅供参考。）`，写在**宿主拼文本那一步**，
而不是写进每一条 `FORTUNES` 的 `text` 里 —— 后者只要有人新增一档忘了抄就漏了。

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
把内存里的注入文本暴露出来，让 `probe-persona` / `probe-flip` / `probe-dice-prompt`
能直接断言注入内容。没命中时它还会返回 `known`（当前登记过的会话 id 列表），
用来区分「查错了会话」和「根本没登记」—— 这是两种完全不同的故障。


