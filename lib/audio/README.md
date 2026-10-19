# 随机音频事件的曲库

往这个目录里放音频文件，然后在同级的 `lib/audio-tracks.json` 里登记。

## 怎么加一首

1. 把文件拷进本目录，文件名只用**字母、数字、下划线、横杠**，扩展名 `.ogg` 或 `.mp3`。
   （含空格、中文、括号的文件名会被静默忽略 —— 白名单与宿主 HTTP 路由是同一套规则。）
2. 在 `lib/audio-tracks.json` 里加一条：

```json
[
  { "file": "morning-loop.mp3", "title": "早八的电梯", "weight": 2 }
]
```

`title` 只用来在设置面板和日志里说明播了什么，可以不写（不写就用文件名）。
`weight` 是可选的出现权重，不写就是 **1**；写 2 就是「比别的歌常出现一倍」。

## 一首歌 = 一条事件

登记几条就有几条随机事件，id 由文件名派生：`morning-loop.mp3` → `audio-morning-loop`。
所以**每首歌能单独开关**（设置面板里取消勾选，或 `config.json` 的 `events` 里写
`"audio-morning-loop": { "enabled": false }`）。

## 包里现在是这五首

| 文件 | 时长 | 权重 | 处理 |
| --- | --- | --- | --- |
| `never-give-you-up.ogg` | 42 秒 | **2** | 只切副歌（用户明确要求的唯一一首） |
| `whos-ready-for-tomorrow.ogg` | 112 秒 | 1 | 完整版，去掉结尾 4 秒静音 |
| `stay-at-your-house.ogg` | 241 秒 | 1 | 完整版，去掉结尾 6 秒静音 |
| `my-shot.ogg` | 328 秒 | 1 | 完整版，首尾都是正常声音，不切 |
| `satisfied.ogg` | 330 秒 | 1 | 完整版，去掉开头 26 秒黑胶底噪 |

**除第一首外都是完整版** —— 用户 m15360 第 8 条的原话是
「除了 never gonna give you up 其他音乐都要完整版」。

完整版之所以不难受，是因为单击池的十种表演**全都能按 ESC 立刻停**（见 README 的
「全部单击事件都能按 ESC 提前结束」）：想听完就听完，不想听按一下就没了。
时长不再是硬绑定，所以这里不再像早期那样「只放高潮」。

## 怎么切

```bash
# 去掉尾部静音（完整版，只想砍掉没声音的一段）
ffmpeg -i 原文件.m4a -to 112 -c:a libvorbis -q:a 2 -ac 2 -ar 44100 out.ogg

# 去掉开头静音（黑胶转录常见，前面几十秒只有底噪）
ffmpeg -i 原文件.m4a -ss 26 -c:a libvorbis -q:a 2 -ac 2 -ar 44100 out.ogg

# 只取高潮段（Never Gonna Give You Up 就是这么切的）
ffmpeg -i 原文件.m4a -ss 58 -to 95 -c:a libvorbis -q:a 4 -ac 2 -ar 44100 out.ogg
```

- `-ss` / `-to` 是秒，`-ss` 放在 `-i` 后面是**精确定位**（慢但准），
  放前面快但会落在最近的关键帧上。
- `-q:a` 是 Vorbis 质量档（0~10）。完整版用 **q2**（约 90 kbps）压包体积，
  短的高潮段可以用 q4。用户明确说过音质不重要。
- **先看响度曲线再定 `-ss`/`-to`，别凭记忆猜时间**。现成工具：`tools/.loudest.mjs`
  （解 PCM 自己按固定秒数分桶算 RMS）。隔壁 `tools/.fetch-bv.mjs` 负责从 B 站
  抓音频流（见其文件头注释）。

## 空清单会发生什么

`audio-tracks.json` 是 `[]` 时，**这一类随机事件整个不存在**：`audioEvents()`
返回空数组，没有任何 `audio-*` 条目参与抽取，也不占命中率。
所以清单可以一直空着，不影响其他事件。

## 音频放完/想提前掐掉

`createSoundEngine()` 只保留一个 `currentTrack`，`playTrack()` 会先把上一首停掉
（连点两下不该叠着响）。ESC 由 `registerEscape` 统一收口，
客户端会在 `hasTrack()` 为真时登记一个 `stopTrack` 回调。

## 为什么不放在 sounds/

`lib/sounds/` 是随包发布的挖掘音效，文件名写死在 `lib/client.js` 的 `SOUND_FILES` 里，
由 `/dsh-lucky-block/sound` 路由用「只认 `.ogg`」的白名单发出。
本目录走的是另一条路由 `/dsh-lucky-block/audio`，允许 `.mp3`，
两者互不影响 —— 改这边的白名单不会放松挖掘音效那边。
