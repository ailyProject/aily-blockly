import { _BuilderService } from './builder.service';
import { BlocklyService } from './blockly.service';
import { ProcessState } from '@core/app-shell/public-api';
import {
  type BlockCodeMapping,
} from '../components/blockly/generators/arduino/arduino';

describe('BuilderService background preprocess ownership', () => {
  function queuedBuilder() {
    const service = Object.create(_BuilderService.prototype) as any;
    service.projectService = { currentProjectPath: 'D:/owned', currentPackageData: {}, getBuildPath: async () => '' };
    service.workflowService = { currentState: ProcessState.IDLE,
      startBuild: () => { service.workflowService.currentState = ProcessState.BUILDING; return true; },
      finishBuild: jasmine.createSpy('finishBuild').and.callFake(() => { service.workflowService.currentState = ProcessState.IDLE; }) };
    service.electronService = { pathJoin: (...parts: string[]) => parts.join('/') };
    service.cmdService = { spawn: jasmine.createSpy('spawn') };
    service.t = (key: string) => key;
    for (const method of ['clearProgressTimer', 'updateCancelledNotice', 'ensureCancelState', 'handleCompileError']) service[method] = jasmine.createSpy(method);
    return service;
  }

  it('cancels resource waiting before preparing or launching a Blockly request', async () => {
    const service = queuedBuilder();
    service.appDataResourceLock = { runShared: (_label: string, _task: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('APPDATA_RESOURCE_LOCK_CANCELLED')))) };
    const result = service.build().catch((error: Error) => error);
    service.cancel();
    expect((await result).message).toBe('APPDATA_RESOURCE_LOCK_CANCELLED');
    expect(service.cmdService.spawn).not.toHaveBeenCalled();
    expect(service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
  });

  it('does not release SDK access or finish workflow while cancelled preparation is pending', async () => {
    const service = queuedBuilder();
    let resourceHeld = false, completePreparation!: () => void;
    service.projectService.getBuildPath = () => new Promise(resolve => { completePreparation = () => resolve(''); });
    service.appDataResourceLock = { runShared: async (_label: string, task: (token: string) => Promise<unknown>) => {
      resourceHeld = true;
      try { return await task('reader'); } finally { resourceHeld = false; }
    } };
    const build = service.build().catch((error: unknown) => error);
    service.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resourceHeld).toBeTrue();
    expect(service.workflowService.finishBuild).not.toHaveBeenCalled();
    service.cancelled = false; // The captured signal, not mutable UI state, owns cancellation.
    completePreparation(); await build;
    expect(resourceHeld).toBeFalse();
    expect(service.cmdService.spawn).not.toHaveBeenCalled();
    expect(service.workflowService.finishBuild).toHaveBeenCalledTimes(1);
  });

  it('rejects a project switch while queued instead of building the newly selected project', async () => {
    const service = queuedBuilder();
    let grant!: () => void;
    service.appDataResourceLock = { runShared: (_label: string, task: (token: string) => Promise<unknown>) =>
      new Promise(resolve => { grant = () => resolve(task('reader')); }) };
    const build = service.build().catch((error: { text: string }) => error);
    service.projectService.currentProjectPath = 'D:/other'; grant();
    expect((await build).text).toContain('BUILD_SOURCE_STALE');
    expect(service.cmdService.spawn).not.toHaveBeenCalled();
  });

  it('invalidates and detaches an active preprocess before asynchronous process cleanup', () => {
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
    expect(service.preprocessProcess).toBeNull();
    expect(service.preprocessStreamId).toBeNull();
    expect(service.pendingPrecompile).toBeTrue();
    expect(unsubscribe).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnceWith('builder_preprocess_1');
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
    service.blocklyService.runWithPreparedProjectCode = operation => operation(prepared, () => undefined);

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
    const workspace = {};
    const prepared = { code: 'void setup() {}\n', artifacts: null };
    const assertCurrent = jasmine.createSpy('assertCurrent');
    const prepare = jasmine.createSpy('prepare').and.callFake(operation => operation(prepared, assertCurrent));
    service.blocklyService = {
      workspace, runWithPreparedProjectCode: prepare,
      publishPreparedCodeView: jasmine.createSpy('publishPreparedCodeView'),
      getReusableGeneratedCode: () => { throw new Error('Code-only cache cannot publish artifacts.'); },
    };
    service.projectService = { currentProjectPath: 'D:/project' };
    service.waitForOneIdleBoundary = () => Promise.resolve();
    service.runBuilderPreprocessPhase = (_tag: string, operation: () => unknown) => operation();

    expect(await service.generateWorkspaceCodeForPreprocess(workspace, 'spec', true)).toBe(prepared.code);
    expect(prepare.calls.mostRecent().args[1]).toBeTrue();
    expect(assertCurrent).toHaveBeenCalled();
    expect(service.blocklyService.publishPreparedCodeView).toHaveBeenCalledWith(prepared.code, null);
    await service.generateWorkspaceCodeForPreprocess(workspace, 'spec');
    expect(prepare.calls.mostRecent().args[1]).toBeFalse();
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
    );
  });

  it('keeps the previous block map when a runtime has no map and flushes after the viewer subscribes', () => {
    const service = viewService();
    const previous = service.blockCodeMapSubject.value;

    service.publishPreparedCodeView('void loop() {}', null);
    expect(service.blockCodeMapSubject.next).not.toHaveBeenCalled();

    const publishCodeState = jasmine.createSpy('publishCodeState');
    service.registerCodeViewerPublisher({ publishCodeState });
    expect(publishCodeState).toHaveBeenCalledOnceWith('void loop() {}', previous, 'selected', ['selected']);
  });
});
