import { Subject } from 'rxjs';
import { listPartitionSerialPorts, readConnectedDevicePartitions } from './partition-device-host';

describe('Connected partition reader port ownership', () => {
  const device = { port: 'COM7', chip: 'ESP32-S3', flashBytes: 8 * 1024 * 1024, tableOffset: 0x8000, partitions: [], readAt: '' };
  let serial: any;
  let ui: any;
  let resources: any;
  let read: jasmine.Spy;
  beforeEach(() => {
    serial = { currentPort: 'COM7', getSerialPorts: jasmine.createSpy('ports').and.resolveTo([{ name: 'COM7', type: 'serial' }, { name: 'COM8', type: 'serial' }]) };
    ui = { actionSubject: new Subject(), sendToolSignal: jasmine.createSpy('signal').and.callFake((data, payload) => {
      ui.actionSubject.next({ action: 'signal', type: 'tool', data, payload });
    }) };
    resources = { handleSignal: jasmine.createSpy('lifecycle').and.resolveTo() };
    read = jasmine.createSpy('read').and.resolveTo(device);
  });

  it('releases the selected port and completes the handoff without reconnecting tools', async () => {
    expect(await readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBe(device);
    expect(read).toHaveBeenCalledOnceWith('COM7');
    const [suspend, resume] = resources.handleSignal.calls.allArgs();
    expect(suspend[0]).toBe('serial-monitor:disconnect'); expect(resume[0]).toBe('serial-monitor:connect');
    expect(suspend[1].operationId).toBe(resume[1].operationId); expect(resume[1].outcome).toBe('success');
    expect(resume[1].port).toBe('COM7');
    expect(suspend[1].restore).toBeFalse(); expect(resume[1].restore).toBeFalse();
    expect(ui.sendToolSignal.calls.allArgs().every(([, payload]) => payload.restore === false)).toBeTrue();
  });

  it('keeps tools disconnected and permits retry after a read failure', async () => {
    read.and.rejectWith(new Error('device unplugged'));
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBeRejectedWithError('device unplugged');
    expect(resources.handleSignal.calls.mostRecent().args[1].outcome).toBe('failed');
    expect(resources.handleSignal.calls.mostRecent().args[1].restore).toBeFalse();
    read.and.resolveTo(device);
    expect(await readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBe(device);
  });

  it('does not read without a serial port or while the project is busy', async () => {
    serial.currentPort = '';
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBeRejectedWithError(/选择.*串口/);
    serial.currentPort = 'COM7'; serial.getSerialPorts.and.resolveTo([{ name: 'COM7', type: 'debugger' }]);
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBeRejectedWithError(/不可用/);
    serial.getSerialPorts.and.resolveTo([{ name: 'COM7', type: 'serial' }]);
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => true, serial.currentPort, read)).toBeRejectedWithError(/正在执行/);
    expect(read).not.toHaveBeenCalled(); expect(resources.handleSignal).not.toHaveBeenCalled();
  });

  it('lists serial ports with the software selection and reads an explicitly chosen port', async () => {
    const listed = await listPartitionSerialPorts(serial);
    expect(listed.currentPort).toBe('COM7'); expect(listed.ports.map(port => port.name)).toEqual(['COM7', 'COM8']);
    await readConnectedDevicePartitions(serial, ui, resources, () => false, 'COM8', read);
    expect(read).toHaveBeenCalledOnceWith('COM8'); expect(serial.currentPort).toBe('COM7');
    expect(resources.handleSignal.calls.first().args[1].port).toBe('COM8');
    expect(resources.handleSignal.calls.mostRecent().args[1].port).toBe('COM8');
  });

  it('rejects a port that disappeared after selection before suspending tools', async () => {
    serial.getSerialPorts.and.resolveTo([]);
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, 'COM8', read)).toBeRejectedWithError(/已断开/);
    expect(read).not.toHaveBeenCalled(); expect(resources.handleSignal).not.toHaveBeenCalled();
  });

  it('rolls back suspension when a serial tool cannot release the port', async () => {
    resources.handleSignal.and.callFake(signal => signal === 'serial-monitor:disconnect'
      ? Promise.reject(new Error('port busy')) : Promise.resolve());
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBeRejectedWithError('port busy');
    expect(read).not.toHaveBeenCalled();
    expect(resources.handleSignal.calls.mostRecent().args[0]).toBe('serial-monitor:connect');
    expect(resources.handleSignal.calls.mostRecent().args[1].restore).toBeFalse();
  });

  it('blocks concurrent reads and makes another serial owner wait for cleanup', async () => {
    let finish!: (value: typeof device) => void;
    read.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read);
    await expectAsync(readConnectedDevicePartitions(serial, ui, resources, () => false, serial.currentPort, read)).toBeRejectedWithError(/正在执行/);
    const waitFor: Promise<void>[] = [];
    ui.sendToolSignal('serial-monitor:disconnect', { port: 'COM7', source: 'uploader', waitFor });
    expect(waitFor.length).toBe(1);
    let released = false; void waitFor[0].then(() => { released = true; });
    await Promise.resolve(); expect(released).toBeFalse();
    finish(device); await pending; await waitFor[0]; expect(released).toBeTrue();
  });
});
