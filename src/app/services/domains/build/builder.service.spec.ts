import { of, Subject } from 'rxjs';
import { createEmptySceneEditorDocumentV2 } from '@aily-project/scene-model';
import { BuilderService } from './builder.service';

describe('BuilderService typed cancellation', () => {
  function failureHarness(result: { state: string; text: string; errorCode?: string }) {
    const service = new BuilderService({
      hasListener: () => true,
      dispatchWithFeedback: () => of({ success: true, data: { success: false, result } }),
    } as any, {
      currentProjectPath: '/workspace/blockly',
      boardChangeSubject: new Subject<void>(),
      isAilyCodeProject: () => false,
    } as any, {} as any, {} as any, { isWindowFocused: () => true } as any, {} as any);
    return service;
  }

  it('preserves the explicit normal Builder cancellation code and localized text', async () => {
    const result = { state: 'warn', text: '已取消，耗时 1.23 秒', errorCode: 'build-cancelled' };
    const service = failureHarness(result);
    const sceneDocument = await createEmptySceneEditorDocumentV2('main');
    const error = await service.buildActiveBlocklyProject({ projectPath: '/workspace/blockly',
      graphSemanticRevision: sceneDocument.graphSemanticRevision, requestId: 'request-main', sceneDocument }).catch(value => value);
    expect(error).toEqual(jasmine.any(Error));
    expect(error.errorCode).toBe('build-cancelled');
    expect(error.message).toBe(result.text);
    expect(error.text).toBe(result.text);
    expect(error.buildResult).toBe(result);
  });

  for (const state of ['warn', 'error']) it(`does not infer ${state} cancellation from text`, async () => {
    const service = failureHarness({ state, text: '已取消，耗时 1.23 秒' });
    const sceneDocument = await createEmptySceneEditorDocumentV2('main');
    const error = await service.buildActiveBlocklyProject({ projectPath: '/workspace/blockly',
      graphSemanticRevision: sceneDocument.graphSemanticRevision, requestId: 'request-main', sceneDocument }).catch(value => value);
    expect(error.errorCode).toBeUndefined();
    expect(error.state).toBe(state);
  });
});

describe('BuilderService Coder persistence', () => {
  function createHarness(options: { coder: boolean; saveSucceeds?: boolean; switchDuringSave?: boolean }) {
    const events: string[] = [];
    const operationEvents: string[] = [];
    const compiledProjects: string[] = [];
    const actionService = {
      hasListener: () => false,
      dispatch: () => undefined,
      dispatchWithFeedback: (type: string) => {
        events.push(type);
        if (options.switchDuringSave) projectService.currentProjectPath = '/workspace/other';
        return of({
          actionId: 'test-save',
          success: options.saveSucceeds !== false,
          data: {},
          error: options.saveSucceeds === false ? 'save failed' : undefined,
          timestamp: Date.now(),
        });
      },
    };
    const projectService = {
      beginCoderOperation: (kind: string, path: string) => {
        operationEvents.push(`${kind}:${path}`);
        return () => operationEvents.push('finished');
      },
      coderProjects: [{ path: '/workspace/coder' }],
      currentProjectPath: options.coder ? '/workspace/coder' : '/workspace/blockly',
      boardChangeSubject: new Subject<void>(),
      isAilyCodeProject: () => options.coder,
    };
    const compileService = {
      runCompileFromDisk: async (input: { projectPath: string }) => {
        events.push('compile-from-disk');
        compiledProjects.push(input.projectPath);
        return {
          success: true,
          result: { state: 'done', text: 'compiled' },
        };
      },
      cancel: () => undefined,
    };
    const service = new BuilderService(
      actionService as any,
      projectService as any,
      {} as any,
      {} as any,
      { isWindowFocused: () => true } as any,
      compileService as any,
    );
    return { service, events, operationEvents, compiledProjects };
  }

  it('saves the active Coder editor to disk before compiling from disk', async () => {
    const { service, events } = createHarness({ coder: true });

    await service.build();

    expect(events).toEqual(['project-save', 'compile-from-disk']);
  });

  it('does not add the Coder persistence step to Blockly builds', async () => {
    const { service, events } = createHarness({ coder: false });

    await service.build();

    expect(events).toEqual(['compile-from-disk']);
  });

  it('does not compile Coder source when persistence fails', async () => {
    const { service, events, operationEvents } = createHarness({ coder: true, saveSucceeds: false });

    await expectAsync(service.build()).toBeRejectedWithError('save failed');

    expect(events).toEqual(['project-save']);
    expect(operationEvents).toEqual(['build:/workspace/coder', 'finished']);
  });

  it('keeps the original project path when the active project changes during saving', async () => {
    const { service, compiledProjects } = createHarness({ coder: true, switchDuringSave: true });
    const finishedProjects: Array<string | undefined> = [];
    service.buildFinishedSubject.subscribe(event => finishedProjects.push(event.projectPath));
    await service.build();
    expect(compiledProjects).toEqual(['/workspace/coder']);
    expect(finishedProjects).toEqual(['/workspace/coder']);
  });
});
