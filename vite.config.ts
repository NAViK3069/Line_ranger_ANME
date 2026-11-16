import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — โมดูล .mjs ฝั่งเซิร์ฟเวอร์ ไม่มีไฟล์ type
import { createApi } from './server/api.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

/** ต่อ API หลังบ้านเข้ากับ dev server (ตัวเดียวกับที่ server.mjs ใช้ตอน production) */
function studioApi(): Plugin {
  return {
    name: 'anme-api',
    configureServer(server) {
      const api = createApi({ root: ROOT })
      server.middlewares.use((req, res, next) => { api(req, res, next) })
    },
  }
}

export default defineConfig({
  plugins: [react(), studioApi()],
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  // รวม React ไว้ตั้งแต่แรก → เปิดหน้าครั้งแรกไม่เจอ "Invalid hook call" จาก Vite optimize ซ้ำกลางทาง
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  server: { port: 5300, watch: { ignored: ['**/storage/**', '**/data/**'] } },
})
