import { expect, type Page } from '@playwright/test';

/** A real installed library callback, native dropdown and live SVG renderer. */
export async function exerciseSerialRefresh(page: Page) {
  const before = await page.evaluate(() => {
    const w = window as any,
      ws = w.blocklyWorkspace;
    const realm = (
      document.querySelector(
        'iframe[data-blockly-generator-runtime]',
      ) as HTMLIFrameElement
    ).contentWindow as any;
    const blocks = ws.getAllBlocks(false).filter((b) => b.getField('SERIAL'));
    if (!blocks.length || !realm.updateSerialCustomPorts)
      throw Error('Missing real serial library');
    w.serialBaseline = w.signature();
    w.serialCode = w.realCode();
    let renders = 0;
    const original = w.Blockly.BlockSvg.prototype.render;
    w.Blockly.BlockSvg.prototype.render = function (...args) {
      renders++;
      return original.apply(this, args);
    };
    const start = performance.now();
    try {
      for (let i = 0; i < 20; i++) realm.updateSerialCustomPorts();
    } finally {
      w.Blockly.BlockSvg.prototype.render = original;
    }
    const block = blocks.find((b) =>
      realm.boardConfig.serialPortOriginal.some(
        ([, value]) => value === b.getFieldValue('SERIAL'),
      ),
    );
    if (!block) throw Error('Missing default serial selection');
    w.serialTestId = block.id;
    const field = block.getField('SERIAL');
    w.serialOriginalPorts = realm.boardConfig.serialPortOriginal;
    w.serialOriginalPins = realm.boardConfig.serialPins;
    w.serialOldLabel = field.getText();
    w.serialOldValue = field.getValue();
    return {
      count: blocks.length,
      repeatMs: performance.now() - start,
      synchronousRenders: renders,
    };
  });
  expect(before.synchronousRenders).toBe(0);
  await page.evaluate(async () => {
    const w = window as any,
      ws = w.blocklyWorkspace;
    const realm = (
      document.querySelector(
        'iframe[data-blockly-generator-runtime]',
      ) as HTMLIFrameElement
    ).contentWindow as any;
    ws.centerOnBlock(w.serialTestId, true);
    const field = ws.getBlockById(w.serialTestId).getField('SERIAL');
    w.Blockly.getFocusManager().focusNode(ws.getBlockById(w.serialTestId));
    // Rename only the board's display label; the language-neutral value and
    // generated code must stay unchanged. Restore both config and UI below.
    realm.boardConfig.serialPins = undefined;
    realm.boardConfig.serialPortOriginal = w.serialOriginalPorts.map(
      ([label, value]) => [
        value === w.serialOldValue ? 'Serial display regression' : label,
        value,
      ],
    );
    realm.updateSerialCustomPorts();
    await w.Blockly.renderManagement.finishQueuedRenders();
    field.getClickTarget_().setAttribute('data-serial-refresh', 'target');
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const changed = await page.evaluate(() => {
    const w = window as any,
      f = w.blocklyWorkspace.getBlockById(w.serialTestId).getField('SERIAL');
    return {
      label: f.getText(),
      value: f.getValue(),
      expectedValue: w.serialOldValue,
      geometry: w.geometryMismatches(),
      mismatches: w.blocklyWorkspace
        .getAllBlocks(false)
        .filter((b) => b.getSvgRoot().isConnected)
        .flatMap((b) => {
          const xy = b.getRelativeToSurfaceXY(),
            m = b.getSvgRoot().getCTM(),
            c = w.blocklyWorkspace.getCanvas().getCTM();
          if (
            Math.abs(m.e - c.e - c.a * xy.x) < 0.1 &&
            Math.abs(m.f - c.f - c.d * xy.y) < 0.1
          )
            return [];
          return [
            {
              id: b.id,
              type: b.type,
              xy,
              root: b.getRootBlock().id,
              parent: b.getParent()?.id,
              transform: b.getSvgRoot().getAttribute('transform'),
              actual: [m.e, m.f],
              expected: [c.e + c.a * xy.x, c.f + c.d * xy.y],
            },
          ];
        }),
    };
  });
  console.log('[serial-refresh]', JSON.stringify({ before, changed }));
  expect(changed.label).toBe('Serial display regression');
  expect(changed.value).toBe(changed.expectedValue);
  expect(changed.geometry).toBe(0);
  await page.locator('[data-serial-refresh="target"]').click();
  const option = page.getByRole('option', {
    name: 'Serial display regression',
    exact: true,
  });
  await expect(option).toBeVisible();
  await option.click();
  const restored = await page.evaluate(async () => {
    const w = window as any;
    const realm = (
      document.querySelector(
        'iframe[data-blockly-generator-runtime]',
      ) as HTMLIFrameElement
    ).contentWindow as any;
    realm.boardConfig.serialPortOriginal = w.serialOriginalPorts;
    realm.boardConfig.serialPins = w.serialOriginalPins;
    realm.updateSerialCustomPorts();
    await w.Blockly.renderManagement.finishQueuedRenders();
    return {
      state: w.signature() === w.serialBaseline,
      code: w.realCode() === w.serialCode,
      label:
        w.blocklyWorkspace
          .getBlockById(w.serialTestId)
          .getField('SERIAL')
          .getText() === w.serialOldLabel,
      geometry: w.geometryMismatches(),
    };
  });
  expect(restored).toEqual({
    state: true,
    code: true,
    label: true,
    geometry: 0,
  });
  return { ...before, changed, restored };
}
