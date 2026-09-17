import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtime = join(root, '.local', 'stp004-pg', 'runtime.env');
if (existsSync(runtime)) {
  for (const line of readFileSync(runtime, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const localOut = join(root, '.local', 'stp004-e2e');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  outputDir: join(localOut, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: join(localOut, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: join(localOut, 'results.json') }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'off',
  },
  webServer: [
    {
      command: 'node ../../scripts/stp004-with-env.mjs pnpm --filter @studysteps/api start',
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @studysteps/web dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @studysteps/admin dev -- --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
