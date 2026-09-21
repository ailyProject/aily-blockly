import * as Blockly from 'blockly';
import 'blockly/blocks';
import { fenceBlocklyWorkspaceBumps } from '../../../editors/blockly-editor/services/blockly-workspace-layout-fence';

describe('workspace transaction layout fence', () => {
  let container: HTMLDivElement, workspace: Blockly.WorkspaceSvg, release: () => void;
  beforeEach(() => {
    container = document.createElement('div'); container.style.cssText = 'width:600px;height:400px';
    document.body.appendChild(container); workspace = Blockly.inject(container, {});
    release = () => undefined;
  });
  afterEach(() => { release(); workspace.dispose(); container.remove(); });
  const number = () => {
    const block = workspace.newBlock('math_number'); block.initSvg(); block.render(); return block;
  };

  it('suppresses only native bumps for existing and subsequently created blocks', () => {
    const before = number(), original = before.moveBy, create = workspace.newBlock;
    release = fenceBlocklyWorkspaceBumps(workspace);
    const after = number();
    for (const block of [before, after]) {
      block.moveBy(10, 20, ['bump']);
      expect(block.getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(0, 0));
      block.moveBy(3, 4); block.moveBy(5, 6, ['drag']);
      expect(block.getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(8, 10));
      expect(block.isMovable()).toBeTrue();
    }
    release(); release();
    expect(before.moveBy).toBe(original); expect(after.moveBy).toBe(original);
    expect(workspace.newBlock).toBe(create);
    expect(Object.hasOwn(before, 'moveBy')).toBeFalse();
    expect(Object.hasOwn(workspace, 'newBlock')).toBeFalse();
    before.moveBy(10, 20, ['bump']);
    expect(before.getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(18, 30));
  });

  it('does not modify another workspace, a prototype or a block custom method after release', () => {
    const other = new Blockly.Workspace(), block = number();
    const custom = jasmine.createSpy('customMove'); block.moveBy = custom;
    const descriptor = Object.getOwnPropertyDescriptor(block, 'moveBy');
    const prototypeMove = Blockly.BlockSvg.prototype.moveBy;
    try {
      release = fenceBlocklyWorkspaceBumps(workspace);
      const otherBlock = other.newBlock('math_number'); otherBlock.moveBy(3, 4, ['bump']);
      expect(otherBlock.getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(3, 4));
      expect(Blockly.BlockSvg.prototype.moveBy).toBe(prototypeMove);
      block.moveBy(3, 4, ['bump']); expect(custom).not.toHaveBeenCalled();
      block.moveBy(3, 4, ['cleanup']); expect(custom).toHaveBeenCalledWith(3, 4, ['cleanup']);
      release(); expect(Object.getOwnPropertyDescriptor(block, 'moveBy')).toEqual(descriptor);
    } finally { other.dispose(); }
  });

  it('restores earlier hooks if acquiring the fence fails', () => {
    const first = number(), second = number(), original = first.moveBy;
    Object.defineProperty(second, 'moveBy', { value: second.moveBy, configurable: false });
    expect(() => fenceBlocklyWorkspaceBumps(workspace)).toThrow();
    expect(first.moveBy).toBe(original); expect(Object.hasOwn(first, 'moveBy')).toBeFalse();
    expect(Object.hasOwn(workspace, 'newBlock')).toBeFalse();
  });

  it('leaves headless workspaces untouched', () => {
    const headless = new Blockly.Workspace();
    try {
      const create = headless.newBlock, block = headless.newBlock('math_number'), move = block.moveBy;
      fenceBlocklyWorkspaceBumps(headless)();
      expect(headless.newBlock).toBe(create); expect(block.moveBy).toBe(move);
    } finally { headless.dispose(); }
  });
});
