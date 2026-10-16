// 用 GitHub search/repositories API 找可能含原版方块 destroy_stage 贴图的仓库。
// 用法：node tools/gh-search-repo.mjs <query>
import https from 'node:https'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function get(url) {
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

const q = process.argv[2]
const data = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`)
for (const item of data.items || []) {
  console.log(`${item.full_name} ★${item.stargazers_count} ${item.default_branch} — ${item.description || ''}`)
}
