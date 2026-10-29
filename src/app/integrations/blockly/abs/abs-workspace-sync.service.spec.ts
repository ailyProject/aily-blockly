import { decodeAbsState, splitAbsState } from './abs-full-state';
import * as Blockly from 'blockly';
import { NgZone } from '@angular/core';
import 'blockly/blocks';
import '../../../editors/blockly-editor/components/blockly/plugins/block-plus-minus/src/index.js';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { AbsBaselineStore, AbsSyncStoragePort, AbsSyncStorageAccess, absBaselineKey } from './abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText, indexAbsSyntax } from './abs-identity-map';
import { parseAbsSyntax } from './abs-syntax';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { composeBlocklyPage, replaceBlocklyPageWorkspace } from '../../../editors/blockly-editor/services/blockly-project-model';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { createAilyProjectDataValue, createProjectDataMarker, materializeGenericProjectDataValues, normalizeProjectDataDocument, projectDataRuntime } from '@domain/project/public-api';
import { bindAbsLoadNormalizationReadback, prepareAbsLoadNormalization } from './abs-load-normalization';
import { SerialOperationQueue } from '@shared/public-api';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { NATIVE_CANDIDATE_LIMITS } from '../../../editors/blockly-editor/services/blockly-native-budget';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { BlocklyEditorAutomationAdapter } from '../blockly-editor-automation.adapter';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { nativeReconciliationDefinition, nativeReconciliationSteps } from './abs-native-reconciliation.fixture';
import { nativeFieldOrder } from './abs-native-field-order';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { observeNativeBlockDefinition } from '../../../editors/blockly-editor/services/blockly-native-structure';
import { AbsBlockContextIndex } from './abs-block-context';
import { nativeDefaultSource } from './abs-native-defaults.fixture';
import { nativeDormantSource } from './abs-native-shadows.fixture';
import { modelDefinitions, modelSource } from './abs-native-models.fixture';
import '../../../editors/blockly-editor/components/blockly/custom-field/field-u8g2-bitmap';

