import { AbsBaselineStore, absBaselineKey, AbsGenerationInput, AbsSyncStoragePort, AbsSyncStorageAccess } from './abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { SerialOperationQueue } from '@shared/public-api';
import { AbsAbiWorkspace } from './abs-state';

/** A host-port model with real byte-hash CAS and serialized locking, plus fault injection. */
class MemoryHost implements AbsSyncStoragePort {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  failWrite: string | null = null;
  private readonly queue = new SerialOperationQueue();
  async read(key: string) { return this.files.get(key) ?? null; }
  withLock<T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>): Promise<T> { return this.queue.run(() => operation(this)); }
  async replace(key: string, expected: string | null, content: string | null) {
    if (key === this.failWrite) throw new Error(`injected write failure: ${key}`);
    const previous = await this.read(key);
    if ((previous === null ? null : await hashAbsText(previous)) !== expected) return false;
    this.writes.push(key);
    if (content === null) this.files.delete(key); else this.files.set(key, content);
    return true;
  }
}

describe('ABS immutable baseline and commit recovery', () => {
  const scope = { projectKey: 'project-a', pageId: 'main' };
  const assertCurrent = () => undefined;
  let host: MemoryHost;
  let store: AbsBaselineStore;
  let input: AbsGenerationInput;
  let save: jasmine.Spy;
  beforeEach(async () => {
    host = new MemoryHost();
    store = new AbsBaselineStore(host, scope);
    host.files.set('project.abi', '{"old":true}');
    host.files.set('project.abs', '# ABS Schema: 2\nroot(VALUE="edited")\r\n# exact input 😀');
    host.files.set('project.abs.map.json', '{"previous":true}');
    const workspace: AbsAbiWorkspace = { blocks: { blocks: [{ type: 'root', id: 'protected', deletable: false, fields: { VALUE: 'edited' } }] } };
    const abi = JSON.stringify(workspace, null, 2);
    input = {
      mode: 'import', inputAbs: await host.read('project.abs'), abi, expected: await store.captureDisk(),
      projection: await createAbsProjection(workspace, { document: { pages: [workspace], sharedModel: { keep: true } },
        generation: 'g1', baselineRef: absBaselineKey('g1'), scope, savedAbiHash: await hashAbsText(absJson(workspace)) }),
    };
    save = jasmine.createSpy('commitAbi').and.callFake(async (text, expected) => {
      if (!await host.replace('project.abi', expected, text)) throw new Error('ABI CAS conflict');
    });
  });

  it('retains exact input, full unsaved model and original projection without publishing or saving', async () => {
    await store.stage(input);
    const loaded = await store.load('g1');
    expect(loaded).toEqual(input.projection);
    loaded.workspace.blocks.blocks[0].id = 'mutated caller';
    expect((await store.load('g1')).workspace.blocks.blocks[0].id).toBe('protected');
    expect(JSON.parse(host.files.get(absBaselineKey('g1'))!).inputAbs).toBe(input.inputAbs);
    expect(await store.captureDisk()).toEqual(input.expected);
    expect(host.writes).toEqual([absBaselineKey('g1')]);
  });

  it('refuses generation overwrites and path traversal', async () => {
    await store.stage(input);
    input.inputAbs += '\n# new input';
    await expectAsync(store.stage(input)).toBeRejected();
    for (const id of ['../outside', 'C:/project', 'a/b', '', '..']) expect(() => absBaselineKey(id)).toThrow();
  });

  it('allows checksum-verified foreign-scope inspection but not load/apply authorization', async () => {
    await store.stage(input); await store.commit('g1', assertCurrent, save);
    const foreign = new AbsBaselineStore(host, { projectKey: 'copy', pageId: 'other' });
    const before = [...host.files], inspected = await foreign.inspectCommitted();
    expect(inspected!.projection).toEqual(input.projection);
    expect(inspected!.pointerHash).toBe(await hashAbsText(host.files.get('committed.json')!));
    await expectAsync(foreign.loadCommitted()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    await expectAsync(foreign.commit('g1', assertCurrent, save)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    expect([...host.files]).toEqual(before);
  });

  it('pins the committed pointer before staging and checks exact recovery map bytes', async () => {
    const before = [...host.files];
    await expectAsync(store.stage(input, 'sha256:' + '0'.repeat(64))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_STALE' }));
    expect([...host.files]).toEqual(before);
    await expectAsync(store.stage({ ...input, inputMap: 'not original' })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_INVALID' }));
    expect([...host.files]).toEqual(before);
    await store.stage({ ...input, inputMap: input.expected.map }, null);
    expect(JSON.parse(host.files.get(absBaselineKey('g1'))!).inputMap).toBe(input.expected.map);
  });

  it('saves ABI before mirrors and commits only after both are published', async () => {
    await store.stage(input);
    expect(await store.commit('g1', assertCurrent, save)).toEqual({
      status: 'COMMITTED', generation: 'g1', abiSaved: true, absMirrored: true, mapPublished: true,
    });
    expect(host.writes).toEqual([absBaselineKey('g1'), 'prepared.json', 'project.abi', 'project.abs',
      'project.abs.map.json', 'committed.json', 'prepared.json']);
    expect(await store.recover(assertCurrent)).toBeNull();
  });

  it('uses the callback-scoped capability for every locked read/write and the ABI commit', async () => {
    let held = false;
    const scoped: AbsSyncStorageAccess = {
      read: key => host.read(key), replace: (key, expected, content) => host.replace(key, expected, content),
    };
    const port: AbsSyncStoragePort = {
      read: key => { if (held) throw new Error('unscoped read inside lock'); return host.read(key); },
      withLock: async operation => {
        if (held) throw new Error('nested lock');
        held = true;
        try { return await operation(scoped); } finally { held = false; }
      },
    };
    store = new AbsBaselineStore(port, scope);
    await store.stage(input);
    const result = await store.commit('g1', assertCurrent, async (text, expected, capability) => {
      expect(capability).toBe(scoped); expect(held).toBeTrue();
      expect(await capability.replace('project.abi', expected, text)).toBeTrue();
    });
    expect(result.status).toBe('COMMITTED');
    expect(await store.recover(assertCurrent)).toBeNull();
    expect(await store.load('g1')).toEqual(input.projection);
  });

  it('selects a committed baseline from the verified private pointer, never the public map', async () => {
    await store.stage(input); expect(await store.loadCommitted()).toBeNull();
    await store.commit('g1', assertCurrent, save);
    host.files.set('project.abs.map.json', '{"generation":"forged"}');
    expect(await store.loadCommitted()).toEqual(input.projection);
    const pointer = JSON.parse(host.files.get('committed.json')!); pointer.hash = 'sha256:' + '0'.repeat(64);
    host.files.set('committed.json', JSON.stringify(pointer));
    await expectAsync(store.loadCommitted()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_CORRUPT' }));
  });

  it('inspects pending state without saving, publishing, deleting, or repairing files', async () => {
    expect(await store.inspectPending()).toBeNull(); await store.stage(input);
    host.failWrite = 'project.abs'; await store.commit('g1', assertCurrent, save);
    const files = [...host.files], writes = [...host.writes];
    expect(await store.inspectPending()).toEqual(jasmine.objectContaining({ mode: 'import', status: 'MIRROR_PENDING', abiSaved: true }));
    expect([...host.files]).toEqual(files); expect(host.writes).toEqual(writes); expect(save.calls.count()).toBe(1);
  });

  it('read-only diagnosis rejects damaged prepared records and retains the evidence', async () => {
    await store.stage(input); save.and.rejectWith(new Error('disk full')); await store.commit('g1', assertCurrent, save);
    expect((await store.inspectPending())!.status).toBe('NOT_COMMITTED');
    host.files.set('prepared.json', '{}');
    await expectAsync(store.inspectPending()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_CORRUPT' }));
    expect(host.files.get('prepared.json')).toBe('{}'); expect(host.files.has('baselines/g1.json')).toBeTrue();
  });

  for (const file of ['project.abs', 'project.abs.map.json', 'committed.json']) {
    it(`recovers after ${file} write failure without applying or saving input twice`, async () => {
      await store.stage(input);
      host.failWrite = file;
      const result = await store.commit('g1', assertCurrent, save);
      expect(result.status).toBe('MIRROR_PENDING');
      expect(result.abiSaved).toBeTrue();
      host.failWrite = null;
      store = new AbsBaselineStore(host, scope); // No in-memory stage/revision survives a restart.
      expect((await store.recover(assertCurrent))?.status).toBe('COMMITTED');
      expect(save.calls.count()).toBe(1);
    });
  }

  it('distinguishes precommit failure and permits explicit cancellation without deleting input', async () => {
    await store.stage(input);
    save.and.rejectWith(new Error('disk full'));
    expect((await store.commit('g1', assertCurrent, save)).status).toBe('NOT_COMMITTED');
    expect((await store.recover(assertCurrent))?.status).toBe('NOT_COMMITTED');
    await expectAsync(store.commit('g1', assertCurrent, save)).toBeRejected();
    await store.abandon('g1');
    expect(await store.captureDisk()).toEqual(input.expected);
    expect(host.files.has(absBaselineKey('g1'))).toBeTrue();
  });

  it('detects an ABI commit that succeeded even when the save callback threw', async () => {
    await store.stage(input);
    save.and.callFake(async (text, expected) => {
      await host.replace('project.abi', expected, text);
      throw new Error('post-save code generation failed');
    });
    expect((await store.commit('g1', assertCurrent, save)).status).toBe('MIRROR_PENDING');
    expect((await store.recover(assertCurrent))?.status).toBe('COMMITTED');
    expect(save.calls.count()).toBe(1);
  });

  it('keeps a new Agent edit after partial publication and reports conflict', async () => {
    await store.stage(input);
    host.failWrite = 'project.abs.map.json';
    await store.commit('g1', assertCurrent, save);
    host.failWrite = null;
    host.files.set('project.abs', 'newer user input');
    expect((await store.recover(assertCurrent))?.status).toBe('CONFLICT');
    expect(host.files.get('project.abs')).toBe('newer user input');
    expect(host.files.get('project.abi')).toBe(input.abi!);
    expect(host.files.has('prepared.json')).toBeTrue();
  });

  it('rejects dual edits before saving or publishing a journal', async () => {
    await store.stage(input);
    host.files.set('project.abi', '{"external":true}');
    expect((await store.commit('g1', assertCurrent, save)).status).toBe('CONFLICT');
    expect(save).not.toHaveBeenCalled();
    expect(host.files.has('prepared.json')).toBeFalse();
  });

  it('never starts ABI saving if the prepared journal cannot be written', async () => {
    await store.stage(input);
    host.failWrite = 'prepared.json';
    await expectAsync(store.commit('g1', assertCurrent, save)).toBeRejected();
    expect(save).not.toHaveBeenCalled();
    expect(await store.captureDisk()).toEqual(input.expected);
  });

  it('retains the journal when another saved ABI replaces the committed candidate', async () => {
    await store.stage(input);
    host.failWrite = 'project.abs';
    await store.commit('g1', assertCurrent, save);
    host.failWrite = null;
    host.files.set('project.abi', '{"newer":true}');
    expect((await store.recover(assertCurrent))?.status).toBe('CONFLICT');
    expect(host.files.has('prepared.json')).toBeTrue();
    expect(host.files.get('project.abs')).toBe(input.expected.abs!);
  });

  it('exports an unsaved project without silently creating project.abi', async () => {
    host.files.delete('project.abi');
    input.mode = 'export';
    input.abi = null;
    input.expected.abi = null;
    input.projection.map.savedAbiHash = null;
    await store.stage(input);
    const result = await store.commit('g1', assertCurrent, save);
    expect(result.status).toBe('COMMITTED');
    expect(result.abiSaved).toBeFalse();
    expect(save).not.toHaveBeenCalled();
    expect(host.files.has('project.abi')).toBeFalse();
  });

  it('refuses corrupt/missing baselines and cross-project reuse', async () => {
    await expectAsync(store.load('missing')).toBeRejected();
    await store.stage(input);
    await expectAsync(new AbsBaselineStore(host, { ...scope, projectKey: 'other' }).load('g1')).toBeRejected();
    host.failWrite = 'project.abs';
    await store.commit('g1', assertCurrent, save);
    host.failWrite = null;
    const key = absBaselineKey('g1');
    const record = JSON.parse(host.files.get(key)!);
    record.inputAbs = 'tampered';
    host.files.set(key, absJson(record));
    await expectAsync(store.recover(assertCurrent)).toBeRejected();
  });

  it('does not write mirrors after the host context changes following ABI commit', async () => {
    await store.stage(input);
    let current = true;
    save.and.callFake(async (text, expected) => { await host.replace('project.abi', expected, text); current = false; });
    const result = await store.commit('g1', () => { if (!current) throw new Error('new runtime'); }, save);
    expect(result.status).toBe('MIRROR_PENDING');
    expect(result.abiSaved).toBeTrue();
    expect(host.files.get('project.abs')).toBe(input.expected.abs!);
  });
});
