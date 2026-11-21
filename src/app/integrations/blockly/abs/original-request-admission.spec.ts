import { BehaviorSubject } from 'rxjs';
import { ProjectService, type ProjectSaveRequest } from '@domain/project/public-api';
import { SerialOperationQueue } from '@shared/public-api';
import { BlocklyLiveOperationBridgeService } from '../../../services/integrations/automation/blockly-live-operation-bridge.service';
import { AbsApplicationJournal } from './abs-application-journal';
import type { AbsSyncStoragePort } from './abs-baseline-store';
import { hashAbsText } from './abs-identity-map';
import { nativeSaveIdentity } from './abs-native-save-result';
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
      getProjectMode: () => 'blockly',
      isProjectTransitionInProgress: () => false,
      injector: { get: () => ({ observeProjectPublication: sync.observeNativeSave.bind(sync) }) },
    });
    const service = Object.create(BlocklyLiveOperationBridgeService.prototype);
    Object.assign(service, { projectService: domain, boardSwitchInProgress: true, pendingApplyAdmissions: new Set(),
      getProjectRuntimeStatus: () => ({ ready: false }), aiOperations: { setActive: jasmine.createSpy('owner') },
      executeAbsApply: jasmine.createSpy('apply writer'), executeProjectSave: jasmine.createSpy('save writer'),
      executeBlocksTidy: jasmine.createSpy('tidy writer') });
    return service;
  };

  const applyParams = () => ({ version: 2, requestId, abs: 'candidate', validation: { version: 2, requestId,
    base: { generation: 'base', scope: { projectKey: project, pageId: 'page' }, abiHash: hash, absHash: hash, mapHash: hash },
    candidate: { hash, bytes: 9 }, workingCandidate: { version: 1, id: requestId, revisionHash: '2'.repeat(64) }, workspaceRevision: 1,
    libraryRuntimeFingerprint: '3'.repeat(64), validation: { scope: 'prepared-generation', ok: true } } });

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
});