describe('v2 actual workspace generation coordinator', () => {
  let originalTimeout: number;
  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    // One coordinator case may validate, apply, reshape and reopen through
    // several isolated candidates. Keep each product deadline unchanged.
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
  });
  afterAll(() => { jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout; });
  let service: AbsWorkspaceSyncService, project: _ProjectService, editor: any;
  let disk: Map<string, string>, values: Map<string, any>;
  let port: AbsSyncStoragePort, gate: BlocklyWorkspaceEditGate;
  let catalog: BlocklyDeclarativeBlockCatalog;
  let failWrite: string | undefined, loseCommitReply: boolean, held: boolean;
  let originalMathNumber: any;
  let oldBlockly: unknown, oldFs: unknown, container: HTMLDivElement | undefined;
  const registeredTypes: string[] = [];
  const declare = (definition: any) => {
    Blockly.defineBlocksWithJsonArray([definition]); catalog.record(definition, Blockly.Blocks[definition.type]);
    registeredTypes.push(definition.type);
  };
  const scope = { projectKey: 'D:/project', pageId: 'main' };
  const nativeState = () => normalizeAbsSerializedWorkspace(Blockly.serialization.workspaces.save(editor.workspace));
  const seed = () => ({ blocks: { languageVersion: 0, blocks: [{ type: 'abs_sync_root', id: 'protected', x: 30, y: 60,
    deletable: false, movable: false, data: 'opaque', fields: { TEXT: 'before' }, inputs: { VALUE: {
      shadow: { type: 'math_number', id: 'dormant', fields: { NUM: 2 } },
      block: { type: 'math_number', id: 'child', fields: { NUM: 1 } },
    } } }] } });
  const baseline = async () => {
    expect((await service.exportGeneration()).publication.status).toBe('COMMITTED');
    editor.prepareProjectCode.calls.reset();
    (project.publishPreparedSaveOutputs as jasmine.Spy).calls.reset();
    return { source: disk.get('project.abs')!, generation: JSON.parse(disk.get('project.abs.map.json')!).generation };
  };
  const apply = (base: Awaited<ReturnType<typeof baseline>>, options = {}) => service.applyGeneration(
    base.source.replace('TEXT="before"', 'TEXT="after"'), base.generation, options);
  const roots = () => editor.workspace.getBlockById('protected');
  const renderWorkspace = () => {
    editor.workspace.dispose(); container = document.createElement('div'); container.style.cssText = 'width:600px;height:400px';
    document.body.appendChild(container); editor.workspace = Blockly.inject(container, {});
    Blockly.serialization.workspaces.load(seed(), editor.workspace);
  };

  beforeEach(() => {
    oldBlockly = window['Blockly']; oldFs = window['fs']; window['Blockly'] = Blockly;
    Blockly.Blocks['abs_sync_root'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput(''), 'TEXT');
      this.appendValueInput('VALUE').setCheck('Number');
    } };
    disk = new Map(); values = new Map(); failWrite = undefined; loseCommitReply = false; held = false;
    const read = async key => disk.get(key) ?? null;
    const access: AbsSyncStorageAccess = {
      read, replace: async (key, expected, content) => {
        expect(held).toBeTrue();
        if (key === failWrite || failWrite === 'recoveries/*' && key.startsWith('recoveries/')) throw new Error('injected write failure');
        const before = await read(key);
        if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
        if (content === null) disk.delete(key); else disk.set(key, content);
        return true;
      },
    };
    const locks = new SerialOperationQueue();
    port = { read, withLock: operation => locks.run(async () => {
      held = true;
      try {
        const result = await operation(access);
        if (loseCommitReply && (result as any)?.status === 'COMMITTED') throw new Error('lost commit acknowledgement');
        return result;
      } finally { held = false; }
    }) };
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (_path, assertCurrent) => {
      expect(assertCurrent()).withContext('Native storage callbacks must be synchronous and return void').toBeUndefined();
      const guardedRead = async key => { assertCurrent(); const value = await port.read(key); assertCurrent(); return value; };
      return { read: guardedRead, withLock: operation => port.withLock(locked => new Promise((resolve, reject) => {
        assertCurrent();
        operation({
          read: async key => { assertCurrent(); const value = await locked.read(key); assertCurrent(); return value; },
          replace: async (key, expected, content) => {
            assertCurrent(); const value = await locked.replace(key, expected, content); assertCurrent(); return value;
          },
        }, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), { code: result.error.code })));
      })) };
    } };
    gate = new BlocklyWorkspaceEditGate(); const queue = new SerialOperationQueue(); const revisions = new BlocklyProjectRevision();
    let document: any = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'Main', content: { blocks: { blocks: [] } } },
        { id: 'other', title: 'Other', content: { blocks: { blocks: [] } }, custom: { preserved: true } }],
      sharedModel: { procedureBlocks: [] }, metadata: 'retained' };
    editor = {
      blockTypeToLibMap: new Map(),
      captureDeclarativeBlockDefinitions: () => catalog.capture(Blockly.Blocks),
      workspace: new Blockly.Workspace(),
      getActivePageId: () => document.activePageId,
      runProjectOperation: operation => queue.run(() => { gate.assertAvailable(); return operation(); }),
      acquireWorkspaceEditLease: () => gate.acquire(),
      assertWorkspaceEditAvailable: owner => gate.assertAvailable(owner),
      captureProjectSnapshot: owner => {
        gate.assertAvailable(owner);
        const current = replaceBlocklyPageWorkspace(document, document.activePageId, nativeState(), () => undefined);
        return { document: current, revision: revisions.observe(current) };
      },
      getProjectAbiForSave: snapshot => snapshot,
      normalizeProjectAbi: snapshot => snapshot,
      normalizeProjectAbiForLoad: snapshot => snapshot,
      getWorkspaceLoadReadbackView: state => state,
      loadProjectDocument: (snapshot, _clone, owner) => {
        gate.assertAvailable(owner); document = JSON.parse(absJson(snapshot));
        const state = composeBlocklyPage(document, document.activePageId);
        const definitions = editor.captureDeclarativeBlockDefinitions();
        withNativeStateLoading(Blockly, editor.workspace, state,
          () => Blockly.serialization.workspaces.load(state, editor.workspace), block => nativeFieldOrder(block, definitions));
      },
      setViewState: viewState => { document.pages[0].viewState = viewState; },
      mutateOtherPage: () => { document.pages[1].custom.preserved = false; },
      switchPage: id => {
        document = replaceBlocklyPageWorkspace(document, document.activePageId, nativeState(), () => undefined);
        document.activePageId = id;
        Blockly.serialization.workspaces.load(composeBlocklyPage(document, id), editor.workspace);
      },
      assertWorkspaceSharedChange: jasmine.createSpy('shared'),
      restoreProjectWorkspaceSnapshot: jasmine.createSpy('restore').and.callFake((snapshot, owner) => {
        gate.assertAvailable(owner); document = JSON.parse(absJson(snapshot));
        const state = composeBlocklyPage(document, document.activePageId);
        const definitions = editor.captureDeclarativeBlockDefinitions();
        withNativeStateLoading(Blockly, editor.workspace, state,
          () => Blockly.serialization.workspaces.load(state, editor.workspace), block => nativeFieldOrder(block, definitions));
      }),
      prepareProjectCode: jasmine.createSpy('prepareCode').and.callFake(async (_assertCurrent, owner) => ({
        revision: editor.captureProjectSnapshot(owner).revision, code: '', artifacts: null, blockCodeMapText: null,
      })),
      markWorkspaceCodeDirty: jasmine.createSpy('dirty'),
      requestWorkspaceVisualRefresh: jasmine.createSpy('visualRefresh'),
      publishAbsContext: jasmine.createSpy('publishAbsContext'),
      describeCommittedAbsSyntax: jasmine.createSpy('describeCommittedAbsSyntax').and.returnValue(undefined),
    };
    Blockly.serialization.workspaces.load(seed(), editor.workspace);
    project = new _ProjectService(editor, {} as any, {} as any); project.currentProjectPath = scope.projectKey;
    spyOn(project, 'publishPreparedSaveOutputs').and.callFake(async (_path, _prepared, _generated, guard) => {
      expect(guard()).toBeUndefined();
    });
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
    spyOn(projectDataRuntime, 'getStore').and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }),
      flushPending: async () => {}, put: request => projectDataRuntime.put(request), resolve: ref => projectDataRuntime.resolve(ref) } as any);
    spyOn(projectDataRuntime, 'put').and.callFake(async request => {
      const id = await hashAbsText(request.codec + ':' + absJson(request.value));
      const size = new TextEncoder().encode(typeof request.value === 'string' ? request.value : absJson(request.value)).length;
      const ref: any = { $ailyData: { schemaVersion: 1, id, codec: request.codec, logicalType: request.codec === 'utf8-v1' ? 'text' : 'json',
        storage: 'raw-v1', rawLength: size, storedLength: size } };
      values.set(id, request.value); return ref;
    });
    spyOn(projectDataRuntime, 'resolve').and.callFake(async ref => {
      if (!values.has(ref.$ailyData.id)) throw new Error('missing resource');
      return values.get(ref.$ailyData.id);
    });
    service = new AbsWorkspaceSyncService(editor, project);
    catalog = new BlocklyDeclarativeBlockCatalog();
    const definition = { type: 'abs_declared_text', message0: '%1 %2', args0: [
      { type: 'field_input', name: 'TEXT', text: 'default' }, { type: 'field_checkbox', name: 'FLAG', checked: true },
    ], output: 'String' };
    declare(definition);
  });
  afterEach(() => {
    editor.workspace.dispose(); container?.remove(); container = undefined;
    if (originalMathNumber) { Blockly.Blocks['math_number'] = originalMathNumber; originalMathNumber = undefined; }
    delete Blockly.Blocks['abs_sync_root']; window['Blockly'] = oldBlockly; window['fs'] = oldFs;
    for (const type of registeredTypes.splice(0)) delete Blockly.Blocks[type];
    if (Blockly.Extensions.isRegistered('native_commit_extension')) Blockly.Extensions.unregister('native_commit_extension');
  });

  const priorityApply = async (base: Awaited<ReturnType<typeof baseline>>, source: string) => {
    const store = new AbsBaselineStore(port, scope), committed = (await store.loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(),
      base: (await generationEvidence(committed, disk.get('project.abi')!)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength },
      concurrentEdits: 'request-priority' as const, intentGeneration: base.generation };
    const validation = await service.validateGeneration(source, request);
    return service.applyGeneration(source, request.base.generation, {}, validation);
  };

  for (const choice of ['keep_view', 'replace_view'] as const) {
    it(`resolves a true disk/view conflict using ${choice}, archiving both versions before replacement`, async () => {
      await baseline();
      const source = JSON.parse(disk.get('project.abi')!);
      source.pages[0].content.blocks.blocks[0].fields.TEXT = 'external';
      const external = JSON.stringify(source); disk.set('project.abi', external);
      roots().setFieldValue('local', 'TEXT');
      const before = editor.captureProjectSnapshot().document;
      const originalMap = disk.get('project.abs.map.json'), originalAbs = disk.get('project.abs');
      const offer = await service.inspectViewConflict();
      const result = await service.resolveViewConflict(choice, offer.token);
      expect(result.publication.status).toBe('COMMITTED'); expect(result.requiresReload).toBeFalse();
      expect(result.refreshed).toBe(choice === 'replace_view');
      expect(roots().getFieldValue('TEXT')).toBe(choice === 'replace_view' ? 'external' : 'local');
      const saved = JSON.parse(disk.get('project.abi')!);
      expect(saved.pages[0].content.blocks.blocks[0].fields.TEXT).toBe(choice === 'replace_view' ? 'external' : 'local');
      expect(saved.pages[1]).toEqual(source.pages[1]); expect(roots().isDeletable()).toBeFalse();
      const archive = JSON.parse(disk.get(result.recoveryArchive!.key)!);
      expect(archive.disk.abi).toBe(external); expect(archive.disk.abs).toBe(originalAbs);
      expect(archive.disk.map).toBe(originalMap); expect(JSON.parse(archive.workspace)).toEqual(before);
      expect(project.publishPreparedSaveOutputs).toHaveBeenCalledWith(scope.projectKey, jasmine.anything(), jasmine.anything(),
        jasmine.any(Function), { preserveSuperseded: true });
    });
  }

  for (const change of ['disk', 'field', 'viewport', 'pointer']) it(`rejects a stale view choice after ${change} changes`, async () => {
    await baseline();
    const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source));
    const offer = await service.inspectViewConflict();
    if (change === 'disk') disk.set('project.abi', disk.get('project.abi')! + ' ');
    if (change === 'field') roots().setFieldValue('new edit', 'TEXT');
    if (change === 'viewport') editor.setViewState({ scale: 2, scrollX: 9, scrollY: 3 });
    if (change === 'pointer') disk.set('committed.json', disk.get('committed.json')! + ' ');
    const files = [...disk], view = editor.captureProjectSnapshot().document;
    await expectAsync(service.resolveViewConflict('replace_view', offer.token)).toBeRejected();
    expect([...disk]).toEqual(files); expect(editor.captureProjectSnapshot().document).toEqual(view);
  });

  for (const choice of ['keep_view', 'replace_view'] as const) it(`preserves a viewport change during ${choice} archival instead of consuming the old offer`, async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source)); const offer = await service.inspectViewConflict(), files = [...disk];
    const archive = AbsBaselineStore.prototype.archiveRepair;
    spyOn(AbsBaselineStore.prototype, 'archiveRepair').and.callFake(function (...args) {
      editor.setViewState({ scale: 1.8, scrollX: 26, scrollY: 44 });
      return archive.apply(this, args);
    });
    await expectAsync(service.resolveViewConflict(choice, offer.token)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_VIEW_CONFLICT_STALE' }));
    expect([...disk]).toEqual(files);
    expect(editor.captureProjectSnapshot().document.pages[0].viewState).toEqual({ scale: 1.8, scrollX: 26, scrollY: 44 });
  });

  it('does not change either version when conflict archival fails', async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source)); roots().setFieldValue('local', 'TEXT');
    const offer = await service.inspectViewConflict(), files = [...disk], view = editor.captureProjectSnapshot().document;
    failWrite = 'recoveries/*';
    await expectAsync(service.resolveViewConflict('replace_view', offer.token)).toBeRejected();
    expect([...disk]).toEqual(files); expect(editor.captureProjectSnapshot().document).toEqual(view);
  });

  it('restores the whole previous view if accepting the saved source fails before commit', async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source)); roots().setFieldValue('local', 'TEXT');
    const offer = await service.inspectViewConflict(), files = { abi: disk.get('project.abi'), abs: disk.get('project.abs'), map: disk.get('project.abs.map.json') };
    const view = editor.captureProjectSnapshot().document;
    editor.prepareProjectCode.and.rejectWith(new Error('generation failed'));
    await expectAsync(service.resolveViewConflict('replace_view', offer.token)).toBeRejectedWith(jasmine.objectContaining({
      message: 'generation failed', applicationStatus: 'ROLLED_BACK',
    }));
    expect(editor.captureProjectSnapshot().document).toEqual(view);
    expect(disk.get('project.abi')).toBe(files.abi); expect(disk.get('project.abs')).toBe(files.abs); expect(disk.get('project.abs.map.json')).toBe(files.map);
    expect(() => gate.assertAvailable()).not.toThrow();
  });

  it('can explicitly accept the saved project active page without rebinding an old candidate', async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!);
    source.activePageId = 'other'; source.openedPageIds = ['main', 'other'];
    disk.set('project.abi', JSON.stringify(source));
    const offer = await service.inspectViewConflict();
    const result = await service.resolveViewConflict('replace_view', offer.token);
    expect(result.publication.status).toBe('COMMITTED');
    expect(editor.getActivePageId()).toBe('other'); expect(result.evidence!.binding.scope.pageId).toBe('other');
    expect(JSON.parse(disk.get('project.abi')!).pages[0]).toEqual(source.pages[0]);
  });

  for (const choice of ['keep_view', 'replace_view'] as const) it(`observes completed ${choice} after lost reply/restart without replaying native work`, async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source)); roots().setFieldValue('local', 'TEXT');
    const offer = await service.inspectViewConflict(); loseCommitReply = true;
    await expectAsync(service.resolveViewConflict(choice, offer.token)).toBeRejected();
    loseCommitReply = false;
    expect(() => gate.assertAvailable()).not.toThrow();
    service = new AbsWorkspaceSyncService(editor, project);
    const known = await service.inspectGeneration();
    expect((known as any).completedResolution.token).toBe(offer.token);
    const files = [...disk], before = editor.captureProjectSnapshot().document;
    const remember = spyOn(project, 'rememberLoadedProject').and.stub();
    editor.prepareProjectCode.and.throwError('Observation must not generate');
    const result = await service.resolveViewConflict(choice, offer.token, true);
    expect(result.publication.status).toBe('COMMITTED'); expect(result.refreshed).toBe(choice === 'replace_view');
    expect(result.derivedOutputs?.published).toBeFalse(); // New host cannot invent the old output observation.
    expect([...disk]).toEqual(files); expect(editor.captureProjectSnapshot().document).toEqual(before);
    expect(remember).toHaveBeenCalledTimes(1);
    editor.setViewState({ scale: 2, scrollX: 10, scrollY: 5 });
    await expectAsync(service.resolveViewConflict(choice, offer.token, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_VIEW_RESOLUTION_UNOBSERVED' }));
    expect(remember).toHaveBeenCalledTimes(1); expect([...disk]).toEqual(files);
  });

  it('never uses observation mode to execute a not-yet-committed conflict choice', async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source)); const offer = await service.inspectViewConflict(), files = [...disk];
    await expectAsync(service.resolveViewConflict('keep_view', offer.token, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_VIEW_RESOLUTION_UNOBSERVED' }));
    expect([...disk]).toEqual(files);
  });

  it('does not acknowledge a viewport settling after the full completed-state comparison', async () => {
    await baseline(); const source = JSON.parse(disk.get('project.abi')!); source.metadata = 'external';
    disk.set('project.abi', JSON.stringify(source));
    const offer = await service.inspectViewConflict(); await service.resolveViewConflict('keep_view', offer.token);
    const files = [...disk], remember = spyOn(project, 'rememberLoadedProject').and.stub();
    const read = port.read; let abiReads = 0;
    spyOn(port, 'read').and.callFake(async key => {
      const result = await read(key);
      // inspectAbsGeneration reads the input and verifies it a second time.
      // The next ABI observation is assertDisk, after full saved-state equality.
      if (key === 'project.abi' && ++abiReads === 3) editor.setViewState({ scale: 1.7, scrollX: 22, scrollY: 33 });
      return result;
    });
    await expectAsync(service.resolveViewConflict('keep_view', offer.token, true)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_VIEW_RESOLUTION_OBSERVATION_STALE' }));
    expect(remember).not.toHaveBeenCalled(); expect([...disk]).toEqual(files);
  });

  it('Save As commits a new destination generation without saving or acknowledging the source', async () => {
    await baseline();
    roots().setFieldValue('copy-edit', 'TEXT');
    editor.publishAbsContext.calls.reset();
    const originalDisk = [...disk];
    const copy = new Map(disk);
    const oldPath = window['path'];
    const sourceOpen = window['fs'].openProjectSyncStorage;
    window['path'] = { resolve: value => value, join: (...parts) => parts.join('/') };
    window['fs'].openProjectSyncStorage = async (path, guard) => {
      expect(guard()).toBeUndefined();
      if (path !== 'D:/copy') return sourceOpen(path, guard);
      return {
        read: async key => copy.get(key) ?? null,
        withLock: operation => new Promise((resolve, reject) => operation({
          read: async key => copy.get(key) ?? null,
          replace: async (key, expected, content) => {
            guard();
            const value = copy.get(key) ?? null;
            if ((value === null ? null : await hashAbsText(value)) !== expected) return false;
            if (content === null) copy.delete(key); else copy.set(key, content);
            return true;
          },
        }, result => result.ok ? resolve(result.value) : reject(new Error(result.error.message)))),
      };
    };
    spyOn(project, 'publishCopyOutputs').and.resolveTo();
    let snapshot;
    try {
      snapshot = await service.prepareCopy();
      expect(gate.busy).toBeTrue();
      await snapshot.write('D:/copy');
      await snapshot.assertCurrent();
      expect([...disk]).toEqual(originalDisk);
      expect(copy.get('project.abi')).toContain('copy-edit');
      expect(copy.get('project.abs')).toContain('copy-edit');
      const map = JSON.parse(copy.get('project.abs.map.json')!);
      expect(map.scope.projectKey).toBe('D:/copy');
      expect(JSON.parse(copy.get('committed.json')!).generation).toBe(map.generation);
      expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
      expect(editor.publishAbsContext).not.toHaveBeenCalled();
    } finally { snapshot?.release(); window['path'] = oldPath; }
    expect(gate.busy).toBeFalse();
  });

  it('automatically prefers the AI field while retaining unrelated live fields and comments', async () => {
    renderWorkspace();
    const base = await baseline();
    roots().setFieldValue('user overlaps', 'TEXT');
    editor.workspace.getBlockById('child').setFieldValue('1337', 'NUM');
    roots().setCommentText('user unrelated comment');
    const result = await priorityApply(base, base.source.replace('TEXT="before"', 'TEXT="AI result"'));
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('AI result');
    expect(editor.workspace.getBlockById('child').getFieldValue('NUM')).toBe(1337);
    expect(roots().getCommentText()).toBe('user unrelated comment');
    expect(await decodeAbsState(disk.get('project.abs')!)).toBeTruthy();
  });

  it('keeps an unrelated user root when applying the request delta', async () => {
    const base = await baseline();
    editor.workspace.newBlock('math_number', 'user-added').setFieldValue('99', 'NUM');
    const result = await priorityApply(base, base.source.replace('TEXT="before"', 'TEXT="AI result"'));
    expect(result.publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById('user-added').getFieldValue('NUM')).toBe(99);
    expect(roots().getFieldValue('TEXT')).toBe('AI result');
  });

  it('restores the request dependency connection when the user disconnects the AI-edited input', async () => {
    const base = await baseline();
    editor.workspace.getBlockById('child').outputConnection.disconnect();
    const source = base.source.replace(/math_number\((?:NUM=)?1\)/, 'math_number(NUM=7)');
    expect(source).not.toBe(base.source);
    const result = await priorityApply(base, source);
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getInputTargetBlock('VALUE').id).toBe('child');
    expect(roots().getInputTargetBlock('VALUE').getFieldValue('NUM')).toBe(7);
  });

  it('restores a deleted AI-edited stack without removing unrelated user roots', async () => {
    originalMathNumber = Blockly.Blocks['math_number'];
    Blockly.Blocks['math_number'] = { ...originalMathNumber };
    catalog.record({ type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' }, Blockly.Blocks['math_number']);
    declare({ type: 'abs_sync_root', message0: '%1 %2', args0: [
      { type: 'field_input', name: 'TEXT', text: '' }, { type: 'input_value', name: 'VALUE', check: 'Number' } ] });
    const base = await baseline();
    roots().dispose(false);
    editor.workspace.newBlock('math_number', 'user-added').setFieldValue('99', 'NUM');
    const result = await priorityApply(base, base.source.replace('"before"', '"AI result"'));
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('AI result');
    expect(roots().getInputTargetBlock('VALUE').id).toBe('child');
    expect(editor.workspace.getBlockById('user-added').getFieldValue('NUM')).toBe(99);
  });

  it('retains a displaced user block as a loose root when restoring an AI input', async () => {
    const base = await baseline();
    editor.workspace.getBlockById('child').outputConnection.disconnect();
    const added = editor.workspace.newBlock('math_number', 'user-replacement');
    added.setFieldValue('99', 'NUM');
    roots().getInput('VALUE').connection.connect(added.outputConnection);
    const source = base.source.replace(/math_number\((?:NUM=)?1\)/, 'math_number(NUM=7)');
    const result = await priorityApply(base, source);
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getInputTargetBlock('VALUE').id).toBe('child');
    const retained = editor.workspace.getBlockById('user-replacement');
    expect(retained.getFieldValue('NUM')).toBe(99);
    expect(retained.getParent()).toBeNull();
  });

  it('merges a concurrent disk draft and live fields without treating either whole file as the request', async () => {
    const base = await baseline();
    disk.set('project.abs', base.source.replace('TEXT="before"', 'TEXT="user disk"'));
    editor.workspace.getBlockById('child').setFieldValue('2337', 'NUM');
    const result = await priorityApply(base, base.source.replace('TEXT="before"', 'TEXT="AI result"'));
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('AI result');
    expect(editor.workspace.getBlockById('child').getFieldValue('NUM')).toBe(2337);
    expect(result.historyBase!.snapshot).toContain('TEXT="user disk"');
    expect(result.historyBase!.snapshot).toContain('2337');
    expect(result.historyBase!.snapshot).not.toContain('AI result');
    expect(await decodeAbsState(result.historyBase!.snapshot)).toBeTruthy();
    expect(result.historyBase!.hash).toBe(await hashAbsText(result.historyBase!.snapshot));
    expect(result.historyBase!.inputAbsHash).toBe(await hashAbsText(base.source.replace('TEXT="before"', 'TEXT="user disk"')));
  });

  it('retains unrelated saved edits when the original intent generation is older than the current commit', async () => {
    const base = await baseline();
    editor.workspace.getBlockById('child').setFieldValue('7337', 'NUM');
    await service.exportGeneration({ save: true });
    const result = await priorityApply(base, base.source.replace('TEXT="before"', 'TEXT="AI result"'));
    expect(result.publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById('child').getFieldValue('NUM')).toBe(7337);
    expect(roots().getFieldValue('TEXT')).toBe('AI result');
  });

  const enableNative = () => {
    Blockly.Extensions.register('native_commit_extension', function() {
      this.getField('MODE').setValidator(mode => {
        if (this.getInput('DETAIL')) this.removeInput('DETAIL');
        if (mode === 'B') this.appendDummyInput('DETAIL').appendField(new Blockly.FieldTextInput('default'), 'DETAIL');
        return mode;
      });
      this.data = 'native:' + this.id;
    });
    declare(nativeReconciliationDefinition);
    const replay = { steps: structuredClone(nativeReconciliationSteps), assertCurrent: jasmine.createSpy('nativeCurrent') };
    editor.captureNativeReplay = jasmine.createSpy('captureNativeReplay').and.returnValue(replay);
    return replay;
  };

  it('externalizes only the authoritative native draft when a declarative new block needs native preparation', async () => {
    const replay = enableNative();
    replay.steps.push({ kind: 'definitions', definitions: [catalog.capture(Blockly.Blocks).get('abs_declared_text')!] });
    replay.steps.push({ kind: 'script', label: 'text-generator', source: 'Arduino.forBlock.abs_declared_text = () => ["text", 0];' });
    const base = await baseline(), large = 'payload'.repeat(6000);
    const source = base.source + `\nabs_declared_text(${JSON.stringify(large)}, true)\n`;
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const before = absJson(nativeState()), files = [...disk];
    (projectDataRuntime.put as jasmine.Spy).calls.reset();
    const validation = await service.validateGeneration(source, request);
    expect((projectDataRuntime.put as jasmine.Spy).calls.allArgs().filter(([request]) => request.value === large).length).toBe(1);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlocksByType('abs_declared_text', false)[0].getFieldValue('TEXT')).toBe(large);
    expect(disk.get('project.abs')).not.toContain(large);
  });

  it('retains resource failure before workspace mutation after deferring the provisional resource pass', async () => {
    const replay = enableNative();
    replay.steps.push({ kind: 'definitions', definitions: [catalog.capture(Blockly.Blocks).get('abs_declared_text')!] });
    replay.steps.push({ kind: 'script', label: 'text-generator', source: 'Arduino.forBlock.abs_declared_text = () => ["text", 0];' });
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    (projectDataRuntime.put as jasmine.Spy).and.rejectWith(new Error('injected resource failure'));
    await expectAsync(service.applyGeneration(base.source + `\nabs_declared_text(${JSON.stringify('x'.repeat(40000))}, true)\n`, base.generation))
      .toBeRejectedWithError('injected resource failure');
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
  });

  /** Use the real post-commit acknowledgement rather than the coordinator's
   * usual output spy, so the UI baseline is exercised across the transaction. */
  const trackCleanState = () => {
    window['fs'].readFileSync = path => {
      if (path !== `${scope.projectKey}/project.abi`) throw new Error(`Unexpected read: ${path}`);
      return disk.get('project.abi');
    };
    editor.normalizeProjectAbi = value => value;
    editor.getWorkspaceLoadReadbackView = value => value;
    editor.getProjectAbiForSave = (snapshot = editor.captureProjectSnapshot().document) => snapshot;
    const document = editor.captureProjectSnapshot().document;
    disk.set('project.abi', JSON.stringify(document));
    project.rememberLoadedProject(scope.projectKey, disk.get('project.abi')!, document);
    (project.publishPreparedSaveOutputs as jasmine.Spy).and.callThrough();
    spyOn(project, 'syncUsedLibraryManifest').and.returnValue(false);
  };

  it('routes normal project Save through the complete ABS snapshot transaction', async () => {
    await baseline(); roots().setFieldValue('saved through UI', 'TEXT');
    await project.save(scope.projectKey);
    expect(disk.get('project.abs')).toContain('saved through UI');
    const decoded = await decodeAbsState(disk.get('project.abs')!);
    expect(absJson(decoded.document)).toBe(absJson(JSON.parse(disk.get('project.abi')!)));
    expect(JSON.parse(disk.get(`baselines/${JSON.parse(disk.get('project.abs.map.json')!).generation}.json`)!).abi).toBeUndefined();
  });

  it('holds history input ownership until reload and keeps its caches derived', async () => {
    const base = await baseline(), before = [...disk];
    const { token } = await service.beginHistoryNavigation();
    expect(gate.busy).toBeTrue(); expect([...disk]).toEqual(before);
    disk.set('project.abs', base.source + '\n# history candidate');
    await service.sealHistoryNavigation(token);
    expect(gate.busy).toBeFalse(); expect(gate.blocked).toBeTrue();
    service.releaseHistoryNavigation(token);
    expect(gate.blocked).toBeTrue(); // Only a fresh workspace activation clears quarantine.
  });

  it('accepts layout-only cache changes before history while retaining exact seal checks', async () => {
    await baseline();
    const abi = JSON.parse(disk.get('project.abi')!);
    abi.pages[0].viewState = { scale: 0.5, scrollX: 17, scrollY: 23 };
    abi.pages[0].content.blocks.blocks[0].x += 12;
    disk.set('project.abi', JSON.stringify(abi));
    const before = [...disk], { token } = await service.beginHistoryNavigation();
    expect([...disk]).toEqual(before); expect(gate.busy).toBeTrue();
    disk.set('project.abi', disk.get('project.abi')! + ' ');
    await expectAsync(service.sealHistoryNavigation(token)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUAL_EDIT_CONFLICT' }));
    service.releaseHistoryNavigation(token);
  });

  it('refuses history before file mutation when the canvas contains unsaved changes', async () => {
    await baseline(); roots().setFieldValue('unsaved user edit', 'TEXT'); const before = [...disk];
    await expectAsync(service.beginHistoryNavigation()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUAL_EDIT_CONFLICT' }));
    expect([...disk]).toEqual(before); expect(roots().getFieldValue('TEXT')).toBe('unsaved user edit'); expect(gate.busy).toBeFalse();
  });

  it('refuses history sealing after a competing cache edit and releases only its own token', async () => {
    await baseline(); const { token } = await service.beginHistoryNavigation();
    service.releaseHistoryNavigation('wrong'); expect(gate.busy).toBeTrue();
    disk.set('project.abi', '{"external":true}'); const before = [...disk];
    await expectAsync(service.sealHistoryNavigation(token)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUAL_EDIT_CONFLICT' }));
    expect([...disk]).toEqual(before); service.releaseHistoryNavigation(token); expect(gate.blocked).toBeFalse();
  });

  it('validation retains the loaded clean state; a complete ABS commit acknowledges only the committed snapshot', async () => {
    trackCleanState();
    const base = await baseline(), source = base.source.replace('TEXT="before"', 'TEXT="after"');
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi')!)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(await project.hasUnsavedChanges()).toBeFalse();
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    expect(await project.hasUnsavedChanges()).toBeFalse();
    roots().setFieldValue('later edit', 'TEXT'); expect(await project.hasUnsavedChanges()).toBeTrue();
    roots().setFieldValue('after', 'TEXT'); expect(await project.hasUnsavedChanges()).toBeFalse();
  });

  it('pre-ABI failure retains the state saved by complete export without acknowledging the failed candidate', async () => {
    trackCleanState();
    roots().setFieldValue('unsaved', 'TEXT');
    const base = await baseline(); failWrite = 'project.abi';
    const result = await service.applyGeneration(base.source.replace('TEXT="unsaved"', 'TEXT="candidate"'), base.generation);
    expect(result.publication.status).toBe('NOT_COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('unsaved');
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
    expect(await project.hasUnsavedChanges()).toBeFalse();
  });

  it('partial ABS publication cannot acknowledge a clean UI or bypass quarantine', async () => {
    trackCleanState();
    const base = await baseline(); failWrite = 'project.abs';
    expect((await apply(base)).publication.status).toBe('MIRROR_PENDING');
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
    await expectAsync(project.hasUnsavedChanges()).toBeRejected();
  });

  it('keeps the saved ABI fact when ordinary save leaves ABS mirrors pending', async () => {
    await baseline(); roots().setFieldValue('saved before mirror failure', 'TEXT'); failWrite = 'project.abs';
    await expectAsync((project as any).absSaveHandler(scope.projectKey)).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_SAVE_INCOMPLETE', projectSaved: true, generatedCodePublished: false, partial: true,
    }));
    expect(disk.get('project.abi')).toContain('saved before mirror failure');
    expect(gate.blocked).toBeTrue();
  });

  const enableDefaults = (extra = '') => {
    const replay = enableNative(), source = nativeDefaultSource + extra;
    new Function('Blockly', 'Arduino', source)(Blockly, { forBlock: {} });
    for (const type of ['native_default_owner', 'native_default_leaf']) {
      registeredTypes.push(type); observeNativeBlockDefinition(Blockly.Blocks[type]);
    }
    replay.steps.push({ kind: 'script', label: 'owned-default', source });
  };

  for (const { rendered, chunk } of [{ rendered: false, chunk: false }, { rendered: true, chunk: false }, { rendered: true, chunk: true }]) it(`replaces owned default children through validate/apply/edit/disconnect/reopen (${rendered ? 'rendered' : 'headless'}, chunk=${chunk})`, async () => {
    enableDefaults();
    if (rendered) renderWorkspace();
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_default_owner(B, math_number(7))\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, { chunk }, validation)).publication.status).toBe('COMMITTED');
    const owner = editor.workspace.getBlocksByType('native_default_owner', false)[0], id = owner.id;
    const childId = owner.getInputTargetBlock('VALUE').id;
    expect(owner.getInputTargetBlock('VALUE').getFieldValue('NUM')).toBe(7);
    expect(editor.workspace.getBlocksByType('native_default_leaf', false).length).toBe(0);
    const edit = disk.get('project.abs')!.replace(/native_default_owner\(B, math_number\((?:NUM=)?7\)\)/, 'native_default_owner(B, math_number(9))');
    expect(edit).not.toBe(disk.get('project.abs'));
    expect((await service.applyGeneration(edit, JSON.parse(disk.get('project.abs.map.json')!).generation, { chunk })).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById(childId).getFieldValue('NUM')).toBe(9);
    const empty = disk.get('project.abs')!.replace(/native_default_owner\(B, math_number\((?:NUM=)?9\)\)/, 'native_default_owner(B, null)');
    expect((await service.applyGeneration(empty, JSON.parse(disk.get('project.abs.map.json')!).generation, { chunk })).publication.status).toBe('COMMITTED');
    const saved = disk.get('project.abi')!;
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(saved));
    expect(editor.workspace.getBlockById(id).getInputTargetBlock('VALUE')).toBeNull();
    expect(editor.workspace.getBlocksByType('native_default_leaf', false).length).toBe(0);
    expect(editor.workspace.getBlockById(childId)).toBeNull();
    expect(roots().isDeletable()).toBeFalse(); expect(disk.get('project.abi')).toBe(saved);
  });

  for (const shadow of [false, true]) it(`adopts new omitted defaults, publishes normal ABS, edits and reopens stable IDs (shadow=${shadow})`, async () => {
    enableDefaults(shadow ? `
      Blockly.Blocks.native_default_owner.makeDefault = function() {
        this.getInput('VALUE').connection.setShadowState({ type: 'math_number', fields: { NUM: 5 } });
      };` : '');
    renderWorkspace();
    const base = await baseline();
    expect((await service.applyGeneration(base.source + '\nnative_default_owner(A)\n', base.generation, { chunk: true })).publication.status).toBe('COMMITTED');
    const owner = editor.workspace.getBlocksByType('native_default_owner', false)[0], ownerId = owner.id;
    const child = shadow ? owner.getInputTargetBlock('VALUE') : owner.getInputTargetBlock('VALUE').getInputTargetBlock('CHILD');
    const childId = child.id;
    expect(child.getFieldValue('NUM')).toBe(5); expect(child.isShadow()).toBe(shadow);
    const published = disk.get('project.abs')!;
    expect(published).toContain('math_number'); expect(splitAbsState(published).program).not.toContain(childId);
    const edited = published.replace(/math_number\((?:NUM=)?5\)/, 'math_number(8)');
    expect(edited).not.toBe(published);
    expect((await service.applyGeneration(edited, JSON.parse(disk.get('project.abs.map.json')!).generation, { chunk: false })).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById(childId).getFieldValue('NUM')).toBe(8);
    const saved = disk.get('project.abi')!;
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(saved));
    expect(editor.workspace.getBlockById(childId).getFieldValue('NUM')).toBe(8);
    expect(editor.workspace.getBlockById(childId).isShadow()).toBe(shadow);
    expect(editor.workspace.getBlockById(ownerId)).not.toBeNull(); expect(roots().isDeletable()).toBeFalse();
    if (!shadow) {
      const latest = disk.get('project.abs')!;
      const empty = latest.replace(/native_default_owner\(A, native_default_leaf\(math_number\((?:NUM=)?8\)\)\)/, 'native_default_owner(A)');
      expect(empty).not.toBe(latest);
      expect((await service.applyGeneration(empty, JSON.parse(disk.get('project.abs.map.json')!).generation)).publication.status).toBe('COMMITTED');
      expect(editor.workspace.getBlockById(ownerId).getInputTargetBlock('VALUE')).toBeNull();
      expect(editor.workspace.getBlockById(childId)).toBeNull();
    }
  });

  it('persists a covered default shadow and respawns its original identity after save/reopen', async () => {
    enableDefaults(`Blockly.Blocks.native_default_owner.makeDefault = function() {
      this.getInput('VALUE').connection.setShadowState({ type: 'math_number', fields: { NUM: 13 } });
    };`);
    renderWorkspace();
    const base = await baseline();
    expect((await service.applyGeneration(base.source + '\nnative_default_owner(A, math_number(7))\n', base.generation)).publication.status).toBe('COMMITTED');
    const owner = editor.workspace.getBlocksByType('native_default_owner', false)[0], ownerId = owner.id;
    const fallbackId = owner.getInput('VALUE').connection.getShadowState().id;
    expect(fallbackId).toBeTruthy();
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    const reopened = editor.workspace.getBlockById(ownerId);
    reopened.getInputTargetBlock('VALUE').dispose(false);
    const fallback = reopened.getInputTargetBlock('VALUE');
    expect(fallback.id).toBe(fallbackId); expect(fallback.isShadow()).toBeTrue(); expect(fallback.getFieldValue('NUM')).toBe(13);
    expect(roots().isDeletable()).toBeFalse();
  });

  it('externalizes large data in an adopted default through the existing Project Data pipeline', async () => {
    enableDefaults(`const init = Blockly.Blocks.native_default_leaf.init;
      Blockly.Blocks.native_default_leaf.init = function() {
        init.call(this); this.appendDummyInput().appendField(new Blockly.FieldTextInput('x'.repeat(40000)), 'TEXT');
        this.payload = { numbers: Array(12000).fill(42) };
        this.saveExtraState = () => this.payload;
        this.loadExtraState = state => { this.payload = state; };
      };`);
    const base = await baseline();
    expect((await service.applyGeneration(base.source + '\nnative_default_owner(A)\n', base.generation)).publication.status).toBe('COMMITTED');
    const leaf = editor.workspace.getBlocksByType('native_default_leaf', false)[0], id = leaf.id;
    expect(leaf.getFieldValue('TEXT')).toBe('x'.repeat(40000));
    expect(leaf.saveExtraState().numbers.length).toBe(12000);
    expect(values.size).toBe(2);
    expect(disk.get('project.abs')).not.toContain('x'.repeat(100));
    expect(disk.get('project.abi')).not.toContain('x'.repeat(100));
    const source = disk.get('project.abs')!.replace(/math_number\((?:NUM=)?5\)/, 'math_number(9)');
    expect((await service.applyGeneration(source, JSON.parse(disk.get('project.abs.map.json')!).generation)).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById(id).getFieldValue('TEXT')).toBe('x'.repeat(40000));
    expect(editor.workspace.getBlockById(id).saveExtraState().numbers).toEqual(Array(12000).fill(42));
  });

  for (const chunk of [false, true]) it(`validates, commits, edits and reopens nested dormant shadows without exposing hidden data in ABS (chunk=${chunk})`, async () => {
    enableDefaults(nativeDormantSource + `
      const init = Blockly.Blocks.native_default_leaf.init;
      Blockly.Blocks.native_default_leaf.init = function() { init.call(this);
        this.payload = { text: 'h'.repeat(40000), numbers: Array(12000).fill(42) };
        this.saveExtraState = () => this.isShadow() ? this.payload : null;
        this.loadExtraState = state => { if(state) this.payload = state; };
      };
    `);
    renderWorkspace();
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_default_owner(A)\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, { chunk }, validation)).publication.status).toBe('COMMITTED');
    const owner = editor.workspace.getBlocksByType('native_default_owner', false)[0], ownerId = owner.id;
    const fallback = owner.getInput('VALUE').connection.getShadowState(), fallbackId = fallback.id;
    const real = owner.getInputTargetBlock('VALUE'), realId = real.id;
    const nestedFallbackId = real.getInput('CHILD').connection.getShadowState().id;
    expect(fallback.extraState.text.length).toBe(40000); expect(values.size).toBe(1);
    expect(disk.get('project.abs')).not.toContain('h'.repeat(100));
    expect(splitAbsState(disk.get('project.abs')!).program).not.toContain('$ailyProjectDataValue');
    expect(disk.get('project.abi')).toContain('$ailyProjectDataValue');
    const edited = disk.get('project.abs')!.replace(/math_number\((?:NUM=)?5\)/, 'math_number(7)');
    expect(edited).not.toBe(disk.get('project.abs'));
    expect((await service.applyGeneration(edited, JSON.parse(disk.get('project.abs.map.json')!).generation, { chunk })).publication.status).toBe('COMMITTED');
    // The normal open pipeline materializes payloads before the synchronous loader.
    editor.restoreProjectWorkspaceSnapshot(await materializeGenericProjectDataValues(JSON.parse(disk.get('project.abi')!), {
      resolve: ref => projectDataRuntime.resolve(ref),
    }));
    const loadedOwner = editor.workspace.getBlockById(ownerId), loadedReal = editor.workspace.getBlockById(realId);
    loadedReal.getInputTargetBlock('CHILD').dispose(false);
    expect(loadedReal.getInputTargetBlock('CHILD').id).toBe(nestedFallbackId);
    expect(loadedReal.getInputTargetBlock('CHILD').getFieldValue('NUM')).toBe(11);
    loadedReal.dispose(false);
    const visibleFallback = loadedOwner.getInputTargetBlock('VALUE');
    expect(visibleFallback.id).toBe(fallbackId); expect(visibleFallback.isShadow()).toBeTrue();
    expect(visibleFallback.getInputTargetBlock('CHILD').getFieldValue('NUM')).toBe(13);
    expect(visibleFallback.saveExtraState()).toEqual({ text: 'h'.repeat(40000), numbers: Array(12000).fill(42) });
    expect(roots().isDeletable()).toBeFalse();
  });

  it('creates a JS-only dynamic block, commits canonical ABI, and reopens without prior instance evidence', async () => {
    const replay = enableNative();
    const source = `Blockly.Blocks.native_js_reopen = { init() {
      this.appendDummyInput('mode').appendField(new Blockly.FieldDropdown([['A', 'A'], ['B', 'B']], mode => {
        if (this.getInput('detail')) this.removeInput('detail');
        if (mode === 'B') this.appendDummyInput('detail').appendField(new Blockly.FieldTextInput('default'), 'A_DETAIL');
        return mode;
      }), 'Z_MODE');
    } };
    Arduino.forBlock.native_js_reopen = block => '// ' + block.getFieldValue('A_DETAIL') + '\\n';`;
    const register = () => {
      new Function('Blockly', 'Arduino', source)(Blockly, { forBlock: {} });
      observeNativeBlockDefinition(Blockly.Blocks['native_js_reopen']);
    };
    register(); registeredTypes.push('native_js_reopen');
    replay.steps.push({ kind: 'script', label: 'js-only-reopen', source });
    const base = await baseline(), before = absJson(nativeState());
    const candidate = base.source + '\nnative_js_reopen(B, "preserved")\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } };
    await service.validateGeneration(candidate, request);
    expect(absJson(nativeState())).toBe(before);
    expect((await service.applyGeneration(candidate, base.generation)).publication.status).toBe('COMMITTED');
    const added = editor.workspace.getBlocksByType('native_js_reopen', false)[0], id = added.id;
    expect(added.getFieldValue('A_DETAIL')).toBe('preserved');
    const saved = disk.get('project.abi')!;
    editor.workspace.clear(); catalog.clear(); register();
    expect(catalog.capture(Blockly.Blocks).get('native_js_reopen')).toBeUndefined();
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(saved));
    expect(editor.workspace.getBlockById(id).getFieldValue('A_DETAIL')).toBe('preserved');
    expect(roots().isDeletable()).toBeFalse();
    expect(disk.get('project.abi')).toBe(saved);
  });

  it('creates and reshapes an unknown native extension through the unique validate/apply transaction', async () => {
    enableNative();
    const base = await baseline(), before = absJson(nativeState()), diskBefore = [...disk];
    let source = base.source + '\nnative_commit_shape(B, math_number(7), "detail")\n';
    const evidence = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(evidence, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validated = await service.validateGeneration(source, request);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(diskBefore);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect((await service.applyGeneration(source, base.generation, {}, validated)).publication.status).toBe('COMMITTED');
    const added = editor.workspace.getBlocksByType('native_commit_shape', false)[0];
    const id = added.id;
    expect(id).not.toContain('abs-candidate-'); expect(added.data).toBe('native:' + id);
    expect(added.getFieldValue('DETAIL')).toBe('detail');
    expect(roots().id).toBe('protected'); expect(roots().isDeletable()).toBeFalse();
    expect(roots().isMovable()).toBeFalse(); expect(roots().data).toBe('opaque');
    expect(nativeState().blocks.blocks[0].inputs!['VALUE'].shadow!.id).toBe('dormant');
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    source = disk.get('project.abs')!.replace(/native_commit_shape\(B, math_number\((?:NUM=)?7\), "detail"\)/, 'native_commit_shape(A, math_number(8))');
    expect(source).not.toBe(disk.get('project.abs')!);
    const generation = JSON.parse(disk.get('project.abs.map.json')!).generation;
    expect((await service.applyGeneration(source, generation)).publication.status).toBe('COMMITTED');
    const changed = editor.workspace.getBlockById(id);
    expect(changed.getField('DETAIL')).toBeNull(); expect(changed.data).toBe('native:' + id);
    expect(changed.getInputTargetBlock('VALUE').getFieldValue('NUM')).toBe(8);
    const persisted = disk.get('project.abi')!;
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(persisted));
    expect(editor.workspace.getBlockById(id).getFieldValue('MODE')).toBe('A');
    expect(roots().isDeletable()).toBeFalse();
  });

  for (const effect of [
    `block.workspace.createVariable('unrequested');`,
    `try { setTimeout(() => {}, 1); } catch {}`,
    `block.setFieldValue('A', 'MODE');`,
    `throw Error('generator failed');`,
  ]) it(`rejects native generator effects before host mutation: ${effect}`, async () => {
    const replay = enableNative();
    replay.steps.push({ kind: 'script', label: 'generator-effect', source:
      `Arduino.forBlock.native_commit_shape = block => { ${effect} return ''; };` });
    const base = await baseline(), before = absJson(nativeState()), originalDisk = [...disk];
    const source = base.source + '\nnative_commit_shape(B, math_number(7), "detail")\n';
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(originalDisk);
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  const validateNativeEdit = async () => {
    const replay = enableNative(), base = await baseline();
    const source = base.source + '\nnative_commit_shape(B, math_number(7), "detail")\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    return { replay, base, source, request, validation };
  };

  it('prepares the isolated native candidate outside Angular without changing publication ownership', async () => {
    renderWorkspace();
    const zone = new NgZone({ enableLongStackTrace: false });
    const outside = jasmine.createSpy('isolatedPreparation').and.callFake(action => zone.runOutsideAngular(() => {
      expect(NgZone.isInAngularZone()).toBeFalse();
      return action();
    }));
    // NgZone itself also calls runOutsideAngular to schedule its own bookkeeping;
    // observe only the explicit preparation boundary, not Angular internals.
    service = new AbsWorkspaceSyncService(editor, project, { runOutsideAngular: outside, run: zone.run.bind(zone) } as unknown as NgZone);
    editor.publishAbsContext.and.callFake(() => expect(NgZone.isInAngularZone()).toBeTrue());
    await zone.run(async () => {
      const { base, source, validation } = await validateNativeEdit();
      expect(outside).toHaveBeenCalledTimes(2); // Baseline export and candidate preparation.
      expect(NgZone.isInAngularZone()).toBeTrue();
      const progress = jasmine.createSpy('progress').and.callFake(() => expect(NgZone.isInAngularZone()).toBeTrue());
      expect((await service.applyGeneration(source, base.generation, { chunk: true, onProgress: progress }, validation)).publication.status).toBe('COMMITTED');
      expect(outside).toHaveBeenCalledTimes(4); // Reuse checks and loading have separate scopes; publication stays in the caller.
      expect(progress).toHaveBeenCalled();
      expect(NgZone.isInAngularZone()).toBeTrue();
      expect(editor.publishAbsContext).toHaveBeenCalled();
    });
  });

  for (const mode of ['export', 'save', 'reuse', 'read-only'] as const)
  it(`keeps ${mode} storage/digests outside Angular and publishes editor state inside`, async () => {
    await baseline();
    if (mode === 'save') roots().setFieldValue('saved edit', 'TEXT');
    const zone = new NgZone({ enableLongStackTrace: false });
    service = new AbsWorkspaceSyncService(editor, project, zone);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let digests = 0;
    spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      digests++; expect(NgZone.isInAngularZone()).toBeFalse();
      return digest(algorithm, data);
    });
    const read = port.read;
    spyOn(port, 'read').and.callFake(key => { expect(NgZone.isInAngularZone()).toBeFalse(); return read(key); });
    editor.prepareProjectCode.and.callFake(async () => { expect(NgZone.isInAngularZone()).toBeTrue(); return null; });
    editor.publishAbsContext.calls.reset();
    editor.publishAbsContext.and.callFake(() => expect(NgZone.isInAngularZone()).toBeTrue());
    (project.publishPreparedSaveOutputs as jasmine.Spy).and.callFake(async (_path, _prepared, _generated, guard) => {
      expect(NgZone.isInAngularZone()).toBeTrue(); guard();
    });
    await zone.run(async () => {
      const result = await service.exportGeneration({ save: mode === 'save', reuseCurrent: mode === 'reuse', publish: mode !== 'read-only' });
      expect(result.publication.status).toBe(mode === 'read-only' ? 'NOT_COMMITTED' : 'COMMITTED');
      if (mode === 'reuse') expect(result.reused).toBeTrue();
      expect(NgZone.isInAngularZone()).toBeTrue();
    });
    expect(digests).toBeGreaterThan(0);
    if (mode === 'save') expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    expect(editor.publishAbsContext.calls.count()).toBe(mode === 'read-only' ? 0 : 1);
    expect(gate.blocked).toBeFalse();
  });

  it('returns an isolated save error to the caller and releases its workspace lease', async () => {
    await baseline();
    const before = [...disk], zone = new NgZone({ enableLongStackTrace: false });
    service = new AbsWorkspaceSyncService(editor, project, zone);
    spyOn(project, 'prepareSave').and.callFake(async () => {
      expect(NgZone.isInAngularZone()).toBeFalse(); throw new Error('save preparation failed');
    });
    editor.publishAbsContext.calls.reset();
    await zone.run(async () => {
      await expectAsync(service.exportGeneration({ save: true })).toBeRejectedWithError('save preparation failed');
      expect(NgZone.isInAngularZone()).toBeTrue();
    });
    expect([...disk]).toEqual(before); expect(editor.publishAbsContext).not.toHaveBeenCalled();
    expect(gate.blocked).toBeFalse();
  });

  it('keeps pure candidate digests outside Angular and resumes the caller for publication', async () => {
    const base = await baseline(), zone = new NgZone({ enableLongStackTrace: false });
    service = new AbsWorkspaceSyncService(editor, project, zone);
    const prepare = (service as any).prepareGeneration;
    let preparing = false, digests = 0;
    spyOn<any>(service, 'prepareGeneration').and.callFake(async (...args: any[]) => {
      expect(NgZone.isInAngularZone()).toBeFalse(); preparing = true;
      try { return await prepare.apply(service, args); } finally { preparing = false; }
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      if (preparing) { digests++; expect(NgZone.isInAngularZone()).toBeFalse(); }
      return digest(algorithm, data);
    });
    editor.prepareProjectCode.and.callFake(async () => { expect(NgZone.isInAngularZone()).toBeTrue(); return null; });
    editor.publishAbsContext.and.callFake(() => expect(NgZone.isInAngularZone()).toBeTrue());
    await zone.run(async () => {
      expect((await apply(base)).publication.status).toBe('COMMITTED');
      expect(NgZone.isInAngularZone()).toBeTrue();
    });
    expect(digests).toBeGreaterThan(0);
    expect(roots().getFieldValue('TEXT')).toBe('after');
    expect(editor.prepareProjectCode).toHaveBeenCalled();
    expect(editor.publishAbsContext).toHaveBeenCalled();
  });

  it('returns preparation errors to the caller zone without applying or publishing', async () => {
    const base = await baseline(), zone = new NgZone({ enableLongStackTrace: false });
    service = new AbsWorkspaceSyncService(editor, project, zone);
    const before = absJson(nativeState()), files = [...disk];
    editor.publishAbsContext.calls.reset();
    await zone.run(async () => {
      await expectAsync(service.applyGeneration(base.source + '\nunfinished(', base.generation)).toBeRejected();
      expect(NgZone.isInAngularZone()).toBeTrue();
    });
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(editor.publishAbsContext).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
  });

  it('restores the whole workspace when an Angular progress consumer fails during isolated loading', async () => {
    renderWorkspace();
    const zone = new NgZone({ enableLongStackTrace: false });
    service = new AbsWorkspaceSyncService(editor, project, zone);
    await zone.run(async () => {
      const base = await baseline(), before = absJson(nativeState()), files = [...disk];
      editor.publishAbsContext.calls.reset();
      await expectAsync(apply(base, { chunk: true, onProgress: () => {
        expect(NgZone.isInAngularZone()).toBeTrue();
        throw new Error('progress consumer failed');
      } })).toBeRejectedWithError('progress consumer failed');
      expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
      expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
      expect(editor.publishAbsContext).not.toHaveBeenCalled();
      expect(editor.requestWorkspaceVisualRefresh).toHaveBeenCalledTimes(1);
      expect(gate.blocked).toBeFalse();
    });
  });

  it('hands off one validated native candidate to apply without repeating isolated preparation', async () => {
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const { base, source, validation } = await validateNativeEdit();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(editor.workspace.getBlocksByType('native_commit_shape', false)[0].getFieldValue('MODE')).toBe('B');
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    await expectAsync(service.applyGeneration(source, base.generation, {}, validation)).toBeRejected();
  });

  for (const chunk of [false, true])
  it(`preserves actual instances for an exact zero-delta formatting edit (chunk=${chunk})`, async () => {
    const base = await baseline(), blocks = editor.workspace.getAllBlocks(false);
    const state = absJson(nativeState());
    const code = editor.prepareProjectCode;
    code.calls.reset();
    const result = await service.applyGeneration(base.source + '\n# formatting only\n', base.generation, { chunk });
    expect(result.publication.status).toBe('COMMITTED');
    expect(absJson(nativeState())).toBe(state);
    for (const block of blocks) expect(editor.workspace.getBlockById(block.id)).toBe(block);
    expect(disk.get('project.abs')).toBe(base.source);
    expect(code).toHaveBeenCalledTimes(1); // Same existing preparation boundary, not another generator call.
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalled();
  });

  it('keeps a zero-delta edit independent of block construction side effects', async () => {
    let initialized = 0;
    const init = Blockly.Blocks['abs_sync_root'].init;
    Blockly.Blocks['abs_sync_root'].init = function() { initialized++; init.call(this); };
    const base = await baseline(), block = roots();
    const before = initialized;
    await service.applyGeneration(base.source + '\n# no new semantics', base.generation);
    expect(initialized).toBe(before); expect(roots()).toBe(block);
  });

  it('still reloads for a real field delta, even when block IDs/types/counts are identical', async () => {
    const base = await baseline(), before = roots();
    await apply(base);
    expect(roots()).not.toBe(before); expect(roots().getFieldValue('TEXT')).toBe('after');
    expect(editor.workspace.getAllBlocks(false).length).toBe(2);
  });

  it('does not compare zero delta against an old projection layout', async () => {
    const base = await baseline(), block = roots();
    block.moveBy(200, 150);
    const position = block.getRelativeToSurfaceXY();
    await service.applyGeneration(base.source + '\n# keep current layout', base.generation);
    expect(roots()).toBe(block); expect(block.getRelativeToSurfaceXY()).toEqual(position);
    expect(JSON.parse(disk.get('project.abi')!).pages[0].content.blocks.blocks[0].x).toBe(position.x);
  });

  it('still restores a zero-delta application when generation mutates serialized state', async () => {
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    editor.prepareProjectCode.and.callFake(async () => { roots().setFieldValue('unexpected', 'TEXT'); return null; });
    await expectAsync(service.applyGeneration(base.source + '\n# no edit', base.generation))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_READBACK_MISMATCH' }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(gate.blocked).toBeFalse();
  });

  it('restores a zero-delta application when save preparation fails before commit', async () => {
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    spyOn(project, 'prepareSave').and.rejectWith(new Error('save preparation failed'));
    await expectAsync(service.applyGeneration(base.source + '\n# no edit', base.generation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(gate.blocked).toBeFalse();
  });

  it('preserves commit-failure quarantine after skipping a zero-delta load', async () => {
    const base = await baseline(), before = absJson(nativeState()), abi = disk.get('project.abi');
    failWrite = 'prepared.json';
    await expectAsync(service.applyGeneration(base.source + '\n# no edit', base.generation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect(disk.get('project.abi')).toBe(abi);
    expect(disk.get('project.abs')).toBe(base.source);
    expect(gate.blocked).toBeTrue();
  });

  it('reuses only pure analysis between different candidates and commits the selected native result', async () => {
    const { base, source, request, replay } = await validateNativeEdit();
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const files = [...disk], before = absJson(nativeState());
    // Both sources must exercise different native field state, not a transport retry.
    const candidate = source.replace('"detail"', '"second detail"');
    expect(candidate).not.toBe(source);
    const nextRequest = { ...request, requestId: crypto.randomUUID(),
      candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } };
    replay.assertCurrent.calls.reset();
    const validation = await service.validateGeneration(candidate, nextRequest);
    expect(prepare).toHaveBeenCalledTimes(1); expect(replay.assertCurrent).toHaveBeenCalled();
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(before);
    expect((await service.applyGeneration(candidate, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(prepare).toHaveBeenCalledTimes(1);
    // This fixture does not declare math_number's positional contract; export
    // canonically names NUM and omits the input's trailing newline.
    expect(splitAbsState(disk.get('project.abs')!).program).toBe(splitAbsState(candidate).program.trimEnd().replace('math_number(7)', 'math_number(NUM=7)'));
    expect(editor.workspace.getBlocksByType('native_commit_shape', false)[0].getFieldValue('DETAIL'))
      .toBe('second detail');
  });

  it('rejects direct host changes during a detached native realm before accepting its result', async () => {
    let changed = false;
    const observer = new MutationObserver(records => {
      if (changed || !records.some(record => [...record.addedNodes].some(node =>
        node instanceof HTMLIFrameElement && node.hasAttribute('data-blockly-native-candidate')))) return;
      changed = true; observer.disconnect();
      roots().setFieldValue('changed during isolated execution', 'TEXT');
    });
    observer.observe(document.body, { childList: true });
    try {
      await expectAsync(validateNativeEdit()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
      expect(changed).toBeTrue();
      expect(roots().getFieldValue('TEXT')).toBe('changed during isolated execution');
      expect(editor.workspace.getBlocksByType('native_commit_shape', false).length).toBe(0);
      expect(disk.get('project.abs')).not.toContain('native_commit_shape');
      expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
      expect(gate.blocked).toBeFalse();
    } finally { observer.disconnect(); }
  });

  it('reuses a dry-run for apply validation with a fresh transport nonce, then consumes it once', async () => {
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const { base, source, request, validation } = await validateNativeEdit();
    const nextRequest = { ...request, requestId: crypto.randomUUID() }, files = [...disk];
    const next = await service.validateGeneration(source, nextRequest);
    expect(next.requestId).toBe(nextRequest.requestId); expect(next.requestId).not.toBe(validation.requestId);
    expect(prepare).toHaveBeenCalledTimes(1); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, {}, next)).publication.status).toBe('COMMITTED');
    expect(prepare).toHaveBeenCalledTimes(1);
    await expectAsync(service.applyGeneration(source, base.generation, {}, next)).toBeRejected();
  });

  for (const change of ['program', 'disk', 'replay'])
  it('rechecks ' + change + ' before reusing a dry-run for another validation request', async () => {
    const { replay, source, request } = await validateNativeEdit();
    if (change === 'program') roots().setFieldValue('user edit', 'TEXT');
    if (change === 'disk') disk.set('project.abs', 'external draft');
    if (change === 'replay') replay.assertCurrent.and.throwError('stale replay');
    const state = absJson(nativeState()), files = [...disk];
    await expectAsync(service.validateGeneration(source, { ...request, requestId: crypto.randomUUID() })).toBeRejected();
    expect(absJson(nativeState())).toBe(state); expect([...disk]).toEqual(files);
  });

  it('reprepares an expired dry-run without renewing its lifetime on repeated validation', async () => {
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const { source, request } = await validateNativeEdit();
    const now = Date.now(), clock = spyOn(Date, 'now').and.returnValue(now + 20000);
    await service.validateGeneration(source, { ...request, requestId: crypto.randomUUID() });
    expect(prepare).toHaveBeenCalledTimes(1);
    clock.and.returnValue(now + 31000);
    await service.validateGeneration(source, { ...request, requestId: crypto.randomUUID() });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('never shares request-bound explicit parameter identities between validation requests', async () => {
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const base = await wireBase();
    const source = base.source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"counter"}]}';
    const request = { ...base.request, version: 2 as const, createVariables: [{ name: 'counter' }],
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const first = await service.validateGeneration(source, request);
    const second = await service.validateGeneration(source, { ...request, requestId: crypto.randomUUID() });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(first.preparedVariables![0].id).not.toBe(second.preparedVariables![0].id);
  });

  it('checks whole-project snapshots at handoff boundaries rather than once per field', async () => {
    for (let i = 0; i < 100; i++) editor.workspace.newBlock('abs_declared_text');
    const base = await baseline(), source = base.source.replace('TEXT="before"', 'TEXT="after"');
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    const snapshots = spyOn(editor, 'captureProjectSnapshot').and.callThrough();
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(snapshots.calls.count()).toBeLessThan(80);
    expect(editor.workspace.getBlocksByType('abs_declared_text', false).length).toBe(100);
    expect(roots().getFieldValue('TEXT')).toBe('after');
  });

  for (const change of ['program', 'disk', 'declarations', 'replay'])
  it('rejects a prepared handoff after ' + change + ' changes without modifying the project', async () => {
    const { replay, base, source, validation } = await validateNativeEdit();
    if (change === 'program') roots().setFieldValue('user edit', 'TEXT');
    if (change === 'disk') disk.set('project.abs', 'external draft');
    if (change === 'declarations') catalog.clear();
    if (change === 'replay') replay.assertCurrent.and.throwError('stale native replay');
    const before = absJson(nativeState()), files = [...disk];
    await expectAsync(service.applyGeneration(source, base.generation, {}, validation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('retains a root move made while the prepared handoff rechecks disk state', async () => {
    const { base, source, validation } = await validateNativeEdit();
    const read = port.read;
    let moved = false;
    spyOn(port, 'read').and.callFake(async key => {
      const text = await read(key);
      if (key === 'project.abs' && !moved) { moved = true; roots().moveBy(123, 45); }
      return text;
    });
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(moved).toBeTrue();
    expect(roots().getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(153, 105));
    expect(composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main').blocks.blocks.find(block => block.id === 'protected'))
      .toEqual(jasmine.objectContaining({ x: 153, y: 105 }));
  });

  for (const reason of ['expired', 'another-request'])
  it('performs full preparation when the handoff is ' + reason, async () => {
    const prepare = spyOn<any>(service, 'prepareGeneration').and.callThrough();
    const { base, source, validation } = await validateNativeEdit();
    if (reason === 'expired') {
      const later = Date.now() + 31000;
      spyOn(Date, 'now').and.returnValue(later);
    }
    else validation.requestId = crypto.randomUUID();
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('rejects a replay becoming stale and a disk CAS conflict during native preparation', async () => {
    const replay = enableNative();
    const base = await baseline(), before = absJson(nativeState());
    const source = base.source + '\nnative_commit_shape(B, math_number(7), "detail")\n';
    let calls = 0;
    replay.assertCurrent.and.callFake(() => { if (++calls > 8) throw Error('stale native replay'); });
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejectedWithError(/stale native replay/);
    expect(absJson(nativeState())).toBe(before);
    replay.assertCurrent.and.callFake(() => { disk.set('project.abs', 'external edit'); });
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
    expect(disk.get('project.abs')).toBe('external edit'); expect(absJson(nativeState())).toBe(before);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('retains disabled reasons and rejects protected deletion before native execution', async () => {
    enableNative();
    roots().setDisabledReason(true, 'HOST_POLICY');
    const base = await baseline();
    expect(base.source).toContain('@disabled');
    const source = base.source + '\nnative_commit_shape(A, math_number(7))\n';
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    expect([...roots().getDisabledReasons()]).toEqual(['HOST_POLICY']);
    const generation = JSON.parse(disk.get('project.abs.map.json')!).generation;
    const oldState = absJson(nativeState()), oldDisk = [...disk];
    editor.captureNativeReplay.calls.reset();
    await expectAsync(service.applyGeneration('# ABS Schema: 2\n', generation)).toBeRejected();
    expect(editor.captureNativeReplay).not.toHaveBeenCalled();
    expect(absJson(nativeState())).toBe(oldState); expect([...disk]).toEqual(oldDisk);
  });

  it('exports protection and retains it when an edited candidate omits the annotation', async () => {
    roots().setEditable(false);
    const base = await baseline();
    expect(base.source).toContain('@protect:{"deletable":false,"editable":false,"movable":false}');
    const source = base.source.replace(/ @protect:\{[^}]*\}/g, '').replace('TEXT="before"', 'TEXT="after"');
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    expect(roots().isDeletable()).toBeFalse();
    expect(roots().isMovable()).toBeFalse();
    expect(roots().isEditable()).toBeFalse();
    expect(roots().getFieldValue('TEXT')).toBe('after');
    expect(disk.get('project.abs')).toContain('@protect:');
  });

  it('adds explicit protection to new native blocks and rejects subsequent deletion atomically', async () => {
    enableNative();
    const base = await baseline();
    const source = base.source + '\nnative_commit_shape(A, math_number(7)) @protect:{"deletable":false,"movable":false,"editable":false}\n';
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    const added = editor.workspace.getBlocksByType('native_commit_shape', false)[0];
    expect(added.isDeletable()).toBeFalse(); expect(added.isMovable()).toBeFalse(); expect(added.isEditable()).toBeFalse();
    const generation = JSON.parse(disk.get('project.abs.map.json')!).generation;
    const before = absJson(nativeState()), files = [...disk];
    await expectAsync(service.applyGeneration(splitAbsState(base.source).program, generation))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROTECTED_BLOCK_MISSING' }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
  });

  it('reshapes a protected native instance without replacing its metadata, child or dormant shadow', async () => {
    enableNative();
    const block = editor.workspace.newBlock('native_commit_shape', 'native-protected');
    block.setFieldValue('B', 'MODE'); block.setFieldValue('old', 'DETAIL');
    block.setDeletable(false); block.setMovable(false); block.data = 'user-owned metadata';
    const child = editor.workspace.newBlock('math_number', 'native-value'); child.setFieldValue(9, 'NUM');
    block.getInput('VALUE').connection.connect(child.outputConnection);
    block.getInput('VALUE').connection.setShadowState({ type: 'math_number', id: 'native-shadow', fields: { NUM: 4 } });
    const base = await baseline();
    const source = base.source.replace(/native_commit_shape\(B, math_number\((?:NUM=)?9\), "old"\)/, 'native_commit_shape(A, math_number(9))');
    expect(source).not.toBe(base.source);
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    const changed = editor.workspace.getBlockById('native-protected');
    expect(changed.isDeletable()).toBeFalse(); expect(changed.isMovable()).toBeFalse();
    expect(changed.data).toBe('user-owned metadata'); expect(changed.getField('DETAIL')).toBeNull();
    expect(changed.getInputTargetBlock('VALUE').id).toBe('native-value');
    expect(changed.getInput('VALUE').connection.getShadowState()).toEqual({ type: 'math_number', id: 'native-shadow', fields: { NUM: 4 } });
  });

  it('does not promote one prepared native instance to all configurations of the same type', async () => {
    enableNative();
    const base = await baseline();
    const source = base.source + '\nnative_commit_shape(A, math_number(1))\nnative_commit_shape(B, math_number(2), "only B")\n';
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    const variants = editor.workspace.getBlocksByType('native_commit_shape', false);
    expect(variants.length).toBe(2);
    expect(variants.find(block => block.getFieldValue('MODE') === 'A').getField('DETAIL')).toBeNull();
    expect(variants.find(block => block.getFieldValue('MODE') === 'B').getFieldValue('DETAIL')).toBe('only B');
    expect(new Set(variants.map(block => block.id)).size).toBe(2);
    expect(variants.every(block => block.data === 'native:' + block.id)).toBeTrue();
  });

  const enableNativeVariables = () => {
    const replay = enableNative();
    const variable = { type: 'variables_get', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR', variable: 'unused-default' }], output: null };
    replay.steps.push({ kind: 'definitions', definitions: [variable] });
    replay.steps.push({ kind: 'script', label: 'variable-generator', source: `
      Arduino.forBlock.variables_get = block => [block.getField('VAR').getVariable().name, 0];
    ` });
    return replay;
  };

  const enableObjectModels = () => {
    const replay = enableNative();
    modelDefinitions.forEach(declare);
    replay.steps.push({ kind: 'definitions', definitions: modelDefinitions }, { kind: 'script', source: modelSource, label: 'generic-object-models' });
    return replay;
  };

  it('keeps explicit initializer evidence identical across reconciliation binds and reuses only committed model IDs', async () => {
    const replay = enableNative();
    const definition = { type: 'native_selected_init', message0: '%1 %2', args0: [
      { type: 'field_variable', name: 'OWNER', variableTypes: ['Sensor'], defaultType: 'Sensor' },
      { type: 'field_variable', name: 'INPUT', variableTypes: ['Sample'], defaultType: 'Sample' },
    ], previousStatement: null, nextStatement: null };
    declare(definition);
    replay.steps.push({ kind: 'definitions', definitions: [definition] }, { kind: 'script', label: 'explicit-selected-models', source: `
      ${modelSource}
      Arduino.modelDeclarations = { native_selected_init: { version: 1, scope: 'workspace', fields: { OWNER: 'Sensor', INPUT: 'Sample' } } };
      Arduino.forBlock.native_selected_init = block => {
        registerVariableToBlockly(block.getField('OWNER').getVariable().name, 'Sensor');
        registerVariableToBlockly(block.getField('INPUT').getVariable().name, 'Sample');
        return '';
      };
    ` });
    const validate = async (source: string) => {
      const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
      const { generationEvidence } = await import('./abs-generation-protocol');
      return service.validateGeneration(source, { version: 2, requestId: crypto.randomUUID(),
        base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
        candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } });
    };
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_selected_init($sensor, $reading)';
    const validation = await validate(source);
    expect(validation.preparedModels!.map(model => model.name).sort()).toEqual(['reading', 'sensor']);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    const committedModels = nativeState()['variables'] as Array<{ id: string; name: string; type: string }>;
    expect(new Set(committedModels.map(model => model.id)))
      .toEqual(new Set(validation.preparedModels!.map(model => model.id)));
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(nativeState()['variables']).toEqual(committedModels);
    const second = await baseline(), next = second.source + '\nnative_selected_init($second, $reading)';
    const more = await validate(next);
    expect(more.preparedModels!.map(model => model.name)).toEqual(['second']);
    expect((await service.applyGeneration(next, second.generation, {}, more)).publication.status).toBe('COMMITTED');
    for (const model of committedModels) expect(nativeState()['variables']).toContain(jasmine.objectContaining(model));
    expect(roots().isDeletable()).toBeFalse(); expect(roots().data).toBe('opaque');
  });

  for (const reverse of [false, true]) it('reuses typed identities internally without presenting them as fresh receipt allocations: ' + reverse, async () => {
    enableObjectModels();
    const variables = [{ id: 'existing-func', name: 'sensor', type: 'FUNC' },
      { id: 'existing-sensor', name: 'sensor', type: 'Sensor' },
      { id: 'existing-other', name: 'sensor', type: 'Other' },
      { id: 'shared-page-model', name: 'shared', type: 'Shared' }];
    if (reverse) variables.reverse();
    for (const model of variables) editor.workspace.getVariableMap().createVariable(model.name, model.type, model.id);
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\ntest_object_read($sensor)\ntest_object_init("sensor", Sensor)\ntest_object_init("sensor", Other)';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(validation.preparedModels).toBeUndefined(); expect(validation.preparedVariables).toBeUndefined();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    const forged = { ...validation, preparedModels: [{ start: source.indexOf('test_object_init'), blockType: 'test_object_init',
      id: 'existing-sensor', name: 'sensor', type: 'Sensor' }] };
    await expectAsync(service.applyGeneration(source, base.generation, {}, forged))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    expect(nativeState()['variables']).toEqual(variables);
    expect(JSON.parse(disk.get('project.abi')!).sharedModel.variables).toEqual(variables);
    expect(roots().isDeletable()).toBeFalse(); expect(roots().data).toBe('opaque');
    expect(JSON.parse(disk.get('project.abi')!).pages.find(page => page.id === 'other').custom).toEqual({ preserved: true });
  });

  it('validates/applies native initializer models atomically, verifies receipt replay and preserves identities after reopen', async () => {
    enableObjectModels(); const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\ntest_object_read($sensor)\ntest_object_init("sensor", Sensor)';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(validation.preparedVariables).toBeUndefined();
    expect(validation.preparedModels!.length).toBe(1);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    const changed = structuredClone(validation); changed.preparedModels![0].id = 'forged';
    await expectAsync(service.applyGeneration(source, base.generation, {}, changed)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    await service.applyGeneration(source, base.generation, {}, validation);
    const model = editor.workspace.getAllVariables()[0];
    expect(model.getId()).toBe(validation.preparedModels![0].id); expect(model.type).toBe('Sensor');
    const ids = editor.workspace.getAllBlocks(false).map(block => block.id).sort();
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(editor.workspace.getAllBlocks(false).map(block => block.id).sort()).toEqual(ids);
    expect(editor.workspace.getAllVariables()[0].getId()).toBe(model.getId());
    const saved = [...disk], stateBeforeRename = absJson(nativeState());
    await expectAsync(service.applyGeneration(splitAbsState(disk.get('project.abs')!).program.replaceAll('sensor', 'renamed'),
      JSON.parse(disk.get('project.abs.map.json')!).generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_RENAME_UNSUPPORTED' }));
    expect([...disk]).toEqual(saved); expect(absJson(nativeState())).toBe(stateBeforeRename);
    // Models are shared state: removing all uses/producers does not implicitly garbage collect them.
    await service.applyGeneration(splitAbsState(base.source).program, JSON.parse(disk.get('project.abs.map.json')!).generation);
    expect(editor.workspace.getAllVariables()[0].getId()).toBe(model.getId());
  });

  it('rolls back derived models and blocks when code generation fails before save', async () => {
    enableObjectModels(); const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    editor.prepareProjectCode.and.rejectWith(new Error('injected generation failure'));
    await expectAsync(service.applyGeneration(base.source + '\ntest_object_read($sensor)\ntest_object_init("sensor", Sensor)', base.generation)).toBeRejectedWithError(/injected generation failure/);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalled();
  });

  it('prepares an initializer-only candidate even though its JSON shape is statically known', async () => {
    enableObjectModels(); const base = await baseline();
    await service.applyGeneration(base.source + '\ntest_object_init("sensor", Sensor)', base.generation);
    expect(editor.workspace.getAllVariables().map(model => [model.name, model.type])).toEqual([['sensor', 'Sensor']]);
  });

  it('never accepts caller-provided model preparation evidence as validation authority', async () => {
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    for (const key of ['preparedModels', 'preparedVariables', 'retiredModels', 'workspaceRevision']) {
      await expectAsync(service.validateGeneration(base.source, { [key]: [] } as any)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REQUEST_INVALID' }));
    }
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  const enableNativeProcedures = () => {
    const replay = enableNativeVariables();
    replay.steps.push({ kind: 'script', label: 'procedure-generators', source: `
      Arduino.forBlock.procedures_defnoreturn = block => {
        Arduino.addFunction(block.getFieldValue('NAME'), 'void ' + block.getFieldValue('NAME') + '() {\\n' + Arduino.statementToCode(block, 'STACK') + '}');
        return '';
      };
      Arduino.forBlock.procedures_defreturn = block => {
        Arduino.addFunction(block.getFieldValue('NAME'), 'int ' + block.getFieldValue('NAME') + '() { return ' + Arduino.valueToCode(block, 'RETURN', 0) + '; }');
        return '';
      };
      // Actual older library handlers use INPUT<n>; the shared adapter must also
      // run in the independent candidate, without changing its ARG<n> blocks.
      Arduino.forBlock.procedures_callnoreturn = block => block.getProcedureCall() + '(' + (block.arguments_ || []).map((_, index) => Arduino.valueToCode(block, 'INPUT' + index, 0)).join(',') + ');\\n';
      Arduino.forBlock.procedures_callreturn = block => [block.getProcedureCall() + '()', 0];
    ` });
    return replay;
  };

  it('prepares procedure parameter identities alongside unknown native blocks, then edits and reopens without new models', async () => {
    enableNativeProcedures(); editor.workspace.createVariable('amount', '', 'amount-id');
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\n'
      + '    @STACK:\n        native_commit_shape(B, $amount, "inside")\n'
      + 'procedures_callnoreturn() @extra:{"name":"work","params":["amount"]}\n    @ARG0:\n        math_number(5)\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    await service.applyGeneration(source, base.generation, {}, validation);
    const definition = editor.workspace.getBlocksByType('procedures_defnoreturn', false)[0];
    const state = nativeState(), parameter = definition.saveExtraState().params[0];
    expect(state.blocks.blocks[0].id).toBe(definition.id); // Same shared-first order as project save/reopen.
    expect(parameter).toEqual({ name: 'amount', id: 'amount-id', argId: 'abs_arg_0' });
    expect(definition.getInputTargetBlock('STACK').getInputTargetBlock('VALUE').getFieldValue('VAR')).toBe('amount-id');
    expect(state['variables']).toEqual([{ name: 'amount', id: 'amount-id' }]);
    const ids = editor.workspace.getAllBlocks(false).map(block => block.id).sort();
    const next = disk.get('project.abs')!.replace('"inside"', '"edited"');
    await service.applyGeneration(next, JSON.parse(disk.get('project.abs.map.json')!).generation);
    expect(editor.workspace.getAllBlocks(false).map(block => block.id).sort()).toEqual(ids);
    expect(editor.workspace.getBlockById(definition.id).saveExtraState().params[0]).toEqual(parameter);
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(nativeState()['variables']).toEqual(state['variables']);
    expect(editor.workspace.getBlockById(definition.id).getInputTargetBlock('STACK').getFieldValue('DETAIL')).toBe('edited');
    const withoutParam = splitAbsState(base.source).program + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[]}\n'
      + '    @STACK:\n        native_commit_shape(B, $amount, "edited")\nprocedures_callnoreturn() @extra:{"name":"work"}\n';
    await service.applyGeneration(withoutParam, JSON.parse(disk.get('project.abs.map.json')!).generation);
    expect(editor.workspace.getBlockById(definition.id).getField('abs_arg_0')).toBeNull();
    expect(nativeState()['variables']).toEqual(state['variables']);
  });

  it('verifies a host-prepared value call connected to a native parent even when the definition follows the call', async () => {
    enableNativeProcedures(); const base = await baseline();
    const source = base.source + '\nnative_commit_shape(B, procedures_callreturn() @extra:{"name":"read"}, "caller")\n'
      + 'procedures_defreturn(NAME="read")\n    @RETURN:\n        math_number(7)\n';
    await service.applyGeneration(source, base.generation);
    const parent = editor.workspace.getBlocksByType('native_commit_shape', false)[0];
    expect(parent.getInputTargetBlock('VALUE').type).toBe('procedures_callreturn');
    expect(editor.workspace.getAllVariables()).toEqual([]);
    expect(editor.workspace.getBlocksByType('procedures_defreturn', false).length).toBe(1);
  });

  for (const signature of [
    '{"params":[{"name":"missing"}]}', '{"params":[{"name":"amount","id":"forged"}]}', '{"hidden":true}',
  ]) it(`rejects invalid prepared procedure intent in a mixed candidate: ${signature}`, async () => {
    enableNativeProcedures(); editor.workspace.createVariable('amount', '', 'amount-id');
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_commit_shape(B, math_number(1), "native")\nprocedures_defnoreturn(NAME="work") @extra:' + signature;
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROCEDURE_INVALID' }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('still executes hosted generators and rejects their unowned child blocks before any host mutation', async () => {
    const replay = enableNativeProcedures();
    replay.steps.push({ kind: 'script', label: 'unowned-procedure-child', source: `
      Arduino.forBlock.procedures_defnoreturn = block => { block.workspace.newBlock('math_number'); return ''; };
    ` });
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_commit_shape(B, math_number(1), "native")\nprocedures_defnoreturn(NAME="work")';
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  for (const call of ['procedures_callnoreturn() @extra:{"name":"work"}', 'procedures_callreturn() @extra:{"name":"missing"}']) {
    it(`does not accept an invalid cross-boundary procedure edge: ${call}`, async () => {
      enableNativeProcedures(); const base = await baseline(), before = absJson(nativeState()), files = [...disk];
      const source = base.source + '\nnative_commit_shape(B, ' + call + ', "native")\nprocedures_defnoreturn(NAME="work")';
      await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
      expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    });
  }

  it('creates native dynamic blocks using existing variables without changing model identity', async () => {
    enableNativeVariables();
    editor.workspace.createVariable('counter', '', 'counter-id');
    const base = await baseline();
    const source = base.source + '\nnative_commit_shape(A, $counter)\n';
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    const created = editor.workspace.getBlocksByType('native_commit_shape', false)[0];
    expect(created.getInputTargetBlock('VALUE').getFieldValue('VAR')).toBe('counter-id');
    expect(nativeState()['variables']).toEqual([{ id: 'counter-id', name: 'counter' }]);
  });

  it('rejects ownerless explicit allocation before native binding without changing the workspace or files', async () => {
    enableNativeVariables();
    const base = await baseline();
    const source = base.source + '\nnative_commit_shape(A, variables_get($counter))\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      createVariables: [{ name: 'counter' }], candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const files = [...disk];
    await expectAsync(service.validateGeneration(source, request)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INTENT_UNOWNED' }));
    expect(editor.workspace.getAllVariables().length).toBe(0);
    expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  const enableNativeDeclarations = () => {
    const replay = enableNativeVariables();
    const definitions = [
      { type: 'native_model_owner', message0: '%1', args0: [{ type: 'input_statement', name: 'BODY' }] },
      // Deliberately value-before-type, not a hardcoded variable_define argument order.
      { type: 'native_model_declare', message0: '%1 %2 %3', args0: [
        { type: 'field_input', name: 'NAME', text: 'unused' }, { type: 'input_value', name: 'VALUE' },
        { type: 'field_dropdown', name: 'TYPE', options: [['int', 'int'], ['float', 'float']] },
      ], previousStatement: null, nextStatement: null },
    ];
    definitions.forEach(declare);
    replay.steps.push({ kind: 'definitions', definitions });
    replay.steps.push({ kind: 'script', label: 'declaration-generator', source: `
      Arduino.forBlock.native_model_owner = block => Arduino.statementToCode(block, 'BODY');
      Arduino.forBlock.native_model_declare = block => {
        block.workspace.createVariable(block.getFieldValue('NAME'), '');
        return block.getFieldValue('TYPE') + ' ' + block.getFieldValue('NAME') + ' = ' + Arduino.valueToCode(block, 'VALUE', 0) + ';\\n';
      };
    ` });
    // Test-only attestation. Production still verifies loaded source/handler/shape provenance.
    editor.captureDeclarativeBlockDefinitions = () => ({ ...catalog.capture(Blockly.Blocks), variableDeclarations: {
      assertCurrent() {}, get: type => type === 'native_model_declare'
        ? { nameField: 'NAME', nativeType: '', owner: { type: 'native_model_owner', input: 'BODY' } } : undefined,
    } });
    return replay;
  };
  const nativeDeclaration = 'native_model_declare("counter", math_number(7), int)';

  for (const forward of [true, false]) it(`prepares declaration models before native binding (${forward ? 'forward' : 'backward'} reference), then applies/reopens once`, async () => {
    enableNativeDeclarations();
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const consumer = 'native_commit_shape(B, $counter, "detail")';
    const body = forward ? [consumer, nativeDeclaration] : [nativeDeclaration, consumer];
    const source = base.source + '\nnative_model_owner()\n    ' + body.join('\n    ') + '\n';
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const validation = await service.validateGeneration(source, request);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect((await service.applyGeneration(source, base.generation, {}, validation)).publication.status).toBe('COMMITTED');
    const model = editor.workspace.getAllVariables()[0], models = nativeState()['variables'];
    expect(editor.workspace.getAllVariables().length).toBe(1); expect(model.name).toBe('counter');
    const block = editor.workspace.getBlocksByType('native_commit_shape', false)[0];
    expect(block.getInputTargetBlock('VALUE').getFieldValue('VAR')).toBe(model.getId());
    const ids = editor.workspace.getAllBlocks(false).map(block => block.id).sort();
    const second = disk.get('project.abs')!.replace('"detail"', '"changed"');
    expect((await service.applyGeneration(second, JSON.parse(disk.get('project.abs.map.json')!).generation)).publication.status).toBe('COMMITTED');
    expect(nativeState()['variables']).toEqual(models);
    expect(editor.workspace.getAllBlocks(false).map(block => block.id).sort()).toEqual(ids);
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(nativeState()['variables']).toEqual(models);
    expect(editor.workspace.getBlockById(block.id).getInputTargetBlock('VALUE').getFieldValue('VAR')).toBe(model.getId());
    expect(roots().isDeletable()).toBeFalse();
  });

  for (const invalid of [
    { source: 'native_model_owner()\n    ' + nativeDeclaration + '\n    ' + nativeDeclaration, code: 'ABS_DECLARATION_DUPLICATE' },
    { source: nativeDeclaration, code: 'ABS_DECLARATION_SCOPE_UNSUPPORTED' },
  ]) it(`never commits tentative models when authoritative planning rejects ${invalid.code}`, async () => {
    enableNativeDeclarations();
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_commit_shape(A, $counter)\n' + invalid.source;
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejectedWith(jasmine.objectContaining({ code: invalid.code }));
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('does not turn a declaration rename or a misspelled reference into model creation in a mixed native edit', async () => {
    enableNativeDeclarations();
    const base = await baseline();
    const source = base.source + '\nnative_model_owner()\n    ' + nativeDeclaration + '\n    native_commit_shape(B, $counter, "detail")';
    await service.applyGeneration(source, base.generation);
    const before = absJson(nativeState()), files = [...disk], saved = disk.get('project.abs')!;
    const generation = JSON.parse(disk.get('project.abs.map.json')!).generation;
    for (const bad of [splitAbsState(saved).program.replaceAll('counter', 'renamed'), saved.replace('$counter', '$typo')]) {
      await expectAsync(service.applyGeneration(bad, generation)).toBeRejected();
      expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    }
  });

  it('requires ordinary declaration preparation instead of a redundant explicit model intent', async () => {
    enableNativeDeclarations();
    const base = await baseline();
    const source = base.source + '\nnative_commit_shape(B, variables_get($counter), "detail")\nnative_model_owner()\n    ' + nativeDeclaration;
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    const { generationEvidence } = await import('./abs-generation-protocol');
    const request = { version: 2 as const, requestId: crypto.randomUUID(), base: (await generationEvidence(committed, disk.get('project.abi') ?? null)).binding,
      createVariables: [{ name: 'counter' }], candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    await expectAsync(service.validateGeneration(source, request)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_INTENT_UNOWNED' }));
    expect(editor.workspace.getAllVariables()).toEqual([]);
  });

  it('does not bootstrap declarations without provenance or adopt an incompatible existing model', async () => {
    enableNativeDeclarations();
    const base = await baseline(), before = absJson(nativeState()), files = [...disk];
    const source = base.source + '\nnative_commit_shape(B, $counter, "detail")\nnative_model_owner()\n    ' + nativeDeclaration;
    const capture = editor.captureDeclarativeBlockDefinitions;
    editor.captureDeclarativeBlockDefinitions = () => catalog.capture(Blockly.Blocks);
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    editor.captureDeclarativeBlockDefinitions = capture;
    editor.workspace.createVariable('counter', 'typed', 'existing-typed');
    const typed = await baseline(), typedBefore = absJson(nativeState()), typedFiles = [...disk];
    const next = typed.source + '\nnative_commit_shape(B, $counter, "detail")\nnative_model_owner()\n    ' + nativeDeclaration;
    await expectAsync(service.applyGeneration(next, typed.generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DECLARATION_MODEL_CONFLICT' }));
    expect(absJson(nativeState())).toBe(typedBefore); expect([...disk]).toEqual(typedFiles);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('hydrates compact large values for native binding and preserves external-only storage through apply/reload', async () => {
    enableNative();
    const text = 'native resource payload '.repeat(2200);
    const ref = await projectDataRuntime.put({ codec: 'utf8-v1', storage: 'raw-v1', value: text });
    const base = await baseline(), compact = JSON.stringify(createAilyProjectDataValue(ref));
    const source = base.source + `\nnative_commit_shape(B, math_number(7), ${compact})\n`;
    expect((await service.applyGeneration(source, base.generation)).publication.status).toBe('COMMITTED');
    const id = editor.workspace.getBlocksByType('native_commit_shape', false)[0].id;
    expect(editor.workspace.getBlockById(id).getFieldValue('DETAIL')).toBe(text);
    expect(disk.get('project.abs')).toContain('$ailyProjectDataValue');
    expect(disk.get('project.abs')).not.toContain(text); expect(disk.get('project.abi')).not.toContain(text);
    const generation = JSON.parse(disk.get('project.abs.map.json')!).generation;
    const next = disk.get('project.abs')!.replace(/math_number\((?:NUM=)?7\)/, 'math_number(8)');
    expect((await service.applyGeneration(next, generation)).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById(id).getFieldValue('DETAIL')).toBe(text);
    expect(editor.workspace.getBlockById(id).getInputTargetBlock('VALUE').getFieldValue('NUM')).toBe(8);
    expect(values.get(ref.$ailyData.id)).toBe(text);
  });

  it('fails native preparation on a missing resource without saving or loading the host workspace', async () => {
    enableNative();
    const ref = await projectDataRuntime.put({ codec: 'utf8-v1', storage: 'raw-v1', value: 'missing'.repeat(6000) });
    values.delete(ref.$ailyData.id);
    const base = await baseline(), before = absJson(nativeState()), originalDisk = [...disk];
    const source = base.source + `\nnative_commit_shape(B, null, ${JSON.stringify(createAilyProjectDataValue(ref))})\n`;
    await expectAsync(service.applyGeneration(source, base.generation)).toBeRejectedWithError(/missing resource/);
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(originalDisk);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  for (const chunk of [false, true]) it(`preserves binary media through native create/edit/save/reopen (chunk=${chunk})`, async () => {
    const replay = enableNative();
    if (chunk) renderWorkspace();
    const definition = { type: 'native_commit_media', message0: '%1', args0: [
      { type: 'field_bitmap_u8g2', name: 'DATA', width: 8, height: 1 },
    ], output: 'Bitmap' };
    declare(definition);
    replay.steps.push({ kind: 'definitions', definitions: [definition] }, { kind: 'script', label: 'media-codegen', source: `
      Arduino.forBlock.native_commit_media = block => {
        const pixels = block.getFieldValue('DATA');
        if (pixels[0][0] !== 1 || pixels[0][7] !== 1) throw Error('Binary bytes lost');
        return ['0', 0];
      };` });
    const ref: any = { $ailyData: { schemaVersion: 1, id: 'sha256:' + 'c'.repeat(64), codec: 'u8g2-xbm-v1',
      logicalType: 'binary', storage: 'raw-v1', rawLength: 1, storedLength: 1 } };
    values.set(ref.$ailyData.id, new Uint8Array([129]));
    const field = { schemaVersion: 1, encoding: 'xbm-lsb-row-v1', width: 8, height: 1, bitmap: ref };
    const base = await baseline(), source = base.source + `\nnative_commit_shape(B, math_number(7), "detail")\nnative_commit_media(${JSON.stringify(field)})\n`;
    expect((await service.applyGeneration(source, base.generation, { chunk })).publication.status).toBe('COMMITTED');
    const id = editor.workspace.getBlocksByType('native_commit_media', false)[0].id;
    expect(editor.workspace.getBlockById(id).getFieldValue('DATA')).toEqual(field);
    const next = await baseline();
    expect((await service.applyGeneration(next.source.replace('"detail"', '"edited"'), next.generation, { chunk })).publication.status).toBe('COMMITTED');
    const state = nativeState(), persisted = JSON.parse(disk.get('project.abi')!);
    editor.restoreProjectWorkspaceSnapshot(persisted);
    expect(nativeState()).toEqual(state); expect(roots().isDeletable()).toBeFalse();
    expect(editor.workspace.getBlockById(id).getFieldValue('DATA')).toEqual(field);
    expect(values.get(ref.$ailyData.id)).toEqual(new Uint8Array([129]));
    const again = await baseline(), files = [...disk], before = absJson(nativeState());
    values.delete(ref.$ailyData.id);
    // Force native shape discovery; the fixture's fast-path resource port is a stub.
    const missing = again.source.replace(/native_commit_shape\([^\n]+/, 'native_commit_shape(A, math_number(7))');
    expect(missing).not.toBe(again.source);
    await expectAsync(service.applyGeneration(missing, again.generation, { chunk })).toBeRejectedWithError(/missing resource/);
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(before);
  });

  it('discovers scoped capabilities without storage, generation, block creation or mutation', () => {
    const before = absJson(nativeState()), probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const report = new AbsGenerationToolsService(service).capabilities({ version: 1, type: 'abs_declared_text' });
    expect(report.scope).toEqual(scope); expect(report.blocks.length).toBe(1); expect(report.blocks[0].level).toBe('create');
    expect(report.runtimeRevision).toBeGreaterThanOrEqual(0); expect(absJson(nativeState())).toBe(before);
    expect(disk.size).toBe(0); expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    editor.blockTypeToLibMap.set('abs_declared_text', { name: 'unique-library' });
    expect(service.describeCapabilities({ version: 1, filter: 'unique-library' }).blocks.map(block => block.type)).toEqual(['abs_declared_text']);
    editor.switchPage('other');
    expect(service.describeCapabilities({ version: 1, type: 'abs_declared_text' }).scope.pageId).toBe('other');
  });

  it('offers native validation only with a current complete replay, without probing blocks', () => {
    const replay = enableNative(), probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const describe = () => service.describeCapabilities({ version: 1, type: 'native_commit_shape' }).blocks[0];
    expect(describe().level).toBe('validate');
    expect((describe() as any).contract).toBe('native-sync-v1');
    expect(probe).not.toHaveBeenCalled(); expect(disk.size).toBe(0);
    replay.steps.push({ kind: 'script', label: 'unsupported', source: 'async function later() {}' });
    expect(describe().level).toBe('preserve-only');
    replay.steps.pop(); replay.assertCurrent.and.throwError('stale');
    expect(describe().level).toBe('preserve-only');
    expect(service.describeCapabilities({ version: 1, type: 'missing' }).blocks[0].level).toBe('unavailable');
  });

  it('batches current instance advice without constructing blocks or granting creation authority', async () => {
    enableNative();
    editor.workspace.newBlock('native_commit_shape').setFieldValue('A', 'MODE');
    editor.workspace.newBlock('native_commit_shape').setFieldValue('B', 'MODE');
    const base = await baseline();
    const committed = await new AbsBaselineStore(port, scope).loadCommitted();
    const index = new AbsBlockContextIndex(committed!);
    editor.describeCommittedAbsSyntax.and.callFake(types => index.describeSyntax(types));
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const before = absJson(nativeState()), files = [...disk];
    const report = service.describeCapabilities({ version: 1, types: ['native_commit_shape', 'missing'] });
    expect(report.blocks.map(block => block.type)).toEqual(['native_commit_shape', 'missing']);
    expect(report.blocks[0].level).toBe('validate');
    expect((report.instanceSyntax as any).generation).toBe(base.generation);
    expect((report.instanceSyntax as any).authority).toBeFalse();
    const variants = (report.instanceSyntax as any).variants;
    expect(variants.length).toBe(2);
    expect(variants.find(item => item.selectors.MODE === 'B').argsOrder.map(arg => arg.name)).toEqual(['MODE', 'VALUE', 'DETAIL']);
    expect(editor.describeCommittedAbsSyntax).toHaveBeenCalledOnceWith(['native_commit_shape', 'missing']);
    expect(probe).not.toHaveBeenCalled(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(absJson(nativeState())).toBe(before); expect([...disk]).toEqual(files);
    editor.describeCommittedAbsSyntax.and.returnValue(undefined);
    expect(service.describeCapabilities({ version: 1, type: 'abs_sync_root' }).instanceSyntax).toEqual({
      scope: 'unavailable', reason: 'no-current-committed-snapshot' });
  });

  it('rejects malformed capability requests and missing runtime context', () => {
    for (const query of [{}, { version: 2 }, { version: 1, type: '' }, { version: 1, filter: [] },
      { version: 1, type: 'x', filter: 'y' }, { version: 1, execute: true }, { version: 1, types: [] },
      { version: 1, types: ['x', 'x'] }, { version: 1, types: [1] }, { version: 1, types: ['x'], type: 'x' },
      { version: 1, types: Array.from({ length: 17 }, (_, i) => 't' + i) }]) expect(() => service.describeCapabilities(query)).toThrow();
    project.currentProjectPath = '';
    expect(() => service.describeCapabilities({ version: 1 })).toThrow();
  });

  it('exports protection and opaque state in one complete ABS snapshot with a derived ABI', async () => {
    const original = absJson(nativeState()); const base = await baseline();
    expect(disk.has('project.abi')).toBeTrue(); expect(absJson(nativeState())).toBe(original);
    expect(splitAbsState(base.source).program).not.toContain('opaque');
    expect((await decodeAbsState(base.source)).workspace.blocks.blocks[0]['data']).toBe('opaque');
    expect(base.source).toContain('@protect:{"deletable":false,"movable":false}');
    const stored = await new AbsBaselineStore(port, scope).loadCommitted();
    expect(stored!.workspace.blocks.blocks[0]['deletable']).toBeFalse();
    expect((stored!.document as any).pages[1].custom).toEqual({ preserved: true });
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('records hidden fallback changes in complete ABS while keeping the readable program unchanged', async () => {
    const original = await baseline(), originalDocument = absJson(editor.captureProjectSnapshot().document);
    const connection = roots().getInput('VALUE').connection;
    const shadow = connection.getShadowState();
    expect(shadow.fields.NUM).toBe(2);
    connection.setShadowState({ ...shadow, fields: { NUM: 99 } });
    const current = await baseline();
    expect(current.source).not.toBe(original.source);
    expect(splitAbsState(current.source).program).toBe(splitAbsState(original.source).program);
    expect((await decodeAbsState(original.source)).workspace.blocks.blocks[0].inputs!['VALUE'].shadow!.fields!['NUM']).toBe(2);
    expect((await decodeAbsState(current.source)).workspace.blocks.blocks[0].inputs!['VALUE'].shadow!.fields!['NUM']).toBe(99);
    expect(absJson(editor.captureProjectSnapshot().document)).not.toBe(originalDocument);
    // Applying a candidate uses its current baseline; full history restoration uses the complete snapshot.
    expect((await service.applyGeneration(current.source, current.generation)).publication.status).toBe('COMMITTED');
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    roots().getInputTargetBlock('VALUE').dispose(false);
    const fallback = roots().getInputTargetBlock('VALUE');
    expect(fallback.id).toBe('dormant');
    expect(fallback.isShadow()).toBeTrue();
    expect(fallback.getFieldValue('NUM')).toBe(99);
  });

  const wireBase = async () => {
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
    const tools = new AbsGenerationToolsService(service);
    const exported: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(disk.get('project.abi')!) });
    expect(exported.ok).withContext(JSON.stringify(exported)).toBeTrue();
    const source = exported.abs.replace('TEXT="before"', 'TEXT="wire edit"');
    const request = { version: 2, requestId: crypto.randomUUID(), base: exported.receipt.base,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    editor.prepareProjectCode.calls.reset();
    (project.publishPreparedSaveOutputs as jasmine.Spy).calls.reset();
    return { tools, exported, source, request };
  };

  for (const failureAt of ['preparation', 'generation', 'rollback', 'commit'] as const)
    it(`reports the proven application boundary after ${failureAt} failure, without guessing from an error code`, async () => {
      const { tools, request, source } = await wireBase();
      const validated: any = await tools.execute('abs_validate', request, source);
      expect(validated.ok).toBeTrue();
      const before = absJson(nativeState()), abi = disk.get('project.abi');
      if (failureAt === 'preparation') {
        spyOn<any>(service, 'prepareApplication').and.rejectWith(Object.assign(new Error('injected preparation timeout'), { code: 'ABS_NATIVE_TIMEOUT' }));
      } else if (failureAt === 'commit') {
        const lock = port.withLock;
        spyOn(port, 'withLock').and.callFake(async operation => {
          const result = await lock(operation);
          if (disk.get('project.abi') !== abi) throw Error('lost commit acknowledgement');
          return result;
        });
      } else {
        // Even a generator reusing the native timeout code cannot claim that no apply occurred.
        editor.prepareProjectCode.and.rejectWith(Object.assign(new Error('injected generator failure'), { code: 'ABS_NATIVE_TIMEOUT' }));
        if (failureAt === 'rollback') editor.restoreProjectWorkspaceSnapshot.and.throwError('rollback failed');
      }
      const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
      expect(result.ok).toBeFalse();
      const known = failureAt === 'preparation' || failureAt === 'generation';
      expect(result.publication.status).toBe(known ? 'NOT_COMMITTED' : 'UNKNOWN');
      expect(result.application.status).toBe(failureAt === 'preparation' ? 'NOT_STARTED' : failureAt === 'generation' ? 'ROLLED_BACK' : 'UNKNOWN');
      if (known) {
        expect(absJson(nativeState())).toBe(before); expect(disk.get('project.abi')).toBe(abi);
        expect(gate.blocked).toBeFalse();
      } else expect(gate.blocked).toBeTrue();
      expect(editor.restoreProjectWorkspaceSnapshot.calls.count()).toBe(failureAt === 'generation' || failureAt === 'rollback' ? 1 : 0);
    });

  it('rejects an over-budget whole ABS candidate without partially applying or rewriting its draft', async () => {
    enableNative();
    editor.workspace.getVariableMap().createVariable('retained model', '', 'retained-model');
    const { tools, exported } = await wireBase();
    const source = exported.abs + '\n' + Array(NATIVE_CANDIDATE_LIMITS.blocks + 1).fill('math_number(7)').join('\n');
    disk.set('project.abs', source);
    const request = { version: 2, requestId: crypto.randomUUID(), base: exported.receipt.base,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const files = [...disk], state = absJson(editor.captureProjectSnapshot().document), resources = [...values];
    const result: any = await tools.execute('abs_validate', request, source);
    expect(result.code).withContext(JSON.stringify(result)).toBe('ABS_LIMIT');
    expect(result.diagnostic.capacity.actual).toBeGreaterThan(NATIVE_CANDIDATE_LIMITS.blocks);
    expect(result.diagnostic.capacity.limit).toBe(NATIVE_CANDIDATE_LIMITS.blocks);
    expect(result.recovery).toContain('local Blockly library'); expect(result.receipt).toBeUndefined();
    expect([...disk]).toEqual(files); expect([...values]).toEqual(resources);
    expect(absJson(editor.captureProjectSnapshot().document)).toBe(state);
    expect(roots().isDeletable()).toBeFalse(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(gate.blocked).toBeFalse(); expect(await service.inspectRecovery()).toBeNull();
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });

  it('keeps candidate, mirrors and live blocks intact when native asset loading fails', async () => {
    // A cold renderer origin: another test may already have verified its build.
    spyOnProperty(document, 'baseURI', 'get').and.returnValue('http://cold-native-coordinator.invalid/');
    enableNative();
    const { tools, exported } = await wireBase();
    const source = exported.abs + '\nnative_commit_shape(B, math_number(7), "detail")';
    const request = { version: 2, requestId: crypto.randomUUID(), base: exported.receipt.base,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const files = [...disk], state = absJson(nativeState());
    const fetch = spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));
    const result: any = await tools.execute('abs_validate', request, source);
    expect(result.code).withContext(JSON.stringify(result)).toBe('ABS_NATIVE_ASSET_UNAVAILABLE');
    expect(result.diagnostic.resource.url).toContain('/blockly/runtime/native-candidate.js');
    expect(result.receipt).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(await service.inspectRecovery()).toBeNull(); expect(gate.blocked).toBeFalse();
  });

  const prepareTurn = async (tools: AbsGenerationToolsService, extra = {}) => tools.execute('abs_projection', {
    version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(disk.get('project.abi')!),
    publish: true, reuseCurrent: true, synchronize: true, ...extra,
  }) as Promise<any>;

  it('wire receipts bind blank-project retirement through native validation, apply and saved readback', async () => {
    const replay = enableObjectModels();
    const definitions = ['arduino_global', 'arduino_setup', 'arduino_loop'].map(type => ({ type, message0: type }));
    definitions.forEach(declare);
    replay.steps.push({ kind: 'definitions', definitions }, { kind: 'script', label: 'empty-roots',
      source: definitions.map(({ type }) => `Arduino.forBlock.${type} = () => '';`).join('\n') });
    editor.restoreProjectWorkspaceSnapshot({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'Main', content: { blocks: { blocks: definitions.map(({ type }) => ({ type, id: type, deletable: false })) } } }],
      sharedModel: { procedureBlocks: [], variables: [{ id: 'old-sensor', name: 'sensor', type: 'OldDriver' }] } });
    const { tools, exported } = await wireBase();
    const source = exported.abs + '\ntest_object_init("sensor", Sensor)\ntest_object_read($sensor)';
    const request = { version: 2, requestId: crypto.randomUUID(), base: exported.receipt.base,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const files = [...disk], original = absJson(nativeState());
    const validated: any = await tools.execute('abs_validate', request, source);
    expect(validated.ok).withContext(JSON.stringify(validated)).toBeTrue();
    expect(validated.receipt.retiredModels).toEqual(['old-sensor']);
    expect(validated.receipt.preparedModels[0].name).toBe('sensor');
    expect(validated.receipt.preparedModels[0].id).not.toBe('old-sensor');
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(original);
    for (const retired of [undefined, ['forged']]) {
      const validation = { ...validated.receipt, retiredModels: retired };
      if (retired === undefined) delete validation.retiredModels;
      const failed: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation }, source);
      expect(failed.code).withContext(JSON.stringify(failed)).toBe('ABS_MODEL_DECLARATION_CHANGED');
      expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(original);
    }
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(applied.ok).withContext(JSON.stringify(applied)).toBeTrue();
    expect(applied.receipt.retiredModels).toEqual(['old-sensor']);
    const saved = JSON.parse(disk.get('project.abi')!);
    expect(saved.sharedModel.variables).toEqual([jasmine.objectContaining({ id: validated.receipt.preparedModels[0].id, name: 'sensor', type: 'Sensor' })]);
    editor.restoreProjectWorkspaceSnapshot(saved);
    expect(editor.workspace.getAllVariables().map(model => model.getId())).toEqual([validated.receipt.preparedModels[0].id]);
  });

  for (const draft of [false, true]) it(`does not mistake load normalization for an external disk edit; draft=${draft}`, async () => {
    const saved = structuredClone(editor.captureProjectSnapshot().document);
    delete saved.sharedModel;
    disk.set('project.abi', absJson(saved));
    const tools = new AbsGenerationToolsService(service);
    const exported: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(),
      expectedAbiHash: await hashAbsText(disk.get('project.abi')!) });
    expect(exported.ok).withContext(JSON.stringify(exported)).toBeTrue();
    editor.prepareProjectCode.calls.reset();
    if (draft) disk.set('project.abs', exported.abs + '\n# unfinished intent');
    const files = [...disk], state = absJson(nativeState());
    const result = await inspect(tools);
    expect(result.ok).toBeTrue();
    expect(result.diagnostics.workspace).toEqual({ changedFromBaseline: false, savedChangedFromBaseline: false, matchesSaved: true });
    expect(result.diagnostics.issues).toEqual(draft ? ['ABS_SOURCE_CONFLICT'] : []);
    if (draft) expect(result.diagnostics.draft.canValidate).toBeTrue();
    else expect(result.diagnostics.status).toBe('ready');
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('does not mistake ABI JSON formatting for an external program edit', async () => {
    const { tools } = await wireBase();
    disk.set('project.abi', JSON.stringify(JSON.parse(disk.get('project.abi')!), null, 2));
    const files = [...disk], result = await inspect(tools);
    expect(result.diagnostics.status).toBe('ready');
    expect(result.diagnostics.workspace.savedChangedFromBaseline).toBeFalse();
    expect([...disk]).toEqual(files);
  });

  for (const canvasChanged of [false, true]) it(`diagnoses external disk edits without guessing authority; canvasChanged=${canvasChanged}`, async () => {
    const { tools } = await wireBase();
    const saved = JSON.parse(disk.get('project.abi')!);
    saved.pages[0].content.blocks.blocks[0].fields.TEXT = 'external edit';
    disk.set('project.abi', absJson(saved));
    if (canvasChanged) roots().setFieldValue('unsaved canvas edit', 'TEXT');
    const files = [...disk], state = absJson(nativeState());
    const result = await inspect(tools);
    expect(result.ok).toBeTrue();
    expect(result.diagnostics.workspace).toEqual({ changedFromBaseline: canvasChanged, savedChangedFromBaseline: true, matchesSaved: false });
    expect(result.diagnostics.issues).toContain('ABS_DUAL_EDIT_CONFLICT');
    expect(result.diagnostics.refresh).toBeUndefined();
    expect([...disk]).toEqual(files); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  for (const synchronize of [false, true]) it(`exports a changed canvas with input and output receipts; turn synchronization=${synchronize}`, async () => {
    const { tools, exported, request, source } = await wireBase();
    roots().setFieldValue('manual user change', 'TEXT');
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.status).toBe('blocked');
    expect(diagnosis.diagnostics.issues).toContain('ABS_BASELINE_STALE');
    const oldHash = await hashAbsText(disk.get('project.abi')!);
    const result = await prepareTurn(tools, { synchronize });
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.synchronized === true).toBe(synchronize); expect(result.receipt.inputAbiHash).toBe(oldHash);
    expect(result.publication.abiSaved).toBeTrue(); expect(result.requiresReload).toBeFalse();
    expect(result.receipt.base.abiHash).toBe(await hashAbsText(disk.get('project.abi')!));
    expect(result.receipt.base.generation).not.toBe(exported.receipt.base.generation);
    expect(result.abs).toContain('manual user change');
    expect(roots().isDeletable()).toBeFalse();
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    expect((await tools.execute('abs_validate', request, source) as any).code).toBe('ABS_BASELINE_STALE');
    const candidate = result.abs.replace('manual user change', 'manual user change plus requested fix');
    const validation: any = await tools.execute('abs_validate', { version: 2, requestId: crypto.randomUUID(),
      base: result.receipt.base, candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } }, candidate);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    const before = [...disk], next = await prepareTurn(tools);
    expect(next.reused).toBeTrue(); expect([...disk]).toEqual(before);
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
  });

  it('reproduces 67 old blocks becoming 3 empty protected roots without a recovery prerequisite', async () => {
    editor.workspace.clear();
    declare({ type: 'abs_turn_root', message0: 'root %1', args0: [{ type: 'input_statement', name: 'BODY' }] });
    declare({ type: 'abs_turn_statement', message0: 'run', previousStatement: null, nextStatement: null });
    let chain: any;
    for (let n = 0; n < 64; n++) chain = { type: 'abs_turn_statement', id: `statement-${n}`, ...(chain ? { next: { block: chain } } : {}) };
    const empty = [0, 1, 2].map(n => ({ type: 'abs_turn_root', id: `root-${n}`, deletable: false }));
    Blockly.serialization.workspaces.load({ blocks: { blocks: empty.map((root, n) => n ? root : { ...root, inputs: { BODY: { block: chain } } }) } }, editor.workspace);
    expect(editor.workspace.getAllBlocks(false).length).toBe(67);
    const { tools } = await wireBase();
    Blockly.serialization.workspaces.load({ blocks: { blocks: empty } }, editor.workspace);
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toContain('ABS_RUNTIME_CONTRACT_STALE');
    const result = await prepareTurn(tools);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.abs.match(/abs_turn_root\(/g)?.length).toBe(3);
    expect(result.abs).not.toContain('abs_turn_statement');
    const saved = composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main');
    expect(saved.blocks.blocks.length).toBe(3);
    expect(saved.blocks.blocks.every(block => block.deletable === false)).toBeTrue();
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('reuses unchanged or viewport-only snapshots without regenerating user-visible C++', async () => {
    const { tools, exported } = await wireBase();
    editor.setViewState({ scale: 0.5, scrollX: 20, scrollY: 30 });
    const before = [...disk], result = await prepareTurn(tools);
    expect(result.ok).toBeTrue(); expect(result.reused).toBeTrue();
    expect(result.receipt.base).toEqual(exported.receipt.base); expect([...disk]).toEqual(before);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
  });

  it('allows viewport settling after turn synchronization prepares code', async () => {
    const { tools } = await wireBase(); roots().setFieldValue('manual change', 'TEXT');
    const prepare = project.prepareSave.bind(project);
    let count = 0;
    spyOn(project, 'prepareSave').and.callFake(async (...args) => {
      if (++count === 2) editor.setViewState({ scale: 0.5, scrollX: 20, scrollY: 30 });
      return prepare(...args);
    });
    const result = await prepareTurn(tools);
    expect(count).toBe(2); expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.publication.abiSaved).toBeTrue(); expect(result.abs).toContain('manual change');
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    expect(editor.publishAbsContext.calls.mostRecent().args[1]).toBe(editor.captureProjectSnapshot().revision);
    expect(gate.blocked).toBeFalse(); expect(await service.inspectRecovery()).toBeNull();
  });

  it('refreshes changed runtime contracts without treating a clean projection as a stale draft', async () => {
    const { tools, exported } = await wireBase(), abi = disk.get('project.abi');
    (editor.workspace.getBlockById('child').getField('NUM') as Blockly.FieldNumber).setMax(10);
    expect((await inspect(tools)).diagnostics.issues).toContain('ABS_RUNTIME_CONTRACT_STALE');
    const result = await prepareTurn(tools);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.base.generation).not.toBe(exported.receipt.base.generation);
    expect(disk.get('project.abi')).toBe(abi); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('accepts an already saved manual change when saved ABI and current canvas agree', async () => {
    const { tools } = await wireBase(); roots().setFieldValue('manually saved change', 'TEXT');
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
    const abi = disk.get('project.abi'), result = await prepareTurn(tools);
    expect(result.ok).toBeTrue(); expect(result.abs).toContain('manually saved change');
    expect(result.publication.abiSaved).toBeTrue(); expect(JSON.parse(disk.get('project.abi')!)).toEqual(JSON.parse(abi!));
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  for (const conflict of ['draft', 'map', 'scope', 'external-abi']) it(`preserves genuine ${conflict} conflicts before turn save`, async () => {
    const { tools } = await wireBase();
    roots().setFieldValue('manual change', 'TEXT');
    if (conflict === 'draft') disk.set('project.abs', disk.get('project.abs')! + '\n# unfinished intent');
    if (conflict === 'map') disk.set('project.abs.map.json', 'damaged');
    if (conflict === 'scope') project.currentProjectPath = 'D:/other-project';
    if (conflict === 'external-abi') disk.set('project.abi', '{"external":true}');
    const before = [...disk], result = await prepareTurn(tools);
    expect(result.ok).toBeFalse();
    expect(result.code).toBe({ draft: 'ABS_SOURCE_CONFLICT', map: 'ABS_MAP_INVALID', scope: 'ABS_SCOPE_INVALID', 'external-abi': 'ABS_DUAL_EDIT_CONFLICT' }[conflict]);
    expect([...disk]).toEqual(before); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('initializes absent mirrors from current canvas without legacy replacement authority', async () => {
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
    roots().setFieldValue('first turn canvas', 'TEXT');
    const result = await prepareTurn(new AbsGenerationToolsService(service));
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue(); expect(result.abs).toContain('first turn canvas');
  });

  it('keeps concurrent disk edits instead of saving over them during turn preparation', async () => {
    const { tools } = await wireBase(), original = disk.get('project.abs');
    roots().setFieldValue('canvas edit', 'TEXT');
    editor.prepareProjectCode.and.callFake(async () => { disk.set('project.abi', '{"external":true}'); return null; });
    const result = await prepareTurn(tools);
    expect(result.ok).toBeFalse(); expect(disk.get('project.abi')).toBe('{"external":true}');
    expect(disk.get('project.abs')).toBe(original); expect(disk.has('prepared.json')).toBeFalse();
  });

  it('captures legitimate synchronous generator model changes before sealing the saved revision', async () => {
    const { tools } = await wireBase(); roots().setFieldValue('manual change', 'TEXT');
    editor.prepareProjectCode.and.callFake(async (assertCurrent, lease) => {
      assertCurrent(); editor.mutateOtherPage(); assertCurrent();
      return { revision: editor.captureProjectSnapshot(lease).revision, code: null, artifacts: null, blockCodeMapText: null,
        error: 'diagnostic retained without discarding editable blocks' };
    });
    const result = await prepareTurn(tools);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.warnings[0]).toContain('diagnostic retained');
    expect(JSON.parse(disk.get('project.abi')!).pages[1].custom.preserved).toBeFalse();
  });

  it('keeps a partial turn publication recoverable and blocks a second preparation', async () => {
    const { tools } = await wireBase();
    roots().setFieldValue('manual change', 'TEXT'); failWrite = 'project.abs.map.json';
    const result = await prepareTurn(tools);
    expect(result.ok).toBeFalse(); expect(result.requiresReload).toBeTrue();
    expect(result.publication.abiSaved).toBeTrue(); expect(disk.has('prepared.json')).toBeTrue();
    const before = [...disk]; expect((await prepareTurn(tools)).ok).toBeFalse(); expect([...disk]).toEqual(before);
    failWrite = undefined;
    expect((await service.recoverGeneration())?.status).toBe('COMMITTED');
  });

  for (const extra of [{ initialize: true }, { publish: false }, { rebind: 'sha256:' + '0'.repeat(64) }, { synchronize: 'yes' }])
    it(`rejects ambiguous turn synchronization authority ${JSON.stringify(extra)}`, async () => {
      const { tools } = await wireBase(), before = [...disk];
      expect((await prepareTurn(tools, extra)).code).toBe('ABS_REQUEST_INVALID'); expect([...disk]).toEqual(before);
    });

  it('reuses a verified unchanged projection without publishing another baseline or saving ABI', async () => {
    const { tools, exported } = await wireBase(), files = [...disk];
    const result: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(),
      expectedAbiHash: await hashAbsText(disk.get('project.abi')!), reuseCurrent: true });
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.reused).toBeTrue(); expect(result.receipt.base).toEqual(exported.receipt.base);
    expect([...disk]).toEqual(files); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('refreshes reuse requests after a workspace change and rejects drafts or stale ABI bytes', async () => {
    const { exported } = await wireBase();
    roots().setFieldValue('canvas edit', 'TEXT');
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
    const next = await service.exportGeneration({ reuseCurrent: true });
    expect(next.reused).not.toBeTrue(); expect(next.evidence!.binding.generation).not.toBe(exported.receipt.base.generation);
    expect(next.abs).toContain('canvas edit');
    disk.set('project.abs', next.abs! + '\n# unapplied draft');
    const files = [...disk];
    await expectAsync(service.exportGeneration({ reuseCurrent: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_CONFLICT' }));
    await expectAsync(service.exportGeneration({ reuseCurrent: true, expectedAbiHash: exported.receipt.base.abiHash }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_STALE' }));
    expect([...disk]).toEqual(files);
  });

  it('wraps a whole rendered statement sequence in one candidate and retains IDs after native save/reopen', async () => {
    renderWorkspace();
    const definitions = [
      { type: 'abs_move_root', message0: '%1', args0: [{ type: 'input_statement', name: 'BODY' }] },
      { type: 'abs_move_step', message0: '%1 %2', args0: [{ type: 'field_input', name: 'NAME', text: '' },
        { type: 'input_value', name: 'VALUE' }], previousStatement: null, nextStatement: null },
      { type: 'abs_move_if', message0: '%1 %2', args0: [{ type: 'input_value', name: 'IF0' },
        { type: 'input_statement', name: 'DO0' }], previousStatement: null, nextStatement: null },
      { type: 'abs_move_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' },
    ];
    definitions.forEach(declare);
    const owner = editor.workspace.newBlock('abs_move_root', 'move-root'); owner.setDeletable(false);
    let connection = owner.getInput('BODY').connection;
    for (const name of ['sample', 'draw', 'delay']) {
      const block = editor.workspace.newBlock('abs_move_step', name); block.setFieldValue(name, 'NAME'); block.data = name + ':metadata';
      const number = editor.workspace.newBlock('abs_move_number', name + '-value'); number.setFieldValue(name === 'delay' ? 2000 : 0, 'NUM');
      block.getInput('VALUE').connection.connect(number.outputConnection);
      connection.connect(block.previousConnection); connection = block.nextConnection;
    }
    const base = await wireBase(), start = base.exported.abs.indexOf('abs_move_root(');
    expect(start).toBeGreaterThan(-1);
    const source = base.exported.abs.slice(0, start) + 'abs_move_root()\n    abs_move_if(abs_move_number(2000))\n'
      + '        abs_move_step("sample", abs_move_number(0))\n        abs_move_step("draw", abs_move_number(0))\n'
      + 'abs_move_number(0)\n';
    const request = { ...base.request, candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const files = [...disk], before = nativeState();
    const validation: any = await base.tools.execute('abs_validate', request, source);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    expect([...disk]).toEqual(files); expect(nativeState()).toEqual(before);
    const result: any = await base.tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt }, source);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    for (const name of ['sample', 'draw']) {
      const block = editor.workspace.getBlockById(name);
      expect(block.data).toBe(name + ':metadata'); expect(block.getInputTargetBlock('VALUE').id).toBe(name + '-value');
    }
    expect(editor.workspace.getBlockById('delay')).toBeNull();
    expect(editor.workspace.getBlockById('delay-value').getParent().type).toBe('abs_move_if');
    expect(editor.workspace.getBlockById('move-root').isDeletable()).toBeFalse();
    expect(roots().isDeletable()).toBeFalse();
  });

  it('production wire validates without publishing and applies through the one generation save', async () => {
    const { tools, source, request } = await wireBase(); const original = [...disk];
    const validated: any = await tools.execute('abs_validate', { ...request, abs: source }, source);
    expect(validated.ok).toBeTrue(); expect(validated.receipt.abs).toBeUndefined(); expect([...disk]).toEqual(original);
    expect(roots().getFieldValue('TEXT')).toBe('before'); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(applied.ok).withContext(JSON.stringify(applied)).toBeTrue(); expect(applied.receipt.validation.scope).toBe('complete-generation');
    expect(applied.receipt.output.binding.abiHash).toBe(await hashAbsText(disk.get('project.abi')!));
    expect(applied.receipt.output.binding.mapHash).toBe(await hashAbsText(disk.get('project.abs.map.json')!));
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1); expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    expect(roots().id).toBe('protected'); expect(roots().isDeletable()).toBeFalse();
  });

  it('production wire applies repeated same-type edits as one identity-preserving batch', async () => {
    declare({ type: 'abs_batch_text', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: null });
    for (const [id, value] of [['batch-a', 'first'], ['batch-b', 'second']]) {
      const block = editor.workspace.newBlock('abs_batch_text', id);
      block.setFieldValue(value, 'TEXT'); block.data = id + ':metadata';
    }
    const base = await wireBase(), original = base.exported.abs as string;
    const edits = ['first', 'second'].map(value => {
      const start = original.indexOf(JSON.stringify(value));
      return { start, end: start + JSON.stringify(value).length, text: JSON.stringify(value + ' changed') };
    }).sort((a, b) => a.start - b.start);
    const source = [...edits].reverse().reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
    const request = { ...base.request, sourceEdits: [edits], candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const before = nativeState(), files = [...disk];
    const validation: any = await base.tools.execute('abs_validate', request, source);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    expect(nativeState()).toEqual(before); expect([...disk]).toEqual(files);
    const applied: any = await base.tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt }, source);
    expect(applied.ok).withContext(JSON.stringify(applied)).toBeTrue();
    expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
    for (const [id, value] of [['batch-a', 'first'], ['batch-b', 'second']]) {
      const block = editor.workspace.getBlockById(id);
      expect(block.getFieldValue('TEXT')).toBe(value + ' changed'); expect(block.data).toBe(id + ':metadata');
    }
    expect(roots().isDeletable()).toBeFalse();
    const saved = nativeState(); editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(nativeState()).toEqual(saved);
  });

  it('creates and reshapes common branch mutators through validate/apply, preserving generation and protected roots', async () => {
    declare({ type: 'abs_dynamic_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' });
    declare({ type: 'abs_dynamic_if', message0: '%1 %2', args0: [{ type: 'input_value', name: 'IF0' },
      { type: 'input_statement', name: 'DO0' }], mutator: 'controls_if_mutator', previousStatement: null, nextStatement: null });
    const run = async (base: Awaited<ReturnType<typeof wireBase>>, candidate: string) => {
      const before = nativeState(), files = [...disk];
      const binding = { ...base.request, candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } };
      const validation: any = await base.tools.execute('abs_validate', binding, candidate);
      expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
      expect(nativeState()).toEqual(before); expect([...disk]).toEqual(files);
      const result: any = await base.tools.execute('abs_apply', { version: 2, requestId: base.request.requestId, validation: validation.receipt }, candidate);
      expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    };
    const first = await wireBase();
    await run(first, first.source + '\nabs_dynamic_if(abs_dynamic_number(1), abs_dynamic_number(2)) @extra:{"elseIfCount":1,"hasElse":true}');
    const id = editor.workspace.getBlocksByType('abs_dynamic_if')[0].id;
    const second = await wireBase();
    await run(second, second.source.replace('"elseIfCount":1', '"elseIfCount":2'));
    expect(editor.workspace.getBlockById(id).getInput('IF2')).toBeTruthy();
    expect(roots().id).toBe('protected'); expect(roots().isDeletable()).toBeFalse();
    const committed = await new AbsBaselineStore(port, scope).loadCommitted();
    expect(committed!.abs).toBe(disk.get('project.abs'));
    expect((committed!.document as any).pages[1].custom).toEqual({ preserved: true });
  });

  it('prepares and commits bundled procedure parameters through the normal generation transaction', async () => {
    renderWorkspace();
    const { tools, source, request } = await wireBase();
    const candidate = source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"amount"}]}\nprocedures_callnoreturn() @extra:{"name":"work","params":["amount"]}';
    const binding = { ...request, createVariables: [{ name: 'amount' }], candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } };
    const before = nativeState(), files = [...disk];
    const validation: any = await tools.execute('abs_validate', binding, candidate);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    expect(nativeState()).toEqual(before); expect([...disk]).toEqual(files);
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt, chunk: true }, candidate);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(editor.workspace.getAllVariables().map(model => model.name)).toEqual(['amount']);
    expect(editor.workspace.getAllBlocks(false).filter(block => block.type.startsWith('procedures_')).length).toBe(2);
    expect(roots().isDeletable()).toBeFalse(); expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1);
  });

  it('rolls back prepared procedure blocks and models when a generator introduces an extra model', async () => {
    const { tools, source, request } = await wireBase();
    const candidate = source + '\nprocedures_defnoreturn(NAME="work")';
    const binding = { ...request, candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength } };
    const validation: any = await tools.execute('abs_validate', binding, candidate);
    expect(validation.ok).toBeTrue(); const before = nativeState(), files = [...disk];
    editor.prepareProjectCode.and.callFake(async () => { editor.workspace.createVariable('unexpected'); return null; });
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt }, candidate);
    expect(result.ok).toBeFalse(); expect(nativeState()).toEqual(before); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });

  for (const chunk of [false, true]) it(`creates owned parameter models and resolves real variable fields atomically (chunk=${chunk})`, async () => {
    if (chunk) renderWorkspace();
    declare({ type: 'abs_native_get', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR', variable: 'default' }],
      extensions: ['contextMenu_variableSetterGetter'], output: null });
    const { tools, request, source } = await wireBase();
    const candidate = source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"counter"}]}\nabs_native_get(VAR="counter")';
    const creation = { ...request, candidate: { hash: await hashAbsText(candidate), bytes: new TextEncoder().encode(candidate).byteLength },
      createVariables: [{ name: 'counter' }] };
    const original = [...disk];
    const validated: any = await tools.execute('abs_validate', creation, candidate);
    expect(validated.ok).withContext(JSON.stringify(validated)).toBeTrue();
    expect(editor.workspace.getAllVariables()).toEqual([]); expect([...disk]).toEqual(original);
    // Same-name generator registration must reuse the prepared model, not manufacture an extra model.
    editor.prepareProjectCode.and.callFake(async () => { editor.workspace.createVariable('counter', ''); return null; });
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: creation.requestId, validation: validated.receipt, chunk }, candidate);
    expect(applied.ok).withContext(JSON.stringify(applied)).toBeTrue();
    const model = editor.workspace.getVariable('counter', '');
    expect(model.getId()).toBe(`abs-variable:${request.requestId}:0`);
    expect(editor.workspace.getBlocksByType('abs_native_get')[0].getFieldValue('VAR')).toBe(model.getId());
    expect(editor.workspace.getAllVariables().length).toBe(1);
    const committed = await new AbsBaselineStore(port, scope).loadCommitted();
    expect(committed!.workspace['variables']).toEqual(nativeState()['variables']);
    expect(JSON.parse(disk.get('project.abi')!).sharedModel.variables).toEqual(nativeState()['variables']);
    expect(disk.get('project.abs')).not.toContain('@var'); expect(roots().isDeletable()).toBeFalse();
    editor.switchPage('other'); editor.switchPage('main');
    expect(editor.workspace.getVariable('counter').getId()).toBe(model.getId());
    const next = await wireBase();
    const duplicate: any = await next.tools.execute('abs_validate', { ...next.request, createVariables: [{ name: 'COUNTER', type: 'Number' }] }, next.source);
    expect(duplicate.code).toBe('ABS_MODEL_INTENT_UNOWNED');
  });

  it('rolls back both new models and blocks when the generator introduces unprepared state', async () => {
    const base = await wireBase(), { tools, request } = base; const original = nativeState(); const mirrors = [...disk];
    const source = base.source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"counter"}]}';
    const validated: any = await tools.execute('abs_validate', { ...request,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength }, createVariables: [{ name: 'counter' }] }, source);
    expect(validated.ok).toBeTrue();
    editor.prepareProjectCode.and.callFake(async () => { editor.workspace.createVariable('unprepared'); return null; });
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(applied.ok).toBeFalse(); expect(nativeState()).toEqual(original); expect([...disk]).toEqual(mirrors);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('uses definition-order syntax through production validate/apply/export and preserves IDs on the second edit', async () => {
    declare({ type: 'abs_tx_order', message0: '%1 %2 %3', args0: [
      { type: 'field_input', name: 'NAME', text: 'counter' }, { type: 'input_value', name: 'VALUE' },
      { type: 'field_dropdown', name: 'TYPE', options: [['int', 'int']] },
    ], previousStatement: null, nextStatement: null });
    declare({ type: 'abs_tx_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' });
    const { tools, request, source } = await wireBase();
    const text = source + '\nabs_tx_order("counter", abs_tx_number(7), int)';
    const input = { ...request, candidate: { hash: await hashAbsText(text), bytes: new TextEncoder().encode(text).length } };
    const validated: any = await tools.execute('abs_validate', input, text);
    expect(validated.ok).withContext(JSON.stringify(validated)).toBeTrue();
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, text);
    expect(applied.ok).withContext(JSON.stringify(applied)).toBeTrue();
    const parent = editor.workspace.getBlocksByType('abs_tx_order', false)[0];
    const number = parent.getInputTargetBlock('VALUE');
    const ids = [parent.id, number.id];
    expect(parent.getFieldValue('TYPE')).toBe('int'); expect(number.getFieldValue('NUM')).toBe(7);
    const next = await baseline();
    expect(next.source).toContain('abs_tx_order("counter", abs_tx_number(7), int)');
    expect((await service.applyGeneration(next.source.replace('abs_tx_number(7)', 'abs_tx_number(9)'), next.generation)).publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlockById(ids[0]).getInputTargetBlock('VALUE').id).toBe(ids[1]);
    expect(editor.workspace.getBlockById(ids[1]).getFieldValue('NUM')).toBe(9);
    expect(roots().isDeletable()).toBeFalse();
    expect((await new AbsBaselineStore(port, scope).loadCommitted())!.map.nodes.some(node => node.blockId === ids[1])).toBeTrue();
  });

  it('rejects malformed model intents before preparing or publishing anything', async () => {
    const { tools, request, source } = await wireBase(); const original = [...disk];
    for (const createVariables of [[], [{ name: 'counter', id: 'supplied' }], [{ name: 'counter' }, { name: 'COUNTER' }]]) {
      expect((await tools.execute('abs_validate', { ...request, createVariables }, source)).ok).toBeFalse();
    }
    expect([...disk]).toEqual(original); expect(editor.workspace.getAllVariables()).toEqual([]);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('requires the exact prepared model IDs before apply and never trusts an intent echo alone', async () => {
    const base = await wireBase(), { tools, request } = base; const mirrors = [...disk];
    const source = base.source + '\nprocedures_defnoreturn(NAME="work") @extra:{"params":[{"name":"counter"}]}';
    const validated: any = await tools.execute('abs_validate', { ...request,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength }, createVariables: [{ name: 'counter' }] }, source);
    expect(validated.ok).toBeTrue();
    expect(validated.receipt.preparedVariables).toEqual([{ id: `abs-variable:${request.requestId}:0`, name: 'counter', type: '' }]);
    for (const mutate of [receipt => delete receipt.preparedVariables, receipt => receipt.preparedVariables[0].id = 'changed',
      receipt => receipt.createVariables[0].name = 'changed']) {
      const receipt = structuredClone(validated.receipt); mutate(receipt);
      const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: receipt }, source);
      expect(result.code).toBe('ABS_REQUEST_INVALID');
    }
    expect([...disk]).toEqual(mirrors); expect(editor.workspace.getAllVariables()).toEqual([]);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('rejects legacy wire requests and stale export bytes without writing', async () => {
    const tools = new AbsGenerationToolsService(service);
    expect((await tools.execute('abs_projection', { version: 1, requestId: crypto.randomUUID() })).ok).toBeFalse();
    const result: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText('stale') });
    expect(result.code).toBe('ABS_BASELINE_STALE'); expect(disk.size).toBe(0);
  });

  it('requires explicit initialization and retains the exact old ABS recovery input', async () => {
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document)); disk.set('project.abs', 'old unversioned candidate');
    const tools = new AbsGenerationToolsService(service);
    const request = { version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(disk.get('project.abi')!) };
    expect((await tools.execute('abs_projection', request) as any).code).toBe('ABS_INITIALIZATION_REQUIRED');
    const initialized: any = await tools.execute('abs_projection', { ...request, initialize: true });
    expect(initialized.ok).toBeTrue();
    expect([...disk.entries()].filter(([key]) => key.startsWith('baselines/')).some(([, text]) => JSON.parse(text).inputAbs === 'old unversioned candidate')).toBeTrue();
  });

  it('custom readonly projection does not advance any generation or mirror', async () => {
    const { tools } = await wireBase(); const original = [...disk];
    const result: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(disk.get('project.abi')!), publish: false });
    expect(result.ok).toBeTrue(); expect(result.receipt.persisted).toBeFalse(); expect([...disk]).toEqual(original);
  });

  it('invalid or changed candidate bindings fail before touching blocks', async () => {
    const { tools, request, source } = await wireBase(); const original = [...disk];
    for (const change of [r => r.base.generation = 'stale', r => r.base.mapHash = 'sha256:' + '0'.repeat(64), r => r.base.scope.pageId = 'other', r => r.candidate.bytes++]) {
      const changed = structuredClone(request); change(changed);
      expect((await tools.execute('abs_validate', changed, source)).ok).toBeFalse();
    }
    expect([...disk]).toEqual(original); expect(roots().getFieldValue('TEXT')).toBe('before');
  });

  for (const timing of ['before-validation', 'after-validation', 'after-eviction']) {
    it(`preserves a concurrent ABS draft ${timing}`, async () => {
      const { tools, request, source, exported } = await wireBase();
      let validation: any;
      if (timing !== 'before-validation') {
        validation = await tools.execute('abs_validate', request, source);
        expect(validation.ok).toBeTrue();
        if (timing === 'after-eviction') {
          const another = source.replace('wire edit', 'another candidate');
          const other: any = await tools.execute('abs_validate', { ...request, requestId: crypto.randomUUID(),
            candidate: { hash: await hashAbsText(another), bytes: new TextEncoder().encode(another).byteLength } }, another);
          expect(other.ok).toBeTrue();
        }
      }
      const draft = exported.abs.replace('TEXT="before"', 'TEXT="user draft"');
      disk.set('project.abs', draft);
      const files = [...disk], canvas = nativeState();
      if (timing === 'before-validation') {
        validation = await tools.execute('abs_validate', request, source);
        expect(validation.ok).toBeTrue(); // Read-only diagnostics remain available.
        expect([...disk]).toEqual(files);
      }
      const result: any = await tools.execute('abs_apply', {
        version: 2, requestId: request.requestId, validation: validation.receipt,
      }, source);
      expect(result.ok).withContext(JSON.stringify(result)).toBeFalse();
      expect(['ABS_SOURCE_CONFLICT', 'ABS_DISK_CONFLICT']).toContain(result.code);
      expect([...disk]).toEqual(files); expect(nativeState()).toEqual(canvas);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    });
  }

  it('an edit after validation cannot be saved away by apply', async () => {
    const { tools, request, source } = await wireBase();
    const validated: any = await tools.execute('abs_validate', request, source);
    roots().setFieldValue('user edit after validation', 'TEXT');
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(result.code).toBe('ABS_REVISION_STALE'); expect(roots().getFieldValue('TEXT')).toBe('user edit after validation');
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('keeps one generation through viewport changes and atomically applies the complete candidate', async () => {
    const { tools, request, source } = await wireBase();
    editor.setViewState({ scale: 0.608742884389289, scrollX: 111.590044, scrollY: 22.41985 });
    const reused = await service.exportGeneration({ reuseCurrent: true });
    expect(reused.reused).toBeTrue(); expect(reused.evidence!.binding.generation).toBe(request.base.generation);
    const validated: any = await tools.execute('abs_validate', request, source);
    expect(validated.ok).withContext(JSON.stringify(validated)).toBeTrue();
    const view = { scale: 0.5004881397671546, scrollX: 122.726067, scrollY: 60.691987 };
    editor.setViewState(view);
    disk.set('project.abs', source);
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toEqual(['ABS_SOURCE_CONFLICT']);
    expect(diagnosis.diagnostics.draft.canValidate).toBeTrue();
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(roots().getFieldValue('TEXT')).toBe('wire edit');
    expect(JSON.parse(disk.get('project.abi')!).pages[0].viewState).toEqual(view);
  });

  for (const phase of ['save', 'commit', 'outputs']) it(`allows viewport settling during ${phase} after applying blocks`, async () => {
    renderWorkspace();
    const base = await baseline();
    const view = { scale: 0.5, scrollX: 123, scrollY: 45 };
    const settleView = () => editor.setViewState(view);
    if (phase === 'save') {
      const prepare = project.prepareSave.bind(project);
      spyOn(project, 'prepareSave').and.callFake(async (...args) => {
        settleView(); return prepare(...args);
      });
    } else if (phase === 'commit') {
      const withLock = port.withLock;
      port.withLock = operation => withLock(async storage => {
        const result = await operation(storage);
        if (disk.has('project.abi')) settleView();
        return result;
      });
    } else (project.publishPreparedSaveOutputs as jasmine.Spy).and.callFake(async () => settleView());
    const result = await apply(base);
    expect(result.publication.status).toBe('COMMITTED');
    expect(result.requiresReload).toBeFalse(); expect(result.warnings).toEqual([]);
    expect(roots().getFieldValue('TEXT')).toBe('after');
    expect(editor.captureProjectSnapshot().document.pages[0].viewState).toEqual(view);
    expect(disk.get('project.abs')).toContain('TEXT="after"');
    expect(result.appliedRevision).toBe(editor.captureProjectSnapshot().revision);
    expect(editor.publishAbsContext.calls.mostRecent().args[1]).toBe(result.appliedRevision);
    const committed = (await new AbsBaselineStore(port, scope).loadCommitted())!;
    expect(committed.map.savedAbiHash).toBe(await hashAbsText(absJson(JSON.parse(disk.get('project.abi')!))));
    expect(await service.inspectRecovery()).toBeNull(); expect(gate.blocked).toBeFalse();
  });

  for (const chunk of [false, true]) it(`keeps native repaint bumps out of the applied save seal, chunk=${chunk}`, async () => {
    renderWorkspace();
    const stray = editor.workspace.newBlock('math_number');
    stray.initSvg(); stray.render(); stray.moveBy(400, 300);
    const strayId = stray.id, base = await baseline();
    const before = nativeState().blocks.blocks.find(block => block.id === strayId)!;
    const prepare = project.prepareSave.bind(project);
    spyOn(project, 'prepareSave').and.callFake(async (...args) => {
      // The native serializer re-enables tracking asynchronously; library UI
      // refreshes can then ask the native renderer to bump an existing root.
      await new Promise(resolve => setTimeout(resolve, 0));
      editor.workspace.getBlockById(strayId).outputConnection.bumpAwayFrom(roots().getInput('VALUE').connection);
      return prepare(...args);
    });
    const result = await apply(base, { chunk });
    expect(result.publication.status).toBe('COMMITTED');
    expect(result.warnings).toEqual([]);
    expect(nativeState().blocks.blocks.find(block => block.id === strayId)).toEqual(before);
    const saved = composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main');
    expect(saved.blocks.blocks.find(block => block.id === strayId)).toEqual(before);
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(gate.blocked).toBeFalse();
    expect(await service.inspectRecovery()).toBeNull();
    // The fence must not leak into normal interactive editing.
    editor.workspace.getBlockById(strayId).outputConnection.bumpAwayFrom(roots().getInput('VALUE').connection);
    expect(nativeState().blocks.blocks.find(block => block.id === strayId)).not.toEqual(before);
  });

  for (const afterValidation of [false, true]) it(`accepts root moves without overwriting the current layout, afterValidation=${afterValidation}`, async () => {
    const { tools, request, source } = await wireBase();
    editor.assertWorkspaceSharedChange.and.callFake((document, candidate) => {
      const current = composeBlocklyPage(document, 'main').blocks.blocks.find(block => block.id === 'protected');
      const retained = candidate.blocks.blocks.find(block => block.id === 'protected');
      expect(retained.x).toBe(current.x); expect(retained.y).toBe(current.y);
    });
    if (!afterValidation) roots().moveBy(123, 45);
    const validation: any = await tools.execute('abs_validate', request, source);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    if (afterValidation) roots().moveBy(123, 45);
    const reused = await service.exportGeneration({ reuseCurrent: true });
    expect(reused.reused).toBeTrue(); expect(reused.evidence!.binding.generation).toBe(request.base.generation);
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt }, source);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(roots().getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(153, 105));
    expect(roots().getFieldValue('TEXT')).toBe('wire edit');
    const saved = composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main');
    expect(saved.blocks.blocks[0].x).toBe(153); expect(saved.blocks.blocks[0].y).toBe(105);
    editor.restoreProjectWorkspaceSnapshot(JSON.parse(disk.get('project.abi')!));
    expect(roots().getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(153, 105));
    expect(roots().getFieldValue('TEXT')).toBe('wire edit');
  });

  it('does not classify a changed connection as a layout-only edit', async () => {
    const { tools, request, source } = await wireBase();
    const validated: any = await tools.execute('abs_validate', request, source);
    roots().getInput('VALUE').connection.disconnect();
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(result.code).toBe('ABS_REVISION_STALE');
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('does not invalidate a sealed program for a late layout-only move', async () => {
    renderWorkspace(); const base = await baseline();
    const prepare = project.prepareSave.bind(project);
    spyOn(project, 'prepareSave').and.callFake(async (...args) => {
      roots().moveBy(20, 30); return prepare(...args);
    });
    const result = await apply(base);
    expect(result.publication.status).toBe('COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('after');
    expect(roots().getRelativeToSurfaceXY()).toEqual(new Blockly.utils.Coordinate(50, 90));
    expect(await service.inspectRecovery()).toBeNull();
  });

  for (const change of ['field', 'other-page', 'view-extension']) it(`rejects ${change} changes during applied save preparation`, async () => {
    const base = await baseline(), files = [...disk];
    const prepare = project.prepareSave.bind(project);
    spyOn(project, 'prepareSave').and.callFake(async (...args) => {
      if (change === 'field') roots().setFieldValue('unexpected callback edit', 'TEXT');
      else if (change === 'other-page') editor.mutateOtherPage();
      else editor.setViewState({ scale: 0.5, pluginState: 'unexpected callback edit' });
      return prepare(...args);
    });
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
    expect(roots().getFieldValue('TEXT')).toBe('before'); expect([...disk]).toEqual(files);
    expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1); expect(gate.blocked).toBeFalse();
    expect(Object.hasOwn(editor.workspace, 'newBlock')).toBeFalse();
    expect(Object.hasOwn(roots(), 'moveBy')).toBeFalse();
  });

  for (const failGeneration of [false, true]) it(`rebuilds repeated calls in one real SVG workspace transaction, failure=${failGeneration}`, async () => {
    renderWorkspace();
    declare({ type: 'abs_test_program', message0: '%1', args0: [{ type: 'input_statement', name: 'BODY' }] });
    declare({ type: 'abs_test_draw', message0: 'draw %1', args0: [{ type: 'input_value', name: 'X', check: 'Number' }],
      previousStatement: null, nextStatement: null });
    declare({ type: 'abs_test_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' });
    const draw = (id, value, next?) => ({ type: 'abs_test_draw', id, inputs: {
      X: { block: { type: 'abs_test_number', id: id + '-x', fields: { NUM: value } } },
    }, ...(next ? { next: { block: next } } : {}) });
    Blockly.serialization.workspaces.load({ blocks: { blocks: [{ type: 'abs_test_program', id: 'protected',
      deletable: false, inputs: { BODY: { block: draw('one', 1, draw('two', 2)) } } }] } }, editor.workspace);
    const { tools, exported } = await wireBase();
    const source = '# ABS Schema: 2\nabs_test_program()\n'
      + [3, 4, 5].map(n => `    abs_test_draw(abs_test_number(${n}))`).join('\n');
    const request = { version: 2, requestId: crypto.randomUUID(), base: exported.receipt.base,
      candidate: { hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength } };
    const original = absJson(nativeState()), files = [...disk];
    const validation: any = await tools.execute('abs_validate', request, source);
    expect(validation.ok).withContext(JSON.stringify(validation)).toBeTrue();
    expect(absJson(nativeState())).toBe(original); expect([...disk]).toEqual(files);
    if (failGeneration) editor.prepareProjectCode.and.rejectWith(new Error('injected generation failure'));
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validation.receipt }, source);
    if (failGeneration) {
      expect(result.ok).toBeFalse(); expect(absJson(nativeState())).toBe(original); expect([...disk]).toEqual(files);
    } else {
      expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
      expect(result.publication.status).toBe('COMMITTED');
      const values = () => editor.workspace.getBlocksByType('abs_test_draw', false)
        .map(block => Number(block.getInputTargetBlock('X').getFieldValue('NUM'))).sort();
      expect(values()).toEqual([3, 4, 5]); expect(roots().isDeletable()).toBeFalse();
      expect(editor.workspace.getBlockById('one')).toBeNull(); expect(editor.workspace.getBlockById('two')).toBeNull();
      const saved = JSON.parse(disk.get('project.abi')!);
      Blockly.serialization.workspaces.load(composeBlocklyPage(saved, 'main'), editor.workspace);
      expect(values()).toEqual([3, 4, 5]); expect(roots().isDeletable()).toBeFalse();
    }
  });

  it('clean disk inspection reports actual canvas changes instead of false ready', async () => {
    const { tools } = await wireBase();
    editor.setViewState({ scale: 0.5, scrollX: 20, scrollY: 30 });
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
    roots().setFieldValue('real program edit', 'TEXT');
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toContain('ABS_BASELINE_STALE');
    expect(diagnosis.diagnostics.status).toBe('blocked');
    expect(diagnosis.diagnostics.refresh).toBeUndefined();
  });

  it('recovery wire inspects and repairs disk without loading or generating blocks', async () => {
    const { tools, request, source } = await wireBase();
    const validated: any = await tools.execute('abs_validate', request, source); failWrite = 'project.abs';
    const applied: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(applied.ok).toBeFalse(); expect(applied.publication.status).toBe('MIRROR_PENDING');
    const base = { version: 2, requestId: crypto.randomUUID() };
    const abi = disk.get('project.abi'), current = absJson(nativeState());
    const inspected: any = await tools.execute('abs_recovery', { ...base, action: 'inspect' });
    expect(inspected.pending.abiSaved).toBeTrue(); expect(inspected.receipt.requestId).toBe(base.requestId);
    expect(inspected.requestId).toBeUndefined(); // Top-level requestId belongs to the enclosing IPC transport.
    expect((await tools.execute('abs_recovery', { ...base, action: 'abandon' })).ok).toBeFalse();
    failWrite = undefined;
    const recovered: any = await tools.execute('abs_recovery', { ...base, action: 'recover' });
    expect(recovered.ok).toBeTrue(); expect(recovered.requiresReload).toBeTrue(); expect(disk.get('project.abi')).toBe(abi);
    expect(absJson(nativeState())).toBe(current); expect(editor.prepareProjectCode).toHaveBeenCalledTimes(1); expect(gate.blocked).toBeTrue();
  });

  const inspect = (tools: AbsGenerationToolsService) => tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(), action: 'inspect' }) as Promise<any>;
  const refreshDraft = (tools: AbsGenerationToolsService, token: string) => tools.execute('abs_recovery', {
    version: 2, requestId: crypto.randomUUID(), action: 'refresh', token,
  }) as Promise<any>;

  it('validates an existing draft with a shrinking unused dropdown domain using current options', async () => {
    let options: [string, string][] = [['first', 'A'], ['unused', 'B']];
    Blockly.Blocks['abs_dynamic_domain'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown(() => options), 'PORT');
    } };
    registeredTypes.push('abs_dynamic_domain');
    editor.workspace.newBlock('abs_dynamic_domain', 'port');
    const { tools, source, request } = await wireBase(); disk.set('project.abs', source);
    options = [['first', 'A'], ['new', 'C']];
    const before = [...disk], state = absJson(nativeState());
    (projectDataRuntime.flushPending as jasmine.Spy).calls.reset();
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.runtime.status).toBe('compatible');
    expect(diagnosis.diagnostics.draft.canValidate).toBeTrue();
    expect(projectDataRuntime.flushPending).not.toHaveBeenCalled(); expect([...disk]).toEqual(before);
    expect((await tools.execute('abs_validate', request, source) as any).ok).toBeTrue();
    expect(absJson(nativeState())).toBe(state); expect([...disk]).toEqual(before);
    const removed = source.replace('PORT=A', 'PORT=B'); expect(removed).not.toBe(source);
    const invalid: any = await tools.execute('abs_validate', { ...request,
      candidate: { hash: await hashAbsText(removed), bytes: new TextEncoder().encode(removed).byteLength } }, removed);
    expect(invalid.ok).toBeFalse(); expect(invalid.code).toBe('ABS_FIELD_OPTION_INVALID');
    expect((await tools.execute('abs_apply', { version: 2, requestId: request.requestId,
      validation: (await tools.execute('abs_validate', request, source) as any).receipt }, source) as any).ok).toBeTrue();
    expect(editor.workspace.getBlockById('port').getFieldValue('PORT')).toBe('A');
  });

  it('explicitly archives the draft and commits the inspected live canvas after a user merge decision', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source);
    roots().setFieldValue('user 1337', 'TEXT');
    const draft = disk.get('project.abs'), inputAbi = disk.get('project.abi')!, state = absJson(nativeState());
    const before = [...disk], diagnosis = await inspect(tools);
    expect([...disk]).toEqual(before);
    expect(diagnosis.diagnostics.draft.canValidate).toBeFalse();
    expect(diagnosis.diagnostics.refresh?.savesCanvas).toBeTrue();
    const result = await refreshDraft(tools, diagnosis.diagnostics.refresh?.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    if (!result.ok) return;
    expect(result.receipt.inputAbiHash).toBe(await hashAbsText(inputAbi));
    expect(result.publication.abiSaved).toBeTrue();
    expect(result.abs).toContain('TEXT="user 1337"');
    expect(absJson(nativeState())).toBe(state);
    const read: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'read_draft', generation: result.draftArchive.generation });
    expect(read.draft.abs).toBe(draft);
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('inspects and explicitly refreshes a draft with a durable readable archive and unchanged ABI/blocks', async () => {
    const { tools, source, exported } = await wireBase(); disk.set('project.abs', source + '\n# 中文😀\r\n');
    const draft = disk.get('project.abs')!, abi = disk.get('project.abi'), state = absJson(nativeState()), before = [...disk];
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.draft.canValidate).toBeTrue(); expect([...disk]).toEqual(before);
    const result = await refreshDraft(tools, diagnosis.diagnostics.refresh.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.abs).toBe(exported.abs); expect(disk.get('project.abs')).toBe(exported.abs);
    expect(disk.get('project.abi')).toBe(abi); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    const read: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'read_draft', generation: result.draftArchive.generation });
    expect(read.ok).toBeTrue(); expect(read.draft.abs).toBe(draft);
    expect(read.draft.baseGeneration).toBe(exported.receipt.base.generation);
    expect(read.draft.hash).toBe(await hashAbsText(draft)); expect(read.draft.bytes).toBe(new TextEncoder().encode(draft).byteLength);
    const key = `baselines/${result.draftArchive.generation}.json`, record = JSON.parse(disk.get(key)!);
    record.inputAbs += 'corrupt'; disk.set(key, absJson(record));
    expect((await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'read_draft', generation: result.draftArchive.generation }) as any).code).toBe('ABS_BASELINE_CORRUPT');
  });

  for (const presentation of ['viewport', 'root layout'] as const)
    it(`refreshes a draft after saved ${presentation} changes while retaining the different live presentation`, async () => {
      const { tools, source, exported } = await wireBase();
      disk.set('project.abs', source);
      const move = (step: number) => presentation === 'viewport'
        ? editor.setViewState({ scale: step, scrollX: step * 100, scrollY: -step * 100 })
        : roots().moveBy(step * 100, step * 100);
      move(1);
      disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
      move(2);
      const abi = disk.get('project.abi'), document = absJson(editor.captureProjectSnapshot().document);
      const diagnosis = await inspect(tools);
      expect(diagnosis.diagnostics.workspace).toEqual({ changedFromBaseline: false, savedChangedFromBaseline: true, matchesSaved: true });
      expect(diagnosis.diagnostics.refresh).toBeDefined();
      const result = await refreshDraft(tools, diagnosis.diagnostics.refresh.token);
      expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
      if (!result.ok) return;
      expect(splitAbsState(result.abs).program).toBe(splitAbsState(exported.abs).program);
      expect(absJson((await decodeAbsState(result.abs)).document)).toBe(document);
      expect(absJson(JSON.parse(disk.get('project.abi')!))).toBe(document);
      expect(absJson(editor.captureProjectSnapshot().document)).toBe(document);
      expect((await service.readArchivedDraft(result.draftArchive.generation)).abs).toBe(source);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled();
      expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    });

  for (const edit of ['field', 'other page'] as const)
    it(`blocks actual saved/canvas ${edit} divergence despite presentation-only differences`, async () => {
      const { tools, source } = await wireBase();
      disk.set('project.abs', source);
      editor.setViewState({ scale: 0.5, scrollX: 283, scrollY: 274 });
      roots().setFieldValue('saved program edit', 'TEXT');
      disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
      const token = (await inspect(tools)).diagnostics.refresh.token;
      editor.setViewState({ scale: 1.185, scrollX: -309, scrollY: 362 });
      if (edit === 'field') roots().setFieldValue('independent canvas edit', 'TEXT');
      else editor.mutateOtherPage();
      const before = [...disk], document = absJson(editor.captureProjectSnapshot().document);
      const diagnosis = await inspect(tools);
      expect(diagnosis.diagnostics.workspace.matchesSaved).toBeFalse();
      expect(diagnosis.diagnostics.issues).toContain('ABS_DUAL_EDIT_CONFLICT');
      expect(diagnosis.diagnostics.refresh).toBeUndefined();
      expect((await refreshDraft(tools, token)).code).toBe('ABS_DUAL_EDIT_CONFLICT');
      expect([...disk]).toEqual(before);
      expect(absJson(editor.captureProjectSnapshot().document)).toBe(document);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled();
      expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
    });

  it('bounds whole-project snapshots during synchronous field capture and still rejects getter mutations', async () => {
    for (let i = 0; i < 40; i++) editor.workspace.newBlock('math_number', `capture_${i}`);
    const snapshots = spyOn(editor, 'captureProjectSnapshot').and.callThrough();
    await baseline();
    expect(snapshots.calls.count()).toBeLessThan(40);
    const field = editor.workspace.getBlockById('capture_0').getField('NUM');
    const getMin = field.getMin.bind(field);
    spyOn(field, 'getMin').and.callFake(() => {
      roots().setFieldValue('changed by getter', 'TEXT');
      return getMin();
    });
    await expectAsync(service.exportGeneration()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
  });

  it('archives a copied project draft before refreshing its scope without changing ABI or blocks', async () => {
    const { tools, source, request, exported } = await wireBase();
    disk.set('project.abs', source + '\n# copied draft 中文\n');
    project.currentProjectPath = 'D:/copied-project';
    const draft = disk.get('project.abs')!, abi = disk.get('project.abi'), state = absJson(nativeState()), before = [...disk];
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toEqual(['ABS_SCOPE_INVALID', 'ABS_SOURCE_CONFLICT']);
    expect(diagnosis.diagnostics.draft?.canValidate).toBeFalse();
    expect(diagnosis.diagnostics.rebind).toBeUndefined();
    expect(diagnosis.diagnostics.refresh).toBeDefined();
    expect([...disk]).toEqual(before);
    if (!diagnosis.diagnostics.refresh) return;
    const result = await refreshDraft(tools, diagnosis.diagnostics.refresh.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.output.binding.scope.projectKey).toBe(project.currentProjectPath);
    expect(result.receipt.output.binding.generation).not.toBe(exported.receipt.base.generation);
    expect(disk.get('project.abi')).toBe(abi); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    const archived = await service.readArchivedDraft(result.draftArchive.generation);
    expect(archived.abs).toBe(draft); expect(archived.baseGeneration).toBe(exported.receipt.base.generation);
    expect((await tools.execute('abs_validate', request, source) as any).code).toBe('ABS_BASELINE_STALE');
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('archives an old copied draft when the current workspace exactly matches a newer saved ABI', async () => {
    const { tools, source, request } = await wireBase();
    disk.set('project.abs', source);
    roots().setFieldValue('newer saved content', 'TEXT');
    disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
    project.currentProjectPath = 'D:/copied-project';
    const abi = disk.get('project.abi'), state = absJson(nativeState());
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.workspace).toEqual({ changedFromBaseline: true, savedChangedFromBaseline: true, matchesSaved: true });
    expect(diagnosis.diagnostics.draft.canValidate).toBeFalse();
    expect(diagnosis.diagnostics.baseline).toBeUndefined();
    expect(diagnosis.diagnostics.refresh).toBeDefined();
    const result = await refreshDraft(tools, diagnosis.diagnostics.refresh.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.abs).toContain('newer saved content');
    expect((await service.readArchivedDraft(result.draftArchive.generation)).abs).toBe(source);
    expect(JSON.parse(disk.get('project.abi')!)).toEqual(JSON.parse(abi!)); expect(absJson(nativeState())).toBe(state);
    expect((await tools.execute('abs_validate', request, source) as any).code).toBe('ABS_BASELINE_STALE');
  });

  it('keeps copied drafts blocked for a different page, changed canvas or stale refresh token', async () => {
    const { tools, source } = await wireBase();
    disk.set('project.abs', source); project.currentProjectPath = 'D:/copied-project';
    const token = (await inspect(tools)).diagnostics.refresh.token;
    editor.switchPage('other');
    expect((await inspect(tools)).diagnostics.refresh).toBeUndefined();
    expect((await refreshDraft(tools, token)).code).toBe('ABS_REFRESH_STALE');
    editor.switchPage('main');
    roots().setFieldValue('new unsaved edit', 'TEXT');
    expect((await inspect(tools)).diagnostics.refresh).toBeUndefined();
    expect((await refreshDraft(tools, token)).code).toBe('ABS_REFRESH_STALE');
    roots().setFieldValue('before', 'TEXT');
    disk.set('project.abs', source + '\n# newer draft');
    const before = [...disk];
    expect((await refreshDraft(tools, token)).code).toBe('ABS_REFRESH_STALE');
    expect([...disk]).toEqual(before);
  });

  it('reports runtime staleness alongside the source conflict and pins refresh to current runtime', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source);
    const field = editor.workspace.getBlockById('child').getField('NUM') as Blockly.FieldNumber;
    field.setMax(10);
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toContain('ABS_RUNTIME_CONTRACT_STALE');
    expect(diagnosis.diagnostics.draft.canValidate).toBeFalse();
    expect(diagnosis.diagnostics.refresh).toBeDefined();
    const before = [...disk]; field.setMax(20);
    expect((await refreshDraft(tools, diagnosis.diagnostics.refresh.token)).code).toBe('ABS_REFRESH_STALE');
    expect([...disk]).toEqual(before);
    expect((await refreshDraft(tools, (await inspect(tools)).diagnostics.refresh.token)).ok).toBeTrue();
  });

  it('rejects stale refresh tokens after draft edits and concurrent canvas edits without writes', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source);
    const diagnosis = await inspect(tools), token = diagnosis.diagnostics.refresh.token;
    disk.set('project.abs', source + '\n# newer'); let before = [...disk];
    expect((await refreshDraft(tools, token)).code).toBe('ABS_REFRESH_STALE'); expect([...disk]).toEqual(before);
    disk.set('project.abs', source); roots().setFieldValue('canvas edit', 'TEXT'); before = [...disk];
    const changed = await inspect(tools);
    expect(changed.diagnostics.draft.canValidate).toBeFalse();
    expect(changed.diagnostics.refresh.savesCanvas).toBeTrue();
    expect(changed.diagnostics.refresh.token).not.toBe(token);
    expect((await refreshDraft(tools, token)).code).toBe('ABS_REFRESH_STALE'); expect([...disk]).toEqual(before);
  });

  it('retains the draft archive when refresh publication is interrupted, then recovers without ABI save', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source);
    const diagnosis = await inspect(tools), abi = disk.get('project.abi'); failWrite = 'project.abs.map.json';
    const result = await refreshDraft(tools, diagnosis.diagnostics.refresh.token);
    expect(result.ok).toBeFalse(); expect(result.publication.status).toBe('MIRROR_PENDING');
    expect((await service.readArchivedDraft(result.draftArchive.generation)).abs).toBe(source);
    expect((await inspect(tools)).diagnostics.refresh).toBeUndefined(); failWrite = undefined;
    expect((await service.recoverGeneration()).status).toBe('COMMITTED'); expect(disk.get('project.abi')).toBe(abi);
    expect((await service.readArchivedDraft(result.draftArchive.generation)).abs).toBe(source);
  });

  it('never replaces mirrors if durable archive staging or readback fails', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source);
    const diagnosis = await inspect(tools), before = [...disk];
    const stage = spyOn(AbsBaselineStore.prototype, 'stage').and.rejectWith(new Error('archive write failed'));
    expect((await refreshDraft(tools, diagnosis.diagnostics.refresh.token)).ok).toBeFalse(); expect([...disk]).toEqual(before);
    stage.and.callThrough();
    spyOn(AbsBaselineStore.prototype, 'readArchivedDraft').and.rejectWith(new Error('archive readback failed'));
    expect((await refreshDraft(tools, diagnosis.diagnostics.refresh.token)).ok).toBeFalse();
    for (const [key, value] of before) expect(disk.get(key)).toBe(value);
    expect(disk.has('prepared.json')).toBeFalse();
  });
  const rebind = async (tools: AbsGenerationToolsService, token: string, options = {}) => tools.execute('abs_projection', {
    version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(disk.get('project.abi')!), rebind: token, ...options,
  }) as Promise<any>;

  it('explicitly rebinds a copied project without saving ABI, changing IDs or accepting its old candidate', async () => {
    const { tools, request, source, exported } = await wireBase();
    const before = [...disk], abi = disk.get('project.abi'), state = absJson(nativeState());
    project.currentProjectPath = 'D:/copied-project';
    await expectAsync(service.exportGeneration()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SCOPE_INVALID' }));
    const diagnosis = await inspect(tools);
    expect([...disk]).toEqual(before); expect(diagnosis.diagnostics.issues).toEqual(['ABS_SCOPE_INVALID']);
    const result = await rebind(tools, diagnosis.diagnostics.rebind.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.receipt.base.scope.projectKey).toBe(project.currentProjectPath);
    expect(result.receipt.base.generation).not.toBe(exported.receipt.base.generation);
    expect(disk.get('project.abi')).toBe(abi); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
    for (const [key, value] of before.filter(([key]) => key.startsWith('baselines/'))) expect(disk.get(key)).toBe(value);
    expect((await tools.execute('abs_validate', request, source) as any).code).toBe('ABS_BASELINE_STALE');
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('switches page scope in both directions through explicit exports without merging either page', async () => {
    const { tools, request, source, exported } = await wireBase(); const abi = disk.get('project.abi');
    editor.switchPage('other');
    const first = await inspect(tools);
    expect(first.diagnostics.rebind.to.pageId).toBe('other');
    const other = await rebind(tools, first.diagnostics.rebind.token);
    expect(other.ok).withContext(JSON.stringify(other)).toBeTrue(); expect(other.receipt.base.scope.pageId).toBe('other');
    expect(editor.workspace.getAllBlocks(false).length).toBe(0);
    expect(JSON.parse(disk.get('project.abi')!).activePageId).toBe('other');
    expect(JSON.parse(disk.get('project.abi')!).pages).toEqual(JSON.parse(abi!).pages);
    expect((await tools.execute('abs_validate', request, source) as any).code).toBe('ABS_BASELINE_STALE');
    editor.switchPage('main');
    expect((await rebind(tools, first.diagnostics.rebind.token)).code).toBe('ABS_REBIND_STALE');
    const second = await inspect(tools), main = await rebind(tools, second.diagnostics.rebind.token);
    expect(main.ok).toBeTrue(); expect(main.abs).toBe(exported.abs); expect(roots().isDeletable()).toBeFalse();
    expect(JSON.parse(disk.get('project.abi')!)).toEqual(JSON.parse(abi!)); expect(editor.prepareProjectCode).toHaveBeenCalled();
  });

  for (const badMap of [null, '{broken map 中文😀']) it(`repairs a ${badMap === null ? 'missing' : 'corrupt'} public map and preserves replaced bytes`, async () => {
    const { tools } = await wireBase();
    if (badMap === null) disk.delete('project.abs.map.json'); else disk.set('project.abs.map.json', badMap);
    const before = [...disk], diagnosis = await inspect(tools);
    expect([...disk]).toEqual(before); expect(diagnosis.diagnostics.issues).toEqual(['ABS_MAP_INVALID']);
    const result = await rebind(tools, diagnosis.diagnostics.rebind.token);
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    const record = JSON.parse(disk.get(`baselines/${result.receipt.base.generation}.json`)!);
    expect(record.inputMap).toBe(badMap); expect(record.inputAbs).toBe(before.find(([key]) => key === 'project.abs')![1]);
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('never offers rebinding for an unapplied source even when the map and project scope differ', async () => {
    const { tools, source } = await wireBase();
    project.currentProjectPath = 'D:/copied-project'; disk.set('project.abs', source); disk.set('project.abs.map.json', 'corrupt');
    const before = [...disk], diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.status).toBe('blocked'); expect(diagnosis.diagnostics.rebind).toBeUndefined();
    expect(diagnosis.diagnostics.issues).toContain('ABS_SOURCE_CONFLICT');
    expect((await rebind(tools, 'sha256:' + '0'.repeat(64))).code).toBe('ABS_REBIND_STALE'); expect([...disk]).toEqual(before);
  });

  it('offers a guarded repair with raw draft evidence for combined scope/map/source conflicts', async () => {
    const { tools, source } = await wireBase();
    project.currentProjectPath = 'D:/copied-project';
    disk.set('project.abs', source); disk.set('project.abs.map.json', '{broken copied map');
    const before = [...disk], diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toContain('ABS_SCOPE_INVALID');
    expect(diagnosis.diagnostics.issues).toContain('ABS_MAP_INVALID');
    expect(diagnosis.diagnostics.issues).toContain('ABS_SOURCE_CONFLICT');
    expect(diagnosis.diagnostics.rebind).toBeUndefined();
    expect(diagnosis.diagnostics.draft).toEqual(jasmine.objectContaining({
      hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength,
    }));
    expect(diagnosis.diagnostics.repair).toEqual(jasmine.objectContaining({ authority: 'workspace', token: jasmine.stringMatching(/^sha256:/) }));
    expect([...disk]).toEqual(before);
  });

  it('repairs the copied conflict from the current canvas and retains the exact original draft/map/ABI', async () => {
    const { tools, source } = await wireBase();
    project.currentProjectPath = 'D:/copied-project';
    disk.set('project.abs', source); disk.set('project.abs.map.json', '{broken copied map');
    const oldAbi = disk.get('project.abi'), oldPointer = disk.get('committed.json');
    const diagnosis = await inspect(tools);
    const result: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'repair', authority: 'workspace', token: diagnosis.diagnostics.repair?.token ?? 'sha256:' + '0'.repeat(64) });
    expect(result.ok).withContext(JSON.stringify(result)).toBeTrue();
    expect(result.publication?.status).toBe('COMMITTED');
    expect(result.appliedRevision).toBeUndefined();
    expect(result.receipt?.appliedRevision).toBeUndefined();
    expect(result.candidateApplied).not.toBeTrue();
    expect(result.receipt?.candidateApplied).not.toBeTrue();
    expect(result.evidence?.binding.scope.projectKey).toBe('D:/copied-project');
    if (!result.recoveryArchive) return;
    const archive = JSON.parse(disk.get(result.recoveryArchive.key)!);
    expect(archive.disk).toEqual({ abi: oldAbi, abs: source, map: '{broken copied map' });
    expect(archive.committed.pointer).toBe(oldPointer);
    const restored: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'read_repair', generation: result.publication.generation });
    expect(restored.ok).toBeTrue(); expect(restored.draft.abs).toBe(source);
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
    expect(roots().getFieldValue('TEXT')).toBe('before');
    expect(result.abs).not.toBe(source);
    expect(disk.get('project.abs')).toBe(result.abs);
    expect(result.receipt.output.binding.absHash).toBe(await hashAbsText(result.abs));
    expect(restored.draft.abs).not.toBe(result.abs);
  });

  it('reuses a completed repair after a lost reply without rewriting the original archive', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source); disk.set('project.abs.map.json', 'broken');
    const diagnosis = await inspect(tools), token = diagnosis.diagnostics.repair.token;
    const request = () => ({ version: 2, requestId: crypto.randomUUID(), action: 'repair', authority: 'workspace', token });
    const first: any = await tools.execute('abs_recovery', request());
    expect(first.ok).withContext(JSON.stringify(first)).toBeTrue();
    const before = [...disk], again: any = await tools.execute('abs_recovery', request());
    expect(again.ok).withContext(JSON.stringify(again)).toBeTrue(); expect(again.reused).toBeTrue();
    expect(again.publication.generation).toBe(first.publication.generation); expect([...disk]).toEqual(before);
    expect(again.appliedRevision).toBeUndefined(); expect(again.receipt?.appliedRevision).toBeUndefined();
    expect(again.candidateApplied).not.toBeTrue(); expect(again.receipt?.candidateApplied).not.toBeTrue();
    const candidate: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(),
      action: 'read_repair', generation: again.publication.generation });
    expect(candidate.draft.abs).toBe(source); expect(roots().getFieldValue('TEXT')).toBe('before');
  });

  it('classifies an internally lost repair acknowledgement as unknown and permits verified observation', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source); disk.set('project.abs.map.json', 'broken');
    const diagnosis = await inspect(tools), token = diagnosis.diagnostics.repair.token;
    const request = () => ({ version: 2, requestId: crypto.randomUUID(), action: 'repair', authority: 'workspace', token });
    loseCommitReply = true;
    const unknown: any = await tools.execute('abs_recovery', request());
    expect(unknown.ok).toBeFalse(); expect(unknown.code).toBe('ABS_REPAIR_OUTCOME_UNKNOWN');
    expect(unknown.publication.status).toBe('UNKNOWN'); expect(gate.blocked).toBeFalse();
    loseCommitReply = false;
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
    const before = [...disk], observed: any = await tools.execute('abs_recovery', request());
    expect(observed.ok).withContext(JSON.stringify(observed)).toBeTrue(); expect(observed.reused).toBeTrue();
    expect([...disk]).toEqual(before);
    expect(observed.appliedRevision).toBeUndefined(); expect(observed.candidateApplied).not.toBeTrue();
    expect(roots().getFieldValue('TEXT')).toBe('before');
  });

  it('does not replace any mirror if original-input archival fails', async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source); disk.set('project.abs.map.json', 'broken');
    const diagnosis = await inspect(tools), before = [...disk]; failWrite = 'recoveries/*';
    const result: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(), action: 'repair',
      authority: 'workspace', token: diagnosis.diagnostics.repair.token });
    expect(result.ok).toBeFalse(); expect([...disk]).toEqual(before); expect(gate.blocked).toBeFalse();
  });

  for (const changed of ['disk', 'canvas']) it(`rejects a repair token after the inspected ${changed} changes`, async () => {
    const { tools, source } = await wireBase(); disk.set('project.abs', source); disk.set('project.abs.map.json', 'broken');
    const diagnosis = await inspect(tools);
    if (changed === 'disk') disk.set('project.abs', source + '\n'); else roots().setFieldValue('new user edit', 'TEXT');
    const before = [...disk];
    const result: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(), action: 'repair',
      authority: 'workspace', token: diagnosis.diagnostics.repair.token });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_REPAIR_STALE'); expect([...disk]).toEqual(before);
  });

  it('upgrades a verified previous projection through inspect/rebind without loading or saving ABI', async () => {
    const { tools, exported } = await wireBase();
    const key = `baselines/${exported.receipt.base.generation}.json`;
    const currentStore = new AbsBaselineStore(port, scope);
    const stored = JSON.parse(disk.get(key)!);
    const { snapshot, context, abiRecipe, ...journal } = stored;
    const record = { ...journal, schemaVersion: 1, projection: await currentStore.load(exported.receipt.base.generation), abi: await currentStore.readDerivedAbi(exported.receipt.base.generation) };
    record.projection.abs = splitAbsState(record.projection.abs).program;
    // Recreate historical bytes/offsets: protection was still retained only in ABI.
    record.projection.abs = record.projection.abs.replace(/ @protect:\{[^}]*\}/g, '');
    record.projection.map.baseAbsHash = await hashAbsText(record.projection.abs);
    const entries = indexAbsSyntax(parseAbsSyntax(record.projection.abs));
    record.projection.map.nodes.forEach((binding, index) => {
      binding.start = entries[index].node.start; binding.end = entries[index].node.end;
    });
    record.projection.map.projectionVersion = 'abs-v2.preview.3';
    disk.set('project.abs', record.projection.abs);
    disk.set(key, absJson(record)); disk.set('project.abs.map.json', absJson(record.projection.map));
    const pointer = JSON.parse(disk.get('committed.json')!); pointer.hash = await hashAbsText(disk.get(key)!);
    disk.set('committed.json', absJson(pointer));
    const originalAbi = disk.get('project.abi'), originalState = absJson(nativeState()), originalRecord = disk.get(key);
    const diagnosis = await inspect(tools);
    expect(diagnosis.diagnostics.issues).toEqual(['ABS_PROJECTION_UPGRADE_REQUIRED']);
    const plain: any = await tools.execute('abs_projection', { version: 2, requestId: crypto.randomUUID(), expectedAbiHash: await hashAbsText(originalAbi!) });
    expect(plain.code).toBe('ABS_PROJECTION_UPGRADE_REQUIRED');
    const upgraded = await rebind(tools, diagnosis.diagnostics.rebind.token);
    expect(upgraded.ok).withContext(JSON.stringify(upgraded)).toBeTrue();
    expect(JSON.parse(disk.get('project.abs.map.json')!).projectionVersion).toBe('abs-v2.preview.7');
    expect(disk.get(key)).toBe(originalRecord); expect(disk.get('project.abi')).toBe(originalAbi);
    expect(absJson(nativeState())).toBe(originalState); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect((await inspect(tools)).diagnostics.status).toBe('ready');
  });

  it('rejects stale inspection tokens after any mirror or target page changes', async () => {
    const { tools } = await wireBase(); project.currentProjectPath = 'D:/copied-project';
    const diagnosis = await inspect(tools);
    for (const key of ['project.abi', 'project.abs', 'project.abs.map.json']) {
      const previous = disk.get(key)!; disk.set(key, previous + ' '); const before = [...disk];
      expect((await rebind(tools, diagnosis.diagnostics.rebind.token)).code).toBe('ABS_REBIND_STALE');
      expect([...disk]).toEqual(before); disk.set(key, previous);
    }
    editor.switchPage('other'); const before = [...disk];
    expect((await rebind(tools, diagnosis.diagnostics.rebind.token)).code).toBe('ABS_REBIND_STALE'); expect([...disk]).toEqual(before);
  });

  it('refuses rebind initialization/custom outputs and corrupt authoritative baselines without writes', async () => {
    const { tools } = await wireBase(); project.currentProjectPath = 'D:/copied-project';
    const diagnosis = await inspect(tools), token = diagnosis.diagnostics.rebind.token, before = [...disk];
    for (const options of [{ initialize: true }, { publish: false }]) {
      expect((await rebind(tools, token, options)).code).toBe('ABS_REBIND_STALE'); expect([...disk]).toEqual(before);
    }
    const pointer = JSON.parse(disk.get('committed.json')!); disk.set(`baselines/${pointer.generation}.json`, '{}');
    const corrupted = [...disk]; expect((await inspect(tools)).code).toBe('ABS_BASELINE_CORRUPT');
    expect((await rebind(tools, token)).code).toBe('ABS_BASELINE_CORRUPT'); expect([...disk]).toEqual(corrupted);
  });

  it('recovers interrupted rebind publication with a derived ABI and retained recovery map', async () => {
    const { tools } = await wireBase(); disk.set('project.abs.map.json', 'damaged');
    const diagnosis = await inspect(tools), abi = disk.get('project.abi'), state = absJson(nativeState());
    failWrite = 'project.abs.map.json';
    const result = await rebind(tools, diagnosis.diagnostics.rebind.token);
    expect(result.ok).toBeFalse(); expect(result.publication.status).toBe('MIRROR_PENDING');
    const pending = await inspect(tools); expect(pending.pending.mode).toBe('import'); expect(pending.diagnostics.rebind).toBeUndefined();
    failWrite = undefined;
    const recovered: any = await tools.execute('abs_recovery', { version: 2, requestId: crypto.randomUUID(), action: 'recover' });
    expect(recovered.ok).toBeTrue(); expect(disk.get('project.abi')).toBe(abi); expect(absJson(nativeState())).toBe(state);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(await service.inspectRecovery()).toBeNull(); expect(gate.blocked).toBeTrue();
  });

  for (const chunk of [false, true]) it(`adds a declaration-backed block with sealed defaults and large data (${chunk ? 'chunk' : 'native'})`, async () => {
    if (chunk) renderWorkspace();
    const base = await baseline(), value = '通用新块文本😀'.repeat(6000);
    const result = await service.applyGeneration(base.source + `\nabs_declared_text(TEXT=${JSON.stringify(value)})`, base.generation, { chunk });
    expect(result.publication.status).toBe('COMMITTED');
    const added = editor.workspace.getBlocksByType('abs_declared_text')[0];
    expect(added.getFieldValue('TEXT')).toBe(value); expect(added.getFieldValue('FLAG')).toBe('TRUE');
    expect(roots().id).toBe('protected'); expect(roots().isDeletable()).toBeFalse();
    if (chunk) expect(added.getBoundingRectangle().top).toBeGreaterThan(roots().getBoundingRectangle().bottom);
    expect(disk.get('project.abi')!.length).toBeLessThan(6000);
    const committed = await new AbsBaselineStore(port, scope).loadCommitted();
    expect(committed!.contracts.fields[added.id]['FLAG'].type).toBe('field_checkbox');
  });

  it('validates new fields before native load and never accepts unknown declared fields', async () => {
    const base = await baseline();
    for (const code of ['abs_declared_text(FLAG="invalid")', 'abs_declared_text(UNKNOWN=1)']) {
      await expectAsync(service.applyGeneration(base.source + '\n' + code, base.generation)).toBeRejected();
    }
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(disk.has('project.abi')).toBeTrue();
  });

  it('binds a new declared variable field to an existing model without adding or renaming models', async () => {
    declare({ type: 'abs_declared_variable', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR', variable: 'kept' }], output: null });
    editor.workspace.getVariableMap().createVariable('kept', '', 'model-keep');
    const base = await baseline();
    await expectAsync(service.applyGeneration(base.source + '\nabs_declared_variable(VAR="missing")', base.generation)).toBeRejected();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    const result = await service.applyGeneration(base.source + '\nabs_declared_variable(VAR="kept")', base.generation);
    expect(result.publication.status).toBe('COMMITTED');
    expect(editor.workspace.getBlocksByType('abs_declared_variable')[0].getFieldValue('VAR')).toBe('model-keep');
    expect(editor.workspace.getAllVariables().map(variable => variable.getId())).toEqual(['model-keep']);
  });

  it('rejects replaced declaration provenance during a resource await before clearing', async () => {
    const base = await baseline();
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => {
      Blockly.Blocks['abs_declared_text'].init = () => {};
    });
    await expectAsync(service.applyGeneration(base.source + '\nabs_declared_text(TEXT="new")', base.generation)).toBeRejected();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(roots()).not.toBeNull();
  });

  it('still rejects library-added defaults on a new block instead of relaxing complete readback', async () => {
    const base = await baseline();
    editor.prepareProjectCode.and.callFake(async () => {
      editor.workspace.getBlocksByType('abs_declared_text')[0].setFieldValue('library changed', 'TEXT'); return null;
    });
    await expectAsync(service.applyGeneration(base.source + '\nabs_declared_text()', base.generation))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_READBACK_MISMATCH' }));
    expect(editor.workspace.getBlocksByType('abs_declared_text')).toEqual([]); expect(roots()).not.toBeNull();
  });

  for (const chunk of [false, true]) it(`preserves real IDs/protection/dormant shadow through ${chunk ? 'chunk' : 'native'} load and same-lock ABI/ABS/map commit`, async () => {
    if (chunk) renderWorkspace();
    const base = await baseline(); const result = await apply(base, { chunk });
    expect(result.publication.status).toBe('COMMITTED'); expect(result.appliedRevision).toBeDefined();
    expect(roots().getFieldValue('TEXT')).toBe('after'); expect(roots().isDeletable()).toBeFalse();
    expect(roots().isMovable()).toBeFalse(); expect(roots().data).toBe('opaque');
    expect(nativeState().blocks.blocks[0].inputs!['VALUE'].shadow!.id).toBe('dormant');
    expect(editor.workspace.getBlockById('child')).not.toBeNull();
    expect(JSON.parse(disk.get('project.abi')!).metadata).toBe('retained');
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1); expect(gate.blocked).toBeFalse();
    expect(await service.inspectRecovery()).toBeNull();
  });

  it('requires explicit initialization and preserves an unversioned source in the immutable record', async () => {
    disk.set('project.abs', 'legacy exact input\r\n');
    await expectAsync(service.exportGeneration()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_INITIALIZATION_REQUIRED' }));
    const result = await service.exportGeneration({ initialize: true });
    const record = JSON.parse(disk.get(`baselines/${result.publication.generation}.json`)!);
    expect(record.inputAbs).toBe('legacy exact input\r\n'); expect(disk.has('project.abi')).toBeTrue();
  });

  it('refuses public map edits and stale generations before changing the workspace', async () => {
    const base = await baseline(); const original = absJson(nativeState());
    await expectAsync(service.applyGeneration(base.source, 'old-generation')).toBeRejected();
    disk.set('project.abs.map.json', '{}'); await expectAsync(apply(base)).toBeRejected();
    expect(absJson(nativeState())).toBe(original); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('will not export over an unapplied ABS edit', async () => {
    await baseline(); disk.set('project.abs', 'external edit');
    await expectAsync(service.exportGeneration()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_CONFLICT' }));
    expect(disk.get('project.abs')).toBe('external edit');
  });

  it('does not rebaseline a saved ABI that diverges from the live document', async () => {
    const base = await baseline(); disk.set('project.abi', '{"external":true}');
    await expectAsync(service.exportGeneration()).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUAL_EDIT_CONFLICT' }));
    expect(disk.get('project.abs')).toBe(base.source); expect(await service.inspectRecovery()).toBeNull();
    expect(disk.get('project.abi')).toBe('{"external":true}');
  });

  it('allows a normal save of the current document to become the next baseline', async () => {
    const base = await baseline(); roots().setFieldValue('normally saved', 'TEXT');
    const prepared = await project.prepareSave(editor.captureProjectSnapshot().document, () => {});
    disk.set('project.abi', prepared.abiText);
    const result = await service.exportGeneration();
    expect(result.publication.status).toBe('COMMITTED'); expect(result.publication.generation).not.toBe(base.generation);
    expect(disk.get('project.abi')).toBe(prepared.abiText); expect(disk.get('project.abs')).toContain('normally saved');
  });

  for (const drift of ['viewport', 'root-layout']) it(`saves local code after ${drift}-only disk drift against the saved recipe`, async () => {
    const base = await baseline(), original = JSON.parse(disk.get('project.abi')!);
    const before = absJson(original.pages[0].content.blocks.blocks[0]);
    if (drift === 'viewport') original.pages[0].viewState = { scale: 1.25, scrollX: 100, scrollY: -30 };
    else original.pages[0].content.blocks.blocks[0].x += 200;
    disk.set('project.abi', JSON.stringify(original, null, 2));
    roots().setFieldValue('saved local edit', 'TEXT');
    const result = await service.exportGeneration({ save: true });
    expect(result.publication.status).toBe('COMMITTED');
    expect(result.publication.generation).not.toBe(base.generation);
    const after = JSON.parse(disk.get('project.abi')!);
    const retained = after.pages[0].content.blocks.blocks[0];
    const old = JSON.parse(before);
    expect(retained.id).toBe(old.id); expect(retained.data).toBe(old.data);
    expect(retained.deletable).toBeFalse(); expect(retained.movable).toBeFalse();
    expect(retained.inputs).toEqual(old.inputs); expect(retained.fields.TEXT).toBe('saved local edit');
    expect((await new AbsBaselineStore(port, scope).readDerivedAbi(result.publication.generation))).toBe(disk.get('project.abi'));
    expect(project.publishPreparedSaveOutputs).toHaveBeenCalledTimes(1);
  });

  it('retains a true external ABI edit and local edit without publishing any save acknowledgement', async () => {
    await baseline();
    const external = JSON.parse(disk.get('project.abi')!);
    external.pages[0].content.blocks.blocks[0].fields.TEXT = 'external edit';
    disk.set('project.abi', JSON.stringify(external));
    roots().setFieldValue('local edit', 'TEXT');
    const before = [...disk];
    await expectAsync(service.exportGeneration({ save: true })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DUAL_EDIT_CONFLICT' }));
    expect([...disk]).toEqual(before); expect(roots().getFieldValue('TEXT')).toBe('local edit');
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
  });

  it('compares against the saved recipe marker rather than substituting compact ABS state', async () => {
    editor.getProjectAbiForSave = document => ({ ...document, $ailyProjectData: { schemaVersion: 1, retained: 'recipe' } });
    const base = await baseline(), store = new AbsBaselineStore(port, scope);
    expect((await store.loadCommitted())!.document['$ailyProjectData']).toBeUndefined();
    const saved = JSON.parse((await store.readDerivedAbi(base.generation))!);
    expect(saved.$ailyProjectData.retained).toBe('recipe');
    saved.pages[0].viewState = { scale: 1, scrollX: 50, scrollY: -20 };
    disk.set('project.abi', JSON.stringify(saved)); roots().setFieldValue('local edit', 'TEXT');
    expect((await service.exportGeneration({ save: true })).publication.status).toBe('COMMITTED');
    expect(JSON.parse(disk.get('project.abi')!).$ailyProjectData).toEqual(saved.$ailyProjectData);
  });

  it('saves an existing old bare-writer marker upgrade without treating it as competing code', async () => {
    await baseline();
    const upgraded = { ...JSON.parse(disk.get('project.abi')!), $ailyProjectData: createProjectDataMarker() };
    disk.set('project.abi', JSON.stringify(upgraded));
    editor.getProjectAbiForSave = document => ({ ...document, $ailyProjectData: createProjectDataMarker() });
    roots().setFieldValue('local edit after upgrade', 'TEXT');
    expect((await service.exportGeneration({ save: true })).publication.status).toBe('COMMITTED');
    expect(JSON.parse(disk.get('project.abi')!).$ailyProjectData).toEqual(createProjectDataMarker());
    expect(disk.get('project.abs')).toContain('local edit after upgrade');
  });

  it('does not accept a missing resource while comparing an external representation change', async () => {
    await baseline(); const changed = JSON.parse(disk.get('project.abi')!);
    changed.pages[0].content.blocks.blocks[0].fields.TEXT = createAilyProjectDataValue({ $ailyData: {
      schemaVersion: 1, id: `sha256:${'0'.repeat(64)}`, codec: 'utf8-v1', logicalType: 'text',
      storage: 'raw-v1', rawLength: 6, storedLength: 6 } });
    disk.set('project.abi', JSON.stringify(changed)); roots().setFieldValue('local edit', 'TEXT');
    const before = [...disk];
    await expectAsync(service.exportGeneration({ save: true })).toBeRejectedWithError('missing resource');
    expect([...disk]).toEqual(before); expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
  });

  it('retains byte CAS when disk changes after the layout-only comparison', async () => {
    await baseline();
    const layout = JSON.parse(disk.get('project.abi')!); layout.pages[0].viewState = { scale: 2, scrollX: 0, scrollY: 0 };
    disk.set('project.abi', JSON.stringify(layout)); roots().setFieldValue('local edit', 'TEXT');
    editor.prepareProjectCode.and.callFake(async (_guard, owner) => {
      disk.set('project.abi', '{"newExternalWriter":true}');
      return { revision: editor.captureProjectSnapshot(owner).revision, code: '', artifacts: null, blockCodeMapText: null };
    });
    await expectAsync(service.exportGeneration({ save: true })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DISK_CONFLICT' }));
    expect(disk.get('project.abi')).toBe('{"newExternalWriter":true}');
    expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
  });

  it('does not adopt a changed committed pointer during an otherwise safe normal save', async () => {
    await baseline(); roots().setFieldValue('local edit', 'TEXT');
    const oldPointer = disk.get('committed.json')!;
    editor.prepareProjectCode.and.callFake(async (_guard, owner) => {
      disk.set('committed.json', JSON.stringify(JSON.parse(oldPointer), null, 2));
      return { revision: editor.captureProjectSnapshot(owner).revision, code: '', artifacts: null, blockCodeMapText: null };
    });
    await expectAsync(service.exportGeneration({ save: true })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_STALE' }));
    expect(disk.get('committed.json')).toBe(JSON.stringify(JSON.parse(oldPointer), null, 2));
    expect(disk.has('prepared.json')).toBeFalse(); expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
  });

  const prepareLoadedNormalization = async () => {
    const originalContent = disk.get('project.abi')!;
    const normalized = await normalizeProjectDataDocument({ projectPath: scope.projectKey,
      document: JSON.parse(originalContent), originalContent, materialize: true }, {
      put: request => projectDataRuntime.put(request), flushPending: () => projectDataRuntime.flushPending(),
      collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }),
      resolve: ref => projectDataRuntime.resolve(ref),
    }, () => undefined, { existsSync: () => true } as any);
    expect(normalized.deferredNormalization).toBeDefined();
    expect(disk.get('project.abi')).toBe(originalContent);
    const preparation = await prepareAbsLoadNormalization(scope.projectKey, normalized.deferredNormalization!, port, () => undefined);
    expect(preparation.input).toBeDefined();
    editor.restoreProjectWorkspaceSnapshot(normalized.document);
    expect(bindAbsLoadNormalizationReadback(preparation.input!, editor.captureProjectSnapshot())).toBeTrue();
    spyOn(project, 'rememberLoadedProject');
    editor.prepareProjectCode.calls.reset(); editor.publishAbsContext.calls.reset();
    return { input: preparation.input!, document: normalized.document, originalContent };
  };

  it('publishes a native-readback load normalization through the journal and retains every original source', async () => {
    roots().setDisabledReason(true, 'MANUALLY_DISABLED'); roots().setCollapsed(true);
    const base = await baseline(), before = [...disk];
    const normalized = await prepareLoadedNormalization();
    const result = await project.publishLoadedNormalization(normalized.input);
    expect(result.status).toBe('COMMITTED');
    if (result.status !== 'COMMITTED') return;
    expect(result.generation).not.toBe(base.generation); expect(result.abiText).toBe(disk.get('project.abi'));
    const store = new AbsBaselineStore(port, scope), archive = await store.inspectRepair(result.generation);
    expect(archive.archive.disk).toEqual(normalized.input.expected.disk);
    expect(archive.archive.disk.abi).toBe(normalized.originalContent);
    expect(archive.archive.committed.pointer).toBe(new Map(before).get('committed.json'));
    expect(archive.archive.committed.baseline).toBe(new Map(before).get(absBaselineKey(base.generation)));
    expect(disk.get(absBaselineKey(base.generation))).toBe(new Map(before).get(absBaselineKey(base.generation)));
    expect(await store.readDerivedAbi(result.generation)).toBe(result.abiText);
    const root = JSON.parse(result.abiText).pages[0].content.blocks.blocks[0];
    const original = JSON.parse(normalized.originalContent).pages[0].content.blocks.blocks[0];
    expect(root).toEqual(original); expect(root.collapsed).toBeTrue(); expect(root.deletable).toBeFalse();
    expect(project.rememberLoadedProject).toHaveBeenCalledTimes(1);
    expect(editor.publishAbsContext).toHaveBeenCalledTimes(1);
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(project.publishPreparedSaveOutputs).not.toHaveBeenCalled();
    expect(await store.inspectPending()).toBeNull(); expect(gate.blocked).toBeFalse();
    roots().setFieldValue('after migrated load', 'TEXT');
    expect((await service.exportGeneration({ save: true })).publication.status).toBe('COMMITTED');
    expect(disk.get('project.abs')).toContain('after migrated load');
  });

  for (const conflict of ['draft', 'pending', 'disk', 'canvas', 'layout', 'viewport']) it(`retains ${conflict} appearing after normalization preparation`, async () => {
    await baseline(); const normalized = await prepareLoadedNormalization();
    if (conflict === 'draft') disk.set('project.abs', disk.get('project.abs')! + '\n# unapplied intent\n');
    if (conflict === 'pending') disk.set('prepared.json', disk.get('committed.json')!);
    if (conflict === 'disk') disk.set('project.abi', '{"newExternalWriter":true}');
    if (conflict === 'canvas') roots().setFieldValue('new local edit', 'TEXT');
    if (conflict === 'layout') roots().moveBy(25, 10);
    if (conflict === 'viewport') editor.setViewState({ scale: 1.5, scrollX: 25, scrollY: 0 });
    const before = [...disk];
    const result = await project.publishLoadedNormalization(normalized.input);
    expect(result.status).toBe('DEFERRED');
    if (result.status === 'DEFERRED') expect(result.recovery).toEqual(jasmine.objectContaining({
      tool: 'project_recover', arguments: { action: 'inspect', project: scope.projectKey } }));
    expect([...disk]).toEqual(before); expect(project.rememberLoadedProject).not.toHaveBeenCalled();
    expect(editor.publishAbsContext).not.toHaveBeenCalled(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    if (conflict === 'canvas') expect(roots().getFieldValue('TEXT')).toBe('new local edit');
  });

  it('defers a viewport edit during asynchronous normalization preparation instead of acknowledging it as saved', async () => {
    await baseline(); const normalized = await prepareLoadedNormalization(), before = [...disk];
    const prepare = project.prepareSave.bind(project);
    spyOn(project, 'prepareSave').and.callFake(async (...args) => {
      const result = await prepare(...args); editor.setViewState({ scale: 1.25, scrollX: 150, scrollY: 0 }); return result;
    });
    expect((await project.publishLoadedNormalization(normalized.input)).status).toBe('DEFERRED');
    expect([...disk]).toEqual(before); expect(project.rememberLoadedProject).not.toHaveBeenCalled();
    expect(editor.captureProjectSnapshot().document.pages[0].viewState.scrollX).toBe(150);
    expect(gate.blocked).toBeFalse();
  });

  it('defers a viewport change between staging and the real pre-journal commit guard', async () => {
    await baseline(); const normalized = await prepareLoadedNormalization();
    const originalMirrors = { abi: disk.get('project.abi'), abs: disk.get('project.abs'),
      map: disk.get('project.abs.map.json'), pointer: disk.get('committed.json') };
    const withLock: AbsSyncStoragePort['withLock'] = port.withLock.bind(port);
    let archived = false, changed = false;
    spyOn(port, 'withLock').and.callFake(async <T>(operation: (storage: AbsSyncStorageAccess) => Promise<T>): Promise<T> => {
      const result = await withLock(operation);
      if ((result as any)?.key?.startsWith('recoveries/')) archived = true;
      else if (archived && !changed && result === undefined) {
        // The actual stage lock has exited. Commit still performs its real
        // async baseline/archive/disk reads before asserting native state.
        changed = true; editor.setViewState({ scale: 1.25, scrollX: 175, scrollY: 0 });
      }
      return result;
    });
    const result = await project.publishLoadedNormalization(normalized.input);
    expect(changed).toBeTrue(); expect(result.status).toBe('DEFERRED');
    if (result.status === 'DEFERRED') expect(result.code).toBe('ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
    expect({ abi: disk.get('project.abi'), abs: disk.get('project.abs'),
      map: disk.get('project.abs.map.json'), pointer: disk.get('committed.json') }).toEqual(originalMirrors);
    expect(disk.has('prepared.json')).toBeFalse();
    expect(editor.captureProjectSnapshot().document.pages[0].viewState.scrollX).toBe(175);
    expect(project.rememberLoadedProject).not.toHaveBeenCalled(); expect(editor.publishAbsContext).not.toHaveBeenCalled();
    expect(gate.blocked).toBeFalse();
  });

  it('retains the source and journal when load normalization commits ABI but its ABS mirror fails', async () => {
    await baseline(); const normalized = await prepareLoadedNormalization(); failWrite = 'project.abs';
    const result = await project.publishLoadedNormalization(normalized.input);
    expect(result.status).toBe('DEFERRED'); expect(gate.blocked).toBeTrue();
    expect(project.rememberLoadedProject).not.toHaveBeenCalled(); expect(editor.publishAbsContext).not.toHaveBeenCalled();
    const store = new AbsBaselineStore(port, scope), pending = (await store.inspectPending())!;
    expect(pending.abiSaved).toBeTrue();
    expect((await store.inspectRepair(pending.generation)).archive.disk.abi).toBe(normalized.originalContent);
    failWrite = undefined;
    expect((await store.recover(() => undefined))!.status).toBe('COMMITTED');
    expect(gate.blocked).toBeTrue(); // Disk repair is not a forged native reload acknowledgement.
  });

  it('does not quarantine a confirmed pre-ABI normalization failure', async () => {
    await baseline(); const normalized = await prepareLoadedNormalization(); failWrite = 'project.abi';
    expect((await project.publishLoadedNormalization(normalized.input)).status).toBe('DEFERRED');
    expect(disk.get('project.abi')).toBe(normalized.originalContent); expect(gate.blocked).toBeFalse();
    expect((await new AbsBaselineStore(port, scope).inspectPending())!.status).toBe('NOT_COMMITTED');
    expect(project.rememberLoadedProject).not.toHaveBeenCalled();
  });

  it('reports a lost normalization commit receipt without repeating the load or fabricating clean state', async () => {
    await baseline(); const normalized = await prepareLoadedNormalization(); loseCommitReply = true;
    await expectAsync(project.publishLoadedNormalization(normalized.input))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_LOAD_NORMALIZATION_OUTCOME_UNKNOWN' }));
    expect(project.rememberLoadedProject).not.toHaveBeenCalled(); expect(editor.publishAbsContext).not.toHaveBeenCalled();
    const store = new AbsBaselineStore(port, scope), committed = (await store.loadCommitted())!;
    expect(committed.map.generation).not.toBe(normalized.input.expected.generation);
    expect((await store.inspectRepair(committed.map.generation)).archive.disk.abi).toBe(normalized.originalContent);
    expect(await store.inspectPending()).toBeNull(); expect(gate.blocked).toBeTrue();
    expect(editor.prepareProjectCode).not.toHaveBeenCalled();
  });

  it('rejects deletion of any protected type and new/dynamic shapes before native load', async () => {
    const base = await baseline(); const original = absJson(nativeState());
    for (const source of ['# ABS Schema: 2\n', base.source + '\ntext(TEXT="new")']) {
      await expectAsync(service.applyGeneration(source, base.generation)).toBeRejected();
    }
    await expectAsync(service.applyGeneration(base.source.replace('abs_sync_root(', 'other_root('), base.generation)).toBeRejected();
    await expectAsync(service.applyGeneration(splitAbsState(base.source).program.trimEnd() + ' @extra:{"shape":2}\n', base.generation))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_RUNTIME_SHAPE_UNSUPPORTED' }));
    expect(absJson(nativeState())).toBe(original); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('externalizes an edited large text and validates native readback against its full materialized value', async () => {
    const base = await baseline(); const large = '通用文本😀'.repeat(8000);
    const result = await service.applyGeneration(base.source.replace('TEXT="before"', `TEXT=${JSON.stringify(large)}`), base.generation);
    expect(result.publication.status).toBe('COMMITTED'); expect(roots().getFieldValue('TEXT')).toBe(large);
    expect(disk.get('project.abs')).toContain('$ailyProjectDataValue'); expect(disk.get('project.abi')!.length).toBeLessThan(5000);
  });

  it('a missing resource fails before clearing the existing workspace', async () => {
    const base = await baseline();
    const ref = createAilyProjectDataValue({ $ailyData: { schemaVersion: 1, id: ('sha256:' + '0'.repeat(64)) as `sha256:${string}`,
      codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: 50000, storedLength: 50000 } });
    await expectAsync(service.applyGeneration(base.source.replace('TEXT="before"', `TEXT=${JSON.stringify(ref)}`), base.generation)).toBeRejected();
    expect(roots().getFieldValue('TEXT')).toBe('before'); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('complete readback rejects a library changing requested fields and restores the full original state', async () => {
    const base = await baseline(); const original = absJson(nativeState());
    editor.prepareProjectCode.and.callFake(async () => { roots().setFieldValue('library changed', 'TEXT'); return null; });
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_READBACK_MISMATCH' }));
    expect(absJson(nativeState())).toBe(original); expect(disk.has('project.abi')).toBeTrue(); expect(gate.blocked).toBeFalse();
    expect(editor.restoreProjectWorkspaceSnapshot.calls.mostRecent().args[2]).toEqual(JSON.parse(original).blocks.blocks.map(block => block.id));
    expect(editor.requestWorkspaceVisualRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not allow Generator model additions to bypass complete state verification', async () => {
    const base = await baseline();
    editor.prepareProjectCode.and.callFake(async () => { editor.workspace.getVariableMap().createVariable('unexpected'); return null; });
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_READBACK_MISMATCH' }));
    expect(editor.workspace.getAllVariables()).toEqual([]); expect(roots().getFieldValue('TEXT')).toBe('before');
  });

  it('does not let complete active-workspace readback hide changes to an inactive page', async () => {
    const base = await baseline();
    editor.prepareProjectCode.and.callFake(async () => { editor.mutateOtherPage(); return null; });
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_PROJECT_ENVELOPE_CHANGED' }));
    expect(disk.has('project.abi')).toBeTrue();
  });

  it('external ABI conflict before commit restores memory but never overwrites external bytes', async () => {
    const base = await baseline(); const originalPrepare = project.prepareSave.bind(project);
    spyOn(project, 'prepareSave').and.callFake(async (...args) => { const prepared = await originalPrepare(...args); disk.set('project.abi', '{"external":true}'); return prepared; });
    expect((await apply(base)).publication.status).toBe('CONFLICT');
    expect(roots().getFieldValue('TEXT')).toBe('before'); expect(disk.get('project.abi')).toBe('{"external":true}');
  });

  it('post-ABI mirror failure keeps the applied state, permits disk-only inspection/recovery, and never clears quarantine', async () => {
    const base = await baseline(); failWrite = 'project.abs';
    const result = await apply(base); expect(result.publication.status).toBe('MIRROR_PENDING'); expect(result.requiresReload).toBeTrue();
    expect(roots().getFieldValue('TEXT')).toBe('after'); expect(gate.blocked).toBeTrue();
    const abi = disk.get('project.abi'); expect((await service.inspectRecovery())!.abiSaved).toBeTrue();
    failWrite = undefined;
    expect((await service.recoverGeneration())!.status).toBe('COMMITTED'); expect(disk.get('project.abi')).toBe(abi);
    expect(await service.recoverGeneration()).toBeNull(); expect(gate.blocked).toBeTrue();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('an unknown commit acknowledgement never triggers workspace rollback', async () => {
    const base = await baseline(); loseCommitReply = true;
    await expectAsync(apply(base)).toBeRejectedWithError('lost commit acknowledgement');
    expect(roots().getFieldValue('TEXT')).toBe('after'); expect(gate.blocked).toBeTrue();
    expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('a definite pre-ABI failure restores memory and can be explicitly abandoned without deleting its baseline', async () => {
    const base = await baseline(); failWrite = 'project.abi';
    const result = await apply(base); expect(result.publication.status).toBe('NOT_COMMITTED');
    expect(roots().getFieldValue('TEXT')).toBe('before'); expect(gate.blocked).toBeFalse();
    expect((await service.inspectRecovery())!.abiSaved).toBeFalse();
    expect((await service.recoverGeneration())!.status).toBe('NOT_COMMITTED');
    await service.abandonGeneration(result.publication.generation);
    expect(await service.inspectRecovery()).toBeNull();
    expect(disk.has(`baselines/${result.publication.generation}.json`)).toBeTrue(); expect(disk.has('project.abi')).toBeTrue();
  });

  it('a failed rollback is reported and quarantined, never automatically retried', async () => {
    const base = await baseline();
    editor.prepareProjectCode.and.callFake(async () => { roots().setFieldValue('changed', 'TEXT'); return null; });
    editor.restoreProjectWorkspaceSnapshot.and.throwError('restore failed');
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_ROLLBACK_FAILED' }));
    expect(gate.blocked).toBeTrue(); expect(editor.restoreProjectWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores event grouping/undo policy without manufacturing serialized block flags', async () => {
    const base = await baseline(); const oldGroup = Blockly.Events.getGroup(), oldUndo = Blockly.Events.getRecordUndo();
    Blockly.Events.setGroup('caller-group'); Blockly.Events.setRecordUndo(false);
    try {
      await apply(base);
      expect(Blockly.Events.getGroup()).toBe('caller-group'); expect(Blockly.Events.getRecordUndo()).toBeFalse();
      expect(roots().isDeletable()).toBeFalse(); expect(Blockly.Events.isEnabled()).toBeTrue();
    } finally { Blockly.Events.setGroup(oldGroup); Blockly.Events.setRecordUndo(oldUndo); }
  });

  it('post-commit derived output failure is a warning, not a source rollback', async () => {
    const base = await baseline(); (project.publishPreparedSaveOutputs as jasmine.Spy).and.rejectWith(new Error('header disk full'));
    const result = await apply(base);
    expect(result.publication.status).toBe('COMMITTED'); expect(result.warnings.length).toBe(1);
    expect(result.derivedOutputs).toEqual(jasmine.objectContaining({ published: false, code: 'PROJECT_DERIVED_OUTPUT_PENDING', error: 'header disk full' }));
    expect(roots().getFieldValue('TEXT')).toBe('after'); expect(gate.blocked).toBeFalse();
    expect(editor.requestWorkspaceVisualRefresh).toHaveBeenCalledTimes(1);
  });

  for (const publicationFailure of [false, true]) it('reports a caught generator failure after committed apply, publication failure=' + publicationFailure, async () => {
    const { tools, request, source } = await wireBase();
    const validated: any = await tools.execute('abs_validate', request, source);
    expect(validated.ok).toBeTrue();
    editor.prepareProjectCode.and.callFake(async (_assertCurrent, lease) => ({
      revision: editor.captureProjectSnapshot(lease).revision, code: null, artifacts: null, blockCodeMapText: null,
      error: '[BLOCKLY_GENERATOR_MISSING] missing generator fixture',
    }));
    if (publicationFailure) (project.publishPreparedSaveOutputs as jasmine.Spy).and.rejectWith(new Error('header write failed'));
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(result.ok).toBeTrue(); expect(result.publication.status).toBe('COMMITTED');
    expect(result.receipt.validation.scope).toBe('complete-generation');
    expect(result.derivedOutputs.published).toBeFalse(); expect(result.derivedOutputs.code).toBe('PROJECT_CODE_GENERATION_FAILED');
    expect(result.derivedOutputs.error).toContain('missing generator fixture');
    expect(result.warnings.length).toBe(publicationFailure ? 2 : 1);
    if (publicationFailure) expect(result.derivedOutputs.error).toContain('header write failed');
    expect(disk.get('project.abs')).toBeDefined(); expect(roots().getFieldValue('TEXT')).toBe('wire edit');
    expect(gate.blocked).toBeFalse(); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  for (const missing of ['null', 'empty-error']) it('does not certify generated artifacts for a missing preparation: ' + missing, async () => {
    const { tools, request, source } = await wireBase();
    const validated: any = await tools.execute('abs_validate', request, source);
    editor.prepareProjectCode.and.callFake(async (_assertCurrent, lease) => missing === 'null' ? null : {
      revision: editor.captureProjectSnapshot(lease).revision, code: null, artifacts: null, blockCodeMapText: null, error: '',
    });
    const result: any = await tools.execute('abs_apply', { version: 2, requestId: request.requestId, validation: validated.receipt }, source);
    expect(result.ok).toBeTrue(); expect(result.publication.status).toBe('COMMITTED');
    expect(result.derivedOutputs).toEqual(jasmine.objectContaining({ published: false, code: 'PROJECT_CODE_GENERATION_FAILED' }));
    expect(result.derivedOutputs.error).toContain('did not produce code'); expect(result.warnings.length).toBe(1);
    expect(roots().getFieldValue('TEXT')).toBe('wire edit'); expect(gate.blocked).toBeFalse();
  });

  it('keeps an attempted generator failure visible when an unchanged ABS baseline is reused', async () => {
    const base = await baseline(), before = [...disk];
    editor.prepareProjectCode.and.resolveTo(null);
    const result = await service.exportGeneration({ save: true, reuseCurrent: true });
    expect(result.reused).toBeTrue(); expect(result.publication.generation).toBe(base.generation);
    expect(result.derivedOutputs).toEqual(jasmine.objectContaining({ published: false, code: 'PROJECT_CODE_GENERATION_FAILED' }));
    expect(result.warnings.length).toBe(1); expect([...disk]).toEqual(before);
  });

  it('queued work is bound to its original page/project/runtime, not a later activation', async () => {
    const pending = service.exportGeneration(); project.currentProjectPath = 'D:/new-project';
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CONTEXT_STALE' }));
    expect(disk.size).toBe(0);
  });

  it('an asynchronous preparation edit is retained rather than rolled back as an import', async () => {
    const base = await baseline();
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => { roots().setFieldValue('later edit', 'TEXT'); });
    await expectAsync(apply(base)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
    expect(roots().getFieldValue('TEXT')).toBe('later edit'); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('publishes selection context only for committed generations, not preview or uncertain saves', async () => {
    await service.exportGeneration({ publish: false });
    expect(editor.publishAbsContext).not.toHaveBeenCalled();
    const base = await baseline();
    expect(editor.publishAbsContext).toHaveBeenCalledTimes(1);
    failWrite = 'project.abs';
    expect((await apply(base)).requiresReload).toBeTrue();
    expect(editor.publishAbsContext).toHaveBeenCalledTimes(1);
  });

  it('queues direct Agent mutations behind export and rejects stale queued owners', async () => {
    const adapter = new BlocklyEditorAutomationAdapter(project as any, editor);
    let release!: () => void;
    (projectDataRuntime.flushPending as jasmine.Spy).and.returnValue(new Promise<void>(resolve => release = resolve));
    const exporting = service.exportGeneration();
    const mutate = jasmine.createSpy('mutation').and.resolveTo('done');
    const pending = adapter.runWorkspaceOperation(mutate);
    await Promise.resolve(); expect(mutate).not.toHaveBeenCalled();
    release(); await exporting; expect(await pending).toBe('done');
    const stale = adapter.runWorkspaceOperation(mutate); project.currentProjectPath = 'D:/other';
    await expectAsync(stale).toBeRejectedWithError(/stale/);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('blocks direct workspace access during a lease and invalidates queued board reconfiguration', async () => {
    const adapter = new BlocklyEditorAutomationAdapter(project as any, editor);
    const lease = editor.acquireWorkspaceEditLease();
    expect(() => adapter.getWorkspace()).toThrow();
    lease.release(); expect(adapter.getWorkspace()).toBe(editor.workspace);
    const runtime = new BlocklyGeneratorRuntimeService();
    runtime.activate({ mode: 'arduino', getWorkspace: () => editor.workspace });
    try {
      const mutate = jasmine.createSpy('mutate').and.resolveTo();
      const pending = adapter.runWorkspaceOperation(mutate); runtime.updateBoardConfig({ pins: [99] });
      await expectAsync(pending).toBeRejectedWithError(/stale/); expect(mutate).not.toHaveBeenCalled();
    } finally { runtime.destroy(); }
  });

  for (const mode of ['export', 'apply']) it(`rejects inactive-page edits during ${mode} preparation before loading`, async () => {
    const base = await baseline(), clear = spyOn(editor.workspace, 'clear').and.callThrough();
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => editor.mutateOtherPage());
    await expectAsync(mode === 'export' ? service.exportGeneration() : apply(base))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_REVISION_STALE' }));
    expect(clear).not.toHaveBeenCalled(); expect(disk.get('project.abs')).toBe(base.source);
    expect(gate.blocked).toBeFalse();
  });

  it('holds queued saves through chunk loading, readback and committed publication', async () => {
    renderWorkspace(); const base = await baseline();
    let queued: Promise<void> | undefined;
    const saving = jasmine.createSpy('queuedSave').and.callFake(async () => {
      expect(roots().getFieldValue('TEXT')).toBe('after');
      expect(disk.get('project.abs')).toContain('TEXT="after"');
    });
    const result = await apply(base, { chunk: true, onProgress: () => {
      queued ??= editor.runProjectOperation(saving);
      expect(saving).not.toHaveBeenCalled();
    } });
    expect(result.publication.status).toBe('COMMITTED');
    expect(queued).toBeDefined(); await queued; expect(saving).toHaveBeenCalledTimes(1);
  });

  describe('explicit existing block state coordinator', () => {
    for (const id of ['x'.repeat(300), 'x'.repeat(512), '😀'.repeat(256)]) {
      it('saves an exact inspected native ID without truncation, preserving state and protection: ' + id.length + ' UTF-16 units', async () => {
        const state = nativeState(); state.blocks.blocks[0].id = id;
        Blockly.serialization.workspaces.load(state, editor.workspace);
        const live = editor.workspace.getBlockById(id)!;
        live.setDisabledReason(true, 'LIBRARY_RULE');
        const original = editor.captureProjectSnapshot().document;
        const base = await baseline();
        const inspection = await service.setBlockState({ version: 2, requestId: 'state-id-request-0001',
          action: 'inspect', blockTypes: ['abs_sync_root'] });
        expect(inspection.instances[0].blockId).toBe(id); expect(inspection.expectedGeneration).toBe(base.generation);
        const result = await service.setBlockState({ version: 2, requestId: 'state-id-request-0002', action: 'update',
          expectedGeneration: inspection.expectedGeneration,
          changes: [{ blockId: inspection.instances[0].blockId, disabled: true, collapsed: true }] });
        expect(result.ok).toBeTrue(); expect(result.publication.status).toBe('COMMITTED');
        expect(result.receipt.states[0].blockId).toBe(id);
        expect(editor.workspace.getBlockById(id)).toBe(live); expect(live.isDeletable()).toBeFalse();
        expect([...live.getDisabledReasons()]).toEqual(['LIBRARY_RULE', 'MANUALLY_DISABLED']);
        const savedDocument = JSON.parse(disk.get('project.abi')!), saved = composeBlocklyPage(savedDocument, 'main');
        expect(saved.blocks.blocks[0].id).toBe(id); expect(saved.blocks.blocks[0].data).toBe('opaque');
        expect(saved.blocks.blocks[0].fields.TEXT).toBe('before');
        expect(saved.blocks.blocks[0].deletable).toBeFalse(); expect(saved.blocks.blocks[0].movable).toBeFalse();
        expect(saved.blocks.blocks[0].collapsed).toBeTrue(); expect(saved.blocks.blocks[0].disabledReasons).toEqual(['LIBRARY_RULE', 'MANUALLY_DISABLED']);
        expect(savedDocument.sharedModel).toEqual(original.sharedModel); expect(savedDocument.pages[1]).toEqual(original.pages[1]);
        expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
      });
    }

    it('rejects a mixed over-limit batch before native setters, persistence or generation work', async () => {
      const base = await baseline(), before = [...disk], live = roots();
      const setter = spyOn(live, 'setDisabledReason').and.callThrough();
      await expectAsync(Promise.resolve().then(() => service.setBlockState({ version: 2, requestId: 'state-id-request-0001', action: 'update',
        expectedGeneration: base.generation, changes: [{ blockId: 'protected', disabled: true },
          { blockId: 'x'.repeat(513), collapsed: true }] })))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BLOCK_STATE_ID_LIMIT', publication: { status: 'NOT_COMMITTED' } }));
      expect(setter).not.toHaveBeenCalled(); expect([...disk]).toEqual(before);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });

    const stateRequest = (generation: string, changes = [{ blockId: 'protected', disabled: true, collapsed: true }]) => ({
      version: 2, requestId: 'state-request-000001', action: 'update', expectedGeneration: generation, changes,
    });
    const inspectState = () => service.setBlockState({ version: 2, requestId: 'state-request-000001',
      action: 'inspect', blockIds: ['protected'] });
    const firstState = (expectedCanvas: string) => service.setBlockState({ version: 2, requestId: 'state-request-000002',
      action: 'update', expectedCanvas, changes: [{ blockId: 'protected', disabled: true }] });

    it('discovers live IDs before a first export without probing broken providers, flushing or writing', async () => {
      const root = roots(), field = new Blockly.FieldDropdown(() => [['Alpha', 'A']]);
      root.appendDummyInput('DYNAMIC_OPTIONS').appendField(field, 'MODE');
      const provider = spyOn(field, 'getOptions').and.throwError('first export provider failure');
      const before = [...disk], result = await inspectState();
      expect(result.ok).toBeTrue(); expect(result.baseline.status).toBe('missing');
      expect(result.expectedGeneration).toBeUndefined(); expect(result.expectedCanvas).toEqual(jasmine.any(String));
      expect(result.receipt.expectedCanvas).toBe(result.expectedCanvas);
      expect(result.instances[0].blockId).toBe('protected'); expect(result.instances[0].sourceRange).toBeUndefined();
      expect(provider).not.toHaveBeenCalled(); expect(projectDataRuntime.flushPending).not.toHaveBeenCalled();
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect([...disk]).toEqual(before);
    });

    for (const existingAbi of [false, true]) it('bootstraps the first generation only after explicit inspected disable, existing ABI=' + existingAbi, async () => {
      const root = roots(), field = new Blockly.FieldDropdown(() => [['Alpha', 'A']]);
      root.appendDummyInput('DYNAMIC_OPTIONS').appendField(field, 'MODE');
      const provider = spyOn(field, 'getOptions').and.throwError('first export provider failure');
      if (existingAbi) disk.set('project.abi', absJson(editor.captureProjectSnapshot().document));
      const oldAbi = disk.get('project.abi') ?? null;
      disk.set('project.abs', 'old unapplied user draft');
      const inspection = await inspectState(), result = await firstState(inspection.expectedCanvas);
      expect(result.ok).toBeTrue(); expect(result.publication.status).toBe('COMMITTED');
      expect(result.receipt.expectedCanvas).toBe(inspection.expectedCanvas); expect(result.receipt.expectedGeneration).toBeUndefined();
      expect(result.receipt.inputAbiHash).toBe(oldAbi === null ? null : await hashAbsText(oldAbi));
      expect(result.receipt.output.binding.generation).toEqual(jasmine.any(String));
      expect(provider).not.toHaveBeenCalled(); expect(root.isEnabled()).toBeFalse(); expect(root.isDeletable()).toBeFalse();
      expect(roots()).toBe(root); expect(disk.get('project.abs')).toContain('@disabled');
      const baselineRecord = JSON.parse(disk.get(absBaselineKey(result.receipt.output.binding.generation))!);
      expect(baselineRecord.inputAbs).toBe('old unapplied user draft');
      expect(result.draftArchive).toEqual(jasmine.objectContaining({ generation: result.receipt.output.binding.generation,
        baseGeneration: null, origin: 'initial-baseline' }));
      const recoveredDraft = await service.readArchivedDraft(result.draftArchive.generation);
      expect(recoveredDraft.abs).toBe('old unapplied user draft'); expect(recoveredDraft.baseGeneration).toBeNull();
      expect(recoveredDraft.hash).toBe(await hashAbsText('old unapplied user draft'));
      expect((await new AbsBaselineStore(port, scope).loadCommitted())!.map.generation).toBe(result.receipt.output.binding.generation);
      expect(gate.blocked).toBeFalse();
    });

    for (const changed of ['canvas', 'disk', 'inactive-page']) it('rejects a stale first-baseline inspection before native mutation: ' + changed, async () => {
      const inspection = await inspectState(), root = roots();
      if (changed === 'canvas') root.setFieldValue('later user edit', 'TEXT');
      if (changed === 'disk') disk.set('project.abs', 'later external draft');
      if (changed === 'inactive-page') editor.mutateOtherPage();
      const before = [...disk];
      await expectAsync(firstState(inspection.expectedCanvas)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BLOCK_STATE_INSPECTION_STALE' }));
      expect(root.isEnabled()).toBeTrue(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
      expect([...disk]).toEqual(before); expect(gate.blocked).toBeFalse();
    });

    it('returns states from the same canvas boundary as its token after asynchronous disk inspection', async () => {
      const read = port.read.bind(port);
      spyOn(port, 'read').and.callFake(async key => {
        if (key === 'project.abs') roots().setCollapsed(true);
        return read(key);
      });
      const result = await inspectState();
      expect(result.instances[0].collapsed).toBeTrue(); expect(result.expectedCanvas).toEqual(jasmine.any(String));
    });

    it('rejects a token after the declarative catalog changes even when the canvas and runtime epoch do not', async () => {
      const result = await inspectState();
      declare({ type: 'state_later_catalog', message0: 'new definition', previousStatement: null });
      await expectAsync(firstState(result.expectedCanvas)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BLOCK_STATE_INSPECTION_STALE' }));
      expect(roots().isEnabled()).toBeTrue(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    });

    for (const bad of ['orphan-map', 'invalid-pointer']) it('still inspects live state but never grants bootstrap authority for ' + bad, async () => {
      disk.set(bad === 'orphan-map' ? 'project.abs.map.json' : 'committed.json', '{}');
      const before = [...disk], result = await inspectState();
      expect(result.ok).toBeTrue(); expect(result.instances[0].blockId).toBe('protected');
      expect(result.baseline.status).toBe('unavailable'); expect(result.expectedCanvas).toBeUndefined();
      expect(result.expectedGeneration).toBeUndefined(); expect([...disk]).toEqual(before);
    });

    it('restores a definitely uncommitted first state change and exposes its journal without granting another token', async () => {
      const inspection = await inspectState(), root = roots(); failWrite = 'project.abi';
      const result = await firstState(inspection.expectedCanvas);
      expect(result.ok).toBeFalse(); expect(result.publication.status).toBe('NOT_COMMITTED');
      expect(result.application).toBe('ROLLED_BACK'); expect(root.isEnabled()).toBeTrue();
      expect(disk.has('project.abi')).toBeFalse(); expect(gate.blocked).toBeFalse();
      failWrite = undefined;
      const next = await inspectState();
      expect(next.ok).toBeTrue(); expect(next.baseline).toEqual({ status: 'unavailable', code: 'ABS_TRANSACTION_PENDING' });
      expect(next.expectedCanvas).toBeUndefined(); expect(next.instances[0].blockId).toBe('protected');
    });

    it('does not advertise ordinary generated sources as first-baseline draft archives', async () => {
      const base = await baseline();
      await expectAsync(service.readArchivedDraft(base.generation)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DRAFT_ARCHIVE_MISSING' }));
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.draftArchive).toBeUndefined();
      await expectAsync(service.readArchivedDraft(result.receipt.output.binding.generation))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DRAFT_ARCHIVE_MISSING' }));
    });
    it('inspects exact live IDs and committed locations without publishing or generating', async () => {
      const base = await baseline(), before = [...disk];
      const result = await service.setBlockState({ version: 2, requestId: 'state-request-000001', action: 'inspect', blockIds: ['protected'], limit: 1 });
      expect(result.ok).toBeTrue(); expect(result.expectedGeneration).toBe(base.generation);
      expect(result.instances).toEqual([jasmine.objectContaining({ blockId: 'protected', type: 'abs_sync_root', manualDisabled: false, collapsed: false })]);
      expect(result.instances[0].sourceRange.start).toBeGreaterThanOrEqual(0);
      expect([...disk]).toEqual(before); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    });
    it('commits manual/collapse changes, keeps library reasons and preserves native instances and protection', async () => {
      roots().setDisabledReason(true, 'LIBRARY_RULE');
      const base = await baseline(), root = roots();
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeTrue(); expect(result.projectSaved).toBeTrue(); expect(result.partial).toBeFalse();
      expect(result.publication.status).toBe('COMMITTED'); expect(result.receipt.output.binding.generation).not.toBe(base.generation);
      expect(result.receipt.beforeStates[0].disabledReasons).toEqual(['LIBRARY_RULE']);
      expect(result.receipt.states[0]).toEqual(jasmine.objectContaining({ manualDisabled: true, collapsed: true, disabledReasons: ['LIBRARY_RULE', 'MANUALLY_DISABLED'] }));
      expect(result.receipt.output.binding.abiHash).toBe(await hashAbsText(disk.get('project.abi')!));
      expect(result.receipt.output.binding.mapHash).toBe(await hashAbsText(disk.get('project.abs.map.json')!));
      expect(result.abs).toBe(disk.get('project.abs')); expect(result.abs).toContain('@disabled');
      expect(roots()).toBe(root); expect(roots().isDeletable()).toBeFalse();
      expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
      const saved = composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main');
      expect(saved.blocks.blocks[0]['collapsed']).toBeTrue(); expect(saved.blocks.blocks[0]['disabledReasons']).toEqual(['LIBRARY_RULE', 'MANUALLY_DISABLED']);
    });
    it('persists clearing only the manual reason without claiming the library-disabled block is enabled', async () => {
      roots().setDisabledReason(true, 'LIBRARY_RULE'); roots().setDisabledReason(true, 'MANUALLY_DISABLED');
      const base = await baseline();
      const result = await service.setBlockState(stateRequest(base.generation, [{ blockId: 'protected', disabled: false, collapsed: false }]));
      expect(result.ok).toBeTrue(); expect(result.receipt.states[0]).toEqual(jasmine.objectContaining({ manualDisabled: false, disabled: true, disabledReasons: ['LIBRARY_RULE'] }));
      expect(roots().isEnabled()).toBeFalse(); expect(gate.blocked).toBeFalse();
    });
    it('lets an explicit disable bypass a broken active dropdown provider without executing or retaining its side effects', async () => {
      const root = roots(), field = new Blockly.FieldDropdown(() => [['Alpha', 'A'], ['Beta', 'B']]);
      root.appendDummyInput('DYNAMIC_OPTIONS').appendField(field, 'MODE'); root.setCollapsed(true);
      const base = await baseline(), beforeText = root.getFieldValue('TEXT');
      expect(root.isEnabled()).toBeTrue(); expect(root.getDisabledReasons().size).toBe(0);
      const provider = spyOn(field, 'getOptions').and.callFake(() => {
        root.setFieldValue('unowned option-provider mutation', 'TEXT');
        throw new Error('active dropdown provider fixture');
      });
      const result = await service.setBlockState({ version: 2, requestId: 'state-request-000001', action: 'update',
        expectedGeneration: base.generation, changes: [{ blockId: 'protected', disabled: true }] });
      expect(result.ok).toBeTrue(); expect(result.publication.status).toBe('COMMITTED'); expect(result.projectSaved).toBeTrue();
      expect(provider).not.toHaveBeenCalled(); expect(root.getFieldValue('TEXT')).toBe(beforeText); expect(root.isCollapsed()).toBeTrue();
      expect([...root.getDisabledReasons()]).toEqual(['MANUALLY_DISABLED']);
      expect(result.receipt.beforeStates[0]).toEqual(jasmine.objectContaining({ disabledReasons: [], collapsed: true }));
      expect(result.receipt.states[0]).toEqual(jasmine.objectContaining({ disabledReasons: ['MANUALLY_DISABLED'], collapsed: true }));
      expect(composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main').blocks.blocks[0].fields.TEXT).toBe(beforeText);
      expect(roots()).toBe(root); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });
    it('preserves committed evidence when only derived output publication fails', async () => {
      const base = await baseline(); (project.publishPreparedSaveOutputs as jasmine.Spy).and.rejectWith(new Error('derived header fixture'));
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.partial).toBeTrue(); expect(result.projectSaved).toBeTrue();
      expect(result.publication.status).toBe('COMMITTED'); expect(result.requiresReload).toBeFalse();
      expect(result.receipt.output.binding.abiHash).toBe(await hashAbsText(disk.get('project.abi')!));
      expect(result.abs).toBe(disk.get('project.abs')); expect(result.receipt.states[0].manualDisabled).toBeTrue();
      expect(roots().getDisabledReasons().has('MANUALLY_DISABLED')).toBeTrue(); expect(gate.blocked).toBeFalse();
    });
    it('does not start when the requested generation is stale', async () => {
      const base = await baseline(), before = [...disk];
      await expectAsync(service.setBlockState(stateRequest('old-generation'))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_STALE' }));
      expect([...disk]).toEqual(before); expect(roots().isCollapsed()).toBeFalse(); expect(roots().isEnabled()).toBeTrue();
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });
    it('does not overwrite an unapplied ABS candidate to change block state', async () => {
      const base = await baseline(); disk.set('project.abs', base.source + '\n# unapplied old candidate');
      const before = [...disk];
      await expectAsync(service.setBlockState(stateRequest(base.generation))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SOURCE_CONFLICT' }));
      expect([...disk]).toEqual(before); expect(roots().isCollapsed()).toBeFalse(); expect(roots().isEnabled()).toBeTrue();
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });
    it('preflights every protected target before touching an earlier editable target', async () => {
      editor.workspace.getBlockById('child').setEditable(false);
      const base = await baseline(), before = [...disk];
      await expectAsync(service.setBlockState(stateRequest(base.generation, [
        { blockId: 'protected', disabled: true, collapsed: false }, { blockId: 'child', disabled: true, collapsed: false },
      ]))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_STATE_EDIT_FORBIDDEN' }));
      expect([...disk]).toEqual(before); expect(roots().isEnabled()).toBeTrue(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    });
    it('restores only tracked state after native setter failure, without rebuilding the canvas', async () => {
      const base = await baseline(), before = [...disk], root = roots();
      spyOn(root, 'setCollapsed').and.callFake(value => { if (value) throw new Error('native setter fixture'); });
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.application).toBe('ROLLED_BACK');
      expect([...disk]).toEqual(before); expect(roots()).toBe(root); expect(root.isEnabled()).toBeTrue(); expect(root.isCollapsed()).toBeFalse();
      expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });
    it('quarantines an unowned setter callback instead of claiming complete rollback or discarding its edit', async () => {
      const base = await baseline(), before = [...disk], root = roots(), child = editor.workspace.getBlockById('child');
      const setCollapsed = root.setCollapsed.bind(root);
      spyOn(root, 'setCollapsed').and.callFake(value => {
        setCollapsed(value);
        if (value) { child.setFieldValue(99, 'NUM'); throw new Error('unowned callback fixture'); }
      });
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.application).toBe('UNKNOWN');
      expect(result.requiresReload).toBeTrue(); expect(result.partial).toBeTrue(); expect(result.rollbackError).toBeDefined();
      expect([...disk]).toEqual(before); expect(roots()).toBe(root); expect(root.isEnabled()).toBeTrue(); expect(root.isCollapsed()).toBeFalse();
      expect(child.getFieldValue('NUM')).toBe(99); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
      expect(gate.blocked).toBeTrue();
    });
    it('does not adopt a foreign committed generation as the state operation save baseline across its CAS boundary', async () => {
      const base = await baseline(), store = new AbsBaselineStore(port, scope), committed = (await store.loadCommitted())!;
      const foreignWorkspace = composeBlocklyPage(JSON.parse(disk.get('project.abi')!), 'main');
      foreignWorkspace.blocks.blocks[0].fields.TEXT = 'foreign saved program';
      const document = replaceBlocklyPageWorkspace(JSON.parse(disk.get('project.abi')!), 'main', foreignWorkspace, () => undefined);
      const abi = absJson(document), generation = 'foreign-state-generation';
      const projection = await createAbsProjection(foreignWorkspace, { document, scope, generation,
        baselineRef: absBaselineKey(generation), savedAbiHash: await hashAbsText(abi), contracts: committed.contracts });
      const exportInContext = (service as any).exportInContext.bind(service);
      spyOn(service as any, 'exportInContext').and.callFake(async (...args: any[]) => {
        const expected = await store.captureDisk();
        await store.stage({ projection, mode: 'import', inputAbs: expected.abs!, abi, expected });
        const foreign = await store.commit(generation, () => {}, async (text, hash, storage) => {
          expect(await storage.replace('project.abi', hash, text)).toBeTrue();
        });
        expect(foreign.status).toBe('COMMITTED');
        return exportInContext(...args);
      });
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_DISK_CONFLICT'); expect(result.application).toBe('UNKNOWN');
      expect(result.requiresReload).toBeTrue(); expect(gate.blocked).toBeTrue();
      expect(disk.get('project.abi')).toBe(abi); expect(disk.get('project.abs')).toBe(projection.abs);
      expect(JSON.parse(disk.get('project.abs.map.json')!).generation).toBe(generation);
      expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled();
    });
    it('rolls back tracked state after a definite pre-ABI publication failure while preserving its journal', async () => {
      const base = await baseline(), root = roots(), abi = disk.get('project.abi'); failWrite = 'project.abi';
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.publication.status).toBe('NOT_COMMITTED');
      expect(roots()).toBe(root); expect(root.isEnabled()).toBeTrue(); expect(root.isCollapsed()).toBeFalse();
      expect(disk.get('project.abi')).toBe(abi); expect((await service.inspectRecovery())!.abiSaved).toBeFalse();
      expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeFalse();
    });
    it('does not undo an unknown commit acknowledgement or claim that the state change was cancelled', async () => {
      const base = await baseline(), root = roots(); loseCommitReply = true;
      const result = await service.setBlockState(stateRequest(base.generation));
      expect(result.ok).toBeFalse(); expect(result.application).toBe('UNKNOWN'); expect(result.requiresReload).toBeTrue();
      expect(root.getDisabledReasons().has('MANUALLY_DISABLED')).toBeTrue(); expect(root.isCollapsed()).toBeTrue();
      expect(roots()).toBe(root); expect(editor.restoreProjectWorkspaceSnapshot).not.toHaveBeenCalled(); expect(gate.blocked).toBeTrue();
    });
  });
});
