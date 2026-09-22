import * as Blockly from 'blockly';
import { layoutAbsNewRoots } from './abs-new-root-layout';

describe('ABS new-root layout seal', () => {
  let oldBlockly: unknown;
  beforeEach(() => { oldBlockly = window['Blockly']; window['Blockly'] = Blockly; });
  afterEach(() => { window['Blockly'] = oldBlockly; });
  const fixture = (RTL: boolean) => {
    const make = (id: string, y: number, height: number) => ({
      id, x: 30, y, getParent: () => null,
      getBoundingRectangle() { return { top: this.y, bottom: this.y + height, left: this.x, right: this.x + 50 }; },
      getRelativeToSurfaceXY() { return { x: this.x, y: this.y }; },
      moveBy(dx: number, dy: number) { this.x += dx; this.y += dy; },
    });
    const blocks = [make('old', 60, 400), make('a', 60, 500), make('b', 60, 100)];
    const workspace: any = { RTL, render() {}, getTopBlocks: () => blocks, getBlockById: id => blocks.find(block => block.id === id) };
    const state = { blocks: { blocks: blocks.map(block => ({ type: 'test', id: block.id, x: block.x, y: block.y })) } };
    return { blocks, workspace, state };
  };
  for (const rtl of [false, true]) it(`places measured new stacks below old stacks and seals coordinates (RTL=${rtl})`, () => {
    const { blocks, workspace, state } = fixture(rtl);
    layoutAbsNewRoots(state, ['a', 'b'], workspace, () => {});
    expect(blocks[0].getRelativeToSurfaceXY()).toEqual({ x: 30, y: 60 });
    expect(blocks[1].y).toBeGreaterThan(blocks[0].getBoundingRectangle().bottom);
    expect(blocks[2].y).toBeGreaterThan(blocks[1].getBoundingRectangle().bottom);
    expect(state.blocks.blocks[1].x).toBe(rtl ? -30 : 30);
    expect(state.blocks.blocks[2].y).toBe(blocks[2].y); expect(Blockly.Events.isEnabled()).toBeTrue();
  });
  it('rejects stale layout before moving and balances event suppression on a failed move', () => {
    const { blocks, workspace, state } = fixture(false);
    expect(() => layoutAbsNewRoots(state, ['a'], workspace, () => { throw new Error('stale'); })).toThrowError('stale');
    expect(blocks[1].y).toBe(60);
    blocks[1].moveBy = () => { throw new Error('layout failed'); };
    expect(() => layoutAbsNewRoots(state, ['a'], workspace, () => {})).toThrowError('layout failed');
    expect(Blockly.Events.isEnabled()).toBeTrue(); expect(blocks[0].y).toBe(60);
  });
});
