import { fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { ProjectAutoSave } from '../src/app/main-window/components/header/project-auto-save';

describe('project idle autosave (#495)', () => {
  function setup() {
    const state = jasmine.createSpy('state'), save = jasmine.createSpy('save').and.resolveTo({ success: true });
    const value = { path: '/a', enabled: true, ready: true };
    const auto = new ProjectAutoSave({ project: () => value.path, enabled: () => value.enabled,
      ready: () => value.ready, dirty: async () => true, save, state });
    return { auto, state, save, value };
  }
  it('waits for two seconds after the last edit and shows saved only after persistence resolves', fakeAsync(() => {
    const h = setup(); let finish!: (result: any) => void;
    h.save.and.returnValue(new Promise(resolve => { finish = resolve; }));
    h.auto.edited(); tick(1500); h.auto.edited(); tick(1999); expect(h.save).not.toHaveBeenCalled();
    tick(1); flushMicrotasks(); expect(h.save).toHaveBeenCalledOnceWith('/a');
    expect(h.state.calls.mostRecent().args[0]).toBe('saving');
    finish({ success: true }); flushMicrotasks(); expect(h.state.calls.mostRecent().args[0]).toBe('saved'); h.auto.dispose();
  }));
  it('defers while busy and cancels an obsolete project or disabled setting', fakeAsync(() => {
    const h = setup(); h.value.ready = false; h.auto.edited(); tick(2000); expect(h.save).not.toHaveBeenCalled();
    h.value.path = '/b'; tick(2000); expect(h.save).not.toHaveBeenCalled();
    h.value.ready = true; h.auto.edited(); h.value.enabled = false; tick(2000); expect(h.save).not.toHaveBeenCalled(); h.auto.dispose();
  }));
  it('reports a failed write without a saved acknowledgement or an automatic retry loop', fakeAsync(() => {
    const h = setup(); h.save.and.resolveTo({ success: false, error: 'disk full' });
    h.auto.edited(); tick(2000); flushMicrotasks(); expect(h.state).toHaveBeenCalledWith('error', 'disk full');
    tick(10000); expect(h.save).toHaveBeenCalledTimes(1); h.auto.dispose();
  }));
  it('retries if editing becomes blocked while the dirty check is pending', fakeAsync(() => {
    let ready = true;
    let resolveDirty!: (value: boolean) => void;
    const save = jasmine.createSpy('save').and.resolveTo({ success: true });
    const dirty = jasmine.createSpy('dirty').and.returnValue(new Promise(resolve => { resolveDirty = resolve; }));
    const auto = new ProjectAutoSave({ project: () => '/a', enabled: () => true, ready: () => ready,
      dirty, save, state: () => {} });
    auto.edited(); tick(2000); ready = false; resolveDirty(true); flushMicrotasks();
    expect(save).not.toHaveBeenCalled(); ready = true; dirty.and.resolveTo(true); tick(2000);
    expect(save).toHaveBeenCalledOnceWith('/a'); auto.dispose();
  }));
});
