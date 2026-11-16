// ====================================================
// server/api.mjs — หลังบ้านของ ANME Studio
//
// ใช้ได้ทั้งตอน dev (เป็น middleware ของ Vite) และตอน production (server.mjs)
//
//   GET  /api/names                 รายชื่อเรนเจอร์ทุกตัว (ไทย/อังกฤษ) จาก lerico — แคช 24 ชม.
//   GET  /api/ranger/:id            รายการชุดไฟล์ (body / e-body / bul / bul2 / ...) ของเรนเจอร์
//   GET  /api/res/<dir>/<file>      proxy ไฟล์จาก rangers.lerico.net/res + แคชลงดิสก์ถาวร
//   GET  /api/gamedata/:id          จุดเงา/จุดหน้า/ชุดกระสุนของแต่ละท่า (จาก warmycat)
//   GET  /api/library               เรนเจอร์ที่เคยโหลดไว้แล้วในเครื่อง
//   POST /api/upload?name=<file>    อัปโหลดไฟล์ (ภาพ/วิดีโอ/gif/webp/sam/plist) → /files/uploads/...
//   GET  /api/uploads               ไฟล์ที่อัปโหลดไว้ทั้งหมด
//   GET  /api/projects              รายชื่อโปรเจคที่บันทึก
//   GET|POST|DELETE /api/projects/:name
//   GET  /files/uploads/<file>      เสิร์ฟไฟล์อัปโหลด (รองรับ Range → เลื่อนวิดีโอได้)
//
// ทำไมต้องมี proxy: rangers.lerico.net ไม่ส่ง Access-Control-Allow-Origin → เบราว์เซอร์ยิงตรงไม่ได้
// ทำไมต้องแคชลงดิสก์: ไฟล์ไม่เปลี่ยน โหลดครั้งเดียวจบ ครั้งต่อไปเร็วและใช้ได้แม้ออฟไลน์
// ====================================================

import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ORIGIN = 'https://rangers.lerico.net'
const UA = { 'User-Agent': 'Mozilla/5.0 (ANME Studio)' }
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i
const SEG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/
const PROJECT_RE = /^[\p{L}\p{N}_\- ]{1,60}$/u
const NAMES_TTL = 24 * 3600 * 1000

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.apng': 'image/apng', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.json': 'application/json', '.plist': 'application/xml', '.sam': 'application/octet-stream',
}
const mimeOf = f => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream'

