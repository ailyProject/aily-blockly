import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
const libraries = process.env['AILY_E2E_LIBRARIES'];
const dialogSelector = 'app-image-upload-dialog';

async function preview(win: Page) {
  return win.locator(`${dialogSelector} canvas[result]`).evaluate((canvas: HTMLCanvasElement) => {
    if (!canvas.width || !canvas.height) return { width: canvas.width, height: canvas.height, black: 0, white: 0, checksum: 0, nonBinary: 0 };
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let black = 0, white = 0, checksum = 0, nonBinary = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) { if (pixels[i] < 128) black++; else white++; }
      checksum = (checksum + pixels[i] * (i + 1)) >>> 0;
      if (pixels[i + 3] && pixels[i] !== 0 && pixels[i] !== 255) nonBinary++;
    }
    return { width: canvas.width, height: canvas.height, black, white, checksum, nonBinary };
  });
}

async function openField(win: Page) {
  await win.evaluate(() => {
    const field = (window as any).blocklyWorkspace.getBlockById('cropper-bitmap').getField('CUSTOM_BITMAP');
    field.getSvgRoot().setAttribute('data-e2e-crop-field', 'true');
  });
  await win.locator('[data-e2e-crop-field] image').click();
  await win.getByRole('button', { name: /Upload|上传/, exact: true }).click();
  await expect(win.locator(dialogSelector)).toBeVisible();
}

