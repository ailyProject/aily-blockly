import { closeToolThroughLifecycle } from './child-tool-close-lifecycle';

describe('closeToolThroughLifecycle', () => {
  it('waits for a registered child lifecycle guard before closing', async () => {
    let resolveClose!: (result: Record<string, unknown>) => void;
    const requestChildClose = jasmine.createSpy('requestChildClose').and.returnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveClose = resolve;
      }),
    );
    const completeClose = jasmine.createSpy('completeClose');

    const closing = closeToolThroughLifecycle({
      childHostRegistered: true,
      requestChildClose,
      completeClose,
    });

    expect(requestChildClose).toHaveBeenCalledTimes(1);
    expect(completeClose).not.toHaveBeenCalled();

    resolveClose({ ok: true });

    expect(await closing).toBeTrue();
    expect(completeClose).not.toHaveBeenCalled();
  });

  it('preserves a registered child when its lifecycle guard vetoes closing', async () => {
    const completeClose = jasmine.createSpy('completeClose');

    const closed = await closeToolThroughLifecycle({
      childHostRegistered: true,
      requestChildClose: async () => ({ ok: false }),
      completeClose,
    });

    expect(closed).toBeFalse();
    expect(completeClose).not.toHaveBeenCalled();
  });

  it('closes an ordinary tool without invoking a child lifecycle guard', async () => {
    const requestChildClose = jasmine.createSpy('requestChildClose');
    const completeClose = jasmine.createSpy('completeClose');

    const closed = await closeToolThroughLifecycle({
      childHostRegistered: false,
      requestChildClose,
      completeClose,
    });

    expect(closed).toBeTrue();
    expect(requestChildClose).not.toHaveBeenCalled();
    expect(completeClose).toHaveBeenCalledTimes(1);
  });
});
