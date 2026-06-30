import { Injectable } from '@angular/core';
import { EspSessionService } from './esp-session.service';
import { ResolvedBaud } from './usb-bridge';

export type FfsFilesystemType = 'spiffs' | 'littlefs' | 'fatfs';

export interface FfsDeviceInfo {
  chip: string;
  mac: string;
  features: string;
  crystal: string;
  flashId: string;
  flashManufacturerId: string;
  flashManufacturer: string;
  flashDeviceId: string;
  flashSize: string;
  rawOutput: string;
}

export interface FfsPartitionInfo {
  index: number;
  label: string;
  type: number;
  subtype: number;
  typeName: string;
  subtypeName: string;
  offset: number;
  size: number;
  flags: number;
  offsetHex: string;
  sizeHex: string;
  sizeText: string;
  filesystemType: FfsFilesystemType | null;
}

const DEFAULT_PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;
const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC = 0x50aa;
const PARTITION_ALIGNMENT = 0x1000;
const PARTITION_TABLE_PROBE_OFFSETS = [
  0x8000, 0x9000, 0xa000, 0xc000, 0xd000, 0xe000, 0x10000,
];

const FLASH_MANUFACTURERS: Record<string, string> = {
  '01': 'Spansion / Cypress',
  '0b': 'XMC',
  '1c': 'EON',
  '20': 'Micron',
  '68': 'Boya',
  '85': 'Puya',
  '9d': 'ISSI',
  'a1': 'Fudan Micro',
  'bf': 'Microchip / SST',
  'c2': 'Macronix',
  'c8': 'GigaDevice',
  'ef': 'Winbond',
};

@Injectable({ providedIn: 'root' })
export class FfsManagerService {
  constructor(private espSession: EspSessionService) { }

  /**
   * 当波特率因为桥接芯片能力被自动钳制时调用，便于 UI 同步显示与提示用户。
   * 仅在实际发生钳制时触发一次（同一会话内重复调用不会重复触发）。
   */
  onBaudResolved: ((result: ResolvedBaud, port: string) => void) | null = null;
  private lastBaudNoticeKey: string | null = null;

  /**
   * 兼容旧 UI 的能力探测：只要渲染端能拿到 Node SerialPort 就视为可用。
   * 返回一个伪 packageInfo 让 component 现有 `esptoolReady` 判断保持原样。
   */
  async detectEsptool(_clearCache = false): Promise<{ esptoolPath: string } | null> {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    if (w?.electronAPI?.SerialPort?.createRaw) {
      return { esptoolPath: 'node-serialport://esptool-js' };
    }
    return null;
  }

  /** 释放 ESP 长会话，关闭串口并 hard reset。组件销毁 / 切换工具时调用。 */
  async release(hardReset = true): Promise<void> {
    this.lastBaudNoticeKey = null;
    if (this.espSession.isConnected) {
      await this.espSession.disconnect(hardReset);
    }
  }

  async readDeviceInfo(port: string, baudRate: number): Promise<FfsDeviceInfo> {
    await this.ensureSession(port, baudRate);
    const chip = this.espSession.chip;
    let manufacturerId = '';
    let deviceId = '';
    let flashSize = chip?.flashSize || '';
    try {
      const flashIdRaw = await this.readFlashIdRaw();
      manufacturerId = (flashIdRaw & 0xff).toString(16).padStart(2, '0');
      deviceId = ((flashIdRaw >> 8) & 0xffff).toString(16).padStart(4, '0');
      if (!flashSize) {
        const sizeId = (flashIdRaw >> 16) & 0xff;
        flashSize = String(sizeId);
      }
    } catch (error) {
      console.warn('[FfsManager] 读取 flash id 失败:', error);
    }

    return {
      chip: chip?.description || chip?.chipName || 'Unknown',
      mac: chip?.mac || '',
      features: chip?.features?.length ? chip.features.join(', ') : '',
      crystal: typeof chip?.crystalFreq === 'number' && chip.crystalFreq > 0 ? `${chip.crystalFreq} MHz` : '',
      flashId: manufacturerId && deviceId ? `${manufacturerId}${deviceId}` : '',
      flashManufacturerId: manufacturerId,
      flashManufacturer: FLASH_MANUFACTURERS[manufacturerId] || '',
      flashDeviceId: deviceId,
      flashSize,
      rawOutput: `Chip: ${chip?.description || chip?.chipName}\nMAC: ${chip?.mac}\nFeatures: ${chip?.features?.join(', ') || ''}\nCrystal: ${chip?.crystalFreq ?? ''}\nFlash size: ${flashSize}\nFlash ID: ${manufacturerId}${deviceId}`,
    };
  }

