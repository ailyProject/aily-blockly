import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { forkProject } from './project-fork-operation';

describe('same-project recovery automation boundary', () => {
  const source = '/isolated/source';
  function fixture() {
    const service: any = { currentProjectPath: source,
      saveRecoveryAs: jasmine.createSpy('copy'), save: jasmine.createSpy('save') };
    return service;
  }

  for (const params of [{}, { targetPath: '/isolated/copy' }, { targetPath: source + '/backup' },
    { explicitUserRequest: true }, { forkRequest: { version: 1, requestId: 'legacy-copy-request' } }]) {
    it(`rejects a recovery copy before saving or selecting any target: ${JSON.stringify(params)}`, async () => {
      const service = fixture(), result = await forkProject(service, source, params);
      expect(result).toEqual(jasmine.objectContaining({ ok: false, project: source,
        code: 'PROJECT_RECOVERY_IN_PLACE_REQUIRED', createdProject: false, projectSaved: false, candidateApplied: false }));
      expect(result['nextAction']).toEqual({ tool: 'project_recover', input: { project: source, action: 'inspect' } });
      expect(service.currentProjectPath).toBe(source);
      expect(service.saveRecoveryAs).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
    });
  }

  it('rejects successive recovery-copy requests even after a prior target became current', async () => {
    const service = fixture();
    const first = await forkProject(service, source, { targetPath: '/isolated/p1' });
    service.currentProjectPath = '/isolated/prior-recovery';
    const second = await forkProject(service, service.currentProjectPath, { targetPath: '/isolated/p2' });
    expect(first['createdProject']).toBeFalse(); expect(second['createdProject']).toBeFalse();
    expect(second['project']).toBe('/isolated/prior-recovery'); expect(service.saveRecoveryAs).not.toHaveBeenCalled();
  });

  it('the live host rejects before reading a supplied receipt, running native policy or dispatching a mutation', async () => {
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = fixture();
    bridge.executeOperation = jasmine.createSpy('dispatch').and.throwError('must not dispatch');
    const previous = window['fs'];
    window['fs'] = { projectRecoveryReceipts: { begin: jasmine.createSpy('begin').and.throwError('must not allocate') } } as any;
    try {
      const result = await bridge.execute({ operation: 'project_fork', path: source,
        params: { forkRequest: { version: 1, requestId: 'legacy-host-copy' }, targetPath: '/isolated/copy' } });
      expect(result.code).toBe('PROJECT_RECOVERY_IN_PLACE_REQUIRED');
      expect(window['fs'].projectRecoveryReceipts.begin).not.toHaveBeenCalled();
      expect(bridge.executeOperation).not.toHaveBeenCalled();
    } finally { window['fs'] = previous; }
  });

  it('refreshes an old receipt against the actual current phase without masking unrelated failures', () => {
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.projectService = { currentProjectPath: source,
      getBlocklyProjectLoadStatus: () => ({ project: source, ready: true, state: 'loaded' }) };
    const result = bridge.refreshForkResult({ project: source, code: 'PROJECT_RECOVERY_RUNTIME_REQUIRED',
      error: 'Load the target runtime before continuing.', partial: true, projectionPending: true, generatedCodePublished: false });
    expect(result.activated).toBeTrue(); expect(result.code).toBeUndefined(); expect(result.error).toBeUndefined();
    expect(result.projectionPending).toBeTrue(); expect(result.generatedCodePublished).toBeFalse();
    expect(bridge.refreshForkResult({ project: source, code: 'REAL_PUBLICATION_FAILURE', error: 'retain' }).code)
      .toBe('REAL_PUBLICATION_FAILURE');
  });
});
