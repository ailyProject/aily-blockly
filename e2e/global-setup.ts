import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Playwright global setup.
 *
 * Responsibilities:
 * 1. Run `ng build --base-href ./` to produce `dist/aily-blockly/browser`.
 * 2. Stage that browser output into `<root>/renderer`, matching the production
 *    electron-builder mapping used by `electron/main.js`.
 *
 * 每次运行都重新构建并暂存 renderer，确保测试使用当前源码。
 */
const ROOT = path.resolve(__dirname, '..');
const NG_CLI = path.join(ROOT, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const BUILD_OUTPUT = path.join(ROOT, 'dist', 'aily-blockly', 'browser');
const RENDERER_DIR = path.join(ROOT, 'renderer');

const BUILD_INPUTS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'public'),
  path.join(ROOT, 'angular.json'),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'tsconfig.app.json'),
];

const IGNORED_DIRS = new Set([
  '.angular',
  'dist',
  'node_modules',
  'playwright-report',
  'renderer',
  'test-results',
]);

function runAngularBuild(): void {
  console.log('[e2e] Running ng build --base-href ./ ...');
  const result = spawnSync(process.execPath, [NG_CLI, 'build', '--base-href', './'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.status !== 0) {
    const detail = result.error
      ? `error: ${result.error.message}`
      : result.signal
        ? `signal: ${result.signal}`
        : `exit code: ${result.status}`;
    throw new Error(`[e2e] ng build failed: ${detail}`);
  }
}

function stageRenderer(): void {
  if (!existsSync(BUILD_OUTPUT)) {
    throw new Error(`[e2e] Build output not found: ${BUILD_OUTPUT}`);
  }
  console.log(`[e2e] Staging renderer: ${BUILD_OUTPUT} -> ${RENDERER_DIR}`);
  rmSync(RENDERER_DIR, { recursive: true, force: true });
  cpSync(BUILD_OUTPUT, RENDERER_DIR, { recursive: true });
}

function latestMtimeMs(targetPath: string): number {
  if (!existsSync(targetPath)) {
    return 0;
  }

  const stat = statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    latest = Math.max(latest, latestMtimeMs(path.join(targetPath, entry.name)));
  }
  return latest;
}

function latestBuildInputMtimeMs(): number {
  return BUILD_INPUTS.reduce((latest, inputPath) => Math.max(latest, latestMtimeMs(inputPath)), 0);
}

function isFreshAgainstBuildInputs(targetPath: string): boolean {
  if (!existsSync(targetPath)) {
    return false;
  }
  return latestMtimeMs(targetPath) >= latestBuildInputMtimeMs();
}

export default function globalSetup(): void {
  runAngularBuild();
  stageRenderer();
}
