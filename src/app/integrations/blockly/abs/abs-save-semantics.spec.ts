import { createAilyProjectDataValue, createProjectDataMarker } from '@domain/project/public-api';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { canSaveAbsWorkspace, sameAbsSavedProgram, type AbsSaveComparisonPort } from './abs-save-semantics';

describe('ABS saved ABI three-way semantic admission', () => {
  const document = () => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    $ailyProjectData: createProjectDataMarker(),
    pages: [{ id: 'main', title: 'Main', viewState: { scale: 1, scrollX: 0, scrollY: 0 },
      content: { blocks: { blocks: [
        { type: 'text', id: 'one', x: 10, y: 20, fields: { TEXT: 'before' }, disabled: true,
          collapsed: true, deletable: false, data: 'opaque', extraState: { x: 2 } },
        { type: 'text', id: 'two', fields: { TEXT: 'other' } },
      ] } } }], sharedModel: { procedureBlocks: [], extension: { retained: true } } });
  const port = (): AbsSaveComparisonPort => ({ normalize: value => value,
    resolve: async () => { throw new Error('missing resource'); }, assertCurrent: () => undefined });
  const current = () => { const value = document(); value.pages[0].content.blocks.blocks[0].fields.TEXT = 'local edit'; return value; };

  for (const name of ['format', 'viewport', 'coordinates']) it(`allows ${name}-only D drift with a separate W edit`, async () => {
    const base = document(), disk = document();
    if (name === 'viewport') disk.pages[0].viewState.scrollX = 45;
    if (name === 'coordinates') disk.pages[0].content.blocks.blocks[0].x = 500;
    const before = JSON.stringify({ base, disk });
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk, null, 2), JSON.stringify(current()), port())).toBeTrue();
    expect(JSON.stringify({ base, disk })).toBe(before);
  });

  it('allows the exact current canvas already on disk, but does not infer a missing old recipe', async () => {
    expect(await canSaveAbsWorkspace(null, JSON.stringify(current()), JSON.stringify(current()), port())).toBeTrue();
    expect(await canSaveAbsWorkspace(null, JSON.stringify(document()), JSON.stringify(current()), port())).toBeFalse();
    expect(await canSaveAbsWorkspace(JSON.stringify(document()), null, JSON.stringify(current()), port())).toBeFalse();
  });

  it('uses the shared persistence normalizer for a legacy workspace recipe without sorting roots', async () => {
    const base = document(), legacy = base.pages[0].content;
    const comparison = port();
    comparison.normalize = value => {
      if (Array.isArray((value as any)?.pages)) return value;
      return { ...document(), pages: [{ ...base.pages[0], content: value }] };
    };
    expect(await canSaveAbsWorkspace(JSON.stringify(legacy), JSON.stringify(base), JSON.stringify(current()), comparison)).toBeTrue();
    const reversed = document(); reversed.pages[0].content.blocks.blocks.reverse();
    expect(await canSaveAbsWorkspace(JSON.stringify(legacy), JSON.stringify(reversed), JSON.stringify(current()), comparison)).toBeFalse();
  });

  it('adapts only an unversioned workspace using the real editor normalizer', async () => {
    const editor = Object.assign(Object.create(BlocklyService.prototype), { projectDocumentSchemaVersion: 3 });
    const comparison = port(); comparison.normalize = value => BlocklyService.prototype.normalizeProjectAbi.call(editor, value);
    const workspace = { blocks: { languageVersion: 0, blocks: [{ type: 'text', id: 'legacy', fields: { TEXT: 'before' } }] },
      unknownSerializer: { keep: 3 } };
    const disk = comparison.normalize(workspace) as any;
    const local = JSON.parse(JSON.stringify(disk)); local.pages[0].content.blocks.blocks[0].fields.TEXT = 'local edit';
    expect(await canSaveAbsWorkspace(JSON.stringify(workspace), JSON.stringify(disk), JSON.stringify(local), comparison)).toBeTrue();
    disk.pages[0].content.unknownSerializer.keep = 4;
    expect(await canSaveAbsWorkspace(JSON.stringify(workspace), JSON.stringify(disk), JSON.stringify(local), comparison)).toBeFalse();
  });

  for (const name of ['schema', 'activePage', 'openedPages', 'metadata', 'rootOrder', 'hidden', 'ownership']) {
    it(`does not let the real native normalizer erase a competing ${name} document edit`, async () => {
      const editor = Object.assign(Object.create(BlocklyService.prototype), { projectDocumentSchemaVersion: 3 });
      const comparison = port(); comparison.normalize = value => BlocklyService.prototype.normalizeProjectAbi.call(editor, value);
      const disk: any = document();
      if (name === 'schema') disk.schemaVersion = 999;
      if (name === 'activePage') disk.activePageId = 'nonexistent';
      if (name === 'openedPages') disk.openedPageIds = ['nonexistent'];
      if (name === 'metadata') disk.unknownMetadata = { keep: true };
      if (name === 'rootOrder') disk.pages[0].content.blocks.blocks.reverse();
      if (name === 'hidden') disk.pages[0].content.blocks.blocks[0].collapsed = false;
      if (name === 'ownership') disk.sharedModel.procedureBlocks.push(disk.pages[0].content.blocks.blocks.shift());
      expect(await canSaveAbsWorkspace(JSON.stringify(document()), JSON.stringify(disk), JSON.stringify(current()), comparison)).toBeFalse();
    });
  }

  it('recognizes the exact missing-to-standard data envelope without ignoring marker extensions', async () => {
    const base: any = document(), disk: any = document(), local: any = current();
    delete base.$ailyProjectData;
    disk.$ailyProjectData = createProjectDataMarker(); local.$ailyProjectData = createProjectDataMarker();
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk), JSON.stringify(local), port())).toBeTrue();
    disk.$ailyProjectData.extension = 'retain me';
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk), JSON.stringify(local), port())).toBeFalse();
    delete disk.$ailyProjectData.extension; disk.$ailyProjectData.schemaVersion++;
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk), JSON.stringify(local), port())).toBeFalse();
    disk.$ailyProjectData = { ...createProjectDataMarker(), mode: 'unknown-mode' };
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk), JSON.stringify(local), port())).toBeFalse();
  });

  const changes: Record<string, (value: any) => void> = {
    field: value => value.pages[0].content.blocks.blocks[0].fields.TEXT = 'external',
    rootOrder: value => value.pages[0].content.blocks.blocks.reverse(),
    owner: value => value.pages[0].id = 'moved',
    hidden: value => value.pages[0].content.blocks.blocks[0].disabled = false,
    collapsed: value => value.pages[0].content.blocks.blocks[0].collapsed = false,
    protection: value => value.pages[0].content.blocks.blocks[0].deletable = true,
    opaque: value => value.pages[0].content.blocks.blocks[0].data = 'changed',
    extraState: value => value.pages[0].content.blocks.blocks[0].extraState.x++,
    unknown: value => value.sharedModel.extension.retained = false,
    unknownViewport: value => value.pages[0].viewState.extension = 'new',
    invalidCoordinate: value => value.pages[0].content.blocks.blocks[0].x = 'invalid',
    marker: value => value.$ailyProjectData.schemaVersion++,
  };
  for (const [name, change] of Object.entries(changes)) it(`retains a competing ${name} disk edit`, async () => {
    const disk = document(); change(disk);
    expect(await canSaveAbsWorkspace(JSON.stringify(document()), JSON.stringify(disk), JSON.stringify(current()), port())).toBeFalse();
  });

  it('materializes ref/inline payloads only on a representation mismatch', async () => {
    const base = document(), disk: any = document(), comparison = port();
    const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'1'.repeat(64)}`, codec: 'utf8-v1',
      logicalType: 'text', storage: 'raw-v1', rawLength: 6, storedLength: 6 } } as const;
    disk.pages[0].content.blocks.blocks[0].fields.TEXT = createAilyProjectDataValue(ref);
    const resolve = jasmine.createSpy('resolve').and.resolveTo('before'); comparison.resolve = resolve;
    expect(await canSaveAbsWorkspace(JSON.stringify(base), JSON.stringify(disk), JSON.stringify(current()), comparison)).toBeTrue();
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.calls.reset();
    expect(await sameAbsSavedProgram(disk, disk, comparison)).toBeTrue();
    expect(resolve).not.toHaveBeenCalled();
    comparison.resolve = port().resolve;
    await expectAsync(sameAbsSavedProgram(base, disk, comparison)).toBeRejectedWithError('missing resource');
  });

  it('checks context after resolving resources instead of accepting a stale comparison', async () => {
    const left: any = document(), right = document(), comparison = port();
    left.pages[0].content.blocks.blocks[0].fields.TEXT = createAilyProjectDataValue({ $ailyData: {
      schemaVersion: 1, id: `sha256:${'2'.repeat(64)}`, codec: 'utf8-v1', logicalType: 'text',
      storage: 'raw-v1', rawLength: 6, storedLength: 6 } });
    let stale = false;
    comparison.resolve = async <T>() => { stale = true; return 'before' as T; };
    comparison.assertCurrent = () => { if (stale) throw new Error('stale context'); };
    await expectAsync(sameAbsSavedProgram(left, right, comparison)).toBeRejectedWithError('stale context');
  });
});
