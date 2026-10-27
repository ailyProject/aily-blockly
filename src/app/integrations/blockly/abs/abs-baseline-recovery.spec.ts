import * as Blockly from 'blockly';
import { AbsBaselineStore } from './abs-baseline-store';
import { inspectAbsGenerationForRecovery } from './abs-baseline-recovery';
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
        expect(result.recovery).toContain('project_recover(action="fork")');
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
