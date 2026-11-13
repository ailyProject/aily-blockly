import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';
import { absProtocolReply } from './abs-live-protocol';

describe('static original-project protocol discovery', () => {
  function fixture(mode = 'blockly') {
    const service: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    service.projectService = { currentProjectPath: '/original', getProjectMode: () => mode,
      isProjectTransitionInProgress: jasmine.createSpy('transition').and.throwError('No lifecycle ownership'),
      getBlocklyProjectLoadStatus: jasmine.createSpy('load').and.throwError('The runtime failed loading'),
      isLibraryMutationInProgress: jasmine.createSpy('libraries').and.throwError('No library preparation') };
    service.absGenerationTools = { capabilities: jasmine.createSpy('dynamic').and.throwError('No runtime schema query') };
    service.aiOperations = { setActive: jasmine.createSpy('owner') };
    return service;
  }
  it('answers during failed or busy loading without capture, runtime advice, lease or publication', async () => {
    const service = fixture();
    const result = await service.execute({ operation: 'abs_protocol', path: '/original', params: { version: 1 } });
    expect(result).toEqual({ ok: true, operation: 'abs_protocol', project: '/original', protocol: {
      version: 1, generation: 2, absSchema: 2, legacyAbiWrites: false, workingCandidateVersion: 1 } });
    expect(service.projectService.getBlocklyProjectLoadStatus).not.toHaveBeenCalled();
    expect(service.projectService.isProjectTransitionInProgress).not.toHaveBeenCalled();
    expect(service.projectService.isLibraryMutationInProgress).not.toHaveBeenCalled();
    expect(service.absGenerationTools.capabilities).not.toHaveBeenCalled();
    expect(service.aiOperations.setActive).not.toHaveBeenCalled();
  });
  it('never grants a different project or a Coder project the Blockly protocol', async () => {
    expect((await fixture().execute({ operation: 'abs_protocol', path: '/foreign', params: { version: 1 } })).ok).toBeFalse();
    expect((await fixture('coder').execute({ operation: 'abs_protocol', path: '/original', params: { version: 1 } })).code)
      .toBe('ABS_WORKING_CANDIDATE_UNSUPPORTED');
  });
  it('rejects mutation, source and dynamic query fields at the protocol-only boundary', () => {
    for (const input of [{}, { version: 2 }, { version: 1, type: 'text' }, { version: 1, workingCandidate: {} }, { version: 1, abs: 'draft' }])
      expect(absProtocolReply('/original', input).ok).toBeFalse();
  });
});
