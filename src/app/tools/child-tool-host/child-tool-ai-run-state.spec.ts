import { ChildToolHostComponent } from './child-tool-host.component';
import { AiOperationRegistryService } from '@integration/automation/public-api';
import { ProjectApplicationAdapter } from '../../integrations/project/project-application.adapter';

describe('Chat whole-run state for Save As', () => {
  let host: any, registry: AiOperationRegistryService, adapter: any;
  beforeEach(() => {
    registry = new AiOperationRegistryService();
    host = Object.create(ChildToolHostComponent.prototype);
    host.hostContextId = 'test'; host.projectService = { currentProjectPath: '/A' };
    host.aiOperationRegistry = registry; host.isAilyChatTool = () => true;
    host.setAilyChatOperationActive = jasmine.createSpy('writeOverlay');
    adapter = Object.create(ProjectApplicationAdapter.prototype); adapter.aiOperationRegistry = registry;
  });
  it('blocks Save As for thinking/Coder runs without enabling the Blockly writing overlay', () => {
    host.reportAiOperationState({ running: true, active: false, sessionId: 's' });
    expect(adapter.hasRunningAi()).toBeTrue(); expect(registry.hasBlocking('/A')).toBeFalse();
    expect(host.setAilyChatOperationActive).toHaveBeenCalledWith(false, 's');
    host.reportAiOperationState({ running: false, active: false, sessionId: 's' });
    expect(adapter.hasRunningAi()).toBeFalse();
  });
  it('preserves legacy active reports and rejects non-Chat reporters', () => {
    host.reportAiOperationState({ active: true, sessionId: 's' });
    expect(adapter.hasRunningAi()).toBeTrue();
    host.isAilyChatTool = () => false;
    expect(host.reportAiOperationState({ running: true }).ok).toBeFalse();
  });
});
