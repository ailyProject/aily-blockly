import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, test } from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('reloads the renderer with a complete project and preserves normal opening performance', async () => {
  test.skip(!source, 'Set AILY_E2E_PROJECT to an installed project; only a copy is modified.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-project-refresh-'));
  const project = path.join(root, 'project');
  const original = await readFile(path.join(source!, 'project.abi'), 'utf8');
  await cp(source!, project, { recursive: true, dereference: true, filter: file => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(file)) });
  const config = JSON.parse(await readFile('electron/config/config.json', 'utf8'));
  config.compile = { backend: 'local' };
  const launched = await launchAilyElectron({ config });
  const win = await getMainWindow(launched.app);
  const report: any = { source, sourceHash: hash(original), rounds: [], errors: [] };
  const editorOnly = async () => {
    // Isolate editor timing from automatic SDK downloads in the disposable
    // profile. Project/library loading, native Blockly and generation stay real.
    await win.waitForFunction(() => {
      const host = document.querySelector('app-main-window');
      return host && (window as any).ng?.getComponent(host)?.npmService;
    });
    await win.evaluate(() => {
      (window as any).ng.getComponent(document.querySelector('app-main-window')).npmService.installBoardDeps = async () => {};
    });
  };
  await editorOnly();
  report.editorOnly = true;
  let expectedProgram: string;
  let expectedCode: string;
  win.on('pageerror', error => report.errors.push(error.message));
  win.on('console', message => {
    if (/加载项目失败|Unable to open the requested project|project open completion timed out/.test(message.text())) {
      report.errors.push(message.text());
    }
  });
  const ready = async () => {
    await win.waitForFunction(() => {
      const host = document.querySelector('app-blockly-editor');
      const editor = host && (window as any).ng?.getComponent(host);
      return editor?.projectService.getBlocklyProjectLoadStatus().ready
        && document.querySelector('iframe[data-runtime-ready="true"]');
    }, undefined, { timeout: 90_000 });
  };
  try {
    for (const mode of ['open', 'open', 'open', 'refresh', 'refresh', 'refresh']) {
      if (mode === 'open') {
        await win.evaluate(() => { location.hash = '#/main/guide'; });
        await expect(win.locator('app-guide')).toHaveCount(1);
      }
      const start = Date.now();
      if (mode === 'refresh') {
        // webContents.reload is the same main-frame reload used by Electron's
        // Ctrl/Cmd+R menu role, including preload and Angular reinitialization.
        await win.reload({ waitUntil: 'domcontentloaded' });
        await editorOnly();
      } else {
        await win.evaluate(projectPath => {
          const guide = (window as any).ng.getComponent(document.querySelector('app-guide'));
          void guide.projectService.projectOpen(projectPath);
        }, project);
      }
      await ready();
      const elapsedMs = Date.now() - start;
      const state = await win.evaluate(async () => {
        const w = window as any;
        const editor = w.ng.getComponent(document.querySelector('app-blockly-editor'));
        const workspace = w.blocklyWorkspace;
        const program = JSON.stringify(editor.blocklyService.getProjectAbiForSave());
        await editor._projectService.save(editor.projectService.currentProjectPath);
        return { program, count: workspace.getAllBlocks(false).length,
          roots: workspace.getTopBlocks(false).map(block => block.id),
          scale: workspace.scale, viewport: workspace.getCanvas().getAttribute('transform') };
      });
      const code = await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
      expectedProgram ??= state.program;
      expectedCode ??= code;
      expect(state.program).toBe(expectedProgram);
      expect(code).toBe(expectedCode);
      report.rounds.push({ mode, elapsedMs, ...state, program: undefined, programHash: hash(state.program), codeHash: hash(code) });
      console.log('[project-refresh]', JSON.stringify(report.rounds.at(-1)));
    }
    expect(report.errors).toEqual([]);
    expect(await readFile(path.join(source!, 'project.abi'), 'utf8')).toBe(original);
  } finally {
    const output = path.resolve('e2e/.artifacts/project-refresh', process.env['AILY_REFRESH_LABEL'] || 'current');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    await win.screenshot({ path: path.join(output, 'project.png') }).catch(() => {});
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});
