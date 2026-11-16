// ====================================================
// netlify/functions/api.mjs — หลังบ้านเวอร์ชัน Netlify (ไม่มีดิสก์ถาวร)
//
// ทำเฉพาะส่วนที่ต้องผ่านเซิร์ฟเวอร์ (lerico ไม่ส่ง CORS header):
//   GET /api/health                 { ok, storage: 'browser' } → ฝั่งเว็บเก็บไฟล์อัปโหลด/โปรเจคใน IndexedDB เอง
//   GET /api/names                  รายชื่อเรนเจอร์ไทย/อังกฤษ
//   GET /api/ranger/:id             ชุดไฟล์ของเรนเจอร์ + ข้อมูลเกม
//   GET /api/res/<dir>/<file>       proxy ไฟล์ .sam/.plist/.png — แคชที่ CDN ของ Netlify ถาวร
//   GET /api/list/<dir>             รายการไฟล์ในโฟลเดอร์ lerico
//   GET /api/gamedata/:id
//   GET /api/library                [] (รายการ "โหลดแล้ว" เก็บฝั่งเว็บ)
//   GET /api/fetch?url=             ดาวน์โหลดสื่อจากลิงก์ภายนอก (≤ 6MB) ให้เว็บเก็บเอง
// ====================================================
import gamedata from '../../data/gamedata-index.json' with { type: 'json' }

const ORIGIN = 'https://rangers.lerico.net'
const UA = { 'User-Agent': 'Mozilla/5.0 (ANME Studio)' }
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i
const SEG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  sam: 'application/octet-stream', plist: 'application/xml', json: 'application/json',
}

/** ไฟล์ของ lerico ไม่เคยเปลี่ยน → แคชที่ CDN ยาว (durable = แชร์ทุกภูมิภาค) */
const FOREVER = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=31536000, durable',
}
const DAY = {
  'Cache-Control': 'public, max-age=3600',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800, durable',
}

/** ให้เว็บโดเมนอื่น (เช่น GitHub Pages) เรียกใช้ได้ */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers } })

async function listDir(dir) {
  const r = await fetch(`${ORIGIN}/res/${dir}/`, { headers: { ...UA, Accept: 'text/html' } })
  if (!r.ok) throw Object.assign(new Error(`ไม่พบ "${dir}" บน lerico (${r.status})`), { status: 404 })
  const html = await r.text()
  return [...html.matchAll(/href="([^"]+)"/gi)].map(m => decodeURIComponent(m[1]))
    .filter(h => !h.startsWith('.') && !h.startsWith('/') && !h.endsWith('/'))
}

function rangerSets(id, files) {
  const sets = {}, thumbs = {}
  const has = new Set(files)
  for (const f of files) {
    if (!f.startsWith(id + '-')) continue
    const part = f.slice(id.length + 1)
    const m = part.match(/^(.+)\.sam$/)
    if (m && has.has(`${id}-${m[1]}.plist`) && has.has(`${id}-${m[1]}.png`)) {
      sets[m[1]] = { sam: `${id}-${m[1]}.sam`, plist: `${id}-${m[1]}.plist`, png: `${id}-${m[1]}.png` }
    }
    if (part === 'thum.png') thumbs.body = f
    if (part === 'e-thum.png') thumbs['e-body'] = f
  }
  return { sets, thumbs }
}

async function names() {
  const [en, th] = await Promise.all(['en', 'th'].map(l =>
    fetch(`${ORIGIN}/api/v2/translate?keys=${l}:UNIT`, { headers: UA }).then(r => r.json()).then(d => d[`${l}:UNIT`] ?? {})))
  const ids = new Set()
  for (const k of [...Object.keys(en), ...Object.keys(th)]) {
    const m = k.match(/^(u[^_]+)_nm$/)
    if (m) ids.add(m[1])
  }
  return [...ids].sort().map(id => ({ id, en: en[`${id}_nm`] ?? null, th: th[`${id}_nm`] ?? null }))
}

export default async (req) => {
  const url = new URL(req.url)
  const seg = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s))
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (seg[0] !== 'api') return json({ error: 'not found' }, 404)
  try {
    if (seg[1] === 'health') return json({ ok: true, storage: 'browser' })
    if (seg[1] === 'library') return json({ rangers: [] })
    if (seg[1] === 'names') return json({ rangers: await names() }, 200, DAY)

    if (seg[1] === 'ranger' && seg[2]) {
      const id = seg[2].toLowerCase().trim()
      if (!ID_RE.test(id)) return json({ error: 'รหัสเรนเจอร์ไม่ถูกต้อง' }, 400)
      const { sets, thumbs } = rangerSets(id, await listDir(id))
      if (!Object.keys(sets).length) return json({ error: `ไม่พบไฟล์อนิเมชั่นของ ${id}` }, 404)
      return json({ id, sets, thumbs, gamedata: gamedata[id] ?? null }, 200, DAY)
    }

    if (seg[1] === 'list' && seg[2]) {
      if (!SEG_RE.test(seg[2])) return json({ error: 'bad dir' }, 400)
      return json({ files: await listDir(seg[2]) }, 200, DAY)
    }

    if (seg[1] === 'gamedata' && seg[2]) return json({ gamedata: gamedata[seg[2].toLowerCase()] ?? null }, 200, FOREVER)

    if (seg[1] === 'res' && seg.length >= 4) {
      const parts = seg.slice(2)
      if (!parts.every(s => SEG_RE.test(s) && s !== '..')) return json({ error: 'bad path' }, 400)
      const r = await fetch(`${ORIGIN}/res/${parts.join('/')}`, { headers: UA })
      if (!r.ok) return json({ error: `lerico ${r.status}` }, r.status === 404 ? 404 : 502)
      const ext = parts.at(-1).split('.').pop().toLowerCase()
      return new Response(await r.arrayBuffer(), { status: 200, headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...CORS, ...FOREVER } })
    }

    if (seg[1] === 'fetch') {
      const src = url.searchParams.get('url') ?? ''
      if (!/^https?:\/\//i.test(src)) return json({ error: 'URL ไม่ถูกต้อง' }, 400)
      const r = await fetch(src, { headers: UA, redirect: 'follow' })
      if (!r.ok) return json({ error: `ต้นทางตอบ ${r.status}` }, 502)
      const type = (r.headers.get('content-type') ?? '').split(';')[0].trim()
      if (!/^(image|video|audio)\//.test(type)) return json({ error: `ไม่ใช่ไฟล์สื่อ (${type || 'ไม่ทราบชนิด'})` }, 415)
      const buf = await r.arrayBuffer()
      if (buf.byteLength > 5.5 * 1024 * 1024) return json({ error: 'ไฟล์ใหญ่เกิน 5.5MB — ดาวน์โหลดลงเครื่องแล้วอัปโหลดแทน' }, 413)
      return new Response(buf, { status: 200, headers: { 'Content-Type': type, ...CORS } })
    }

    if (seg[1] === 'upload' || seg[1] === 'uploads' || seg[1] === 'projects' || seg[1] === 'import-url') {
      return json({ error: 'เวอร์ชันออนไลน์เก็บไฟล์ในเบราว์เซอร์ของคุณ (IndexedDB) — ไม่ผ่านเซิร์ฟเวอร์' }, 501)
    }
    return json({ error: 'not found' }, 404)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, typeof err?.status === 'number' ? err.status : 500)
  }
}

export const config = { path: '/api/*' }
