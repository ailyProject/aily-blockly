import * as Blockly from 'blockly';
import 'blockly/blocks';
import { BehaviorSubject, Subject } from 'rxjs';
import { SerialOperationQueue } from '@shared/public-api';
import { projectDataRuntime } from '@domain/project/public-api';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { BlocklyProjectCodePreparation } from '../../../editors/blockly-editor/services/prepared-project-code';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { AbsReferenceContractCache } from './abs-reference-contract-cache';

describe('library rebuild transfers runtime ownership without acknowledging edits', () => {
  let editor: BlocklyService, internal: any, project: _ProjectService;
  let runtime: BlocklyGeneratorRuntimeService, live: Blockly.Workspace;
  let files: Map<string, string>, oldFs: unknown, load: jasmine.Spy;
  const path = 'D:/runtime-test';
  const options = () => ({ projectPath: path, packageJson: {}, libraryNames: ['test-library'], projectService: {} });
  const field = () => live.getBlockById('text')!;
  const recoveryFiles = () => [...files.keys()].filter(name => name.endsWith('.recovery.json'));

  beforeEach(() => {
    editor = Object.create(BlocklyService.prototype); internal = editor; live = new Blockly.Workspace();
    runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', projectPath: path, getWorkspace: () => live as any });
    Object.assign(internal, {
      _workspace: live, projectDocumentSchemaVersion: 3, documentMetadata: {}, generatorRuntime: runtime,
      projectRevision: new BlocklyProjectRevision(), workspaceEditGate: new BlocklyWorkspaceEditGate(),
      projectCodePreparation: new BlocklyProjectCodePreparation(), projectOperations: new SerialOperationQueue(),
      pageReferenceContracts: new AbsReferenceContractCache(), declarativeBlocks: new BlocklyDeclarativeBlockCatalog(),
      libraryLoadQueue: Promise.resolve(), libraryLoadEpoch: 0, rebuildingLibraryRuntime: false,
      failedLibraryLoads: new Map(), iconsMap: new Map(), blockDefinitionsMap: new Map(), loadedGenerators: new Map(),
      loadedLibraries: new Set(), loadedLibraryInfos: new Map(), runtimeDefinedLibraryBlockTypes: new Set(),
      libraryLoadTasks: new Map(), libraryIntegrityFailureLogSignatures: new Map(), libraryIntegrityWarningLogSignatures: new Map(),
      blockTypeToLibMap: new Map(), setAiWritingActive() {}, hideChaff() {}, refreshToolboxFromContents() {}, requestCodeViewerRefresh() {},
      pagesSubject: new BehaviorSubject([]), sharedModelSubject: new BehaviorSubject({ procedureBlocks: [] }),
      activePageIdSubject: new BehaviorSubject('one'), openedPageIdsSubject: new BehaviorSubject(['one']),
      selectedBlockSubject: new BehaviorSubject(null), selectedBlockIdsSubject: new BehaviorSubject([]),
      loadLibraryFinishedLoadingSubject: new Subject(), projectPageHydrated: new Subject(),
      workspaceVisualRefreshRequestSubject: new Subject(), closeWorkspaceBlockSearch() {}, mountExternalToolbox() {},
      loadWorkspaceJson: state => Blockly.serialization.workspaces.load(state, live), getWorkspaceLoadReadbackView: state => state,
    });
    editor.loadProjectDocument(editor.normalizeProjectAbi({ schemaVersion: 3, activePageId: 'one', openedPageIds: ['one'],
      pages: [{ id: 'one', title: 'One', content: { blocks: { languageVersion: 0,
        blocks: [{ type: 'text', id: 'text', fields: { TEXT: 'saved' }, deletable: false }] } } },
      { id: 'other', title: 'Other', content: { blocks: { languageVersion: 0, blocks: [] }, extension: { keep: true } } }],
      sharedModel: { procedureBlocks: [], extension: { keep: 'shared data' } } }));
    load = spyOn(editor, 'loadLibrary').and.resolveTo();
    oldFs = window['fs']; files = new Map([[`${path}/project.abi`, JSON.stringify(editor.getProjectAbiForSave())]]);
    window['fs'] = { readFileSync: file => files.get(file), mkdirSync() {},
      writeFileSync: (file, text) => { if (files.has(file)) throw new Error('exists'); files.set(file, text); },
      unlinkSync: file => files.delete(file) };
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    project = new _ProjectService(editor, { listen() {}, unlisten() {} } as any, {} as any);
    project.currentProjectPath = path; project.init();
    project.rememberLoadedProject(path, files.get(`${path}/project.abi`)!, editor.getProjectAbiForSave());
  });
  afterEach(() => { project.destroy(); live.dispose(); runtime.destroy(); window['fs'] = oldFs; });

  it('keeps repeated clean reloads clean, preserving disk bytes, protections, pages and shared data', async () => {
    const before = editor.getProjectAbiForSave(), disk = files.get(`${path}/project.abi`);
    for (let round = 0; round < 3; round++) {
      await project.rebuildLibraryRuntime(options());
      expect(await project.hasUnsavedChanges()).toBeFalse(); expect(field().isDeletable()).toBeFalse();
      expect(editor.getProjectAbiForSave()).toEqual(before); expect(files.get(`${path}/project.abi`)).toBe(disk);
      expect(recoveryFiles()).toEqual([]); expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    }
  });
  it('collects library usage from inactive pages, dormant shadows and shared procedures', () => {
    const document = editor.getProjectDocument();
    (document.pages[1].content as any).blocks.blocks.push({ type: 'other_page_block', id: 'other', inputs: { VALUE: {
      shadow: { type: 'dormant_block', id: 'dormant' }, block: { type: 'text', id: 'override', fields: { TEXT: 'value' } },
    } } });
    document.sharedModel.procedureBlocks.push({ type: 'shared_procedure', id: 'procedure' } as any);
    for (const type of ['other_page_block', 'dormant_block', 'shared_procedure']) {
      internal.blockTypeToLibMap.set(type, { name: `@aily-project/lib-${type}`, version: '1.0.0' });
    }
    expect(Object.keys(editor.getProjectUsedLibraryManifest(undefined, document)).sort()).toEqual([
      '@aily-project/lib-dormant_block', '@aily-project/lib-other_page_block', '@aily-project/lib-shared_procedure',
    ]);
  });
  it('retains dirty state and the original saved baseline through a reload and a manual revert', async () => {
    field().setFieldValue('unsaved', 'TEXT'); editor.renamePage('other', 'renamed');
    await project.rebuildLibraryRuntime(options());
    expect(field().getFieldValue('TEXT')).toBe('unsaved'); expect(await project.hasUnsavedChanges()).toBeTrue();
    field().setFieldValue('saved', 'TEXT'); expect(await project.hasUnsavedChanges()).toBeTrue();
    editor.renamePage('other', 'Other'); expect(await project.hasUnsavedChanges()).toBeFalse();
  });
  for (const [name, edit] of [
    ['comment', (workspace: Blockly.Workspace) => workspace.getBlockById('text')!.setCommentText('user note')],
    ['protection', (workspace: Blockly.Workspace) => workspace.getBlockById('text')!.setDeletable(true)],
    ['disabled', (workspace: Blockly.Workspace) => workspace.getBlockById('text')!.setDisabledReason(true, 'user')],
    ['variable model', (workspace: Blockly.Workspace) => workspace.getVariableMap().createVariable('unused', '', 'model')],
    ['numeric value', (workspace: Blockly.Workspace) => workspace.newBlock('math_number', 'number').setFieldValue(42, 'NUM')],
    ['block deletion', (workspace: Blockly.Workspace) => workspace.getBlockById('text')!.dispose(false)],
    ['procedure definition', (workspace: Blockly.Workspace) => workspace.newBlock('procedures_defnoreturn', 'procedure').setFieldValue('userProcedure', 'NAME')],
    ['connection', (workspace: Blockly.Workspace) => workspace.newBlock('text_print', 'print').getInput('TEXT')!.connection!
      .connect(workspace.getBlockById('text')!.outputConnection!)],
    ['dynamic extraState', (workspace: Blockly.Workspace) => {
      const block: any = workspace.newBlock('controls_if', 'dynamic'); block.elseifCount_ = 1; block.elseCount_ = 1; block.updateShape_();
    }],
  ] as const) it(`retains a native ${name} edit through a rebuild without resetting the baseline`, async () => {
    const saved = editor.getProjectDocument(); edit(live); const edited = editor.getProjectDocument();
    expect(await project.hasUnsavedChanges()).toBeTrue(); await project.rebuildLibraryRuntime(options());
    expect(editor.getProjectDocument()).toEqual(edited); expect(await project.hasUnsavedChanges()).toBeTrue();
    editor.loadProjectDocument(saved); expect(await project.hasUnsavedChanges()).toBeFalse();
  });
  it('serializes against other project work and captures edits made before the queued rebuild starts', async () => {
    let release!: () => void;
    const earlier = editor.runProjectOperation(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const rebuilding = project.rebuildLibraryRuntime(options());
    expect(load).not.toHaveBeenCalled(); field().setFieldValue('queued edit', 'TEXT'); release();
    await earlier; await rebuilding;
    expect(field().getFieldValue('TEXT')).toBe('queued edit'); expect(await project.hasUnsavedChanges()).toBeTrue();
  });
  it('owns the edit gate throughout library loading and passes ownership to the loader', async () => {
    load.and.callFake(async (_name, _path, owner) => {
      expect(owner).toBeTruthy(); owner.assertCurrent(); expect(editor.isWorkspaceEditInProgress()).toBeTrue();
      expect(() => editor.renamePage('other', 'forbidden')).toThrow();
      expect(() => editor.getProjectDocument()).toThrow();
      await Promise.resolve(); owner.assertCurrent();
    });
    await project.rebuildLibraryRuntime(options()); expect(editor.isWorkspaceEditInProgress()).toBeFalse();
  });
  const useRealLibraryLoader = () => {
    const snapshot = { paths: { generatorJs: 'test-library/generator.js' },
      packageJson: { version: '1.0.0' },
      blockJson: [{ type: 'audit_library_value', message0: 'value', output: null }] };
    Object.assign(internal, {
      blocklyLibraryPackageService: { getPackagePath: (_path, name) => name, readLibraryPackage: () => snapshot },
      electronService: { pathJoin: (...parts) => parts.join('/'), exists: name => name.endsWith('/generator.js'),
        readFile: () => 'Arduino.forBlock["audit_library_value"] = () => ["1", 0];' },
      translateService: { currentLang: 'en', instant: value => value },
      resolveLibraryLocalPath: () => undefined,
    });
    spyOn<any>(editor, 'checkLibraryIntegrity').and.returnValue({ valid: true, errors: [], warnings: [] });
    load.and.callThrough();
  };
  it('carries explicit edit ownership through the real library, generator and JSON block loaders', async () => {
    useRealLibraryLoader();
    await project.rebuildLibraryRuntime(options());
    expect(internal.loadedLibraries.has('test-library')).toBeTrue();
    expect(Blockly.Blocks['audit_library_value']?.init).toEqual(jasmine.any(Function));
    expect(runtime.getActiveGenerator()!.forBlock['audit_library_value']).toEqual(jasmine.any(Function));
    expect(await project.hasUnsavedChanges()).toBeFalse();
  });
  it('does not register library definitions into a runtime replaced during generator loading', async () => {
    useRealLibraryLoader();
    spyOn(editor, 'loadLibGenerator').and.callFake(async () => {
      runtime.rebuild({ projectPath: path }); return true;
    });
    const register = spyOn(editor, 'loadLibBlocks').and.callThrough();
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejectedWithError(/replaced generator/);
    expect(register).not.toHaveBeenCalled(); expect(recoveryFiles().length).toBe(1);
  });
  it('stops a programmatic edit made outside the gate from being replaced by the old snapshot', async () => {
    load.and.callFake(async () => field().setFieldValue('late edit', 'TEXT'));
    const replace = spyOn(editor, 'loadProjectDocument').and.callThrough();
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejectedWithError(/stopped replacing/);
    expect(replace).not.toHaveBeenCalled(); expect(field().getFieldValue('TEXT')).toBe('late edit');
    expect(editor.isWorkspaceEditBlocked()).toBeTrue();
  });
  for (const failure of ['load', 'missing-definition', 'readback']) it(`retains a recovery snapshot and refuses a clean/save-ready state after ${failure}`, async () => {
    field().setFieldValue('unsaved source', 'TEXT'); const before = editor.getProjectAbiForSave();
    const disk = files.get(`${path}/project.abi`);
    if (failure === 'load') load.and.rejectWith(new Error('library unavailable'));
    if (failure === 'missing-definition') spyOn<any>(editor, 'collectBlockTypesFromProjectDocument').and.returnValue(['missing-block']);
    if (failure === 'readback') {
      const original = editor.loadProjectDocument.bind(editor);
      spyOn(editor, 'loadProjectDocument').and.callFake((...args) => { original(...args); field().setDeletable(true); });
    }
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejectedWithError(/Unsaved project snapshot:/);
    expect(recoveryFiles().length).toBe(1); expect(JSON.parse(files.get(recoveryFiles()[0])!)).toEqual(before);
    expect(files.get(`${path}/project.abi`)).toBe(disk);
    expect(runtime.isReady()).toBeFalse(); await expectAsync(project.hasUnsavedChanges()).toBeRejected();
    expect(editor.isWorkspaceEditBlocked()).toBeTrue();
  });
  it('does not replace or quarantine another project when a queued operation becomes stale', async () => {
    const rebuilding = project.rebuildLibraryRuntime(options()); project.currentProjectPath = 'D:/other';
    await expectAsync(rebuilding).toBeRejectedWithError(/changed/);
    expect(load).not.toHaveBeenCalled(); expect(recoveryFiles()).toEqual([]); expect(editor.isWorkspaceEditBlocked()).toBeFalse();
  });
  it('does not quarantine a replacement workspace after an asynchronous load fails', async () => {
    load.and.callFake(async () => { internal.workspaceEditGate.reset(); internal._workspace = null; throw new Error('old failed'); });
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejected();
    expect(editor.isWorkspaceEditBlocked()).toBeFalse(); expect(recoveryFiles().length).toBe(1);
  });
  it('refuses a rebuild if its recovery snapshot cannot be written', async () => {
    window['fs'].writeFileSync = () => { throw new Error('disk unavailable'); };
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejectedWithError('disk unavailable');
    expect(load).not.toHaveBeenCalled(); expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    expect(await project.hasUnsavedChanges()).toBeFalse();
  });
  it('does not acknowledge an external ABI write during library loading', async () => {
    load.and.callFake(async () => { files.set(`${path}/project.abi`, 'external'); });
    await expectAsync(project.rebuildLibraryRuntime(options())).toBeRejectedWithError(/project.abi changed/);
    expect(files.get(`${path}/project.abi`)).toBe('external'); expect(recoveryFiles().length).toBe(1);
  });
  it('keeps the content baseline through incremental library registration and runtime-only configuration changes', async () => {
    useRealLibraryLoader();
    await editor.loadLibrary('test-library', path);
    expect(await project.hasUnsavedChanges()).toBeFalse();
    field().setFieldValue('unsaved', 'TEXT'); runtime.updateBoardConfig({ next: true });
    expect(await project.hasUnsavedChanges()).toBeTrue();
    field().setFieldValue('saved', 'TEXT'); expect(await project.hasUnsavedChanges()).toBeFalse();
  });
  it('rejects in-flight runtime changes but permits a new query without requiring a needless save', async () => {
    (projectDataRuntime.flushPending as jasmine.Spy).and.callFake(async () => runtime.updateBoardConfig({ next: true }));
    await expectAsync(project.hasUnsavedChanges()).toBeRejectedWithError(/runtime changed/);
    (projectDataRuntime.flushPending as jasmine.Spy).and.resolveTo();
    expect(await project.hasUnsavedChanges()).toBeFalse();
  });
});