export function createApi({ root }) {
  const STORAGE = path.join(root, 'storage')
  const CACHE = path.join(STORAGE, 'cache')
  const RES_CACHE = path.join(CACHE, 'res')
  const UPLOADS = path.join(STORAGE, 'uploads')
  const PROJECTS = path.join(STORAGE, 'projects')
  const GAMEDATA_FILE = path.join(root, 'data', 'gamedata-index.json')

  /** โหลดพร้อมกันหลายคนขอไฟล์เดียวกัน → ยิงต้นทางครั้งเดียว */
  const inflight = new Map()
  let gamedata = null
  let namesMem = null

  const send = (res, code, data) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(data))
  }
  const readBody = async req => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return Buffer.concat(chunks)
  }
  const exists = p => fs.stat(p).then(() => true, () => false)

  /** ดึงไฟล์จาก lerico (แคชลงดิสก์) → คืน path ในเครื่อง */
  async function cachedRes(segs) {
    const local = path.join(RES_CACHE, ...segs)
    if (await exists(local)) return local
    const key = segs.join('/')
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const r = await fetch(`${ORIGIN}/res/${key}`, { headers: UA })
        if (!r.ok) throw Object.assign(new Error(`lerico ${r.status}: ${key}`), { status: r.status === 404 ? 404 : 502 })
        const buf = Buffer.from(await r.arrayBuffer())
        await fs.mkdir(path.dirname(local), { recursive: true })
        const tmp = local + '.' + process.pid + '.tmp'
        await fs.writeFile(tmp, buf)
        await fs.rename(tmp, local).catch(async () => { await fs.rm(tmp, { force: true }) })
        return local
      })().finally(() => inflight.delete(key)))
    }
    return inflight.get(key)
  }

  /** รายการไฟล์ในโฟลเดอร์ของ lerico (แคช) */
  async function listDir(dir) {
    const idx = path.join(RES_CACHE, dir, '__index.json')
    try { return JSON.parse(await fs.readFile(idx, 'utf8')) } catch { /* ยังไม่มี */ }
    const r = await fetch(`${ORIGIN}/res/${dir}/`, { headers: { ...UA, Accept: 'text/html' } })
    if (!r.ok) throw Object.assign(new Error(`ไม่พบ "${dir}" บน lerico (${r.status})`), { status: 404 })
    const html = await r.text()
    const files = [...html.matchAll(/href="([^"]+)"/gi)].map(m => decodeURIComponent(m[1]))
      .filter(h => !h.startsWith('.') && !h.startsWith('/') && !h.endsWith('/'))
    await fs.mkdir(path.dirname(idx), { recursive: true })
    await fs.writeFile(idx, JSON.stringify(files))
    return files
  }

  /** จัดกลุ่มไฟล์ของเรนเจอร์เป็น "ชุด" (.sam + .plist + .png ชื่อเดียวกัน) */
  function rangerSets(id, files) {
    const sets = {}
    const thumbs = {}
    const set = new Set(files)
    for (const f of files) {
      if (!f.startsWith(id + '-')) continue
      const part = f.slice(id.length + 1)
      const m = part.match(/^(.+)\.sam$/)
      if (m && set.has(`${id}-${m[1]}.plist`) && set.has(`${id}-${m[1]}.png`)) {
        sets[m[1]] = { sam: `${id}-${m[1]}.sam`, plist: `${id}-${m[1]}.plist`, png: `${id}-${m[1]}.png` }
      }
      if (part === 'thum.png') thumbs.body = f
      if (part === 'e-thum.png') thumbs['e-body'] = f
    }
    return { sets, thumbs }
  }

  async function loadGamedata() {
    if (!gamedata) {
      gamedata = fs.readFile(GAMEDATA_FILE, 'utf8').then(JSON.parse).catch(() => ({}))
    }
    return gamedata
  }

  async function loadNames() {
    const file = path.join(CACHE, 'names.json')
    if (namesMem && Date.now() - namesMem.at < NAMES_TTL) return namesMem.list
    const disk = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)
    if (disk && Date.now() - disk.at < NAMES_TTL) { namesMem = disk; return disk.list }
    try {
      const [en, th] = await Promise.all(['en', 'th'].map(l =>
        fetch(`${ORIGIN}/api/v2/translate?keys=${l}:UNIT`, { headers: UA }).then(r => r.json()).then(d => d[`${l}:UNIT`] ?? {})))
      const ids = new Set()
      for (const k of [...Object.keys(en), ...Object.keys(th)]) {
        const m = k.match(/^(u[^_]+)_nm$/)
        if (m) ids.add(m[1])
      }
      const list = [...ids].sort().map(id => ({ id, en: en[`${id}_nm`] ?? null, th: th[`${id}_nm`] ?? null }))
      namesMem = { at: Date.now(), list }
      await fs.mkdir(CACHE, { recursive: true })
      await fs.writeFile(file, JSON.stringify(namesMem))
      return list
    } catch (e) {
      if (disk) return disk.list            // เน็ตล่ม → ใช้ของเก่าไปก่อน
      throw e
    }
  }

  /** เสิร์ฟไฟล์จากดิสก์ รองรับ Range (วิดีโอต้องใช้เพื่อเลื่อนเวลา) */
  async function serveFile(req, res, file, cache = 'public, max-age=31536000, immutable') {
    const st = await fs.stat(file).catch(() => null)
    if (!st || !st.isFile()) return send(res, 404, { error: 'not found' })
    res.setHeader('Content-Type', mimeOf(file))
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', cache)
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    if (range) {
      let start = range[1] ? parseInt(range[1], 10) : 0
      let end = range[2] ? parseInt(range[2], 10) : st.size - 1
      if (!range[1] && range[2]) { start = st.size - parseInt(range[2], 10); end = st.size - 1 }
      if (start >= st.size || end >= st.size || start > end) {
        res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); return res.end()
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
      res.setHeader('Content-Length', end - start + 1)
      return createReadStream(file, { start, end }).pipe(res)
    }
    res.statusCode = 200
    res.setHeader('Content-Length', st.size)
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  }

  async function listUploads() {
    await fs.mkdir(UPLOADS, { recursive: true })
    const files = await fs.readdir(UPLOADS)
    const out = []
    for (const f of files) {
      if (f.endsWith('.tmp')) continue
      const st = await fs.stat(path.join(UPLOADS, f)).catch(() => null)
      if (st?.isFile()) out.push({ file: f, name: f.replace(/^[0-9a-f]{8}-/, ''), url: `/files/uploads/${encodeURIComponent(f)}`, size: st.size, mime: mimeOf(f), at: st.mtimeMs })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  return async function api(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    if (!p.startsWith('/api/') && !p.startsWith('/files/')) return next?.()
    const seg = p.split('/').filter(Boolean).map(s => decodeURIComponent(s))

    try {
      // ── ไฟล์อัปโหลด ──
      if (seg[0] === 'files' && seg[1] === 'uploads' && seg[2] && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!SEG_RE.test(seg[2])) return send(res, 400, { error: 'bad name' })
        return serveFile(req, res, path.join(UPLOADS, seg[2]))
      }
      if (seg[0] !== 'api') return next?.()

      if (req.method === 'GET' && seg[1] === 'health') return send(res, 200, { ok: true })

      if (req.method === 'GET' && seg[1] === 'names') {
        return send(res, 200, { rangers: await loadNames() })
      }

      // GET /api/ranger/:id
      if (req.method === 'GET' && seg[1] === 'ranger' && seg[2]) {
        const id = seg[2].toLowerCase().trim()
        if (!ID_RE.test(id)) return send(res, 400, { error: 'รหัสเรนเจอร์ไม่ถูกต้อง' })
        const files = await listDir(id)
        const { sets, thumbs } = rangerSets(id, files)
        if (!Object.keys(sets).length) return send(res, 404, { error: `ไม่พบไฟล์อนิเมชั่นของ ${id}` })
        const gd = (await loadGamedata())[id] ?? null
        return send(res, 200, { id, sets, thumbs, gamedata: gd })
      }

      // GET /api/res/<dir>/<file>
      if ((req.method === 'GET' || req.method === 'HEAD') && seg[1] === 'res' && seg.length >= 4) {
        const parts = seg.slice(2)
        if (!parts.every(s => SEG_RE.test(s) && s !== '..')) return send(res, 400, { error: 'bad path' })
        const local = await cachedRes(parts)
        return serveFile(req, res, local)
      }

      // GET /api/list/<dir> → รายการไฟล์ในโฟลเดอร์ (เช่น ฉากด่าน battle01)
      if (req.method === 'GET' && seg[1] === 'list' && seg[2]) {
        if (!SEG_RE.test(seg[2])) return send(res, 400, { error: 'bad dir' })
        return send(res, 200, { files: await listDir(seg[2]) })
      }

      if (req.method === 'GET' && seg[1] === 'gamedata' && seg[2]) {
        return send(res, 200, { gamedata: (await loadGamedata())[seg[2].toLowerCase()] ?? null })
      }

      // GET /api/library → เรนเจอร์ที่แคชไว้แล้ว
      if (req.method === 'GET' && seg[1] === 'library') {
        await fs.mkdir(RES_CACHE, { recursive: true })
        // นับเฉพาะตัวที่เคยโหลดจริง (มีรายการไฟล์) — ไม่ใช่แค่เคยแสดงภาพย่อในผลค้นหา
        const dirs = []
        for (const d of await fs.readdir(RES_CACHE, { withFileTypes: true })) {
          if (d.isDirectory() && /^u\d/i.test(d.name) && await exists(path.join(RES_CACHE, d.name, '__index.json'))) dirs.push(d.name)
        }
        const names = namesMem?.list ?? (await fs.readFile(path.join(CACHE, 'names.json'), 'utf8').then(j => JSON.parse(j).list).catch(() => []))
        const byId = new Map(names.map(n => [n.id, n]))
        const items = []
        for (const id of dirs) {
          const st = await fs.stat(path.join(RES_CACHE, id)).catch(() => null)
          items.push({ id, en: byId.get(id)?.en ?? null, th: byId.get(id)?.th ?? null, at: st?.mtimeMs ?? 0 })
        }
        return send(res, 200, { rangers: items.sort((a, b) => b.at - a.at) })
      }

      // POST /api/upload?name=
      if (req.method === 'POST' && seg[1] === 'upload') {
        const raw = (url.searchParams.get('name') ?? 'file').normalize('NFC')
        const ext = path.extname(raw).toLowerCase().replace(/[^.a-z0-9]/g, '')
        const stem = path.basename(raw, path.extname(raw)).replace(/[^A-Za-z0-9_\-.]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'file'
        const buf = await readBody(req)
        if (!buf.length) return send(res, 400, { error: 'ไฟล์ว่าง' })
        await fs.mkdir(UPLOADS, { recursive: true })
        // ชื่อไฟล์ขึ้นต้นด้วยแฮช 8 ตัว → ไฟล์เดิมอัปซ้ำได้ชื่อเดิม ไม่เปลือง
        const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)
        const file = `${hash}-${stem}${ext}`
        const dest = path.join(UPLOADS, file)
        if (!(await exists(dest))) await fs.writeFile(dest, buf)
        return send(res, 200, { file, name: stem + ext, url: `/files/uploads/${encodeURIComponent(file)}`, size: buf.length, mime: mimeOf(file) })
      }

      // POST /api/import-url {url} → ดาวน์โหลดสื่อจากลิงก์มาเก็บเป็นไฟล์อัปโหลด (เลี่ยง CORS ของเว็บต้นทาง)
      if (req.method === 'POST' && seg[1] === 'import-url') {
        const { url: src } = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) return send(res, 400, { error: 'URL ไม่ถูกต้อง' })
        const r = await fetch(src, { headers: UA, redirect: 'follow' })
        if (!r.ok) return send(res, 502, { error: `ต้นทางตอบ ${r.status}` })
        const type = (r.headers.get('content-type') ?? '').split(';')[0].trim()
        if (!/^(image|video)\//.test(type)) return send(res, 415, { error: `ไม่ใช่ไฟล์ภาพ/วิดีโอ (${type || 'ไม่ทราบชนิด'})` })
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 200 * 1024 * 1024) return send(res, 413, { error: 'ไฟล์ใหญ่เกิน 200MB' })
        const extByType = Object.entries(MIME).find(([, m]) => m === type)?.[0] ?? ''
        let base = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'media')
        if (!path.extname(base)) base += extByType
        const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '')
        const stem = path.basename(base, path.extname(base)).replace(/[^A-Za-z0-9_\-.]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'media'
        await fs.mkdir(UPLOADS, { recursive: true })
        const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)
        const file = `${hash}-${stem}${ext}`
        const dest = path.join(UPLOADS, file)
        if (!(await exists(dest))) await fs.writeFile(dest, buf)
        return send(res, 200, { file, name: stem + ext, url: `/files/uploads/${encodeURIComponent(file)}`, size: buf.length, mime: mimeOf(file) })
      }

      if (req.method === 'GET' && seg[1] === 'uploads') return send(res, 200, { files: await listUploads() })
      if (req.method === 'DELETE' && seg[1] === 'uploads' && seg[2]) {
        if (!SEG_RE.test(seg[2])) return send(res, 400, { error: 'bad name' })
        await fs.rm(path.join(UPLOADS, seg[2]), { force: true })
        return send(res, 200, { ok: true })
      }

      // ── โปรเจค ──
      if (seg[1] === 'projects') {
        await fs.mkdir(PROJECTS, { recursive: true })
        if (req.method === 'GET' && !seg[2]) {
          const files = (await fs.readdir(PROJECTS)).filter(f => f.endsWith('.json'))
          const list = await Promise.all(files.map(async f => {
            const st = await fs.stat(path.join(PROJECTS, f))
            return { name: f.slice(0, -5), at: st.mtimeMs, size: st.size }
          }))
          return send(res, 200, { projects: list.sort((a, b) => b.at - a.at) })
        }
        const name = seg[2]
        if (!name || !PROJECT_RE.test(name)) return send(res, 400, { error: 'ชื่อโปรเจคใช้ได้แค่ตัวอักษร ตัวเลข ช่องว่าง _ -' })
        const file = path.join(PROJECTS, name + '.json')
        if (req.method === 'GET') {
          const data = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)
          return data ? send(res, 200, { project: data }) : send(res, 404, { error: 'ไม่พบโปรเจค' })
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8'))
          await fs.writeFile(file, JSON.stringify(body, null, 1), 'utf8')
          return send(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          await fs.rm(file, { force: true })
          return send(res, 200, { ok: true })
        }
      }

      return send(res, 404, { error: 'not found' })
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 500
      return send(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
