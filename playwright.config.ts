import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.pw.ts',
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:4317', hasTouch: true, serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node tests/browser/server.mjs',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
  },
})
