import * as Blockly from 'blockly';
import 'blockly/blocks';
import { BehaviorSubject } from 'rxjs';
import {
  BlocklyProjectDocument, BlocklyProjectModelError, BlocklyRootClassifier,
  composeBlocklyPage, normalizeBlocklyOwnership, replaceBlocklyPageWorkspace,
} from '../../../editors/blockly-editor/services/blockly-project-model';
import { captureBlocklyRootClassifier } from '../../../editors/blockly-editor/services/blockly-root-role';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { BlocklyProjectCodePreparation } from '../../../editors/blockly-editor/services/prepared-project-code';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { AbsReferenceContractCache } from './abs-reference-contract-cache';
import { projectDataRuntime } from '@domain/project/public-api';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';

const root = (id: string, type = 'local') => ({ id, type });
const workspace = (...blocks: any[]) => ({ blocks: { languageVersion: 0, blocks } });
const source = (): BlocklyProjectDocument => ({
  schemaVersion: 3, activePageId: 'one', openedPageIds: ['one', 'two'],
  pages: [{ id: 'one', title: 'One', content: workspace() }, { id: 'two', title: 'Two', content: workspace() }],
  sharedModel: { procedureBlocks: [] },
});
const role: BlocklyRootClassifier = block => block.type === 'definition' ? 'definition' : block.type === 'call' ? 'call' : undefined;

