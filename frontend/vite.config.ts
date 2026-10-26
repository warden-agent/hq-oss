import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4780', '/ws': { target: 'ws://127.0.0.1:4780', ws: true } } },
  build: { outDir: 'dist' },
})
