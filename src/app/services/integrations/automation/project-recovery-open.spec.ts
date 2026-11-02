import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { ProjectService } from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';

describe('closed-source recovery opening and durable observations', () => {
  let oldFs: any, oldPath: any, service: any, entries: Map<string, any>;
  const source = '/private/closed-source';
  const requestId = 'closed-source-test-001';
  beforeEach(() => {
    oldFs = window['fs']; oldPath = window['path']; entries = new Map();
    window['path'] = { isAbsolute: value => value.startsWith('/'), dirname: value => value.slice(0, value.lastIndexOf('/')),
      basename: value => value.slice(value.lastIndexOf('/') + 1), resolve: value => value, join: (...parts) => parts.join('/') } as any;
    window['fs'] = { existsSync: () => false, projectRecoveryReceipts: {
      abiHash: project => 'sha256:' + (project === source ? 'a' : 'b').repeat(64),
      begin: (project, id, signature, sourceAbiHash) => {
        if (entries.has(id)) {
          if (entries.get(id).signature !== signature) throw Error('different options');
          return { ...entries.get(id), created: false };
        }
        const entry = { project, requestId: id, signature, sourceAbiHash, state: 'running' };
        entries.set(id, entry); return { ...entry, created: true };
      },
      complete: (_project, id, _signature, result, targetAbiHash) => {
        const entry = { ...entries.get(id), state: 'completed', result, targetAbiHash }; entries.set(id, entry); return entry;
      },
      status: (_project, id) => entries.get(id) ?? null,
    } } as any;
    service = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.projectService = {
      currentProjectPath: '', isProjectOpening: false, coderProjects: [],
      isProjectTransitionInProgress: () => false, getProjectMode: () => 'blockly',
      getBlocklyProjectLoadStatus: project => ({ project, ready: true, state: 'loaded' }),
      saveClosedRecoveryAs: jasmine.createSpy('closedCopy').and.callFake(async (from, to) => {
        expect(from).toBe(source); service.projectService.currentProjectPath = to;
        return { sourceProject: source, project: to, projectSaved: true, activated: true,
          recoverySource: { version: 1, kind: 'saved-document', complete: true, loadFailed: false, partialCanvas: 'not-applicable' },
          recoveryArchive: to + '/archive.json', projectionPending: true };
      }),
    };
  });
  afterEach(() => { window['fs'] = oldFs; window['path'] = oldPath; });

  it('opens only an independent copy and replays its receipt after the original response is lost', async () => {
    const request = { operation: 'project_recovery_open', params: { version: 1, requestId, project: source } };
    const started = await service.execute(request);
    expect(started.ok).toBeTrue(); expect(started.sourceGuardReleased).toBeFalse();
    expect(started.result.sourceProject).toBe(source); expect(started.result.project).not.toBe(source);
    expect(started.result.forkReceipt).toEqual(jasmine.objectContaining({ requestId, state: 'completed', project: source }));
    service.absApplyInProgress = true; service.boardSwitchInProgress = true;
    const observed = await service.execute({ operation: 'project_fork_status', params: { project: source, forkRequest: { version: 1, requestId } } });
    expect(observed.operation).toBe('project_fork_status'); expect(observed.result.project).toBe(started.result.project);
    expect(observed.result.activated).toBeTrue();
    const replay = await service.execute(request); expect(replay.result.project).toBe(started.result.project);
    expect(service.projectService.saveClosedRecoveryAs).toHaveBeenCalledTimes(1);
  });

  it('only observes an already open source without reload or creating another target', async () => {
    service.projectService.currentProjectPath = source;
    const result = await service.execute({ operation: 'project_recovery_open', params: { version: 1, requestId, project: source } });
    expect(result.observedOpen).toBeTrue(); expect(result.sourceGuardReleased).toBeFalse();
    expect(result.result).toBeUndefined(); expect(service.projectService.saveClosedRecoveryAs).not.toHaveBeenCalled();
  });

  it('does not replace another live view, and rejects forged request outcome fields', async () => {
    service.projectService.currentProjectPath = '/private/another-view';
    const result = await service.execute({ operation: 'project_recovery_open', params: { version: 1, requestId, project: source } });
    expect(result.ok).toBeFalse(); expect(result.result.code).toBe('PROJECT_RECOVERY_OPEN_VIEW_ACTIVE');
    expect(service.projectService.currentProjectPath).toBe('/private/another-view');
    expect(service.projectService.saveClosedRecoveryAs).not.toHaveBeenCalled();
    const invalid = await service.execute({ operation: 'project_recovery_open', params: { version: 1, requestId, project: source, force: true } });
    expect(invalid.code).toBe('PROJECT_RECOVERY_OPEN_INVALID');
  });
});

