import { Subject, filter, throwError } from 'rxjs';
import { ProjectCompilerConfigurationService } from './project-compiler-configuration.service';

describe('Read-only project compiler configuration query', () => {
  let previous: any, service: ProjectCompilerConfigurationService;
  let project: any, cmd: any, builder: any, stream: Subject<any>, manifest: any;
  let session: any, sessionController: AbortController;
  const context = { schemaVersion: 1, kind: 'aily-resolved-compiler-configuration', scope: 'command-line-only',
    status: 'available', effectiveFqbn: 'vendor:arch:board:Mode=exact', platformVersion: '1.0.0',
    definitions: [{ name: 'CURRENT', value: '0', state: 'defined' }], limitations: ['cpp-preprocessing-not-performed'] };
  beforeEach(() => {
    previous = { builder: window['builder'], path: window['path'] };
    manifest = { dependencies: { '@aily-project/board-test': '1' }, projectConfig: { Mode: 'exact' } };
    sessionController = new AbortController();
    session = { projectPath: '/project', projectSessionId: 'project-session-1', signal: sessionController.signal };
    project = { currentProjectPath: '/project', currentBoardConfig: {}, getRuntimeBoardModule: () => '@aily-project/board-test',
      getPackageJson: async () => manifest,
      getProjectDependencySession: jasmine.createSpy('getProjectDependencySession').and.callFake(() => session),
      assertProjectDependencySession: jasmine.createSpy('assertProjectDependencySession').and.callFake((captured: any) => {
        if (captured !== session || captured.signal.aborted) throw new Error('Project dependency session was cancelled or replaced.');
      }) };
    builder = { status: jasmine.createSpy('status').and.callFake(async () => ({ installed: true, installing: false,
      entryPath: '/managed/node_modules/@aily-project/aily-builder/dist/main.js' })) };
    window['builder'] = builder;
    window['path'] = { join: (...parts: string[]) => parts.join('/'), getAilyChildPath: () => '/child', getAppDataPath: () => '/app-data' };
    stream = new Subject();
    cmd = { spawn: jasmine.createSpy('spawn').and.callFake((_command: string, _args: string[], options: any) => {
      // Main requires the complete existing project scope, even for readonly work.
      if (options.projectPath !== undefined && (!options.projectPath || typeof options.projectSessionId !== 'string' || !options.projectSessionId.trim())) {
        return throwError(() => new Error('Invalid project task scope.'));
      }
      return stream.pipe(filter(event => event.type !== 'stdout' || options.forwardStdout !== false));
    }),
      kill: jasmine.createSpy('kill').and.resolveTo(true) };
    service = new ProjectCompilerConfigurationService(project, cmd);
  });
  afterEach(() => { window['builder'] = previous.builder; window['path'] = previous.path; });
  async function launched() { for (let index = 0; index < 8 && !cmd.spawn.calls.count(); index++) await Promise.resolve(); expect(cmd.spawn).toHaveBeenCalled(); }
  function success(value: any = context, targetMarkers: any = { mcu: 'esp32' }) {
    stream.next({ type: 'stdout', data: JSON.stringify({ compileContext: value, targetMarkers }) });
    stream.next({ type: 'close', code: 0, signal: null });
  }

  it('requires the managed package entry instead of guessing the builder cache directory', async () => {
    builder.status.and.resolveTo({ installed: true });
    const result = await service.read('/project');
    expect(result.compileContext.status).toBe('unavailable'); expect(result.targetMarkers).toBeNull(); expect(cmd.spawn).not.toHaveBeenCalled();
  });

  it('uses bounded shell-free Node input and waits for an actual successful close', async () => {
    const pending = service.read('/project'); await launched();
    const [command, args, options, silent] = cmd.spawn.calls.mostRecent().args;
    expect(command).toBe('node'); expect(args[0]).toBe('/child/scripts/project-compiler-configuration.js');
    expect(options.shellProfile).toBeFalse(); expect(options.projectPath).toBe('/project'); expect(silent).toBeTrue();
    expect(options.projectSessionId).toBe(session.projectSessionId);
    const request = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(args[1]), ch => ch.charCodeAt(0))));
    expect(request.entryPath).toContain('/dist/main.js'); expect(Object.keys(request).sort()).toEqual(['appDataPath', 'boardModule', 'entryPath', 'projectPath', 'schemaVersion']);
    success(); expect(await pending).toEqual({ compileContext: context, targetMarkers: { mcu: 'esp32' } } as any); expect(cmd.kill).not.toHaveBeenCalled();
  });

  it('silent execution preserves stdout through the Main transport filter', async () => {
    const pending = service.read('/project'); await launched();
    success();
    expect((await pending).compileContext.status).toBe('available');
    const [, , options, silent] = cmd.spawn.calls.mostRecent().args;
    expect(options.forwardStdout).not.toBeFalse(); expect(silent).toBeTrue();
  });

  it('rejects output without a confirmed close and reclaims its exact stream', async () => {
    const pending = service.read('/project'); await launched();
    stream.next({ type: 'stdout', data: JSON.stringify(context) }); stream.complete();
    expect((await pending).compileContext.status).toBe('unavailable');
    expect(cmd.kill).toHaveBeenCalledOnceWith(cmd.spawn.calls.mostRecent().args[2].streamId);
  });

  it('does not mix facts after the current project configuration changes', async () => {
    const pending = service.read('/project'); await launched();
    manifest = { ...manifest, projectConfig: { Mode: 'different' } }; success();
    expect((await pending).compileContext.status).toBe('unavailable');
  });

  it('does not mix facts after a managed builder replacement', async () => {
    const pending = service.read('/project'); await launched();
    builder.status.and.resolveTo({ installed: true, installing: false, entryPath: '/different/dist/main.js' }); success();
    expect((await pending).compileContext.status).toBe('unavailable');
  });

  it('rejects malformed unsafe output through the shared protocol validator', async () => {
    const pending = service.read('/project'); await launched();
    success({ ...context, definitions: [{ name: 'CURRENT', value: 'C:/private', state: 'defined' }] });
    expect((await pending).compileContext.status).toBe('unavailable');
  });

  it('cancellation waits for tree cleanup before rejecting the query', async () => {
    const signal = new AbortController();
    const pending = service.read('/project', signal.signal); await launched();
    signal.abort(); await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
    expect(cmd.kill).toHaveBeenCalledOnceWith(cmd.spawn.calls.mostRecent().args[2].streamId);
  });

  it('borrows the existing session without creating a different project operation', async () => {
    const pending = service.read('/project'); await launched(); success();
    expect((await pending).compileContext.status).toBe('available');
    expect(project.getProjectDependencySession).toHaveBeenCalledOnceWith('/project');
    expect(project.assertProjectDependencySession).toHaveBeenCalledWith(session);
    const options = cmd.spawn.calls.mostRecent().args[2];
    expect(options.projectPath).toBe(session.projectPath); expect(options.projectSessionId).toBe(session.projectSessionId);
    expect(options.signal).toBe(session.signal);
  });

  it('an existing session cancellation also cancels a query without a caller signal', async () => {
    const pending = service.read('/project'); await launched();
    sessionController.abort();
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
    expect(cmd.kill).toHaveBeenCalledOnceWith(cmd.spawn.calls.mostRecent().args[2].streamId);
  });

  it('reopening the same path cannot publish the old activation and uses the new session', async () => {
    const old = session, pending = service.read('/project'); await launched();
    sessionController.abort();
    sessionController = new AbortController();
    session = { ...old, projectSessionId: 'project-session-2', signal: sessionController.signal };
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
    stream = new Subject();
    const fresh = service.read('/project');
    for (let index = 0; index < 8 && cmd.spawn.calls.count() < 2; index++) await Promise.resolve();
    expect(cmd.spawn.calls.count()).toBe(2); success(); expect((await fresh).compileContext.status).toBe('available');
    expect(cmd.spawn.calls.first().args[2].projectSessionId).toBe(old.projectSessionId);
    expect(cmd.spawn.calls.mostRecent().args[2].projectSessionId).toBe(session.projectSessionId);
  });

  it('asserts the captured session again at the bookend even when its signal was not aborted', async () => {
    const pending = service.read('/project'); await launched();
    session = { ...session, projectSessionId: 'different-activation' }; success();
    expect((await pending).compileContext.status).toBe('unavailable');
  });

  it('unconfirmed termination is a blocking error rather than an unavailable success', async () => {
    const pending = service.read('/project'); await launched();
    cmd.kill.and.resolveTo(false); stream.error(new Error('private details must not escape'));
    await expectAsync(pending).toBeRejectedWithError('configuration-query-termination-unconfirmed');
  });

  it('the thirty-second deadline cancels the exact process before falling back', async () => {
    jasmine.clock().install();
    try {
      const pending = service.read('/project'); await launched();
      jasmine.clock().tick(30_001);
      expect((await pending).compileContext.status).toBe('unavailable');
      expect(cmd.kill).toHaveBeenCalledOnceWith(cmd.spawn.calls.mostRecent().args[2].streamId);
    } finally { jasmine.clock().uninstall(); }
  });

  it('keeps exact resolved markers outside the unchanged public compile context', async () => {
    const pending = service.read('/project'); await launched();
    success(context, { boardId: 'GENERIC_F103CBTX', mcu: 'STM32F103CB' });
    const result = await pending;
    expect(result.targetMarkers).toEqual({ boardId: 'GENERIC_F103CBTX', mcu: 'STM32F103CB' });
    expect(Object.isFrozen(result.targetMarkers)).toBeTrue();
    expect(Object.hasOwn(result.compileContext, 'targetMarkers')).toBeFalse();
  });

  for (const markers of [null, { mcu: '' }, { mcu: 'C:/private' }, { mcu: 'esp32', recipe: 'not permitted' }]) {
    it(`rejects invalid private target marker transport: ${JSON.stringify(markers)}`, async () => {
      const pending = service.read('/project'); await launched(); success(context, markers);
      const result = await pending;
      expect(result.compileContext.status).toBe('unavailable'); expect(result.targetMarkers).toBeNull();
    });
  }

  it('rejects the retired scalar transport shape rather than dropping target identity', async () => {
    const pending = service.read('/project'); await launched();
    stream.next({ type: 'stdout', data: JSON.stringify(context) }); stream.next({ type: 'close', code: 0, signal: null });
    expect((await pending).compileContext.status).toBe('unavailable');
  });
});
