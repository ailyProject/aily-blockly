import { resolveChildCloseDecision } from './child-close-decision';
import { ChildAppHostRegistryService } from './child-app-host-registry.service';

describe('partition close confirmation handshake', () => {
  it('waits for a pending dialog and preserves cancellation', async () => {
    let decide!: (value: boolean) => void;
    const remote = { waitForCloseDecision: () => new Promise(resolve => { decide = resolve; }) };
    let settled = false;
    const task = resolveChildCloseDecision(remote, { canClose: false, confirmationPending: true }).then(value => { settled = true; return value; });
    await Promise.resolve(); expect(settled).toBeFalse();
    decide(false); expect(await task).toBeFalse();
    expect(await resolveChildCloseDecision({ waitForCloseDecision: async () => true }, { confirmationPending: true })).toBeTrue();
  });
  it('never treats a lost or unsupported decision as permission', async () => {
    expect(await resolveChildCloseDecision({}, { confirmationPending: true })).toBeFalse();
    await expectAsync(resolveChildCloseDecision({ waitForCloseDecision: async () => { throw new Error('lost'); } }, { confirmationPending: true })).toBeRejected();
  });
  it('closes every registered partition surface and stops on cancellation', async () => {
    const registry = new ChildAppHostRegistryService();
    const closeA = jasmine.createSpy().and.resolveTo({ ok: false });
    const closeB = jasmine.createSpy().and.resolveTo({ ok: true });
    registry.register('ffs-manager-child', { close: closeA } as any, { instanceId: 'full' });
    registry.register('ffs-manager-child', { close: closeB } as any, { instanceId: 'compact' });
    expect((await registry.closeAll('ffs-manager-child'))['ok']).toBeFalse();
    expect(closeB).not.toHaveBeenCalled();
    closeA.and.resolveTo({ ok: true });
    expect((await registry.closeAll('ffs-manager-child'))['ok']).toBeTrue();
    expect(closeB).toHaveBeenCalledTimes(1);
  });
});
