import { defineConfig } from '@playwright/test';

/**
 * Tests de bout en bout : base Supabase locale (`npm run db:start`) + serveur Vite.
 * En local, Playwright utilise le Chrome installé ; en intégration continue, le Chromium de Playwright.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'fr-FR',
    timezoneId: 'Indian/Antananarivo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.CI ? undefined : 'chrome',
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
