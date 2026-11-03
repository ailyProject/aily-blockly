import { projectViewOpenError } from '@domain/project/public-api';
import { BlocklyLiveOperationBridgeService } from './blockly-live-operation-bridge.service';
import { projectViewRecoveryFailure } from './project-view-recovery';

describe('noninteractive view conflicts and executable recovery guidance', () => {
  const project = '/isolated/source';
  const failure = state => projectViewOpenError(project, { code: state === 'unknown' ? 'PROJECT_VIEW_OWNER_UNKNOWN'
    : state === 'busy' ? 'PROJECT_VIEW_BUSY' : 'PROJECT_VIEW_OCCUPIED', ownership: { state }, holder: { pid: 202 } });
  it('offers the existing guarded closed-source tool for an unknown view with a saved document', () => {
    const result = projectViewRecoveryFailure(failure('unknown'), project,
      { mode: 'blockly', hasOpenView: false, hasSavedDocument: () => true });
    expect(result?.nextAction).toEqual({ tool: 'project_recover', input: { project, action: 'open' } });
    expect(result?.sourceViewPreserved).toBeTrue(); expect(result?.projectView.holder?.pid).toBe(202);
  });
  for (const state of ['active', 'busy']) it(`does not fork around ${state} ownership`, () => {
    const document = jasmine.createSpy('disk').and.returnValue(true);
    const result = projectViewRecoveryFailure(failure(state), project,
      { mode: 'blockly', hasOpenView: false, hasSavedDocument: document });
    expect(result?.nextAction).toEqual({ tool: 'app_info', input: {} });
    expect(document).not.toHaveBeenCalled();
  });
  for (const context of [{ mode: 'coder', hasOpenView: false }, { mode: 'blockly', hasOpenView: true }]) {
    it('does not offer an unavailable copy in another mode or over another open view', () => {
      const result = projectViewRecoveryFailure(failure('unknown'), project, { ...context, hasSavedDocument: () => true });
      expect(result?.nextAction.tool).toBe('app_info');
    });
  }
  it('does not hide an ordinary load failure behind new disk probing', async () => {
    const disk = jasmine.createSpy('disk').and.throwError('must not probe');
    expect(projectViewRecoveryFailure(new Error('load failed'), project,
      { mode: 'blockly', hasOpenView: false, hasSavedDocument: disk })).toBeUndefined();
    expect(disk).not.toHaveBeenCalled();
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.configService = { init: async () => {}, getPreferredChatAgentRuntimeMode: () => 'blockly' };
    bridge.electronService = { exists: () => true };
    bridge.projectService = { currentProjectPath: '', getProjectMode: () => 'blockly',
      projectOpen: async () => { throw new Error('specific load failure'); },
      getBlocklyProjectLoadStatus: () => ({ state: 'error', error: 'specific load failure' }) };
    const result = await bridge.executeProjectOpen(project);
    expect(result.reason).toBe('project_load_failed'); expect(result.message).toBe('specific load failure');
  });
  it('routes a real bridge conflict without a modal or forced acquisition', async () => {
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    bridge.configService = { init: async () => {}, getPreferredChatAgentRuntimeMode: () => 'blockly' };
    bridge.electronService = { exists: () => true, pathJoin: (...parts) => parts.join('/') };
    const open = jasmine.createSpy('open').and.rejectWith(failure('unknown'));
    bridge.projectService = { currentProjectPath: '', coderProjects: [], getProjectMode: () => 'blockly', projectOpen: open };
    const result = await bridge.executeProjectOpen(project);
    expect(open).toHaveBeenCalledOnceWith(project, { reason: 'chat-tool-open', interactive: false });
    expect(result.code).toBe('PROJECT_VIEW_OWNER_UNKNOWN'); expect(result.nextAction.input.action).toBe('open');
  });
  it('retains the conflict without offering a copy when disk inspection fails', () => {
    const result = projectViewRecoveryFailure(failure('unknown'), project,
      { mode: 'blockly', hasOpenView: false, hasSavedDocument: () => { throw new Error('disk unavailable'); } });
    expect(result?.code).toBe('PROJECT_VIEW_OWNER_UNKNOWN'); expect(result?.nextAction.tool).toBe('app_info');
  });
});