describe('pure Blockly page/shared ownership', () => {
  it('normalizes sub-pixel pan noise identically on disk and live snapshots without touching other data', () => {
    const input = source();
    input.pages[0].viewState = { scale: 1.234567890123, scrollX: -1.1368683772161603e-13, scrollY: 123.123456789,
      future: 0.123456789 } as any;
    input.pages[0].content.blocks.blocks.push({ ...root('numeric'), fields: { VALUE: 0.123456789 } });
    const normalized = normalizeBlocklyOwnership(input);
    expect(normalized.pages[0].viewState).toEqual({ scale: 1.234567890123, scrollX: 0, scrollY: 123.123457, future: 0.123456789 } as any);
    expect(normalized.pages[0].content).toEqual(input.pages[0].content);
    expect(input.pages[0].viewState!.scrollX).not.toBe(0);
    expect(normalizeBlocklyOwnership(normalized)).toEqual(normalized);
  });
  it('still observes meaningful viewport edits as project revisions', () => {
    const input = source(), revision = new BlocklyProjectRevision();
    input.pages[0].viewState = { scale: 1, scrollX: 0, scrollY: 0 };
    const before = revision.observe(normalizeBlocklyOwnership(input));
    input.pages[0].viewState.scrollX = -1.1368683772161603e-13;
    expect(revision.observe(normalizeBlocklyOwnership(input))).toBe(before);
    input.pages[0].viewState.scrollX = 0.001;
    expect(revision.observe(normalizeBlocklyOwnership(input))).toBe(before + 1);
  });
  it('shares definitions, keeps calls page-owned, and never infers a role from a prefix', () => {
    const input = source();
    input.pages[0].content = workspace(root('d', 'definition'), root('c', 'call'), root('p', 'procedures_custom_local'));
    const result = normalizeBlocklyOwnership(input, role);
    expect(result.sharedModel.procedureBlocks.map(block => block.id)).toEqual(['d']);
    expect(result.pages[0].content.blocks.blocks.map(block => block.id)).toEqual(['c', 'p']);
    expect(input.pages[0].content.blocks.blocks.length).toBe(3);
    expect(composeBlocklyPage(result, 'two').blocks.blocks.map(block => block.id)).toEqual(['d']);
  });

  it('recovers an old shared call only when its page owner is proven', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [root('c', 'call')];
    const text = JSON.stringify(input);
    try { normalizeBlocklyOwnership(input, role); fail('Ambiguous ownership accepted'); }
    catch (error) {
      expect((error as BlocklyProjectModelError).code).toBe('BLOCKLY_SHARED_OWNER_REQUIRED');
      expect((error as BlocklyProjectModelError).blockIds).toEqual(['c']);
    }
    expect(JSON.stringify(input)).toBe(text);
    const explicit = normalizeBlocklyOwnership(input, role, { c: 'two' });
    expect(explicit.pages[1].content.blocks.blocks).toEqual([root('c', 'call')]);
    expect(explicit.sharedModel.procedureBlocks).toEqual([]);
    input.pages.splice(1); input.openedPageIds = ['one'];
    expect(normalizeBlocklyOwnership(input, role).pages[0].content.blocks.blocks).toEqual([root('c', 'call')]);
  });

  it('uses a matching existing page copy as ownership proof, rejecting divergent copies', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [root('c', 'call')];
    input.pages[1].content = workspace(root('c', 'call'));
    expect(normalizeBlocklyOwnership(input, role).pages[1].content.blocks.blocks.length).toBe(1);
    input.pages[1].content.blocks.blocks[0].data = 'different';
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/copies differ/);
    expect(() => normalizeBlocklyOwnership(input, role, { c: 'one' })).toThrowError(/owner/);
  });

  it('retains unknown existing shared roots until the runtime supplies a role', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [root('extension')];
    const result = normalizeBlocklyOwnership(input);
    expect(result.sharedModel.procedureBlocks).toEqual(input.sharedModel.procedureBlocks);
    expect(() => normalizeBlocklyOwnership(input, () => 'local')).toThrowError(/owner/);
  });

  it('merges variable models by ID, preserves unused/custom state, rejects conflicts', () => {
    const input = source();
    input.sharedModel.variables = [{ id: 'v', name: 'global', custom: { keep: true } }];
    input.pages[0].content.variables = [{ id: 'v', name: 'global', type: '', custom: { keep: true } }];
    input.pages[1].content.variables = [{ id: 'unused', name: 'Unused', type: 'Number' }];
    const result = normalizeBlocklyOwnership(input, role);
    expect(result.sharedModel.variables.map(model => model.id)).toEqual(['v', 'unused']);
    expect(result.sharedModel.variables[0].custom).toEqual({ keep: true });
    expect(result.pages.every(page => !Object.hasOwn(page.content, 'variables'))).toBeTrue();
    input.pages[0].content.variables[0].name = 'conflict';
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/Variable models/);
  });

  it('preserves full page/project/shared and workspace payloads over repeated composition/extraction', () => {
    const input = source();
    input['extension'] = { future: true };
    input.sharedModel['extension'] = { revision: 2 };
    input.sharedModel.variables = [{ id: 'v', name: 'Unused', type: '' }];
    input.sharedModel.procedureBlocks = [{ ...root('d', 'definition'), deletable: false, x: 32, data: 'opaque' }];
    input.pages[0]['extension'] = { retain: true };
    input.pages[0].content = { ...workspace({ ...root('c', 'call'), icons: { comment: { text: 'keep' } }, extraState: { nested: [1, 2] } }), customSerializer: { rows: ['large-data-reference'] } };
    input.pages[0].viewState = { scale: 1.2, scrollX: 20, scrollY: 40 };
    input.pages[1].content = workspace(root('other'));
    const text = JSON.stringify(input);
    let result = normalizeBlocklyOwnership(input, role);
    for (let round = 0; round < 3; round++) {
      for (const page of result.pages) result = replaceBlocklyPageWorkspace(result, page.id, composeBlocklyPage(result, page.id), role, page.viewState);
    }
    expect(result).toEqual(input);
    expect(JSON.stringify(input)).toBe(text);
  });

  it('replaces only the target page plus shared state; independent pages are detached and unchanged', () => {
    const input = source();
    input.pages[0].content = workspace(root('old'));
    input.pages[1].content = workspace(root('other'));
    input.sharedModel.procedureBlocks = [root('d', 'definition')];
    const next = workspace(root('d', 'definition'), root('new'));
    const result = replaceBlocklyPageWorkspace(input, 'one', next, role);
    expect(result.pages[0].content.blocks.blocks).toEqual([root('new')]);
    expect(result.pages[1]).toEqual(input.pages[1]);
    next.blocks.blocks[1].id = 'mutated';
    result.pages[1].title = 'detached';
    expect(result.pages[0].content.blocks.blocks[0].id).toBe('new');
    expect(input.pages[1].title).toBe('Two');
  });

  it('rejects cross-page identities including children and fallback shadows', () => {
    const input = source();
    input.pages[0].content = workspace(root('duplicate'));
    input.pages[1].content = workspace({ ...root('parent'), inputs: { VALUE: { block: root('actual'), shadow: root('duplicate') } } });
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/identity/);
    input.pages[1].content = workspace({ ...root('parent'), next: { block: root('duplicate') } });
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/identity/);
  });

  it('rejects malformed stored lists and conflicting shared definitions without silently emptying them', () => {
    const input = source();
    input.pages[1].content.blocks.blocks = 'invalid';
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/root block list/);
    input.pages[1].content = workspace({ ...root('d', 'definition'), data: 'other' });
    input.sharedModel.procedureBlocks = [root('d', 'definition')];
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/copies differ/);
    input.sharedModel.procedureBlocks = {} as any;
    expect(() => normalizeBlocklyOwnership(input, role)).toThrowError(/shared root block list/);
    expect(() => composeBlocklyPage(source(), 'missing')).toThrowError(/page/);
  });
});

