import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsNativeCandidateFailures } from './abs-native-candidate-failures';
import type { AbsGenerationCandidateRequest } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';
import { hashAbsText } from './abs-identity-map';

/** Protocol composition only; real runtime reconstruction belongs to the isolated native suite. */
describe('native recovery admission, tools and bridge receipt binding', () => {
  const oldFingerprint = 'a'.repeat(64), newFingerprint = 'b'.repeat(64), hash = `sha256:${oldFingerprint}`;
  let previousFs: any;
  beforeEach(() => {
    previousFs = window['fs']; const files = new Map<string, string>();
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (_project, guard) => {
      const read = async key => { guard(); return files.get(key) ?? null; };
      return { read, withLock: operation => new Promise((resolve, reject) => operation({ read,
        replace: async (key, expected, text) => {
          guard(); const before = await read(key);
          if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
          files.set(key, text); return true;
        } }, result => result.ok ? resolve(result.value) : reject(new Error(result.error.message)))) };
    } } as any;
  });
  afterEach(() => window['fs'] = previousFs);
  async function fixture() {
    const failures = new AbsNativeCandidateFailures();
    const source = 'arduino_setup() {}';
    const request: AbsGenerationCandidateRequest = { version: 2, requestId: crypto.randomUUID(),
      base: { generation: 'base', scope: { projectKey: '/isolated/project', pageId: 'main' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const description = (await failures.remember({ key: 'exact-native-failure', source: 'arduino_setup() {}', base: request.base,
      candidate: request.candidate, request, error: new AbsSyncError('ABS_NATIVE_TIMEOUT', 'native timed out') }))!;
    const params = { version: 2, action: 'prepare_native', ...description.recovery };
    const prepared = { ...request, workspaceRevision: 7 };
    let current = true, fingerprint = oldFingerprint;
    const operation = jasmine.createSpy('prepare').and.resolveTo(prepared);
    const sync: any = {
      prepareNativeCandidate: (token: string, requestId: string, observe: boolean) => failures.run(token, requestId, observe, operation),
      describeNativeCandidateFailure: () => Promise.resolve(failures.describe()),
      validateGeneration: async () => { throw new AbsSyncError('ABS_NATIVE_TIMEOUT', 'native timed out'); },
      assertNativeRecoveryRequest: (token: string, requestId: string) => { failures.capture(token, requestId); },
      assertNativeRecoveryCurrent: () => { if (!current) throw new AbsSyncError('ABS_NATIVE_RECOVERY_STALE', 'runtime changed'); },
    };
    const tools = new AbsGenerationToolsService(sync);
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.absGenerationTools = tools;
    bridge.projectService = { currentProjectPath: '/isolated/project',
      ensureBlocklyLibraryRuntimeReady: async () => {},
      getBlocklyLibraryRuntimeFingerprint: jasmine.createSpy('fingerprint').and.callFake(async () => fingerprint) };
    bridge.readAbsSource = () => 'arduino_setup() {}';
    expect((await bridge.executeAbsCandidateValidation(request)).ok).toBeFalse();
    bridge.projectService.getBlocklyLibraryRuntimeFingerprint.calls.reset();
    return { failures, params, operation, bridge, project: bridge.projectService,
      setCurrent: (value: boolean) => { current = value; }, setFingerprint: (value: string) => { fingerprint = value; } };
  }

  it('retains the original completed prepared receipt across observation without another operation', async () => {
    const f = await fixture();
    const first = await f.bridge.executeAbsRecovery(f.params);
    expect(first.ok).toBeTrue(); expect(first.receipt.candidateApplied).toBeFalse();
    expect(first.receipt.prepared.libraryRuntimeFingerprint).toBe(oldFingerprint);
    const observed = await f.bridge.executeAbsRecovery({ ...f.params, observe: true });
    expect(observed.receipt.prepared).toEqual(first.receipt.prepared);
    expect(f.operation).toHaveBeenCalledTimes(1);
  });

  it('never relabels an old prepared result with a later runtime fingerprint', async () => {
    const f = await fixture();
    const first = await f.bridge.executeAbsRecovery(f.params);
    expect(first.receipt.prepared.libraryRuntimeFingerprint).toBe(oldFingerprint);
    f.setFingerprint(newFingerprint);
    const observed = await f.bridge.executeAbsRecovery({ ...f.params, observe: true });
    expect(observed.receipt?.prepared?.libraryRuntimeFingerprint).not.toBe(newFingerprint);
    expect(f.operation).toHaveBeenCalledTimes(1);
  });

  it('rejects library-file changes before rebuilding, not only after completion', async () => {
    const f = await fixture();
    f.setFingerprint(newFingerprint);
    const refused = await f.bridge.executeAbsRecovery(f.params);
    expect(refused.ok).toBeFalse(); expect(refused.code).toBe('ABS_RUNTIME_CONTRACT_STALE');
    expect(f.operation).not.toHaveBeenCalled();
  });

  it('rejects a replaced runtime before any late fingerprint can be attached', async () => {
    const f = await fixture();
    await f.bridge.executeAbsRecovery(f.params);
    const queries = f.project.getBlocklyLibraryRuntimeFingerprint.calls.count();
    f.setCurrent(false); f.setFingerprint(newFingerprint);
    await expectAsync(f.bridge.executeAbsRecovery({ ...f.params, observe: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_RECOVERY_STALE' }));
    expect(f.project.getBlocklyLibraryRuntimeFingerprint.calls.count()).toBe(queries);
    expect(f.operation).toHaveBeenCalledTimes(1);
  });

  it('rechecks completion context after an asynchronous fingerprint read', async () => {
    const f = await fixture();
    let queries = 0;
    f.project.getBlocklyLibraryRuntimeFingerprint.and.callFake(async () => {
      if (++queries === 1) return oldFingerprint; // Original failed runtime still admits recovery.
      f.setCurrent(false); return newFingerprint;
    });
    await expectAsync(f.bridge.executeAbsRecovery(f.params))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_RECOVERY_STALE' }));
    expect(f.operation).toHaveBeenCalledTimes(1);
  });

  it('observes an in-flight request without querying or blessing a prepared runtime', async () => {
    const f = await fixture(); let finish!: (value: any) => void;
    f.operation.and.callFake(() => new Promise(resolve => { finish = resolve; }));
    const first = f.bridge.executeAbsRecovery(f.params);
    await Promise.resolve(); await Promise.resolve();
    const observed = await f.bridge.executeAbsRecovery({ ...f.params, observe: true });
    expect(observed.ok).toBeFalse(); expect(observed.recoveryState).toBe('running');
    expect(f.project.getBlocklyLibraryRuntimeFingerprint).toHaveBeenCalledTimes(1);
    finish({ version: 2, requestId: 'original-request-id', base: { scope: { projectKey: '/isolated/project' } } });
    await first; expect(f.operation).toHaveBeenCalledTimes(1);
  });

  it('does not execute or fingerprint a recovery with different credentials', async () => {
    const f = await fixture();
    const result = await f.bridge.executeAbsRecovery({ ...f.params, requestId: crypto.randomUUID() });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_NATIVE_RECOVERY_STALE');
    expect(f.operation).not.toHaveBeenCalled();
    expect(f.project.getBlocklyLibraryRuntimeFingerprint).not.toHaveBeenCalled();
    const completed = await f.bridge.executeAbsRecovery(f.params);
    const queries = f.project.getBlocklyLibraryRuntimeFingerprint.calls.count();
    const invalid = await f.bridge.executeAbsRecovery({ ...f.params, requestId: crypto.randomUUID() });
    expect(invalid.code).toBe('ABS_NATIVE_RECOVERY_STALE');
    expect(f.project.getBlocklyLibraryRuntimeFingerprint.calls.count()).toBe(queries);
    const observed = await f.bridge.executeAbsRecovery({ ...f.params, observe: true });
    expect(observed.receipt.prepared).toEqual(completed.receipt.prepared);
    expect(f.operation).toHaveBeenCalledTimes(1);
  });
});
