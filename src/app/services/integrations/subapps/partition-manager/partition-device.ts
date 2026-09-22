import SparkMD5 from 'spark-md5';
import { NodeSerialPortAdapter } from './node-serial-port';
import { hex, parseFlashSize, SECTOR } from './partition-layout';

export interface DevicePartition {
  name: string;
  type: string;
  subtype: string;
  offset: number;
  size: number;
  flags: number;
}
export interface DevicePartitionSnapshot {
  port: string;
  chip: string;
  flashBytes: number;
  tableOffset: number;
  bootloaderOffset?: number;
  partitions: DevicePartition[];
  readAt: string;
}

export interface PartitionSerialPort {
  name: string;
  text: string;
}

const TABLE_SIZE = 0xc00;
const TABLE_OFFSETS = [0x8000, 0x9000, 0xa000, 0xc000, 0xd000, 0xe000, 0x10000];
const DATA_SUBTYPES: Record<number, string> = {
  0: 'ota', 1: 'phy', 2: 'nvs', 3: 'coredump', 4: 'nvs_keys', 5: 'efuse',
  6: 'undefined', 0x80: 'esphttpd', 0x81: 'fat', 0x82: 'spiffs', 0x83: 'littlefs',
};

/** Decode the on-device ESP-IDF table, including its optional MD5 record. */
export function parseDevicePartitionTable(bytes: Uint8Array, tableOffset: number, flashBytes = 0): DevicePartition[] {
  if (bytes.length !== TABLE_SIZE) throw new Error('设备分区表读取不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions: DevicePartition[] = [];
  for (let position = 0; position < bytes.length; position += 32) {
    const magic = view.getUint16(position, true);
    if (magic === 0xffff) break;
    if (magic === 0xebeb) {
      const expected = Array.from(bytes.subarray(position + 16, position + 32), byte => byte.toString(16).padStart(2, '0')).join('');
      if (SparkMD5.ArrayBuffer.hash(bytes.slice(0, position).buffer) !== expected) throw new Error('设备分区表校验失败，请重新读取。');
      break;
    }
    if (magic !== 0x50aa) throw new Error('设备分区表格式无效。');
    const type = view.getUint8(position + 2);
    const subtype = view.getUint8(position + 3);
    const offset = view.getUint32(position + 4, true);
    const size = view.getUint32(position + 8, true);
    const validLocation = type === 2 && subtype === 0 ? offset + size <= tableOffset
      : type === 3 && subtype === 0 ? offset === tableOffset && size === SECTOR
      : offset >= tableOffset + SECTOR;
    if (type === 0xff || !validLocation || offset % SECTOR || !size
      || offset + size > 0x100000000 || (flashBytes > 0 && offset + size > flashBytes)) {
      throw new Error('设备分区的地址或大小无效。');
    }
    const label = bytes.subarray(position + 12, position + 28);
    const end = label.indexOf(0);
    const name = new TextDecoder().decode(end < 0 ? label : label.subarray(0, end));
    partitions.push({
      name, type: type === 0 ? 'app' : type === 1 ? 'data' : type === 2 ? 'bootloader' : type === 3 ? 'partition_table' : hex(type),
      subtype: type === 0
        ? subtype === 0 ? 'factory' : subtype === 0x20 ? 'test' : subtype >= 0x10 && subtype <= 0x1f ? `ota_${subtype - 0x10}` : hex(subtype)
        : type === 1 ? DATA_SUBTYPES[subtype] || hex(subtype)
        : type === 2 ? ({ 0: 'primary', 1: 'ota', 2: 'recovery' }[subtype] || hex(subtype))
        : type === 3 ? ({ 0: 'primary', 1: 'ota' }[subtype] || hex(subtype)) : hex(subtype),
      offset, size, flags: view.getUint32(position + 28, true),
    });
  }
  if (!partitions.length) throw new Error('设备中未找到分区信息。');
  const sorted = [...partitions].sort((a, b) => a.offset - b.offset);
  if (sorted.some((partition, index) => index > 0 && partition.offset < sorted[index - 1].offset + sorted[index - 1].size)) {
    throw new Error('设备分区表存在重叠分区。');
  }
  return partitions;
}

/** Match ffs-manager's ROM/stub read flow; never erase or write flash. */
export async function readDevicePartitions(portPath: string): Promise<DevicePartitionSnapshot> {
  const { ESPLoader, Transport } = await import('esptool-js');
  const port = new NodeSerialPortAdapter({ path: portPath });
  const transport = new Transport(port as any, false);
  // Only a few KiB are read. Keep the ROM baud rate to avoid USB-UART baud switching.
  const loader = new ESPLoader({ transport, baudrate: 115200, debugLogging: false,
    terminal: { clean: () => {}, write: () => {}, writeLine: () => {} } });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void port.dispose(); }, 60000);
  try {
    const chip = await loader.main('default_reset');
    if (!loader.chip.CHIP_NAME.startsWith('ESP32')) throw new Error('当前连接的设备不是 ESP32。');
    let flashBytes = 0;
    try {
      const id = await loader.readFlashId();
      flashBytes = parseFlashSize(loader.DETECTED_FLASH_SIZES[(id >>> 16) & 0xff]);
    } catch { /* The partition table can still be inspected when capacity detection is unavailable. */ }
    let invalidTable = '';
    for (const tableOffset of TABLE_OFFSETS) {
      if (timedOut) throw new Error('读取设备分区超时，请检查连接后重试。');
      const bytes = await loader.readFlash(tableOffset, TABLE_SIZE);
      if (timedOut) throw new Error('读取设备分区超时，请检查连接后重试。');
      if (bytes[0] !== 0xaa || bytes[1] !== 0x50) continue;
      try {
        const partitions = parseDevicePartitionTable(bytes, tableOffset, flashBytes);
        return { port: portPath, chip, flashBytes, tableOffset, bootloaderOffset: loader.chip.BOOTLOADER_FLASH_OFFSET,
          partitions, readAt: new Date().toISOString() };
      } catch (error) { invalidTable = error instanceof Error ? error.message : String(error); }
    }
    throw new Error(invalidTable || '未找到有效的设备分区表，请确认固件已烧录，且分区表位于支持的地址。');
  } catch (error) {
    if (timedOut) throw new Error('读取设备分区超时，请检查连接后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    // Return to the installed firmware, then leave the serial port disconnected.
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch { /* The device may have been unplugged. */ }
    // Transport.disconnect waits for stream locks. Close the raw handle first so even a
    // failed read with a locked stream cannot retain the COM port during that wait.
    try { await port.dispose(); } finally { await transport.disconnect(); }
  }
}