// Run with AILY_E2E_PROJECT (installed Arduino project) and AILY_E2E_LIBRARIES
// (library sources). All edits, bitmap persistence and appdata stay in temp dirs.
test('image cropper: reselect, crop, options, confirm and reopen (#738)', async ({}, info) => {
  test.setTimeout(120_000);
  test.skip(!source || !libraries, 'Set AILY_E2E_PROJECT and AILY_E2E_LIBRARIES.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-cropper-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  const pkg = JSON.parse(await readFile(path.join(source!, 'package.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => /lib-core-|board-/.test(name)));
  for (const name of Object.keys(dependencies)) {
    await cp(path.join(source!, 'node_modules', name), path.join(project, 'node_modules', name), { recursive: true, dereference: true });
  }
  const lib = JSON.parse(await readFile(path.join(libraries!, 'u8g2', 'package.json'), 'utf8'));
  dependencies[lib.name] = lib.version;
  await cp(path.join(libraries!, 'u8g2'), path.join(project, 'node_modules', lib.name), { recursive: true, dereference: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'cropper-regression', version: '1.0.0', board: pkg.board, devmode: 'arduino', dependencies }));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({ blocks: { languageVersion: 0, blocks: [
    { type: 'arduino_global', id: 'global', x: 30, y: 60 },
    { type: 'arduino_setup', id: 'setup', x: 30, y: 180 },
    { type: 'arduino_loop', id: 'loop', x: 30, y: 300 },
    { type: 'u8g2_bitmap', id: 'cropper-bitmap', x: 350, y: 100 }
  ] } }));
  const launched = await launchAilyElectron();
  const win = await getMainWindow(launched.app);
  // A fresh, signed-out profile can show login/onboarding again on reload.
  await win.addLocatorHandler(win.locator('.login-modal-wrap'), async overlay => {
    await overlay.locator('.login-close').click();
  });
  await win.addLocatorHandler(win.locator('app-onboarding .btn-skip'), async skip => {
    await skip.click();
  });
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  try {
    await openBlocklyProject(win, project);
    await win.waitForFunction(() => !!(window as any).blocklyWorkspace?.getBlockById('cropper-bitmap'));
    await expect(win.locator('.blockly-spin')).toBeHidden();
    const images = await win.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      const result: Record<string, string> = {};
      for (const color of ['white', 'black', 'checker']) {
        ctx.fillStyle = color === 'black' ? 'black' : 'white'; ctx.fillRect(0, 0, 256, 128);
        if (color === 'checker') for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
          ctx.fillStyle = (x + y) % 2 ? 'white' : 'black'; ctx.fillRect(x * 32, y * 32, 32, 32);
        }
        for (const format of ['png', 'jpeg', 'webp']) result[`${color}.${format}`] = canvas.toDataURL(`image/${format}`).split(',')[1];
      }
      return result;
    });
    const upload = (name: string) => win.locator(`${dialogSelector} input[type=file]`).setInputFiles({ name, mimeType: `image/${name.split('.')[1]}`, buffer: Buffer.from(images[name], 'base64') });
    const ready = async () => {
      await expect(win.locator(`${dialogSelector} .loading`)).toBeHidden();
      await expect(win.locator(`${dialogSelector} .cropper-container`)).toHaveCount(1);
      await expect(win.locator(`${dialogSelector} .right-text`)).toHaveText('128 × 64');
      await expect(win.locator(dialogSelector).getByRole('button', { name: '确定', exact: true })).toBeEnabled();
    };
    await openField(win);
    await expect(win.locator(dialogSelector).getByRole('button', { name: '确定', exact: true })).toBeDisabled();
    await upload('checker.png'); await upload('white.png'); // overlapping native FileReader/image loads
    await ready();
    await expect.poll(async () => (await preview(win)).white).toBe(128 * 64);
    const reselectMs: number[] = [];
    for (let i = 0; i < 12; i++) {
      const color = i % 2 ? 'white' : 'black', format = ['png', 'jpeg', 'webp'][i % 3];
      const start = Date.now();
      await upload(`${color}.${format}`); await ready();
      await expect.poll(async () => (await preview(win))[color]).toBe(128 * 64);
      reselectMs.push(Date.now() - start);
    }
    await upload('checker.png'); await ready();
    await expect.poll(async () => (await preview(win)).black).toBeGreaterThan(1000);
    // Wait for the worker's monochrome result, not the intermediate resized
    // source image, whose anti-aliased edges still contain gray pixels.
    await expect.poll(async () => (await preview(win)).nonBinary).toBe(0);
    const original = await preview(win);
    const crop = win.locator(`${dialogSelector} .cropper-face`);
    const rect = (await crop.boundingBox())!;
    await win.mouse.move(rect.x + 40, rect.y + 40); await win.mouse.down();
    await win.mouse.move(rect.x + 75, rect.y + 55, { steps: 8 }); await win.mouse.up();
    await expect.poll(async () => (await preview(win)).checksum).not.toBe(original.checksum);
    const moved = await preview(win);
    await win.mouse.wheel(0, -160);
    await expect.poll(async () => (await preview(win)).checksum).not.toBe(moved.checksum);
    await win.locator(`${dialogSelector} button[title="重置图片位置和缩放"]`).click();
    await expect.poll(async () => (await preview(win)).checksum).toBe(original.checksum);
    const switches = win.locator(`${dialogSelector} nz-switch button`);
    const optionStart = Date.now();
    await switches.nth(0).click();
    await expect.poll(async () => (await preview(win)).checksum).not.toBe(original.checksum);
    const invertMs = Date.now() - optionStart;
    await switches.nth(1).click();
    await expect(win.locator(`${dialogSelector} nz-input-number`)).toBeHidden();
    await switches.nth(1).click();
    await win.locator(`${dialogSelector} nz-input-number input`).fill('180');
    await win.locator(`${dialogSelector} nz-input-number input`).press('Tab');
    await win.screenshot({ path: info.outputPath('crop-preview.png') });
    // Set black, then immediately confirm after changing invert: confirmation
    // must flush the pending preview, not return pixels from the last worker.
    await upload('black.png'); await ready();
    await expect.poll(async () => (await preview(win)).white).toBe(128 * 64); // invert still on
    await switches.nth(0).click();
    await win.locator(dialogSelector).getByRole('button', { name: '确定', exact: true }).click();
    await expect(win.locator(dialogSelector)).toHaveCount(0);
    const bitmapState = () => win.evaluate(async () => {
      const f = (window as any).blocklyWorkspace.getBlockById('cropper-bitmap').getField('CUSTOM_BITMAP');
      await f.ensureBitmapLoaded();
      return { width: f.getImageWidth(), height: f.getImageHeight(), ones: f.resolvedBitmap.flat().reduce((a: number, b: number) => a + b, 0) };
    });
    await expect.poll(bitmapState).toEqual({ width: 128, height: 64, ones: 8192 });
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(async () => await readFile(path.join(project, 'project.abi'), 'utf8')).toContain('CUSTOM_BITMAP');
    await win.reload();
    await win.waitForFunction(() => !!(window as any).blocklyWorkspace?.getBlockById('cropper-bitmap'));
    await expect(win.locator('.blockly-spin')).toBeHidden();
    await expect.poll(bitmapState).toEqual({ width: 128, height: 64, ones: 8192 });
    await openField(win);
    await win.locator(`${dialogSelector} input[type=file]`).setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
    await expect(win.getByText('图片加载失败', { exact: true })).toBeVisible();
    await expect(win.locator(`${dialogSelector} .empty-tip`)).toBeVisible();
    await upload('black.png'); await ready();
    await expect.poll(async () => (await preview(win)).black).toBe(128 * 64);
    await upload('black.png'); await ready(); // same file can be selected again
    await win.locator(dialogSelector).getByRole('button', { name: '取消', exact: true }).click();
    await expect(win.locator('.cropper-container')).toHaveCount(0);
    await expect.poll(bitmapState).toEqual({ width: 128, height: 64, ones: 8192 });
    expect(errors.filter(error => /drawImage|裁剪|Bitmap conversion/.test(error))).toEqual([]);
    await expect(win.getByText(/NaN × NaN|Failed to execute 'drawImage'/)).toHaveCount(0);
    await expect(win.locator('.ant-modal-wrap')).toHaveCount(0);
    await expect(win.getByText('图片加载失败', { exact: true })).toBeHidden();
    await win.screenshot({ path: info.outputPath('saved-bitmap.png') });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ reselectMs, invertMs, errors, persisted: await bitmapState(), formats: ['png', 'jpeg', 'webp'], validFileSelections: 18 }, null, 2));
  } catch (error) {
    await win.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    throw error;
  } finally {
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});
