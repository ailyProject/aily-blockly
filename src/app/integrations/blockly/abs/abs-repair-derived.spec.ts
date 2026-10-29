import * as Blockly from 'blockly';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { absJson, hashAbsText } from './abs-identity-map';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { projectDataRuntime } from '@domain/project/public-api';
import { AbsRepairDerivedReports } from './abs-repair-derived';

describe('repair source commits and derived output observations', () => {
  let disk: Map<string, string>, editor: any, project: any, service: AbsWorkspaceSyncService;
  let oldBlockly: unknown, oldFs: unknown, publisher: jasmine.Spy, prepareCode: jasmine.Spy;
  const scope = { projectKey: 'D:/isolated-repair-derived', pageId: 'main' };
  const snapshot = () => ({ revision: 1, document: { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'Main', content: normalizeAbsSerializedWorkspace(Blockly.serialization.workspaces.save(editor.workspace)) }],
    sharedModel: { procedureBlocks: [] } } });
  const repair = async () => {
    disk.set('project.abi', absJson(snapshot().document));
    await service.exportGeneration({ initialize: true });
    prepareCode.calls.reset(); publisher.calls.reset();
    disk.set('project.abs.map.json', '{}');
    const diagnostics = (await service.inspectGeneration()).diagnostics as { repair?: { token: string } };
    if (!diagnostics.repair) throw new Error('The broken public map must offer a repair capability.');
    const offer = diagnostics.repair;
    return { token: offer.token, result: await service.repairGeneration(offer.token, 'workspace') };
  };

  beforeEach(() => {
    oldBlockly = window['Blockly']; oldFs = window['fs']; window['Blockly'] = Blockly;
    const definition = { type: 'repair_derived_root', message0: 'root %1', args0: [{ type: 'field_input', name: 'TEXT', text: 'same' }] };
    Blockly.defineBlocksWithJsonArray([definition]);
    const catalog = new BlocklyDeclarativeBlockCatalog(); catalog.record(definition, Blockly.Blocks[definition.type]);
    const workspace = new Blockly.Workspace(); workspace.newBlock(definition.type, 'retained-root');
    const gate = new BlocklyWorkspaceEditGate(); disk = new Map();
    const access = { read: async (key: string) => disk.get(key) ?? null,
      replace: async (key: string, expected: string | null, text: string | null) => {
        const before = disk.get(key) ?? null;
        if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
        if (text === null) disk.delete(key); else disk.set(key, text);
        return true;
      } };
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async () => ({ read: access.read,
      withLock: (operation: any) => new Promise((resolve, reject) => operation(access,
        (result: any) => result.ok ? resolve(result.value) : reject(new Error(result.error.message)))) }) };
    prepareCode = jasmine.createSpy('prepareCode').and.callFake(async () => ({ code: 'current code', revision: 1 }));
    publisher = jasmine.createSpy('publish').and.resolveTo();
    editor = { workspace, blockTypeToLibMap: new Map(), getActivePageId: () => 'main',
      captureDeclarativeBlockDefinitions: () => catalog.capture(Blockly.Blocks), runProjectOperation: async (operation: any) => operation(),
      acquireWorkspaceEditLease: () => gate.acquire(), captureProjectSnapshot: snapshot, getProjectAbiForSave: (value: unknown) => value,
      normalizeProjectAbi: (value: unknown) => value, getWorkspaceLoadReadbackView: (value: unknown) => value,
      prepareProjectCode: prepareCode, publishAbsContext: jasmine.createSpy('publishAbsContext') };
    project = { currentProjectPath: scope.projectKey, prepareSave: async (document: unknown) => ({ abiText: absJson(document) }),
      publishPreparedSaveOutputs: publisher };
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo(); spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
    spyOn(projectDataRuntime, 'getStore').and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }) } as any);
    service = new AbsWorkspaceSyncService(editor, project);
  });
  afterEach(() => { editor.workspace.dispose(); delete Blockly.Blocks['repair_derived_root']; window['Blockly'] = oldBlockly; window['fs'] = oldFs; });

  for (const generated of [null, { code: null, error: '', revision: 1 }, { code: null, error: 'missing generator', revision: 1 }]) {
    it('reports unavailable generated code without changing a committed repair: ' + JSON.stringify(generated), async () => {
      prepareCode.and.resolveTo(generated);
      const { result } = await repair();
      expect(result.publication.status).toBe('COMMITTED'); expect(result.requiresReload).toBeFalse();
      expect(result.appliedRevision).toBeUndefined();
      expect(result.derivedOutputs?.published).toBeFalse(); expect(result.derivedOutputs?.code).toBe('PROJECT_CODE_GENERATION_FAILED');
      expect(result.warnings.length).toBe(1);
    });
  }
  it('keeps generation and publication errors independent in a successful source repair', async () => {
    prepareCode.and.resolveTo({ code: null, error: 'missing generator', revision: 1 });
    publisher.and.rejectWith(new Error('header publication failed'));
    const { result } = await repair();
    expect(result.publication.status).toBe('COMMITTED'); expect(result.derivedOutputs?.error).toBe('missing generator\nheader publication failed');
    expect(result.warnings.length).toBe(2);
  });
  it('observes the exact completed failed report after a lost reply without generating or publishing again', async () => {
    prepareCode.and.resolveTo({ code: null, error: 'first generator error', revision: 1 });
    const first = await repair(), before = new Map(disk);
    const repeated = await service.repairGeneration(first.token, 'workspace');
    expect(repeated.reused).toBeTrue(); expect(repeated.derivedOutputs).toEqual(first.result.derivedOutputs);
    expect(repeated.warnings).toEqual(first.result.warnings); expect(prepareCode).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledTimes(1); expect(disk).toEqual(before);
  });
  it('observes a successful completion without calling the output publisher twice', async () => {
    const first = await repair(), repeated = await service.repairGeneration(first.token, 'workspace');
    expect(first.result.derivedOutputs).toEqual({ published: true }); expect(repeated.derivedOutputs).toEqual(first.result.derivedOutputs);
    expect(first.result.appliedRevision).toBeUndefined(); expect(repeated.appliedRevision).toBeUndefined();
    expect(publisher).toHaveBeenCalledTimes(1); expect(prepareCode).toHaveBeenCalledTimes(1);
  });
  it('reports unknown artifact publication after coordinator restart instead of fabricating success', async () => {
    const first = await repair(); service = new AbsWorkspaceSyncService(editor, project);
    const before = new Map(disk), repeated = await service.repairGeneration(first.token, 'workspace');
    expect(repeated.reused).toBeTrue(); expect(repeated.publication.status).toBe('COMMITTED');
    expect(repeated.derivedOutputs?.published).toBeFalse(); expect(repeated.derivedOutputs?.code).toBe('PROJECT_DERIVED_OUTPUT_UNKNOWN');
    expect(repeated.warnings.length).toBe(1); expect(publisher).toHaveBeenCalledTimes(1); expect(disk).toEqual(before);
  });
  it('rejects old repair tokens after source mirrors change, before returning cached outcome facts', async () => {
    const first = await repair(); disk.set('project.abs', disk.get('project.abs')! + '\n# newer draft');
    await expectAsync(service.repairGeneration(first.token, 'workspace')).toBeRejected();
    expect(publisher).toHaveBeenCalledTimes(1);
  });
  it('actually publishes prepared output when save and reuseCurrent are explicitly combined', async () => {
    disk.set('project.abi', absJson(snapshot().document)); await service.exportGeneration({ initialize: true });
    prepareCode.calls.reset(); publisher.calls.reset();
    const before = new Map(disk), result = await service.exportGeneration({ save: true, reuseCurrent: true });
    expect(result.reused).toBeTrue(); expect(result.derivedOutputs?.published).toBeTrue(); expect(publisher).toHaveBeenCalledTimes(1);
    expect(disk).toEqual(before);
  });
  it('does not publish or certify output for projection-only baseline reuse', async () => {
    disk.set('project.abi', absJson(snapshot().document)); await service.exportGeneration({ initialize: true });
    prepareCode.calls.reset(); publisher.calls.reset();
    const result = await service.exportGeneration({ reuseCurrent: true });
    expect(result.reused).toBeTrue(); expect(result.derivedOutputs).toBeUndefined(); expect(publisher).not.toHaveBeenCalled();
    expect(prepareCode).not.toHaveBeenCalled();
  });
});

