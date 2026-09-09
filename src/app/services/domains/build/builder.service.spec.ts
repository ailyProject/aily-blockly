import { of, Subject } from 'rxjs';
import { BuilderService } from './builder.service';

describe('BuilderService Coder persistence', () => {
  function createHarness(options: { coder: boolean; saveSucceeds?: boolean }) {
    const events: string[] = [];
    const operationEvents: string[] = [];
    const actionService = {
      hasListener: () => false,
      dispatch: () => undefined,
      dispatchWithFeedback: (type: string) => {
        events.push(type);
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
      runCompileFromDisk: async () => {
        events.push('compile-from-disk');
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
    return { service, events, operationEvents };
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
});
