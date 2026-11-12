import { BehaviorSubject, Subject } from 'rxjs';
import { fakeAsync, tick } from '@angular/core/testing';
import { HeaderComponent } from './header.component';

describe('project title unsaved marker', () => {
  function fixture() {
    const view: any = Object.create(HeaderComponent.prototype);
    view.hasUnsavedProjectChanges = false;
    view.unsavedCheckRevision = 0;
    view.unsavedCheckRunning = false;
    view.router = { url: '/main/blockly-editor', events: new Subject() };
    view.configService = { configReloaded$: new Subject() };
    view.blocklyService = { projectDirtyState: { changed: new BehaviorSubject(false), activity: new Subject() } };
    view.projectService = { currentProjectPath: '/project', stateSubject: new BehaviorSubject('loaded'),
      hasCachedLibraryChanges: jasmine.createSpy('cached library state').and.returnValue(false),
      hasUnsavedChanges: jasmine.createSpy('full check').and.throwError('title must not serialize'),
      getProjectMode: jasmine.createSpy('mode').and.throwError('title must not read files') };
    view.ngZone = { run: (action: () => void) => action(), runOutsideAngular: (action: () => void) => action() };
    view.cd = { markForCheck: jasmine.createSpy('mark') };
    view.scheduleUnsavedCheck = jasmine.createSpy('reschedule');
    return view;
  }

  it('reads cached content/library state without serialization or disk reads', async () => {
    const view = fixture();
    view.blocklyService.projectDirtyState.changed.next(true);
    await view.refreshProjectUnsavedState(); expect(view.hasUnsavedProjectChanges).toBeTrue();
    view.projectService.stateSubject.next('error');
    await view.refreshProjectUnsavedState(); expect(view.hasUnsavedProjectChanges).toBeTrue();
    view.blocklyService.projectDirtyState.changed.next(false);
    view.projectService.hasCachedLibraryChanges.and.returnValue(true);
    await view.refreshProjectUnsavedState(); expect(view.hasUnsavedProjectChanges).toBeTrue();
    view.projectService.hasCachedLibraryChanges.and.returnValue(false);
    view.projectService.stateSubject.next('saved');
    await view.refreshProjectUnsavedState(); expect(view.hasUnsavedProjectChanges).toBeFalse();
    expect(view.projectService.hasUnsavedChanges).not.toHaveBeenCalled();
    expect(view.projectService.getProjectMode).not.toHaveBeenCalled();
  });

  it('clears the dirty title without querying the retired editor while closing', async () => {
    const view = fixture();
    view.hasUnsavedProjectChanges = true;
    view.blocklyService.projectDirtyState.changed.next(true);
    view.projectService.stateSubject.next('closing');
    await view.refreshProjectUnsavedState();
    expect(view.hasUnsavedProjectChanges).toBeFalse();
    expect(view.projectService.hasCachedLibraryChanges).not.toHaveBeenCalled();
  });

  it('keeps failed Coder checks dirty and ignores stale replies after save/switch/destroy', async () => {
    for (const changed of ['revision', 'project', 'destroyed']) {
      const view = fixture(); view.router.url = '/main/code-editor-pro';
      let finish!: (saved: boolean) => void;
      view.coderPersistence = { hasSavedProject: jasmine.createSpy('saved').and.returnValue(new Promise(resolve => finish = resolve)) };
      const check = view.refreshProjectUnsavedState(); await view.refreshProjectUnsavedState();
      expect(view.coderPersistence.hasSavedProject).toHaveBeenCalledOnceWith('/project', true);
      if (changed === 'revision') view.unsavedCheckRevision++;
      else if (changed === 'project') view.projectService.currentProjectPath = '/other';
      else view.destroyed = true;
      finish(false); await check; expect(view.hasUnsavedProjectChanges).toBeFalse();
    }
    const view = fixture(); view.router.url = '/main/code-editor-pro'; view.hasUnsavedProjectChanges = true;
    view.coderPersistence = { hasSavedProject: jasmine.createSpy('saved').and.rejectWith(new Error('bridge unavailable')) };
    await view.refreshProjectUnsavedState(); expect(view.hasUnsavedProjectChanges).toBeTrue();
  });

  it('does no polling work for idle Blockly and schedules Coder only while active', fakeAsync(() => {
    const view = fixture(); view.unsavedSubscriptions = { add() {} };
    view.projectService.currentProjectPath$ = new Subject();
    view.projectService.libraryChangesChanged = new Subject();
    view.watchProjectUnsavedState(); view.scheduleUnsavedCheck.calls.reset();
    tick(5000); expect(view.scheduleUnsavedCheck).not.toHaveBeenCalled();
    expect(view.projectService.getProjectMode).not.toHaveBeenCalled();
    view.router.url = '/main/code-editor-pro'; tick(1000);
    expect(view.scheduleUnsavedCheck).toHaveBeenCalledTimes(1);
    clearInterval(view.coderUnsavedPoll);
  }));

  it('retains canvas edits during dependency preparation and autosaves once it settles', fakeAsync(() => {
    const view = fixture(), activity = new Subject();
    let installing = true;
    view.unsavedSubscriptions = { add() {} };
    view.projectService.currentProjectPath$ = new Subject();
    view.projectService.libraryChangesChanged = new Subject();
    view.projectService.isProjectTransitionInProgress = () => false;
    view.projectService.isProjectDependencyPreparationInProgress = () => installing;
    view.projectService.hasUnsavedChanges.and.resolveTo(true);
    view.projectService.save = jasmine.createSpy('save').and.resolveTo({ success: true });
    view.blocklyService.projectDirtyState.activity = activity;
    view.blocklyService.isWorkspaceEditBlocked = () => false;
    view.blocklyService.workspace = { isDragging: () => false };
    view.configService = { data: { blockly: { autoSave: true } }, configReloaded$: new Subject() };
    view.watchProjectUnsavedState();
    activity.next({}); tick(2000); activity.next({}); tick(6000);
    expect(view.projectService.save).not.toHaveBeenCalled();
    expect(view.projectService.hasUnsavedChanges).not.toHaveBeenCalled();
    expect(view.autoSaveState).toBe('pending');
    installing = false; tick(2000);
    expect(view.projectService.save).toHaveBeenCalledOnceWith('/project');
    expect(view.autoSaveState).toBe('saved');
    view.autoSave.dispose(); clearInterval(view.coderUnsavedPoll);
  }));
});
