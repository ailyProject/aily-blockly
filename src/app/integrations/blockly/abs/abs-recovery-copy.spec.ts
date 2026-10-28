import { BehaviorSubject } from 'rxjs';
import * as Blockly from 'blockly';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyProjectRevision } from '../../../editors/blockly-editor/services/blockly-project-revision';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { SerialOperationQueue } from '@shared/public-api';
import { createAilyProjectDataValue, materializeGenericProjectDataValues, ProjectDataStore, projectDataRuntime, type AilyDataRef } from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';

describe('quarantined complete recovery copy', () => {
  const source = '/recovery-source', target = '/recovery-target', local = 'recovery_copy_local', shared = 'recovery_copy_shared';
  let editor: any, sync: AbsWorkspaceSyncService, workspace: Blockly.Workspace;
  let files: Map<string, string | Uint8Array>, directories: Set<string>, fs: any, path: any;
  let oldFs: unknown, oldPath: unknown, oldBlockly: unknown, resolved: jasmine.Spy;
  let mode: 'commit' | 'conflict' | 'lost' = 'commit';
  const payload = 'cache-only-data-'.repeat(3000);
  const ref: AilyDataRef = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
    codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: payload.length, storedLength: payload.length } };
  const text = (name: string) => String(files.get(name));
  const sourceFiles = () => Object.fromEntries([...files].filter(([name]) => name.startsWith(source + '/')));
  const createCapture = (): Promise<any> => (sync as any).captureRecoveryCopySnapshot(source);

  beforeEach(() => {
    oldFs = window['fs']; oldPath = window['path']; oldBlockly = window['Blockly']; window['Blockly'] = Blockly;
    files = new Map([['/recovery-source/project.abi', 'old ABI'], ['/recovery-source/project.abs', 'unapplied ABS draft'],
      ['/recovery-source/project.abs.map.json', '{old-map}'], ['/recovery-source/.aily/abs-sync/committed.json', 'old pointer']]);
    directories = new Set(['/', source, target]); mode = 'commit';
    const normalize = (value: string) => {
      const result: string[] = [];
      for (const item of value.split('/')) { if (item === '..') result.pop(); else if (item && item !== '.') result.push(item); }
      return '/' + result.join('/');
    };
    path = { join: (...parts: string[]) => normalize(parts.join('/')), resolve: normalize,
      dirname: (value: string) => normalize(value.slice(0, value.lastIndexOf('/'))), isAbsolute: (value: string) => value.startsWith('/'),
      relative: (from: string, to: string) => {
        const a = normalize(from).split('/').filter(Boolean), b = normalize(to).split('/').filter(Boolean);
        while (a[0] === b[0] && a.length && b.length) { a.shift(); b.shift(); }
        return [...a.map(() => '..'), ...b].join('/');
      } };
    const mkdir = (value: string) => {
      const parts = normalize(value).split('/').filter(Boolean); let current = '';
      for (const part of parts) { current += '/' + part; directories.add(current); }
    };
    fs = { existsSync: (name: string) => files.has(name) || directories.has(name),
      readFileSync: (name: string) => { if (!files.has(name)) throw Error('missing file: ' + name); return text(name); },
      writeFileSync: jasmine.createSpy('writeText').and.callFake((name: string, value: string, options?: { flag?: string }) => {
        if (options?.flag === 'wx' && files.has(name)) throw Error('archive already exists'); files.set(name, value);
      }),
      mkdirSync: mkdir, readFileBuffer: (name: string) => files.get(name),
      writeFileBuffer: (name: string, value: ArrayBuffer) => files.set(name, new Uint8Array(value)),
      renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      unlinkSync: (name: string) => files.delete(name),
      lstatSync: (name: string) => {
        if (!files.has(name) && !directories.has(name)) throw Error('missing stat: ' + name);
        const value = files.get(name); return { _isFile: files.has(name), _isDirectory: directories.has(name), _isSymbolicLink: false,
          size: typeof value === 'string' ? value.length : value?.byteLength ?? 0, mtimeMs: 0 };
      },
      replaceProjectText: jasmine.createSpy('commit').and.callFake(async (request: any, guard: () => void) => {
        guard(); const file = `${request.projectPath}/${request.fileName}`;
        if (mode === 'conflict') files.set(file, 'external destination edit');
        const before = files.get(file), expected = before === undefined ? null : 'sha256:' + await sha256Hex(String(before));
        if (expected !== request.expectedHash) return { status: 'CONFLICT', error: 'destination changed' };
        files.set(file, request.content);
        if (mode === 'lost') throw Error('lost destination commit response');
        return { status: 'COMMITTED', hash: 'sha256:' + await sha256Hex(request.content) };
      }) };
    window['fs'] = fs; window['path'] = path;
    Blockly.Blocks[local] = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('before'), 'TEXT'); } };
    Blockly.Blocks[shared] = { init() { this.appendDummyInput().appendField('definition'); }, getProcedureDef() { return ['fn', [], false]; } };
    workspace = new Blockly.Workspace(); const block = workspace.newBlock(local, 'local-id');
    block.setDisabledReason(true, 'MANUALLY_DISABLED'); block.setDisabledReason(true, 'library-reason');
    block.setCollapsed(true); block.setEditable(false); block.setDeletable(false); block.setMovable(false);
    workspace.newBlock(shared, 'shared-id'); workspace.getVariableMap().createVariable('counter', 'int', 'variable-id');
    editor = Object.create(BlocklyService.prototype); editor._workspace = workspace;
    editor.workspaceEditGate = new BlocklyWorkspaceEditGate(); editor.projectRevision = new BlocklyProjectRevision();
    editor.projectOperations = new SerialOperationQueue(); editor.projectDocumentSchemaVersion = 3;
    editor.documentMetadata = { retained: { extension: true } };
    editor.activePageIdSubject = new BehaviorSubject('main'); editor.openedPageIdsSubject = new BehaviorSubject(['main', 'other']);
    editor.pagesSubject = new BehaviorSubject([{ id: 'main', title: 'Main', content: { blocks: { blocks: [] } } },
      { id: 'other', title: 'Other', extraMetadata: true, content: { blocks: { blocks: [
        { type: local, id: 'other-id', extraState: { cachedText: createAilyProjectDataValue(ref) } } ] } } }]);
    editor.sharedModelSubject = new BehaviorSubject({ procedureBlocks: [{ type: shared, id: 'shared-id' }], modelMetadata: { retained: true } });
    editor.captureWorkspaceViewState = () => ({ scale: 0.8, scrollX: 1, scrollY: 2 });
    editor.getWorkspaceJson = jasmine.createSpy('custom serialization').and.throwError('must not prepare source serialization');
    editor.prepareProjectCode = jasmine.createSpy('generator').and.throwError('must not run source generator');
    editor.captureDeclarativeBlockDefinitions = jasmine.createSpy('declarative context').and.returnValue({ assertCurrent: () => {},
      blockContract: jasmine.createSpy('dynamic contract').and.throwError('must not probe dynamic contracts') });
    editor.releaseWorkspaceInputFence = jasmine.createSpy('clear quarantine fence');
    spyOn(projectDataRuntime, 'flushPending').and.rejectWith(Error('must not flush the source'));
    resolved = spyOn(projectDataRuntime, 'resolve').and.callFake(async value => { expect(value).toEqual(ref); return payload as any; });
    sync = new AbsWorkspaceSyncService(editor, { currentProjectPath: source } as any);
  });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[local]; delete Blockly.Blocks[shared];
    window['fs'] = oldFs; window['path'] = oldPath; window['Blockly'] = oldBlockly; });

  it('captures a tainted complete native document without source preparation, writes or releasing its quarantine', async () => {
    const lease = editor.workspaceEditGate.acquire(); lease.quarantine('uncertain rollback'); lease.release();
    const before = sourceFiles(), capture = await createCapture();
    expect(capture.isCurrent()).toBeTrue(); expect(resolved).toHaveBeenCalledTimes(1);
    expect(editor.workspaceEditGate.blocked).toBeTrue(); expect(editor.workspaceEditGate.busy).toBeFalse();
    expect(editor.prepareProjectCode).not.toHaveBeenCalled(); expect(editor.getWorkspaceJson).not.toHaveBeenCalled();
    expect(projectDataRuntime.flushPending).not.toHaveBeenCalled(); expect(editor.releaseWorkspaceInputFence).not.toHaveBeenCalled();
    expect(editor.captureDeclarativeBlockDefinitions.calls.mostRecent().returnValue.blockContract).not.toHaveBeenCalled();
    expect(sourceFiles()).toEqual(before); expect(fs.writeFileSync).not.toHaveBeenCalled(); capture.dispose();
  });
  it('rejects active native writers before observing the canvas or resolving its resource cache', async () => {
    const lease = editor.workspaceEditGate.acquire();
    await expectAsync(createCapture()).toBeRejectedWithError(/writer is still active/);
    expect(resolved).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled(); lease.release();
  });
  it('retains invalid draft bytes in the new target archive without source writes or inherited authority', async () => {
    const raw = Uint8Array.of(0xff, 0xfe, 0x41); files.set(source + '/project.abs', raw);
    const before = sourceFiles(), capture = await createCapture();
    await capture.publish(target);
    const archiveName = [...files.keys()].find(name => name.startsWith(target + '/recovery-source-'))!;
    const archive = JSON.parse(text(archiveName));
    expect(archive.files['project.abs']).toBeNull();
    expect(archive.rawFiles['project.abs']).toEqual(jasmine.objectContaining({ encoding: 'base64', contents: '//5B', bytes: 3 }));
    expect(sourceFiles()).toEqual(before);
    expect(files.has(target + '/project.abs')).toBeFalse(); capture.dispose();
  });
  it('publishes only the complete independent ABI and target resources, with original mirrors archived as non-authoritative evidence', async () => {
    const lease = editor.workspaceEditGate.acquire(); lease.quarantine('uncertain rollback'); lease.release();
    const before = sourceFiles(), capture = await createCapture(), result = await capture.publish(target);
    expect(result).toEqual(jasmine.objectContaining({ projectSaved: true, generatedCodePublished: false, partial: true, projectionPending: true }));
    expect(result.code).toBe('PROJECT_RECOVERY_RUNTIME_REQUIRED');
    const saved = JSON.parse(text(target + '/project.abi'));
    const store = new ProjectDataStore(); store.configure(target);
    const materialized: any = await materializeGenericProjectDataValues(saved, { resolve: value => store.resolve(value) });
    const block = materialized.pages[0].content.blocks.blocks[0];
    expect(block.id).toBe('local-id'); expect(block.disabledReasons).toEqual(['MANUALLY_DISABLED', 'library-reason']);
    expect(block.collapsed).toBeTrue(); expect(block.deletable).toBeFalse(); expect(block.editable).toBeFalse(); expect(block.movable).toBeFalse();
    expect(materialized.pages[1].extraMetadata).toBeTrue(); expect(materialized.pages[1].content.blocks.blocks[0].extraState.cachedText).toBe(payload);
    expect(materialized.sharedModel.variables).toEqual([{ name: 'counter', type: 'int', id: 'variable-id' }]);
    expect(materialized.sharedModel.procedureBlocks[0].id).toBe('shared-id'); expect(materialized.sharedModel.modelMetadata).toEqual({ retained: true });
    expect(materialized.retained).toEqual({ extension: true }); expect(sourceFiles()).toEqual(before);
    const targetKeys = [...files.keys()].filter(name => name.startsWith(target + '/'));
    expect(targetKeys.some(name => /assets\/project-data\/.+\.bin$/.test(name))).toBeTrue();
    expect(targetKeys.some(name => /project\.abs|abs-sync|committed\.json/.test(name))).toBeFalse();
    const archive = JSON.parse(text(targetKeys.find(name => /recovery-source-.*\.json$/.test(name))!));
    expect(archive.files).toEqual({ 'project.abi': 'old ABI', 'project.abs': 'unapplied ABS draft', 'project.abs.map.json': '{old-map}' });
    expect(editor.workspaceEditGate.blocked).toBeTrue(); expect(editor.prepareProjectCode).not.toHaveBeenCalled();
    expect(projectDataRuntime.flushPending).not.toHaveBeenCalled(); capture.dispose();
  });
  it('retains an immutable captured document if a subsequent user edit makes activation stale', async () => {
    const capture = await createCapture(); workspace.getBlockById('local-id')!.setFieldValue('newer source edit', 'TEXT');
    expect(capture.isCurrent()).toBeFalse(); await capture.publish(target);
    expect(JSON.parse(text(target + '/project.abi')).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('before');
    expect(workspace.getBlockById('local-id')!.getFieldValue('TEXT')).toBe('newer source edit'); capture.dispose();
  });
  it('detaches cache-only JSON arrays before publishing them into the target resource store', async () => {
    const value = { items: Array.from({ length: 20000 }, (_, index) => index % 10) };
    const jsonRef: AilyDataRef = { $ailyData: { ...ref.$ailyData, id: `sha256:${'b'.repeat(64)}`,
      codec: 'canonical-json-v1', logicalType: 'json' } };
    editor.pagesSubject.value[1].content.blocks.blocks[0].extraState.cachedText = createAilyProjectDataValue(jsonRef);
    resolved.and.callFake(async input => { expect(input).toEqual(jsonRef); return value as any; });
    const capture = await createCapture(); value.items[0] = 9999;
    await capture.publish(target);
    const store = new ProjectDataStore(); store.configure(target);
    const saved: any = await materializeGenericProjectDataValues(JSON.parse(text(target + '/project.abi')),
      { resolve: input => store.resolve(input) });
    expect(saved.pages[1].content.blocks.blocks[0].extraState.cachedText.items[0]).toBe(0);
    expect(saved.pages[1].content.blocks.blocks[0].extraState.cachedText.items.length).toBe(20000);
    expect(projectDataRuntime.flushPending).not.toHaveBeenCalled(); capture.dispose();
  });
  it('rejects context changes during cache-only materialization before publishing anything', async () => {
    const lease = editor.workspaceEditGate.acquire(); lease.quarantine('uncertain rollback'); lease.release();
    resolved.and.callFake(async () => { editor.activePageIdSubject.next('other'); return payload as any; });
    await expectAsync(createCapture()).toBeRejectedWithError(/stale project/);
    expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.replaceProjectText).not.toHaveBeenCalled();
    expect(editor.workspaceEditGate.blocked).toBeTrue();
  });
  it('rejects a disposed capture before any destination writes', async () => {
    const capture = await createCapture(); capture.dispose();
    await expectAsync(Promise.resolve().then(() => capture.publish(target))).toBeRejectedWithError(/disposed/);
    expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.replaceProjectText).not.toHaveBeenCalled();
  });
  it('rejects a context guard failure before destination preparation or archive writes', async () => {
    const capture = await createCapture(); editor.activePageIdSubject.next('other');
    await expectAsync(Promise.resolve().then(() => capture.publish(target))).toBeRejected();
    expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.replaceProjectText).not.toHaveBeenCalled();
  });
  it('preserves a destination CAS conflict and never rewrites the original project', async () => {
    const before = sourceFiles(), capture = await createCapture(); mode = 'conflict';
    await expectAsync(capture.publish(target)).toBeRejectedWithError(/destination changed/);
    expect(text(target + '/project.abi')).toBe('external destination edit'); expect(sourceFiles()).toEqual(before);
  });
  it('retains an uncertain destination commit rather than reporting rollback or source success', async () => {
    const capture = await createCapture(), before = sourceFiles(); mode = 'lost';
    let error: any; try { await capture.publish(target); } catch (failure) { error = failure; }
    expect(error?.uncertain).toBeTrue(); expect(error?.code).toBe('PROJECT_FILE_COMMIT_UNCERTAIN');
    expect(files.has(target + '/project.abi')).toBeTrue(); expect(sourceFiles()).toEqual(before);
  });
});
