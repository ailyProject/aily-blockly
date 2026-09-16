import * as Blockly from 'blockly';
import { ArduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { Subject } from 'rxjs';
import { BlocklyService } from './blockly.service';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';

describe('Blockly library failure recovery', () => {
  let service: any;
  let runtime: BlocklyGeneratorRuntimeService;
  let sources: Map<string, string>;
  let snapshots: Map<string, any>;
  const projectPath = '/project';
  const packagePath = (name: string) => `${projectPath}/node_modules/${name}`;
  const name = (suffix: string) => `@aily-project/lib-${suffix}`;
  const path = (suffix: string) => packagePath(name(suffix));
  const toolbox = (suffix: string) => service.toolbox.contents.find((item: any) => item.ailyLibraryName === name(suffix));

  beforeEach(() => {
    sources = new Map();
    snapshots = new Map();
    runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', projectPath, getWorkspace: () => null });
    service = Object.create(BlocklyService.prototype);
    Object.assign(service, {
      generatorRuntime: runtime,
      translateService: { currentLang: 'en', instant: (key: string) => key },
      electronService: {
        pathJoin: (...parts: string[]) => parts.join('/'),
        exists: (file: string) => sources.has(file),
        readFile: (file: string) => sources.get(file),
      },
      blocklyLibraryPackageService: {
        getPackagePath: (_project: string, lib: string) => packagePath(lib),
        readLibraryPackage: (_project: string, lib: string) => snapshots.get(lib),
        validateLibraryPackage: () => ({ valid: true, errors: [], warnings: [] }),
      },
      noticeService: { update: jasmine.createSpy('notice') },
      loadedLibraries: new Set(), loadedLibraryInfos: new Map(), loadedGenerators: new Map(),
      libraryLoadTasks: new Map(), libraryLoadQueue: Promise.resolve(), libraryLoadEpoch: 0,
      failedLibraryLoads: new Map(),
      iconsMap: new Map(), blockDefinitionsMap: new Map(), blockTypeToLibMap: new Map(),
      runtimeDefinedLibraryBlockTypes: new Set(),
      libraryIntegrityFailureLogSignatures: new Map(), libraryIntegrityWarningLogSignatures: new Map(),
      loadLibraryFinishedLoadingSubject: new Subject(),
      toolbox: { kind: 'categoryToolbox', contents: [] },
      getProjectDocument: () => ({ pages: [] }),
      loadProjectDocument: jasmine.createSpy('restoreDocument'),
      refreshToolboxFromContents: jasmine.createSpy('refreshToolbox'),
      requestCodeViewerRefresh: jasmine.createSpy('refreshCode'),
      ensureToolboxItemIds: () => {}, applyToolboxSortOrderToContents: () => {},
      checkLibraryIntegrity: () => ({ valid: true, errors: [] }),
      resolveLibraryLocalPath: (_project: string, lib: string) => lib === name('bad') ? '/source/local-library' : undefined,
    });
    spyOn(console, 'error');
  });

  afterEach(() => runtime.destroy());

  function library(suffix: string, source = `Arduino.forBlock.recovery_${suffix} = () => '${suffix}';`) {
    const lib = name(suffix);
    const root = path(suffix);
    snapshots.set(lib, {
      ref: { name: lib, path: root },
      paths: { generatorJs: `${root}/generator.js` },
      packageJson: { name: lib, version: '1.0.0' },
      blockJson: [{ type: `recovery_${suffix}`, message0: suffix, previousStatement: null, nextStatement: null }],
      toolboxRoot: { kind: 'category', name: suffix, contents: [{ kind: 'block', type: `recovery_${suffix}` }] },
    });
    sources.set(`${root}/generator.js`, source);
  }

  async function load(suffix: string) { await service.loadLibrary(name(suffix), projectPath); }

  it('isolates execution failure, rolls back partial writes and still loads later libraries', async () => {
    library('before', `const sharedHealthyValue = 'before'; Arduino.forBlock.recovery_before = () => sharedHealthyValue;`);
    library('bad', `const failedLexical = 1; Arduino.forBlock.recovery_before = () => 'corrupt';
      Blockly.Msg.RECOVERY_LEAK = 'leak'; Blockly.Extensions.register('recovery_leak', function() {});
      missingRecoverySymbol;`);
    library('after', `const failedLexical = 2; Arduino.forBlock.recovery_after = () => String(failedLexical);`);
    await load('before');
    await expectAsync(load('bad')).toBeResolved();
    await load('after');

    const generator = runtime.getActiveGenerator() as ArduinoGenerator;
    expect(generator.forBlock['recovery_before']({ type: 'recovery_test' } as Blockly.Block, generator)).toBe('before');
    expect(generator.forBlock['recovery_after']({ type: 'recovery_test' } as Blockly.Block, generator)).toBe('2');
    expect(Blockly.Msg['RECOVERY_LEAK']).toBeUndefined();
    expect(Blockly.Extensions.isRegistered('recovery_leak')).toBeFalse();
    expect(service.loadedLibraries.has(path('bad'))).toBeFalse();
    expect(toolbox('bad').ailyLibraryLoadFailed).toBeTrue();
    expect(toolbox('bad').ailyIsLocalLibrary).toBeTrue();
    expect(toolbox('before').ailyLibraryLoadFailed).toBeFalse();
    expect(toolbox('after').ailyLibraryLoadFailed).toBeFalse();
    const workspace = new Blockly.Workspace();
    try {
      expect(workspace.newBlock('recovery_bad').type).toBe('recovery_bad');
      expect(() => generator.forBlock['recovery_bad']({ type: 'recovery_test' } as Blockly.Block, generator)).toThrowError(/加载失败/);
    } finally { workspace.dispose(); }
  });

  it('shows original error and local source context, then clears red state after repair', async () => {
    library('before');
    library('bad', 'const repairedBinding = 1; missingRecoverySymbol;');
    await load('before');
    await load('bad');
    expect(await service.retryLibrary(name('bad'), projectPath)).toBeFalse();
    const notice = service.noticeService.update.calls.mostRecent().args[0];
    expect(notice.detail).toContain('missingRecoverySymbol');
    expect(notice.detail).toContain(`${path('bad')}/generator.js`);
    expect(notice.detail).toContain('/source/local-library');
    expect(typeof notice.onRetry).toBe('function');

    sources.set(`${path('bad')}/generator.js`, `const repairedBinding = 2; Arduino.forBlock.recovery_bad = () => String(repairedBinding);`);
    expect(await service.retryLibrary(name('bad'), projectPath)).toBeTrue();
    expect(toolbox('bad').ailyLibraryLoadFailed).toBeFalse();
    expect(service.failedLibraryLoads.size).toBe(0);
    const generator = runtime.getActiveGenerator() as ArduinoGenerator;
    expect(generator.forBlock['recovery_bad']({ type: 'recovery_test' } as Blockly.Block, generator)).toBe('2');
    expect(service.loadProjectDocument).toHaveBeenCalled();
  });

  it('retains multiple failed placeholders across repeated syntax and runtime failures', async () => {
    library('before');
    library('bad', 'const invalid = ;');
    library('second_bad', 'missingRecoverySymbol;');
    library('after');
    for (const suffix of ['before', 'bad', 'second_bad', 'after']) await load(suffix);
    expect(runtime.isActive()).toBeTrue();
    expect(service.loadedLibraries.size).toBe(2);
    expect(toolbox('bad').ailyLibraryLoadFailed).toBeTrue();
    expect(toolbox('second_bad').ailyLibraryLoadFailed).toBeTrue();
    expect(await service.retryLibrary(name('bad'), projectPath)).toBeFalse();
    expect(service.loadedLibraries.size).toBe(2);
    expect(toolbox('second_bad').ailyLibraryLoadFailed).toBeTrue();
  });

  it('serializes concurrent loads while recovering and deduplicates one library', async () => {
    library('before'); library('bad', 'missingRecoverySymbol;'); library('after');
    await Promise.all([load('before'), load('bad'), load('after'), load('after')]);
    expect(runtime.isActive()).toBeTrue();
    expect(service.loadedLibraries.size).toBe(2);
    expect(service.toolbox.contents.filter((item: any) => item.ailyLibraryName === name('after')).length).toBe(1);
    expect(toolbox('bad').ailyLibraryLoadFailed).toBeTrue();
  });

  it('keeps integrity errors recoverable without rebuilding healthy runtime', async () => {
    library('before'); library('bad'); library('after');
    await load('before');
    const generator = runtime.getActiveGenerator();
    service.checkLibraryIntegrity = (snapshot: any) => snapshot.ref.name === name('bad')
      ? { valid: false, errors: ['generator.js:3: SyntaxError'] } : { valid: true, errors: [] };
    await load('bad'); await load('after');
    expect(runtime.getActiveGenerator()).toBe(generator);
    expect(toolbox('bad').ailyLibraryLoadFailed).toBeTrue();
    expect(service.loadedLibraries.size).toBe(2);
  });
});
