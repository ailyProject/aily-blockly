import { SerialService } from '../src/app/services/domains/device/serial.service';

describe('serial host selection', () => {
  it('publishes a coherent serial selection once and excludes debugger/network targets', async () => {
    const service = new SerialService({} as any);
    service.currentPort = 'COM20'; service.currentPortInfo = { name: 'COM20', type: 'serial' };
    await Promise.resolve();
    expect(service.selectedPort$.value).toEqual({ path: 'COM20', revision: 1 });
    service.currentPort = 'COM20'; await Promise.resolve();
    expect(service.selectedPort$.value?.revision).toBe(1);
    service.currentPort = 'network-ota:host'; service.currentPortInfo = { type: 'network' };
    await Promise.resolve(); expect(service.selectedPort$.value).toBeNull();
    service.currentPort = 'COM21'; service.currentPortInfo = { type: 'debugger' };
    await Promise.resolve(); expect(service.selectedPort$.value).toBeNull();
  });

  it('does not broadcast an inactive Coder project selection into the main monitor', async () => {
    const service = new SerialService({} as any);
    service.currentPort = 'COM20'; service.currentPortInfo = { type: 'serial' };
    const child = Object.assign(Object.create(service), { currentPort: 'COM187', currentPortInfo: { type: 'serial' } }) as SerialService;
    await Promise.resolve();
    expect(child.selectedPort$.value?.path).toBe('COM187');
    expect(service.selectedPort$.value?.path).toBe('COM20');
    expect(child.selectedPort$).not.toBe(service.selectedPort$);
  });
});
