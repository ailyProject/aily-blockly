import { Subject } from 'rxjs';
import { BlocklyEditorComponent } from './blockly-editor.component';
import { projectDataRuntime } from '@domain/project/public-api';

describe('project load normalization context', () => {
  let component: any;
  let current: boolean;
  const guard = () => { if (!current) throw new Error('stale load'); };
  beforeEach(() => {
    current = true;
    component = Object.create(BlocklyEditorComponent.prototype);
    component.electronService = { pathJoin: (...parts: string[]) => parts.join('/'), readFileAsync: jasmine.createSpy('read').and.resolveTo('{}') };
    component.parseProjectAbiContent = jasmine.createSpy('parse').and.callFake(async text => JSON.parse(text));
    component.projectService = { ensureProjectDataSchemaForLoad: jasmine.createSpy('normalize').and.callFake(async (_path, document) => document) };
    component.blocklyService = { normalizeProjectAbiForLoad: jasmine.createSpy('model').and.callFake(value => value) };
  });
  it('does not begin migration after navigation during the file read', async () => {
    component.electronService.readFileAsync.and.callFake(async () => { current = false; return '{}'; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.parseProjectAbiContent).not.toHaveBeenCalled();
    expect(component.projectService.ensureProjectDataSchemaForLoad).not.toHaveBeenCalled();
  });
  it('does not begin migration after navigation during worker parsing', async () => {
    component.parseProjectAbiContent.and.callFake(async () => { current = false; return {}; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.projectService.ensureProjectDataSchemaForLoad).not.toHaveBeenCalled();
  });
  it('passes the same guard to disk and in-memory template normalization', async () => {
    component.electronService.readFileAsync.and.resolveTo('{"blocks":{"blocks":[]}}');
    const template = { blocks: { blocks: [{ type: 'arduino_setup', id: 'protected', deletable: false }] } };
    component.readCurrentBoardTemplateAbi = jasmine.createSpy('template').and.resolveTo(template);
    const result = await component.loadProjectAbiDocument('D:/project', guard);
    expect(result.usedBoardTemplate).toBeTrue();
    expect(component.projectService.ensureProjectDataSchemaForLoad.calls.argsFor(0)[3]).toBe(guard);
    expect(component.projectService.ensureProjectDataSchemaForLoad.calls.argsFor(1)).toEqual(['D:/project', template, undefined, guard]);
  });
  it('does not return an old document after normalization completes in a new context', async () => {
    component.projectService.ensureProjectDataSchemaForLoad.and.callFake(async () => { current = false; return {}; });
    await expectAsync(component.loadProjectAbiDocument('D:/old', guard)).toBeRejectedWithError('stale load');
    expect(component.blocklyService.normalizeProjectAbiForLoad).not.toHaveBeenCalled();
  });

  it('late failure of a route load cannot abort or mark failed a newer project', async () => {
    const route = new Subject<any>(); const board = new Subject<any>(); let session = 0;
    component.projectLoadSequence = 0; component.loadedProjectPath = null;
    component.activatedRoute = { queryParams: route };
    component._projectService = { init: () => {} }; component._builderService = { init: () => {} }; component._uploadService = { init: () => {} };
    Object.assign(component.projectService, { boardConfigUpdatedSubject: board,
      beginBlocklyProjectLoad: () => {}, markBlocklyProjectLoadFailed: jasmine.createSpy('failed') });
    component.abortFailedProjectLoad = jasmine.createSpy('abort'); component.message = { error: jasmine.createSpy('error') };
    let rejectOld!: (error: Error) => void;
    component.loadProject = jasmine.createSpy('load').and.callFake(path => path === 'old'
      ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve());
    spyOn(projectDataRuntime, 'configure').and.callFake(() => { session++; });
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => String(session));
    spyOn(window.history, 'replaceState'); spyOn(window.history, 'pushState');
    component.ngOnInit();
    try {
      route.next({ path: 'old' }); route.next({ path: 'new' });
      rejectOld(new Error('old host acknowledgement failed'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(component.loadedProjectPath).toBe('new');
      expect(component.abortFailedProjectLoad).not.toHaveBeenCalled();
      expect(component.projectService.markBlocklyProjectLoadFailed).not.toHaveBeenCalled();
      expect(component.message.error).not.toHaveBeenCalled();
    } finally { component.projectRouteSubscription.unsubscribe(); component.boardConfigUpdatedSubscription.unsubscribe(); }
  });
});
