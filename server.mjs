// ====================================================
// server.mjs — รันเวอร์ชัน production:  npm run build && npm start
// เสิร์ฟหน้าเว็บจาก dist/ + API เดียวกับตอน dev (server/api.mjs)
// ====================================================
import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from './server/api.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT) || 5300
const api = createApi({ root: ROOT })

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}

http.createServer((req, res) => {
  api(req, res, async () => {
    const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    let file = path.join(DIST, path.normalize(p).replace(/^([/\\])+/, ''))
    if (!file.startsWith(DIST)) { res.statusCode = 403; return res.end() }
    const st = await fs.stat(file).catch(() => null)
    if (!st || st.isDirectory()) file = path.join(DIST, 'index.html')
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    if (p.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    createReadStream(file).on('error', () => { res.statusCode = 404; res.end() }).pipe(res)
  })
}).listen(PORT, () => console.log(`✦ ANME Studio → http://localhost:${PORT}`))
