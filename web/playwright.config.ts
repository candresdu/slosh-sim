import { defineConfig, devices } from '@playwright/test';

// E2E suite: serves the production library build (dist/, which also holds the demo and mock al-folio pages)
// with `vite preview` and runs every spec on Chromium, Firefox and WebKit.
const PORT = 4173;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 3, // software WebGL in three browsers: more workers slow the sim clock and make timing waits flaky
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1000, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 900 } } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1000, height: 900 },
        // software WebGL in headless Firefox; specs that need a 3D scene check for it first
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1000, height: 900 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !CI,
    timeout: 180_000,
  },
});
