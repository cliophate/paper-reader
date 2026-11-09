import fs from 'node:fs'
import crypto from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'paper-offline-assets',
    generateBundle(_options, bundle) {
      const version = crypto.createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: fs.readFileSync('public/sw.js', 'utf8').replace('paper-shell-v3', `paper-shell-v3-${version}`) })
      this.emitFile({ type: 'asset', fileName: 'offline-assets.json', source: JSON.stringify(Object.keys(bundle).filter(name => !name.endsWith('.map') && name !== 'index.html').map(name => `/${name}`)) })
    },
  }],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/briefings': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
})
