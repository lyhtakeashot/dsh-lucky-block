// 用 GitHub git/trees API 在仓库里递归找匹配文件名的路径。
// 用法：node tools/gh-tree.mjs <repo> <branch> <path-prefix> <name-filter-regex>
import https from 'node:https'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    u.protocol = 'https:'
    const req = https.request(
      u,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`))
            return
          }
          resolve(JSON.parse(body.toString('utf8')))
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const [repo, branch, prefix, filter] = process.argv.slice(2)
const data = await getJson(
  `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
)
if (data.truncated) console.log('NOTE: tree truncated')
let n = 0
for (const item of data.tree || []) {
  if (item.type !== 'blob') continue
  if (!item.path.startsWith(prefix)) continue
  if (!new RegExp(filter, 'i').test(item.path)) continue
  console.log(`${item.size ?? '?'}\t${item.path}`)
  n += 1
}
console.log(`-- ${n} match(es)`)
