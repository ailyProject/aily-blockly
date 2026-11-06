import * as Blockly from 'blockly';
import { AbsBaselineStore } from './abs-baseline-store';
import { inspectAbsBaselineRecovery, inspectAbsGenerationForRecovery, recoverAbsBaseline, recoverAbsLocationMetadata } from './abs-baseline-recovery';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

describe('private baseline recovery diagnosis', () => {
  for (const mode of ['committed-corrupt', 'prepared-corrupt', 'baseline-missing']) {
    it(`offers preserving recovery for ${mode} without writing or granting a generation`, async () => {
      const scope = { projectKey: '/isolated/baseline-recovery', pageId: 'main' };
      const files = new Map<string, string>();
      const read = async (key: string) => files.get(key) ?? null;
      let writes = 0;
      const store = new AbsBaselineStore({ read, withLock: async operation => operation({ read,
        replace: async (key, expected, value) => {
          const before = await read(key);
          if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
          writes++; if (value === null) files.delete(key); else files.set(key, value); return true;
        } }) }, scope);
      const workspace = { blocks: { blocks: [{ type: 'math_number', id: 'keep-id',
        fields: { NUM: 7 }, disabledReasons: ['MANUALLY_DISABLED'], collapsed: true, deletable: false }] } };
      const projection = await createAbsProjection(workspace, { generation: 'baseline-g1', scope,
        baselineRef: 'baselines/baseline-g1.json', document: workspace,
        savedAbiHash: await hashAbsText(absJson(workspace)) });
      files.set('project.abi', absJson(workspace)); files.set('project.abs', 'old source');
      await store.stage({ projection, mode: 'import', abi: absJson(workspace), inputAbs: 'old source', expected: await store.captureDisk() });
      await store.commit('baseline-g1', () => {}, async () => {});
      if (mode === 'baseline-missing') files.delete('baselines/baseline-g1.json');
      else files.set(mode === 'committed-corrupt' ? 'committed.json' : 'prepared.json', '{broken');
      const before = [...files], beforeWrites = writes;
      const native = new Blockly.Workspace();
      const sync = new AbsWorkspaceSyncService({} as any, {} as any);
      (sync as any).context = () => ({ scope, workspace: native, assertCurrent() {} });
      (sync as any).store = async () => store;
      try {
        const result: any = await new AbsGenerationToolsService(sync).execute('abs_recovery',
          { version: 2, requestId: 'baseline-recovery-' + mode, action: 'inspect' });
        expect(result.ok).toBeFalse();
        expect(result.code).toBe(mode === 'baseline-missing' ? 'ABS_BASELINE_MISSING' : 'ABS_BASELINE_CORRUPT');
        expect(result.diagnostic.reason).toBe('baseline-unavailable');
        expect(result.recovery).toContain('same-project preserving recovery');
        expect(result.recovery).not.toContain('action="fork"');
        expect(result.recovery).toContain('Do not delete locks/baselines');
        expect(result.receipt).toBeUndefined(); expect(result.generation).toBeUndefined();
        expect(result.publication).toBeUndefined();
        expect([...files]).toEqual(before); expect(writes).toBe(beforeWrites);
      } finally { native.dispose(); }
    });
  }

  it('does not promote forged codes or unrelated inspection failures into recovery facts', async () => {
    for (const error of [Object.assign(new Error('third-party callback'), { code: 'ABS_BASELINE_CORRUPT' }),
      new AbsSyncError('ABS_BASELINE_STALE', 'changed during inspection'), new Error('unreadable disk')]) {
      let failure: unknown;
      try { await inspectAbsGenerationForRecovery({ captureDisk: async () => { throw error; } } as any,
        { projectKey: '/isolated/baseline-recovery', pageId: 'main' }); }
      catch (caught) { failure = caught; }
      expect(failure).toBe(error);
      expect((failure as any).diagnostic).toBeUndefined();
    }
  });
});