describe('independent recovery view handoff', () => {
  let previousFs: any, previousLibraries: any;
  beforeEach(() => { previousFs = window['fs']; previousLibraries = window['libraryDependencies']; });
  afterEach(() => { window['fs'] = previousFs; window['libraryDependencies'] = previousLibraries; });
  const source = '/private/unserialisable-source', target = '/private/independent-target';
  const forkReceipt = { version: 1, requestId: 'independent-request-001', project: source, state: 'completed' };
  function fork() { return { ok: true, operation: 'project_fork', sourceProject: source, project: target, projectSaved: true,
    activated: false, activationBlocked: { reason: 'partial-canvas-unavailable' }, forkReceipt }; }

  it('adds independent environment facts without claiming source activation or removing its blocked state', async () => {
    const environment = { version: 1, project: target, state: 'starting', originalViewPreserved: true };
    const ensure = jasmine.createSpy('nativeEnsure').and.resolveTo(environment);
    window['fs'] = { projectRepairEnvironment: { ensure } } as any;
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    const result = await bridge.withRepairEnvironment(fork());
    expect(ensure).toHaveBeenCalledOnceWith(source, forkReceipt.requestId);
    expect(result.activated).toBeFalse(); expect(result.activationBlocked.reason).toBe('partial-canvas-unavailable');
    expect(result.forkReceipt).toBe(forkReceipt); expect(result.repairEnvironment).toBe(environment);
  });

  it('resumes the same child through status after a lost initial response without replacing the source view', async () => {
    const environment = { version: 1, project: target, state: 'load-failed', hostPid: 202, originalViewPreserved: true };
    const ensure = jasmine.createSpy('nativeObserve').and.resolveTo(environment);
    window['fs'] = { projectRepairEnvironment: { ensure } } as any;
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype), original = fork();
    const response = await bridge.withRepairEnvironment({ ok: true, operation: 'project_fork_status', forkReceipt, result: original });
    expect(response.result.repairEnvironment).toBe(environment); expect(response.result.activated).toBeFalse();
    expect(original['repairEnvironment']).toBeUndefined(); expect(response.forkReceipt).toBe(forkReceipt);
  });

  it('does not launch for caller paths, unknown receipts, or other activation failures', async () => {
    const ensure = jasmine.createSpy('nativeEnsure'); window['fs'] = { projectRepairEnvironment: { ensure } } as any;
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    for (const response of [{ ...fork(), forkReceipt: undefined }, { ...fork(), forkReceipt: { ...forkReceipt, state: 'unknown' } },
      { ...fork(), activationBlocked: { reason: 'source-busy' } }]) await bridge.withRepairEnvironment(response);
    expect(ensure).not.toHaveBeenCalled();
  });

  function domain() {
    const service: any = Object.create(ProjectService.prototype), order: string[] = [];
    const outcome = { ...fork(), recoveryArchive: `${target}/recovery-source-proof.json`, targetAbiHash: 'sha256:' + 'a'.repeat(64) };
    Object.defineProperty(service, 'currentProjectPath', { value: '', writable: true, configurable: true });
    Object.defineProperty(service, 'coderProjects', { value: [], writable: true, configurable: true });
    Object.defineProperty(service, 'isProjectOpening', { value: false, writable: true, configurable: true });
    service.recoveryTargets = { has: () => false, remember: jasmine.createSpy('remember').and.callFake(async () => { order.push('admit'); }),
      advanceNormalization: jasmine.createSpy('advance').and.resolveTo(false) };
    service.projectOpen = jasmine.createSpy('open').and.callFake(async () => { order.push('open'); return false; });
    service.getBlocklyProjectLoadStatus = () => ({ project: target, ready: false, state: 'failed', error: 'Missing library' });
    window['fs'] = { projectRepairEnvironment: { admission: jasmine.createSpy('nativeAdmission').and.resolveTo(outcome) } } as any;
    return { service, order, outcome };
  }
  it('registers trusted saved-primary repair authority before the child first loads an incomplete target', async () => {
    const f = domain(), result = await f.service.openIndependentRepairTarget();
    expect(f.order).toEqual(['admit', 'open']); expect(result.loadStatus.error).toBe('Missing library');
    expect(f.service.projectOpen).toHaveBeenCalledOnceWith(target, { saveBeforeReload: false });
    expect(window['fs'].projectRepairEnvironment.admission).toHaveBeenCalledTimes(2);
  });
  it('records only actual typed Project Data CAS transitions during initial repair loading, including a later missing-library failure', async () => {
    const f = domain(), before = '{"blocks":{"blocks":[]}}';
    const archive = f.outcome.recoveryArchive, archiveText = '{"retained":"source proof"}';
    const disk = new Map([[`${target}/project.abi`, before], [`${source}/project.abi`, before], [archive, archiveText]]);
    f.service.createProjectDataStore = () => ({ put: async () => { throw new Error('No payload was expected.'); },
      flushPending: async () => {}, collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }) });
    Object.assign(window['fs'], { existsSync: path => disk.has(path), readFileSync: path => disk.get(path), projectFilePublicationVersion: 2,
      replaceProjectText: jasmine.createSpy('actualPublication').and.callFake(async request => {
        const path = `${request.projectPath}/${request.fileName}`, original = disk.get(path)!;
        if (`sha256:${await sha256Hex(original)}` !== request.expectedHash) return { status: 'CONFLICT' };
        disk.set(path, request.content);
        return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}`, backupHash: request.expectedHash };
      }) });
    f.service.projectOpen.and.callFake(async () => {
      await f.service.ensureProjectDataSchemaForLoad(target, JSON.parse(before), before);
      return false;
    });
    const result = await f.service.openIndependentRepairTarget();
    expect(result.normalizationTransitions.length).toBe(1);
    expect(result.normalizationTransitions[0]).toEqual(jasmine.objectContaining({ kind: 'project-data-normalization',
      beforeAbiHash: `sha256:${await sha256Hex(before)}`, changes: jasmine.objectContaining({ schemaMarker: 1 }),
      publication: jasmine.objectContaining({ status: 'COMMITTED', backupHash: `sha256:${await sha256Hex(before)}` }) }));
    expect(result.loadStatus.error).toBe('Missing library');
    expect(f.service.independentRepairNormalization).toBeUndefined();
    expect(window['fs'].replaceProjectText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(disk.get(`${target}/project.abi`)!).$ailyProjectData).toBeDefined();
    expect(disk.get(`${source}/project.abi`)).toBe(before); expect(disk.get(archive)).toBe(archiveText);
  });
  it('does not invent a repair normalization transition when filesystem inspection cannot prove ABI-only context', async () => {
    const f = domain(), before = '{"blocks":{"blocks":[]}}';
    let deferred: any, acknowledged: string | undefined;
    f.service.createProjectDataStore = () => ({ put: async () => { throw new Error('No payload was expected.'); },
      flushPending: async () => {}, collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }) });
    Object.assign(window['fs'], { projectFilePublicationVersion: 2, replaceProjectText: jasmine.createSpy('mustNotPublish') });
    f.service.projectOpen.and.callFake(async () => {
      await f.service.ensureProjectDataSchemaForLoad(target, JSON.parse(before), before, () => {},
        text => { acknowledged = text; }, receipt => { deferred = receipt; });
      return false;
    });
    const result = await f.service.openIndependentRepairTarget();
    expect(result.normalizationTransitions).toEqual([]);
    expect(window['fs'].replaceProjectText).not.toHaveBeenCalled();
    expect(f.service.recoveryTargets.advanceNormalization).not.toHaveBeenCalled();
    expect(acknowledged).toBe(before);
    expect(deferred).toEqual(jasmine.objectContaining({ mode: 'load', projectPath: target, originalContent: before }));
    expect(JSON.parse(deferred.persistedText).$ailyProjectData).toBeDefined();
    expect(result.loadStatus.error).toBe('Missing library');
    expect(f.service.independentRepairNormalization).toBeUndefined();
  });
  it('keeps managed dependency admission after actual markerless normalization then failed loading, and inspect does not offer another fork', async () => {
    const f = domain(), before = '{"blocks":{"blocks":[]}}', archive = f.outcome.recoveryArchive;
    f.service.recoveryTargets = undefined;
    Object.assign(f.outcome, { recoverySource: { version: 1, kind: 'saved-document', complete: true, loadFailed: true, partialCanvas: 'unavailable' } });
    const disk = new Map([[`${target}/project.abi`, before], [`${source}/project.abi`, before], [archive, '{"retained":"source proof"}']]);
    Object.assign(window['fs'], { existsSync: path => disk.has(path), readFileSync: path => disk.get(path), projectFilePublicationVersion: 2,
      replaceProjectText: jasmine.createSpy('nativeCAS').and.callFake(async request => {
        const path = `${request.projectPath}/${request.fileName}`, original = disk.get(path)!;
        if (`sha256:${await sha256Hex(original)}` !== request.expectedHash) return { status: 'CONFLICT' };
        disk.set(path, request.content);
        return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}`, backupHash: request.expectedHash };
      }) });
    f.service.createProjectDataStore = () => ({ flushPending: async () => {}, collectReferences: () => [],
      validateReferences: async () => ({ valid: true, issues: [] }) });
    f.service.getProjectMode = () => 'blockly'; f.service.isProjectTransitionInProgress = () => false;
    Object.defineProperty(f.service, 'application', { value: { hasActiveProjectMutation: () => false, hasActiveBlocklyBuildOrUpload: () => false } });
    Object.defineProperty(f.service, 'dependencyLifecycle', { value: { isBusy: () => false } });
    window['libraryDependencies'] = { status: async () => ({ dirty: false, busy: false }) } as any;
    f.service.projectOpen.and.callFake(async () => {
      f.service.currentProjectPath = target;
      await f.service.ensureProjectDataSchemaForLoad(target, JSON.parse(before), before);
      return false;
    });
    const boot = await f.service.openIndependentRepairTarget();
    expect(boot.normalizationTransitions.length).toBe(1); expect(boot.loadStatus.error).toBe('Missing library');
    const facts = await f.service.inspectSavedRecoveryTarget(target);
    expect(facts.abiHash).toBe(`sha256:${await sha256Hex(disk.get(`${target}/project.abi`)!)}`);
    expect(facts.sourceProject).toBe(source); expect(facts.recoveryArchive).toBe(archive);
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = f.service; bridge.aiOperations = { hasBlocking: () => false, setActive: jasmine.createSpy('writer') };
    const admission = await bridge.execute({ operation: 'project_abi_check', params: {} });
    expect(admission.scope).toBe('saved-recovery-project'); expect(admission.pendingMutation).toBeFalse();
    const inspection = await bridge.execute({ operation: 'abs_recovery', params: { version: 2, requestId: 'normalized-target-inspect', action: 'inspect' } });
    expect(inspection.diagnostics.loadRecovery.alreadyIndependent).toBeTrue();
    expect(inspection.diagnostics.loadRecovery.offer).toBeUndefined();
    expect(inspection.nextAction).toEqual({ tool: 'project_status', input: { project: target } });
    expect(inspection.guidance).toContain('Do not fork again');
    expect(disk.get(`${source}/project.abi`)).toBe(before); expect(disk.get(archive)).toBe('{"retained":"source proof"}');
  });
  it('does not replace an existing view or admit arbitrary caller-supplied target flags', async () => {
    const f = domain(); f.service.currentProjectPath = source;
    await expectAsync(f.service.openIndependentRepairTarget()).toBeRejectedWithError(/cannot replace/);
    expect(f.service.projectOpen).not.toHaveBeenCalled(); expect(f.service.recoveryTargets.remember).not.toHaveBeenCalled();
    f.service.currentProjectPath = ''; window['fs'].projectRepairEnvironment.admission.and.resolveTo(null);
    await expectAsync(f.service.openIndependentRepairTarget()).toBeRejectedWithError(/cannot replace/);
    expect(f.service.projectOpen).not.toHaveBeenCalled();
  });
  it('rechecks native fork/primary evidence after marker capture and refuses a changed target', async () => {
    const f = domain(); window['fs'].projectRepairEnvironment.admission.and.returnValues(Promise.resolve(f.outcome), Promise.resolve({ ...f.outcome, targetAbiHash: 'changed' }));
    await expectAsync(f.service.openIndependentRepairTarget()).toBeRejectedWithError(/evidence changed/);
    expect(f.service.projectOpen).not.toHaveBeenCalled();
  });
});
