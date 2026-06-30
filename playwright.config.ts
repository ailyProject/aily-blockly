import { defineConfig } from '@playwright/test';

/**
 * Playwright 配置 —— 用于 aily-blockly Electron 桌面应用的端到端测试。
 *
 * 测试针对「生产构建产物」运行：global-setup 会执行 `ng build` 并把渲染层
 * 暂存到 <root>/renderer，随后由 Electron 主进程以 loadFile('renderer/index.html')
 * 方式加载（即非 --serve 的生产加载路径）。
 *
 * 由于每个测试会真实启动一个 Electron 实例，测试串行执行（workers: 1），
 * 避免多个 Electron 进程互相争抢窗口/端口/用户数据目录。
 */
export default defineConfig({
  testDir: './e2e/tests',
  // 构建 + 启动 Electron 较慢，给足超时。
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  // Electron 实例串行启动，避免相互干扰。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    // 失败时保留排查信息。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
