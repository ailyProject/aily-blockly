import { defineConfig } from '@playwright/test';
import * as path from 'path';

const target = (process.env.AILY_TEST_TARGET ?? 'dev') as 'dev' | 'prod';
const isCI = !!process.env.CI;
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs',
  // 单个测试总超时：含 npm install + 编译 + 上传，给足时间
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: Number(process.env.AILY_TEST_WORKERS ?? (isCI ? 2 : 1)),
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // dev 模式下自动拉起 ng serve；若已经在跑则复用，不再重复启动。
  webServer:
    target === 'dev'
      ? {
          command: 'npm start',
          cwd: repoRoot,
          url: 'http://localhost:4200',
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
        }
      : undefined,
  projects: [
    {
      name: target,
      metadata: {
        target,
        repoRoot,
      },
    },
  ],
});
