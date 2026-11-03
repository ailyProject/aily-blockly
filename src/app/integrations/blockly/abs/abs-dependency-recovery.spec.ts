import { ProjectService } from '@domain/project/public-api';
import { AiOperationRegistryService, BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('dependency conflict admission and original decision receipts', () => {
  const path = 'D:/isolated/dependency-recovery';
  const token = `sha256:${'a'.repeat(64)}`, requestId = 'a3e32b14-a3b1-4d55-8a32-f5a00c6ef8b1';
  const entries = [{ field: 'dependencies', name: '@aily-project/lib-demo', base: '1', staged: '2', disk: '3' }];
  const offer = { version: 1, project: path, token, requestId, status: 'available', sourceFilesChanged: false, entries };
  let previous: any;
  beforeEach(() => { previous = window['libraryDependencies']; });
  afterEach(() => { window['libraryDependencies'] = previous; });
  function fixture() {
    let active = false, current = true;
    const service: any = Object.assign(Object.create(ProjectService.prototype), {
      libraryChanges: new Map(), coderProjectContexts: new Map(), blocklyLibraryRuntimeSignatures: new Map([[path, 'old-runtime']]),
      libraryChangesChanged: { next: jasmine.createSpy() }, normalizeProjectPath: (value: string) => value,
      isSameProjectPath: (a: string, b: string) => a === b,
      captureCurrentProjectGuard: () => () => current, isProjectTransitionInProgress: () => false,
    });
    Object.defineProperty(service, 'currentProjectPath', { value: path });
    Object.defineProperty(service, 'isProjectOpening', { get: () => false });
    Object.defineProperty(service, 'application', { value: { hasActiveProjectMutation: () => active, hasActiveBlocklyBuildOrUpload: () => false } });
    Object.defineProperty(service, 'dependencyLifecycle', { value: { isBusy: () => false } });
    const recover = jasmine.createSpy().and.resolveTo({ ok: true, dirty: true, busy: false, manifest: null, dependencyConflict: offer });
    const status = jasmine.createSpy().and.resolveTo({ dirty: false, busy: false, manifest: {} });
    window['libraryDependencies'] = { recover, status };
    return { service, recover, status, active: (value: boolean) => { active = value; }, stale: () => { current = false; } };
  }
  it('queries conflicts without adopting a fallback manifest or reading a partial canvas', async () => {
    const f = fixture(), result = await f.service.recoverLibraryDependencies({ version: 1, action: 'inspect' });
    expect(result.dependencyConflict).toEqual(offer); expect(f.service.currentPackageData).toBeUndefined();
    expect(f.service.blocklyLibraryRuntimeSignatures.get(path)).toBe('old-runtime');
  });
  it('only a fresh decision invalidates runtime; old completed receipts cannot touch a newer signature', async () => {
    const f = fixture(), request = { version: 1, action: 'resolve', token, requestId, choices: [{ field: 'dependencies', name: entries[0].name, choice: 'staged' }] };
    const result = { ok: true, dirty: true, busy: false, manifest: { dependencies: { [entries[0].name]: '2' } },
      freshCompletion: true, treeNeedsReconcile: true, dependencyRecovery: { ...offer, status: 'completed' } };
    f.recover.and.resolveTo(result); await f.service.recoverLibraryDependencies(request);
    expect(f.service.blocklyLibraryRuntimeSignatures.has(path)).toBeFalse();
    f.service.blocklyLibraryRuntimeSignatures.set(path, 'new-runtime');
    f.recover.and.resolveTo({ ...result, freshCompletion: false }); await f.service.recoverLibraryDependencies(request);
    expect(f.service.blocklyLibraryRuntimeSignatures.get(path)).toBe('new-runtime');
    f.active(true); const blocked = await f.service.recoverLibraryDependencies(request);
    expect(blocked.code).toBe('LIBRARY_DEPENDENCY_RECOVERY_BUSY'); expect(f.recover).toHaveBeenCalledTimes(2);
    await f.service.recoverLibraryDependencies({ version: 1, action: 'observe', token, requestId });
    expect(f.service.blocklyLibraryRuntimeSignatures.get(path)).toBe('new-runtime');
  });
  it('a late acknowledgement cannot update another project incarnation', async () => {
    const f = fixture(); f.recover.and.callFake(async () => { f.stale(); return { ok: true, dirty: false, manifest: {} }; });
    await expectAsync(f.service.recoverLibraryDependencies({ version: 1, action: 'inspect' })).toBeRejected();
    expect(f.service.currentPackageData).toBeUndefined();
  });
  it('ordinary clean saving does not perform reconciliation, while a resolved choice uses normal save first', async () => {
    const f = fixture(); f.service.saveLibraryChanges = jasmine.createSpy().and.resolveTo();
    expect(await f.service.prepareResolvedLibraryChangesForSave(path)).toBeFalse();
    expect(f.service.saveLibraryChanges).not.toHaveBeenCalled();
    f.status.and.resolveTo({ dirty: true, busy: false, manifest: {}, treeNeedsReconcile: true });
    expect(await f.service.prepareResolvedLibraryChangesForSave(path)).toBeTrue();
    expect(f.service.saveLibraryChanges).toHaveBeenCalledOnceWith(path);
  });
  it('unresolved conflicts cannot save or be treated as runtime readiness', async () => {
    const f = fixture(); f.service.saveLibraryChanges = jasmine.createSpy();
    f.status.and.resolveTo({ dirty: true, busy: false, manifest: null, dependencyConflict: offer });
    await expectAsync(f.service.prepareResolvedLibraryChangesForSave(path)).toBeRejected();
    await expectAsync(f.service.ensureBlocklyLibraryRuntimeReady(path)).toBeRejected();
    expect(f.service.saveLibraryChanges).not.toHaveBeenCalled();
  });
  it('unsaved decisions cannot trigger implicit installation through ABS/runtime synchronization', async () => {
    const f = fixture(); f.status.and.resolveTo({ dirty: true, busy: false, manifest: {}, treeNeedsReconcile: true });
    f.service.rebuildBlocklyRuntimeAfterLibraryChange = jasmine.createSpy();
    await expectAsync(f.service.ensureBlocklyLibraryRuntimeReady(path)).toBeRejected();
    expect(f.service.rebuildBlocklyRuntimeAfterLibraryChange).not.toHaveBeenCalled();
  });
  it('the dependency recovery route remains reachable without native canvas readiness', async () => {
    const recover = jasmine.createSpy().and.resolveTo({ ok: true, dirty: true, busy: false, dependencyConflict: offer });
    const bridge: any = Object.assign(Object.create(BlocklyLiveOperationBridgeService.prototype), {
      aiOperations: new AiOperationRegistryService(), projectService: { currentProjectPath: path, getProjectMode: () => 'blockly', recoverLibraryDependencies: recover },
      getProjectRuntimeStatus: jasmine.createSpy().and.throwError('must not inspect partial workspace') });
    const result = await bridge.executeAdmittedOperation({ operation: 'project_dependency_recovery', path, params: { version: 1, action: 'inspect' } });
    expect(result.ok).toBeTrue(); expect(recover).toHaveBeenCalledTimes(1); expect(bridge.getProjectRuntimeStatus).not.toHaveBeenCalled();
  });
  async function ipcFailure(error: unknown, requested: string | undefined = path) {
    const send = jasmine.createSpy(), bridge: any = Object.assign(Object.create(BlocklyLiveOperationBridgeService.prototype), {
      ngZone: { run: (operation: () => unknown) => operation() }, execute: async () => { throw error; } });
    await bridge.handleIpcPayload({ send }, { requestId: 'original-ipc-request', rendererGeneration: 8,
      operation: 'abs_projection', ...(requested === undefined ? {} : { path: requested }) });
    expect(send).toHaveBeenCalledTimes(1);
    return send.calls.mostRecent().args[1];
  }
  it('retains the exact requested projection identity and read-only dependency action across IPC without exposing capabilities', async () => {
    const error = Object.assign(new Error('Dependency edits conflict'), { code: 'LIBRARY_DEPENDENCY_CONFLICT',
      dependencyConflict: { ...offer, project: path.toUpperCase().replaceAll('/', '\\') + '\\' }, manifest: { arbitrary: 'not serialized' } });
    const result = await ipcFailure(error);
    expect(result).toEqual({ ok: false, code: error.code, message: error.message, project: path, operation: 'abs_projection',
      requestId: 'original-ipc-request', rendererGeneration: 8,
      nextAction: { tool: 'project_recover', input: { project: path, action: 'inspect_dependencies' } },
      recovery: 'Inspect the retained dependency entries before reading ABS; projection did not complete. No version was discarded or candidate applied.' });
    expect(JSON.stringify(result)).not.toContain(token); expect(result.dependencyConflict).toBeUndefined(); expect(result.manifest).toBeUndefined();
  });
  it('does not attach current-project recovery to foreign or malformed dependency diagnoses', async () => {
    for (const dependencyConflict of [{ ...offer, project: 'D:/another-project' }, { ...offer, token: 'invalid' },
      { ...offer, entries: [] }, { ...offer, entries: [{ field: 'dependencies', name: 'x', base: {}, staged: '2', disk: '3' }] },
      { project: path }, undefined]) {
      const error = Object.assign(new Error('Conflict not verified'), { code: 'LIBRARY_DEPENDENCY_CONFLICT', dependencyConflict });
      const result = await ipcFailure(error);
      expect(result).toEqual({ ok: false, code: error.code, message: error.message, requestId: 'original-ipc-request', rendererGeneration: 8 });
    }
  });
  it('preserves ordinary error replies and does not infer an original path from the current project', async () => {
    const ordinary = Object.assign(new Error('Original failure'), { code: 'OTHER_FAILURE', dependencyConflict: offer });
    expect(await ipcFailure(ordinary)).toEqual({ ok: false, code: ordinary.code, message: ordinary.message,
      requestId: 'original-ipc-request', rendererGeneration: 8 });
    const error = Object.assign(new Error('No original scope'), { code: 'LIBRARY_DEPENDENCY_CONFLICT', dependencyConflict: offer });
    // An empty requested path must never fall back to whichever project is current now.
    const result = await ipcFailure(error, ''); expect(result.project).toBeUndefined(); expect(result.nextAction).toBeUndefined();
  });
});
