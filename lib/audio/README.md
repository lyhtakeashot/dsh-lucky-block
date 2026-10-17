# 随机音频事件的曲库

往这个目录里放音频文件，然后在同级的 `lib/audio-tracks.json` 里登记。

## 怎么加一首

1. 把文件拷进本目录，文件名只用**字母、数字、下划线、横杠**，扩展名 `.ogg` 或 `.mp3`。
   （含空格、中文、括号的文件名会被静默忽略 —— 白名单与宿主 HTTP 路由是同一套规则。）
2. 在 `lib/audio-tracks.json` 里加一条：

```json
[
  { "file": "morning-loop.mp3", "title": "早八的电梯" }
]
```

`title` 只用来在日志里说明播了什么，可以不写（不写就用文件名）。

## 空清单会发生什么

`audio-tracks.json` 是 `[]` 时，**这条随机事件整个不存在**：它不会参与抽取，
也不会占掉一份命中率（详见 `lib/index.js` 里 `buildEvents()` 末尾的注释）。
所以清单可以一直空着，不影响其他事件。

## 为什么不放在 sounds/

`lib/sounds/` 是随包发布的挖掘音效，文件名写死在 `lib/client.js` 的 `SOUND_FILES` 里，
由 `/dsh-lucky-block/sound` 路由用「只认 `.ogg`」的白名单发出。
本目录走的是另一条路由 `/dsh-lucky-block/audio`，允许 `.mp3`，
两者互不影响 —— 改这边的白名单不会放松挖掘音效那边。
