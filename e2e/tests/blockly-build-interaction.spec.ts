import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const SOURCE = process.env['AILY_E2E_PROJECT'];

test('build capture and compile-error notices do not cancel active Blockly interaction', async ({}, testInfo) => {
  test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed Blockly project.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-build-interaction-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, { recursive: true, filter: source => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(source)) });
  const launched = await launchAilyElectron({ config: { blocklyOnboardingCompleted: true } });
  const win = await getMainWindow(launched.app);
  try {
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
    await win.waitForTimeout(1500);
    await win.evaluate(() => {
      const w = window as any, ws = w.blocklyWorkspace, B = w.Blockly;
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const builder = [...realm.projectService.injector.records.values()].map((record: any) => record?.value)
        .find(value => typeof value?.generateWorkspaceBuildSnapshotForPreprocess === 'function');
      if (!builder) throw new Error('The Blockly builder is unavailable.');
      w.__buildProbe = { builder, cancellations: [], captured: false, error: null };
      const original = ws.cancelCurrentGesture;
      ws.cancelCurrentGesture = function (...args) {
        w.__buildProbe.cancellations.push({ dragging: ws.isDragging(), stack: new Error().stack });
        return original.apply(this, args);
      };
      B.Blocks.build_interaction_probe = { init() {
        this.appendDummyInput().appendField('build probe').appendField(new B.FieldTextInput('initial'), 'TEXT');
        this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(170);
      } };
      realm.Arduino.forBlock.build_interaction_probe = block => {
        realm.Arduino.addSetup('build_interaction_probe', `// ${block.getFieldValue('TEXT')}\n`); return '';
      };
      const block = ws.newBlock('build_interaction_probe', 'build-probe'); block.initSvg(); block.render(); block.moveBy(1500, 1500);
      block.getSvgRoot().setAttribute('data-build-probe', 'block');
      block.getField('TEXT').getClickTarget_().setAttribute('data-build-probe', 'field');
      ws.centerOnBlock(block.id);
    });
    const beginDrag = async () => {
      const box = await win.locator('[data-build-probe="block"] .blocklyText').first().boundingBox();
      if (!box) throw new Error('Build probe is not rendered.');
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await win.mouse.down();
      await win.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    };
    // Exercise the real error handler, including details, error styling and log
    // publication. A plain progress notification does not cover this path.
    await beginDrag();
    await win.evaluate(() => (window as any).__buildProbe.builder.handleCompileError(
      'BUILD_SOURCE_STALE: Workspace changed after code capture; build again.', true));
    await expect(win.locator('.notification-box .text')).toContainText('BUILD_SOURCE_STALE');
    await win.screenshot({ path: testInfo.outputPath('stale-notice-during-drag.png') });
    await win.waitForTimeout(1300);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.mouse.up();

    // A build can wait for SDK/resources before reaching source capture. Start
    // that actual source-capture boundary after the next gesture has begun.
    await beginDrag();
    await win.evaluate(() => {
      const w = window as any, probe = w.__buildProbe;
      probe.promise = probe.builder.generateWorkspaceBuildSnapshotForPreprocess(w.blocklyWorkspace, 'interaction-regression')
        .then(snapshot => { probe.snapshot = snapshot; probe.captured = true; }, error => { probe.error = error.message; });
    });
    await win.waitForTimeout(1300);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    expect(await win.evaluate(() => (window as any).__buildProbe.captured)).toBe(false);
    await win.mouse.up();
    await expect.poll(() => win.evaluate(() => ({ captured: (window as any).__buildProbe.captured, error: (window as any).__buildProbe.error })))
      .toEqual({ captured: true, error: null });

    // The source-freshness safety check still rejects a real edit after capture.
    // Its exact error notification must not cancel the *new* gesture either.
    await beginDrag();
    expect(await win.evaluate(() => {
      const w = window as any, probe = w.__buildProbe;
      w.blocklyWorkspace.getBlockById('build-probe').setFieldValue('changed after capture', 'TEXT');
      try { probe.snapshot.assertFresh(); return false; }
      catch (error) { probe.builder.handleCompileError(error.message, true); return error.message.startsWith('BUILD_SOURCE_STALE:'); }
    })).toBe(true);
    await win.waitForTimeout(1300);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.mouse.up();

    // Background dependency preprocessing uses the same non-interrupting read.
    // Exercise its actual code-publication entry while a field is still open.
    await win.locator('[data-build-probe="field"]').click();
    const input = win.locator('.blocklyHtmlInput'); await input.fill('preprocess input');
    await win.evaluate(() => {
      const w = window as any, probe = w.__buildProbe;
      probe.preprocessCode = null;
      probe.preprocess = probe.builder.generateWorkspaceCodeForPreprocess(w.blocklyWorkspace, 'background_preprocess')
        .then(code => { probe.preprocessCode = code; });
      probe.builder.handleCompileError('BUILD_SOURCE_STALE: Workspace changed after code capture; build again.', true);
    });
    await expect(win.locator('.notification-box .text')).toContainText('BUILD_SOURCE_STALE');
    await expect(input).toBeFocused();
    await win.screenshot({ path: testInfo.outputPath('stale-notice-during-input.png') });
    await win.waitForTimeout(1300); await expect(input).toBeFocused();
    expect(await win.evaluate(() => (window as any).__buildProbe.preprocessCode)).toBeNull();
    await input.press('Enter');
    await expect.poll(() => win.evaluate(() => (window as any).__buildProbe.preprocessCode)).toContain('preprocess input');
    expect(await win.evaluate(() => (window as any).__buildProbe.cancellations)).toEqual([]);
    await testInfo.attach('build-interaction', { contentType: 'application/json', body: JSON.stringify(await win.evaluate(() => ({
      captured: (window as any).__buildProbe.captured, cancellations: (window as any).__buildProbe.cancellations,
    }))) });
  } catch (error) {
    console.log('[build-interaction-failure]', await win.evaluate(() => ({
      cancellations: (window as any).__buildProbe?.cancellations, error: (window as any).__buildProbe?.error,
    })));
    await win.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
    throw error;
  } finally {
    await launched.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
