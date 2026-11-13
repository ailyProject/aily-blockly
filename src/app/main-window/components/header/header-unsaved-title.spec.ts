import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { fakeAsync, tick } from '@angular/core/testing';
import { HeaderComponent } from './header.component';
import { BlocklyProjectDirtyState } from '../../../editors/blockly-editor/services/blockly-project-dirty-state';
import { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';

describe('project title unsaved marker', () => {
  function fixture() {
    const view: any = Object.create(HeaderComponent.prototype);
    view.hasUnsavedProjectChanges = false;
    view.autoSaveState = '';
    view.uiService = { updateFooterState: jasmine.createSpy('footer') };
    view.translate = { instant: (key: string) => key };
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

  function watchingFixture(autoSave?: boolean) {
    const view = fixture();
    const document: BlocklyProjectDocument = { schemaVersion: 3, activePageId: 'one', openedPageIds: ['one'],
      sharedModel: { procedureBlocks: [] }, pages: [{ id: 'one', title: 'One', content: { blocks: { blocks: [] } },
        viewState: { scale: 1, scrollX: 0, scrollY: 0 } }] };
    const dirty = new BlocklyProjectDirtyState(() => document, () => undefined, () => false, action => action());
    dirty.remember(document);
    view.unsavedSubscriptions = new Subscription();
    view.projectService.currentProjectPath$ = new Subject();
    view.projectService.libraryChangesChanged = new Subject();
    view.projectService.isProjectTransitionInProgress = () => false;
    view.projectService.isProjectDependencyPreparationInProgress = () => false;
    view.projectService.hasUnsavedChanges.and.callFake(async () => dirty.changed.value);
    view.projectService.saveInBackground = jasmine.createSpy('background save').and.callFake(async () => {
      dirty.remember(document); dirty.invalidate(); return { success: true };
    });
    view.blocklyService.projectDirtyState = dirty;
    view.blocklyService.isWorkspaceEditBlocked = () => false;
    view.blocklyService.workspace = { isDragging: () => false };
    view.configService = { data: { blockly: { autoSave } }, configReloaded$: new Subject() };
    view.watchProjectUnsavedState();
    return { view, dirty, document, pan: (scrollX: number) => {
      document.pages[0].viewState.scrollX = scrollX; dirty.viewport('one', document.pages[0].viewState);
    }, dispose: () => {
      view.unsavedSubscriptions.unsubscribe(); view.autoSave.dispose(); dirty.reset(); clearInterval(view.coderUnsavedPoll);
    } };
  }

  it('defaults missing and false preferences to off until explicitly enabled', fakeAsync(() => {
    for (const preference of [undefined, false]) {
      const h = watchingFixture(preference);
      h.pan(10); tick(6000);
      expect(h.view.projectService.saveInBackground).not.toHaveBeenCalled(); expect(h.view.autoSaveState).toBe('');
      h.view.configService.data.blockly.autoSave = true; h.view.configService.configReloaded$.next(); tick(2000);
      expect(h.view.projectService.saveInBackground).toHaveBeenCalledOnceWith('/project');
      h.pan(20); h.view.configService.data.blockly.autoSave = false;
      h.view.configService.configReloaded$.next(); tick(6000);
      expect(h.view.projectService.saveInBackground).toHaveBeenCalledTimes(1); expect(h.view.autoSaveState).toBe('');
      h.dispose();
    }
  }));

  it('saves viewport changes consistently after opening, saving and a long idle period', fakeAsync(() => {
    const h = watchingFixture(true);
    h.dirty.invalidate(); tick(6000);
    expect(h.view.projectService.saveInBackground).not.toHaveBeenCalled(); expect(h.view.autoSaveState).toBe('');
    h.pan(10); tick(1500); h.pan(20); tick(1999);
    expect(h.view.projectService.saveInBackground).not.toHaveBeenCalled();
    tick(1); expect(h.view.projectService.saveInBackground).toHaveBeenCalledOnceWith('/project');
    expect(h.view.autoSaveState).toBe('saved');
    expect(h.view.uiService.updateFooterState.calls.allArgs()).toEqual([
      [{ owner: 'project-auto-save', state: 'doing', text: 'PROJECT.AUTO_SAVE_SAVING' }],
      [{ owner: 'project-auto-save', state: 'done', text: 'PROJECT.AUTO_SAVE_SAVED', timeout: 3000 }],
    ]);
    h.pan(20); tick(6000);
    expect(h.view.projectService.saveInBackground).toHaveBeenCalledTimes(1);
    h.pan(30); tick(2000);
    expect(h.view.projectService.saveInBackground).toHaveBeenCalledTimes(2); expect(h.view.autoSaveState).toBe('saved');
    tick(6000); expect(h.view.projectService.saveInBackground).toHaveBeenCalledTimes(2);
    h.dispose();
  }));

  it('keeps the saved acknowledgement when publication broadcasts clean library/config status', fakeAsync(() => {
    const h = watchingFixture(true);
    h.view.projectService.saveInBackground.and.callFake(async () => {
      h.view.projectService.libraryChangesChanged.next();
      h.view.configService.configReloaded$.next();
      h.dirty.remember(h.document);
      return { success: true };
    });
    h.pan(10); tick(2000);
    expect(h.view.autoSaveState).toBe('saved');
    expect(h.view.uiService.updateFooterState.calls.allArgs()).toEqual([
      [{ owner: 'project-auto-save', state: 'doing', text: 'PROJECT.AUTO_SAVE_SAVING' }],
      [{ owner: 'project-auto-save', state: 'done', text: 'PROJECT.AUTO_SAVE_SAVED', timeout: 3000 }],
    ]);
    tick(6000); expect(h.view.projectService.saveInBackground).toHaveBeenCalledTimes(1); h.dispose();
  }));

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
    view.projectService.saveInBackground = jasmine.createSpy('background save').and.resolveTo({ success: true });
    view.blocklyService.projectDirtyState.activity = activity;
    view.blocklyService.isWorkspaceEditBlocked = () => false;
    view.blocklyService.workspace = { isDragging: () => false };
    view.configService = { data: { blockly: { autoSave: true } }, configReloaded$: new Subject() };
    view.watchProjectUnsavedState();
    activity.next({}); tick(2000); activity.next({}); tick(6000);
    expect(view.projectService.saveInBackground).not.toHaveBeenCalled();
    expect(view.projectService.hasUnsavedChanges).not.toHaveBeenCalled();
    expect(view.autoSaveState).toBe('pending');
    installing = false; tick(2000);
    expect(view.projectService.saveInBackground).toHaveBeenCalledOnceWith('/project');
    expect(view.autoSaveState).toBe('saved');
    view.autoSave.dispose(); clearInterval(view.coderUnsavedPoll);
  }));
});
