import {
  AilyChatDemandSessionService,
  type AilyChatDemandSessionResult,
} from './aily-chat-demand-session.service';
import { BehaviorSubject } from 'rxjs';

describe('AilyChatDemandSessionService', () => {
  const channel = 'aily-chat-demand-session-v1';

  function createHarness(options: { autoRespond?: boolean } = {}) {
    const processMessageListeners = new Set<(message: Record<string, unknown>) => void>();
    const sentMessages: Record<string, unknown>[] = [];
    const openedSessions: string[] = [];
    const projectPath = new BehaviorSubject('/tmp/project');
    const projectService = {
      currentProjectPath: projectPath.value,
      currentProjectPath$: projectPath.asObservable(),
    };
    projectPath.subscribe(path => projectService.currentProjectPath = path);
    const childToolProcess = {
      acquire: async () => undefined,
      release: async () => undefined,
      onMessage: (
        _toolId: string,
        listener: (message: Record<string, unknown>) => void,
      ) => {
        processMessageListeners.add(listener);
        return () => processMessageListeners.delete(listener);
      },
      sendMessage: async (_toolId: string, message: Record<string, unknown>) => {
        sentMessages.push(message);
        if (options.autoRespond === false) return;
        const requestId = String(message['requestId']);
        queueMicrotask(() => {
          for (const listener of processMessageListeners) listener({
            channel,
            type: 'event',
            requestId,
            event: { type: 'session-created', sessionId: 'session-1' },
          });
          const result: AilyChatDemandSessionResult = {
            accepted: true,
            sessionId: 'session-1',
            state: 'settled',
          };
          for (const listener of processMessageListeners) listener({
            channel,
            type: 'response',
            requestId,
            result,
          });
        });
      },
    };
    const service = new AilyChatDemandSessionService(
      projectService as never,
      childToolProcess as never,
      {
        openAilyChatSession: async (sessionId: string) => {
          openedSessions.push(sessionId);
          return true;
        },
      } as never,
    );
    return {
      service,
      projectPath,
      sentMessages,
      openedSessions,
      emitProcessMessage: (message: Record<string, unknown>) => {
        for (const listener of processMessageListeners) listener(message);
      },
    };
  }

  it('creates an ArchitectureAgent demand session without composer injection', async () => {
    const harness = createHarness();

    await harness.service.createArchitectureSession('生成项目架构图');

    expect(harness.sentMessages).toHaveSize(1);
    expect(harness.sentMessages[0]).toEqual(jasmine.objectContaining({
      channel,
      action: 'demand-session.run',
      kind: 'architecture',
      mode: 'agent',
      prompt: '[AGENT: ArchitectureAgent] 生成项目架构图',
      revealSession: true,
    }));
    expect(harness.openedSessions).toEqual(['session-1']);
  });

  it('creates an ask-mode block explanation session with block resources', async () => {
    const harness = createHarness();
    const resources = [{
      type: 'block' as const,
      name: 'digital write',
      blockId: 'block-1',
      blockContext: '<block type="digital_write" />',
    }];

    await harness.service.explainBlocks('解释这个积木块', resources);

    expect(harness.sentMessages[0]).toEqual(jasmine.objectContaining({
      action: 'demand-session.run',
      kind: 'block-explain',
      mode: 'ask',
      prompt: '解释这个积木块',
      resources,
    }));
  });

  it('uses only the canonical ProjectSceneAgent marker', async () => {
    const harness = createHarness();

    await harness.service.generateProjectScene('生成项目连线图', { revealSession: true });

    expect(harness.sentMessages[0]).toEqual(jasmine.objectContaining({
      action: 'demand-session.run',
      kind: 'project-scene',
      mode: 'agent',
      prompt: '[AGENT: ProjectSceneAgent] 生成项目连线图',
    }));
  });

  it('publishes architecture generation state until the matching request settles', async () => {
    const harness = createHarness({ autoRespond: false });
    const states: Array<{ architecture: { requestId: string; sessionId?: string } | null }> = [];
    const subscription = harness.service.diagramGenerationState$.subscribe(state => states.push(state));

    const pending = harness.service.createArchitectureSession('生成项目架构图');
    expect(harness.service.isDiagramGenerating('architecture')).toBeTrue();

    await Promise.resolve();
    const requestId = String(harness.sentMessages[0]['requestId']);
    harness.emitProcessMessage({
      channel,
      type: 'event',
      requestId,
      event: { type: 'session-created', sessionId: 'architecture-session' },
    });
    expect(states.at(-1)?.architecture).toEqual(jasmine.objectContaining({
      requestId,
      sessionId: 'architecture-session',
    }));

    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId,
      result: { accepted: true, sessionId: 'architecture-session', state: 'settled' },
    });
    await pending;

    expect(harness.service.isDiagramGenerating('architecture')).toBeFalse();
    expect(states.at(-1)?.architecture).toBeNull();
    subscription.unsubscribe();
  });

  it('clears generation state when the runtime reports an aborted operation', async () => {
    const harness = createHarness({ autoRespond: false });
    const pending = harness.service.createArchitectureSession('生成项目架构图');

    await Promise.resolve();
    const requestId = String(harness.sentMessages[0]['requestId']);
    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId,
      result: {
        accepted: true,
        sessionId: 'architecture-session',
        state: 'failed',
        error: 'Operation aborted by user',
      },
    });

    await expectAsync(pending).toBeRejectedWithError('Operation aborted by user');
    expect(harness.service.isDiagramGenerating('architecture')).toBeFalse();
  });

  it('rejects a duplicate diagram request without clearing the active request state', async () => {
    const harness = createHarness({ autoRespond: false });
    const first = harness.service.createArchitectureSession('生成项目架构图');

    await expectAsync(
      harness.service.createArchitectureSession('再次生成项目架构图'),
    ).toBeRejectedWithError('框架图正在生成，请等待当前任务结束');
    expect(harness.service.isDiagramGenerating('architecture')).toBeTrue();

    await Promise.resolve();
    expect(harness.sentMessages).toHaveSize(1);
    const requestId = String(harness.sentMessages[0]['requestId']);
    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId,
      result: { accepted: true, sessionId: 'architecture-session', state: 'settled' },
    });
    await first;
    expect(harness.service.isDiagramGenerating('architecture')).toBeFalse();
  });

  it('coalesces a duplicate project Scene request without reporting an error', async () => {
    const harness = createHarness({ autoRespond: false });
    const request = {
      kind: 'project-scene' as const,
      title: '生成项目连线图',
      prompt: '[AGENT: ProjectSceneAgent] 生成项目连线图',
      mode: 'agent' as const,
    };
    const first = harness.service.runDemandSession(request);

    await expectAsync(harness.service.runDemandSession(request)).toBeResolvedTo({
      accepted: false,
      reason: 'project-scene-agent-running',
    });
    expect(harness.sentMessages).toHaveSize(1);

    await Promise.resolve();
    const requestId = String(harness.sentMessages[0]['requestId']);
    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId,
      result: { accepted: true, sessionId: 'project-scene-session', state: 'settled' },
    });
    await first;
  });

  it('clears a stale diagram gate when the active project changes', async () => {
    const harness = createHarness({ autoRespond: false });
    const pending = harness.service.generateProjectScene('生成项目连线图');
    expect(harness.service.isDiagramGenerating('project-scene')).toBeTrue();

    harness.projectPath.next('/tmp/other-project');

    expect(harness.service.isDiagramGenerating('project-scene')).toBeFalse();

    await Promise.resolve();
    const requestId = String(harness.sentMessages[0]['requestId']);
    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId,
      result: { accepted: true, sessionId: 'project-scene-session', state: 'settled' },
    });
    await pending;
  });

  it('keeps architecture and project Scene generation states independent', async () => {
    const harness = createHarness({ autoRespond: false });
    const architecture = harness.service.createArchitectureSession('生成项目架构图');
    const projectScene = harness.service.generateProjectScene('生成项目连线图');

    expect(harness.service.isDiagramGenerating('architecture')).toBeTrue();
    expect(harness.service.isDiagramGenerating('project-scene')).toBeTrue();

    await Promise.resolve();
    const architectureRequestId = String(
      harness.sentMessages.find(message => message['kind'] === 'architecture')?.['requestId'],
    );
    const projectSceneRequestId = String(
      harness.sentMessages.find(message => message['kind'] === 'project-scene')?.['requestId'],
    );
    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId: architectureRequestId,
      result: { accepted: true, sessionId: 'architecture-session', state: 'settled' },
    });
    await architecture;
    expect(harness.service.isDiagramGenerating('architecture')).toBeFalse();
    expect(harness.service.isDiagramGenerating('project-scene')).toBeTrue();

    harness.emitProcessMessage({
      channel,
      type: 'response',
      requestId: projectSceneRequestId,
      result: { accepted: true, sessionId: 'project-scene-session', state: 'settled' },
    });
    await projectScene;
    expect(harness.service.isDiagramGenerating('project-scene')).toBeFalse();
  });
});
