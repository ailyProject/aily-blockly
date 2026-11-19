import { mkdir, mkdtemp, readFile, writeFile, realpath, cp } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, test, ROOT } from '../fixtures/electron-app';

const platform = process.env['AILY_E2E_PLATFORM_SEED'];
const { runDependencyWorker } = require('../../electron/library-dependencies');
const name = (id: string) => `@aily-project-coder/lib-case-${id}`;

test('Coder project under an upper-case path closes, saves and quits without an unknown save state', async ({}, info) => {
  test.skip(!platform, 'Supply the installed platform root.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-coder-case-')));
  const project = path.join(root, 'Aily-Case', 'Coder-Project');
  expect(project.toLowerCase()).not.toBe(project);
  const write = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  const tar = require(path.join(ROOT, 'child/node/lib/node_modules/npm/node_modules/tar'));
  const packages = new Map<string, any>();
  for (const id of ['a', 'b']) {
    const directory = path.join(root, 'registry', id), manifest = { name: name(id), version: '1.0.0' };
    await write(path.join(directory, 'package/package.json'), JSON.stringify(manifest));
    await write(path.join(directory, 'package/src/library.properties'), `name=Case ${id}\nversion=1.0.0\narchitectures=*\n`);
    await write(path.join(directory, 'package/src/src', `Case${id}.h`), '#pragma once\n');
    await tar.c({ gzip: true, file: path.join(directory, 'package.tgz'), cwd: directory }, ['package']);
    const body = await readFile(path.join(directory, 'package.tgz'));
    packages.set(name(id), { manifest, body, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}` });
  }
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url!.split('/-/')[0].slice(1)), pkg = packages.get(key);
    if (!pkg) { res.writeHead(404); res.end(); return; }
    if (req.url!.includes('/-/')) { res.end(pkg.body); return; }
    const version = { ...pkg.manifest, dist: { tarball: `${registry}/${key}/-/package.tgz`, integrity: pkg.integrity } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: key, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${(server.address() as any).port}`;
  const board = '@aily-project/board-arduino_uno';
  await cp(path.join(platform!, 'node_modules', board), path.join(project, 'local-board'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  await write(path.join(project, 'package.json'), JSON.stringify({ name: 'coder-case-path', version: '1.0.0', type: 'coder', framework: 'arduino',
    entry: 'src/main.cpp', dependencies: { [board]: 'file:local-board', [name('a')]: '1.0.0' } }, null, 2));
  await write(path.join(project, 'sketch/src/main.cpp'), '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n');
  await runDependencyWorker(project, { save: true, options: { '@aily-project-coder:registry': registry } });

  const launch = await launchAilyElectron({
    environment: { AILY_BUILD_PRODUCT: 'coder', AILY_E2E_CODER_STORE_SEED: path.join(platform!, 'npm-global/app/store/subapp-aily-coder-editor') },
    config: { lang: 'zh_CN', blocklyOnboardingCompleted: true, devmode: { enabled: true, autoSave: false }, regions: { cn: { npm_registry_coder: registry } } },
  });
  const electronProcess = launch.app.process();
  const catalog = { libraries: ['a', 'b'].map(id => ({ name: name(id), nickname: `Case ${id}`, version: '1.0.0', architectures: ['*'], description: 'Case path fixture' })) };
  const index = 'https://blockly.yiyu.pro/libraries-coder-index.json';
  await write(path.join(launch.userDataDir, 'cache/coder-package-libraries', `${createHash('sha256').update(index).digest('hex')}.json`), JSON.stringify(catalog));
  const win = await getMainWindow(launch.app);
  const config = JSON.parse(await readFile(path.join(launch.userDataDir, 'config.json'), 'utf8'));
  config.regions.cn.npm_registry_coder = registry;
  await writeFile(path.join(launch.userDataDir, 'config.json'), JSON.stringify(config));
  await win.evaluate(registry => { (window as any).ng.getComponent(document.querySelector('app-header')).configService.data.regions.cn.npm_registry_coder = registry; }, registry);
  await win.addLocatorHandler(win.locator('app-login .login-close'), async button => button.click());

  const dialog = win.locator('app-unsave-dialog');
  const ready = () => expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1, { timeout: 90_000 });
  const dirty = (value: boolean) => expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', String(value));
  const frame = () => win.frames().find(frame => frame.url().includes('nativeFsBridge=true'))!;
  const editor = () => frame().locator('.monaco-editor').first();
  const manifest = async () => JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const api = (action: string, id: string) => frame().evaluate(async ({ action, id, project }) => {
    const response = await fetch(`/api/component-libraries/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: project, source: 'registry', libraryId: `coder:@aily-project-coder/lib-case-${id}`, version: '1.0.0', query: 'Case' }) });
    return response.json();
  }, { action, id, project });
  const pageErrors: string[] = [], messages: string[] = [];
  win.on('pageerror', error => pageErrors.push(error.message));
  win.on('console', message => { if (/identity changed|无法确认保存状态/.test(message.text())) messages.push(message.text()); });
  const startClose = () => win.evaluate(() => {
    const w = window as any; w.closeDecision = undefined;
    w.ng.getComponent(document.querySelector('app-header')).checkUnsavedChanges('close').then((value: boolean) => { w.closeDecision = value; });
  });
  const closeDecision = () => win.evaluate(() => (window as any).closeDecision);
  const expectCleanClose = async (step: string) => {
    await startClose();
    await expect.poll(closeDecision, { message: step }).toBe(true);
    await expect(dialog, step).toHaveCount(0);
  };
  const evidence: Record<string, unknown> = { project };

  try {
    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); await dirty(false);

    // 1. Saved project: the close check must resolve without any dialog.
    evidence['status'] = await win.evaluate(project => (window as any).libraryDependencies.status(project), project);
    // Control: the host still rejects the lower-cased spelling the old service passed.
    evidence['lowerCaseStatus'] = await win.evaluate(project => (window as any).libraryDependencies.status(project.toLowerCase())
      .then(() => 'accepted', (error: Error) => error.message), project);
    expect(evidence['lowerCaseStatus']).toContain('Project root identity changed during publication');
    await expectCleanClose('saved project close');

    // 2. Library install/remove publish immediately; closing stays silent.
    evidence['install'] = await api('install', 'b'); expect(evidence['install']).toMatchObject({ ok: true });
    evidence['remove'] = await api('remove', 'a'); expect(evidence['remove']).toMatchObject({ ok: true });
    await dirty(false);
    const dependencies = (await manifest()).dependencies;
    expect(dependencies[name('b')]).toBe('1.0.0'); expect(dependencies[name('a')]).toBeUndefined();
    await expectCleanClose('close after library changes');

    // 3. Unsaved code shows the normal dialog; "save and continue" writes it.
    await editor().click({ position: { x: 420, y: 65 } }); await win.keyboard.press('Control+Home');
    await win.keyboard.insertText('// case-path edit\n'); await dirty(true);
    await startClose();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('未保存的更改');
    await expect(dialog).not.toContainText('无法确认保存状态');
    await win.screenshot({ path: info.outputPath('unsaved-dialog.png') });
    await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
    await expect.poll(closeDecision).toBe(true);
    await dirty(false);
    expect(await readFile(path.join(project, 'sketch/src/main.cpp'), 'utf8')).toContain('// case-path edit');
    await expectCleanClose('close after dialog save');

    // 4. Menu/shortcut save-all after another edit.
    await editor().click({ position: { x: 420, y: 65 } }); await win.keyboard.press('Control+Home');
    await win.keyboard.insertText('// shortcut save\n'); await dirty(true);
    evidence['saveAll'] = await win.evaluate(async () => {
      const header = (window as any).ng.getComponent(document.querySelector('app-header'));
      try { await header.coderPersistence.saveAllOpenProjects(); return 'ok'; } catch (error) { return String(error); }
    });
    expect(evidence['saveAll']).toBe('ok');
    await dirty(false);
    expect(await readFile(path.join(project, 'sketch/src/main.cpp'), 'utf8')).toContain('// shortcut save');

    // 5. Native quit exits directly.
    await win.screenshot({ path: info.outputPath('before-quit.png') });
    await launch.app.evaluate(({ app }) => { app.quit(); });
    await expect.poll(() => electronProcess.exitCode, { timeout: 30_000 }).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(messages).toEqual([]);
  } finally {
    const logs = path.join(project, '.log');
    evidence['identityErrors'] = existsSync(logs) ? require('node:child_process')
      .spawnSync('rg', ['-c', '-uu', '--no-filename', "Error occurred in handler for 'library-dependencies'", logs], { encoding: 'utf8' }).stdout
      .split('\n').filter(Boolean).reduce((sum: number, count: string) => sum + Number(count), 0) : 'no-log';
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    await launch.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  expect(evidence['identityErrors'], 'only the lower-case control may fail').toBe(1);
});
