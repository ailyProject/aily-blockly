import { absMapJson } from './abs-map-json';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';

/** Actual Bridge + tools + immutable reader composition. The storage boundary
 * is an in-memory fixture and native synchronization is controlled: these are
 * protocol tests, not an Electron, physical-root or native readback oracle. */
describe('R3 Working candidate real bridge receipt composition', () => {
  const project = '/isolated/r3-working-bridge', fingerprint = 'a'.repeat(64);
  let previousFs: any;

  beforeEach(() => { previousFs = window['fs']; });
  afterEach(() => { window['fs'] = previousFs; });

  async function fixture() {
    const scope = { projectKey: project, pageId: 'main' };
    const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'Working', content: { blocks: { blocks: [
        { id: 'number', type: 'math_number', fields: { NUM: 100 }, data: 'retained opaque' },
      ] } } }], sharedModel: { variables: [], procedureBlocks: [] } };
    const projection = await createAbsProjection(composeBlocklyPage(document, 'main'), { document, scope,
      generation: 'frozen-working', baselineRef: 'working-original', savedAbiHash: null,
      contracts: { fields: { number: { NUM: { type: 'field_number' } } } } });
    const attachment = { version: 1, root: project, identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
    const files = new Map<string, string>(), reads: string[] = [];
    const put = async (text: string) => {
      const hash = (await hashAbsText(text)).slice(7); files.set(`history-objects/${hash}`, text);
      return { hash, bytes: new TextEncoder().encode(text).length };
    };
    const record = { version: 1, kind: 'agent', id: '11111111-1111-4111-8111-111111111111',
      owner: { sessionId: 'original-session', intentAnchorId: 'original-intent' },
      project: { logicalId: (await hashAbsText(project)).slice(7), attachment },
      scope: { kind: 'pages', pageIds: ['main'] }, base: {
        document: await put(absJson(projection.document)), abs: await put(projection.abs), map: await put(absMapJson(projection.map)),
        contracts: await put(absJson(projection.contracts)), published: null }, source: await put(projection.abs),
      derivation: { kind: 'capture' }, intent: { anchorId: 'original-intent' } };
    const stored = await put(absJson(record));
    const workingCandidate = { version: 1, id: record.id, revisionHash: stored.hash };
    const request = { version: 2, requestId: crypto.randomUUID(), workingCandidate,
      candidate: { hash: await hashAbsText(projection.abs), bytes: new TextEncoder().encode(projection.abs).length } };
    const lock = jasmine.createSpy('no candidate re-archive').and.callFake(() => {
      throw new Error('A fixed immutable candidate must not start a legacy archive write');
    });
    window['fs'] = { projectSyncStorageVersion: 2,
      openProjectSyncStorage: async (_path: string, guard: () => void) => ({ attachment,
        read: async (key: string) => { guard(); reads.push(key); return files.get(key) ?? null; }, withLock: lock }) } as any;
    const sync: any = Object.create(AbsWorkspaceSyncService.prototype);
    sync.context = () => ({ path: project, scope, assertCurrent: () => {} });
    let ready = false;
    sync.validateGeneration = jasmine.createSpy('controlled native validation').and.callFake(async (_source: string, bound: any) => {
      expect(ready).toBeTrue();
      return { ...bound, workspaceRevision: 7, syntaxAdvice: {} };
    });
    sync.describeNativeCandidateFailure = async () => undefined;
    sync.applyGeneration = jasmine.createSpy('controlled native application');
    const tools = new AbsGenerationToolsService(sync);
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.absGenerationTools = tools;
    bridge.projectService = { currentProjectPath: project,
      ensureBlocklyLibraryRuntimeReady: jasmine.createSpy('actual runtime admission').and.callFake(async () => { ready = true; }),
      getBlocklyLibraryRuntimeFingerprint: jasmine.createSpy('runtime fingerprint').and.resolveTo(fingerprint) };
    bridge.ngZone = { runOutsideAngular: (run: () => unknown) => run() };
    bridge.emitLiveOperationProgress = () => {};
    return { bridge, tools, sync, request, source: projection.abs, projection, workingCandidate, lock, reads };
  }

  it('prepares runtime for a fixed ref and attaches the real bridge fingerprint without a legacy archive', async () => {
    const f = await fixture();
    const result = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.workingCandidate).toEqual(f.workingCandidate);
    expect(result.receipt.libraryRuntimeFingerprint).toBe(fingerprint);
    expect(result.receipt.base.generation).toBe('frozen-working');
    expect(f.bridge.projectService.ensureBlocklyLibraryRuntimeReady).toHaveBeenCalledTimes(1);
    expect(f.sync.validateGeneration).toHaveBeenCalledTimes(1);
    expect(f.lock).not.toHaveBeenCalled(); expect(result.candidateArchive).toBeUndefined();
    expect(f.reads.every(key => /^history-objects\/[a-f0-9]{64}$/.test(key))).toBeTrue();
  });

  it('retains the fixed ref when runtime admission fails and does not begin native validation', async () => {
    const f = await fixture();
    f.bridge.projectService.ensureBlocklyLibraryRuntimeReady.and.rejectWith(new AbsSyncError('ABS_RUNTIME_NOT_READY', 'fixture runtime unavailable'));
    const result = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_RUNTIME_NOT_READY');
    expect(f.sync.validateGeneration).not.toHaveBeenCalled(); expect(f.lock).not.toHaveBeenCalled();
    expect(f.request.workingCandidate).toEqual(f.workingCandidate);
  });

  it('does not bless a preparation with a later runtime fingerprint', async () => {
    const f = await fixture(); let queries = 0;
    f.bridge.projectService.getBlocklyLibraryRuntimeFingerprint.and.callFake(async () => ++queries === 1 ? fingerprint : 'b'.repeat(64));
    const result = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_RUNTIME_CONTRACT_STALE');
    expect(result.receipt).toBeUndefined(); expect(f.sync.validateGeneration).toHaveBeenCalledTimes(1);
    expect(f.lock).not.toHaveBeenCalled();
  });

  it('rejects a changed source body against the old exact ref before runtime or native preparation', async () => {
    const f = await fixture(), source = f.source + '\n// a different immutable revision';
    const result = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: source,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).length } });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_CANDIDATE_OBJECT_INVALID');
    expect(f.bridge.projectService.ensureBlocklyLibraryRuntimeReady).not.toHaveBeenCalled();
    expect(f.sync.validateGeneration).not.toHaveBeenCalled(); expect(f.lock).not.toHaveBeenCalled();
  });

  it('keeps the immutable base page when the caller currently displays a different page', async () => {
    const f = await fixture();
    f.sync.context = () => ({ path: project, scope: { projectKey: project, pageId: 'another-visible-page' }, assertCurrent: () => {} });
    const result = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.base.scope.pageId).toBe('main');
    expect(result.receipt.workingCandidate).toEqual(f.workingCandidate);
  });

  it('a new ref with equal source bytes cannot consume the old revision preparation cache', async () => {
    const f = await fixture(), validated = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    const old = validated.receipt;
    const next = { ...old, workingCandidate: { ...old.workingCandidate, revisionHash: 'c'.repeat(64) } };
    const fresh = { marker: 'fresh preparation required' };
    f.sync.preparedValidation = { expires: Date.now() + 30000, source: f.source,
      key: f.sync.validationKey(old), prepared: { assertRuntimeCurrent: () => {} } };
    f.sync.prepareGeneration = jasmine.createSpy('fresh immutable-ref hydration').and.resolveTo(fresh);
    const result = await f.sync.prepareApplication({}, {}, {}, f.source, old.base.generation, next);
    expect(result).toBe(fresh); expect(f.sync.prepareGeneration).toHaveBeenCalledTimes(1);
    expect(f.sync.prepareGeneration.calls.mostRecent().args[5].workingCandidate).toEqual(next.workingCandidate);
    expect(f.sync.preparedValidation).toBeUndefined();
  });

  it('an old receipt cannot be used under a different application request ID through the real bridge', async () => {
    const f = await fixture(), validated = await f.bridge.executeAbsCandidateValidation({ ...f.request, abs: f.source });
    const result = await f.bridge.executeAbsApply({ version: 2, requestId: crypto.randomUUID(), abs: f.source,
      validation: validated.receipt });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_REQUEST_INVALID');
    expect(f.sync.applyGeneration).not.toHaveBeenCalled();
  });
});
