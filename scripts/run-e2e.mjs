#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const [mode = 'test', ...args] = process.argv.slice(2);

const modes = {
  test: ['test'],
  ui: ['test', '--ui'],
  headed: ['test', '--headed'],
  fast: ['test'],
  report: ['show-report'],
};

if (!Object.prototype.hasOwnProperty.call(modes, mode)) {
  console.error(`[e2e] 未知模式：${mode}`);
  console.error(`[e2e] 可用模式：${Object.keys(modes).join(', ')}`);
  process.exit(1);
}

function resolvePlaywrightCli() {
  for (const id of ['@playwright/test/cli', 'playwright/cli']) {
    try {
      return require.resolve(id);
    } catch {
      // Try the next package entry.
    }
  }
  return null;
}

const cliPath = resolvePlaywrightCli();
if (!cliPath) {
  console.error('[e2e] 未找到 Playwright CLI。请先执行 `npm install` 安装 devDependencies。');
  process.exit(1);
}

const env = { ...process.env };
if (mode === 'fast') {
  env.E2E_SKIP_BUILD = '1';
}

const result = spawnSync(process.execPath, [cliPath, ...modes[mode], ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(`[e2e] Playwright 启动失败：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
