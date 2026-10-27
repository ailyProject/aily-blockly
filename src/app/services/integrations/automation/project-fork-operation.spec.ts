import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { forkProject, type ProjectForkNative } from './project-fork-operation';

describe('isolated Blockly project fork', () => {
  function fixture() {
    const source = '/isolated/source';
    const service: any = {
      currentProjectPath: source,
      getProjectMode: () => 'blockly',
      isProjectOpening: false,
      isProjectTransitionInProgress: () => false,
      save: jasmine.createSpy('sourceSave').and.throwError('Source must not be saved'),
    };
    const native: ProjectForkNative = {
      path: {
        dirname: path => path.slice(0, path.lastIndexOf('/')),
        basename: path => path.slice(path.lastIndexOf('/') + 1),
        join: (...parts) => parts.join('/'), resolve: path => path,
        isAbsolute: path => path.startsWith('/'),
      },
      exists: () => false, windows: false,
    };
    service.saveRecoveryAs = jasmine.createSpy('saveRecoveryAs').and.callFake(async (target: string) => {
      service.currentProjectPath = target;
      return { sourceProject: source, project: target, projectSaved: true,
        generatedCodePublished: true, partial: false, activated: true };
    });
    return { service, native, source };
  }

  it('automatically chooses a fresh sibling, publishes the unsaved snapshot through SaveAs and confirms activation', async () => {
    const f = fixture();
    const result = await forkProject(f.service, f.source, {}, f.native);
    expect(result['ok']).toBeTrue();
    expect(result['operation']).toBe('project_fork');
    expect(result['project']).toMatch(/^\/isolated\/source-recovered-[a-f0-9]{8}$/);
    expect(result['projectSaved']).toBeTrue(); expect(result['activated']).toBeTrue();
    expect(result['sourceProject']).toBe(f.source); expect(result['originalWorkspaceReleased']).toBeFalse();
    expect(f.service.saveRecoveryAs).toHaveBeenCalledOnceWith(result['project']);
    expect(f.service.save).not.toHaveBeenCalled();
  });

  it('preserves a completed copy when a live source build prevents activation', async () => {
    const f = fixture(), target = '/isolated/copy with spaces';
    f.service.saveRecoveryAs.and.resolveTo({ sourceProject: f.source, project: target, projectSaved: true,
      generatedCodePublished: true, partial: false, activated: false, warnings: ['source build still owns lifecycle'] });
    const result = await forkProject(f.service, f.source, { targetPath: target }, f.native);
    expect(result).toEqual(jasmine.objectContaining({ ok: true, project: target, projectSaved: true,
      activated: false, partial: true, warnings: ['source build still owns lifecycle'], originalWorkspaceReleased: false }));
    expect(f.service.currentProjectPath).toBe(f.source);
    expect(f.service.save).not.toHaveBeenCalled();
  });

  it('uses only native policy to publish a nested target without navigating the exact-source repair host', async () => {
    const f = fixture(), target = '/isolated/nested';
    f.native.forkPolicy = async params => ({ version: 1, ...params, activation: 'deferred', reason: 'isolated-repair-host' });
    f.service.saveRecoveryAs.and.resolveTo({ sourceProject: f.source, project: target, projectSaved: true,
      generatedCodePublished: false, projectionPending: true, partial: false, activated: false,
      activationDeferred: { reason: 'isolated-repair-host' },
      recoverySource: { version: 1, kind: 'workspace', complete: true, loadFailed: false, partialCanvas: 'not-applicable' } });
    const result = await forkProject(f.service, f.source, { targetPath: target }, f.native);
    expect(f.service.saveRecoveryAs).toHaveBeenCalledOnceWith(target, { activation: 'retain-source' });
    expect(f.service.currentProjectPath).toBe(f.source); expect(f.service.save).not.toHaveBeenCalled();
    expect(result).toEqual(jasmine.objectContaining({ ok: true, projectSaved: true, activated: false,
      activationDeferred: { reason: 'isolated-repair-host' }, originalWorkspaceReleased: false }));
    expect(result['loadStatus']).toBeUndefined(); expect(result['guidance']).toContain('宿主交接');
  });

  it('refuses a stale native policy before publishing and never exposes activation policy as an Agent option', async () => {
    const f = fixture(), target = '/isolated/nested';
    f.native.forkPolicy = async params => ({ version: 1, ...params, sourceProject: '/foreign', activation: 'deferred', reason: 'isolated-repair-host' });
    expect((await forkProject(f.service, f.source, { targetPath: target }, f.native))['code']).toBe('PROJECT_FORK_POLICY_INVALID');
    expect((await forkProject(f.service, f.source, { targetPath: target, activation: 'retain-source' }, f.native))['code']).toBe('PROJECT_FORK_INVALID');
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled();
  });

  it('does not claim activation based only on a stale SaveAs receipt', async () => {
    const f = fixture(), target = '/isolated/copy';
    f.service.saveRecoveryAs.and.resolveTo({ sourceProject: f.source, project: target, projectSaved: true,
      generatedCodePublished: true, partial: false, activated: true });
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: true, projectSaved: true, activated: false, partial: true }));
  });

  it('does not claim activation if the user changes projects during final physical-path verification', async () => {
    const f = fixture(), target = '/isolated/copy';
    f.service.saveRecoveryAs.and.callFake(async () => {
      f.service.currentProjectPath = '/active-alias';
      return { sourceProject: f.source, project: target, projectSaved: true,
        generatedCodePublished: true, partial: false, activated: true };
    });
    f.native.realpath = async value => {
      if (value === '/active-alias') { f.service.currentProjectPath = '/replacement'; return target; }
      return value;
    };
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: true, projectSaved: true, activated: false, partial: true }));
  });

  it('rejects a different requested source before saving any project', async () => {
    const f = fixture();
    expect(await forkProject(f.service, '/another', {}, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_FORK_CONTEXT_STALE', projectSaved: false }));
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled();
  });

  it('rejects a source switch during physical-path verification', async () => {
    const f = fixture();
    f.native.realpath = async () => { f.service.currentProjectPath = '/replacement'; return f.source; };
    expect(await forkProject(f.service, '/alias', {}, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_FORK_CONTEXT_STALE' }));
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled();
  });

  it('accepts a canonical alias for the same source without rebinding the open workspace', async () => {
    const f = fixture();
    f.native.realpath = async value => value === '/alias' ? f.source : value;
    expect((await forkProject(f.service, '/alias', {}, f.native))['ok']).toBeTrue();
  });

  for (const state of ['opening', 'transition', 'coder']) it(`does not bypass ${state} source protection`, async () => {
    const f = fixture();
    if (state === 'opening') f.service.isProjectOpening = true;
    if (state === 'transition') f.service.isProjectTransitionInProgress = () => true;
    if (state === 'coder') f.service.getProjectMode = () => 'coder';
    expect((await forkProject(f.service, f.source, {}, f.native))['ok']).toBeFalse();
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled();
  });

  for (const params of [{ targetPath: 4 }, { cleanup: true }, { targetPath: '' }, { targetPath: 'relative/copy' }]) {
    it(`rejects unsupported parameters ${JSON.stringify(params)} without writes`, async () => {
      const f = fixture();
      expect((await forkProject(f.service, f.source, params, f.native))['ok']).toBeFalse();
      expect(f.service.saveRecoveryAs).not.toHaveBeenCalled();
    });
  }

  it('keeps destination validation owned by SaveAs and reports its actual failure without claiming a saved copy', async () => {
    const f = fixture();
    f.service.saveRecoveryAs.and.rejectWith(Object.assign(new Error('destination is inside the source'), { code: 'TARGET_INVALID' }));
    expect(await forkProject(f.service, f.source, { targetPath: '/aliased-source/child' }, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'TARGET_INVALID', projectSaved: false, activated: false }));
    expect(f.service.save).not.toHaveBeenCalled();
  });

  for (const target of ['/isolated/source', '/isolated/source/child']) it(`rejects ${target} before saving either project`, async () => {
    const f = fixture();
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_FORK_TARGET_INVALID', projectSaved: false }));
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled(); expect(f.service.save).not.toHaveBeenCalled();
  });

  it('does not overwrite an explicit target collision or fall back to saving the source', async () => {
    const f = fixture(), target = '/isolated/existing';
    f.service.saveRecoveryAs.and.rejectWith(Object.assign(new Error('target already exists'), { code: 'EEXIST' }));
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'EEXIST', projectSaved: false, activated: false }));
    expect(f.service.saveRecoveryAs).toHaveBeenCalledOnceWith(target);
    expect(f.service.save).not.toHaveBeenCalled();
  });

  it('bounds automatic naming collisions without creating a directory or saving any project', async () => {
    const f = fixture(); f.native.exists = () => true;
    expect(await forkProject(f.service, f.source, {}, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_FORK_TARGET_BUSY', projectSaved: false }));
    expect(f.service.saveRecoveryAs).not.toHaveBeenCalled(); expect(f.service.save).not.toHaveBeenCalled();
  });

  it('preserves truthful partial publication evidence from a completed target snapshot', async () => {
    const f = fixture(), target = '/isolated/copy';
    f.service.saveRecoveryAs.and.resolveTo({ sourceProject: f.source, project: target, projectSaved: true,
      generatedCodePublished: false, partial: true, activated: false,
      code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED', error: 'derived publication is protected', warnings: ['copy remains saved'] });
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: true, projectSaved: true, generatedCodePublished: false,
        partial: true, activated: false, code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED', error: 'derived publication is protected' }));
  });

  it('preserves an uncertain target receipt and never treats projectSaved:false as permission to delete or overwrite it', async () => {
    const f = fixture(), target = '/isolated/copy';
    f.service.saveRecoveryAs.and.resolveTo({ sourceProject: f.source, project: target, projectSaved: false,
      generatedCodePublished: false, partial: true, activated: false,
      code: 'PROJECT_SAVE_AS_UNKNOWN', error: 'destination receipt lost', warnings: ['preserve destination'] });
    expect(await forkProject(f.service, f.source, { targetPath: target }, f.native))
      .toEqual(jasmine.objectContaining({ ok: false, project: target, projectSaved: false, partial: true,
        activated: false, code: 'PROJECT_SAVE_AS_UNKNOWN', error: 'destination receipt lost', warnings: ['preserve destination'] }));
    expect(f.service.saveRecoveryAs).toHaveBeenCalledTimes(1);
    expect(f.service.save).not.toHaveBeenCalled();
  });

  for (const outcome of [undefined, { projectSaved: false }, { projectSaved: true, project: '/foreign', sourceProject: '/wrong' }]) {
    it(`refuses an unconfirmed or unrelated copy receipt ${JSON.stringify(outcome)}`, async () => {
      const f = fixture(); f.service.saveRecoveryAs.and.resolveTo(outcome);
      expect(await forkProject(f.service, f.source, { targetPath: '/isolated/copy' }, f.native))
        .toEqual(jasmine.objectContaining({ ok: false, code: 'PROJECT_FORK_UNCONFIRMED', projectSaved: false, activated: false }));
    });
  }
});

describe('fork lifecycle admission', () => {
  function fixture() {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.mutationSequence = 0;
    service.aiOperations = { setActive: jasmine.createSpy('lifecycleMask') };
    service.projectService = { currentProjectPath: '/isolated', isProjectTransitionInProgress: () => false };
    service.executeOperation = jasmine.createSpy('execute').and.resolveTo({ ok: true });
    return service;
  }

  it('does not install a generic lifecycle mask that would reject its own normal activation', async () => {
    const service = fixture();
    await service.execute({ operation: 'project_fork', path: '/isolated', params: {} });
    expect(service.executeOperation).toHaveBeenCalledTimes(1);
    expect(service.aiOperations.setActive).not.toHaveBeenCalled();
  });

  for (const operation of ['project_save', 'blocks_tidy']) it(`retains the normal mutation protection for ${operation}`, async () => {
    const service = fixture();
    await service.execute({ operation, path: '/isolated', params: {} });
    expect(service.aiOperations.setActive.calls.allArgs()).toEqual([
      [jasmine.any(String), true, { projectPath: '/isolated', blocksProjectLifecycle: true }],
      [jasmine.any(String), false],
    ]);
  });

  for (const gate of ['boardSwitchInProgress', 'absApplyInProgress']) it(`retains ${gate} protection for fork`, async () => {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service[gate] = true;
    expect((await service.executeOperation({ operation: 'project_fork', params: {} })).ok).toBeFalse();
  });
});
