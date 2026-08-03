#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
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
env.AILY_E2E_INTERACTIVE_DECISIONS =
  !process.env.CI && process.stdin.isTTY && process.stdout.isTTY ? '1' : '0';

const child = spawn(process.execPath, [cliPath, ...modes[mode], ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env,
  // POSIX 下让 Playwright 成为独立进程组，便于只向它及其 worker/应用
  // 转发中断；Windows 控制台则依赖 Ctrl+C 的前台进程广播。
  detached: process.platform !== 'win32',
});

let interrupted = false;
let lastSigintAt = 0;

function forceStopChild() {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function handleSigint() {
  const now = Date.now();
  if (!interrupted) {
    interrupted = true;
    lastSigintAt = now;
    console.error('\n[e2e] 收到 Ctrl+C，正在停止测试、关闭子进程并生成报告，请稍候……');

    // POSIX 下 Playwright 位于独立进程组，需要把中断转发给整组。
    // Windows 的前台控制台会广播 Ctrl+C；child.kill('SIGINT') 在 Windows
    // 等同于强制终止，不能用于优雅停止。
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        child.kill('SIGINT');
      }
    }
    return;
  }

  // npm 在部分平台会快速重复投递同一次 SIGINT，不能把它误判为用户第二次按键。
  if (now - lastSigintAt < 1_000) {
    return;
  }

  console.error('\n[e2e] 再次收到 Ctrl+C，强制终止测试；本次报告可能不完整。');
  forceStopChild();
}

process.on('SIGINT', handleSigint);

child.once('error', (error) => {
  process.off('SIGINT', handleSigint);
  console.error(`[e2e] Playwright 启动失败：${error.message}`);
  process.exitCode = 1;
});

child.once('close', (code, signal) => {
  process.off('SIGINT', handleSigint);
  if (code !== null) {
    process.exitCode = code;
    return;
  }

  process.exitCode = signal === 'SIGINT' || interrupted ? 130 : 1;
});
