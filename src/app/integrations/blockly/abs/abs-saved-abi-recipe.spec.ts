import { Subject } from 'rxjs';
import { projectDataRuntime } from '@domain/project/public-api';
import { BlocklyProjectCleanState } from '../../../editors/blockly-editor/services/blockly-project-clean-state';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import type { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';

const document = (): BlocklyProjectDocument => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
  $ailyProjectData: { schemaVersion: 1, mode: 'external-only' },
  pages: [{ id: 'main', title: 'Main', content: { blocks: { languageVersion: 0, blocks: [
    { id: 'number', type: 'math_number', fields: { NUM: 300 } },
  ] } } }], sharedModel: { procedureBlocks: [] } });

describe('R3 original saved ABI recipe', () => {
  it('returns only the original accepted bytes while local edits stay dirty', () => {
    const state = new BlocklyProjectCleanState(), source = document(), disk = JSON.stringify(source, null, 2) + '\r\n';
    state.remember(['project', 1, 'data-session'], disk, source);
    source.pages[0].content.blocks.blocks[0].fields.NUM = 301;
    expect(state.compare(['project', 1, 'data-session'], disk, source)).toBeTrue();
    expect((state as any).readSavedAbiRecipe(['project', 1, 'data-session'])).toBe(disk);
    expect(state.compare(['project', 1, 'data-session'], disk, source)).toBeTrue();
    expect(() => state.compare(['project', 1, 'data-session'], JSON.stringify(source), source)).toThrowError(/outside/);
    expect((state as any).readSavedAbiRecipe(['project', 1, 'data-session'])).toBe(disk);
  });

  it('has no recipe after missing, failed or cleared acknowledgement and refuses every different scope', () => {
    const state = new BlocklyProjectCleanState(), workspace = {}, session = {}, scope = ['project', workspace, session];
    expect((state as any).readSavedAbiRecipe(scope)).toBeUndefined();
    state.remember(scope, 'original saved text', document());
    for (const other of [['other', workspace, session], ['project', {}, session], ['project', workspace, {}], ['project', workspace]])
      expect((state as any).readSavedAbiRecipe(other)).toBeUndefined();
    expect((state as any).readSavedAbiRecipe([...scope])).toBe('original saved text');
    state.clear(); expect((state as any).readSavedAbiRecipe(scope)).toBeUndefined();
    state.remember(scope, 'original saved text', document());
    state.reject(new Error('load readback failed'));
    expect((state as any).readSavedAbiRecipe(scope)).toBeUndefined();
  });
});

describe('R3 editor saved recipe forwarding', () => {
  let previousFs: unknown, disk: string, current: BlocklyProjectDocument, session: string;
  let editor: any, service: _ProjectService, read: jasmine.Spy;
  beforeEach(() => {
    previousFs = window['fs']; current = document(); disk = JSON.stringify(current, null, 2) + '\n'; session = 'original-data-session';
    read = jasmine.createSpy('actual disk read').and.callFake(() => disk);
    window['fs'] = { readFileSync: read };
    editor = { workspace: {}, getActivePageId: () => current.activePageId, projectPageHydrated: new Subject(),
      getWorkspaceLoadReadbackView: value => value, normalizeProjectAbi: value => value,
      getProjectAbiForSave: (value = current) => value, getProjectDocument: () => current,
      captureProjectSnapshot: () => ({ document: current, revision: 1 }),
      projectDirtyState: { remember: jasmine.createSpy('remember'), recover: jasmine.createSpy('recover'), reset() {} } };
    service = new _ProjectService(editor, { listen() {}, unlisten() {} } as any, {} as any);
    service.currentProjectPath = 'D:/project';
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
  });
  afterEach(() => { service.destroy(); window['fs'] = previousFs; });

  it('forwards the acknowledged loader recipe without disk reads or saved-state acknowledgement', () => {
    const originalDisk = disk;
    service.rememberLoadedProject('D:/project', disk, structuredClone(current));
    current.pages[0].content.blocks.blocks[0].fields.NUM = 301;
    read.calls.reset(); read.and.throwError('Recipe lookup cannot read current disk');
    editor.projectDirtyState.remember.calls.reset();
    expect((service as any).readSavedAbiRecipe('D:/project')).toBe(originalDisk);
    expect(read).not.toHaveBeenCalled();
    expect(editor.projectDirtyState.remember).not.toHaveBeenCalled();
    expect(current.pages[0].content.blocks.blocks[0].fields.NUM).toBe(301);
  });

  it('refuses unacknowledged, foreign project, replacement workspace and replacement data session', () => {
    expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
    service.rememberLoadedProject('D:/project', disk, structuredClone(current));
    expect((service as any).readSavedAbiRecipe('D:/other')).toBeUndefined();
    const workspace = editor.workspace;
    editor.workspace = {}; expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
    editor.workspace = workspace; session = 'replacement';
    expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
    session = 'original-data-session'; service.currentProjectPath = 'D:/other';
    expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
    service.currentProjectPath = 'D:/project'; service.destroy();
    expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
  });

  it('does not turn a recovered unsaved view into an acknowledged saved recipe', async () => {
    service.rememberLoadedProject('D:/project', disk, structuredClone(current));
    current.pages[0].content.blocks.blocks[0].fields.NUM = 301;
    await service.rememberRecoveredProject('D:/project', disk, structuredClone(current), { assertCurrent() {} } as any);
    expect(editor.projectDirtyState.recover).toHaveBeenCalled();
    expect((service as any).readSavedAbiRecipe('D:/project')).toBeUndefined();
  });
});
