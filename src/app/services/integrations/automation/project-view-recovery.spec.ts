import { projectViewOpenError } from '@domain/project/public-api';
import { BlocklyLiveOperationBridgeService } from './blockly-live-operation-bridge.service';
import { projectViewRecoveryFailure } from './project-view-recovery';

describe('noninteractive view conflicts and executable recovery guidance', () => {
  const project = '/isolated/source';
  const failure = state => projectViewOpenError(project, { code: state === 'unknown' ? 'PROJECT_VIEW_OWNER_UNKNOWN'
    : state === 'busy' ? 'PROJECT_VIEW_BUSY' : 'PROJECT_VIEW_OCCUPIED', ownership: { state }, holder: { pid: 202 } });
  it('preserves the unknown owner and returns an executable read-only follow-up', () => {
    const result = projectViewRecoveryFailure(failure('unknown'), project);
    expect(result?.nextAction).toEqual({ tool: 'app_info', input: {} });
    expect(result?.sourceViewPreserved).toBeTrue(); expect(result?.projectView.holder?.pid).toBe(202);
  });
  for (const state of ['active', 'busy']) it(`does not fork around ${state} ownership`, () => {
    const result = projectViewRecoveryFailure(failure(state), project);
    expect(result?.nextAction).toEqual({ tool: 'app_info', input: {} });
  });
  it('does not hide an ordinary load failure behind new disk probing', async () => {
    expect(projectViewRecoveryFailure(new Error('load failed'), project)).toBeUndefined();
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
    expect(result.code).toBe('PROJECT_VIEW_OWNER_UNKNOWN');
    expect(result.nextAction).toEqual({ tool: 'app_info', input: {} });
  });
});
