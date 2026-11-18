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
import { nativeSaveAdmissionIdentity, OriginalRequestAdmissions } from './original-request-admission';

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

  it('observes a pre-writer ABS rejection after losing the entire reply; the old ID cannot apply again', async () => {
    const host = bridge();
    const candidate = { version: 1, id: requestId, revisionHash: '2'.repeat(64) };
    const params = { version: 2, requestId, abs: 'candidate', validation: { version: 2, requestId,
      base: { generation: 'base', scope: { projectKey: project, pageId: 'page' }, abiHash: hash, absHash: hash, mapHash: hash },
      candidate: { hash, bytes: 9 }, workingCandidate: candidate, workspaceRevision: 1,
      libraryRuntimeFingerprint: '3'.repeat(64), validation: { scope: 'prepared-generation', ok: true } } };
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
});
