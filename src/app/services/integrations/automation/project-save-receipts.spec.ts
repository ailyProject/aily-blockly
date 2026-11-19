import { BehaviorSubject } from 'rxjs';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { ProjectService, type ProjectSaveRequest } from '@domain/project/public-api';
import { BlocklyLiveOperationBridgeService } from './blockly-live-operation-bridge.service';

describe('shared project save receipts and original completion', () => {
  const project = '/isolated-save', originalId = 'pub2-00000000-0000-4000-8000-000000000001';
  const request = (id = originalId, waitMs = 0): ProjectSaveRequest => ({
    version: 2, requestId: id, operation: 'project_save', waitMs,
  });
  let oldPath: any, oldFs: any, domain: any, bridge: any, dispatch: jasmine.Spy;

  beforeEach(() => {
    oldPath = window['path']; oldFs = window['fs'];
    window['path'] = { isAbsolute: (value: string) => value.startsWith('/'),
      join: (...parts: string[]) => parts.join('/'), isExists: () => false } as any;
    window['fs'] = { projectProgramPublicationVersion: 1, nativeSaveReceiptVersion: 2,
      projectSyncStorageVersion: 2, openProjectSyncStorage: async () => { throw new Error('Unexpected native storage read'); } };
    domain = Object.create(ProjectService.prototype);
    domain.currentProjectPathSubject = new BehaviorSubject(project);
    domain.stateSubject = new BehaviorSubject('loaded');
    domain.getProjectMode = () => 'blockly';
    domain.getPackageJson = jasmine.createSpy('manifest').and.resolveTo({ name: 'isolated' });
    dispatch = jasmine.createSpy('save').and.resolveTo({ success: true,
      projectSaved: true, generatedCodePublished: true, partial: false });
    const history = new Map<string, unknown>();
    const complete = (path: string, input: ProjectSaveRequest, result: unknown) =>
      history.set(input.requestId, { ok: true, operation: 'project_save_status', result,
        saveReceipt: { version: 2, project: path, requestId: input.requestId, operation: input.operation, state: 'completed' } });
    domain.injector = { get: () => ({
      dispatchProjectSave: async (path: string, timeout: number, input?: ProjectSaveRequest) => {
        const result = await dispatch(path, timeout, input);
        if (input) complete(path, input, result);
        return result;
      },
      observeProjectPublication: async (_path: string, input: ProjectSaveRequest) => history.get(input.requestId) ?? null,
    }) };
    bridge = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = domain;
    bridge.executeAdmittedOperation = jasmine.createSpy('admitted').and.resolveTo({
      ok: true, projectSaved: true, generation: 'original' });
    bridge.executeSaveAdmission = async (payload: unknown, path: string, input: ProjectSaveRequest) => {
      const result = await bridge.executeAdmittedOperation(payload, input);
      complete(path, input, result);
      return result;
    };
  });
  afterEach(() => { window['path'] = oldPath; window['fs'] = oldFs; });

  it('manual save owns the actual Action completion and its queryable receipt, not a five-second observer timer', fakeAsync(() => {
    let finish!: (value: any) => void, saved: any;
    dispatch.and.returnValue(new Promise(resolve => { finish = resolve; }));
    domain.save(project, 5000).then(value => { saved = value; });
    flushMicrotasks(); tick(15001);
    expect(saved).toBeUndefined(); expect(domain.stateSubject.value).toBe('saving');
    expect(dispatch).toHaveBeenCalledOnceWith(project, 0, jasmine.objectContaining({ version: 2 }));
    finish({ success: true, projectSaved: true, generatedCodePublished: true, partial: false }); flushMicrotasks();
    expect(saved.success).toBeTrue(); expect(saved.saveReceipt.state).toBe('completed');
    let observed: any;
    domain.getProjectSaveReceipt(project, { ...request(saved.saveReceipt.requestId), waitMs: 0 }).then(value => { observed = value; });
    flushMicrotasks(); expect(observed.result.success).toBeTrue(); expect(dispatch).toHaveBeenCalledTimes(1);
  }));

  it('preserves a false/partial business outcome rather than turning a completed receipt into saved success', async () => {
    dispatch.and.resolveTo({ success: false, projectSaved: true, generatedCodePublished: false, partial: true,
      code: 'DERIVED_OUTPUT_FAILED', error: 'publish failed' });
    const saved = await domain.save(project);
    expect(saved.success).toBeFalse(); expect(saved.projectSaved).toBeTrue(); expect(saved.partial).toBeTrue();
    expect(saved.code).toBe('DERIVED_OUTPUT_FAILED'); expect(saved.saveReceipt.state).toBe('completed');
    expect(domain.stateSubject.value).toBe('saved');
  });

  it('a late completion cannot mark a replacement project saved or read its manifest', fakeAsync(() => {
    let finish!: (value: any) => void, saved: any;
    dispatch.and.returnValue(new Promise(resolve => { finish = resolve; }));
    domain.save(project).then(value => { saved = value; }); flushMicrotasks();
    expect(dispatch).toHaveBeenCalledTimes(1);
    domain.currentProjectPathSubject.next('/replacement'); domain.stateSubject.next('loaded');
    finish({ success: true, projectSaved: true, generatedCodePublished: true, partial: false }); flushMicrotasks();
    expect(saved.success).toBeTrue(); expect(domain.stateSubject.value).toBe('loaded');
    expect(domain.getPackageJson).not.toHaveBeenCalled();
  }));

  it('a new manual save intention is never coalesced with a previous revision', async () => {
    const first = await domain.save(project), second = await domain.save(project);
    expect(first.saveReceipt.requestId).not.toBe(second.saveReceipt.requestId);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('one Agent start and a pure status query retain the original result after the transport observer is gone', async () => {
    const params = { project, saveRequest: request() };
    await bridge.execute({ operation: 'project_save', params });
    const complete = await bridge.execute({ operation: 'project_save_status', params: { project, saveRequest: request(originalId, 100) } });
    expect(complete.saveReceipt.state).toBe('completed'); expect(complete.result.generation).toBe('original');
    await bridge.execute({ operation: 'project_save', params });
    expect(bridge.executeAdmittedOperation).toHaveBeenCalledTimes(1);
  });

  it('status remains readonly after the original project closes and new writes are blocked', async () => {
    await bridge.execute({ operation: 'project_save', params: { project, saveRequest: request() } });
    domain.currentProjectPathSubject.next('/another'); bridge.absApplyInProgress = true; bridge.boardSwitchInProgress = true;
    const result = await bridge.execute({ operation: 'project_save_status', params: { project, saveRequest: request(originalId, 100) } });
    expect(result.saveReceipt.project).toBe(project); expect(result.result.ok).toBeTrue();
    expect(bridge.executeAdmittedOperation).toHaveBeenCalledTimes(1);
  });

  it('rejects missing project, contradictory project aliases, wrong operation, and forged status options without running code', async () => {
    for (const payload of [
      { operation: 'project_save_status', params: { saveRequest: request() } },
      { operation: 'project_save_status', path: '/other', params: { project, saveRequest: request() } },
      { operation: 'blocks_tidy', params: { project, saveRequest: request() } },
      { operation: 'project_save_status', params: { project, saveRequest: request(), force: true } },
    ]) expect((await bridge.execute(payload)).code).toBe('PROJECT_SAVE_RECEIPT_INVALID');
    expect(bridge.executeAdmittedOperation).not.toHaveBeenCalled();
  });

  it('missing receipt is unknown and never starts a save for the active project', async () => {
    const result = await bridge.execute({ operation: 'project_save_status', params: { project, saveRequest: request() } });
    expect(result.saveReceipt.state).toBe('unknown'); expect(result.result).toBeUndefined();
    expect(bridge.executeAdmittedOperation).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('a canceled dependency context before queued execution is terminal without writing', async () => {
    domain.getProjectMode = () => 'coder';
    const legacy = { ...request('agent-save-1', 100), version: 1 };
    const lifecycle = domain.dependencyLifecycle, session = lifecycle.ensure(project);
    const first = domain.startProjectSaveReceipt(project, legacy, async () => { throw Error('must not run'); });
    lifecycle.cancel(project); await first;
    const terminal = await domain.getProjectSaveReceipt(project, legacy);
    expect(terminal.result.code).toBe('PROJECT_SAVE_RECEIPT_CONTEXT_STALE');
    expect(session.signal.aborted).toBeTrue(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('the real save branch preserves its editor publication facts and original failure code', async () => {
    domain.ensureBlocklyLibraryRuntimeReady = async () => undefined;
    bridge.blocklyEditor = { saveProject: jasmine.createSpy('nativeSave').and.resolveTo({
      projectSaved: true, generatedCodePublished: true, partial: false, generation: 'native-generation',
    }) };
    const saved = await bridge.executeProjectSave();
    expect(saved.projectSaved).toBeTrue(); expect(saved.generation).toBe('native-generation');
    bridge.blocklyEditor.saveProject.and.rejectWith(Object.assign(new Error('snapshot stale'), { code: 'ABS_CONTEXT_STALE' }));
    const failed = await bridge.executeProjectSave();
    expect(failed.ok).toBeFalse(); expect(failed.code).toBe('ABS_CONTEXT_STALE');
  });
});
