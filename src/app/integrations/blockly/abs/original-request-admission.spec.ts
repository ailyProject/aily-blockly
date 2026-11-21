import { BehaviorSubject } from 'rxjs';
import { ProjectService, type ProjectSaveRequest } from '@domain/project/public-api';
import { SerialOperationQueue } from '@shared/public-api';
import { BlocklyLiveOperationBridgeService } from '../../../services/integrations/automation/blockly-live-operation-bridge.service';
import { AbsApplicationJournal } from './abs-application-journal';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import type { AbsSyncStoragePort } from './abs-baseline-store';
import { hashAbsText } from './abs-identity-map';
import { nativeSaveIdentity } from './abs-native-save-result';
import { blockStatePublicationIdentity, nativeSaveIndexKey } from './abs-native-save-protocol';
import { AbsOperationJournal } from './abs-operation-journal';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { applicationRequestKey, nativeSaveAdmissionIdentity, OriginalRequestAdmissions } from './original-request-admission';

describe('original project admission settlement', () => {
  const project = '/admission-test';
  const requestId = '00000000-0000-4000-8000-000000000abc';
  const hash = 'sha256:' + '1'.repeat(64);
  let files: Map<string, string>, port: AbsSyncStoragePort, oldFs: any, oldPath: any;
  const guard = () => {};
  const open = (inode = '2', hostPid = 101): AbsSyncStoragePort => {
    const queue = new SerialOperationQueue();
    const read = async (key: string) => files.get(key) ?? null;
    return {
      attachment: { version: 1, root: project, identity: { dev: '1', ino: inode, birthtimeNs: '3' } },
      executor: { version: 1, hostPid, storagePid: hostPid + 1,
        instanceId: 'coordinator-test', processIdentity: 'test-process', bootId: 'test-boot' },
      read, withLock: operation => queue.run(() => operation({ read, replace: async (key, expected, value) => {
        const old = await read(key);
        if ((old === null ? null : await hashAbsText(old)) !== expected) return false;
        if (value === null) files.delete(key); else files.set(key, value);
        return true;
      } })),
    };
  };
  beforeEach(() => {
    oldFs = window['fs']; oldPath = window['path'];
    files = new Map(); port = open();
    window['path'] = { isAbsolute: (value: string) => value.startsWith('/') } as any;
    window['fs'] = { projectProgramPublicationVersion: 1, nativeSaveReceiptVersion: 2, projectSyncStorageVersion: 2,
      openProjectSyncStorage: async () => ({ attachment: port.attachment, executor: port.executor, read: port.read,
        observeExecutor: port.observeExecutor,
        withLock: operation => port.withLock(locked => new Promise((resolve, reject) => {
          operation(locked, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), { code: result.error.code })));
        })),
      }) };
  });
  afterEach(() => { window['fs'] = oldFs; window['path'] = oldPath; });

  const bridge = () => {
    const sync = Object.create(AbsWorkspaceSyncService.prototype);
    const domain = Object.create(ProjectService.prototype);
    Object.assign(domain, {
      currentProjectPathSubject: new BehaviorSubject(project),
      viewRevision: 0,
      getProjectMode: () => 'blockly',
      isProjectTransitionInProgress: () => false,
      injector: { get: () => ({ observeProjectPublication: (path, request, pid) =>
        sync.observeNativeSave(path, request, pid, () => domain.projectViewRevision) }) },
    });
    Object.assign(sync, { project: domain });
    const service = Object.create(BlocklyLiveOperationBridgeService.prototype);
    Object.assign(service, { projectService: domain, boardSwitchInProgress: true, pendingOriginalAdmissions: new Set(),
      absGenerationTools: new AbsGenerationToolsService(sync),
      getProjectRuntimeStatus: () => ({ ready: false }), aiOperations: { setActive: jasmine.createSpy('owner') },
      executeAbsApply: jasmine.createSpy('apply writer'), executeProjectSave: jasmine.createSpy('save writer'),
      executeBlocksTidy: jasmine.createSpy('tidy writer') });
    return service;
  };

  const applyParams = () => ({ version: 2, requestId, abs: 'candidate', validation: { version: 2, requestId,
    base: { generation: 'base', scope: { projectKey: project, pageId: 'page' }, abiHash: hash, absHash: hash, mapHash: hash },
    candidate: { hash, bytes: 9 }, workingCandidate: { version: 1, id: requestId, revisionHash: '2'.repeat(64) }, workspaceRevision: 1,
    libraryRuntimeFingerprint: '3'.repeat(64), validation: { scope: 'prepared-generation', ok: true } } });

  const stateRequest = () => ({ version: 2 as const, requestId, action: 'update' as const,
    expectedGeneration: 'prior-generation', changes: [{ blockId: 'existing-block', collapsed: true }] });
  const stateObservation = (state: ReturnType<typeof stateRequest>, originalTargetPid = 101) => ({
    operation: 'abs_recovery', path: project,
    params: { version: 2, requestId: crypto.randomUUID(), action: 'observe_state', state, originalTargetPid },
  });

  it('reads an unknown or mismatched original state request without opening a publication lock', async () => {
    const state = stateRequest(), identity = await blockStatePublicationIdentity(project, state);
    const host = bridge();
    port = { ...port, observeExecutor: async () => ({ version: 1, state: 'exited', reason: 'process-exited' }) };
    const lock = spyOn(port, 'withLock').and.callThrough();
    const absent = await host.execute(stateObservation(state));
    expect(absent.saveReceipt.state).toBe('unknown');
    expect(lock).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    await new OriginalRequestAdmissions(port, project).reserveSave(identity, 0, guard);
    lock.calls.reset();
    expect((await host.execute(stateObservation(state, 333))).saveReceipt.state).toBe('unknown');
    expect((await host.execute(stateObservation({ ...state, expectedGeneration: 'other' }))).saveReceipt).toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
  });

  it('binds a state writer rejection during a competing ABS operation and reads it off-canvas', async () => {
    const host = bridge(), state = stateRequest(), identity = await blockStatePublicationIdentity(project, state);
    host.boardSwitchInProgress = false;
    host.absApplyInProgress = true;
    const writer = spyOn(host.absGenerationTools, 'blockState').and.throwError('unexpected state writer');
    const first = await host.execute({ operation: 'blocks_set_state', path: project, params: state });
    const reference = { version: 1, requestId, nativeRequestId: identity.requestId, inputDigest: identity.inputDigest };
    expect(first).toEqual(jasmine.objectContaining({ ok: false, statePublication: reference,
      code: 'abs_apply_in_progress', admission: { status: 'NOT_STARTED', requestId: identity.requestId },
      saveReceipt: jasmine.objectContaining({ state: 'completed', requestId: identity.requestId }) }));
    expect(writer).not.toHaveBeenCalled();
    expect(await port.read(await nativeSaveIndexKey(identity.requestId))).toBeNull();
    const before = [...files];
    port = open('2', 222);
    const cold = bridge();
    cold.projectService.isProjectTransitionInProgress = () => true;
    for (const active of ['/replacement-canvas', '']) {
      cold.projectService.currentProjectPathSubject.next(active);
      const observed = await cold.execute(stateObservation(state));
      expect(observed).toEqual(jasmine.objectContaining({
        operation: 'abs_recovery', project, statePublication: reference,
        saveReceipt: jasmine.objectContaining({ state: 'completed', requestId: identity.requestId }),
        result: jasmine.objectContaining({ publication: { status: 'NOT_COMMITTED' },
          admission: { status: 'NOT_STARTED', requestId: identity.requestId } }),
        publicationObservation: jasmine.objectContaining({ current: false, observer: { hostPid: 222 },
          executor: jasmine.objectContaining({ hostPid: 101 }) }),
      }));
    }
    expect((await cold.execute(stateObservation(state, 333))).result).toBeUndefined();
    expect((await cold.execute(stateObservation({ ...state, expectedGeneration: 'another-generation' }))).result).toBeUndefined();
    port = open('9', 222);
    expect((await cold.execute(stateObservation(state))).result).toBeUndefined();
    expect([...files]).toEqual(before);
  });

  for (const cut of ['before-index', 'after-index'] as const) {
    it(`settles only the exited state writer beside a later native publication (${cut})`, async () => {
      const state = stateRequest(), identity = await blockStatePublicationIdentity(project, state);
      const snapshot = { document: {}, disk: { abi: null, abs: null, map: null } };
      const original = port.executor!;
      const admissions = new OriginalRequestAdmissions(port, project);
      expect(await admissions.reserveSave(identity, 0, guard)).toBeTruthy();
      const admitted = cut === 'after-index'
        ? await new AbsOperationJournal(port, project).beginDocumentSave({ request: identity, ...snapshot }, guard)
        : undefined;
      const active = await bridge().execute(stateObservation(state));
      expect(active.writerObservation).toBeUndefined();
      port = { ...open('2', 222), observeExecutor: async () =>
        ({ version: 1, state: 'exited', reason: 'process-exited' }) };
      const next = new AbsOperationJournal(port, project);
      if (admitted) await next.restored(admitted.ref.operationId, guard);
      const newer = await nativeSaveIdentity(project, { operation: 'blocks_tidy', version: 2,
        requestId: 'pub2-' + crypto.randomUUID() });
      await next.beginDocumentSave({ request: newer, ...snapshot }, guard);
      const pointer = await port.read('operation.json');
      const result = await bridge().execute(stateObservation(state));
      expect(result.saveReceipt).toEqual(jasmine.objectContaining({ state: 'unknown', requestId: identity.requestId }));
      expect(result.writerObservation).toEqual(jasmine.objectContaining({
        request: identity, executor: original, observer: { hostPid: 222 },
        kind: admitted ? 'indexed-save-retired' : 'admitted-save',
      }));
      expect(result.result).toBeUndefined();
      expect(await port.read('operation.json')).toBe(pointer);
      expect((await bridge().execute(stateObservation(state, 333))).writerObservation).toBeUndefined();
    });
  }

  it('observes a pre-writer ABS rejection after losing the entire reply; the old ID cannot apply again', async () => {
    const host = bridge();
    const params = applyParams();
    await host.execute({ operation: 'abs_apply', path: project, params });
    expect(host.executeAbsApply).not.toHaveBeenCalled();
    expect([...files.keys()]).toEqual([jasmine.stringMatching(/^recoveries\/admission-/)]);
    port = open('2', 222);
    const cold = bridge();
    const rebound = await cold.execute({ operation: 'abs_recovery', path: project,
      params: { version: 2, action: 'observe_apply', requestId } });
    expect(rebound).toEqual(jasmine.objectContaining({
      project, operation: 'abs_apply', admission: { status: 'NOT_STARTED', requestId },
      publication: { status: 'NOT_COMMITTED' }, application: { status: 'NOT_STARTED', requestId },
      applicationObservation: { version: 1, requestId, observationOnly: true, resultKnown: true, current: false },
    }));
    cold.boardSwitchInProgress = false;
    expect(await cold.execute({ operation: 'abs_apply', path: project, params })).toEqual(rebound);
    expect(cold.executeAbsApply).not.toHaveBeenCalled();
    const unknown = await new AbsApplicationJournal(port, project).observe(crypto.randomUUID(), guard);
    expect(unknown.result.publication.status).toBe('UNKNOWN');
    expect(unknown.result.admission).toBeUndefined();
  });

  for (const operation of ['project_save', 'blocks_tidy'] as const) {
    it(`settles the original v2 ${operation} gate rejection durably without a publisher`, async () => {
      const host = bridge();
      const original: ProjectSaveRequest = { version: 2, operation, requestId: 'pub2-' + requestId, waitMs: 1000 };
      const params = { project, saveRequest: original };
      await host.execute({ path: project, operation, params });
      expect(host.executeProjectSave).not.toHaveBeenCalled();
      expect(host.executeBlocksTidy).not.toHaveBeenCalled();
      port = open('2', 222);
      const cold = bridge();
      cold.boardSwitchInProgress = false;
      const observed = await cold.execute({ operation: 'project_publication_status', path: project,
        params: { ...params, originalTargetPid: 101 } });
      expect(observed.saveReceipt).toEqual(jasmine.objectContaining({ project, operation, state: 'completed' }));
      expect(observed.result).toEqual(jasmine.objectContaining({
        ok: false, projectSaved: false, generatedCodePublished: false,
        admission: { status: 'NOT_STARTED', requestId: original.requestId },
      }));
      expect(observed.publicationObservation.executor.hostPid).toBe(101);
      expect(observed.publicationObservation.observer.hostPid).toBe(222);
      expect((await cold.execute({ path: project, operation, params })).result).toEqual(observed.result);
      expect(cold.executeProjectSave).not.toHaveBeenCalled();
      expect(cold.executeBlocksTidy).not.toHaveBeenCalled();
      port = open('9');
      const copied = await cold.execute({ operation: 'project_publication_status', path: project,
        params: { ...params, originalTargetPid: 101 } });
      expect(copied.ok).toBeFalse();
      expect(copied.result).toBeUndefined();
    });
  }

  it('excludes a no-start receipt once the native writer holds the original index', async () => {
    const identity = await nativeSaveIdentity(project, { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId });
    const admissions = new OriginalRequestAdmissions(port, project);
    const original = nativeSaveAdmissionIdentity(identity)!;
    const snapshot = { document: { pages: [] }, disk: { abi: null, abs: null, map: null } };
    const writer = new AbsOperationJournal(port, project);
    expect((await writer.beginDocumentSave({ ...snapshot, request: identity }, guard)).created).toBeTrue();
    expect(await admissions.reject(original, { code: 'REJECTED', message: 'Rejected' }, guard)).toBeNull();
    expect(await admissions.observe(original)).toBeNull();
  });

  it('settles a lost writer envelope against its invalidated view even after returning to the same project', async () => {
    const host = bridge();
    const request: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId };
    const prepared = await host.execute({ operation: 'project_publication_prepare', path: project,
      params: { saveRequest: request }, originalAdmissionAttachment: port.attachment });
    const status = { operation: 'project_publication_status', path: project,
      params: { saveRequest: request, originalTargetPid: 101 } };
    expect(prepared.saveWriter?.viewRevision).toBe(0);
    expect((await host.execute(status)).saveReceipt.state).toBe('unknown');
    host.projectService.viewRevision += 2;
    const retired = await host.execute(status);
    expect(retired.saveReceipt.state).toBe('completed');
    expect(retired.result.admission).toEqual({ status: 'NOT_STARTED', requestId: request.requestId });
    expect(retired.publicationObservation.current).toBeFalse();
    expect(await port.read(await nativeSaveIndexKey(request.requestId))).toBeNull();
    await host.execute({ operation: 'project_save', path: project, params: { saveRequest: request },
      nativeSaveWriter: prepared.saveWriter, originalAdmissionAttachment: port.attachment });
    expect(host.executeProjectSave).not.toHaveBeenCalled();
    expect((await host.execute(status)).result).toEqual(retired.result);
  });

  for (const cut of ['index-only', 'after-restore'] as const) {
    it(`keeps the proven writer release independent of the latest operation pointer (${cut})`, async () => {
      const request: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId };
      const identity = await nativeSaveIdentity(project, request);
      const input = { request: identity, document: {}, disk: { abi: null, abs: null, map: null } };
      const first = await new AbsOperationJournal(port, project).beginDocumentSave(input, guard);
      if (cut === 'index-only') files.delete('operation.json');
      const original = port.executor;
      port = { ...open('2', 222), observeExecutor: async () =>
        ({ version: 1, state: 'exited', reason: 'process-exited' }) };
      const journal = new AbsOperationJournal(port, project);
      if (cut === 'after-restore') {
        await journal.restored(first.ref.operationId, guard);
        await journal.beginDocumentSave({ ...input,
          request: { ...identity, requestId: 'pub2-' + crypto.randomUUID() } }, guard);
      }
      const result = await bridge().execute({ operation: 'project_publication_status', path: project,
        params: { saveRequest: request, originalTargetPid: original!.hostPid } });
      expect(result.saveReceipt.state).toBe('unknown');
      expect(result.writerObservation?.settlement?.recordHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.result).toBeUndefined();
    });
  }

  it('keeps an admitted route rejection observable after the active canvas moves', async () => {
    const host = bridge();
    const originalAttachment = port.attachment;
    host.projectService.currentProjectPathSubject.next('/replacement-canvas');
    host.boardSwitchInProgress = false;
    const refused = await host.execute({ operation: 'abs_apply', path: project, params: applyParams(), originalAdmissionAttachment: originalAttachment });
    expect(host.executeAbsApply).not.toHaveBeenCalled();
    expect(refused.admission).withContext(JSON.stringify(refused)).toEqual({ status: 'NOT_STARTED', requestId });
    expect([...files.keys()]).toEqual([jasmine.stringMatching(/^recoveries\/admission-/)]);
    port = open('2', 222);
    const restarted = await bridge().execute({ operation: 'abs_recovery', path: project,
      params: { version: 2, action: 'observe_apply', requestId } });
    expect(restarted).toEqual(jasmine.objectContaining({
      code: 'PROJECT_ADMISSION_CONTEXT_STALE', project,
      admission: { status: 'NOT_STARTED', requestId },
      applicationObservation: jasmine.objectContaining({ requestId, resultKnown: true, current: false }),
    }));
  });

  it('settles the original native save when the queued context expires before its writer', async () => {
    const host = bridge();
    host.boardSwitchInProgress = false;
    const originalAttachment = port.attachment;
    let contextChecks = 0;
    host.projectService.saveContext = () => [host, ++contextChecks > 1, 'blockly'];
    const original: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId, waitMs: 1000 };
    const params = { project, saveRequest: original };
    await host.execute({ path: project, operation: 'project_save', params, originalAdmissionAttachment: originalAttachment });
    expect(host.executeProjectSave).not.toHaveBeenCalled();
    expect([...files.keys()]).toEqual([jasmine.stringMatching(/^recoveries\/admission-/)]);
    port = open('2', 222);
    const observed = await bridge().execute({ operation: 'project_publication_status', path: project,
      params: { ...params, originalTargetPid: 101 } });
    expect(observed.saveReceipt.state).toBe('completed');
    expect(observed.result).toEqual(jasmine.objectContaining({ code: 'PROJECT_SAVE_RECEIPT_CONTEXT_STALE', project,
      admission: { status: 'NOT_STARTED', requestId: original.requestId }, projectSaved: false }));
    expect(observed.publicationObservation.executor.hostPid).toBe(101);
  });

  it('has no admission authority when the original path was replaced by another physical directory', async () => {
    const host = bridge();
    const originalAttachment = port.attachment;
    const original: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId, waitMs: 1000 };
    const params = { project, saveRequest: original };
    host.projectService.currentProjectPathSubject.next('/replacement-canvas');
    port = open('9', 101);
    const first = await host.execute({ path: project, operation: 'project_save', params, originalAdmissionAttachment: originalAttachment });
    expect(host.executeProjectSave).not.toHaveBeenCalled();
    expect(first.commandDispatched).toBeUndefined();
    expect([...files.keys()]).toEqual([]);
    const observed = await bridge().execute({ operation: 'project_publication_status', path: project,
      params: { ...params, originalTargetPid: 101 } });
    expect(observed.saveReceipt.state).toBe('unknown');
    expect(observed.result).toBeUndefined();
  });

  it('reads the original ABS refusal while a different or no project is active', async () => {
    const admissions = new OriginalRequestAdmissions(port, project);
    await admissions.reject({ operation: 'abs_apply', requestId }, { code: 'PROJECT_ADMISSION_CONTEXT_STALE', message: 'Original route changed' }, guard);
    const retained = [...files];
    const cold = bridge();
    const request = { operation: 'abs_admission_status', path: project, params: { version: 2, requestId } };
    for (const active of ['/replacement-canvas', '']) {
      cold.projectService.currentProjectPathSubject.next(active);
      expect(await cold.execute(request)).toEqual(jasmine.objectContaining({
        code: 'PROJECT_ADMISSION_CONTEXT_STALE', operation: 'abs_apply', project,
        admission: { status: 'NOT_STARTED', requestId }, publication: { status: 'NOT_COMMITTED' },
        applicationObservation: { version: 1, requestId, observationOnly: true, resultKnown: true, current: false },
      }));
    }
    port = open('9', 222);
    const copy = await cold.execute(request);
    expect(copy.publication.status).toBe('UNKNOWN');
    expect(copy.admission).toBeUndefined();
    expect([...files]).toEqual(retained);
  });

  it('keeps a cross-restart ABS refusal tied to its original writer and the observing host', async () => {
    const admissions = new OriginalRequestAdmissions(port, project);
    await admissions.reject({ operation: 'abs_apply', requestId },
      { code: 'PROJECT_ADMISSION_CONTEXT_STALE', message: 'Original route changed' }, guard);
    const original = port.executor;
    port = open('2', 222);
    const cold = bridge();
    cold.projectService.currentProjectPathSubject.next('/replacement-canvas');
    const payload = { operation: 'abs_admission_status', path: project,
      params: { version: 2, requestId, originalTargetPid: original.hostPid } };
    const verified = await cold.execute(payload);
    expect(verified.publicationObservation).toEqual(jasmine.objectContaining({
      operation: 'abs_apply', requestId, executor: original, observer: { hostPid: 222 }, current: false, durable: true,
    }));
    expect(verified.applicationObservation.resultKnown).toBeTrue();
    const foreign = await cold.execute({ ...payload, params: { ...payload.params, originalTargetPid: 333 } });
    expect(foreign.publication.status).toBe('UNKNOWN');
    expect(foreign.admission).toBeUndefined();
  });

  it('releases the original validated ABS writer after exit without a terminal result or a write', async () => {
    const admissions = new OriginalRequestAdmissions(port, project);
    const original = port.executor;
    await admissions.reserveApplication(requestId, hash, guard);
    const retained = [...files];
    let exited = false;
    port = { ...open('2', 222), observeExecutor: async candidate => {
      expect(candidate).toEqual(original);
      return { version: 1, state: exited ? 'exited' : 'active', reason: exited ? 'process-exited' : 'process-matched' };
    } };
    const cold = bridge();
    const payload = { operation: 'abs_admission_status', path: project,
      params: { version: 2, requestId, originalTargetPid: original.hostPid } };
    expect((await cold.execute(payload)).writerObservation).toBeUndefined();
    exited = true;
    const released = await cold.execute(payload);
    expect(released).toEqual(jasmine.objectContaining({
      ok: false, publication: { status: 'UNKNOWN' },
      applicationObservation: jasmine.objectContaining({ resultKnown: false, current: false }),
      writerObservation: jasmine.objectContaining({ executor: original, observer: { hostPid: 222 } }),
    }));
    expect(released.admission).toBeUndefined();
    expect((await cold.execute({ operation: 'abs_apply', path: project, params: applyParams() })).publication.status).toBe('UNKNOWN');
    expect(cold.executeAbsApply).not.toHaveBeenCalled();
    const newerJournal = new AbsOperationJournal(port, project);
    await expectAsync(newerJournal.begin({ kind: 'abs-apply', document: {}, disk: { abi: null, abs: null, map: null },
      candidate: { hash, source: 'candidate', generation: 'base' }, application: { requestId, validation: applyParams().validation },
    }, guard)).toBeRejectedWithError('The original application belongs to a different validated writer or candidate.');
    expect([...files]).toEqual(retained);
    files.set(await applicationRequestKey(requestId), 'registered writer');
    expect((await cold.execute(payload)).writerObservation).toBeUndefined();
  });

  it('cannot settle another ABS writer, an absent original or a request with extra fields', async () => {
    const cold = bridge();
    cold.projectService.currentProjectPathSubject.next('/replacement-canvas');
    const payload = { operation: 'abs_admission_status', path: project, params: { version: 2, requestId } };
    await expectAsync(cold.execute(payload)).toBeResolvedTo(jasmine.objectContaining({ publication: { status: 'UNKNOWN' } }));
    files.set(await applicationRequestKey(requestId), 'A writer already owns this request. Do not read its result here.');
    const snapshot = [...files];
    const writer = await cold.execute(payload);
    expect(writer.publication.status).toBe('UNKNOWN');
    expect(writer.admission).toBeUndefined();
    const openStorage = spyOn(window['fs'], 'openProjectSyncStorage').and.callThrough();
    for (const request of [{ ...payload, path: '' }, { ...payload, path: 'relative' },
      { ...payload, params: { ...payload.params, abs: 'arbitrary source' } }]) {
      const rejected = await cold.execute(request);
      expect(rejected.code).toBe('ABS_ADMISSION_STATUS_INVALID');
      expect(rejected.admission).toBeUndefined();
    }
    expect(openStorage).not.toHaveBeenCalled();
    expect([...files]).toEqual(snapshot);
  });

  it('observes an indexed ABS rollback on a replacement canvas only for its original writer', async () => {
    const source = 'candidate', candidateHash = await hashAbsText(source);
    const original = port.executor;
    const validation = applyParams().validation;
    validation.candidate.hash = candidateHash;
    const operations = new AbsOperationJournal(port, project);
    await new OriginalRequestAdmissions(port, project).reserveApplication(requestId, candidateHash, guard);
    const id = await operations.begin({ kind: 'abs-apply', document: {}, disk: { abi: null, abs: null, map: null },
      candidate: { hash: candidateHash, source, generation: 'base' }, application: { requestId, validation },
    }, guard);
    await operations.restored(id, guard);
    await new AbsApplicationJournal(port, project).completeRolledBack(id, { code: 'ORIGINAL_ROLLBACK' }, guard, async () => {});
    const retained = [...files];
    port = open('2', 222);
    const cold = bridge();
    cold.projectService.currentProjectPathSubject.next('/replacement-canvas');
    const payload = { operation: 'abs_admission_status', path: project,
      params: { version: 2, requestId, originalTargetPid: original.hostPid } };
    expect(await cold.execute(payload)).toEqual(jasmine.objectContaining({
      ok: false, code: 'ORIGINAL_ROLLBACK', application: { status: 'ROLLED_BACK', requestId },
      applicationObservation: { version: 1, requestId, observationOnly: true, resultKnown: true, current: false },
      publicationObservation: jasmine.objectContaining({ executor: original, observer: { hostPid: 222 }, current: false }),
    }));
    expect((await cold.execute({ ...payload, params: { ...payload.params, originalTargetPid: 333 } })).publication.status).toBe('UNKNOWN');
    port = open('9', 222);
    expect((await cold.execute(payload)).publication.status).toBe('UNKNOWN');
    expect([...files]).toEqual(retained);
  });

  for (const indexed of [false, true]) {
    it(`observes exact exited save occupancy with ${indexed ? 'an unchanged indexed snapshot' : 'no writer index'}`, async () => {
      const host = bridge();
      const request: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId };
      const original = port.executor;
      const prepare = { operation: 'project_publication_prepare', path: project,
        params: { saveRequest: request }, originalAdmissionAttachment: port.attachment };
      const prepared = await host.execute(prepare);
      expect(prepared).toEqual(jasmine.objectContaining({ ok: true, operation: 'project_publication_prepare',
        saveWriter: jasmine.objectContaining({ executor: original, attachment: port.attachment }) }));
      expect(host.executeProjectSave).not.toHaveBeenCalled();
      const identity = await nativeSaveIdentity(project, request);
      if (indexed) await new AbsOperationJournal(port, project).beginDocumentSave({
        request: identity, document: {}, disk: { abi: null, abs: null, map: null },
      }, guard);
      const retained = [...files];
      let exited = false;
      port = { ...open('2', 222), observeExecutor: async candidate => {
        expect(candidate).toEqual(original);
        return { version: 1, state: exited ? 'exited' : 'active', reason: exited ? 'process-exited' : 'process-matched' };
      } };
      const cold = bridge();
      cold.projectService.currentProjectPathSubject.next('/replacement-canvas');
      const observe = { operation: 'project_publication_status', path: project,
        params: { saveRequest: request, originalTargetPid: 101 } };
      expect((await cold.execute(observe)).writerObservation).toBeUndefined();
      exited = true;
      expect(await cold.execute(observe)).toEqual(jasmine.objectContaining({
        saveReceipt: jasmine.objectContaining({ requestId: request.requestId, state: 'unknown' }),
        writerObservation: jasmine.objectContaining({ kind: indexed ? 'indexed-save-retired' : 'admitted-save',
          request: identity, executor: original, observer: { hostPid: 222 }, oldWriter: jasmine.objectContaining({ state: 'exited' }) }),
      }));
      expect((await cold.execute({ ...observe, params: { ...observe.params, originalTargetPid: 333 } })).writerObservation).toBeUndefined();
      await expectAsync(new AbsOperationJournal(port, project).beginDocumentSave({
        request: identity, document: {}, disk: { abi: null, abs: null, map: null },
      }, guard)).toBeRejectedWithError('The original save belongs to a different admitted writer.');
      expect([...files].filter(([key]) => !key.startsWith('recoveries/save-settlement-'))).toEqual(retained);
      expect([...files.keys()].filter(key => key.startsWith('recoveries/save-settlement-')).length).toBe(indexed ? 1 : 0);
    });
  }

  it('durably refuses a prepared save after its canvas is replaced, without dispatching a writer', async () => {
    const host = bridge(), attachment = port.attachment;
    const request: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId, waitMs: 1000 };
    const params = { saveRequest: request };
    const prepared = await host.execute({ operation: 'project_publication_prepare', path: project, params,
      originalAdmissionAttachment: attachment });
    expect(prepared.ok).toBeTrue();
    host.projectService.currentProjectPathSubject.next('/replacement-canvas');
    await host.execute({ path: project, operation: 'project_save', params, originalAdmissionAttachment: attachment,
      nativeSaveWriter: prepared.saveWriter });
    expect(host.executeProjectSave).not.toHaveBeenCalled();
    const observed = await host.execute({ operation: 'project_publication_status', path: project,
      params: { ...params, originalTargetPid: 101 } });
    expect(observed.result.admission).toEqual({ status: 'NOT_STARTED', requestId: request.requestId });
  });

  it('prepares the exact board save input and observes a consumed request without entering the board writer', async () => {
    const host = bridge(), attachment = port.attachment;
    const request: ProjectSaveRequest = { version: 2, operation: 'project_save', requestId: 'pub2-' + requestId,
      input: { kind: 'board-config', configKey: 'clock', configValue: '80' } };
    const params = { saveRequest: request };
    const prepared = await host.execute({ operation: 'project_publication_prepare', path: project, params,
      originalAdmissionAttachment: attachment });
    expect(prepared.ok).toBeTrue();
    const identity = await nativeSaveIdentity(project, request);
    expect(prepared.saveWriter.request).toEqual(identity);
    await new AbsOperationJournal(port, project).beginDocumentSave({
      request: identity, document: {}, disk: { abi: null, abs: null, map: null },
    }, guard);
    host.executeAdmittedOperation = jasmine.createSpy('board writer');
    const observed = await host.execute({ path: project, operation: 'set_board_config',
      params: { ...params, config_key: 'clock', config_value: '80' }, originalAdmissionAttachment: attachment,
      nativeSaveWriter: prepared.saveWriter });
    expect(observed.saveReceipt.state).toBe('running');
    expect(host.executeAdmittedOperation).not.toHaveBeenCalled();
  });
});
