import { test, expect, getMainWindow, openBlocklyProject } from '../fixtures/electron-app';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Phase 3 —— Blockly 编辑器。
 *
 * 需要一个真实的 Blockly 项目（含 project.abi），并且其依赖的开发板/库包
 * 已安装。通过环境变量 AILY_E2E_PROJECT 指定项目目录的绝对路径，例如：
 *
 *   $env:AILY_E2E_PROJECT = 'D:\\path\\to\\blockly-project'
 *   npm run test:e2e -- blockly-editor.spec.ts
 *
 * 未设置该变量时整套用例自动跳过。
 */
const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];
const SECOND_PROJECT_PATH = process.env['AILY_E2E_PROJECT_SECOND'];
const REMOVAL_LIBRARY = process.env['AILY_E2E_REMOVAL_LIBRARY'] || '@aily-project/lib-async-http';
const REMOVAL_GENERATOR = process.env['AILY_E2E_REMOVAL_GENERATOR'] || 'async_http_get';
const RETAINED_LIBRARY = '@aily-project/lib-core-serial';

test.describe('Blockly 编辑器', () => {
  test.skip(!PROJECT_PATH, '未设置 AILY_E2E_PROJECT，跳过 Blockly 编辑器用例。');

  test('打开项目后应渲染 Blockly 工作区', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, PROJECT_PATH!);

    await expect(win.locator('app-blockly-editor')).toBeVisible({ timeout: 30_000 });
    // 第三方 Blockly 库注入的工作区容器。
    await expect(win.locator('app-blockly-editor .blocklyBox')).toBeVisible({ timeout: 30_000 });
    // 头部应显示已加载项目的名称。
    await expect(win.locator('app-header .project-box')).not.toBeEmpty();
  });

  test('应渲染工具箱', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, PROJECT_PATH!);

    // The native toolbox is intentionally hidden by the external Angular pane.
    // Assert the actual user entry and its flyout, not the hidden native DOM.
    await expect(win.locator('app-blockly-toolbox-pane')).toBeVisible({
      timeout: 30_000,
    });
    const category = win.locator('app-blockly-toolbox-pane .toolbox-item').filter({hasText: /循环|Loop/i}).first();
    await expect(category).toBeVisible({timeout: 30_000});
    await category.click();
    await expect.poll(() => win.evaluate(() => {
      const flyout = (window as any).blocklyWorkspace?.getFlyout();
      return flyout?.isVisible() && flyout.getWorkspace().getAllBlocks(false).length > 0;
    })).toBe(true);
  });

  test('连续打开两个项目时应重建 generator realm', async ({ electronApp }) => {
    test.skip(!SECOND_PROJECT_PATH, '未设置 AILY_E2E_PROJECT_SECOND，跳过项目切换隔离用例。');
    const win = await getMainWindow(electronApp);
    const pageErrors: string[] = [];
    win.on('pageerror', (error) => pageErrors.push(error.message));

    const readRuntime = () => win.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]');
      const realm = iframe?.contentWindow as any;
      const generator = realm?.Arduino || realm?.MPY || realm?.MicropPython;
      return {
        epoch: iframe?.getAttribute('data-blockly-generator-runtime') || '',
        ready: iframe?.getAttribute('data-runtime-ready') === 'true',
        projectPath: iframe?.getAttribute('data-runtime-project-path') || '',
        generatorCount: generator?.forBlock ? Object.keys(generator.forBlock).length : 0,
      };
    });
    const generateCurrentCode = () => win.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]');
      const realm = iframe?.contentWindow as any;
      const generator = realm?.Arduino || realm?.MPY || realm?.MicropPython;
      const workspace = realm?.Blockly?.getMainWorkspace?.();
      return typeof generator?.workspaceToCode === 'function' && workspace
        ? String(generator.workspaceToCode(workspace) || '')
        : '';
    });

    await openBlocklyProject(win, PROJECT_PATH!);
    await expect.poll(async () => (await readRuntime()).ready, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await readRuntime()).projectPath, { timeout: 60_000 }).toBe(PROJECT_PATH);
    const firstRuntime = await readRuntime();
    expect((await generateCurrentCode()).length).toBeGreaterThan(0);

    await openBlocklyProject(win, SECOND_PROJECT_PATH!);
    await expect.poll(async () => (await readRuntime()).epoch, { timeout: 60_000 }).not.toBe(firstRuntime.epoch);
    await expect.poll(async () => (await readRuntime()).ready, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await readRuntime()).projectPath, { timeout: 60_000 }).toBe(SECOND_PROJECT_PATH);
    expect((await readRuntime()).generatorCount).toBeGreaterThan(0);
    expect((await generateCurrentCode()).length).toBeGreaterThan(0);
    await expect(win.locator('app-blockly-editor .blocklyBox')).toBeVisible();

    expect(pageErrors.filter((message) => /already been declared|generator runtime|generator loading failed/i.test(message))).toEqual([]);
  });

  test('移除未使用库后应原地重建 runtime 且不重载编辑器', async ({ electronApp }) => {
    const sourceLibraryPath = path.join(PROJECT_PATH!, 'node_modules', ...REMOVAL_LIBRARY.split('/'));
    test.skip(!existsSync(sourceLibraryPath), `测试项目未安装 ${REMOVAL_LIBRARY}。`);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-library-removal-'));
    const projectPath = path.join(tempRoot, 'project');
    await cp(PROJECT_PATH!, projectPath, { recursive: true });

    const win = await getMainWindow(electronApp);
    const runtimeErrors: string[] = [];
    win.on('pageerror', (error) => {
      if (/Blockly generator session .* is inactive/i.test(error.message)) {
        runtimeErrors.push(error.message);
      }
    });
    win.on('console', (message) => {
      if (message.type() === 'error' && /Blockly generator session .* is inactive/i.test(message.text())) {
        runtimeErrors.push(message.text());
      }
    });
    const rendererRealmMarker = `library-removal-${Date.now()}`;
    const readRendererIdentity = () => win.evaluate(() => ({
      marker: (window as any).__ailyLibraryRemovalRendererRealmMarker || '',
      timeOrigin: window.performance.timeOrigin,
      sameEditorElement: (window as any).__ailyLibraryRemovalEditorElement
        === document.querySelector('app-blockly-editor'),
      sameWorkspaceElement: (window as any).__ailyLibraryRemovalWorkspaceElement
        === document.querySelector('app-blockly-editor .blocklyBox'),
    }));
    const readRuntime = () => win.evaluate(removedGenerator => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]');
      const realm = iframe?.contentWindow as any;
      const generator = realm?.Arduino || realm?.MPY || realm?.MicropPython;
      const workspace = realm?.Blockly?.getMainWorkspace?.();
      return {
        id: iframe?.getAttribute('data-blockly-generator-runtime') || '',
        ready: iframe?.getAttribute('data-runtime-ready') === 'true',
        projectPath: iframe?.getAttribute('data-runtime-project-path') || '',
        hasRemovedLibraryGenerator: typeof generator?.forBlock?.[removedGenerator] === 'function',
        generatedCode: typeof generator?.workspaceToCode === 'function' && workspace
          ? String(generator.workspaceToCode(workspace) || '')
          : '',
      };
    }, REMOVAL_GENERATOR);
    const readWorkspaceProgram = () => win.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]');
      const blockly = (iframe?.contentWindow as any)?.Blockly;
      const workspace = blockly?.getMainWorkspace?.();
      return workspace ? blockly.serialization.workspaces.save(workspace) : null;
    });
    const readToolboxOrder = () => win.locator(
      'app-blockly-toolbox-pane .toolbox-list > .toolbox-node',
    ).evaluateAll((nodes) => nodes
      .map((node) => node.getAttribute('data-toolbox-sort-key') || '')
      .filter((key) => key.startsWith('@aily-project/lib-')));

    try {
      await openBlocklyProject(win, projectPath);
      await expect.poll(async () => (await readRuntime()).ready, { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await readRuntime()).projectPath, { timeout: 60_000 }).toBe(projectPath);
      // Unused libraries load their generator when the real toolbox category
      // is opened. Exercise that path before verifying cache invalidation.
      await win.locator(`.toolbox-node[data-toolbox-sort-key="${REMOVAL_LIBRARY}"] > .toolbox-row > button.toolbox-item`).click();
      await expect.poll(async () => (await readRuntime()).hasRemovedLibraryGenerator).toBe(true);
      await win.clock.install();
      // Renderer clock time advances independently from the runner's wall
      // clock. Pause using its own future time, before capturing the baseline.
      await win.clock.pauseAt(new Date(await win.evaluate(() => Date.now()) + 10_000));
      const firstRuntime = await readRuntime();
      const workspaceBeforeRemoval = await readWorkspaceProgram();
      const toolboxOrderBeforeRemoval = await readToolboxOrder();
      expect(firstRuntime.hasRemovedLibraryGenerator).toBe(true);
      expect(toolboxOrderBeforeRemoval).toContain(REMOVAL_LIBRARY);
      await win.evaluate((marker) => {
        (window as any).__ailyLibraryRemovalRendererRealmMarker = marker;
        (window as any).__ailyLibraryRemovalEditorElement = document.querySelector('app-blockly-editor');
        (window as any).__ailyLibraryRemovalWorkspaceElement = document.querySelector('app-blockly-editor .blocklyBox');
      }, rendererRealmMarker);
      const rendererBeforeRemoval = await readRendererIdentity();

      // Pause renderer timers while npm runs so its debounced watcher cannot
      // rebuild before the retained-package outage is established.
      const retainedLibraryPath = path.join(projectPath, 'node_modules', ...RETAINED_LIBRARY.split('/'));
      // Keep the moved package outside node_modules: the scanner correctly
      // recognizes package.json names even if its folder has a temporary suffix.
      const transientLibraryPath = path.join(tempRoot, 'retained-library-transient');
      expect(existsSync(retainedLibraryPath)).toBe(true);

      execFileSync('npm', [
        'uninstall',
        REMOVAL_LIBRARY,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--@aily-project:registry=https://registry.yiyu.pro',
      ], { cwd: projectPath, stdio: 'pipe' });

      // npm may temporarily move/recreate unrelated packages while it updates
      // node_modules. The removal watcher must keep the current workspace intact
      // until every retained library is readable again.
      await rename(retainedLibraryPath, transientLibraryPath);
      await win.clock.resume();
      await win.waitForTimeout(2_000);
      expect((await readRuntime()).id).toBe(firstRuntime.id);
      expect(await readWorkspaceProgram()).toEqual(workspaceBeforeRemoval);
      await rename(transientLibraryPath, retainedLibraryPath);

      await expect.poll(async () => (await readRuntime()).id, { timeout: 60_000 }).not.toBe(firstRuntime.id);
      await expect.poll(async () => (await readRuntime()).ready, { timeout: 60_000 }).toBe(true);
      const rebuiltRuntime = await readRuntime();
      const rendererAfterRemoval = await readRendererIdentity();
      expect(rebuiltRuntime.hasRemovedLibraryGenerator).toBe(false);
      expect(rebuiltRuntime.generatedCode.length).toBeGreaterThan(0);
      expect(await readWorkspaceProgram()).toEqual(workspaceBeforeRemoval);
      expect(existsSync(path.join(projectPath, 'node_modules', ...REMOVAL_LIBRARY.split('/')))).toBe(false);
      expect(rendererAfterRemoval).toEqual(rendererBeforeRemoval);
      expect(await readToolboxOrder()).toEqual(
        toolboxOrderBeforeRemoval.filter((libraryName) => libraryName !== REMOVAL_LIBRARY),
      );
      expect(runtimeErrors).toEqual([]);
    } finally {
      await win.evaluate(() => { window.location.hash = '#/main/guide'; }).catch(() => undefined);
      await win.waitForTimeout(100);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
