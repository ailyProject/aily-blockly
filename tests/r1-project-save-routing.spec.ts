import { BehaviorSubject } from 'rxjs';
import { ProjectService, type ProjectSaveRequest } from '@domain/project/public-api';
import { ProjectSaveReceipts } from '../src/app/services/domains/project/project-save-receipts';

describe('R1 UI save routing through the real receipt manager', () => {
  const project = '/isolated-r1-ui-save';
  let oldFs: any, oldPath: any, oldDependencies: any;
  let execute: jasmine.Spy;

  beforeEach(() => {
    oldFs = window['fs'];
    oldPath = window['path'];
    oldDependencies = window['libraryDependencies'];
    window['path'] = {
      isAbsolute: (value: string) => value.startsWith('/'),
      join: (...parts: string[]) => parts.join('/'),
      isExists: () => false,
    } as any;
    window['libraryDependencies'] = undefined;
    execute = spyOn(ProjectSaveReceipts.prototype, 'execute').and.callThrough();
  });

  afterEach(() => {
    window['fs'] = oldFs;
    window['path'] = oldPath;
    window['libraryDependencies'] = oldDependencies;
  });

  function controlledDomain(capability: 1 | 2, durableFacts: Record<string, any>, actionFacts: Record<string, any>) {
    window['fs'] = capability === 2 ? { nativeSaveReceiptVersion: 2, projectProgramPublicationVersion: 1,
      projectSyncStorageVersion: 2, openProjectSyncStorage() {} } as any : {};
    const domain: any = Object.create(ProjectService.prototype);
    domain.currentProjectPathSubject = new BehaviorSubject(project);
    domain.stateSubject = new BehaviorSubject('loaded');
    domain.getProjectMode = () => capability === 2 ? 'blockly' : 'coder';
    domain.getPackageJson = jasmine.createSpy('manifest').and.resolveTo({ name: 'controlled-r1-ui-project' });
    const observations: ProjectSaveRequest[] = [];
    let original: any;
    const dispatch = jasmine.createSpy('Action dispatch').and.callFake(async (
      path: string, timeout: number, request?: ProjectSaveRequest,
    ) => {
      expect(path).toBe(project);
      expect(timeout).toBe(0);
      if (request) {
        // Controlled application-port record, not a simulated native journal or commit proof.
        original = {
          ok: true,
          operation: request.operation,
          saveReceipt: { version: 2, project, requestId: request.requestId, operation: request.operation, state: 'completed' },
          result: { ...durableFacts },
        };
      }
      return { ...actionFacts };
    });
    const observe = jasmine.createSpy('durable publication port').and.callFake(async (
      path: string, request: ProjectSaveRequest,
    ) => {
      expect(path).toBe(project);
      observations.push({ ...request });
      if (original) expect(request.requestId).toBe(original.saveReceipt.requestId);
      return original ?? null;
    });
    domain.injector = { get: () => ({ dispatchProjectSave: dispatch, observeProjectPublication: observe }) };
    return { domain, dispatch, observe, observations, original: () => original };
  }

  it('passes one new pub2 request through UI, real manager and Action, then maps durable ok without legacy success', async () => {
    const f = controlledDomain(2,
      { ok: true, projectSaved: true, partial: false },
      { success: true, projectSaved: true, generatedCodePublished: true, partial: false });

    const saved = await f.domain.save(project);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    const actionArgs = f.dispatch.calls.mostRecent().args;
    expect(actionArgs.length).toBe(3);
    const request = actionArgs[2] as ProjectSaveRequest;
    expect(request.version).toBe(2);
    expect(request.operation).toBe('project_save');
    expect(request.requestId).toMatch(/^pub2-[a-f0-9-]{36}$/);
    expect((execute.calls.mostRecent().args[1] as ProjectSaveRequest).requestId).toBe(request.requestId);
    expect(f.observations.length).toBeGreaterThanOrEqual(2);
    expect(f.observations.every(observed => observed.version === 2 && observed.requestId === request.requestId)).toBeTrue();
    expect(Object.hasOwn(f.original().result, 'success')).toBeFalse();
    expect(saved.success).toBeTrue();
    expect(saved.projectSaved).toBeTrue();
    expect(saved.partial).toBeFalse();
    expect(saved.saveReceipt.version).toBe(2);
    expect(saved.saveReceipt.requestId).toBe(request.requestId);
    expect(f.domain.stateSubject.value).toBe('saved');
  });

  it('keeps a partial source result unsuccessful while Coder retains the two-argument dispatch', async () => {
    const partial = controlledDomain(2,
      { ok: true, projectSaved: true, generatedCodePublished: false, partial: true,
        publication: { status: 'COMMITTED' }, code: 'CONTROLLED_DERIVED_PENDING' },
      { success: false, projectSaved: true, generatedCodePublished: false, partial: true,
        publication: { status: 'COMMITTED' }, code: 'CONTROLLED_DERIVED_PENDING', error: 'controlled post-source failure' });

    const saved = await partial.domain.save(project);

    expect(saved.success).toBeFalse();
    expect(saved.projectSaved).toBeTrue();
    expect(saved.partial).toBeTrue();
    expect(saved.publication.status).toBe('COMMITTED');
    expect(saved.code).toBe('CONTROLLED_DERIVED_PENDING');
    expect(saved.saveReceipt.state).toBe('completed');
    expect(partial.dispatch.calls.mostRecent().args.length).toBe(3);

    // Coder has its own manager and completion; it does not borrow the Blockly publication cohort.
    const legacy = controlledDomain(1, {},
      { success: true, projectSaved: true, generatedCodePublished: true, partial: false });
    const legacySaved = await legacy.domain.save(project);
    expect(legacySaved.success).toBeTrue();
    expect(legacySaved.saveReceipt.version).toBe(1);
    expect(legacy.dispatch).toHaveBeenCalledOnceWith(project, 0);
    expect(legacy.dispatch.calls.mostRecent().args.length).toBe(2);
    expect(legacy.observe).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps a live local writer pending and reads its durable result with the original executor after settlement', async () => {
    const f = controlledDomain(2, {}, {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let durable: any = null;
    f.observe.and.callFake(async () => durable);
    f.dispatch.and.callFake(async (_path: string, _timeout: number, request: ProjectSaveRequest) => {
      const receipt = { version: 2, project, requestId: request.requestId, operation: request.operation, state: 'completed' };
      // The application port can already prove source commit while the real
      // manager's original callback is still completing post-save work.
      durable = { ok: true, operation: 'project_save_status', saveReceipt: receipt,
        result: { ok: false, projectSaved: true, partial: true, publication: { status: 'COMMITTED' } } };
      await gate;
      durable = { ...durable, result: { ok: true, projectSaved: true, partial: false, publication: { status: 'COMMITTED' } } };
      return { success: true, projectSaved: true, generatedCodePublished: true, partial: false };
    });
    const saving = f.domain.save(project);
    try {
      const deadline = Date.now() + 1000;
      while (!f.dispatch.calls.any() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      const request = f.dispatch.calls.mostRecent().args[2] as ProjectSaveRequest;
      const lookups = f.observe.calls.count();
      const pending = await f.domain.observeProjectPublication(project, { ...request, waitMs: 0 }, 901);
      expect(pending.saveReceipt.state).toBe('running');
      expect(pending.result).toBeUndefined();
      expect(f.observe.calls.count()).toBe(lookups);
      release();
      expect((await saving).success).toBeTrue();
      const complete = await f.domain.observeProjectPublication(project, request, 901);
      expect(complete.saveReceipt.state).toBe('completed');
      expect(complete.result?.partial).toBeFalse();
      expect(f.observe.calls.mostRecent().args[2]).toBe(901);
    } finally { release(); await saving; }
  });

  it('keeps Coder legacy saves available under a v2 host and enforces durable saves after changing project mode', async () => {
    const f = controlledDomain(2, { ok: true, projectSaved: true, partial: false },
      { success: true, projectSaved: true, generatedCodePublished: true, partial: false });
    f.domain.getProjectMode = () => 'coder';
    const coder = await f.domain.save(project);
    expect(coder.success).toBeTrue();
    expect(coder.saveReceipt.version).toBe(1);
    expect(f.dispatch.calls.mostRecent().args.length).toBe(2);
    expect(f.observe).not.toHaveBeenCalled();
    f.domain.getProjectMode = () => 'blockly';
    const blockly = await f.domain.save(project);
    expect(blockly.success).toBeTrue();
    expect(blockly.saveReceipt.version).toBe(2);
    expect(f.dispatch.calls.mostRecent().args[2].version).toBe(2);
    await expectAsync(f.domain.startProjectSaveReceipt(project,
      { version: 1, requestId: 'legacy-must-not-mutate-blockly', operation: 'project_save' }, async () => ({ ok: true })))
      .toBeRejectedWithError(/matching durable save protocol/);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
});
