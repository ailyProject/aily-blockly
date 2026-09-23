import * as Blockly from 'blockly';
import { projectDataRuntime } from '@domain/project/public-api';
import { BlocklyGeneratorRuntimeService, getActiveProjectGenerator, getActiveProjectGeneratorRevision } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyProjectCodePreparation } from '../../../editors/blockly-editor/services/prepared-project-code';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { captureArduinoGeneratedArtifacts, isBuildWorkspaceBusyError, writePreparedArduinoGeneratedArtifacts } from '../../../editors/blockly-editor/services/generated-code-artifacts';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { SerialOperationQueue } from '@shared/public-api';

describe('prepared project code boundary', () => {
  let runtime: BlocklyGeneratorRuntimeService;
  let workspace: Blockly.Workspace;
  let preparation: BlocklyProjectCodePreparation;
  let revision: BlocklyProjectRevision;
  let pageId: string;
  let dataSession: string;
  let generator: any;
  const capture = () => {
    const document = Blockly.serialization.workspaces.save(workspace);
    return { document, revision: revision.observe(document), workspace, generator: getActiveProjectGenerator(),
      runtimeRevision: getActiveProjectGeneratorRevision(), pageId, dataSession };
  };
  beforeEach(() => {
    runtime = new BlocklyGeneratorRuntimeService(); workspace = new Blockly.Workspace();
    preparation = new BlocklyProjectCodePreparation(); revision = new BlocklyProjectRevision();
    pageId = 'main'; dataSession = 'session-1';
    generator = runtime.activate({ mode: 'arduino', getWorkspace: () => workspace as any });
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
    spyOn(generator, 'workspaceToCode').and.returnValue('prepared code');
  });
  afterEach(() => { workspace.dispose(); runtime.destroy(); });

  const productEditor = () => {
    const editor = Object.create(BlocklyService.prototype) as BlocklyService;
    const gate = new BlocklyWorkspaceEditGate();
    Object.defineProperty(editor, 'workspace', { get: () => workspace });
    Object.assign(editor, { projectCodePreparation: preparation, projectOperations: new SerialOperationQueue(),
      getActivePageId: () => pageId, assertWorkspaceEditAvailable: owner => gate.assertAvailable(owner),
      acquireWorkspaceEditLease: () => gate.acquire(), isWorkspaceEditBlocked: () => gate.blocked,
      captureProjectSnapshot: owner => { gate.assertAvailable(owner); return capture(); } });
    return editor;
  };

  it('serializes product code consumers under edit ownership and shares one prepared result', async () => {
    const editor = productEditor();
    const consume = jasmine.createSpy('consume').and.callFake(async (prepared, assertCurrent) => {
      expect(editor.isWorkspaceEditBlocked()).toBeTrue(); assertCurrent(); return prepared.code;
    });
    expect(await Promise.all([editor.runWithPreparedProjectCode(consume), editor.runWithPreparedProjectCode(consume)])).toEqual(['prepared code', 'prepared code']);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(2); expect(editor.isWorkspaceEditBlocked()).toBeFalse();
  });

  it('rejects a stale queued code consumer before generation or publication', async () => {
    const editor = productEditor(); const consume = jasmine.createSpy();
    const pending = editor.runWithPreparedProjectCode(consume); pageId = 'other';
    await expectAsync(pending).toBeRejectedWithError(/context changed/);
    expect(consume).not.toHaveBeenCalled(); expect(generator.workspaceToCode).not.toHaveBeenCalled();
  });

  it('prepares background code without acquiring an exclusive edit lease', async () => {
    const editor = productEditor();
    const acquire = spyOn(editor, 'acquireWorkspaceEditLease').and.callThrough();
    const consume = jasmine.createSpy('consume').and.callFake((_prepared, assertCurrent) => {
      expect(editor.isWorkspaceEditBlocked()).toBeFalse(); assertCurrent();
    });
    expect(await editor.runWithBackgroundProjectCode(consume, () => false)).toBeTrue();
    expect(acquire).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('defers background work when editing starts while waiting in the project queue', async () => {
    const editor = productEditor(); const consume = jasmine.createSpy('consume');
    let editing = false;
    const pending = editor.runWithBackgroundProjectCode(consume, () => editing);
    editing = true;
    expect(await pending).toBeFalse();
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    editing = false;
    expect(await editor.runWithBackgroundProjectCode(consume, () => editing)).toBeTrue();
  });

  it('lets edits continue during resource preparation and discards stale background results', async () => {
    const editor = productEditor(); const consume = jasmine.createSpy('consume');
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => {
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
      workspace.createVariable('typed while preparing');
    });
    expect(await editor.runWithBackgroundProjectCode(consume, () => false)).toBeFalse();
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    (projectDataRuntime.prepareValue as jasmine.Spy).and.resolveTo();
    expect(await editor.runWithBackgroundProjectCode(consume, () => false)).toBeTrue();
  });

  it('rechecks editor activity after resource awaits even when the document has not changed', async () => {
    const editor = productEditor(); const consume = jasmine.createSpy('consume');
    let editing = false;
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => { editing = true; });
    expect(await editor.runWithBackgroundProjectCode(consume, () => editing)).toBeFalse();
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('keeps input available during background publication and retries an intervening edit', async () => {
    const editor = productEditor();
    expect(await editor.runWithBackgroundProjectCode(async (_prepared, assertCurrent) => {
      await Promise.resolve();
      expect(editor.isWorkspaceEditBlocked()).toBeFalse();
      workspace.createVariable('next edit');
      assertCurrent();
    }, () => false)).toBeFalse();
    expect(await editor.runWithBackgroundProjectCode(() => {}, () => false)).toBeTrue();
  });

  it('drops background results after a runtime replacement without hiding real generator failures', async () => {
    const editor = productEditor(); const consume = jasmine.createSpy('consume');
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => runtime.updateBoardConfig({changed: true}));
    expect(await editor.runWithBackgroundProjectCode(consume, () => false)).toBeFalse();
    expect(consume).not.toHaveBeenCalled();
    (projectDataRuntime.prepareValue as jasmine.Spy).and.resolveTo();
    generator.workspaceToCode.and.throwError('bad generator');
    await expectAsync(editor.runWithBackgroundProjectCode(consume, () => false)).toBeRejectedWithError('bad generator');
    expect(editor.isWorkspaceEditBlocked()).toBeFalse();
  });

  it('guards consumer continuations and releases the lease after state changes', async () => {
    const editor = productEditor();
    await expectAsync(editor.runWithPreparedProjectCode(async (_prepared, assertCurrent) => {
      await Promise.resolve(); workspace.createVariable('intervening edit'); assertCurrent();
    })).toBeRejectedWithError(/changed before code publication/);
    expect(editor.isWorkspaceEditBlocked()).toBeFalse();
    expect(await editor.runWithPreparedProjectCode(prepared => prepared.code)).toBe('prepared code');
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(2);
  });

  it('does not relabel cached code when state changes between preparation return and consumer continuation', async () => {
    const editor = productEditor();
    await editor.runWithPreparedProjectCode(prepared => prepared.code);
    const prepare = editor.prepareProjectCode.bind(editor);
    spyOn(editor, 'prepareProjectCode').and.callFake(async (...args) => {
      const result = await prepare(...args);
      queueMicrotask(() => workspace.createVariable('late cache-hit edit'));
      return result;
    });
    const consume = jasmine.createSpy('consume');
    await expectAsync(editor.runWithPreparedProjectCode(consume)).toBeRejectedWithError(/changed before code publication/);
    expect(consume).not.toHaveBeenCalled(); expect(generator.workspaceToCode).toHaveBeenCalledTimes(1);
  });

  it('generates once, adopts synchronous model registration and reuses the resulting persisted revision', async () => {
    generator.workspaceToCode.and.callFake(() => { workspace.createVariable('device', 'runtime-type'); return 'prepared code'; });
    const before = capture().revision;
    const result = await preparation.prepare(capture);
    expect(capture().revision).toBeGreaterThan(before);
    expect(workspace.getAllVariables().length).toBe(1);
    expect(result.code).toBe('prepared code');
    expect(result.sourceWorkspace.revision).toBe(capture().revision);
    expect(result.sourceWorkspace.documentText).toContain('device');
    expect(await preparation.prepare(capture)).toBe(result);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(1);
  });

  it('captures detached artifacts and the map after workspaceToCode replaces mutable generator state', async () => {
    const artifact = { fileName: 'variables_data-12345678.h', content: 'original header', sourceTag: 'data' };
    const mapping = { blockId: 'b', codeSnippet: 'original' };
    spyOn(generator, 'getGeneratedArtifacts').and.returnValue([artifact]);
    generator.workspaceToCode.and.callFake(() => { generator.blockCodeMap = new Map([['b', mapping]]); return 'original code'; });
    const result = await preparation.prepare(capture);
    artifact.content = 'later header'; mapping.codeSnippet = 'later'; generator.blockCodeMap.clear();
    expect(result.artifacts[0].content).toBe('original header');
    expect(JSON.parse(result.blockCodeMapText)[0][1].codeSnippet).toBe('original');
    expect(Object.isFrozen(result)).toBeTrue(); expect(Object.isFrozen(result.artifacts[0])).toBeTrue();
    const capturedText = result.sourceWorkspace.documentText;
    workspace.createVariable('later edit');
    expect(result.sourceWorkspace.documentText).toBe(capturedText);
    expect(result.sourceWorkspace.documentText).not.toContain('later edit');
  });

  it('rejects changes during the resource await before executing any generator', async () => {
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => workspace.createVariable('external edit'));
    await expectAsync(preparation.prepare(capture)).toBeRejectedWithError(/before code preparation/);
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
  });

  it('rejects runtime replacement during resource preparation', async () => {
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => runtime.rebuild());
    await expectAsync(preparation.prepare(capture)).toBeRejectedWithError(/runtime changed/);
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
  });

  it('never reuses a result for a changed page, resource session or persisted state', async () => {
    await preparation.prepare(capture);
    pageId = 'other'; await preparation.prepare(capture);
    dataSession = 'session-2'; await preparation.prepare(capture);
    workspace.createVariable('new model'); await preparation.prepare(capture);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(4);
    await preparation.prepare(capture, true);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(5);
  });

  it('invalidates code for board configuration and library registration without a workspace edit', async () => {
    await preparation.prepare(capture);
    const revisionBefore = capture().revision;
    runtime.updateBoardConfig({ pins: [1, 2] }); await preparation.prepare(capture);
    runtime.loadGenerator('prepared-code-test.js', 'window.preparedCodeLibrary = true;'); await preparation.prepare(capture);
    expect(capture().revision).toBe(revisionBefore);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(3);
  });

  it('rejects configuration changes while waiting for resources', async () => {
    (projectDataRuntime.prepareValue as jasmine.Spy).and.callFake(async () => runtime.updateBoardConfig({ changed: true }));
    await expectAsync(preparation.prepare(capture)).toBeRejectedWithError(/runtime changed/);
    expect(generator.workspaceToCode).not.toHaveBeenCalled();
  });

  it('does not adopt a late asynchronous generator mutation or cache its output', async () => {
    generator.workspaceToCode.and.callFake(() => { queueMicrotask(() => workspace.createVariable('late model')); return 'stale code'; });
    await expectAsync(preparation.prepare(capture)).toBeRejectedWithError(/after code preparation/);
    generator.workspaceToCode.and.returnValue('latest code');
    expect((await preparation.prepare(capture)).code).toBe('latest code');
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(2);
  });

  it('retains a generation failure for the same revision without replay or partial artifact publication', async () => {
    generator.workspaceToCode.and.callFake(() => { workspace.createVariable('registered before failure'); throw new Error('unfinished code'); });
    const result = await preparation.prepare(capture);
    expect(result).toEqual({ code: null, artifacts: null, blockCodeMapText: null, error: 'unfinished code', revision: capture().revision });
    expect(await preparation.prepare(capture)).toBe(result);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(1);
    preparation.clear();
    await preparation.prepare(capture);
    expect(generator.workspaceToCode).toHaveBeenCalledTimes(2);
  });
  it('does not publish an asynchronous generator return value as code', async () => {
    generator.workspaceToCode.and.returnValue(Promise.resolve('too late'));
    const result = await preparation.prepare(capture);
    expect(result.code).toBeNull(); expect(result.artifacts).toBeNull();
    expect(result.error).toContain('synchronous');
  });

  it('publishes the captured headers and sketch through one protected host call', async () => {
    const oldBuilder = window['builder'];
    const publish = jasmine.createSpy('publishArduinoGeneratedCode');
    window['builder'] = { publishArduinoGeneratedCode: publish };
    try {
      const artifact = { fileName: 'variables_data-12345678.h', content: 'prepared header', sourceTag: 'data' };
      const source = { getGeneratedArtifacts: jasmine.createSpy().and.returnValue([artifact]) };
      const captured = captureArduinoGeneratedArtifacts(source);
      artifact.content = 'later output'; source.getGeneratedArtifacts.and.throwError('runtime disposed');
      await writePreparedArduinoGeneratedArtifacts('D:/project', captured, 'prepared sketch');
      expect(publish).toHaveBeenCalledOnceWith('D:/project', {
        artifacts: [{ fileName: 'variables_data-12345678.h', content: 'prepared header', sourceTag: 'data' }],
        sketchCode: 'prepared sketch',
      });
      expect(source.getGeneratedArtifacts).toHaveBeenCalledTimes(1);
    } finally { window['builder'] = oldBuilder; }
  });

  it('does not silently bypass protection when the preload is old', async () => {
    const oldBuilder = window['builder']; window['builder'] = {};
    try {
      await expectAsync(writePreparedArduinoGeneratedArtifacts('D:/project', [])).toBeRejectedWithError(/restart the host/);
      await expectAsync(writePreparedArduinoGeneratedArtifacts('D:/project', null)).toBeResolved();
    } finally { window['builder'] = oldBuilder; }
  });

  it('recognizes a busy build lease without treating other publication failures as retryable', () => {
    expect(isBuildWorkspaceBusyError(Object.assign(new Error('BUILD_WORKSPACE_BUSY: busy'), { code: 'BUILD_WORKSPACE_BUSY' }))).toBeTrue();
    expect(isBuildWorkspaceBusyError(new Error('BUILD_WORKSPACE_BUSY: Another host build/preprocess owns this project.'))).toBeTrue();
    expect(isBuildWorkspaceBusyError(new Error('BUILD_PUBLICATION_INVALID: Invalid generated code.'))).toBeFalse();
  });

  it('rejects artifact paths outside the generated header namespace and skips unsupported runtimes', () => {
    expect(() => captureArduinoGeneratedArtifacts({ getGeneratedArtifacts: () => [{ fileName: '../user.h', content: 'x' }] })).toThrowError(/Invalid/);
    expect(captureArduinoGeneratedArtifacts({})).toBeNull();
  });
});
