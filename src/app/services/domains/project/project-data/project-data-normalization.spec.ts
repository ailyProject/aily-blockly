import { BehaviorSubject } from 'rxjs';
import { sha256Hex } from '../../../../utils/crypto.utils';
import { normalizeProjectDataDocument, ProjectDataNormalizationStore } from './project-data-normalization';
import { AilyDataRef, createProjectDataMarker } from './project-data.types';
import { ProjectService } from '../project.service';
import { projectDataRuntime } from './project-data-runtime';

describe('Project Data normalization publication boundary', () => {
  const path = 'D:/project';
  const large = '中'.repeat(14000);
  const source = () => ({ blocks: { blocks: [{ type: 'any_library', id: 'protected', deletable: false,
    fields: { LARGE: large, SECOND: large + '2' } }] } });
  const digest = async (text: string) => `sha256:${await sha256Hex(text)}`;
  let values: Map<string, unknown>;
  let store: ProjectDataNormalizationStore;
  let files: any;
  let current: boolean;
  let disk: string;
  let events: string[];
  const guard = () => { if (!current) throw new Error('stale'); };
  const prepare = (document: unknown = source(), materialize = true, originalContent: string | undefined = disk) =>
    normalizeProjectDataDocument({ projectPath: path, document, originalContent, materialize }, store, guard, files);

  beforeEach(() => {
    current = true; values = new Map(); events = []; disk = JSON.stringify(source());
    store = {
      put: jasmine.createSpy('put').and.callFake(async ({ value, codec }) => {
        events.push('put'); const id = `sha256:${String(values.size + 1).padStart(64, '0')}` as const;
        values.set(id, value);
        return { $ailyData: { schemaVersion: 1, id, codec, logicalType: codec === 'utf8-v1' ? 'text' : 'json', storage: 'raw-v1',
          rawLength: new TextEncoder().encode(value).length, storedLength: new TextEncoder().encode(value).length } } satisfies AilyDataRef;
      }),
      flushPending: jasmine.createSpy('flush').and.callFake(async () => { events.push('flush'); }),
      collectReferences: jasmine.createSpy('refs').and.returnValue([]),
      validateReferences: jasmine.createSpy('validate').and.callFake(async () => { events.push('validate'); return { valid: true, issues: [] }; }),
      resolve: jasmine.createSpy('resolve').and.callFake(async ref => { events.push('resolve'); return values.get(ref.$ailyData.id); }),
    };
    files = { projectFilePublicationVersion: 2,
      replaceProjectText: jasmine.createSpy('publish').and.callFake(async (request, check) => {
        const expected = await digest(disk); const output = await digest(request.content); check(); events.push('publish');
        if (expected !== request.expectedHash) return { status: 'CONFLICT' };
        disk = request.content;
        return { status: 'COMMITTED', hash: output, ...(request.backup ? { backupHash: expected } : {}) };
      }) };
  });

  it('prepares and restores arbitrary large values before publishing a compact protected ABI with backup', async () => {
    const original = disk; const result = await prepare();
    expect(result.document).toEqual({ ...source(), $ailyProjectData: createProjectDataMarker() });
    expect(disk.length).toBeLessThan(2000);
    expect(JSON.parse(disk).blocks.blocks[0]).toEqual(jasmine.objectContaining({ id: 'protected', deletable: false }));
    expect(events).toEqual(['put', 'put', 'flush', 'validate', 'resolve', 'resolve', 'publish']);
    expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ projectPath: path,
      expectedHash: await digest(original), backup: 'project-data' }));
  });

  it('initialization externalizes and validates without materializing large fields', async () => {
    const result = await prepare(source(), false);
    expect(store.resolve).not.toHaveBeenCalled(); expect(result.document).toEqual(JSON.parse(disk));
  });

  describe('legacy hidden identity migration publication', () => {
    const legacy = () => ({ blocks: { blocks: ['a', 'b'].map(id => ({ id, type: 'owner', inputs: { VALUE: {
      block: { id: `value-${id}`, type: 'number' }, shadow: { id: 'shared-default', type: 'number', fields: { NUM: 1500 } },
    } } })) } });
    beforeEach(() => { disk = JSON.stringify(legacy()); files.existsSync = () => false; files.projectShadowIdentityMigrationVersion = 1; });
    it('publishes exactly once with a recoverable original and a host-locked identity precondition', async () => {
      const result = await prepare(legacy());
      expect(result.identityMigration.length).toBe(1);
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
      expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ backup: 'project-data', migrateLegacyShadowIds: true }));
      expect(JSON.parse(disk).blocks.blocks[1].inputs.VALUE.shadow.id).not.toBe('shared-default');
    });
    it('retains standalone ABS text while repairing identities in the ABI', async () => {
      files.existsSync = (file: string) => file.endsWith('/project.abs');
      const result = await prepare(legacy());
      expect(result.identityMigration.length).toBe(1);
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
    });
    for (const blocked of ['project.abs.map.json', '.aily/abs-sync']) it(`preserves ${blocked} and the ABI before any resource write`, async () => {
      const original = disk; files.existsSync = (file: string) => file.endsWith('/' + blocked);
      await expectAsync(prepare(legacy())).toBeRejectedWith(jasmine.objectContaining({ code: 'BLOCKLY_IDENTITY_MIGRATION_BLOCKED' }));
      expect(disk).toBe(original); expect(store.flushPending).not.toHaveBeenCalled(); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it('rechecks identity context when asynchronous resource work finishes', async () => {
      const original = disk; (store.flushPending as jasmine.Spy).and.callFake(async () => { files.existsSync = () => true; });
      await expectAsync(prepare(legacy())).toBeRejectedWith(jasmine.objectContaining({ code: 'BLOCKLY_IDENTITY_MIGRATION_BLOCKED' }));
      expect(disk).toBe(original); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it('rejects an older host that cannot enforce the locked precondition', async () => {
      files.projectShadowIdentityMigrationVersion = undefined; const original = disk;
      await expectAsync(prepare(legacy())).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_HOST_UNAVAILABLE' }));
      expect(disk).toBe(original); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it('accepts the cloud entry with empty field updates after fixing hidden identities', async () => {
      const result = await normalizeProjectDataDocument({ projectPath: path, document: legacy(), originalContent: disk, materialize: false, fieldUpdates: {} }, store, guard, files);
      expect(result.identityMigration.length).toBe(1); expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
    });
    it('imports an example whose first duplicated shadow is hidden and second is visible', async () => {
      const input = legacy();
      delete input.blocks.blocks[1].inputs.VALUE.block;
      disk = JSON.stringify(input);
      const result = await normalizeProjectDataDocument({ projectPath: path, document: input, originalContent: disk,
        materialize: false, fieldUpdates: {} }, store, guard, files);
      expect(result.identityMigration.length).toBe(1);
      const published = JSON.parse(disk);
      expect(published.blocks.blocks[0].inputs.VALUE.shadow.id).not.toBe('shared-default');
      expect(published.blocks.blocks[1].inputs.VALUE.shadow.id).toBe('shared-default');
      expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
        backup: 'project-data', migrateLegacyShadowIds: true,
      }));
    });
    it('does not guess which occurrence an ambiguous example parameter targets', async () => {
      await expectAsync(normalizeProjectDataDocument({ projectPath: path, document: legacy(), originalContent: disk, materialize: false,
        fieldUpdates: { 'shared-default': { field: 'NUM', value: 12 } } }, store, guard, files))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'BLOCKLY_IDENTITY_REFERENCE_AMBIGUOUS' }));
      expect(files.replaceProjectText).not.toHaveBeenCalled(); expect(store.flushPending).not.toHaveBeenCalled();
    });
  });

  it('an in-memory board template never publishes or reads the project mirror', async () => {
    const original = disk;
    const result = await normalizeProjectDataDocument({ projectPath: path, document: source(), materialize: true }, store, guard, files);
    expect(result.document).toEqual({ ...source(), $ailyProjectData: createProjectDataMarker() });
    expect(files.replaceProjectText).not.toHaveBeenCalled(); expect(disk).toBe(original);
  });

  it('unchanged documents still validate the original bytes without formatting changes or a new backup', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [] } };
    disk = JSON.stringify(document, null, 2) + '\r\n'; const original = disk;
    const result = await prepare(document);
    expect(result.migration.documentChanged).toBeFalse(); expect(disk).toBe(original);
    expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ content: original, expectedHash: await digest(original) }));
    expect(files.replaceProjectText.calls.mostRecent().args[0].backup).toBeUndefined();
  });

  it('migrates only legacy Arduino String declaration values before strict native loading', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [
      { type: 'variable_define', id: 'global-string', fields: { VAR: 'name', TYPE: 'string' } },
      { type: 'variable_define_scoped', id: 'scoped-string', fields: { VAR: 'local', TYPE: 'string' } },
      { type: 'another_library_block', id: 'unrelated', fields: { TYPE: 'string' } },
    ] } };
    disk = JSON.stringify(document); const original = disk;

    const result = await prepare(document);
    const migrated = result.document as typeof document;

    expect(document.blocks.blocks.map(block => block.fields.TYPE)).toEqual(['string', 'string', 'string']);
    expect(result.legacyFieldMigration.map(change => change.blockId)).toEqual(['global-string', 'scoped-string']);
    expect(migrated.blocks.blocks.map(block => block.fields.TYPE)).toEqual(['String', 'String', 'string']);
    expect(JSON.parse(disk).blocks.blocks.map((block: any) => block.fields.TYPE)).toEqual(['String', 'String', 'string']);
    expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
    expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      expectedHash: await digest(original), backup: 'project-data',
    }));
  });

  it('migrates only verified serial and U8G2 dropdown values, preserving the original ABI as backup', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [
      { type: 'serial_read', id: 'old-serial', fields: { SERIAL: 'Serial', TYPE: 'read' } },
      { type: 'u8g2_begin', id: 'old-display', fields: { TYPE: 'SSD1306', RESOLUTION: '128X64_NONAME_F', PROTOCOL: '_HW_I2C' } },
      { type: 'serial_read', id: 'other-option', fields: { TYPE: 'parseInt' } },
      { type: 'u8g2_begin', id: 'different-display', fields: { TYPE: 'SH1106', RESOLUTION: '128X64_NONAME_F' } },
    ] } };
    disk = JSON.stringify(document); const original = disk;

    const result = await prepare(document, false);
    const blocks = (result.document as typeof document).blocks.blocks;

    expect(result.legacyFieldMigration.map(change => `${change.blockId}/${change.field}`))
      .toEqual(['old-serial/TYPE', 'old-display/RESOLUTION', 'old-display/MODE']);
    expect(blocks[0].fields.TYPE).toBe('read()');
    expect(blocks[1].fields).toEqual(jasmine.objectContaining({ RESOLUTION: '128X64_NONAME', MODE: 'FULL_BUFFER' }));
    expect(blocks[2].fields.TYPE).toBe('parseInt');
    expect(blocks[3].fields.RESOLUTION).toBe('128X64_NONAME_F');
    expect(JSON.parse(disk).blocks.blocks).toEqual(blocks);
    expect(files.replaceProjectText.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      expectedHash: await digest(original), backup: 'project-data',
    }));
  });

  it('translates only corroborated legacy Blinker input counts', async () => {
    const input = (id: string, count: number, extraState: any) => ({
      type: 'blinker_widget_print', id, fields: { WIDGET: 'temp' }, extraState,
      inputs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`INPUT${i}`, { block: { type: 'text', id: `${id}-${i}` } }])),
    });
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [
      input('old', 2, { itemCount: 2 }),
      input('already-current', 2, { extraCount: 1 }),
      input('mismatch', 1, { itemCount: 2 }),
      { ...input('other-type', 2, { itemCount: 2 }), type: 'other_mutator' },
      input('missing-state', 2, undefined),
      { type: 'controls_ifelse', id: 'old-else', extraState: { elseIfCount: 1 },
        inputs: { IF0: {}, DO0: {}, IF1: {}, DO1: {}, ELSE: {} } },
    ] } };
    disk = JSON.stringify(document);

    const result = await prepare(document, false);
    const blocks = (result.document as typeof document).blocks.blocks;

    expect(result.legacyShapeMigration.map(change => change.blockId)).toEqual(['old', 'missing-state', 'old-else']);
    expect(blocks[0].extraState).toEqual({ extraCount: 1 });
    expect(blocks[1].extraState).toEqual({ extraCount: 1 });
    expect(blocks[2].extraState).toEqual({ itemCount: 2 });
    expect(blocks[3].extraState).toEqual({ itemCount: 2 });
    expect(blocks[4].extraState).toEqual({ extraCount: 1 });
    expect(blocks[5].extraState).toEqual({ elseIfCount: 1, hasElse: true });
    expect(JSON.parse(disk).blocks.blocks).toEqual(blocks);
    expect(files.replaceProjectText.calls.mostRecent().args[0].backup).toBe('project-data');
  });

  it('renames only the no-argument legacy FastLED refresh block', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [
      { type: 'fastled_refresh', id: 'old' },
      { type: 'fastled_refresh', id: 'unknown-shape', fields: { MODE: 'other' } },
    ] } };
    disk = JSON.stringify(document);
    const result = await prepare(document, false);
    expect(result.legacyTypeMigration.map(change => change.blockId)).toEqual(['old']);
    expect((result.document as typeof document).blocks.blocks.map(block => block.type))
      .toEqual(['fastled_show', 'fastled_refresh']);
    expect(files.replaceProjectText.calls.mostRecent().args[0].backup).toBe('project-data');
  });

  it('keeps the exact legacy U8G2 font while adding the new picker categories', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [
      { type: 'u8g2_set_font', id: 'font', fields: { FONT: 'u8g2_font_wqy13_t_chinese2' } },
      { type: 'u8g2_set_font', id: 'unknown', fields: { FONT: 'unrelated-font' } },
    ] } };
    disk = JSON.stringify(document);
    const result = await prepare(document, false);
    const blocks = (result.document as typeof document).blocks.blocks;
    expect(result.legacyFieldMigration.map(change => `${change.blockId}/${change.field}`)).toEqual(['font/SIZE', 'font/FONT_TYPE']);
    expect(blocks[0].fields).toEqual(jasmine.objectContaining({
      FONT: 'u8g2_font_wqy13_t_chinese2', SIZE: '14', FONT_TYPE: 'CHINESE',
    }));
    expect(blocks[1].fields).toEqual({ FONT: 'unrelated-font' });
  });

  for (const stage of ['put', 'flushPending', 'validateReferences', 'resolve'] as const) {
    it(`failure in ${stage} leaves the original ABI and avoids publication`, async () => {
      const original = disk; (store[stage] as jasmine.Spy).and.rejectWith(new Error(stage));
      await expectAsync(prepare()).toBeRejectedWithError(stage);
      expect(disk).toBe(original); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it(`session change during ${stage} stops subsequent I/O and publication`, async () => {
      // Preserve the stage's normal return contract, but invalidate its caller.
      (store[stage] as jasmine.Spy).and.callFake(async () => {
        current = false;
        if (stage === 'validateReferences') return { valid: true, issues: [] };
        if (stage === 'resolve') return large;
        return undefined;
      });
      await expectAsync(prepare()).toBeRejectedWithError('stale');
      expect(store[stage]).toHaveBeenCalledTimes(1); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
  }

  it('retains an external edit made during restoration instead of overwriting it', async () => {
    (store.resolve as jasmine.Spy).and.callFake(async ref => { disk = 'external'; return values.get(ref.$ailyData.id); });
    await expectAsync(prepare()).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_CONFLICT' }));
    expect(disk).toBe('external');
  });

  it('rejects stale disk bytes even when normalization would not change the document', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [] } };
    disk = JSON.stringify(document);
    (store.flushPending as jasmine.Spy).and.callFake(async () => { disk = 'external'; });
    await expectAsync(prepare(document)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_FILE_CONFLICT' }));
    expect(disk).toBe('external');
  });

  it('retains a committed ABI when the acknowledgement is uncertain and does not return a load candidate', async () => {
    files.replaceProjectText.and.callFake(async request => { disk = request.content; return { status: 'UNKNOWN' }; });
    await expectAsync(prepare()).toBeRejectedWith(jasmine.objectContaining({ uncertain: true }));
    expect(disk.length).toBeLessThan(2000); expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
  });

  it('does not return an old load candidate after a confirmed commit in a superseded context', async () => {
    files.replaceProjectText.and.callFake(async request => {
      disk = request.content; current = false;
      return { status: 'COMMITTED', hash: await digest(disk), backupHash: request.expectedHash };
    });
    await expectAsync(prepare()).toBeRejectedWithError('stale'); expect(disk.length).toBeLessThan(2000);
  });

  it('does not share a caller-mutated unchanged document across asynchronous validation', async () => {
    const document = { $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [] }, extra: 'before' };
    disk = JSON.stringify(document);
    const pending = prepare(document); document.extra = 'after';
    expect((await pending).document['extra']).toBe('before');
  });

  describe('ProjectService entry points', () => {
    let service: any;
    let previous: any;
    let session: string;
    beforeEach(() => {
      previous = { fs: window['fs'], path: window['path'] };
      window['fs'] = { ...files, existsSync: () => true, readFileSync: () => disk,
        writeFileSync: jasmine.createSpy('unchecked write'), renameSync: jasmine.createSpy('unchecked rename') };
      window['path'] = { join: (...parts: string[]) => parts.join('/') };
      service = Object.create(ProjectService.prototype);
      service.currentProjectPathSubject = new BehaviorSubject(path);
      service.createProjectDataStore = jasmine.createSpy('store').and.returnValue(store);
      session = 'session-a'; spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
      spyOn(projectDataRuntime, 'getStore').and.throwError('must not use a global store');
      spyOn(console, 'info');
    });
    afterEach(() => Object.assign(window, previous));
    it('routes initialization to the same host without consulting the active runtime', async () => {
      await service.initializeProjectDataSchema(path);
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
      expect(window['fs'].writeFileSync).not.toHaveBeenCalled(); expect(window['fs'].renameSync).not.toHaveBeenCalled();
    });
    it('publishes small field edits even when Project Data normalization itself is a no-op', async () => {
      disk = JSON.stringify({ $ailyProjectData: createProjectDataMarker(), blocks: { blocks: [{ type: 'text', id: 'small', fields: { TEXT: 'before' } }] } });
      await service.initializeProjectDataSchema(path, () => {}, { small: 'after' });
      expect(JSON.parse(disk).blocks.blocks[0].fields.TEXT).toBe('after');
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
    });
    it('externalizes large example parameters and commits once, retaining the original as backup', async () => {
      disk = JSON.stringify({ blocks: { blocks: [{ type: 'text', id: 'large', fields: { TEXT: 'before' }, deletable: false }] } });
      const original = disk;
      await service.initializeProjectDataSchema(path, () => {}, { large });
      expect(JSON.parse(disk).blocks.blocks[0].fields.TEXT.$ailyProjectDataValue).toBeDefined();
      expect(JSON.parse(disk).blocks.blocks[0].deletable).toBeFalse();
      expect(files.replaceProjectText).toHaveBeenCalledTimes(1);
      expect(files.replaceProjectText.calls.mostRecent().args[0].expectedHash).toBe(await digest(original));
    });
    it('rejects missing target IDs before resource I/O or ABI publication', async () => {
      await expectAsync(service.initializeProjectDataSchema(path, () => {}, { unknown: large })).toBeRejected();
      expect(store.put).not.toHaveBeenCalled(); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it('rejects same-path runtime replacement before publishing during load', async () => {
      (store.flushPending as jasmine.Spy).and.callFake(async () => { session = 'session-b'; });
      await expectAsync(service.ensureProjectDataSchemaForLoad(path, source(), disk))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
      expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
    it('rejects navigation during load without selecting the new project store', async () => {
      (store.flushPending as jasmine.Spy).and.callFake(async () => { service.currentProjectPathSubject.next('D:/another'); });
      await expectAsync(service.ensureProjectDataSchemaForLoad(path, source(), disk))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
      expect(projectDataRuntime.getStore).not.toHaveBeenCalled(); expect(files.replaceProjectText).not.toHaveBeenCalled();
    });
  });
});
