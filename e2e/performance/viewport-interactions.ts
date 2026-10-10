import { expect, type Page } from '@playwright/test';

/** Exercise the complete real model while views leave/re-enter the live SVG. */
export async function exerciseViewport(page: Page) {
  const report: any = { views: [] };
  await page.evaluate(async () => {
    const w = window as any,
      B = w.Blockly,
      ws = w.blocklyWorkspace;
    // Begin panning from workspace focus, as a background gesture would. A
    // previous block's queued native focus-scroll can otherwise race the zoom.
    B.getFocusManager().focusNode(ws.getRootFocusableNode());
    await B.renderManagement.finishQueuedRenders();
    w.viewportBaseline = JSON.stringify(B.serialization.workspaces.save(ws));
    w.viewportCode = w.realCode();
    w.viewportRoot = ws
      .getTopBlocks(false)
      .sort(
        (a, b) =>
          b.getDescendants(false).length - a.getDescendants(false).length,
      )[0].id;
    w.checkViewport = () => {
      const view = ws.getMetricsManager().getViewMetrics(true),
        canvas = ws.getCanvas().getCTM();
      let missing = 0,
        incorrect = 0,
        mounted = 0;
      for (const block of ws.getAllBlocks(false)) {
        const bounds = block.getBoundingRectangleWithoutChildren();
        if (
          bounds.right >= view.left &&
          bounds.left <= view.left + view.width &&
          bounds.bottom >= view.top &&
          bounds.top <= view.top + view.height
        ) {
          let visible = true;
          for (let node = block; node; node = node.getParent())
            if (node.getSvgRoot().style.display === 'none') {
              visible = false;
              break;
            }
          if (visible && !block.getSvgRoot().isConnected) missing++;
        }
        if (!block.getSvgRoot().isConnected) continue;
        mounted++;
        const point = block.getRelativeToSurfaceXY(),
          matrix = block.getSvgRoot().getCTM();
        if (
          !matrix ||
          Math.abs(matrix.e - canvas.e - canvas.a * point.x) > 0.1 ||
          Math.abs(matrix.f - canvas.f - canvas.d * point.y) > 0.1
        )
          incorrect++;
      }
      return {
        missing,
        incorrect,
        mounted,
        count: ws.getAllBlocks(false).length,
      };
    };
  });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  for (const [fraction, scale] of [
    [0, 1],
    [0.25, 1],
    [0.5, 0.5],
    [0.75, 1.5],
    [1, 1],
    [0, 1],
  ]) {
    await page.evaluate(
      ({ fraction, scale }) => {
        const w = window as any,
          ws = w.blocklyWorkspace,
          root = ws.getBlockById(w.viewportRoot);
        const bounds = root.getBoundingRectangle();
        ws.setScale(scale);
        ws.scroll(
          240 - bounds.left * scale,
          100 -
            (bounds.top + (bounds.bottom - bounds.top - 700) * fraction) *
              scale,
        );
      },
      { fraction, scale },
    );
    await settle();
    const state = await page.evaluate(() => (window as any).checkViewport());
    report.views.push({ fraction, scale, ...state });
    expect(state.missing).toBe(0);
    expect(state.incorrect).toBe(0);
    expect(state.count).toBe(8265);
    expect(state.mounted).toBeLessThan(600);
  }
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return (
        w.realCode() === w.viewportCode &&
        JSON.stringify(
          w.Blockly.serialization.workspaces.save(w.blocklyWorkspace),
        ) === w.viewportBaseline
      );
    }),
  ).toBe(true);
  report.panZoomPreserved = true;

  // Measure a sustained real pointer gesture without a CPU profiler/trace.
  const rootPoint = await page.evaluate(() => {
    const w = window as any,
      block = w.blocklyWorkspace.getBlockById(w.viewportRoot);
    const rect = block.pathObject.svgPath.getBoundingClientRect();
    const candidates = [
      [8, 20],
      [4, 24],
      [5, 30],
      [40, 8],
    ].map(([x, y]) => ({ x: rect.x + x, y: rect.y + y }));
    // Other root stacks can overlap the header after native neighbour bumps.
    // Locate an exposed part of the same path; never force a covered click.
    for (
      let y = Math.max(rect.y + 40, 64);
      y < Math.min(rect.bottom, innerHeight - 32);
      y += 20
    ) {
      for (const x of [8, 20, 40, 60]) candidates.push({ x: rect.x + x, y });
    }
    return candidates.find(
      (p) => document.elementFromPoint(p.x, p.y) === block.pathObject.svgPath,
    );
  });
  if (!rootPoint)
    console.log(
      '[viewport pointer diagnostic]',
      await page.evaluate(() => {
        const w = window as any,
          ws = w.blocklyWorkspace,
          block = ws.getBlockById(w.viewportRoot);
        return {
          rect: block.pathObject.svgPath.getBoundingClientRect().toJSON(),
          xy: block.getRelativeToSurfaceXY(),
          bounds: block.getBoundingRectangle(),
          metrics: ws.getMetricsManager().getViewMetrics(true),
          scroll: [ws.scrollX, ws.scrollY],
          focus: w.Blockly.getFocusManager().getFocusedNode()?.id,
          scrollIntoView: w.scrollIntoView,
        };
      }),
    );
  expect(rootPoint).toBeTruthy();
  const rootStart = rootPoint!;
  const rootBefore = await page.evaluate(() => {
    const w = window as any;
    return {
      ...w.blocklyWorkspace
        .getBlockById(w.viewportRoot)
        .getRelativeToSurfaceXY(),
    };
  });
  await page.mouse.move(rootStart.x, rootStart.y);
  const beginDrag = Date.now();
  await page.mouse.down();
  await page.mouse.move(rootStart.x + 20, rootStart.y + 10);
  await settle();
  const startMs = Date.now() - beginDrag;
  expect(
    await page.evaluate(() => (window as any).blocklyWorkspace.isDragging()),
  ).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.steadyFrames = [];
    w.steadyRunning = true;
    let previous = performance.now();
    const sample = (now: number) => {
      if (!w.steadyRunning) return;
      w.steadyFrames.push(now - previous);
      previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let step = 1; step <= 45; step++) {
    await page.mouse.move(rootStart.x + 20 + step * 4, rootStart.y + 10 + step);
    await page.waitForTimeout(16);
  }
  const frames = await page.evaluate(() => {
    const w = window as any;
    w.steadyRunning = false;
    return w.steadyFrames as number[];
  });
  const releaseStart = Date.now();
  await page.mouse.up();
  await settle();
  const releaseMs = Date.now() - releaseStart;
  const rootAfter = await page.evaluate(() => {
    const w = window as any,
      ws = w.blocklyWorkspace;
    return {
      ...ws.getBlockById(w.viewportRoot).getRelativeToSurfaceXY(),
      dragging: ws.isDragging(),
      gesture: !!ws.currentGesture_,
    };
  });
  expect(rootAfter.x - rootBefore.x).toBeCloseTo(200, 0);
  expect(rootAfter.y - rootBefore.y).toBeCloseTo(55, 0);
  expect(rootAfter.dragging).toBe(false);
  expect(rootAfter.gesture).toBe(false);
  const sorted = [...frames].sort((a, b) => a - b);
  report.sustainedDrag = {
    startMs,
    releaseMs,
    displacement: {
      x: rootAfter.x - rootBefore.x,
      y: rootAfter.y - rootBefore.y,
    },
    frames,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
  expect(frames.length).toBeGreaterThan(30);
  expect(
    (await page.evaluate(() => (window as any).checkViewport())).incorrect,
  ).toBe(0);
  expect(
    await page.evaluate(() => {
      const w = window as any;
      return w.realCode() === w.viewportCode;
    }),
  ).toBe(true);

  // Edit a real numeric field, including undo/redo while its view is offscreen.
  const number = await page.evaluate(() => {
    const w = window as any,
      ws = w.blocklyWorkspace;
    const block = ws
      .getAllBlocks(false)
      .find((b) => b.type === 'math_number' && b.isEditable());
    ws.centerOnBlock(block.id, true);
    w.Blockly.getFocusManager().focusNode(block);
    block
      .getField('NUM')
      .getClickTarget_()
      .setAttribute('data-viewport-field', 'number');
    return { id: block.id, value: block.getFieldValue('NUM') };
  });
  await settle();
  await page.locator('[data-viewport-field="number"]').click();
  await page.locator('.blocklyHtmlInput').fill('987');
  await page.locator('.blocklyHtmlInput').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        number.id,
      ),
    )
    .toBe(987);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getUndoStack()
            .some(
              (e) =>
                e.blockId === id &&
                e.element === 'field' &&
                String(e.newValue) === '987',
            ),
        number.id,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.Blockly.getFocusManager().focusNode(w.blocklyWorkspace);
    w.blocklyWorkspace.scroll(-5000, -90000);
    w.blocklyWorkspace.undo(false);
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        number.id,
      ),
    )
    .toBe(number.value);
  await page.evaluate(() => (window as any).blocklyWorkspace.undo(true));
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace
            .getBlockById(id)
            .getFieldValue('NUM'),
        number.id,
      ),
    )
    .toBe(987);
  await page.evaluate(() => (window as any).blocklyWorkspace.undo(false));
  await settle();
  report.fieldUndoRedo = true;

  // Drag an existing middle statement through the actual pointer entry.
  const target = await page.evaluate(() => {
    const w = window as any,
      ws = w.blocklyWorkspace,
      root = ws.getBlockById(w.viewportRoot);
    const block = root
      .getDescendants(false)
      .find(
        (b) =>
          b.previousConnection?.isConnected() &&
          b.nextConnection?.isConnected() &&
          !b.isShadow(),
      );
    w.viewportDragParent = block.getParent().id;
    w.viewportReconnect = block.previousConnection.targetConnection;
    ws.centerOnBlock(block.id, true);
    ws.clearUndo();
    return { id: block.id, parent: block.getParent().id };
  });
  await settle();
  const point = await page.evaluate((id) => {
    const w = window as any,
      block = w.blocklyWorkspace.getBlockById(id),
      rect = block.pathObject.svgPath.getBoundingClientRect();
    return [
      [5, 20],
      [8, 24],
      [12, 10],
      [30, 8],
    ]
      .map(([x, y]) => ({ x: rect.x + x, y: rect.y + y }))
      .find(
        (p) => document.elementFromPoint(p.x, p.y) === block.pathObject.svgPath,
      );
  }, target.id);
  expect(point).toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(point!.x + 220, point!.y + 90, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace.getBlockById(id).getParent()?.id ??
          null,
        target.id,
      ),
    )
    .toBeNull();
  await settle();
  expect(
    (await page.evaluate(() => (window as any).checkViewport())).incorrect,
  ).toBe(0);
  await page.evaluate(() => (window as any).blocklyWorkspace.undo(false));
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace.getBlockById(id).getParent()?.id ??
          null,
        target.id,
      ),
    )
    .toBe(target.parent);
  await settle();
  report.middleDragAndUndo = true;
  // Redo the detach, then reconnect through native hit-testing and snap preview.
  await page.evaluate(() => (window as any).blocklyWorkspace.undo(true));
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace.getBlockById(id).getParent()?.id ??
          null,
        target.id,
      ),
    )
    .toBeNull();
  await settle();
  const reconnect = await page.evaluate((id) => {
    const w = window as any,
      ws = w.blocklyWorkspace,
      block = ws.getBlockById(id);
    const rect = block.pathObject.svgPath.getBoundingClientRect();
    const start = [
      [5, 20],
      [8, 24],
      [12, 10],
      [30, 8],
    ]
      .map(([x, y]) => ({ x: rect.x + x, y: rect.y + y }))
      .find(
        (p) => document.elementFromPoint(p.x, p.y) === block.pathObject.svgPath,
      );
    return {
      start,
      dx: (w.viewportReconnect.x - block.previousConnection.x) * ws.scale,
      dy: (w.viewportReconnect.y - block.previousConnection.y) * ws.scale,
    };
  }, target.id);
  expect(reconnect.start).toBeTruthy();
  const start = reconnect.start!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + reconnect.dx, start.y + reconnect.dy, {
    steps: 20,
  });
  await settle();
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).blocklyWorkspace.getBlockById(id).getParent()?.id ??
          null,
        target.id,
      ),
    )
    .toBe(target.parent);
  await settle();
  expect(
    (await page.evaluate(() => (window as any).checkViewport())).incorrect,
  ).toBe(0);
  report.pointerReconnect = true;

  // Collapse a real container, then restore and save/load the complete model.
  await page.evaluate(async () => {
    const w = window as any,
      B = w.Blockly,
      ws = w.blocklyWorkspace,
      root = ws.getBlockById(w.viewportRoot);
    root.setCollapsed(true);
    await B.renderManagement.finishQueuedRenders();
    root.setCollapsed(false);
    await B.renderManagement.finishQueuedRenders();
    w.viewportSaved = B.serialization.workspaces.save(ws);
    w.viewportSavedCode = w.realCode();
    B.Events.disable();
    try {
      if (w.loadForBenchmark) w.loadForBenchmark(w.viewportSaved);
      else B.serialization.workspaces.load(w.viewportSaved, ws);
    } finally {
      B.Events.enable();
    }
  });
  await settle();
  const after = await page.evaluate(() => {
    const w = window as any;
    return {
      ...w.checkViewport(),
      code: w.realCode() === w.viewportSavedCode,
      state:
        JSON.stringify(
          w.Blockly.serialization.workspaces.save(w.blocklyWorkspace),
        ) === JSON.stringify(w.viewportSaved),
    };
  });
  expect(after.count).toBe(8265);
  expect(after.code).toBe(true);
  expect(after.state).toBe(true);
  expect(after.incorrect).toBe(0);
  expect(after.missing).toBe(0);
  report.collapseAndReload = after;
  return report;
}