  async readPartitionTable(port: string, baudRate: number): Promise<FfsPartitionInfo[]> {
    await this.ensureSession(port, baudRate);
    const tableOffset = await this.detectPartitionTableOffset();
    const bytes = await this.espSession.readFlash(tableOffset, PARTITION_TABLE_SIZE);
    return this.parsePartitionTable(bytes);
  }

  async readPartitionImage(
    port: string,
    baudRate: number,
    partition: FfsPartitionInfo,
    onProgress?: (received: number, total: number) => void,
  ): Promise<Uint8Array> {
    await this.ensureSession(port, baudRate);
    return await this.espSession.readFlash(partition.offset, partition.size, onProgress);
  }

  async erasePartition(port: string, baudRate: number, partition: FfsPartitionInfo): Promise<void> {
    await this.ensureSession(port, baudRate);
    await this.espSession.erasePartition(partition.offset, partition.size);
  }

  async writePartitionImage(
    port: string,
    baudRate: number,
    partition: FfsPartitionInfo,
    data: Uint8Array,
    onProgress?: (written: number, total: number) => void,
  ): Promise<void> {
    if (data.length !== partition.size) {
      throw new Error(`镜像大小必须等于分区大小：${partition.sizeText}`);
    }
    await this.ensureSession(port, baudRate);
    await this.espSession.writePartitionImage(partition.offset, data, onProgress);
  }

  buildPartitionFileName(partition: FfsPartitionInfo): string {
    const label = this.sanitizeFileName(partition.label || `partition_${partition.index}`);
    const suffix = partition.filesystemType || partition.subtypeName.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'partition';
    return `${label}_${partition.offsetHex}_${suffix}.bin`;
  }

  parsePartitionTable(bytes: Uint8Array): FfsPartitionInfo[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const partitions: FfsPartitionInfo[] = [];

    for (let offset = 0; offset + PARTITION_ENTRY_SIZE <= bytes.length; offset += PARTITION_ENTRY_SIZE) {
      const magic = view.getUint16(offset, true);
      if (magic === 0xffff || magic === 0x0000) {
        break;
      }
      if (magic !== PARTITION_MAGIC) continue;

      const type = view.getUint8(offset + 2);
      const subtype = view.getUint8(offset + 3);
      const partitionOffset = view.getUint32(offset + 4, true);
      const size = view.getUint32(offset + 8, true);
      const label = this.readAscii(bytes.subarray(offset + 12, offset + 28));
      const flags = view.getUint32(offset + 28, true);
      const typeName = this.getPartitionTypeName(type);
      const subtypeName = this.getPartitionSubtypeName(type, subtype);

      partitions.push({
        index: partitions.length,
        label,
        type,
        subtype,
        typeName,
        subtypeName,
        offset: partitionOffset,
        size,
        flags,
        offsetHex: this.toHex(partitionOffset),
        sizeHex: this.toHex(size),
        sizeText: this.formatBytes(size),
        filesystemType: this.detectFilesystemType(label, type, subtype),
      });
    }

    return partitions;
  }