describe('automatic location metadata recovery', () => {
  const oldScope = { projectKey: '/original/project', pageId: 'main' };
  const movedScope = { projectKey: '/moved/project', pageId: 'main' };
  const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'main', content: { blocks: { blocks: [{ id: 'keep', type: 'math_number',
      fields: { NUM: 7 }, icons: { comment: { text: 'keep comment' } } }] } } }], sharedModel: { procedureBlocks: [] } };
  async function fixture() {
    const files = new Map<string, string>();
    const read = async (key: string) => files.get(key) ?? null;
    const port = { read, withLock: async <T>(operation: (storage: any) => Promise<T>) => operation({ read,
      replace: async (key: string, expected: string | null, value: string | null) => {
        const before = await read(key);
        if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
        if (value === null) files.delete(key); else files.set(key, value); return true;
      } }) };
    const generation = 'original-intent', store = new AbsBaselineStore(port, oldScope), abi = JSON.stringify(document);
    const projection = await createAbsProjection(document.pages[0].content, { generation, scope: oldScope,
      baselineRef: `baselines/${generation}.json`, document, savedAbiHash: await hashAbsText(absJson(document)) });
    await store.stage({ projection, mode: 'import', abi, inputAbs: projection.abs, expected: await store.captureDisk() });
    await store.commit(generation, () => {}, async (text, hash, storage) => {
      if (!await storage.replace('project.abi', hash, text)) throw new Error('CAS');
    });
    return { files, port, generation, store, projection, abi };
  }
  it('executes the exact same-project offer for a moved complete source and retains original intent', async () => {
    const f = await fixture(), original = f.files.get('baselines/original-intent.json');
    const offer = await inspectAbsBaselineRecovery(f.port, movedScope.projectKey);
    expect(offer).toEqual(jasmine.objectContaining({ action: 'recover_project', sameProject: true, source: 'public-generation' }));
    const result = await recoverAbsBaseline(f.port, movedScope.projectKey, () => {});
    expect(result.changed).toBeTrue();
    const moved = new AbsBaselineStore(f.port, movedScope), current = (await moved.loadCommitted())!;
    expect(current.map.scope).toEqual(movedScope); expect(current.map.generation).not.toBe(f.generation);
    expect(f.files.get('project.abi')).toBe(f.abi); expect(f.files.get('project.abs')).toBe(f.projection.abs);
    expect(f.files.get('baselines/original-intent.json')).toBe(original);
    await expectAsync(moved.load(f.generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    const intent = await moved.loadIntent(f.generation);
    expect(intent.map.generation).toBe(f.generation); expect(intent.map.scope).toEqual(movedScope);
    expect(intent.document).toEqual(document); expect(intent.abs).toBe(f.projection.abs);
  });
  it('automatically repairs location once and leaves ordinary valid entrypoints unchanged', async () => {
    const f = await fixture();
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    const after = [...f.files];
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    expect([...f.files]).toEqual(after);
    expect([...f.files.keys()].filter(key => key.startsWith('recoveries/baseline-')).length).toBe(1);
  });
  for (const broken of [null, '{invalid']) {
    it(`repairs an ${broken === null ? 'absent' : 'invalid'} public map from the complete verified saved source`, async () => {
      const f = await fixture();
      if (broken === null) f.files.delete('project.abs.map.json'); else f.files.set('project.abs.map.json', broken);
      await recoverAbsLocationMetadata(f.port, oldScope, () => {});
      expect((await new AbsBaselineStore(f.port, oldScope).loadCommitted())!.document).toEqual(document);
      expect(f.files.get('project.abi')).toBe(f.abi); expect(f.files.get('project.abs')).toBe(f.projection.abs);
    });
  }
  it('does not rebind an unproven draft or a competing complete primary', async () => {
    for (const key of ['project.abs', 'project.abi']) {
      const f = await fixture();
      f.files.set(key, key.endsWith('.abs') ? f.projection.abs + '\n# unapplied draft' : f.abi.replace('"NUM":7', '"NUM":8'));
      if (key === 'project.abs') f.files.set('project.abs.map.json', '{unproven draft origin}');
      const before = [...f.files];
      expect(await inspectAbsBaselineRecovery(f.port, movedScope.projectKey)).toBeNull();
      await recoverAbsLocationMetadata(f.port, movedScope, () => {});
      await expectAsync(recoverAbsBaseline(f.port, movedScope.projectKey, () => {})).toBeRejected();
      expect([...f.files]).toEqual(before);
    }
  });

  it('preserves a known pending draft while automatically rebinding its complete saved source', async () => {
    const f = await fixture(), draft = f.projection.abs + '\n# retained pending edit'; f.files.set('project.abs', draft);
    expect(await inspectAbsBaselineRecovery(f.port, movedScope.projectKey)).not.toBeNull();
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    const moved = new AbsBaselineStore(f.port, movedScope), current = (await moved.loadCommitted())!;
    expect(f.files.get('project.abi')).toBe(f.abi); expect(f.files.get('project.abs')).toBe(f.projection.abs);
    const retained = await moved.readArchivedDraft(current.map.generation);
    expect(retained.abs).toBe(draft); expect(retained.baseGeneration).toBe(f.generation);
    expect((await moved.loadIntent(f.generation)).map.generation).toBe(f.generation);
  });
  it('never starts another metadata publication while an original transaction is pending', async () => {
    const f = await fixture(); f.files.set('prepared.json', '{original pending}'); const before = [...f.files];
    expect(await inspectAbsBaselineRecovery(f.port, movedScope.projectKey)).toBeNull();
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    await expectAsync(recoverAbsBaseline(f.port, movedScope.projectKey, () => {}))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_TRANSACTION_PENDING' }));
    expect([...f.files]).toEqual(before);
  });
  it('keeps a concurrent writer when files change after source classification', async () => {
    const f = await fixture(); let mutate = true;
    const raced = { read: f.port.read, withLock: async <T>(operation: (storage: any) => Promise<T>) => {
      if (mutate) { mutate = false; f.files.set('project.abi', f.abi.replace('"NUM":7', '"NUM":9')); }
      return f.port.withLock(operation);
    } };
    await expectAsync(recoverAbsLocationMetadata(raced, movedScope, () => {}))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DISK_CONFLICT' }));
    expect(JSON.parse(f.files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.NUM).toBe(9);
    expect(JSON.parse(f.files.get('project.abs.map.json')!).scope).toEqual(oldScope);
  });
  it('cannot admit an unrelated staged generation as a relocated original intent', async () => {
    const f = await fixture();
    const staged = await createAbsProjection(document.pages[0].content, { generation: 'uncommitted-intent', scope: oldScope,
      baselineRef: 'baselines/uncommitted-intent.json', document, savedAbiHash: await hashAbsText(absJson(document)) });
    await f.store.stage({ projection: staged, mode: 'import', abi: f.abi, inputAbs: staged.abs, expected: await f.store.captureDisk() });
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    const before = [...f.files];
    await expectAsync(new AbsBaselineStore(f.port, movedScope).loadIntent('uncommitted-intent'))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    expect([...f.files]).toEqual(before);
  });

  it('does not treat an ordinary cross-scope commit as metadata recovery authority', async () => {
    const f = await fixture(), moved = new AbsBaselineStore(f.port, movedScope);
    const projection = await createAbsProjection(document.pages[0].content, { generation: 'ordinary-new-scope', scope: movedScope,
      baselineRef: 'baselines/ordinary-new-scope.json', document, savedAbiHash: await hashAbsText(absJson(document)) });
    await moved.stage({ projection, mode: 'import', abi: f.abi, inputAbs: projection.abs, expected: await moved.captureDisk() });
    await moved.commit(projection.map.generation, () => {}, async (text, hash, storage) => {
      if (!await storage.replace('project.abi', hash, text)) throw new Error('CAS');
    });
    const before = [...f.files];
    await expectAsync(moved.loadIntent(f.generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    expect([...f.files]).toEqual(before);
  });

  it('verifies every original checksum when discovering a migrated intent', async () => {
    const f = await fixture(); await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    const key = 'baselines/original-intent.json'; f.files.set(key, f.files.get(key)! + ' ');
    const before = [...f.files];
    await expectAsync(new AbsBaselineStore(f.port, movedScope).loadIntent(f.generation))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_CORRUPT' }));
    expect([...f.files]).toEqual(before);
  });

  it('keeps a damaged uncommitted state diagnostic while automatic probing grants no repair', async () => {
    const f = await fixture(); f.files.delete('committed.json');
    f.files.set('project.abs', f.projection.abs.slice(0, -10)); const before = [...f.files];
    await recoverAbsLocationMetadata(f.port, movedScope, () => {});
    expect([...f.files]).toEqual(before);
    await expectAsync(recoverAbsBaseline(f.port, movedScope.projectKey, () => {}))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STATE_INVALID' }));
    expect([...f.files]).toEqual(before);
  });
});
