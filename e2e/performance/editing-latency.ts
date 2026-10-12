import { expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Profile real input in shallow and deep rows, including deferred host work. */
export async function exerciseEditingLatency(
  page: Page,
  output: string,
  profile: boolean,
) {
  const targets = await page.evaluate(() => {
    const w = window as any,
      ws = w.blocklyWorkspace;
    const root = ws
      .getTopBlocks(false)
      .sort(
        (a, b) =>
          b.getDescendants(false).length - a.getDescendants(false).length,
      )[0];
    const numbers = root
      .getDescendants(false)
      .filter((b) => b.type === 'math_number' && b.isEditable());
    w.editingBeforeSignature = w.signature();
    w.editingBeforeCode = w.realCode();
    return [0.02, 0.5, 0.95].map((fraction) => {
      const block = numbers[Math.floor((numbers.length - 1) * fraction)];
      let depth = 0;
      for (let parent = block.getParent(); parent; parent = parent.getParent())
        depth++;
      return {
        id: block.id,
        value: block.getFieldValue('NUM'),
        depth,
        fraction,
      };
    });
  });
  const frames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const results: any[] = [];
  for (const target of targets) {
    await page.evaluate((id) => {
      const w = window as any,
        ws = w.blocklyWorkspace,
        block = ws.getBlockById(id);
      ws.clearUndo();
      ws.centerOnBlock(id, true);
      w.Blockly.getFocusManager().focusNode(block);
      document
        .querySelectorAll('[data-edit-latency]')
        .forEach((el) => el.removeAttribute('data-edit-latency'));
      block
        .getField('NUM')
        .getClickTarget_()
        .setAttribute('data-edit-latency', 'number');
    }, target.id);
    await frames();
    const cdp = profile ? await page.context().newCDPSession(page) : undefined;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    await page.evaluate(() => {
      const w = window as any;
      w.editingTasks = [];
      w.editingObserver = new PerformanceObserver((list) =>
        w.editingTasks.push(
          ...list
            .getEntries()
            .map((e) => ({ start: e.startTime, duration: e.duration })),
        ),
      );
      w.editingObserver.observe({ entryTypes: ['longtask'] });
    });
    const start = Date.now();
    await page.locator('[data-edit-latency="number"]').click();
    const openMs = Date.now() - start;
    const inputStart = Date.now();
    await page.locator('.blocklyHtmlInput').fill('987654');
    await frames();
    const inputMs = Date.now() - inputStart;
    const commitStart = Date.now();
    await page.locator('.blocklyHtmlInput').press('Enter');
    await frames();
    const commitMs = Date.now() - commitStart;
    // The host debounces code/artifact generation by 500ms. Include that work
    // in the profile/long-task evidence, separately from input response time.
    await page.waitForTimeout(1500);
    const longTasks = await page.evaluate(() => {
      const w = window as any;
      w.editingObserver.disconnect();
      return w.editingTasks;
    });
    if (cdp) {
      const { profile: cpu } = await cdp.send('Profiler.stop');
      await writeFile(
        path.join(output, `edit-depth-${target.depth}.cpuprofile`),
        JSON.stringify(cpu),
      );
      await cdp.detach();
    }
    expect(
      await page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        target.id,
      ),
    ).toBe(987654);
    const undoStart = Date.now();
    await page.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await frames();
    const undoMs = Date.now() - undoStart;
    expect(
      await page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        target.id,
      ),
    ).toBe(target.value);
    await page.evaluate(() => (window as any).blocklyWorkspace.undo(true));
    await frames();
    expect(
      await page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        target.id,
      ),
    ).toBe(987654);
    await page.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await frames();
    const preserved = await page.evaluate(() => {
      const w = window as any;
      return {
        state: w.signature() === w.editingBeforeSignature,
        code: w.realCode() === w.editingBeforeCode,
        geometry: w.geometryMismatches(),
      };
    });
    expect(preserved).toEqual({ state: true, code: true, geometry: 0 });
    results.push({
      ...target,
      openMs,
      inputMs,
      commitMs,
      undoMs,
      longTasks,
      preserved,
    });
    console.log('[editing-latency]', JSON.stringify(results.at(-1)));
  }
  return results;
}
