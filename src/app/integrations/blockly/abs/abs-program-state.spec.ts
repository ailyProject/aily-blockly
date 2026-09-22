import { absProgramDocument, retainAbsRootLayout, sameAbsProgram } from './abs-program-state';

describe('ABS layout-neutral program comparison', () => {
  const document = () => ({ pages: [{ id: 'main', content: { value: 1 }, viewState: { scale: 1, scrollX: 10, scrollY: 20 } }], sharedModel: {} });
  it('ignores only known numeric viewport values without mutating either document', () => {
    const a = document(), b = document(); b.pages[0].viewState = { scale: 0.5, scrollX: 20, scrollY: 30 };
    expect(sameAbsProgram(a, b)).toBeTrue(); expect(a.pages[0].viewState.scale).toBe(1);
    delete b.pages[0].viewState; expect(sameAbsProgram(a, b)).toBeTrue();
  });
  it('keeps unknown view state, page content, shared models and invalid values significant', () => {
    for (const change of [b => b.pages[0].viewState.extension = 1, b => b.pages[0].content.value++,
      b => b.sharedModel.reference = 'id', b => b.pages[0].viewState.scale = 'invalid']) {
      const b = document(); change(b); expect(sameAbsProgram(document(), b)).toBeFalse();
    }
  });
  const layout = () => ({ pages: [{ id: 'main', content: { blocks: { blocks: [
    { type: 'root', id: 'root', x: 30, y: 60, fields: { X: 7 }, extraState: { x: 8 },
      inputs: { BODY: { block: { type: 'child', id: 'child' } } }, deletable: false },
    { type: 'other', id: 'other', x: 100, y: 100 },
  ] } } }], sharedModel: { procedureBlocks: [{ type: 'procedure', id: 'procedure', x: 30, y: 60 }] } });
  it('ignores finite root coordinates on pages and shared definitions without mutating the snapshot', () => {
    const a = layout(), b = layout();
    b.pages[0].content.blocks.blocks[0].x = 500;
    b.sharedModel.procedureBlocks[0].y = 999;
    expect(sameAbsProgram(a, b)).toBeTrue();
    const program: any = absProgramDocument(a);
    expect(program.pages[0].content.blocks.blocks[0].x).toBeUndefined();
    expect(a.pages[0].content.blocks.blocks[0].x).toBe(30);
    expect(a.sharedModel.procedureBlocks[0].y).toBe(60);
  });
  it('does not discard topology, root order, fields, flags, extension coordinates or invalid coordinates', () => {
    for (const change of [
      b => delete b.pages[0].content.blocks.blocks[0].inputs,
      b => b.pages[0].content.blocks.blocks.reverse(),
      b => b.pages[0].content.blocks.blocks[0].fields.X++,
      b => b.pages[0].content.blocks.blocks[0].extraState.x++,
      b => b.pages[0].content.blocks.blocks[0].deletable = true,
      b => b.pages[0].content.blocks.blocks[0].x = 'invalid',
      b => b.sharedModel.procedureBlocks[0].id = 'changed',
    ]) {
      const b = layout(); change(b); expect(sameAbsProgram(layout(), b)).toBeFalse();
    }
  });
  it('retains only matching existing root coordinates, not current fields or new-root layout', () => {
    const target: any = { blocks: { blocks: [{ type: 'root', id: 'root', x: 30, y: 60, fields: { X: 2 } },
      { type: 'new', id: 'new', x: 10, y: 20 }] } };
    const current: any = { blocks: { blocks: [{ type: 'root', id: 'root', x: 90, y: 110, fields: { X: 1 } }] } };
    retainAbsRootLayout(target, current);
    expect(target.blocks.blocks[0]).toEqual({ type: 'root', id: 'root', x: 90, y: 110, fields: { X: 2 } });
    expect(target.blocks.blocks[1]).toEqual({ type: 'new', id: 'new', x: 10, y: 20 });
    expect(current.blocks.blocks[0].fields.X).toBe(1);
  });
});
