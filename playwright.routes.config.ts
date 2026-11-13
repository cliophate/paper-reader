import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/routes',
  testMatch: '*.pw.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4318', browserName: 'chromium' },
  webServer: { command: 'node scripts/reader-routes-fixture.mjs', url: 'http://127.0.0.1:4318/health', reuseExistingServer: false },
})
