// ====================================================
// storage.ts — ที่เก็บไฟล์อัปโหลดและโปรเจค
//
//   disk    = รันด้วย npm run dev / npm start → เก็บในโฟลเดอร์ storage/ ของเครื่อง (ผ่าน /api)
//   browser = เว็บออนไลน์ (Netlify ฯลฯ ไม่มีดิสก์ถาวร) → เก็บใน IndexedDB ของเบราว์เซอร์
//
// ไฟล์ในโหมด browser อ้างด้วย URL รูปแบบ "local:<แฮช>/<ชื่อไฟล์>" ในฉาก
// ทุกจุดที่จะโหลดไฟล์ต้องผ่าน fetchBlob() / resolveUrl() เพื่อแปลงเป็น blob: URL
// ====================================================

export type StorageMode = 'disk' | 'browser'

export interface UploadItem {
  file: string
  name: string
  /** URL ที่เก็บในฉาก (local:… หรือ /files/uploads/…) */
  url: string
  /** URL สำหรับแสดงผลตรงๆ (<img>/<video>) */
  src: string
  size: number
  mime: string
  at: number
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', apng: 'image/apng', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  sam: 'application/octet-stream', plist: 'application/xml', json: 'application/json',
}
const mimeOf = (name: string, fallback = '') => fallback && fallback !== 'application/octet-stream' ? fallback : MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? (fallback || 'application/octet-stream')

// ── ตรวจโหมด (ครั้งเดียว) ──
let modePromise: Promise<StorageMode> | null = null
export function storageMode(): Promise<StorageMode> {
  if (!modePromise) {
    // ?storage=browser บังคับโหมดเบราว์เซอร์ (ไว้ทดสอบแบบเว็บออนไลน์บนเครื่องตัวเอง)
    const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('storage') : null
    if (forced === 'browser' || forced === 'disk') return (modePromise = Promise.resolve(forced))
    modePromise = fetch('/api/health')
      .then(r => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
      .then(d => (d?.ok && d.storage !== 'browser' ? 'disk' : 'browser') as StorageMode)
      .catch(() => 'browser' as StorageMode)
  }
  return modePromise
}

// ── IndexedDB ──
interface FileRec { key: string; name: string; mime: string; size: number; at: number; blob: Blob }
interface ProjectRec { name: string; at: number; scene: unknown }

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('anme-studio', 1)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' })
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'name' })
      }
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error ?? new Error('เปิด IndexedDB ไม่ได้'))
    })
  }
  return dbPromise
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(d => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  }))
}

async function hashOf(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
  return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
}