  private async ensureSession(port: string, baudRate: number): Promise<void> {
    if (
      this.espSession.isConnected &&
      this.espSession.portPath === port &&
      (this.espSession.requestedBaudRate === baudRate || this.espSession.baudRate === baudRate)
    ) {
      return;
    }
    await this.espSession.connect({
      portPath: port,
      baudRate,
      onBaudResolved: (resolved, resolvedPort) => this.notifyBaudResolved(resolved, resolvedPort),
    });
  }

  private notifyBaudResolved(resolved: ResolvedBaud, port: string): void {
    const key = `${port}|${resolved.requested}|${resolved.baud}`;
    if (this.lastBaudNoticeKey === key) {
      return;
    }
    this.lastBaudNoticeKey = key;
    try { this.onBaudResolved?.(resolved, port); } catch { /* ignore */ }
  }

  private async readFlashIdRaw(): Promise<number> {
    const session = this.espSession as any;
    const loader = session?.loader;
    if (!loader) {
      throw new Error('ESP 设备未连接');
    }
    return await loader.readFlashId();
  }

  private async detectPartitionTableOffset(): Promise<number> {
    for (const candidate of PARTITION_TABLE_PROBE_OFFSETS) {
      try {
        const entry = await this.espSession.readFlash(candidate, PARTITION_ENTRY_SIZE);
        if (this.hasPlausiblePartitionEntry(entry)) {
          return candidate;
        }
      } catch (error) {
        console.warn(`[FfsManager] 分区表偏移 ${this.toHex(candidate)} 探测失败:`, error);
      }
    }
    return DEFAULT_PARTITION_TABLE_OFFSET;
  }

  private hasPlausiblePartitionEntry(bytes: Uint8Array): boolean {
    if (bytes.length < PARTITION_ENTRY_SIZE) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== PARTITION_MAGIC) return false;
    const type = view.getUint8(2);
    const offset = view.getUint32(4, true);
    const size = view.getUint32(8, true);
    if (type === 0xff) return false;
    if (offset < PARTITION_ALIGNMENT || size < PARTITION_ALIGNMENT) return false;
    return offset % PARTITION_ALIGNMENT === 0 && size % PARTITION_ALIGNMENT === 0;
  }

  private getPartitionTypeName(type: number): string {
    if (type === 0x00) return 'app';
    if (type === 0x01) return 'data';
    return this.toHex(type, 2);
  }

  private getPartitionSubtypeName(type: number, subtype: number): string {
    if (type === 0x00) {
      if (subtype === 0x00) return 'factory';
      if (subtype === 0x20) return 'test';
      if (subtype >= 0x10 && subtype <= 0x1f) return `ota_${subtype - 0x10}`;
    }
    if (type === 0x01) {
      const dataSubtypes: Record<number, string> = {
        0x00: 'ota',
        0x01: 'phy',
        0x02: 'nvs',
        0x03: 'coredump',
        0x04: 'nvs_keys',
        0x05: 'efuse',
        0x80: 'esphttpd',
        0x81: 'fatfs',
        0x82: 'spiffs',
        0x83: 'littlefs',
      };
      return dataSubtypes[subtype] || this.toHex(subtype, 2);
    }
    return this.toHex(subtype, 2);
  }

  private detectFilesystemType(label: string, type: number, subtype: number): FfsFilesystemType | null {
    if (type !== 0x01) return null;
    if (subtype === 0x82) return 'spiffs';
    if (subtype === 0x83) return 'littlefs';
    if (subtype === 0x81) return 'fatfs';
    const normalized = label.toLowerCase();
    if (normalized.includes('littlefs') || normalized.includes('little_fs')) return 'littlefs';
    if (normalized.includes('spiffs') || normalized.includes('spiflash')) return 'spiffs';
    if (normalized.includes('fatfs') || normalized === 'ffat' || normalized.includes('vfs')) return 'fatfs';
    return null;
  }

  private readAscii(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) {
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text.trim();
  }

  private toHex(value: number, minLength = 0): string {
    return `0x${value.toString(16).toUpperCase().padStart(minLength, '0')}`;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  private sanitizeFileName(value: string): string {
    return (value || 'partition').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'partition';
  }
}
