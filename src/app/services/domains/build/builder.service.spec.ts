import { of, Subject } from 'rxjs';
import { createEmptySceneEditorDocumentV2 } from '@aily-project/scene-model';
import { buildCancelledResult } from './build-cancellation';
import { BuilderService } from './builder.service';

describe('BuilderService typed cancellation', () => {
  function failureHarness(result: { state: string; text: string }) {
    const service = new BuilderService({
      hasListener: () => true,
      dispatchWithFeedback: () => of({ success: true, data: { success: false, result } }),
    } as any, {
      currentProjectPath: '/workspace/blockly',
      boardChangeSubject: new Subject<void>(),
      isAilyCodeProject: () => false,
    } as any, {} as any, {} as any, { isWindowFocused: () => true } as any, {} as any, undefined, {
      isAvailable: () => true,
      build: async () => ({ success: false, result, checkpoint: { startedAt: 1 } }),
    } as any);

    return service;
  }

  it('preserves the explicit normal Builder cancellation code and localized text', async () => {
    const result = buildCancelledResult('已取消，耗时 1.23 秒');
    const service = failureHarness(result);
    const sceneDocument = await createEmptySceneEditorDocumentV2('main');

    const error = await service.buildActiveBlocklyProject({ projectPath: '/workspace/blockly',
      graphSemanticRevision: sceneDocument.graphSemanticRevision, requestId: 'request-main', sceneDocument }).catch(value => value);

    expect(error).toEqual(jasmine.any(Error));
    expect(error.code).toBe('BUILD_CANCELLED');
    expect(error.buildOutcome).toBe('cancelled');
    expect(error.message).toBe(result.text);
    expect(error.text).toBe(result.text);
    expect(error.buildResult).toBe(result);
  });

  for (const state of ['warn', 'error']) it(`does not infer ${state} cancellation from text`, async () => {
    const service = failureHarness({ state, text: '已取消，耗时 1.23 秒' });
    const sceneDocument = await createEmptySceneEditorDocumentV2('main');

    const error = await service.buildActiveBlocklyProject({ projectPath: '/workspace/blockly',
      graphSemanticRevision: sceneDocument.graphSemanticRevision, requestId: 'request-main', sceneDocument }).catch(value => value);

    expect(error.code).toBeUndefined();
    expect(error.state).toBe(state);
  });
});

describe('BuilderService Coder persistence', () => {
  function createHarness(options: { coder: boolean; cloud?: boolean; saveSucceeds?: boolean; switchDuringSave?: boolean }) {
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
      isCloudBuild: () => options.cloud === true,
    };

    const compileService = {
      canReuseCloudBuildForUpload: async () => {
        events.push('check-cloud-firmware');

        return true;
      },
      canReuseLocalCoderBuildForUpload: async () => {
        events.push('check-local-firmware');

        return true;
      },
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
      undefined,
      {
        isAvailable: () => true,
        build: async () => {
          events.push('build-blockly');

          return { success: true, result: { state: 'done', text: 'compiled' }, checkpoint: {} };
        },
      },
    );

    return { service, events, operationEvents, compiledProjects };
  }

  it('saves the active Coder editor to disk before compiling from disk', async () => {
    const { service, events } = createHarness({ coder: true });

    await service.build();
    expect(events).toEqual(['project-save', 'compile-from-disk']);
  });

  it('saves the Coder editor before checking the local firmware', async () => {
    const originalBuilder = window['builder'];

    window['builder'] = { canReuseCoderUpload: async () => true };

    try {
      const { service, events } = createHarness({ coder: true });

      expect(await service.canReuseBuildForUpload('/workspace/coder')).toBeTrue();
      expect(events).toEqual(['project-save', 'check-local-firmware']);

      const fallback = createHarness({ coder: true, cloud: true });

      expect(await fallback.service.canReuseBuildForUpload('/workspace/coder', () => false, 'local')).toBeTrue();
      expect(fallback.events).toEqual(['project-save', 'check-local-firmware']);

      const previousCloud = createHarness({ coder: true, cloud: false });

      expect(await previousCloud.service.canReuseBuildForUpload('/workspace/coder', () => false, 'cloud')).toBeTrue();
      expect(previousCloud.events).toEqual(['project-save', 'check-cloud-firmware']);

      const failure = createHarness({ coder: true, saveSucceeds: false });

      await expectAsync(failure.service.canReuseBuildForUpload('/workspace/coder')).toBeRejectedWithError('save failed');
      expect(failure.events).toEqual(['project-save']);
    } finally {
      window['builder'] = originalBuilder;
    }
  });

  it('does not add the Coder persistence step to Blockly builds', async () => {
    const { service, events } = createHarness({ coder: false });

    await service.build();
    expect(events).toEqual(['build-blockly']);
  });

  it('delegates both local Blockly cache modes to the native shared-build owner', async () => {
    const original = window['builder'];
    const clearSharedBuildCache = jasmine.createSpy('clearSharedBuildCache').and.resolveTo();

    window['builder'] = { sharedBuildExecutionVersion: 1, clearSharedBuildCache };

    try {
      const { service } = createHarness({ coder: false });

      await service.clearBuildCache('/workspace/blockly');
      await service.clearCache('/workspace/blockly');

      expect(clearSharedBuildCache.calls.allArgs()).toEqual([
        ['/workspace/blockly', { preserveSketch: true }],
        ['/workspace/blockly', { preserveSketch: false }],
      ]);

      expect(createHarness({ coder: true }).service.usesSharedBuildCache('/workspace/coder')).toBeFalse();
      expect(createHarness({ coder: false, cloud: true }).service.usesSharedBuildCache('/workspace/blockly')).toBeFalse();
      clearSharedBuildCache.and.rejectWith(new Error('BUILD_WORKSPACE_BUSY'));
      await expectAsync(service.clearCache('/workspace/blockly')).toBeRejectedWithError('BUILD_WORKSPACE_BUSY');
    } finally {
      window['builder'] = original;
    }
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
