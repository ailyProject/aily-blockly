import {
  ChildAppHostRegistryService,
  type ChildAppHostController,
  type ChildAppLifecycleOptions,
} from './child-app-host-registry.service';

function controller(
  prepareUpdate: (options?: ChildAppLifecycleOptions) => Promise<Record<string, unknown>>,
): ChildAppHostController {
  return {
    status: () => ({}),
    prepareUpdate,
    restart: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    detach: async () => ({ ok: true }),
    embed: async () => ({ ok: true }),
  };
}

describe('ChildAppHostRegistryService application update preparation', () => {
  it('prepares every registered child with strict lifecycle confirmation', async () => {
    const service = new ChildAppHostRegistryService();
    const received: Array<{ id: string; strict?: boolean }> = [];
    service.register('aily-chat', controller(async options => {
      received.push({ id: 'aily-chat', strict: options?.strict });
      return { ok: true };
    }));
    service.register('network-debugger', controller(async options => {
      received.push({ id: 'network-debugger', strict: options?.strict });
      return { ok: true };
    }));

    const result = await service.prepareAllForApplicationUpdate();

    expect(result.ok).toBeTrue();
    expect(received).toEqual([
      { id: 'aily-chat', strict: true },
      { id: 'network-debugger', strict: true },
    ]);
  });

  it('blocks application update when any child cannot confirm persistence', async () => {
    const service = new ChildAppHostRegistryService();
    service.register('aily-chat', controller(async () => ({
      ok: false,
      message: 'session save failed',
    })));

    const result = await service.prepareAllForApplicationUpdate();

    expect(result.ok).toBeFalse();
    expect(result.results[0]['message']).toBe('session save failed');
  });

  it('blocks application update when a child does not explicitly confirm persistence', async () => {
    const service = new ChildAppHostRegistryService();
    service.register('legacy-child', controller(async () => ({})));

    const result = await service.prepareAllForApplicationUpdate();

    expect(result.ok).toBeFalse();
  });
});
