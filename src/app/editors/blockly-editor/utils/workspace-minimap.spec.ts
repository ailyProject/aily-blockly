import * as Blockly from 'blockly';
import { WorkspaceMinimap } from './workspace-minimap';

for (const virtual of [false, true]) describe(`WorkspaceMinimap projection (virtual=${virtual})`, () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;
  let minimap: WorkspaceMinimap;
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'position:relative;width:800px;height:600px';
    document.body.append(host);
    workspace = Blockly.inject(host, {scrollbars: true});
    workspace.setViewportRendering(virtual);
    Blockly.Blocks['minimap_test'] = {init() {this.appendDummyInput().appendField('visible label');}};
    minimap = new WorkspaceMinimap(workspace);
  });
  afterEach(() => {
    minimap.dispose();
    workspace.dispose();
    host.remove();
    delete Blockly.Blocks['minimap_test'];
  });

  it('projects the original SVG without a second workspace, constructors or XML', async () => {
    const count = Blockly.common.getAllWorkspaces().length;
    const xml = spyOn(Blockly.Xml, 'workspaceToDom').and.callThrough();
    const block = workspace.newBlock('minimap_test');
    block.initSvg(); block.render();
    minimap.requestSync({type: 'create'});
    await frame();
    const reference = host.querySelector('[data-minimap-source]');
    expect(reference?.getAttribute('data-minimap-source')).toBe(block.getSvgRoot().id);
    expect(reference?.querySelector('text')?.textContent).toBeTruthy();
    expect(reference?.querySelector('[id], [tabindex="0"], .blocklyDraggable')).toBeNull();
    expect(Blockly.common.getAllWorkspaces().length).toBe(count);
    expect(xml).not.toHaveBeenCalled();
    expect(host.querySelector('.blockly-minimap')?.getAttribute('data-minimap-ready')).toBe('true');
  });

  it('updates snapshots on moves and removes stale snapshots on delete/page replacement', async () => {
    const block = workspace.newBlock('minimap_test');
    block.initSvg(); block.render();
    minimap.requestSync(); await frame();
    block.moveBy(800, 400);
    minimap.requestSync({type: 'move'}); await frame();
    expect(host.querySelector('[data-minimap-source]')?.getAttribute('transform')).toBe(block.getSvgRoot().getAttribute('transform'));
    block.dispose(false);
    minimap.requestSync({type: 'delete'}); await frame();
    expect(host.querySelectorAll('[data-minimap-source]').length).toBe(0);
    expect(host.querySelector('.blockly-minimap svg')?.innerHTML).not.toContain('NaN');
  });

  it('retains custom canvas previews and refreshes variable-label changes', async () => {
    const block = workspace.newBlock('minimap_test');
    block.initSvg(); block.render();
    const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    canvas.getContext('2d')!.fillStyle = '#f00';
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
    foreign.append(canvas); block.getSvgRoot().append(foreign);
    minimap.requestSync(); await frame();
    const copy = host.querySelector('[data-minimap-source] canvas') as HTMLCanvasElement;
    expect(Array.from(copy.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255]);
    block.getSvgRoot().querySelector('text')!.textContent = 'renamed variable';
    minimap.requestSync({type: 'var_rename'}); await frame();
    expect(host.querySelector('[data-minimap-source] text')?.textContent).toBe('renamed variable');
  });

  it('excludes hidden functions and restores their projection when the complete file is shown', async () => {
    const first = workspace.newBlock('minimap_test'), other = workspace.newBlock('minimap_test');
    first.initSvg(); first.render(); other.initSvg(); other.render(); other.moveBy(1000, 500);
    other.getSvgRoot().setAttribute('data-aily-function-hidden', 'true');
    other.getSvgRoot().style.display = 'none';
    minimap.requestSync(); await frame();
    expect(host.querySelectorAll('[data-minimap-source]').length).toBe(1);
    expect(host.querySelector('.blockly-minimap')?.getAttribute('data-minimap-shapes')).toBe('1');
    other.getSvgRoot().removeAttribute('data-aily-function-hidden'); other.getSvgRoot().style.display = '';
    minimap.requestSync(); await frame();
    expect(host.querySelectorAll('[data-minimap-source]').length).toBe(2);
    expect(host.querySelector('.blockly-minimap')?.getAttribute('data-minimap-shapes')).toBe('2');
  });

  it('supports keyboard navigation and cleans up queued frames and listeners', async () => {
    const block = workspace.newBlock('minimap_test');
    block.initSvg(); block.render();
    minimap.requestSync(); await frame();
    const element = host.querySelector('.blockly-minimap') as HTMLElement;
    expect(element.tabIndex).toBe(0);
    expect(element.getAttribute('aria-label')).toBeTruthy();
    const scroll = spyOn(workspace, 'scroll').and.callThrough();
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(scroll).toHaveBeenCalled();
    minimap.requestSync(); minimap.dispose(); await frame();
    expect(host.querySelector('.blockly-minimap')).toBeNull();
    scroll.calls.reset();
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(scroll).not.toHaveBeenCalled();
  });

  async function largeOverview(): Promise<HTMLElement> {
    for (let i = 0; i < 301; i++) {
      const block = workspace.newBlock('minimap_test');
      block.initSvg(); block.queueRender(); block.moveBy((i % 20) * 160, Math.floor(i / 20) * 60);
    }
    await Blockly.renderManagement.finishQueuedRenders();
    minimap.requestSync();
    const element = host.querySelector('.blockly-minimap') as HTMLElement;
    for (let i = 0; i < 100; i++) {
      await frame();
      if (element.dataset['minimapReady'] === 'true' && element.dataset['minimapShapes'] === '301') return element;
    }
    throw new Error('Large minimap did not finish painting');
  }

  it('renders large diagrams in a worker with no SVG clones and switches back after page clear', async () => {
    const element = await largeOverview();
    expect(element.dataset['minimapMode']).toBe('canvas-worker');
    expect(element.querySelectorAll('use').length).toBe(0);
    expect(element.querySelector('canvas')!.width).toBeGreaterThan(0);
    workspace.clear(); minimap.requestSync(); await frame();
    expect(element.dataset['minimapMode']).toBe('svg-snapshot');
    expect(element.querySelectorAll('use').length).toBe(0);
  });

  it('uses bounded canvas batches when workers are unavailable', async () => {
    spyOn(window, 'Worker').and.throwError('worker disabled by policy');
    const element = await largeOverview();
    expect(element.dataset['minimapMode']).toBe('canvas-main-thread');
    const context = element.querySelector('canvas')!.getContext('2d')!;
    expect(context.getImageData(0, 0, context.canvas.width, context.canvas.height).data.some(value => value > 0)).toBeTrue();
  });

  it('abandons an in-flight overview when interaction starts and later captures current native geometry', async () => {
    minimap.dispose();
    let busy = false;
    minimap = new WorkspaceMinimap(workspace, () => busy);
    for (let i = 0; i < 301; i++) {
      const block = workspace.newBlock('minimap_test'); block.initSvg(); block.queueRender();
      block.moveBy(i * 17, i * 9);
    }
    await Blockly.renderManagement.finishQueuedRenders();
    minimap.requestSync();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    // The first frame schedules collection; an interaction arrives before it.
    busy = true; await frame();
    expect((minimap as any).scene).toBeNull();
    const block = workspace.getTopBlocks(false)[0]; block.moveBy(30, 40);
    busy = false; minimap.requestSync({type: 'move'});
    const element = host.querySelector('.blockly-minimap') as HTMLElement;
    for (let i = 0; i < 100 && element.dataset['minimapReady'] !== 'true'; i++) await frame();
    expect(element.dataset['minimapShapes']).toBe('301');
    const shapes = (minimap as any).scene.shapes;
    for (const block of workspace.getAllBlocks(false)) {
      const shape = shapes.find(shape => shape.id === block.id), point = block.getRelativeToSurfaceXY();
      expect([shape.x, shape.y]).toEqual([point.x, point.y]);
    }
  });
});
