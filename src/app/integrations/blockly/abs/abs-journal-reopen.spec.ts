import { AbsJournalReopenAdmission, type AbsJournalReopenObservation } from './abs-journal-reopen';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';

describe('equal-canvas exact journal reopen', () => {
  const scope = { projectKey: 'journal-project', pageId: 'main' };
  const observation = (): AbsJournalReopenObservation => ({ scope, generation: 'g1', pointerHash: 'pointer',
    hashes: { abi: 'abi', abs: 'abs', map: 'map' }, canvasHash: 'complete-canvas', revision: 2, runtimeRevision: 3 });

  it('offers only a just-recovered journal and consumes one exact observation', async () => {
    const gate = new AbsJournalReopenAdmission();
    expect(await gate.offer(observation())).toBeUndefined();
    gate.remember('g1', 'original-journal-token');
    const cap = (await gate.offer(observation()))!;
    gate.consume(cap.generation, cap.token, observation());
    expect(() => gate.consume(cap.generation, cap.token, observation())).toThrow();
  });

  it('rejects changed canvas/runtime/scope/pointer/mirrors and expired tokens; fresh inspect can offer again', async () => {
    for (const field of ['canvasHash', 'revision', 'runtimeRevision', 'scope', 'pointerHash', 'hashes', 'generation']) {
      const gate = new AbsJournalReopenAdmission(); gate.remember('g1', 'journal');
      const cap = (await gate.offer(observation()))!, changed = observation();
      (changed as any)[field] = field === 'scope' ? { ...scope, projectKey: 'foreign' }
        : field === 'hashes' ? { ...changed.hashes, abi: 'changed' } : field.includes('evision') ? 4 : 'changed';
      expect(() => gate.consume(cap.generation, cap.token, changed)).toThrow();
    }
    let now = 0;
    const gate = new AbsJournalReopenAdmission(() => now); gate.remember('g1', 'journal');
    const expired = (await gate.offer(observation()))!; now = 300_001;
    expect(() => gate.consume(expired.generation, expired.token, observation())).toThrow();
    const fresh = (await gate.offer(observation()))!; gate.consume(fresh.generation, fresh.token, observation());
  });

  async function fixture() {
    const files = new Map<string, string>();
    const port: AbsSyncStoragePort = { read: async key => files.get(key) ?? null,
      withLock: async action => action({ read: async key => files.get(key) ?? null,
        replace: async (key, expected, value) => {
          if ((files.has(key) ? await hashAbsText(files.get(key)!) : null) !== expected) return false;
          if (value === null) files.delete(key); else files.set(key, value); return true;
        } }) };
    const store = new AbsBaselineStore(port, scope);
    const document = { schemaVersion: 3, pages: [{ id: 'main', content: { blocks: { blocks: [
      { type: 'root', id: 'r', disabledReasons: ['MANUALLY_DISABLED'], collapsed: true, inputsInline: false },
    ] } } }, { id: 'other', content: { blocks: { blocks: [] } } }] };
    const workspace = document.pages[0].content;
    const projection = await createAbsProjection(workspace, { document, generation: 'g1', scope,
      baselineRef: 'baselines/g1.json', savedAbiHash: await hashAbsText(absJson(document)) });
    files.set('project.abi', absJson(document)); files.set('project.abs', 'old-source');
    await store.stage({ projection, mode: 'import', abi: absJson(document), inputAbs: 'old-source', expected: await store.captureDisk() });
    await store.commit('g1', () => {}, async () => {});
    let current = structuredClone(document), active = true, blocked = true;
    const root = window.document.createElement('div'), svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    root.appendChild(svg); window.document.body.appendChild(root);
    const context = { path: scope.projectKey, scope, runtimeRevision: 3,
      workspace: { getParentSvg: () => svg }, assertCurrent: () => { if (!active) throw new Error('old activation'); } };
    const editor = { captureRecoverySnapshot: () => ({ document: current, revision: 2, documentText: absJson(current) }),
      normalizeProjectAbi: value => value, getProjectAbiForSave: value => value, isWorkspaceEditBlocked: () => blocked };
    const service = new AbsWorkspaceSyncService(editor as any, {} as any);
    (service as any).context = () => context; (service as any).store = async () => store;
    (service as any).journalReopen.remember('g1', 'recovered-token');
    return { service, files, root, current, context,
      activate: () => { blocked = false; }, mutate: () => { current.pages[0].content.blocks.blocks[0].collapsed = false; },
      stale: () => { active = false; } };
  }

  let libraries: unknown;
  beforeEach(() => { libraries = window['libraryDependencies']; window['libraryDependencies'] = { status: async () => ({ dirty: false, busy: false }) }; });
  afterEach(() => { window['libraryDependencies'] = libraries; });

  it('reads quarantined full state without mutation and fences input through activation/verification', async () => {
    const f = await fixture(), before = [...f.files];
    try {
      const offer = (await f.service.inspectGeneration()).diagnostics['reopen'];
      expect(offer?.generation).toBe('g1');
      const tools = new AbsGenerationToolsService(f.service);
      let activationCalls = 0;
      const result = await tools.execute('abs_recovery', { version: 2, requestId: 'reopen-request-00000001', action: 'reopen', ...offer }, undefined, undefined,
        async (path, guard) => {
          activationCalls++; guard();
          const event = new Event('pointerdown', { bubbles: true, cancelable: true }); f.root.dispatchEvent(event);
          expect(event.defaultPrevented).toBeTrue(); f.activate(); return { project: path, activated: true };
        });
      expect(result.ok).toBeTrue(); expect(activationCalls).toBe(1); expect([...f.files]).toEqual(before);
      const event = new Event('pointerdown', { bubbles: true, cancelable: true }); f.root.dispatchEvent(event);
      expect(event.defaultPrevented).toBeFalse();
      // Treat the first response as lost. Fresh inspection can observe its
      // exact completed activation without another lifecycle operation.
      const observedOffer = (await f.service.inspectGeneration()).diagnostics['reopen'];
      expect(observedOffer.reused).toBeTrue();
      const observed = await tools.execute('abs_recovery', { version: 2, requestId: 'reopen-request-00000002', action: 'reopen', ...observedOffer }, undefined, undefined,
        async () => { activationCalls++; return { project: '', activated: false }; });
      expect(observed.ok).toBeTrue(); expect((observed as any).reused).toBeTrue();
      expect(activationCalls).toBe(1);
      f.mutate();
      expect(await f.service.observeJournalReopen(offer.generation, offer.token)).toBeUndefined();
      await expectAsync(f.service.beginJournalReopen(offer.generation, offer.token)).toBeRejected();
    } finally { f.root.remove(); }
  });

  it('does not offer reload when hidden state/another page or dependencies differ', async () => {
    const f = await fixture();
    try {
      f.mutate(); const result = await f.service.inspectGeneration();
      expect(result.diagnostics['reopen']).toBeUndefined();
      expect(result.diagnostics['reopenBlocked'].code).toBe('ABS_JOURNAL_REOPEN_CANVAS_DIVERGED');
      window['libraryDependencies'] = { status: async () => ({ dirty: true, busy: false }) };
      expect((await f.service.inspectGeneration()).diagnostics['reopen']).toBeUndefined();
    } finally { f.root.remove(); }
  });

  it('rejects a canvas edit after inspection before activation and leaves project files untouched', async () => {
    const f = await fixture(), before = [...f.files];
    try {
      const cap = (await f.service.inspectGeneration()).diagnostics['reopen']; f.mutate();
      await expectAsync(f.service.beginJournalReopen(cap.generation, cap.token)).toBeRejected();
      expect([...f.files]).toEqual(before);
    } finally { f.root.remove(); }
  });

  it('reports UNKNOWN and never overwrites an external mirror change during lifecycle activation', async () => {
    const f = await fixture();
    try {
      const cap = (await f.service.inspectGeneration()).diagnostics['reopen'];
      const result = await new AbsGenerationToolsService(f.service).execute('abs_recovery', {
        version: 2, requestId: 'reopen-request-00000003', ...cap,
      }, undefined, undefined, async (path, guard) => {
        guard(); f.files.set('project.abs', 'externally changed during lifecycle'); f.activate();
        return { project: path, activated: true };
      });
      expect(result.ok).toBeFalse(); expect((result as any).publication.status).toBe('UNKNOWN');
      expect(f.files.get('project.abs')).toBe('externally changed during lifecycle');
      expect(await f.service.observeJournalReopen(cap.generation, cap.token)).toBeUndefined();
    } finally { f.root.remove(); }
  });
});
