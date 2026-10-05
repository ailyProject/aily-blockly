import {
  ProjectDataStore, ProjectDataFileSystem, AilyDataRef, projectDataRuntime, canonicalJsonStringify,
  externalizeGenericProjectDataValues, materializeGenericProjectDataValues, assertNoOversizedInlineValues,
} from '@domain/project/public-api';
import { prepareBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';

/** Only the filesystem boundary is substituted; containers, codecs and hashes are real. */
function memoryFiles() {
  const files = new Map<string, Uint8Array>(), directories = new Set(['/project']);
  const resolve = (path: string) => path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const dirname = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const readBinary = jasmine.createSpy('readBinary').and.callFake(async (path: string) => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
    return files.get(path)!.slice();
  });
  const writeBinary = jasmine.createSpy('writeBinary').and.callFake(async (path: string, bytes: Uint8Array) => {
    files.set(path, bytes.slice());
  });
  const fs: ProjectDataFileSystem = {
    resolve, dirname, join: (...parts) => resolve(parts.join('/')),
    relative: (from, to) => to === from ? '' : to.startsWith(from + '/') ? to.slice(from.length + 1) : '../outside',
    isAbsolute: path => path.startsWith('/'), exists: async path => files.has(path) || directories.has(path),
    mkdir: async path => { for (let part = path; part; part = dirname(part)) directories.add(part); },
    readBinary, writeBinary,
    rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    unlink: async path => { files.delete(path); },
    readdir: async path => [...new Set([...files.keys(), ...directories].filter(p => p.startsWith(path + '/'))
      .map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: async path => {
      if (!files.has(path) && !directories.has(path)) throw new Error(`ENOENT: ${path}`);
      return { size: files.get(path)?.length ?? 0, isFile: files.has(path), isDirectory: directories.has(path),
        isSymbolicLink: false, mtimeMs: 0 };
    },
  };
  const store = new ProjectDataStore(fs); store.configure('/project');
  return { store, files, fs, readBinary, writeBinary };
}

describe('project data persistence acceptance', () => {
  const workspace = (payload: unknown) => ({ blocks: { blocks: [{ type: 'opaque', id: 'block', fields: { PAYLOAD: payload } }] } });
  for (const [kind, makeValue] of [
    ['ASCII', (bytes: number) => 'x'.repeat(bytes)],
    ['Chinese', (bytes: number) => '界'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3)],
    ['emoji', (bytes: number) => '😀'.repeat(Math.floor(bytes / 4)) + 'x'.repeat(bytes % 4)],
    ['array', (bytes: number) => ['x'.repeat(bytes - 4)]],
    ['object', (bytes: number) => ({ v: 'x'.repeat(bytes - 8) })],
  ] as Array<[string, (bytes: number) => unknown]>) {
    for (const bytes of [32768, 32769]) it(`round trips ${kind} at ${bytes} canonical UTF-8 bytes through real storage`, async () => {
      const { store, files, writeBinary } = memoryFiles();
      const payload = makeValue(bytes), source = workspace(payload);
      expect(new TextEncoder().encode(typeof payload === 'string' ? payload : canonicalJsonStringify(payload)).length).toBe(bytes);
      const result = await externalizeGenericProjectDataValues(source, store);
      expect(result.externalized.length).toBe(bytes > 32768 ? 1 : 0);
      expect(files.size).toBe(bytes > 32768 ? 1 : 0);
      expect(() => assertNoOversizedInlineValues(result.document)).not.toThrow();
      const writes = writeBinary.calls.count(), persisted = JSON.stringify(result.document);
      for (let round = 0; round < 3; round++) {
        store.configure('/project');
        expect(await materializeGenericProjectDataValues(JSON.parse(persisted), store)).toEqual(source);
      }
      expect(writeBinary.calls.count()).toBe(writes);
    });
  }

  it('externalizes and restores shared-model extensions without treating their JSON as blocks', async () => {
    const { store } = memoryFiles();
    const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'Main', content: { blocks: { blocks: [] } } }],
      sharedModel: { variables: [{ id: 'v', name: 'counter', type: 'int' }], procedureBlocks: [],
        extension: { type: 'opaque-not-a-block', id: 'payload', samples: Array(10000).fill(12345) } } };
    const result = await externalizeGenericProjectDataValues(document, store);
    expect(result.externalized.map(entry => entry.jsonPointer)).toEqual(['/sharedModel/extension']);
    expect(result.document.sharedModel.variables).toEqual(document.sharedModel.variables);
    store.configure('/project');
    expect(await materializeGenericProjectDataValues(JSON.parse(JSON.stringify(result.document)), store)).toEqual(document);
  });

  it('rejects conflicting metadata on a concurrent read of the same resource ID', async () => {
    const { store, readBinary } = memoryFiles();
    const ref = await store.put({ codec: 'utf8-v1', value: 'verified payload' });
    const conflicting: AilyDataRef = { $ailyData: { ...ref.$ailyData,
      rawLength: ref.$ailyData.rawLength + 1, storedLength: ref.$ailyData.storedLength + 1 } };
    store.configure('/project'); readBinary.calls.reset();
    const [valid, invalid] = await Promise.allSettled([store.resolve(ref), store.resolve(conflicting)]);
    expect(valid).toEqual({ status: 'fulfilled', value: 'verified payload' });
    expect(invalid.status).toBe('rejected');
    if (invalid.status === 'rejected') expect(invalid.reason.code).toBe('corrupt');
    expect(readBinary).toHaveBeenCalledTimes(1);
  });

  it('shares equivalent pending reads but returns detached byte buffers', async () => {
    const { store, readBinary } = memoryFiles();
    const ref = await store.put({ codec: 'utf8-v1', value: 'payload' });
    store.configure('/project'); readBinary.calls.reset();
    const [a, b] = await Promise.all([store.getCanonicalBytes(ref), store.getCanonicalBytes(structuredClone(ref))]);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(readBinary).toHaveBeenCalledTimes(1);
    a.fill(0); expect(await store.resolve(ref)).toBe('payload');
  });

  it('does not let a mutable caller reference rewrite cached storage or prepared metadata', async () => {
    const { store } = memoryFiles();
    const ref: any = await store.put({ codec: 'utf8-v1', value: 'payload' });
    const original = structuredClone(ref);
    const runtime: any = new (projectDataRuntime.constructor as any)();
    runtime.sessionId = 'test'; runtime.store = store;
    expect(await runtime.resolve(ref)).toBe('payload');
    ref.$ailyData.rawLength++; ref.$ailyData.storedLength++;
    await expectAsync(store.resolve(ref)).toBeRejectedWith(jasmine.objectContaining({ code: 'corrupt' }));
    await expectAsync(runtime.resolve(ref)).toBeRejectedWith(jasmine.objectContaining({ code: 'corrupt' }));
    expect(await runtime.resolve(original)).toBe('payload');
  });

  for (const layer of ['store', 'runtime']) it(`keeps an in-flight ${layer} read bound to its original metadata snapshot`, async () => {
    const { store } = memoryFiles();
    const ref: any = await store.put({ codec: 'utf8-v1', value: 'payload' });
    store.configure('/project');
    const runtime: any = new (projectDataRuntime.constructor as any)();
    runtime.sessionId = 'test'; runtime.store = store;
    const reader = layer === 'store' ? store : runtime;
    const pending = reader.resolve(ref);
    ref.$ailyData.rawLength++; ref.$ailyData.storedLength++;
    expect(await pending).toBe('payload');
    await expectAsync(reader.resolve(ref)).toBeRejectedWith(jasmine.objectContaining({ code: 'corrupt' }));
  });

  it('deduplicates payloads across pages, shared models and variables while retaining dedicated references', async () => {
    const { store, files, writeBinary } = memoryFiles();
    const payload = { samples: Array(10000).fill(12345) };
    const dedicated = await store.put({ codec: 'raw-binary-v1', value: new Uint8Array([0, 255]) });
    const source: any = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      $ailyProjectData: { schemaVersion: 1, mode: 'external-only' }, pages: [
        { id: 'main', title: 'Main', content: { blocks: { blocks: [{ type: 'opaque', id: 'b',
          fields: { DATA: payload, IMAGE: dedicated }, extraState: payload }] } } },
        { id: 'other', title: 'Other', content: { blocks: { blocks: [] }, serializer: payload } },
      ], sharedModel: { variables: [{ id: 'v', name: 'counter', type: 'int', extension: payload }],
        procedureBlocks: [{ id: 'f', type: 'function', extraState: payload }], extension: payload } };
    const runtime: any = { put: request => store.put(request), flushPending: () => store.flushPending(), getStore: () => store };
    const saved = await prepareBlocklySave(source, snapshot => snapshot, () => {}, runtime);
    const persisted = JSON.parse(saved.abiText), references = store.collectReferences(persisted);
    expect(new Set(references.map(ref => ref.$ailyData.id)).size).toBe(2); expect(files.size).toBe(2);
    expect(persisted.pages[0].content.blocks.blocks[0].fields.IMAGE).toEqual(dedicated);
    expect(saved.abiText.length).toBeLessThan(5000);
    expect(JSON.parse(saved.documentText)).toEqual(source);
    expect((await store.validateReferences(references)).valid).toBeTrue();
    const writes = writeBinary.calls.count();
    for (let round = 0; round < 3; round++) {
      store.configure('/project');
      expect(await materializeGenericProjectDataValues(JSON.parse(saved.abiText), store)).toEqual(source);
      expect(await store.resolve(dedicated)).toEqual(new Uint8Array([0, 255]));
    }
    expect(writeBinary.calls.count()).toBe(writes);
  });

  for (const fault of ['missing', 'hash', 'metadata', 'codec', 'schema']) {
    it(`fails a cold ${fault} resource read and unsaved query without writes or empty fallback`, async () => {
      const { store, files, writeBinary } = memoryFiles();
      const payload = '界😀'.repeat(5000), source = workspace(payload);
      const result = await externalizeGenericProjectDataValues(source, store);
      const ref = result.externalized[0].ref, path = store.resolveRefPath(ref);
      const bad: any = structuredClone(ref);
      if (fault === 'missing') files.delete(path);
      if (fault === 'hash') files.get(path)![files.get(path)!.length - 1] ^= 1;
      if (fault === 'metadata') { bad.$ailyData.rawLength++; bad.$ailyData.storedLength++; }
      if (fault === 'codec') bad.$ailyData.codec = 'unknown-v99';
      if (fault === 'schema') bad.$ailyData.schemaVersion = 99;
      (result.document.blocks.blocks[0].fields as any).PAYLOAD = { $ailyProjectDataValue: { schemaVersion: 1, ref: bad } };
      const disk = JSON.stringify(result.document), originalFs = window['fs'];
      store.configure('/project'); writeBinary.calls.reset();
      const codes: Record<string, string> = { missing: 'missing', hash: 'corrupt', metadata: 'corrupt', codec: 'unsupported-codec', schema: 'invalid-ref' };
      await expectAsync(store.resolve(bad)).toBeRejectedWith(jasmine.objectContaining({ code: codes[fault] }));
      const editor: any = { workspace: {}, getActivePageId: () => 'main', captureProjectSnapshot: () => ({ document: source, revision: 1 }),
        normalizeProjectAbi: value => value, getProjectAbiForSave: value => value };
      const project = new _ProjectService(editor, {} as any, {} as any); project.currentProjectPath = '/project';
      spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
      spyOn(projectDataRuntime, 'resolve').and.callFake(ref => store.resolve(ref));
      window['fs'] = { readFileSync: () => disk };
      try {
        await expectAsync(materializeGenericProjectDataValues(JSON.parse(disk), store)).toBeRejected();
        await expectAsync(project.hasUnsavedChanges()).toBeRejected();
        expect(writeBinary).not.toHaveBeenCalled();
      } finally { window['fs'] = originalFs; }
    });
  }
});
