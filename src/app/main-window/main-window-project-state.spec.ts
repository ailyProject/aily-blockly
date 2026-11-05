import { fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectState } from '@domain/project/public-api';
import { MainWindowComponent } from './main-window.component';

describe('project progress messages', () => {
  function fixture() {
    const component: any = Object.create(MainWindowComponent.prototype);
    const state = new BehaviorSubject<ProjectState>('default');
    let sequence = 0;
    const message = {
      loading: jasmine.createSpy('loading').and.callFake(() => ({ messageId: `progress-${++sequence}` })),
      success: jasmine.createSpy('success'),
      remove: jasmine.createSpy('remove'),
    };
    Object.assign(component, {
      uiService: { actionSubject: new Subject() },
      projectService: { stateSubject: state },
      message,
      translate: { instant: (key: string) => key },
      cd: { detectChanges() {} },
      reloadTerminalAfterProjectOpen: jasmine.createSpy('reload terminal').and.resolveTo(),
    });
    component.ngAfterViewInit();
    return { component, state, message };
  }

  for (const finished of ['loaded', 'closing', 'default', 'error', 'saved'] as const) {
    it(`cancels a pending load message when the project becomes ${finished}`, fakeAsync(() => {
      const { component, state, message } = fixture();
      state.next('loading');
      tick(10);
      state.next(finished);
      tick(5000);
      expect(message.loading).not.toHaveBeenCalled();
      expect(message.remove).not.toHaveBeenCalled();
      if (finished === 'loaded') {
        expect(message.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_LOADED');
        expect(component.reloadTerminalAfterProjectOpen).toHaveBeenCalledTimes(1);
      }
      component.ngOnDestroy();
    }));
  }

  for (const finished of ['loaded', 'closing', 'default', 'error'] as const) {
    it(`removes only its own active load message on ${finished}`, fakeAsync(() => {
      const { component, state, message } = fixture();
      state.next('loading');
      tick(20);
      expect(message.loading).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_LOADING', { nzDuration: 0 });
      state.next(finished);
      tick(5000);
      expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
      expect(message.loading).toHaveBeenCalledTimes(1);
      component.ngOnDestroy();
    }));
  }

  it('replaces loading with saving and clears saving when it completes', fakeAsync(() => {
    const { component, state, message } = fixture();
    state.next('loading');
    tick(20);
    state.next('saving');
    expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
    expect(message.loading).toHaveBeenCalledWith('MAIN_WINDOW.PROJECT_SAVING', { nzDuration: 0 });
    state.next('saved');
    expect(message.remove.calls.allArgs()).toEqual([['progress-1'], ['progress-2']]);
    expect(message.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVED');
    component.ngOnDestroy();
  }));

  it('does not let a pending load message appear over saving or its error', fakeAsync(() => {
    const { component, state, message } = fixture();
    state.next('loading');
    tick(10);
    state.next('saving');
    tick(5000);
    expect(message.loading).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVING', { nzDuration: 0 });
    state.next('error');
    expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
    component.ngOnDestroy();
  }));

  it('gives a replacement project its own delay after retiring the old editor', fakeAsync(() => {
    const { component, state, message } = fixture();
    state.next('loading');
    tick(19);
    state.next('closing');
    state.next('loading');
    tick(1);
    expect(message.loading).not.toHaveBeenCalled();
    tick(19);
    state.next('loading');
    expect(message.loading).toHaveBeenCalledTimes(1);
    state.next('loaded');
    expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
    component.ngOnDestroy();
  }));

  it('cancels pending messages and unsubscribes when the main window is destroyed', fakeAsync(() => {
    const { component, state, message } = fixture();
    state.next('loading');
    component.ngOnDestroy();
    tick(5000);
    state.next('loaded');
    expect(message.loading).not.toHaveBeenCalled();
    expect(message.success).not.toHaveBeenCalled();
  }));

  it('removes an active progress message when the main window is destroyed', fakeAsync(() => {
    const { component, state, message } = fixture();
    state.next('saving');
    component.ngOnDestroy();
    tick(5000);
    expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
  }));
});
