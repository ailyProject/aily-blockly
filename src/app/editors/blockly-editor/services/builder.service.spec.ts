import { _BuilderService } from './builder.service';
import {
  type BlockCodeMapping,
} from '../components/blockly/generators/arduino/arduino';

describe('BuilderService background preprocess ownership', () => {
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
    const prepared = { code: 'void setup() {}\n', artifacts: null, blockCodeMapText: JSON.stringify([...generatedMap]) };
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
      publishGeneratedCode: jasmine.createSpy('publish'),
      getReusableGeneratedCode: () => { throw new Error('Code-only cache cannot publish artifacts.'); },
    };
    service.projectService = { currentProjectPath: 'D:/project' };
    service.waitForOneIdleBoundary = () => Promise.resolve();
    service.runBuilderPreprocessPhase = (_tag: string, operation: () => unknown) => operation();

    expect(await service.generateWorkspaceCodeForPreprocess(workspace, 'spec', true)).toBe(prepared.code);
    expect(prepare.calls.mostRecent().args[1]).toBeTrue();
    expect(assertCurrent).toHaveBeenCalled();
    expect(service.blocklyService.publishGeneratedCode).toHaveBeenCalledWith(prepared.code);
    await service.generateWorkspaceCodeForPreprocess(workspace, 'spec');
    expect(prepare.calls.mostRecent().args[1]).toBeFalse();
  });
});