const safeName = (n: string) => n.normalize('NFC').replace(/[\\/:*?"<>|#%]+/g, '_').slice(0, 80) || 'file'

// ── แปลง local: → blob: URL (แคชไว้ ใช้ซ้ำได้ตลอดอายุหน้า) ──
const objectUrls = new Map<string, string>()
const keyOf = (url: string) => url.slice('local:'.length).split('/')[0]
export const isLocalUrl = (url: string) => url.startsWith('local:')

export async function resolveUrl(url: string): Promise<string> {
  if (!isLocalUrl(url)) return url
  const key = keyOf(url)
  const hit = objectUrls.get(key)
  if (hit) return hit
  const rec = await tx<FileRec | undefined>('files', 'readonly', s => s.get(key))
  if (!rec) throw new Error(`ไม่พบไฟล์ในเบราว์เซอร์นี้ (${decodeURIComponent(url.split('/').pop() ?? '')}) — อาจถูกล้างข้อมูล หรือฉากนี้มาจากเครื่องอื่น`)
  const obj = URL.createObjectURL(rec.blob)
  objectUrls.set(key, obj)
  return obj
}

/** โหลดไฟล์เป็น Blob ได้ทั้ง URL ปกติและ local: */
export async function fetchBlob(url: string): Promise<Blob> {
  if (isLocalUrl(url)) {
    const rec = await tx<FileRec | undefined>('files', 'readonly', s => s.get(keyOf(url)))
    if (!rec) throw new Error(`ไม่พบไฟล์ในเบราว์เซอร์นี้ (${decodeURIComponent(url.split('/').pop() ?? '')})`)
    return rec.blob
  }
  const r = await fetch(url)
  if (!r.ok || (r.headers.get('content-type') ?? '').startsWith('text/html')) {
    throw new Error(`${decodeURIComponent(url.split('/').pop() ?? url)} (${r.ok ? 'ไม่ใช่ไฟล์' : r.status})`)
  }
  return r.blob()
}

// ── อัปโหลด ──
export async function saveUpload(f: File | Blob, name?: string): Promise<UploadItem> {
  const n = safeName(name ?? (f instanceof File ? f.name : 'file'))
  if ((await storageMode()) === 'disk') {
    const r = await fetch(`/api/upload?name=${encodeURIComponent(n)}`, { method: 'POST', body: f })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error ?? 'อัปโหลดไม่สำเร็จ')
    return { ...d, src: d.url, at: Date.now() }
  }
  const key = await hashOf(f)
  const mime = mimeOf(n, f.type)
  const rec: FileRec = { key, name: n, mime, size: f.size, at: Date.now(), blob: f.type === mime ? f : new Blob([f], { type: mime }) }
  await tx('files', 'readwrite', s => s.put(rec))
  const url = `local:${key}/${encodeURIComponent(n)}`
  return { file: key, name: n, url, src: await resolveUrl(url), size: f.size, mime, at: rec.at }
}

export async function listUploads(): Promise<UploadItem[]> {
  if ((await storageMode()) === 'disk') {
    const d = await fetch('/api/uploads').then(r => r.json())
    return (d.files ?? []).map((x: UploadItem) => ({ ...x, src: x.url }))
  }
  const all = await tx<FileRec[]>('files', 'readonly', s => s.getAll())
  const out: UploadItem[] = []
  for (const r of all) {
    if (/\.(sam|plist)$/i.test(r.name)) continue
    const url = `local:${r.key}/${encodeURIComponent(r.name)}`
    out.push({ file: r.key, name: r.name, url, src: await resolveUrl(url), size: r.size, mime: r.mime, at: r.at })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** ดึงสื่อจากลิงก์ภายนอกแล้วเก็บเหมือนไฟล์อัปโหลด */
export async function importFromUrl(src: string): Promise<UploadItem> {
  if ((await storageMode()) === 'disk') {
    const r = await fetch('/api/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: src }) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error ?? 'ดาวน์โหลดไม่ได้')
    return { ...d, src: d.url, at: Date.now() }
  }
  const r = await fetch(`/api/fetch?url=${encodeURIComponent(src)}`)
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `ดาวน์โหลดไม่ได้ (${r.status})`)
  const blob = await r.blob()
  let name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'media')
  if (!/\.\w+$/.test(name)) name += '.' + (blob.type.split('/')[1] ?? 'bin')
  return saveUpload(blob, name)
}

// ── โปรเจค ──
export interface ProjectInfo { name: string; at: number }

export async function listProjects(): Promise<ProjectInfo[]> {
  if ((await storageMode()) === 'disk') return (await fetch('/api/projects').then(r => r.json())).projects ?? []
  const all = await tx<ProjectRec[]>('projects', 'readonly', s => s.getAll())
  return all.map(p => ({ name: p.name, at: p.at })).sort((a, b) => b.at - a.at)
}

export async function loadProject(name: string): Promise<unknown | null> {
  if ((await storageMode()) === 'disk') return (await fetch(`/api/projects/${encodeURIComponent(name)}`).then(r => r.json())).project ?? null
  return (await tx<ProjectRec | undefined>('projects', 'readonly', s => s.get(name)))?.scene ?? null
}

export async function saveProjectData(name: string, scene: unknown): Promise<void> {
  if ((await storageMode()) === 'disk') {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) })
    if (!r.ok) throw new Error((await r.json()).error ?? 'บันทึกไม่สำเร็จ')
    return
  }
  await tx('projects', 'readwrite', s => s.put({ name, at: Date.now(), scene: JSON.parse(JSON.stringify(scene)) }))
}

export async function deleteProject(name: string): Promise<void> {
  if ((await storageMode()) === 'disk') { await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }); return }
  await tx('projects', 'readwrite', s => s.delete(name))
}

// ── เรนเจอร์ที่เคยโหลด (ใช้ในโหมด browser แทนการอ่านโฟลเดอร์แคช) ──
const RECENT_KEY = 'anme.recentRangers'
export function rememberRanger(id: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list.filter(x => x !== id)].slice(0, 60)))
  } catch { /* */ }
}
export function recentRangers(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}
