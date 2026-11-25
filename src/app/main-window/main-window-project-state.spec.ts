import { OverlayContainer } from '@angular/cdk/overlay';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { NzMessageModule, NzMessageService } from 'ng-zorro-antd/message';
import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectState } from '@domain/project/public-api';
import { ProjectSaveMessageService } from '@core/app-shell/public-api';
import { MainWindowComponent } from './main-window.component';

describe('project progress messages', () => {
  function fixture(nativeMessage?: NzMessageService) {
    const component: any = Object.create(MainWindowComponent.prototype);
    const state = new BehaviorSubject<ProjectState>('default');
    const path = new BehaviorSubject('/a');
    let sequence = 0;
    const message = {
      loading: jasmine.createSpy('loading').and.callFake(() => ({ messageId: `progress-${++sequence}` })),
      success: jasmine.createSpy('success').and.callFake(() => ({ messageId: `success-${++sequence}`, onClose: new Subject() })),
      remove: jasmine.createSpy('remove'),
    };
    Object.assign(component, {
      uiService: { actionSubject: new Subject() },
      projectService: { stateSubject: state, currentProjectPath$: path.asObservable(), get currentProjectPath() { return path.value; } },
      message: nativeMessage || message,
      projectSaveMessages: new ProjectSaveMessageService(nativeMessage || message as any, { instant: (key: string) => key } as any),
      translate: { instant: (key: string) => key },
      cd: { detectChanges() {} },
      reloadTerminalAfterProjectOpen: jasmine.createSpy('reload terminal').and.resolveTo(),
    });
    component.ngAfterViewInit();
    return { component, state, path, message };
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
        expect(message.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_LOADED', { nzDuration: 4000, nzAnimate: false });
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
    expect(message.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVED', { nzDuration: 4000, nzAnimate: false });
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
    tick(1000);
    component.ngOnDestroy();
    tick(5000);
    expect(message.remove).toHaveBeenCalledOnceWith('progress-1');
  }));

  it('shows even a fast save immediately and retires its progress or result on project replacement', fakeAsync(() => {
    const { component, state, message, path } = fixture();
    state.next('saving');
    expect(message.loading).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVING', { nzDuration: 0 });
    state.next('saved');
    expect(message.success).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_SAVED', { nzDuration: 4000, nzAnimate: false });
    path.next('/b');
    expect(message.remove.calls.allArgs()).toEqual([['progress-1'], ['success-2']]);
    state.next('saving'); path.next('/c'); tick(5000);
    expect(message.remove.calls.allArgs()).toEqual([['progress-1'], ['success-2'], ['progress-3']]);
    state.next('error');
    expect(message.success).toHaveBeenCalledTimes(1);
    component.ngOnDestroy();
  }));

  it('keeps a new load active when its path is published and retires its result on the next operation', fakeAsync(() => {
    const { component, state, path, message } = fixture();
    state.next('loading'); tick(10); path.next('/b'); tick(10);
    expect(message.loading).toHaveBeenCalledOnceWith('MAIN_WINDOW.PROJECT_LOADING', { nzDuration: 0 });
    state.next('loaded'); tick(200); state.next('saving');
    expect(message.remove.calls.allArgs()).toEqual([['progress-1'], ['success-2']]);
    state.next('error'); tick(2000);
    expect(message.loading).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  }));

  it('shows one real save message at a time and keeps the success visible for four seconds after completion', fakeAsync(() => {
    TestBed.configureTestingModule({ imports: [NzMessageModule], providers: [provideNoopAnimations()] });
    const notices = TestBed.inject(NzMessageService);
    const { state, component } = fixture(notices);
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const rows = () => Array.from(overlay.querySelectorAll('.ant-message-notice-content'), n => n.textContent?.trim());
    state.next('saving');
    expect(rows()).toEqual(['MAIN_WINDOW.PROJECT_SAVING']);
    expect(overlay.querySelector('.ant-message-loading .anticon-loading')).not.toBeNull();
    tick();
    expect(overlay.querySelector('.ant-message-loading svg.anticon-spin')).not.toBeNull();
    tick(4500);
    expect(rows()).toEqual(['MAIN_WINDOW.PROJECT_SAVING']);
    state.next('saved'); tick();
    expect(rows()).toEqual(['MAIN_WINDOW.PROJECT_SAVED']);
    tick(3999); expect(rows()).toEqual(['MAIN_WINDOW.PROJECT_SAVED']);
    tick(1); expect(rows()).toEqual([]);
    component.ngOnDestroy();
  }));
});
