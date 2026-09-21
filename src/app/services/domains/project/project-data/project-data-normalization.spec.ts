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
