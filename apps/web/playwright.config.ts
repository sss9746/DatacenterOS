import { defineConfig } from '@playwright/test';
/** `E2E_PORT=5197 pnpm test:e2e` runs against a dev server on another port when 5173 is taken. */
const port = Number(process.env.E2E_PORT ?? 5173);
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } }, { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
  webServer: { command: `corepack pnpm dev --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI },
});
