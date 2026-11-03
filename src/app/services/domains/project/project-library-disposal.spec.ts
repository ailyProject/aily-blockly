import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';

describe('Blockly dependency discard belongs to editor disposal', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    const events: string[] = [];
    let mounted = true;
    Object.assign(service, {
      currentProjectPathSubject: new BehaviorSubject('/source'),
      stateSubject: new BehaviorSubject('loaded'),
      coderProjectsSubject: new BehaviorSubject([]), coderOperationsSubject: new BehaviorSubject(new Map()),
      projectLifecycle: new ProjectLifecycleGate(),
      messageService: { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') },
      getProjectMode: () => 'blockly',
      stopProjectCommands: async () => { events.push('stop'); },
      closeInternal: async () => { events.push('close'); return true; },
      discardLibraryChanges: jasmine.createSpy('discard').and.callFake(async () => {
        expect(mounted).toBeFalse();
        expect(service.isProjectTransitionInProgress('/source')).toBeTrue();
        events.push('discard');
      }),
      rebuildBlocklyRuntimeAfterLibraryChange: jasmine.createSpy('rebuild'),
    });
    const graph = jasmine.createSpy('graph').and.resolveTo(true);
    Object.defineProperty(service, 'application', { value: {
      hasActiveProjectMutation: () => false, closeConnectionGraphWindows: graph,
    } });
    Object.defineProperty(service, 'router', { value: { url: '/main/blockly-editor?path=source', navigate: jasmine.createSpy('navigate').and.callFake(async () => {
      events.push('dispose'); mounted = false; service.router.url = '/main/guide'; return true;
    }) } });
    return { service, events, graph, mounted: () => mounted };
  }

  it('holds lifecycle ownership through teardown and discard, without rebuilding the old canvas', async () => {
    const { service, events } = fixture();
    expect(await service.close()).toBeTrue();
    expect(events).toEqual(['stop', 'dispose', 'discard', 'close']);
    expect(service.rebuildBlocklyRuntimeAfterLibraryChange).not.toHaveBeenCalled();
    expect(service.isProjectTransitionInProgress('/source')).toBeFalse();
  });

  it('leaves the loaded canvas and library edits intact when a child window refuses close', async () => {
    const { service, graph, mounted } = fixture(); graph.and.resolveTo(false);
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeTrue(); expect(service.stateSubject.value).toBe('loaded');
    expect(service.discardLibraryChanges).not.toHaveBeenCalled();
  });

  it('does not discard if Angular refuses the editor teardown', async () => {
    const { service, mounted } = fixture(); service.router.navigate.and.resolveTo(false);
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeTrue(); expect(service.stateSubject.value).toBe('loaded');
    expect(service.discardLibraryChanges).not.toHaveBeenCalled();
  });

  for (const decision of ['cancel', 'focus']) it(`retains the source activation after target lock ${decision}`, async () => {
    const { service, mounted } = fixture();
    const previous = window['projectLock'];
    window['projectLock'] = { tryAcquire: async () => ({ ok: false, conflict: true, holder: { pid: 123 } }),
      focusProcess: jasmine.createSpy('focus').and.resolveTo() };
    service.electronService = { exists: () => true, isElectron: true };
    service.ensureProjectModeAllowed = async () => true;
    service.promptProjectLockConflict = async () => decision;
    try {
      expect(await service.projectOpenInternal('/target', {}, () => {})).toBeFalse();
      expect(service.stateSubject.value).toBe('loaded'); expect(mounted()).toBeTrue();
      expect(service.discardLibraryChanges).not.toHaveBeenCalled();
      expect(service.router.navigate).not.toHaveBeenCalled();
    } finally { window['projectLock'] = previous; }
  });

  it('keeps failed dependency recovery retryable without reviving the retired canvas', async () => {
    const { service, mounted } = fixture();
    service.discardLibraryChanges.and.rejectWith(new Error('EACCES: dependency tree is locked'));
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeFalse(); expect(service.stateSubject.value).toBe('error');
    expect(service.blocklyProjectLoadFailure.error).toContain('EACCES');
    expect(service.isProjectTransitionInProgress('/source')).toBeFalse();
    service.discardLibraryChanges.and.resolveTo();
    expect(await service.close()).toBeTrue();
    expect(service.rebuildBlocklyRuntimeAfterLibraryChange).not.toHaveBeenCalled();
  });
});
