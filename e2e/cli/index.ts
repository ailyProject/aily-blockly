#!/usr/bin/env tsx
/**
 * aily-test — 外部 Node.js CLI，用于调度 Electron 自动化测试。
 *
 * 子命令：
 *   run [pattern]           直接跑 playwright test pattern
 *   doctor                  环境自检（node/electron/deps/ng serve）
 *   boards list             列出当前 boards.json
 *   boards run              跑 10-board-matrix-build 板卡矩阵
 *   mock-server start|stop  启动/停止本地 mock 服务（MCP/npm registry）
 *   report                  打开最近一次 HTML 报告
 */

import { Command } from 'commander';
import chalk from 'chalk';
import execa from 'execa';
import * as path from 'path';
import * as fs from 'fs';

const E2E_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(E2E_ROOT, '..');

const program = new Command();
program
  .name('aily-test')
  .description('Automation CLI for aily-blockly E2E tests')
  .version('0.1.0');

// ------------------ run ------------------
program
  .command('run [pattern]')
  .description('Run Playwright specs (optionally filter by pattern)')
  .option('--headed', 'run with visible Electron window')
  .option('--target <mode>', 'dev | prod', 'dev')
  .option('--workers <n>', 'parallel workers', '1')
  .option('--grep <re>', 'only run tests matching regex')
  .option('--mock', 'enable MOCK_BUILDER=1 MOCK_HARDWARE=1 MOCK_SERIAL=1', false)
  .action(async (pattern: string | undefined, opts) => {
    const args = ['playwright', 'test'];
    if (pattern) args.push(pattern);
    if (opts.headed) args.push('--headed');
    if (opts.workers) args.push(`--workers=${opts.workers}`);
    if (opts.grep) args.push(`--grep=${opts.grep}`);

    const env = {
      ...process.env,
      AILY_TEST_TARGET: opts.target,
    };
    if (opts.mock) {
      env.MOCK_BUILDER = '1';
      env.MOCK_HARDWARE = '1';
      env.MOCK_SERIAL = '1';
    }

    console.log(chalk.cyan('[aily-test] npx'), args.join(' '));
    try {
      await execa('npx', args, { cwd: E2E_ROOT, stdio: 'inherit', env });
    } catch (e: any) {
      process.exit(e.exitCode ?? 1);
    }
  });

// ------------------ doctor ------------------
program
  .command('doctor')
  .description('Sanity check environment')
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    // Node
    const nodeV = process.versions.node;
    checks.push({ name: 'node', ok: parseInt(nodeV.split('.')[0], 10) >= 18, detail: nodeV });

    // Playwright
    try {
      const pw = await execa('npx', ['playwright', '--version'], { cwd: E2E_ROOT });
      checks.push({ name: 'playwright', ok: true, detail: pw.stdout.trim() });
    } catch (e: any) {
      checks.push({ name: 'playwright', ok: false, detail: e.shortMessage || String(e) });
    }

    // main.js
    const mainJs = path.join(REPO_ROOT, 'electron/main.js');
    checks.push({ name: 'electron/main.js', ok: fs.existsSync(mainJs) });

    // test-hooks.js
    const hooks = path.join(REPO_ROOT, 'electron/test-hooks.js');
    checks.push({ name: 'electron/test-hooks.js', ok: fs.existsSync(hooks) });

    // child binaries
    const childDir = path.join(REPO_ROOT, 'child');
    checks.push({ name: 'child/', ok: fs.existsSync(childDir) });

    // boards.json
    const boardsPath = path.join(E2E_ROOT, 'fixtures/boards.json');
    checks.push({ name: 'fixtures/boards.json', ok: fs.existsSync(boardsPath) });

    let anyFail = false;
    for (const c of checks) {
      const mark = c.ok ? chalk.green('✓') : chalk.red('✗');
      console.log(`${mark} ${c.name}${c.detail ? chalk.gray(`  (${c.detail})`) : ''}`);
      if (!c.ok) anyFail = true;
    }
    if (anyFail) {
      console.log(chalk.yellow('\nSome checks failed. Run `npm install` in both root and e2e/, then `npx playwright install chromium`.'));
      process.exit(1);
    } else {
      console.log(chalk.green('\nAll checks passed.'));
    }
  });

// ------------------ boards ------------------
const boardsCmd = program.command('boards').description('Board matrix operations');

boardsCmd
  .command('list')
  .description('List boards from fixtures/boards.json')
  .action(() => {
    const boardsPath = path.join(E2E_ROOT, 'fixtures/boards.json');
    const boards = JSON.parse(fs.readFileSync(boardsPath, 'utf8'));
    for (const b of boards) {
      console.log(
        `${chalk.cyan(b.id.padEnd(24))} ${chalk.bold(b.name.padEnd(28))} ${chalk.gray(b.package)}`
      );
    }
    console.log(chalk.gray(`\n${boards.length} boards`));
  });

boardsCmd
  .command('run')
  .description('Run the board matrix build spec')
  .option('--ids <csv>', 'comma-separated board ids to include')
  .option('--headed', 'run headed')
  .option('--workers <n>', 'parallel workers', '1')
  .option('--grep <re>', 'only run tests whose title matches regex')
  .option('--mock', 'enable mocks (default: on)', true)
  .option('--no-mock', 'disable mocks (use real builder)')
  .option('--target <mode>', 'dev | prod', 'dev')
  .action(async (opts) => {
    const env = {
      ...process.env,
      AILY_TEST_TARGET: opts.target,
    };
    if (opts.mock !== false) {
      env.MOCK_BUILDER = '1';
      env.MOCK_HARDWARE = '1';
      env.MOCK_SERIAL = '1';
    }
    if (opts.ids) env.BOARDS = opts.ids;

    const args = [
      'playwright',
      'test',
      'specs/10-board-matrix-build.spec.ts',
      `--workers=${opts.workers}`,
    ];
    if (opts.headed) args.push('--headed');
    if (opts.grep) args.push(`--grep=${opts.grep}`);

    console.log(chalk.cyan('[aily-test boards run]'),
      env.BOARDS ? `boards=${env.BOARDS}` : '(all)',
      env.MOCK_BUILDER ? '[mocked]' : '[real build]'
    );

    try {
      await execa('npx', args, { cwd: E2E_ROOT, stdio: 'inherit', env });
    } catch (e: any) {
      process.exit(e.exitCode ?? 1);
    }
  });

// ------------------ report ------------------
program
  .command('report')
  .description('Open the latest HTML report')
  .action(async () => {
    await execa('npx', ['playwright', 'show-report', 'reports/html'], {
      cwd: E2E_ROOT,
      stdio: 'inherit',
    });
  });

// ------------------ mock-server (stub) ------------------
program
  .command('mock-server <action>')
  .description('Start/stop local mock servers (MCP/npm) — WIP')
  .action(async (action: string) => {
    console.log(chalk.yellow(`[mock-server] ${action} — not yet implemented`));
    console.log('TODO: 启动 verdaccio (mock npm) + local MCP HTTP server');
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(e?.stack || e));
  process.exit(1);
});
