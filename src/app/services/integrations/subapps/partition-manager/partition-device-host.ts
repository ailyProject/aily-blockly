import type { SerialService } from '@domain/device/public-api';
import type { Observable } from 'rxjs';
import type { SubappResourceLifecycleService } from '@integration/subapps/public-api';
import { readDevicePartitions, type PartitionSerialPort } from './partition-device';

let reading = false;

interface PartitionDeviceSignals {
  actionSubject: Observable<unknown>;
  sendToolSignal(signal: string, payload?: unknown): void;
}

export async function listPartitionSerialPorts(serial: Pick<SerialService, 'currentPort' | 'getSerialPorts'>) {
  const ports: PartitionSerialPort[] = (await serial.getSerialPorts())
    .filter(port => port.name && (!port.type || port.type === 'serial'))
    .map(port => ({ name: port.name!, text: port.text || port.name! }));
  return { ports, currentPort: String(serial.currentPort || '').trim() };
}

export async function readConnectedDevicePartitions(
  serial: Pick<SerialService, 'currentPort' | 'getSerialPorts'>,
  ui: PartitionDeviceSignals,
  resources: Pick<SubappResourceLifecycleService, 'handleSignal'>,
  isBusy: () => boolean,
  requestedPort = String(serial.currentPort || ''),
  read = readDevicePartitions,
) {
  const port = String(requestedPort || '').trim();
  if (!port) throw new Error('请先选择设备串口。');
  if (reading || isBusy()) throw new Error('设备或项目正在执行操作，请等待完成后再读取分区。');
  reading = true;
  const operationId = `partition-read-${crypto.randomUUID()}`;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const subscription = ui.actionSubject.subscribe((action: any) => {
    const payload = action?.payload;
    if (action?.data === 'serial-monitor:disconnect' && payload?.source !== 'partition-manager'
      && String(payload?.port || '').toLowerCase() === port.toLowerCase() && Array.isArray(payload?.waitFor)) {
      payload.waitFor.push(released);
    }
  });
  const signal = async (name: string, outcome?: string) => {
    const waitFor: Promise<void>[] = [];
    const payload = { port, portType: 'serial', source: 'partition-manager', reason: 'partition-read', restore: false, operationId, outcome, waitFor };
    const task = resources.handleSignal(name, payload);
    if (task) waitFor.push(task);
    ui.sendToolSignal(name, payload);
    const results = await Promise.allSettled(waitFor);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  let outcome = 'failed';
  let suspended = false;
  try {
    const { ports } = await listPartitionSerialPorts(serial);
    if (!ports.some(item => item.name === port)) throw new Error(`串口 ${port} 已断开或不可用，请刷新串口列表。`);
    suspended = true;
    await signal('serial-monitor:disconnect');
    await new Promise(resolve => setTimeout(resolve, 300));
    if (isBusy()) throw new Error('项目状态已改变，请等待当前操作结束后重试。');
    const device = await read(port);
    outcome = 'success';
    return device;
  } finally {
    // Complete the resource handoff without reopening a monitor/FS connection (restore: false).
    try { if (suspended) await signal('serial-monitor:connect', outcome); }
    catch (error) { console.warn('[PartitionManager] 结束串口资源占用失败:', error); }
    finally { subscription.unsubscribe(); reading = false; release(); }
  }
}
