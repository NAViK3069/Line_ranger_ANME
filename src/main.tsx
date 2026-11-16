import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

// ช่วยดีบักตอน dev: window.__anme.assets / .store
if (import.meta.env.DEV) {
  Promise.all([import('./engine/assets'), import('./engine/store')]).then(([a, s]) => {
    (window as unknown as Record<string, unknown>).__anme = { assets: a.assets, store: s }
  })
}