describe('bounded completed repair artifact facts', () => {
  const binding = () => ({ generation: 'repair-a', scope: { projectKey: 'D:/isolated-repair', pageId: 'main' },
    abiHash: 'sha256:a', absHash: 'sha256:b', mapHash: 'sha256:c' });
  it('returns detached reports so caller mutation cannot rewrite the remembered outcome', () => {
    const reports = new AbsRepairDerivedReports(), original = { output: { published: false, code: 'failed', error: 'first' }, warnings: ['first'] };
    reports.remember('token-a', binding(), original); original.output.error = 'changed'; original.warnings.push('changed');
    const observed = reports.observe('token-a', binding());
    expect(observed.output?.error).toBe('first'); expect(observed.warnings).toEqual(['first']);
    observed.output!.error = 'changed again'; observed.warnings.length = 0;
    expect(reports.observe('token-a', binding()).warnings).toEqual(['first']);
    expect(reports.observe('token-a', binding()).output?.error).toBe('first');
  });
  it('never accepts a report for a different token, generation, scope or mirror binding', () => {
    const reports = new AbsRepairDerivedReports(); reports.remember('token-a', binding(), { output: { published: true }, warnings: [] });
    for (const foreign of [ { ...binding(), generation: 'repair-b' }, { ...binding(), mapHash: 'changed' },
      { ...binding(), scope: { ...binding().scope, projectKey: 'D:/other-project' } } ]) {
      expect(reports.observe('token-a', foreign).output?.code).toBe('PROJECT_DERIVED_OUTPUT_UNKNOWN');
    }
    expect(reports.observe('other-token', binding()).output?.code).toBe('PROJECT_DERIVED_OUTPUT_UNKNOWN');
  });
  it('keeps only one recent report and makes an evicted completion explicitly unknown', () => {
    const reports = new AbsRepairDerivedReports(); reports.remember('token-a', binding(), { output: { published: true }, warnings: [] });
    const next = { ...binding(), generation: 'repair-b' };
    reports.remember('token-b', next, { output: { published: true }, warnings: [] });
    expect(reports.observe('token-a', binding()).output?.code).toBe('PROJECT_DERIVED_OUTPUT_UNKNOWN');
    expect(reports.observe('token-b', next).output?.published).toBeTrue();
  });
});
