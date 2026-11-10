import { _BuilderService } from './builder.service';
import { fakeAsync, tick } from '@angular/core/testing';
import * as Blockly from 'blockly';
import { BlocklyService } from './blockly.service';
import { ProcessState } from '@core/app-shell/public-api';
import { Subject } from 'rxjs';
import { BlocklyCodePreparationInvalidatedError } from './prepared-project-code';
import {
  type BlockCodeMapping,
} from '../components/blockly/generators/arduino/arduino';

describe('BuilderService isolated derived outputs', () => {
  let oldBuilder: any;
  let service: any;
  let publish: jasmine.Spy;
  beforeEach(() => {
    oldBuilder = window['builder'];
    service = Object.create(_BuilderService.prototype);
    service.configService = { getCompileBackend: () => 'local' };
    service.projectService = { currentProjectPath: 'D:/logical', currentPackageData: {
      dependencies: { 'current-library': '2' }, board: 'current-board', MACROS: [['CURRENT=1']],
    }, isCloudBuild: () => false };
    publish = jasmine.createSpy('publish').and.callFake((path, patch) => {
      if (path === 'D:/logical') throw new Error('BUILD_WORKSPACE_RECOVERY_REQUIRED: legacy root owner exited');
      return { dependencies: { 'captured-library': '1' }, board: 'captured-board', MACROS: [['CAPTURED=1']], ...patch };
    });
    window['builder'] = { isolatedBuildExecutionVersion: 1, patchBuildMetadata: publish,
      publishArduinoGeneratedCode: jasmine.createSpy('rootArtifacts').and.throwError('legacy root output lease') };
  });
  afterEach(() => { window['builder'] = oldBuilder; });

  const execution = () => ({ currentProjectPath: 'D:/logical/.aily/build-executions/id/project',
    execution: { id: 'execution-id', buildRequestId: 'request-id', logicalProjectPath: 'D:/logical' } });
  const inspect = (status: string, executionId = 'execution-id') => jasmine.createSpy('inspect').and.returnValue({
    executionId, buildRequestId: 'request-id', status, current: true,
    ...(status === 'completed' ? { result: { currentProjectPath: 'private' } } : {}),
  });

  for (const status of ['success', 'failed', 'cancelled'] as const) {
    it(`writes ${status} metadata to its captured private execution and merges only live result fields`, async () => {
      const config = execution(); service.activeExecutionConfig = config;
      window['builder'].inspectBuildExecution = inspect(status === 'success' ? 'completed' : status);
      await service.saveBuildInfo('D:/logical', status, '1.25', 'a'.repeat(64), true, { config });
      expect(window['builder'].inspectBuildExecution).toHaveBeenCalledOnceWith('D:/logical', 'request-id');
      expect(publish).toHaveBeenCalledOnceWith(config.currentProjectPath, jasmine.objectContaining({
        buildInfo: jasmine.objectContaining({ lastBuildStatus: status, lastBuildDuration: 1.25 }),
      }));
      expect(service.projectService.currentPackageData).toEqual(jasmine.objectContaining({
        dependencies: { 'current-library': '2' }, board: 'current-board', MACROS: [['CURRENT=1']],
        buildInfo: jasmine.objectContaining({ lastBuildStatus: status }),
      }));
    });
  }
  it('never substitutes a newer execution for a delayed metadata callback', async () => {
    const config = execution(); service.activeExecutionConfig = execution();
    window['builder'].inspectBuildExecution = inspect('completed');
    const current = service.projectService.currentPackageData;
    await service.saveBuildInfo('D:/logical', 'success', '1', 'a'.repeat(64), true, { config });
    expect(publish.calls.mostRecent().args[0]).toBe(config.currentProjectPath);
    expect(service.projectService.currentPackageData).toBe(current);
  });
  it('rejects another execution returned for the same request instead of publishing root metadata', async () => {
    window['builder'].inspectBuildExecution = inspect('completed', 'newer-execution');
    await expectAsync(service.saveBuildInfo('D:/logical', 'success', '1', 'a'.repeat(64), true, { config: execution() }))
      .toBeRejectedWithError('Build metadata does not belong to the observed execution.');
    expect(publish).not.toHaveBeenCalled();
  });
  it('keeps a completed execution unchanged after a late cancellation', async () => {
    window['builder'].inspectBuildExecution = inspect('completed');
    await service.saveBuildInfo('D:/logical', 'cancelled', '1', 'a'.repeat(64), true, { config: execution() });
    expect(publish).not.toHaveBeenCalled();
  });
  it('does not acquire the logical root lease when cancellation precedes execution capture', async () => {
    await expectAsync(service.saveBuildInfo('D:/logical', 'cancelled', '0', '', true, {})).toBeResolved();
    expect(publish).not.toHaveBeenCalled();
  });
  it('keeps the protected metadata contract for cloud and legacy calls', async () => {
    publish.and.returnValue({ buildInfo: { lastBuildStatus: 'success' }, dependencies: { legacy: '1' } });
    await service.saveBuildInfo('D:/logical', 'success', '1', 'a'.repeat(64), true);
    expect(publish.calls.mostRecent().args[0]).toBe('D:/logical');
    expect(service.projectService.currentPackageData.dependencies).toEqual({ legacy: '1' });
  });

  function startup() {
    const prepared = { code: 'exact prepared code', artifacts: [], blockCodeMapText: 'exact map', projectMacros: undefined };
    service.blocklyService = { workspace: {}, publishPreparedCodeView: jasmine.createSpy('view'),
      runWithBackgroundProjectCode: jasmine.createSpy('background').and.callFake(async callback => {
        await callback(prepared, () => {}); return true;
      }) };
    return prepared;
  }
  it('finishes local startup publication with the captured preview while the legacy root is locked', async () => {
    const prepared = startup();
    expect(await service.generateAndWriteProjectSourceInBackground(() => false)).toBeTrue();
    expect(service.blocklyService.publishPreparedCodeView).toHaveBeenCalledOnceWith(prepared.code, prepared.blockCodeMapText);
    expect(window['builder'].publishArduinoGeneratedCode).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  for (const cloud of [false, true]) it(`preserves ${cloud ? 'cloud' : 'legacy host'} startup artifact publication`, async () => {
    const prepared = startup();
    if (cloud) {
      service.configService.getCompileBackend = () => 'cloud'; service.projectService.isCloudBuild = () => true;
    } else delete window['builder'].isolatedBuildExecutionVersion;
    window['builder'].publishArduinoGeneratedCode.and.returnValue({ changed: false });
    expect(await service.generateAndWriteProjectSourceInBackground(() => false)).toBeTrue();
    expect(window['builder'].publishArduinoGeneratedCode).toHaveBeenCalledOnceWith('D:/logical', { artifacts: [], sketchCode: prepared.code });
  });
});

describe('BuilderService background preprocess ownership', () => {
  it('reports an unconfirmed stop instead of treating false as successful cleanup', async () => {
    const service = Object.create(_BuilderService.prototype) as any;
    service.preprocessProcess = { unsubscribe: jasmine.createSpy('unsubscribe') };
    service.preprocessStreamId = 'preprocess';
    service.cmdService = { kill: jasmine.createSpy('kill').and.resolveTo(false) };
    await expectAsync(service.stopPreprocess()).toBeRejectedWithError(/未确认停止/);
    expect(service.cmdService.kill).toHaveBeenCalledOnceWith('preprocess');
    expect(service.preprocessStreamId).toBe('preprocess');
    service.cmdService.kill.and.resolveTo(true);
    await service.stopPreprocess();
    expect(service.cmdService.kill).toHaveBeenCalledTimes(2);
    expect(service.preprocessStreamId).toBeNull();
  });

  it('shares an in-flight stop and clears ownership only after confirmation', async () => {
    const service = Object.create(_BuilderService.prototype) as any;
    let stopped!: (value: boolean) => void;
    service.preprocessStreamId = 'preprocess';
    service.cmdService = { kill: jasmine.createSpy('kill').and.returnValue(new Promise<boolean>(resolve => { stopped = resolve; })) };

    const firstStop = service.stopPreprocess();
    const secondStop = service.stopPreprocess();
    expect(service.cmdService.kill).toHaveBeenCalledOnceWith('preprocess');
    expect(service.preprocessStreamId).toBe('preprocess');
    stopped(true);
    await Promise.all([firstStop, secondStop]);
    expect(service.preprocessStreamId).toBeNull();
    expect(service.preprocessStop).toBeNull();
  });

  function queuedBuilder() {
    const service = Object.create(_BuilderService.prototype) as any;
    service.metrics = { record: () => {} };
    service.configService = { getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local', data: {} };
    service.projectService = { captureCurrentProjectGuard: () => () => true, beginBuildBackendOperation: () => ({ release() {} }), currentProjectPath: 'D:/owned', currentPackageData: {}, getBuildPath: async () => '' };
    service.workflowService = { currentState: ProcessState.IDLE,
      startBuild: () => { service.workflowService.currentState = ProcessState.BUILDING; return true; },
      finishBuild: jasmine.createSpy('finishBuild').and.callFake(() => { service.workflowService.currentState = ProcessState.IDLE; }) };
    service.electronService = { pathJoin: (...parts: string[]) => parts.join('/') };
    service.cmdService = { spawn: jasmine.createSpy('spawn') };
    service.npmService = { ensureLocalCompilerDependencies: async () => {} };
    service.t = (key: string) => key;
    for (const method of ['clearProgressTimer', 'updateCancelledNotice', 'ensureCancelState', 'handleCompileError', 'safeUpdateNotice']) service[method] = jasmine.createSpy(method);
    return service;
  }

  describe('background preparation', () => {
    let oldPath: any;
    beforeEach(() => {
      oldPath = window['path'];
      window['path'] = { getAppDataPath: () => '/sdk', getAilyChildPath: () => '/child', isExists: () => true };
    });
    afterEach(() => { window['path'] = oldPath; });

    function backgroundBuilder() {
      const service = queuedBuilder();
      service.preprocessRunGeneration = 0;
      service.actionService = { listen() {}, unlisten() {} };
      service.ngZone = { runOutsideAngular: (task: () => unknown) => task() };
      service.blocklyService = { workspace: {}, dependencySubject: new Subject(), aiExecutionActive$: new Subject() };
      service.workflowService.state$ = new Subject();
      service.projectService.stateSubject = { value: 'loaded' };
      service.projectService.hasUnsavedChanges = async () => false;
      service.projectService.getBoardModule = async () => 'board';
      service.platformService = { za7: '7za' };
      service.configService = { getCompileBackend: () => 'local', getCompileSettingsKey: () => 'local', data: {} };
      service.isInstallInProgress = () => false;
      service.getPendingChatBlockingOperationCount = () => 0;
      service.getMissingBoardDependencies = async () => [];
      service.generateWorkspaceCodeForPreprocess = async () => 'void setup() {}';
      service.writeCompileRequest = async () => '/project/request.json';
      for (const method of ['waitForBackgroundPreprocessIdle', 'waitForOneIdleBoundary', 'waitForAilyBuilderReady', 'writeTextFile']) {
        service[method] = async () => {};
      }
      service.recordPreprocessDuration = () => {};
      service.backgroundOutput = new Subject();
      service.cmdService.spawn.and.returnValue(service.backgroundOutput);
      service.cmdService.kill = jasmine.createSpy('kill').and.resolveTo(true);
      service.logService = { update: jasmine.createSpy('log') };
      service.appendCompileLog = jasmine.createSpy('compileLog');
      return service;
    }

    it('defers dirty-canvas preprocessing until save completes instead of making save wait for it', fakeAsync(() => {
      const service = backgroundBuilder();
      let dirty = true;
      service.projectService.hasUnsavedChanges = async () => dirty;
      service.init();
      service.blocklyService.dependencySubject.next('user-delete');
      tick(500);
      expect(service.cmdService.spawn).not.toHaveBeenCalled();
      expect(service.pendingPrecompile).toBeTrue();
      dirty = false;
      let release!: () => void;
      service.pauseBackgroundPreprocessForSave('D:/owned').then((value: () => void) => { release = value; });
      tick();
      release();
      tick(1300);
      expect(service.cmdService.spawn).toHaveBeenCalledTimes(1);
      service.destroy();
      tick();
    }));

    it('does not spawn after the project starts closing during preparation', fakeAsync(() => {
      const service = backgroundBuilder();
      let completePreparation!: () => void;
      service.writeCompileRequest = () => new Promise(resolve => {
        completePreparation = () => resolve('/project/request.json');
      });
      service.init();
      service.blocklyService.dependencySubject.next('changed');
      tick(500);
      service.projectService.isProjectTransitionInProgress = () => true;
      completePreparation();
      tick();
      expect(service.cmdService.spawn).not.toHaveBeenCalled();
      service.destroy();
    }));

    it('a private background execution uses its own captured inputs and supervisor path', fakeAsync(() => {
      const service = backgroundBuilder(), previousBridge = window['builder'];
      const captured = { code: 'void setup() {}', projectMacros: [], generatedArtifacts: [],
        sourceWorkspace: { documentText: '{}', revision: 1, runtimeRevision: 1, pageId: 'main' }, assertFresh: () => {} };
      service.generateWorkspaceBuildSnapshotForPreprocess = async () => captured;
      service.writeCompileRequest = jasmine.createSpy('request').and.resolveTo('/private/request.json');
      const prepare = jasmine.createSpy('prepare').and.callFake(async config => ({ ...config, currentProjectPath: '/private/execution', execution: { operation: 'preprocess' } }));
      const abandon = jasmine.createSpy('abandon').and.resolveTo(true);
      window['builder'] = { isolatedBuildExecutionVersion: 1, prepareBuildExecution: prepare, abandonPreparedPreprocess: abandon };
      try {
        service.init(); service.blocklyService.dependencySubject.next('changed'); tick(500);
        expect(prepare).toHaveBeenCalledOnceWith(jasmine.objectContaining({ generatedArtifacts: [], projectMacros: [] }), captured.sourceWorkspace, 'preprocess');
        expect(service.writeCompileRequest).toHaveBeenCalledOnceWith(jasmine.objectContaining({ currentProjectPath: '/private/execution' }));
        expect(service.cmdService.spawn.calls.mostRecent().args[2].buildWorkspace).toBe('/private/execution');
        service.backgroundOutput.complete(); tick(); service.destroy(); tick();
        expect(abandon).not.toHaveBeenCalled();
      } finally { window['builder'] = previousBridge; }
    }));

    for (const phase of ['stale capture', 'configuration write failure', 'closing before spawn']) {
      it(`relinquishes its exact private preparation on ${phase}`, fakeAsync(() => {
        const service = backgroundBuilder(), previousBridge = window['builder'];
        const execution = { currentProjectPath: '/private/execution', execution: { operation: 'preprocess', id: 'captured' }, sourceCapture: { digest: 'capture' } };
        const abandon = jasmine.createSpy('abandon').and.resolveTo(true);
        window['builder'] = { isolatedBuildExecutionVersion: 1, prepareBuildExecution: async () => ({ ...execution, code: 'generated code' }), abandonPreparedPreprocess: abandon };
        service.generateWorkspaceBuildSnapshotForPreprocess = async () => ({ code: 'void setup() {}', assertFresh: () => {
          if (phase === 'stale capture') throw new BlocklyCodePreparationInvalidatedError('invalidated by newer work');
        } });
        let finishWrite!: (request: string) => void;
        if (phase === 'configuration write failure') service.writeCompileRequest = async () => { throw new Error('configuration could not be written'); };
        if (phase === 'closing before spawn') service.writeCompileRequest = () => new Promise(resolve => { finishWrite = resolve; });
        try {
          service.init(); service.blocklyService.dependencySubject.next('changed'); tick(500);
          if (phase === 'closing before spawn') {
            expect(abandon).not.toHaveBeenCalled();
            service.projectService.isProjectTransitionInProgress = () => true;
            finishWrite('/private/request.json'); tick();
          }
          expect(abandon).toHaveBeenCalledOnceWith(execution);
          expect(service.cmdService.spawn).not.toHaveBeenCalled();
          expect(service.preprocessPreparations.size).toBe(0);
        } finally { service.destroy(); window['builder'] = previousBridge; }
      }));
    }

    it('keeps a real active stream until normal completion and suppresses stale AI-era output', fakeAsync(() => {
      const service = backgroundBuilder(); service.init();
      service.blocklyService.dependencySubject.next('changed'); tick(500);
      expect(service.cmdService.spawn).toHaveBeenCalledTimes(1);
      const subscription = service.preprocessProcess, streamId = service.preprocessStreamId;
      service.blocklyService.aiExecutionActive$.next(true);
      expect(service.preprocessProcess).toBe(subscription); expect(service.preprocessStreamId).toBe(streamId);
      expect(subscription.closed).toBeFalse(); expect(service.cmdService.kill).not.toHaveBeenCalled();
      service.backgroundOutput.next({ type: 'stdout', data: '[ERROR] stale diagnostics' });
      service.backgroundOutput.next({ type: 'stderr', data: 'stale output' });
      service.backgroundOutput.complete(); tick();
      expect(service.preprocessError).toBeNull(); expect(service.logService.update).not.toHaveBeenCalled();
      expect(service.appendCompileLog).not.toHaveBeenCalled();
      expect(service.preprocessProcess).toBeNull(); expect(service.preprocessStreamId).toBeNull();
      service.destroy();
    }));

    it('installation invalidates background results without terminating their registered process', fakeAsync(() => {
      const service = backgroundBuilder(); service.init();
      service.blocklyService.dependencySubject.next('changed'); tick(500);
      const subscription = service.preprocessProcess;
      service.workflowService.currentState = ProcessState.INSTALLING;
      service.workflowService.state$.next(ProcessState.INSTALLING); tick();
      expect(service.preprocessProcess).toBe(subscription); expect(subscription.closed).toBeFalse();
      expect(service.cmdService.kill).not.toHaveBeenCalled(); expect(service.pendingPrecompile).toBeTrue();
      service.backgroundOutput.error(new Error('stale install-era process error')); tick();
      expect(service.preprocessError).toBeNull(); expect(service.logService.update).not.toHaveBeenCalled();
      expect(service.preprocessProcess).toBeNull(); expect(service.preprocessStreamId).toBeNull();
      service.destroy();
    }));

    for (const replacement of [false, true]) it(`settles its terminal stream after diagnostic publication fails${replacement ? ' without clearing a newer stream' : ''}`, fakeAsync(() => {
      const service = backgroundBuilder(); service.init();
      service.blocklyService.dependencySubject.next('changed'); tick(500);
      const newer = { unsubscribe: jasmine.createSpy('newerUnsubscribe') };
      service.preprocessError = '[ERROR] background failed'; service.preprocessFullError = 'full background error';
      service.appendCompileLog.and.callFake(() => {
        if (replacement) { service.preprocessProcess = newer; service.preprocessStreamId = 'newer-preprocess'; }
        throw Object.assign(new Error('No space for diagnostic log'), { code: 'ENOSPC' });
      });
      expect(() => { service.backgroundOutput.complete(); tick(); }).not.toThrow();
      expect(service.appendCompileLog).toHaveBeenCalledTimes(1);
      expect(service.preprocessProcess).toBe(replacement ? newer : null);
      expect(service.preprocessStreamId).toBe(replacement ? 'newer-preprocess' : null);
      expect(service.cmdService.kill).not.toHaveBeenCalled();
      service.preprocessProcess = null; service.preprocessStreamId = null; service.destroy();
    }));

    it('settles a nullable stream error even when diagnostic collection itself fails', fakeAsync(() => {
      const service = backgroundBuilder(); service.init();
      service.blocklyService.dependencySubject.next('changed'); tick(500);
      service.appendPreprocessErrorOutput = () => { throw new Error('Diagnostic collection unavailable'); };
      expect(() => { service.backgroundOutput.error(null); tick(); }).not.toThrow();
      expect(service.preprocessProcess).toBeNull(); expect(service.preprocessStreamId).toBeNull();
      expect(service.cmdService.kill).not.toHaveBeenCalled(); service.destroy();
    }));
  });

  it('reports a busy foreground drain at its existing budget without killing a detached background command', fakeAsync(() => {
    const service = queuedBuilder();
    service.preprocessStreamId = 'preprocess';
    service.cmdService.kill = jasmine.createSpy('kill').and.resolveTo(false);
    let result: any;
    service.build().catch(error => { result = error; }); tick(60_000);
    expect(result.text).toContain('still running');
    expect(service.preprocessStreamId).toBe('preprocess');
    expect(service.cmdService.spawn).not.toHaveBeenCalled(); expect(service.cmdService.kill).not.toHaveBeenCalled();
  }));

  it('foreground source capture starts only after the existing preprocess naturally closes', fakeAsync(() => {
    const service = queuedBuilder(); service.preprocessRunGeneration = 1;
    service.preprocessProcess = {}; service.preprocessStreamId = 'existing-preprocess';
    const capture = jasmine.createSpy('capture').and.callFake(async () => { throw new Error('after-drain capture boundary'); });
    service.projectService.getBuildPath = capture;
    service.cmdService.kill = jasmine.createSpy('kill');
    const build = service.build().catch(() => undefined); tick(500);
    expect(capture).not.toHaveBeenCalled(); expect(service.cmdService.kill).not.toHaveBeenCalled();
    service.preprocessProcess = null; service.preprocessStreamId = null; tick(100);
    expect(capture).toHaveBeenCalledTimes(1); expect(service.cmdService.kill).not.toHaveBeenCalled();
    void build;
  }));

  for (const reason of ['cancelled', 'project-changed']) it(`drain rejects ${reason} even when the process finishes at that boundary`, fakeAsync(() => {
    const service = queuedBuilder(); service.preprocessProcess = {};
    let cancelled = false, outcome: any;
    service.waitForPreprocessDrain('D:/owned', () => cancelled, 'compile').catch(error => { outcome = error; }); tick();
    if (reason === 'cancelled') cancelled = true;
    else service.projectService.currentProjectPath = 'D:/other';
    service.preprocessProcess = null; tick(100);
    expect(outcome.message).toMatch(/cancelled|project changed/i); expect(service.cmdService.spawn).not.toHaveBeenCalled();
  }));

  it('does not finish workflow while cancelled preparation is pending', async () => {
    const service = queuedBuilder();
    let completePreparation!: () => void;
    let enteredPreparation!: () => void;
    const entered = new Promise<void>(resolve => { enteredPreparation = resolve; });
    service.projectService.getBuildPath = () => new Promise(resolve => { completePreparation = () => resolve(''); enteredPreparation(); });
    const build = service.build().catch((error: unknown) => error);
    await entered;
    service.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.workflowService.finishBuild).not.toHaveBeenCalled();
    service.cancelled = false; // The captured signal, not mutable UI state, owns cancellation.
    completePreparation(); await build;
    expect(service.cmdService.spawn).not.toHaveBeenCalled();
    expect(service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
  });

  it('rejects a project switch during preparation instead of building the newly selected project', async () => {
    const service = queuedBuilder();
    let completePreparation!: () => void;
    let enteredPreparation!: () => void;
    const entered = new Promise<void>(resolve => { enteredPreparation = resolve; });
    service.projectService.getBuildPath = () => new Promise(resolve => { completePreparation = () => resolve(''); enteredPreparation(); });
    const build = service.build().catch((error: { text: string }) => error);
    await entered;
    service.projectService.currentProjectPath = 'D:/other'; completePreparation();
    expect((await build).text).toContain('Build project changed before capture');
    expect(service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('invalidates an active preprocess without detaching or killing its registered process', () => {
    const unsubscribe = jasmine.createSpy('unsubscribe');
    const kill = jasmine.createSpy('kill').and.returnValue(new Promise<boolean>(() => undefined));
    const service = Object.create(_BuilderService.prototype) as any;
    service.preprocessRunGeneration = 3;
    service.preprocessProcess = { unsubscribe };
    service.preprocessStreamId = 'builder_preprocess_1';
    service.pendingPrecompile = false;
    service.cmdService = { kill };

    const result = service.handleAiExecutionActiveChange(true);

    expect(result).toBeUndefined();
    expect(service.preprocessRunGeneration).toBe(4);
    expect(service.preprocessProcess).toEqual({ unsubscribe });
    expect(service.preprocessStreamId).toBe('builder_preprocess_1');
    expect(service.pendingPrecompile).toBeTrue();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('retains pending preprocessing when installation interrupts preparation, but not after destruction', () => {
    const service = Object.create(_BuilderService.prototype) as any;
    Object.assign(service, { initialized: true, preprocessRunGeneration: 1, pendingPrecompile: false,
      configService: { getCompileBackend: () => 'local' },
      projectService: { currentProjectPath: '/project', isProjectTransitionInProgress: () => false },
      blocklyService: { aiWaiting: false }, getPendingChatBlockingOperationCount: () => 0,
      isInstallInProgress: () => true, workflowService: { currentState: ProcessState.INSTALLING } });
    expect(service.shouldCancelBackgroundPreprocess(1)).toBeTrue();
    expect(service.pendingPrecompile).toBeTrue();
    service.initialized = false; service.pendingPrecompile = false;
    expect(service.shouldCancelBackgroundPreprocess(1)).toBeTrue();
    expect(service.pendingPrecompile).toBeFalse();
  });

  it('serializes source ranges from the exact generator result, not the debounced UI map', () => {
    const service = Object.create(_BuilderService.prototype) as any;
    service.blocklyService = {
      workspace: {
        getBlockById: (blockId: string) => ({
          outputConnection: blockId === 'value-block' ? {} : null,
        }),
      },
      blockCodeMapSubject: {
        value: new Map([[
          'stale-block',
          {
            blockId: 'stale-block',
            lineRanges: [{ startLine: 99, endLine: 99 }],
          },
        ]]),
      },
    };
    const exactGeneratorMap = new Map([
      [
        'statement-block',
        {
          blockId: 'statement-block',
          blockType: 'controls_repeat',
          fragments: [],
          lineRanges: [
            { startLine: 20, endLine: 21 },
            { startLine: 4, endLine: 4 },
          ],
          executableLineRanges: [{ startLine: 20, endLine: 21 }],
          supportLineRanges: [{ startLine: 4, endLine: 4 }],
          codeSnippet: '',
        },
      ],
      [
        'value-block',
        {
          blockId: 'value-block',
          blockType: 'math_number',
          fragments: [],
          lineRanges: [{ startLine: 20, endLine: 20 }],
          executableLineRanges: [{ startLine: 20, endLine: 20 }],
          supportLineRanges: [],
          codeSnippet: '1',
        },
      ],
    ]);

    expect(service.createBlockSourceMappings(exactGeneratorMap)).toEqual([
      {
        blockId: 'statement-block',
        executionRole: 'statement',
        ranges: [
          { startLine: 4, endLine: 4 },
          { startLine: 20, endLine: 21 },
        ],
        executableRanges: [{ startLine: 20, endLine: 21 }],
        supportRanges: [{ startLine: 4, endLine: 4 }],
      },
      {
        blockId: 'value-block',
        executionRole: 'value',
        ranges: [{ startLine: 20, endLine: 20 }],
        executableRanges: [{ startLine: 20, endLine: 20 }],
        supportRanges: [],
      },
    ]);
  });

  it('atomically snapshots generated code and source mappings before generator state can change', async () => {
    const service = Object.create(_BuilderService.prototype) as any;
    const workspace = {
      isDragging: () => false, getInjectionDiv: () => null,
      getBlockById: (blockId: string) => ({
        outputConnection: blockId === 'value-block' ? {} : null,
      }),
    };
    service.blocklyService = { workspace };
    service.projectService = { currentProjectPath: 'D:/project' };
    service.waitForOneIdleBoundary = () => Promise.resolve();
    service.runBuilderPreprocessPhase = (
      _tag: string,
      operation: () => unknown,
    ) => Promise.resolve(operation());

    const generatedMap = new Map<string, BlockCodeMapping>([[
      'statement-block',
      {
        blockId: 'statement-block',
        blockType: 'controls_repeat',
        fragments: [],
        lineRanges: [
          { startLine: 4, endLine: 4 },
          { startLine: 12, endLine: 13 },
        ],
        executableLineRanges: [{ startLine: 12, endLine: 13 }],
        supportLineRanges: [{ startLine: 4, endLine: 4 }],
        codeSnippet: 'delay(1);',
      },
    ]]);
    const prepared = { code: 'void setup() {}\n', artifacts: null, revision: 1, blockCodeMapText: JSON.stringify([...generatedMap]) };
    service.blocklyService.isWorkspaceEditBlocked = () => false;
    service.blocklyService.getProjectPersistenceRevision = () => 1;
    service.blocklyService.getActivePageId = () => 'main';
    service.blocklyService.publishPreparedCodeView = jasmine.createSpy('publishPreparedCodeView');
    service.blocklyService.runWithBackgroundProjectCode = async operation => { await operation(prepared, () => undefined); return true; };

    const checkpoint: { inputCapturedAt?: number } = {};
    const startedAt = Date.now();
    const snapshot = await service.generateWorkspaceBuildSnapshotForPreprocess(
      workspace,
      'spec',
      checkpoint,
    );
    expect(checkpoint.inputCapturedAt).toBeGreaterThanOrEqual(startedAt);
    expect(checkpoint.inputCapturedAt).toBeLessThanOrEqual(Date.now());

    generatedMap.get('statement-block')!.lineRanges[0].startLine = 99;
    generatedMap.get('statement-block')!.executableLineRanges![0].startLine = 99;
    generatedMap.clear();

    expect(snapshot.code).toContain('void setup()');
    snapshot.assertFresh();
    service.blocklyService.getActivePageId = () => 'other';
    expect(snapshot.assertFresh).toThrowError(/BUILD_SOURCE_STALE/);
    service.blocklyService.getActivePageId = () => 'main';
    service.blocklyService.getProjectPersistenceRevision = () => 2;
    expect(snapshot.assertFresh).toThrowError(/BUILD_SOURCE_STALE/);
    service.blocklyService.getProjectPersistenceRevision = () => 1;
    service.projectService.currentProjectPath = 'D:/another-project';
    expect(snapshot.assertFresh).toThrowError(/BUILD_SOURCE_STALE/);
    expect(service.blocklyService.publishPreparedCodeView).toHaveBeenCalledWith(prepared.code, prepared.blockCodeMapText);
    expect(snapshot.blockSourceMappings).toEqual([{
      blockId: 'statement-block',
      executionRole: 'statement',
      ranges: [
        { startLine: 4, endLine: 4 },
        { startLine: 12, endLine: 13 },
      ],
      executableRanges: [{ startLine: 12, endLine: 13 }],
      supportRanges: [{ startLine: 4, endLine: 4 }],
    }]);
  });

  it('routes forced preprocessing through the prepared code/artifact cache', async () => {
    const service = Object.create(_BuilderService.prototype) as any;
    const workspace = { isDragging: () => false, getInjectionDiv: () => null };
    const prepared = { code: 'void setup() {}\n', artifacts: null };
    const assertCurrent = jasmine.createSpy('assertCurrent');
    const prepare = jasmine.createSpy('prepare').and.callFake(async operation => { await operation(prepared, assertCurrent); return true; });
    service.blocklyService = {
      workspace, runWithBackgroundProjectCode: prepare,
      isWorkspaceEditBlocked: () => false, getActivePageId: () => 'main',
      publishPreparedCodeView: jasmine.createSpy('publishPreparedCodeView'),
      getReusableGeneratedCode: () => { throw new Error('Code-only cache cannot publish artifacts.'); },
    };
    service.projectService = { currentProjectPath: 'D:/project' };
    service.waitForOneIdleBoundary = () => Promise.resolve();
    service.runBuilderPreprocessPhase = (_tag: string, operation: () => unknown) => operation();

    expect(await service.generateWorkspaceCodeForPreprocess(workspace, 'spec', true)).toBe(prepared.code);
    expect(prepare.calls.mostRecent().args[2]).toBeTrue();
    expect(assertCurrent).toHaveBeenCalled();
    expect(service.blocklyService.publishPreparedCodeView).toHaveBeenCalledWith(prepared.code, null);
    await service.generateWorkspaceCodeForPreprocess(workspace, 'spec');
    expect(prepare.calls.mostRecent().args[2]).toBeFalse();
  });
});

describe('BuilderService non-interrupting code capture', () => {
  let service: any;
  let workspace: any;
  let consume: jasmine.Spy;
  let cancelled: boolean;
  beforeEach(() => {
    cancelled = false;
    workspace = { currentGesture_: null, isDragging: () => false, getInjectionDiv: () => document.body };
    spyOn(Blockly.WidgetDiv, 'isVisible').and.returnValue(false);
    spyOn(Blockly.DropDownDiv, 'isVisible').and.returnValue(false);
    service = Object.create(_BuilderService.prototype);
    consume = jasmine.createSpy('consume').and.resolveTo('code');
    Object.assign(service, {
      codePreparationSequence: 0, t: (key: string) => key,
      projectService: { currentProjectPath: '/project' },
      blocklyService: {
        workspace, getActivePageId: () => 'main', isWorkspaceEditBlocked: () => false,
        runWithPreparedProjectCode: jasmine.createSpy('exclusive'),
        runWithBackgroundProjectCode: jasmine.createSpy('reader').and.callFake(async operation => {
          await operation({ code: 'code', artifacts: null }, () => undefined); return true;
        }),
      },
    });
  });
  const capture = () => service.runWithInteractiveProjectCode(workspace, consume, false, () => cancelled);

  it('waits outside the project queue for a drag and retries invalidated preparation without an edit fence', fakeAsync(() => {
    workspace.currentGesture_ = {};
    let result: string | undefined;
    capture().then(value => { result = value; }); tick(1500);
    expect(service.blocklyService.runWithBackgroundProjectCode).not.toHaveBeenCalled();
    workspace.currentGesture_ = null;
    const reader = service.blocklyService.runWithBackgroundProjectCode;
    let attempts = 0;
    reader.and.callFake(async operation => {
      if (++attempts === 1) return false;
      await operation({ code: 'code', artifacts: null }, () => undefined); return true;
    });
    tick(200);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(result).toBe('code');
    expect(service.blocklyService.runWithPreparedProjectCode).not.toHaveBeenCalled();
  }));

  it('keeps text and dropdown editors open, then returns the latest idle result', fakeAsync(() => {
    const input = document.createElement('input'); document.body.append(input); input.focus();
    let result: string;
    try {
      capture().then(value => { result = value; }); tick(500);
      expect(document.activeElement).toBe(input); expect(consume).not.toHaveBeenCalled();
      input.blur(); (Blockly.DropDownDiv.isVisible as jasmine.Spy).and.returnValue(true); tick(500);
      expect(consume).not.toHaveBeenCalled();
      (Blockly.DropDownDiv.isVisible as jasmine.Spy).and.returnValue(false); tick(100);
      expect(result!).toBe('code'); expect(consume).toHaveBeenCalledTimes(1);
    } finally { input.remove(); }
  }));

  it('can cancel a pending capture without waiting for the user to release input', fakeAsync(() => {
    workspace.currentGesture_ = {};
    let error: Error;
    capture().catch(value => { error = value; }); tick(100);
    cancelled = true; tick(100);
    expect(error!.message).toBe('CANCELLED_TITLE');
    expect(consume).not.toHaveBeenCalled();
  }));

  for (const invalidate of ['project', 'workspace', 'destroy', 'page']) {
    it(`drops pending capture after ${invalidate} changes`, fakeAsync(() => {
      workspace.currentGesture_ = {};
      let error: Error;
      capture().catch(value => { error = value; }); tick(100);
      if (invalidate === 'project') service.projectService.currentProjectPath = '/other';
      if (invalidate === 'workspace') service.blocklyService.workspace = {};
      if (invalidate === 'destroy') ++service.codePreparationSequence;
      if (invalidate === 'page') service.blocklyService.getActivePageId = () => 'other';
      tick(100);
      expect(error!.message).toContain('BUILD_SOURCE_STALE'); expect(consume).not.toHaveBeenCalled();
    }));
  }

  it('retries build-publication contention but propagates genuine generator errors', fakeAsync(() => {
    const reader = service.blocklyService.runWithBackgroundProjectCode;
    let attempts = 0, error: Error;
    reader.and.callFake(async () => { throw new Error(++attempts === 1 ? 'BUILD_WORKSPACE_BUSY: compile' : 'bad generator'); });
    capture().catch(value => { error = value; }); tick(100);
    expect(error!.message).toBe('bad generator'); expect(reader).toHaveBeenCalledTimes(2);
  }));

  it('Python publishes the revision captured after editing finishes, not the pre-wait revision', fakeAsync(() => {
    service.projectService.currentPackageData = { devmode: 'python' };
    service.electronService = { pathJoin: (...parts: string[]) => parts.join('/') };
    service.waitForOneIdleBoundary = () => Promise.resolve();
    service.runBuilderPreprocessPhase = (_tag, task) => task();
    service.writeTextFileAtomic = jasmine.createSpy('write').and.resolveTo();
    let revision = 1;
    service.blocklyService.getProjectPersistenceRevision = () => revision;
    service.blocklyService.publishPreparedCodeView = jasmine.createSpy('preview');
    service.blocklyService.runWithBackgroundProjectCode.and.callFake(async operation => {
      await operation({ code: 'print("latest")', artifacts: null, revision }, () => undefined); return true;
    });
    workspace.currentGesture_ = {};
    let result: any;
    service.generateAndWritePythonEntry().then(value => { result = value; }); tick(1000);
    expect(service.writeTextFileAtomic).not.toHaveBeenCalled();
    revision = 2; workspace.currentGesture_ = null; tick(100);
    expect(result.state).toBe('done');
    expect(service.writeTextFileAtomic).toHaveBeenCalledOnceWith('/project/main.py', 'print("latest")');
    expect(service.lastCode).toBe('print("latest")');
  }));

  it('Python rechecks freshness after its asynchronous file publication', async () => {
    service.projectService.currentPackageData = { devmode: 'python' };
    service.electronService = { pathJoin: (...parts: string[]) => parts.join('/') };
    let changed = false;
    service.generateWorkspaceBuildSnapshotForPreprocess = async () => ({ code: 'print(1)', assertFresh: () => {
      if (changed) throw new Error('BUILD_SOURCE_STALE: changed during write');
    } });
    service.writeTextFileAtomic = async () => { changed = true; };
    await expectAsync(service.generateAndWritePythonEntry()).toBeRejectedWithError(/BUILD_SOURCE_STALE/);
    expect(service.lastCode).toBeUndefined();
  });
});

describe('BlocklyService prepared code view', () => {
  function viewService() {
    const service = Object.create(BlocklyService.prototype) as any;
    service.workspaceCodeRevision = 4;
    service.generatedCodeRevision = -1;
    service.latestGeneratedCode = '';
    service.codeSubject = { next: jasmine.createSpy('code') };
    service.blockCodeMapSubject = {
      value: new Map([['previous', { blockId: 'previous' }]]),
      next: jasmine.createSpy('map').and.callFake((value: Map<string, unknown>) => {
        service.blockCodeMapSubject.value = value;
      }),
    };
    service.selectedBlockSubject = { value: 'selected' };
    service.selectedBlockIdsSubject = { value: ['selected'] };
    service.codeViewerPublisher = null;
    return service;
  }

  it('publishes a prepared snapshot to the code viewer without taking a build lease', () => {
    const service = viewService();
    const publishCodeState = jasmine.createSpy('publishCodeState');
    service.codeViewerPublisher = { publishCodeState };
    const mapText = JSON.stringify([['selected', { blockId: 'selected' }]]);

    service.publishPreparedCodeView('void setup() {}', mapText);

    expect(service.codeSubject.next).toHaveBeenCalledOnceWith('void setup() {}');
    expect(service.blockCodeMapSubject.value.get('selected')).toEqual({ blockId: 'selected' });
    expect(publishCodeState).toHaveBeenCalledOnceWith(
      'void setup() {}',
      service.blockCodeMapSubject.value,
      'selected',
      ['selected'],
      jasmine.any(Function),
    );
  });

  it('keeps the previous block map when a runtime has no map and flushes after the viewer subscribes', () => {
    const service = viewService();
    const previous = service.blockCodeMapSubject.value;

    service.publishPreparedCodeView('void loop() {}', null);
    expect(service.blockCodeMapSubject.next).not.toHaveBeenCalled();

    const publishCodeState = jasmine.createSpy('publishCodeState');
    service.registerCodeViewerPublisher({ publishCodeState });
    expect(publishCodeState).toHaveBeenCalledOnceWith('void loop() {}', previous, 'selected', ['selected'], jasmine.any(Function));
  });
});
