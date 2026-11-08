import { defineConfig } from '@playwright/test';
/**
 * `E2E_PORT=5197 pnpm test:e2e` overrides the port.
 *
 * The default is 5199, deliberately NOT the dev server's 5173: with `reuseExistingServer` the suite
 * would otherwise attach to a presenter's live dev server and run the fixture, local-physics and
 * benchmark specs against a live database, which fails 6/10 with misleading assertion errors.
 */
const port = Number(process.env.E2E_PORT ?? 5199);
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } }, { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
  // Every spec here is mock / local-physics. Pin the mode so an ambient VITE_DATA_MODE=live, or an
  // apps/web/.env.local written for presenter mode, cannot silently change what is under test. The
  // empty token keeps the suite on the read-only path regardless of what the presenter has exported.
  webServer: {
    command: `corepack pnpm dev --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    env: { VITE_DATA_MODE: 'mock', VITE_ADMIN_TOKEN: '' },
  },
});
