import SparkMD5 from 'spark-md5';
import { ESPLoader, Transport } from 'esptool-js';
import { parseDevicePartitionTable, readDevicePartitions } from './partition-device';

describe('Device partition table decoding', () => {
  function table(entries = [{ type: 1, subtype: 2, offset: 0x9000, size: 0x6000, name: 'nvs', flags: 0 }]) {
    const bytes = new Uint8Array(0xc00).fill(0xff);
    const view = new DataView(bytes.buffer);
    entries.forEach((entry, index) => {
      const position = index * 32;
      view.setUint16(position, 0x50aa, true);
      view.setUint8(position + 2, entry.type); view.setUint8(position + 3, entry.subtype);
      view.setUint32(position + 4, entry.offset, true); view.setUint32(position + 8, entry.size, true);
      bytes.fill(0, position + 12, position + 28);
      bytes.set(new TextEncoder().encode(entry.name), position + 12);
      view.setUint32(position + 28, entry.flags, true);
    });
    return bytes;
  }

  it('decodes OTA, filesystems, custom identifiers and flags without changing their values', () => {
    const bytes = table([
      { type: 0, subtype: 0x11, offset: 0x10000, size: 0x100000, name: 'ota_1', flags: 1 },
      { type: 1, subtype: 0x83, offset: 0x110000, size: 0x10000, name: 'littlefs', flags: 2 },
      { type: 0x40, subtype: 0x42, offset: 0x120000, size: 0x1000, name: 'custom', flags: 0x80 },
    ]);
    expect(parseDevicePartitionTable(bytes, 0x8000, 4 * 1024 * 1024)).toEqual([
      { name: 'ota_1', type: 'app', subtype: 'ota_1', offset: 0x10000, size: 0x100000, flags: 1 },
      { name: 'littlefs', type: 'data', subtype: 'littlefs', offset: 0x110000, size: 0x10000, flags: 2 },
      { name: 'custom', type: '0x40', subtype: '0x42', offset: 0x120000, size: 0x1000, flags: 0x80 },
    ]);
  });

  it('verifies the optional MD5 record and rejects corrupted data', () => {
    const bytes = table();
    const digest = SparkMD5.ArrayBuffer.hash(bytes.slice(0, 32).buffer);
    new DataView(bytes.buffer).setUint16(32, 0xebeb, true);
    bytes.set(Uint8Array.from(digest.match(/../g)!, (value: string) => parseInt(value, 16)), 48);
    expect(parseDevicePartitionTable(bytes, 0x8000).length).toBe(1);
    bytes[12] ^= 1;
    expect(() => parseDevicePartitionTable(bytes, 0x8000)).toThrowError(/校验失败/);
  });

  it('decodes explicit primary and recovery system entries, including bootloaders at address zero', () => {
    const bytes = table([
      { type: 2, subtype: 0, offset: 0, size: 0x8000, name: 'boot', flags: 1 },
      { type: 3, subtype: 0, offset: 0x8000, size: 0x1000, name: 'partitions', flags: 0 },
      { type: 2, subtype: 2, offset: 0x10000, size: 0x8000, name: 'recovery', flags: 0 },
      { type: 3, subtype: 1, offset: 0x18000, size: 0x1000, name: 'pt_ota', flags: 0 },
    ]);
    const entries = parseDevicePartitionTable(bytes, 0x8000, 4 * 1024 * 1024);
    expect(entries.map(entry => [entry.type, entry.subtype])).toEqual([
      ['bootloader', 'primary'], ['partition_table', 'primary'], ['bootloader', 'recovery'], ['partition_table', 'ota'],
    ]);
    expect(entries[0].offset).toBe(0); expect(entries[0].flags).toBe(1);
  });

  it('still rejects normal partitions in reserved addresses and inconsistent primary system entries', () => {
    for (const entry of [
      { type: 1, subtype: 2, offset: 0, size: 0x6000, name: 'nvs', flags: 0 },
      { type: 2, subtype: 0, offset: 0x1000, size: 0x8000, name: 'boot', flags: 0 },
      { type: 3, subtype: 0, offset: 0x9000, size: 0x1000, name: 'pt', flags: 0 },
      { type: 3, subtype: 0, offset: 0x8000, size: 0x2000, name: 'pt', flags: 0 },
    ]) expect(() => parseDevicePartitionTable(table([entry]), 0x8000)).toThrowError(/地址或大小/);
  });

  it('rejects empty, truncated, malformed and out-of-range tables', () => {
    expect(() => parseDevicePartitionTable(new Uint8Array(0xc00).fill(0xff), 0x8000)).toThrowError(/未找到/);
    expect(() => parseDevicePartitionTable(table().slice(0, 32), 0x8000)).toThrowError(/不完整/);
    const invalid = table(); invalid[32] = 0;
    expect(() => parseDevicePartitionTable(invalid, 0x8000)).toThrowError(/格式无效/);
    expect(() => parseDevicePartitionTable(table(), 0x9000)).toThrowError(/地址或大小/);
    expect(() => parseDevicePartitionTable(table(), 0x8000, 0xa000)).toThrowError(/地址或大小/);
  });

  it('rejects overlapping partitions', () => {
    const bytes = table([
      { type: 1, subtype: 2, offset: 0x9000, size: 0x6000, name: 'nvs', flags: 0 },
      { type: 1, subtype: 0, offset: 0xe000, size: 0x2000, name: 'otadata', flags: 0 },
    ]);
    expect(() => parseDevicePartitionTable(bytes, 0x8000)).toThrowError(/重叠/);
  });

  describe('read completion releases the serial handle', () => {
    let originalApi: any;
    let raw: any;
    let handshakeError: Error | null;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let writer: WritableStreamDefaultWriter<Uint8Array>;

    beforeEach(() => {
      originalApi = window['electronAPI']; handshakeError = null;
      raw = {
        isOpen: false,
        open: jasmine.createSpy('open').and.callFake(callback => { raw.isOpen = true; callback(); }),
        close: jasmine.createSpy('close').and.callFake(callback => setTimeout(() => { raw.isOpen = false; callback(); }, 10)),
        set: jasmine.createSpy('set').and.callFake((signals, callback) => callback()),
        on: jasmine.createSpy('on'), off: jasmine.createSpy('off'),
      };
      window['electronAPI'] = { SerialPort: { createRaw: () => raw } } as any;
      spyOn(ESPLoader.prototype, 'main').and.callFake(async function (this: ESPLoader) {
        this.chip = { CHIP_NAME: 'ESP32-S3', BOOTLOADER_FLASH_OFFSET: 0 } as any;
        await this.transport.device.open({ baudRate: 115200 });
        // Retain both stream locks, as may happen when a command fails mid-read.
        reader = this.transport.device.readable!.getReader();
        writer = this.transport.device.writable!.getWriter();
        if (handshakeError) throw handshakeError;
        return 'ESP32-S3';
      });
      spyOn(ESPLoader.prototype, 'readFlashId').and.rejectWith(new Error('capacity unavailable'));
      spyOn(ESPLoader.prototype, 'readFlash').and.resolveTo(table());
      const disconnect = Transport.prototype.disconnect;
      spyOn(Transport.prototype, 'disconnect').and.callFake(async function (this: Transport) {
        if (raw.isOpen) throw new Error('Raw serial handle was not released before stream cleanup');
        await disconnect.call(this);
      });
    });
    afterEach(() => {
      reader?.releaseLock(); writer?.releaseLock(); window['electronAPI'] = originalApi;
    });

    it('closes the port before resolving a successful read, even with retained stream locks', async () => {
      const result = await readDevicePartitions('COM7');
      expect(result.partitions[0].name).toBe('nvs'); expect(result.bootloaderOffset).toBe(0);
      expect(raw.isOpen).toBeFalse(); expect(raw.close).toHaveBeenCalledTimes(1);
      expect(Transport.prototype.disconnect).toHaveBeenCalledTimes(1);
    });

    it('closes the port before reporting a partition read failure', async () => {
      (ESPLoader.prototype.readFlash as jasmine.Spy).and.rejectWith(new Error('read failed'));
      await expectAsync(readDevicePartitions('COM7')).toBeRejectedWithError('read failed');
      expect(raw.isOpen).toBeFalse(); expect(raw.close).toHaveBeenCalledTimes(1);
    });

    it('closes the port before reporting a handshake failure', async () => {
      handshakeError = new Error('handshake failed');
      await expectAsync(readDevicePartitions('COM7')).toBeRejectedWithError('handshake failed');
      expect(raw.isOpen).toBeFalse(); expect(raw.close).toHaveBeenCalledTimes(1);
      expect(ESPLoader.prototype.readFlash).not.toHaveBeenCalled();
    });
  });
});