describe('Blockly ownership capability capture', () => {
  it('uses native instances and static definition/call capabilities without probe construction', () => {
    const live = new Blockly.Workspace();
    try {
      const definition = live.newBlock('procedures_defnoreturn', 'd');
      const call = live.newBlock('procedures_callnoreturn', 'c');
      const local = live.newBlock('text', 't');
      const probe = spyOn(live, 'newBlock').and.callThrough();
      const classify = captureBlocklyRootClassifier(live, Blockly.Blocks);
      expect(classify(definition)).toBe('definition');
      expect(classify(call)).toBe('call');
      expect(classify(local)).toBe('local');
      expect(classify(root('not-loaded', 'procedures_callnoreturn'))).toBe('call');
      expect(classify(root('d', 'procedures_callnoreturn'))).toBe('call');
      expect(probe).not.toHaveBeenCalled();
    } finally { live.dispose(); }
  });

  it('recognizes model-backed roles but does not reuse instance state across captures', () => {
    const fake = { id: 'd', type: 'extension', getProcedureModel() {}, isProcedureDef: () => true };
    const live = { getAllBlocks: () => [fake] } as any;
    const first = captureBlocklyRootClassifier(live, {});
    fake.isProcedureDef = () => false;
    expect(first(fake)).toBe('definition');
    expect(captureBlocklyRootClassifier(live, {})(fake)).toBe('call');
    expect(captureBlocklyRootClassifier(null, {})(fake)).toBeUndefined();
  });
});


