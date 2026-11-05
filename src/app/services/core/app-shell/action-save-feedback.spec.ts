import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { ActionService } from './action.service';

describe('Action save admission feedback', () => {
  it('reports missing save handlers synchronously without leaving an unbounded observer', () => {
    const service = new ActionService(), result = jasmine.createSpy('result');
    service.dispatch('project-save', {}, result, 0, { requireHandler: true });
    expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success: false,
      data: { code: 'ACTION_HANDLER_UNAVAILABLE' } }));
  });

  it('keeps the original completion after a handler admits a slow save', fakeAsync(() => {
    const service = new ActionService(), result = jasmine.createSpy('result');
    let finish!: (value: any) => void;
    service.listen('project-save', () => new Promise(resolve => { finish = resolve; }));
    service.dispatch('project-save', {}, result, 0, { requireHandler: true });
    tick(6000); expect(result).not.toHaveBeenCalled();
    finish({ projectSaved: true }); flushMicrotasks();
    expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success: true, data: { projectSaved: true } }));
  }));

  it('does not mistake an unrelated handler or a removed handler for save admission', () => {
    const service = new ActionService(), result = jasmine.createSpy('result');
    service.listen('different-action', () => {});
    const stop = service.listen('project-save', () => {}); stop();
    service.dispatch('project-save', {}, result, 0, { requireHandler: true });
    expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success: false }));
  });

  it('preserves the legacy bounded behavior unless the caller explicitly opts in', fakeAsync(() => {
    const service = new ActionService(), result = jasmine.createSpy('result');
    service.dispatch('other', {}, result);
    expect(result).not.toHaveBeenCalled(); tick(5000);
    expect(result).toHaveBeenCalledOnceWith(jasmine.objectContaining({ success: false, error: '等待反馈超时' }));
  }));
});
