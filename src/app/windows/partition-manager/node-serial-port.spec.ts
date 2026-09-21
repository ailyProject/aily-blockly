import { NodeSerialPortAdapter } from './node-serial-port';

describe('Partition reader serial adapter cleanup', () => {
  let originalApi: any;
  let raw: any;
  beforeEach(() => {
    originalApi = window['electronAPI'];
    raw = {
      isOpen: false,
      open: jasmine.createSpy('open').and.callFake(callback => callback()),
      close: jasmine.createSpy('close').and.callFake(callback => callback()),
      on: jasmine.createSpy('on'), off: jasmine.createSpy('off'),
    };
    window['electronAPI'] = { SerialPort: { createRaw: () => raw } } as any;
  });
  afterEach(() => { window['electronAPI'] = originalApi; });

  it('closes the actual port even when the bridge reports a stale isOpen value', async () => {
    const port = new NodeSerialPortAdapter({ path: 'COM7' });
    await port.open({ baudRate: 115200 });
    await port.dispose();
    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(port.readable).toBeNull(); expect(port.writable).toBeNull();
    await expectAsync(port.open({ baudRate: 115200 })).toBeRejectedWithError(/读取已结束/);
  });

  it('closes a pending open that completes after the read has been disposed', async () => {
    let opened!: () => void;
    raw.open.and.callFake(callback => { opened = callback; });
    const port = new NodeSerialPortAdapter({ path: 'COM7' });
    const pending = port.open({ baudRate: 115200 });
    await port.dispose(); opened();
    await expectAsync(pending).toBeRejectedWithError(/读取已结束/);
    expect(raw.close).toHaveBeenCalled(); expect(port.readable).toBeNull();
  });

  it('waits for the same physical close when timeout and final cleanup overlap', async () => {
    let finishClose!: () => void;
    raw.close.and.callFake(callback => { finishClose = callback; });
    const port = new NodeSerialPortAdapter({ path: 'COM7' });
    await port.open({ baudRate: 115200 });
    const timedOut = port.dispose();
    const finished = port.dispose();
    expect(finished).toBe(timedOut);
    let settled = false; void finished.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse(); expect(raw.close).toHaveBeenCalledTimes(1);
    finishClose(); await finished;
    expect(settled).toBeTrue();
  });
});
