import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 把 @/ 映射到 src/，shadcn/ui 的组件按这个别名互相引用
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // 让 Tauri 的 devUrl 每次都命中同一个端口，端口被占用时直接报错而不是漂移
  server: { port: 1420, strictPort: true },
})