describe('Blockly service document boundary', () => {
  let service: BlocklyService;
  let internal: any;
  let live: Blockly.Workspace;
  beforeEach(() => {
    service = Object.create(BlocklyService.prototype);
    internal = service;
    live = new Blockly.Workspace();
    Object.assign(internal, {
      _workspace: live, projectDocumentSchemaVersion: 3, documentMetadata: {},
      projectRevision: new BlocklyProjectRevision(), workspaceEditGate: new BlocklyWorkspaceEditGate(),
      projectCodePreparation: new BlocklyProjectCodePreparation(),
      pageReferenceContracts: new AbsReferenceContractCache(),
      declarativeBlocks: new BlocklyDeclarativeBlockCatalog(),
      setAiWritingActive() {},
      pagesSubject: new BehaviorSubject([]), sharedModelSubject: new BehaviorSubject({ procedureBlocks: [] }),
      activePageIdSubject: new BehaviorSubject('one'), openedPageIdsSubject: new BehaviorSubject(['one']),
      selectedBlockSubject: new BehaviorSubject(null), selectedBlockIdsSubject: new BehaviorSubject([]),
      loadLibraryFinishedLoadingSubject: new BehaviorSubject(undefined),
      closeWorkspaceBlockSearch() {}, mountExternalToolbox() {},
      loadWorkspaceJson: state => Blockly.serialization.workspaces.load(state, live),
    });
    internal.applyProjectDocument(source());
  });
  afterEach(() => live.dispose());

  it('captures without publishing state and retains metadata even for a single-page save', () => {
    const input = source();
    input.pages.splice(1); input.openedPageIds = ['one'];
    input['extension'] = { keep: true }; input.pages[0]['extension'] = { future: 'page' };
    input.sharedModel['extension'] = { keep: 'shared' };
    internal.applyProjectDocument(input);
    live.newBlock('text', 't').setDeletable(false);
    const publish = spyOn(internal.pagesSubject, 'next').and.callThrough();
    const capture = service.getProjectDocument();
    expect(publish).not.toHaveBeenCalled();
    const saved = service.getProjectAbiForSave(capture);
    expect(saved.pages.length).toBe(1);
    expect(saved.pages[0].content.blocks.blocks[0].deletable).toBeFalse();
    expect(saved['extension']).toEqual(input['extension']);
    expect(saved.pages[0]['extension']).toEqual(input.pages[0]['extension']);
    expect(saved.sharedModel['extension']).toEqual(input.sharedModel['extension']);
    const reopened = service.normalizeProjectAbiForLoad(saved);
    expect(reopened).toEqual(saved);
    saved.pages[0].title = 'detached';
    expect(capture.pages[0].title).toBe('One');
  });

  it('does not discard page-local calls during normalization or change the active page to a missing ID', () => {
    const input = source();
    input.pages[0].content = workspace(root('c', 'procedures_callnoreturn'));
    expect(service.normalizeProjectAbi(input).pages[0].content.blocks.blocks).toEqual(input.pages[0].content.blocks.blocks);
    const publish = spyOn(internal.pagesSubject, 'next').and.callThrough();
    expect(service.switchPage('missing')).toBeFalse();
    expect(service.getActivePageId()).toBe('one');
    expect(publish).not.toHaveBeenCalled();
  });

  it('round trips native procedure definitions and page-owned calls across actual page switches', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [{ type: 'procedures_defnoreturn', id: 'd', fields: { NAME: 'work' }, deletable: false }];
    input.pages[0].content = workspace({ type: 'procedures_callnoreturn', id: 'c', extraState: { name: 'work' } });
    input.pages[1].content = workspace({ type: 'text', id: 't', fields: { TEXT: 'other page' } });
    service.loadProjectDocument(input);
    for (let round = 0; round < 3; round++) {
      expect(live.getBlockById('c')).toBeTruthy();
      expect(live.getBlockById('d')?.isDeletable()).toBeFalse();
      expect(service.switchPage('two')).toBeTrue();
      expect(live.getBlockById('c')).toBeNull();
      expect(live.getBlockById('t')?.getFieldValue('TEXT')).toBe('other page');
      expect(live.getBlockById('d')?.isDeletable()).toBeFalse();
      expect(service.switchPage('one')).toBeTrue();
    }
    const saved = service.getProjectDocument();
    expect(saved.sharedModel.procedureBlocks.map(block => block.id)).toEqual(['d']);
    expect(saved.pages[0].content.blocks.blocks.map(block => block.id)).toEqual(['c']);
    expect(saved.pages[1].content.blocks.blocks.map(block => block.id)).toEqual(['t']);
  });

  it('restores only the composed workspace without overwriting concurrent page metadata edits', () => {
    const input = source();
    input.pages[0].content = workspace({ type: 'text', id: 't', fields: { TEXT: 'original' }, deletable: false });
    input.pages[1].content = workspace({ type: 'text', id: 'other', fields: { TEXT: 'independent' } });
    service.loadProjectDocument(input);
    const snapshot = service.getProjectDocument();
    live.getBlockById('t')!.setFieldValue('imported', 'TEXT');
    service.renamePage('two', 'concurrent title');
    service.renamePage('one', 'new active title');
    service.restoreProjectWorkspaceSnapshot(snapshot);
    const result = service.getProjectDocument();
    expect(live.getBlockById('t')?.getFieldValue('TEXT')).toBe('original');
    expect(live.getBlockById('t')?.isDeletable()).toBeFalse();
    expect(result.pages[0].title).toBe('new active title');
    expect(result.pages[1].title).toBe('concurrent title');
    expect(result.pages[1].content).toEqual(snapshot.pages[1].content);
    service.switchPage('two');
    expect(() => service.restoreProjectWorkspaceSnapshot(snapshot)).toThrowError(/different page/);
    expect(service.getActivePageId()).toBe('two');
  });

  it('compares saved/reopened documents semantically despite metadata key insertion order', () => {
    live.newBlock('text', 't');
    const saved = service.getProjectAbiForSave();
    const disk = JSON.stringify(saved);
    internal.applyProjectDocument(service.normalizeProjectAbiForLoad(saved));
    const oldFiles = window['fs'];
    window['fs'] = { readFileSync: () => disk };
    try {
      const project = new _ProjectService(service, {} as any, {} as any);
      project.currentProjectPath = 'D:/project';
      expect(project.hasUnsavedChanges()).toBeFalse();
      service.renamePage('two', 'changed');
      expect(project.hasUnsavedChanges()).toBeTrue();
    } finally { window['fs'] = oldFiles; }
  });

  it('normalizes legacy workspace payloads without retaining the schema marker as a serializer', () => {
    const saved = service.getProjectAbiForSave(source());
    const legacy = { ...workspace(root('c', 'procedures_callnoreturn')), $ailyProjectData: saved.$ailyProjectData, customSerializer: { keep: true } };
    const result = service.normalizeProjectAbiForLoad(legacy);
    expect(result.pages[0].content.blocks.blocks).toEqual(legacy.blocks.blocks);
    expect(result.pages[0].content.customSerializer).toEqual(legacy.customSerializer);
    expect(result.pages[0].content.$ailyProjectData).toBeUndefined();
  });

  it('blocks page/load mutations during a lease without changing serialized protection flags', () => {
    live.newBlock('text', 't').setDeletable(false);
    const snapshot = service.captureProjectSnapshot();
    const serialized = Blockly.serialization.workspaces.save(live);
    const lease = service.acquireWorkspaceEditLease();
    try {
      for (const operation of [() => service.switchPage('two'), () => service.renamePage('two', 'changed'),
        () => service.createPage(), () => service.openPage('two'), () => service.closePage('one'),
        () => service.loadProjectDocument(snapshot.document), () => service.captureProjectSnapshot()]) {
        expect(operation).toThrowMatching(error => error.code === 'BLOCKLY_EDIT_BUSY');
      }
      expect(Blockly.serialization.workspaces.save(live)).toEqual(serialized);
      expect(service.captureProjectSnapshot(lease).revision).toBe(snapshot.revision);
      live.getBlockById('t')!.setFieldValue('host candidate', 'TEXT');
      expect(service.getProjectPersistenceRevision()).toBe(snapshot.revision);
      service.restoreProjectWorkspaceSnapshot(snapshot.document, lease);
      expect(Blockly.serialization.workspaces.save(live)).toEqual(serialized);
    } finally { lease.release(); }
    expect(() => service.renamePage('two', 'allowed')).not.toThrow();
  });

  it('rejects destructive shared edits before native load when other-page contracts are unavailable', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [{ type: 'procedures_defnoreturn', id: 'd', fields: { NAME: 'work' } }];
    input.pages[1].content = workspace({ type: 'procedures_callnoreturn', id: 'c', extraState: { name: 'work' } });
    service.loadProjectDocument(input);
    const before = service.getProjectDocument();
    expect(() => service.assertWorkspaceSharedChange(before, workspace())).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    expect(live.getBlockById('d')).toBeTruthy();
    expect(service.getProjectDocument()).toEqual(before);
  });

  const loadVisitedReferencePage = () => {
    const input = source();
    input.sharedModel.variables = [{ id: 'v', name: 'Value', type: '' }, { id: 'unused', name: 'Unused', type: '' }];
    input.pages[0].content = workspace({ type: 'text', id: 'text', fields: { TEXT: 'one' } });
    input.pages[1].content = workspace({ type: 'variables_get', id: 'get', fields: { VAR: { id: 'v' } } });
    service.loadProjectDocument(input);
    service.switchPage('two'); service.switchPage('one');
    return service.getProjectDocument();
  };
  it('uses actual visited-page contracts to allow unused model removal and reject lost live references', () => {
    const before = loadVisitedReferencePage();
    const candidate = composeBlocklyPage(before, 'one');
    candidate.variables = candidate.variables.filter(model => model.id !== 'unused');
    expect(() => service.assertWorkspaceSharedChange(before, candidate)).not.toThrow();
    candidate.variables = [];
    expect(() => service.assertWorkspaceSharedChange(before, candidate)).toThrowMatching(error => error.code === 'ABS_SYMBOL_MISSING');
    expect(service.getProjectDocument()).toEqual(before);
  });

  it('permits unused shared-definition deletion, but does not reuse an instance contract for a changed definition', () => {
    const input = source();
    input.sharedModel.procedureBlocks = [{ type: 'procedures_defnoreturn', id: 'd', fields: { NAME: 'unused' } }];
    input.pages[1].content = workspace({ type: 'text', id: 't', fields: { TEXT: 'other' } });
    service.loadProjectDocument(input); service.switchPage('two'); service.switchPage('one');
    const before = service.getProjectDocument();
    const candidate = composeBlocklyPage(before, 'one');
    candidate.blocks.blocks[0].fields.NAME = 'changed';
    expect(() => service.assertWorkspaceSharedChange(before, candidate)).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    candidate.blocks.blocks = [];
    expect(() => service.assertWorkspaceSharedChange(before, candidate)).not.toThrow();
  });

  it('invalidates visited-page evidence when a library is registered or the data runtime changes', () => {
    const before = loadVisitedReferencePage();
    const candidate = composeBlocklyPage(before, 'one'); candidate.variables.pop();
    service.loadLibBlocks([], null);
    expect(() => service.assertWorkspaceSharedChange(before, candidate)).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    service.switchPage('two'); service.switchPage('one');
    expect(() => service.assertWorkspaceSharedChange(service.getProjectDocument(), candidate)).not.toThrow();
    spyOn(projectDataRuntime, 'getSessionToken').and.returnValue('different-data-session');
    expect(() => service.assertWorkspaceSharedChange(service.getProjectDocument(), candidate)).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
  });

  it('keeps ordinary page loading available for unadapted state without granting shared-edit permission', () => {
    const type = 'abs_uncovered_page';
    Blockly.Blocks[type] = { init() {}, saveExtraState: () => ({ foreignModelId: 'hidden' }), loadExtraState() {} };
    try {
      const input = source(); input.sharedModel.variables = [{ id: 'unused', name: 'Unused', type: '' }];
      input.pages[1].content = workspace({ type, id: 'custom', extraState: { foreignModelId: 'hidden' } });
      service.loadProjectDocument(input);
      expect(() => { service.switchPage('two'); service.switchPage('one'); }).not.toThrow();
      const before = service.getProjectDocument(); const candidate = composeBlocklyPage(before, 'one'); candidate.variables = [];
      expect(() => service.assertWorkspaceSharedChange(before, candidate)).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    } finally { delete Blockly.Blocks[type]; }
  });

  it('does not permit library registration to bypass an active workspace lease', async () => {
    const lease = service.acquireWorkspaceEditLease();
    try {
      expect(() => service.loadLibBlocks([], null)).toThrowMatching(error => error.code === 'BLOCKLY_EDIT_BUSY');
      expect(() => service.loadLibGenerator('never-read.js')).toThrowMatching(error => error.code === 'BLOCKLY_EDIT_BUSY');
      await expectAsync(service.loadLibrary('never-read', 'D:/project')).toBeRejected();
    } finally { lease.release(); }
  });

  for (const mutation of ['workspace', 'metadata', 'registry']) {
    it(`does not publish an older page snapshot when a contract getter changes ${mutation}`, () => {
      const type = 'abs_mutating_contract_getter';
      Blockly.Blocks[type] = { init() { this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'a']]), 'MODE'); } };
      try {
        const input = source(); input.pages[0].content = workspace({ type, id: 'changing', fields: { MODE: 'a' } });
        service.loadProjectDocument(input);
        const block = live.getBlockById('changing')!;
        spyOn(block.getField('MODE') as Blockly.FieldDropdown, 'getOptions').and.callFake(() => {
          if (mutation === 'workspace') { block.data = 'new data'; throw new Error('provider threw after mutation'); }
          if (mutation === 'metadata') service.renamePage('two', 'latest title');
          if (mutation === 'registry') service.loadLibBlocks([], null);
          return [['A', 'a']];
        });
        expect(() => service.switchPage('two')).toThrow();
        expect(service.getActivePageId()).toBe('one');
        expect(live.getBlockById('changing')).toBe(block);
        if (mutation === 'metadata') expect(service.getProjectDocument().pages[1].title).toBe('latest title');
        if (mutation === 'workspace') expect(block.data).toBe('new data');
        expect(internal.pageReferenceContracts.matching(service.getProjectDocument())['one']).toBeUndefined();
      } finally { delete Blockly.Blocks[type]; }
    });
  }

  it('keeps quarantine until workspace activation changes and does not let old cleanup unlock a new lease', () => {
    const old = service.acquireWorkspaceEditLease();
    old.quarantine('restore failed'); old.release();
    expect(() => service.captureProjectSnapshot()).toThrow();
    const nextWorkspace = new Blockly.Workspace();
    internal.workspaceReadySubject = new BehaviorSubject(live);
    internal.syncSerialDynamicToolboxBlocks = () => undefined;
    try {
      service.workspace = nextWorkspace as any;
      expect(() => service.assertWorkspaceEditAvailable()).not.toThrow();
      const next = service.acquireWorkspaceEditLease();
      old.release();
      expect(() => next.assertCurrent()).not.toThrow();
      expect(() => service.captureProjectSnapshot()).toThrow();
      next.release();
      expect(() => service.captureProjectSnapshot()).not.toThrow();
    } finally { nextWorkspace.dispose(); }
  });
});
