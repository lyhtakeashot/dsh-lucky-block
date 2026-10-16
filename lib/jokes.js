/**
 * 本地冷笑话语料库（零 token）。
 *
 * 语料本体在 `jokes-data.json`（笑话 + 点评两池），由
 * `tools/extract-jokes.mjs` 从 `research/joke-library.md` 抽取而来。
 *
 * **为什么数据在 JSON 而不是本文件里**：正文含逗号、引号、书名号等大量标点，
 * 手抄进 .js 字符串字面量极易在转义上出错（子代理也专门提醒过）。JSON 文件
 * 是唯一的真相来源，代码只负责读取 —— 没有二次转写的余地。
 *
 * 语料的设计约束（来自 `research/joke-library.md` 的实测分析）：
 *
 * 1. **笑话与点评独立随机**，不做「按结构匹配点评」的映射 —— 映射会让点评
 *    变成结构说明，反而不好笑。
 * 2. `form` 只用于统计与调参，**永远不要暴露给用户** —— 用户看到「本条属于
 *    谐音梗」就完全笑不出来了。
 * 3. 全部为自撰或公共领域通用文字游戏，未复制任何脱口秀段子、笑话书或
 *    特定作者作品。
 *
 * 与「AI 生成笑话」的关系：`joke` 事件默认走 AI（用 JOKE_FORMS 出题）；
 * 用户在设置里把它勾成「不调用 AI」后才走这里的本地库。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jokes-data.json')

/** 读一次就够：这是随包发布的静态文件，用户不会改（与 config.json 不同）。 */
let cache = null

/**
 * 读本地笑话库。
 *
 * 读不到时返回空库而不是抛错：语料缺失只应让那一条事件退回 AI 路径，
 * 不该让整个掷骰子失败。
 *
 * @returns {Promise<{jokes: Array<{text: string, form: string}>, quips: string[]}>}
 */
export async function loadJokeLibrary() {
  if (cache) return cache
  try {
    const raw = await readFile(DATA_FILE, 'utf8')
    // 与 config.json 同理：Windows 记事本/PowerShell 可能在开头写 BOM。
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    const jokes = Array.isArray(parsed?.jokes)
      ? parsed.jokes
          .filter((j) => j && typeof j.text === 'string' && j.text.trim().length > 0)
          .map((j) => ({ text: j.text.trim(), form: typeof j.form === 'string' ? j.form : '未分类' }))
      : []
    const quips = Array.isArray(parsed?.quips)
      ? parsed.quips.filter((q) => typeof q === 'string' && q.trim().length > 0).map((q) => q.trim())
      : []
    cache = { jokes, quips }
  } catch {
    cache = { jokes: [], quips: [] }
  }
  return cache
}
