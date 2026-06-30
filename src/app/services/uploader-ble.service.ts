import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject } from 'rxjs';
import { IMenuItem } from '../configs/menu.config';

const BLE_OTA_SERVICE_UUID = '00008018-0000-1000-8000-00805f9b34fb';
const BLE_OTA_RECV_FW_CHAR_UUID = '00008020-0000-1000-8000-00805f9b34fb';
const BLE_OTA_COMMAND_CHAR_UUID = '00008022-0000-1000-8000-00805f9b34fb';
const DEVICE_INFORMATION_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';

const SECTOR_SIZE = 4096;
const COMMAND_FRAME_SIZE = 20;
const FIRMWARE_PACKET_HEADER_SIZE = 3;
const FIRMWARE_PACKET_CRC_SIZE = 2;
const CMD_START_FLASH = 0x0001;
const CMD_STOP = 0x0002;
const CMD_ACK = 0x0003;
const CMD_START_FILESYSTEM = 0x0004;
const ACK_OK = 0x0000;
const ACK_CRC_ERROR = 0x0001;
const ACK_INDEX_ERROR = 0x0002;
const ACK_SIGNATURE_ERROR = 0x0003;
const ACK_START_ERROR = 0x0005;
const COMMAND_ACK_TIMEOUT_MS = 15000;
const STOP_COMMAND_ACK_TIMEOUT_MS = 45000;
const STOP_COMMAND_RETRY_TIMEOUT_MS = 15000;
const DEFAULT_SCAN_TIMEOUT_MS = 3000;
const GATT_CONNECT_MAX_ATTEMPTS = 3;
const GATT_CONNECT_RETRY_DELAY_MS = 800;
const GATT_CONNECT_SETTLE_DELAY_MS = 500;
const GATT_DISCONNECT_CLEANUP_TIMEOUT_MS = 3000;
const DEVICE_AUTHORIZATION_TIMEOUT_MS = 10000;
const BLE_WRITE_YIELD_INTERVAL = 8;
const BLE_DEBUG_ENABLED = false;

export type BleOtaUpdateType = 'flash' | 'filesystem';

export interface BleOtaDeviceItem {
  id: string;
  name: string;
  device?: any;
  connected?: boolean;
  source?: 'web-bluetooth' | 'electron-scan';
}

export interface BleOtaScanState {
  scanning: boolean;
  devices: BleOtaDeviceItem[];
}

export interface BleOtaProgress {
  state: 'connecting' | 'probing' | 'starting' | 'sending' | 'stopping' | 'done';
  progress: number;
  text?: string;
  sectorIndex?: number;
  sectorCount?: number;
  bytesSent?: number;
  totalBytes?: number;
  speed?: number;
}

export interface BleOtaUploadOptions {
  updateType?: BleOtaUpdateType;
  packetSize?: number;
  retries?: number;
  progress?: (progress: BleOtaProgress) => void;
  signal?: AbortSignal;
}

export interface BleOtaUploadResult {
  success: boolean;
  bytes: number;
  elapsedMs: number;
  deviceName?: string;
}

export interface BleOtaTransport {
  beginScan(timeoutMs?: number): Promise<BleOtaDeviceItem>;
  cancelScan(): Promise<void>;
  selectDevice(deviceId: string): Promise<BleOtaDeviceItem>;
  authorizeDevice(deviceId?: string, progress?: (progress: BleOtaProgress) => void, deviceName?: string): Promise<BleOtaDeviceItem>;
  connect(deviceId?: string, progress?: (progress: BleOtaProgress) => void): Promise<void>;
  disconnect(): Promise<void>;
  uploadFirmware(firmware: Uint8Array | ArrayBuffer, options?: BleOtaUploadOptions): Promise<BleOtaUploadResult>;
  cancel(): void;
}

interface BleOtaCommandAck {
  commandId: number;
  status: number;
}

interface BleOtaSectorAck {
  sectorIndex: number;
  status: number;
  expectedIndex: number;
}

interface PendingCommandAck {
  commandId: number;
  resolve: (ack: BleOtaCommandAck) => void;
  reject: (error: any) => void;
  timer: any;
}

interface PendingSectorAck {
  sectorIndex: number;
  resolve: (ack: BleOtaSectorAck) => void;
  reject: (error: any) => void;
  timer: any;
}

@Injectable({
  providedIn: 'root'
})
export class UploaderBleService implements BleOtaTransport {
  private translate = inject(TranslateService);

  readonly devicesChanged = new BehaviorSubject<BleOtaDeviceItem[]>([]);
  readonly scanStateChanged = new BehaviorSubject<BleOtaScanState>({ scanning: false, devices: [] });

  private knownDevices = new Map<string, BleOtaDeviceItem>();
  private discoveredDevices = new Map<string, BleOtaDeviceItem>();
  private selectedDeviceId: string | null = null;
  private scanPromise: Promise<BleOtaDeviceItem> | null = null;
  private searching = false;
  private scanTimeoutTimer: any = null;
  private emitLogTimer: any = null;
  private bridgeInitialized = false;
  private removeBridgeDeviceListListener?: () => void;

  private server: any = null;
  private recvFwCharacteristic: any = null;
  private commandCharacteristic: any = null;
  private pendingCommandAcks: PendingCommandAck[] = [];
  private pendingSectorAcks: PendingSectorAck[] = [];
  private cancelRequested = false;

  private readonly handleCommandNotification = (event: any) => {
    const data = this.getEventBytes(event);
    if (data.length < COMMAND_FRAME_SIZE) return;
    if (!this.isFrameCrcValid(data)) return;

    const frameCommand = this.readUint16LE(data, 0);
    if (frameCommand !== CMD_ACK) return;

    const ack: BleOtaCommandAck = {
      commandId: this.readUint16LE(data, 2),
      status: this.readUint16LE(data, 4),
    };

    const pending = this.pendingCommandAcks.find(item => item.commandId === ack.commandId) || this.pendingCommandAcks[0];
    if (!pending) return;

    this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
    pending.resolve(ack);
  };

  private readonly handleFirmwareNotification = (event: any) => {
    const data = this.getEventBytes(event);
    if (data.length < COMMAND_FRAME_SIZE) return;
    if (!this.isFrameCrcValid(data)) return;

    const ack: BleOtaSectorAck = {
      sectorIndex: this.readUint16LE(data, 0),
      status: this.readUint16LE(data, 2),
      expectedIndex: this.readUint16LE(data, 4),
    };

    const pending = this.pendingSectorAcks.find(item => item.sectorIndex === ack.sectorIndex) || this.pendingSectorAcks[0];
    if (!pending) return;

    this.pendingSectorAcks = this.pendingSectorAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
    pending.resolve(ack);
  };

  private readonly handleGattDisconnected = (event: any) => {
    const device = event?.target;
    if (device?.id && this.knownDevices.has(device.id)) {
      const cached = this.knownDevices.get(device.id);
      this.knownDevices.set(device.id, { ...cached, connected: false });
      this.emitDevices(this.isScanning());
    }
    this.rejectPendingAcks(new Error(this.t('DEVICE_DISCONNECTED')));
    this.server = null;
    this.recvFwCharacteristic = null;
    this.commandCharacteristic = null;
  };

  isSupported(): boolean {
    return !!this.getBluetooth()?.requestDevice;
  }

  isScanning(): boolean {
    return this.searching;
  }

  hasActiveRequest(): boolean {
    return !!this.scanPromise;
  }

  getSelectedDevice(): BleOtaDeviceItem | null {
    if (!this.selectedDeviceId) return null;
    return this.knownDevices.get(this.selectedDeviceId) || this.discoveredDevices.get(this.selectedDeviceId) || null;
  }

  getDevices(): BleOtaDeviceItem[] {
    return Array.from(this.discoveredDevices.values());
  }

  getPortMenuItems(currentPort?: string): IMenuItem[] {
    const items: IMenuItem[] = [];
    const supported = this.isSupported();
    const scanning = this.isScanning();
    const devices = this.getDevices();

    this.debug('build port menu items', {
      supported,
      scanning,
      currentPort,
      deviceCount: devices.length,
      devices: devices.map(device => ({ id: device.id, name: device.name, source: device.source }))
    });

    items.push({
      name: scanning ? this.t('SEARCHING_DEVICE') : this.t('SEARCH_DEVICE'),
      // text: supported ? 'Web Bluetooth' : 'Not supported',
      action: supported && !scanning ? 'ble-scan' : undefined,
      type: 'ble-action',
      icon: scanning ? 'fa-light fa-spinner-third fa-spin' : 'fa-light fa-magnifying-glass',
      disabled: !supported || scanning,
    });

    for (const device of devices) {
      items.push({
        name: device.name || this.t('DEFAULT_DEVICE_NAME'),
        text: 'BLE OTA',
        type: 'ble',
        icon: 'fa-light fa-bluetooth',
        current: currentPort === device.id,
        extra: {
          deviceId: device.id,
          source: device.source,
        },
      } as IMenuItem);
    }

    return items;
  }

  async refreshGrantedDevices(): Promise<BleOtaDeviceItem[]> {
    const bluetooth = this.getBluetooth();
    if (!bluetooth?.getDevices) return this.getDevices();

    try {
      const devices = await bluetooth.getDevices();
      for (const device of devices || []) {
        this.cacheBluetoothDevice(device);
      }
      this.emitDevices(this.isScanning());
    } catch (error) {
      console.warn('读取已授权 BLE 设备失败:', error);
    }

    return this.getDevices();
  }

  async beginScan(timeoutMs = DEFAULT_SCAN_TIMEOUT_MS): Promise<BleOtaDeviceItem> {
    if (this.scanPromise) {
      this.startSearchWindow(timeoutMs);
      return this.scanPromise;
    }

    const bluetooth = this.getBluetooth();
    this.debug('beginScan called', {
      hasBluetooth: !!bluetooth,
      hasRequestDevice: !!bluetooth?.requestDevice,
      hasBridge: !!window['ble']?.onDeviceList,
      userAgent: navigator.userAgent,
    });

    if (!bluetooth?.requestDevice) {
      throw new Error(this.t('WEB_BLUETOOTH_UNSUPPORTED'));
    }

    if (this.isElectronRuntime() && !window['ble']?.onDeviceList) {
      throw new Error(this.t('PREPARE_DEVICE_SELECTION_FAILED'));
    }

    this.setupElectronBluetoothBridge();
    this.discoveredDevices.clear();
    this.startSearchWindow(timeoutMs);

    const requestOptions = {
      filters: [{ services: [BLE_OTA_SERVICE_UUID] }],
      optionalServices: [BLE_OTA_SERVICE_UUID, DEVICE_INFORMATION_SERVICE_UUID],
    };

    this.debug('calling navigator.bluetooth.requestDevice', requestOptions);

    this.scanPromise = bluetooth.requestDevice(requestOptions)
      .then((device: any) => {
        this.debug('requestDevice resolved', {
          id: device?.id,
          name: device?.name,
          hasGatt: !!device?.gatt,
        });
        const item = this.cacheBluetoothDevice(device);
        this.selectedDeviceId = item.id;
        return this.releaseDeviceConnection(item, 'scan selection');
      })
      .catch(error => {
        this.debug('requestDevice rejected', error?.message || error);
        throw error;
      })
      .finally(() => {
        this.debug('requestDevice finished');
        this.clearSearchTimeout();
        this.searching = false;
        window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
        this.scanPromise = null;
        this.emitDevices(false);
      });

    return this.scanPromise;
  }

  async cancelScan(): Promise<void> {
    if (!this.scanPromise && !this.searching) return;

    try {
      this.clearSearchTimeout();
      this.searching = false;
      await window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
      await window['ble']?.cancelDeviceRequest?.().catch?.(() => undefined);
    } catch (error) {
      console.warn('取消 BLE 扫描失败:', error);
    } finally {
      this.emitDevices(false);
    }
  }

  async selectDevice(deviceId: string): Promise<BleOtaDeviceItem> {
    if (!deviceId) throw new Error(this.t('DEVICE_ID_EMPTY'));

    const cached = this.knownDevices.get(deviceId);
    if (cached?.device) {
      this.selectedDeviceId = deviceId;
      const selected = this.releaseDeviceConnection(cached, 'device selection');
      this.emitDevices(this.isScanning());
      return selected;
    }

    const discovered = this.discoveredDevices.get(deviceId);
    if (discovered) {
      this.selectedDeviceId = discovered.id;
      this.emitDevices(this.isScanning());
      return discovered;
    }

    throw new Error(this.t('DEVICE_NOT_FOUND'));
  }

  async authorizeDevice(
    deviceId?: string,
    progress?: (progress: BleOtaProgress) => void,
    deviceName?: string,
  ): Promise<BleOtaDeviceItem> {
    const item = await this.ensureDevice(deviceId || this.selectedDeviceId || undefined, progress, deviceName);
    this.selectedDeviceId = item.id;
    this.emitDevices(this.isScanning());
    return item;
  }

  async connect(deviceId?: string, progress?: (progress: BleOtaProgress) => void): Promise<void> {
    const deviceItem = await this.ensureDevice(deviceId || this.selectedDeviceId || undefined, progress);
    const device = deviceItem.device;
    if (!device?.gatt) {
      throw new Error(this.t('DEVICE_NOT_AUTHORIZED'));
    }

    if (device.gatt.connected && this.recvFwCharacteristic && this.commandCharacteristic) {
      return;
    }

    await this.disconnect();
    this.server = await this.connectGattWithRetry(deviceItem, progress);
    const otaService = await this.server.getPrimaryService(BLE_OTA_SERVICE_UUID);
    this.recvFwCharacteristic = await otaService.getCharacteristic(BLE_OTA_RECV_FW_CHAR_UUID);
    this.commandCharacteristic = await otaService.getCharacteristic(BLE_OTA_COMMAND_CHAR_UUID);

    await this.commandCharacteristic.startNotifications();
    await this.recvFwCharacteristic.startNotifications();
    this.commandCharacteristic.addEventListener('characteristicvaluechanged', this.handleCommandNotification);
    this.recvFwCharacteristic.addEventListener('characteristicvaluechanged', this.handleFirmwareNotification);

    this.knownDevices.set(deviceItem.id, { ...deviceItem, connected: true });
    this.selectedDeviceId = deviceItem.id;
    this.emitDevices(this.isScanning());
  }

  async disconnect(): Promise<void> {
    try {
      if (this.commandCharacteristic) {
        this.commandCharacteristic.removeEventListener('characteristicvaluechanged', this.handleCommandNotification);
        await this.stopNotificationsSafely(this.commandCharacteristic, 'command');
      }
      if (this.recvFwCharacteristic) {
        this.recvFwCharacteristic.removeEventListener('characteristicvaluechanged', this.handleFirmwareNotification);
        await this.stopNotificationsSafely(this.recvFwCharacteristic, 'firmware');
      }
    } finally {
      const selected = this.getSelectedDevice();
      if (selected?.device?.gatt?.connected) {
        selected.device.gatt.disconnect();
      }
      this.server = null;
      this.recvFwCharacteristic = null;
      this.commandCharacteristic = null;
      this.rejectPendingAcks(new Error(this.t('CONNECTION_CLOSED')));
    }
  }

  private async stopNotificationsSafely(characteristic: any, label: string): Promise<void> {
    if (!characteristic?.service?.device?.gatt?.connected || !characteristic.stopNotifications) return;

    try {
      await this.withTimeout(
        characteristic.stopNotifications(),
        GATT_DISCONNECT_CLEANUP_TIMEOUT_MS,
        `stop ${label} notifications timeout`,
      );
    } catch (error) {
      this.debug('stop BLE notifications failed', {
        characteristic: label,
        error: error?.message || error,
      });
    }
  }

  async uploadFirmware(firmware: Uint8Array | ArrayBuffer, options: BleOtaUploadOptions = {}): Promise<BleOtaUploadResult> {
    const data = firmware instanceof Uint8Array ? firmware : new Uint8Array(firmware);
    if (!data.byteLength) throw new Error(this.t('FIRMWARE_EMPTY'));

    const startTime = Date.now();
    this.cancelRequested = false;

    const emitProgress = (progress: BleOtaProgress) => {
      options.progress?.(progress);
    };

    try {
      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'connecting', progress: 0, text: this.t('CONNECTING_DEVICE') });
      await this.connect(undefined, emitProgress);

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'probing', progress: 1, text: this.t('NEGOTIATING_PACKET_SIZE') });
      const packetSize = options.packetSize || await this.probePacketSize();
      emitProgress({
        state: 'probing',
        progress: 1,
        text: this.t('PACKET_SIZE_INFO', {
          packetSize,
          payloadSize: Math.max(0, packetSize - FIRMWARE_PACKET_HEADER_SIZE),
        }),
      });

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'starting', progress: 2, text: this.t('STARTING_OTA') });
      await this.sendStartCommand(options.updateType || 'flash', data.byteLength);

      await this.sendFirmware(data, packetSize, {
        ...options,
        progress: emitProgress,
      });

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'stopping', progress: 99, text: this.t('VERIFYING_FIRMWARE') });
      await this.sendStopCommand();

      const elapsedMs = Date.now() - startTime;
      emitProgress({
        state: 'done',
        progress: 100,
        text: this.t('DONE'),
        bytesSent: data.byteLength,
        totalBytes: data.byteLength,
        speed: elapsedMs > 0 ? Math.round(data.byteLength / (elapsedMs / 1000)) : 0,
      });

      return {
        success: true,
        bytes: data.byteLength,
        elapsedMs,
        deviceName: this.getSelectedDevice()?.name,
      };
    } catch (error) {
      if (this.cancelRequested || options.signal?.aborted) {
        throw new Error(this.t('CANCELLED'));
      }
      throw error;
    }
  }

  cancel(): void {
    this.cancelRequested = true;
    this.rejectPendingAcks(new Error(this.t('CANCELLED')));
  }

  findFirmwareFile(buildPath: string): string {
    if (!buildPath || !window['fs']?.existsSync(buildPath)) return '';

    const files = this.collectFiles(buildPath)
      .filter(filePath => filePath.toLowerCase().endsWith('.bin'));

    const appBins = files.filter(filePath => {
      const name = window['path'].basename(filePath).toLowerCase();
      return !/(bootloader|partition|boot_app0|ota_data|spiffs|littlefs|filesystem|fatfs)/.test(name);
    });

    return appBins.find(filePath => window['path'].basename(filePath).toLowerCase().endsWith('.ino.bin'))
      || appBins[0]
      || '';
  }

  readFirmwareFile(filePath: string): Uint8Array {
    const base64 = window['fs'].readFileAsBase64(filePath);
    return this.base64ToBytes(base64);
  }

  private async sendFirmware(data: Uint8Array, packetSize: number, options: BleOtaUploadOptions): Promise<void> {
    const sectorCount = Math.ceil(data.byteLength / SECTOR_SIZE);
    const retries = options.retries ?? 3;
    const payloadSize = packetSize - FIRMWARE_PACKET_HEADER_SIZE;
    const finalPayloadSize = packetSize - FIRMWARE_PACKET_HEADER_SIZE - FIRMWARE_PACKET_CRC_SIZE;
    if (finalPayloadSize <= 0) throw new Error(this.t('PACKET_SIZE_INVALID', { packetSize }));

    let sectorIndex = 0;
    const startTime = Date.now();
    let lastProgressValue = -1;
    const reportSendingProgress = (bytesSent: number, currentSectorIndex: number) => {
      const progressValue = Math.max(2, Math.floor((bytesSent / data.byteLength) * 98));
      if (progressValue === lastProgressValue && bytesSent < data.byteLength) return;

      lastProgressValue = progressValue;
      const elapsed = Math.max(Date.now() - startTime, 1);
      const percent = Math.floor((bytesSent / data.byteLength) * 100);
      options.progress?.({
        state: 'sending',
        progress: progressValue,
        text: this.t('SENDING_PROGRESS', { progress: percent }),
        sectorIndex: currentSectorIndex,
        sectorCount,
        bytesSent,
        totalBytes: data.byteLength,
        speed: Math.round(bytesSent / (elapsed / 1000)),
      });
    };

    while (sectorIndex < sectorCount) {
      let sent = false;
      let attempt = 0;

      while (!sent && attempt <= retries) {
        this.throwIfCancelled(options.signal);
        const sectorStart = sectorIndex * SECTOR_SIZE;
        const sectorEnd = Math.min(sectorStart + SECTOR_SIZE, data.byteLength);
        const sector = data.subarray(sectorStart, sectorEnd);

        const ackPromise = this.waitForSectorAck(sectorIndex);
        await this.writeSector(sectorIndex, sector, payloadSize, finalPayloadSize, data.byteLength, reportSendingProgress, options.signal);
        const ack = await ackPromise;

        if (ack.status === ACK_OK) {
          sectorIndex++;
          sent = true;
          break;
        }

        if (ack.status === ACK_INDEX_ERROR && ack.expectedIndex >= 0 && ack.expectedIndex < sectorCount) {
          sectorIndex = ack.expectedIndex;
          sent = true;
          break;
        }

        attempt++;
      }

      if (!sent) {
        throw new Error(this.t('SECTOR_RETRY_FAILED', { sectorIndex }));
      }
    }
  }

  private async writeSector(
    sectorIndex: number,
    sector: Uint8Array,
    payloadSize: number,
    finalPayloadSize: number,
    totalBytes: number,
    progress?: (bytesSent: number, sectorIndex: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const sectorCrc = this.crc16(sector);
    let offset = 0;
    let seq = 0;
    let packetsWritten = 0;

    while (offset < sector.byteLength) {
      this.throwIfCancelled(signal);
      const remaining = sector.byteLength - offset;
      const isLast = remaining <= finalPayloadSize;
      let chunkSize = isLast ? remaining : Math.min(payloadSize, remaining);

      if (!isLast && remaining - chunkSize === 0) {
        chunkSize = remaining - finalPayloadSize;
      }

      const packet = new Uint8Array(FIRMWARE_PACKET_HEADER_SIZE + chunkSize + (isLast ? FIRMWARE_PACKET_CRC_SIZE : 0));
      this.writeUint16LE(packet, 0, sectorIndex);
      packet[2] = isLast ? 0xff : seq++;
      packet.set(sector.subarray(offset, offset + chunkSize), FIRMWARE_PACKET_HEADER_SIZE);
      if (isLast) {
        this.writeUint16LE(packet, FIRMWARE_PACKET_HEADER_SIZE + chunkSize, sectorCrc);
      }

      await this.writeCharacteristic(this.recvFwCharacteristic, packet, true);
      packetsWritten++;
      offset += chunkSize;

      const bytesSent = Math.min((sectorIndex * SECTOR_SIZE) + offset, totalBytes);
      progress?.(bytesSent, sectorIndex);

      if (packetsWritten % BLE_WRITE_YIELD_INTERVAL === 0) {
        await this.delay(0);
      }
    }
  }

  private async sendStartCommand(updateType: BleOtaUpdateType, totalSize: number): Promise<void> {
    const commandId = updateType === 'filesystem' ? CMD_START_FILESYSTEM : CMD_START_FLASH;
    await this.sendCommand(commandId, totalSize);
  }

  private async sendStopCommand(): Promise<void> {
    try {
      await this.sendCommand(CMD_STOP, undefined, STOP_COMMAND_ACK_TIMEOUT_MS);
      return;
    } catch (error) {
      if (this.isDisconnectedError(error)) return;
      if (!this.isCommandAckTimeout(error, CMD_STOP)) throw error;
      if (!this.isSelectedGattConnected()) return;

      this.debug('STOP ACK timeout, retrying command once');
    }

    try {
      await this.sendCommand(CMD_STOP, undefined, STOP_COMMAND_RETRY_TIMEOUT_MS);
    } catch (error) {
      if (this.isDisconnectedError(error)) return;
      if (this.isCommandAckTimeout(error, CMD_STOP)) {
        this.debug('STOP ACK timeout after retry, treating command as completed');
        return;
      }
      throw error;
    }
  }

  private async sendCommand(commandId: number, totalSize?: number, timeout = COMMAND_ACK_TIMEOUT_MS): Promise<void> {
    if (!this.commandCharacteristic) throw new Error(this.t('COMMAND_CHARACTERISTIC_UNAVAILABLE'));

    const frame = this.buildCommandFrame(commandId, totalSize);
    const ackPromise = this.waitForCommandAck(commandId, timeout);
    try {
      await this.writeCharacteristic(this.commandCharacteristic, frame, true);
    } catch (error) {
      this.clearPendingCommandAck(commandId);
      throw error;
    }
    const ack = await ackPromise;

    if (ack.status !== ACK_OK) {
      throw new Error(this.formatAckError(ack.status, commandId));
    }
  }

  private async probePacketSize(): Promise<number> {
    if (!this.recvFwCharacteristic) throw new Error(this.t('FIRMWARE_CHARACTERISTIC_UNAVAILABLE'));

    for (const candidate of [510, 247, 185, 122, 23]) {
      try {
        await this.writeCharacteristic(this.recvFwCharacteristic, new Uint8Array(candidate), true);
        return candidate;
      } catch (error) {
        console.warn(`BLE 包大小 ${candidate} 不可用:`, error);
      }
    }

    return 20;
  }

  private waitForCommandAck(commandId: number, timeout = COMMAND_ACK_TIMEOUT_MS): Promise<BleOtaCommandAck> {
    return new Promise((resolve, reject) => {
      const pending: PendingCommandAck = {
        commandId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
          reject(new Error(this.getCommandAckTimeoutMessage(commandId)));
        }, timeout),
      };
      this.pendingCommandAcks.push(pending);
    });
  }

  private clearPendingCommandAck(commandId: number): void {
    const pending = this.pendingCommandAcks.find(item => item.commandId === commandId);
    if (!pending) return;
    this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
  }

  private waitForSectorAck(sectorIndex: number, timeout = 15000): Promise<BleOtaSectorAck> {
    return new Promise((resolve, reject) => {
      const pending: PendingSectorAck = {
        sectorIndex,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingSectorAcks = this.pendingSectorAcks.filter(item => item !== pending);
          reject(new Error(this.t('SECTOR_ACK_TIMEOUT', { sectorIndex })));
        }, timeout),
      };
      this.pendingSectorAcks.push(pending);
    });
  }

  private buildCommandFrame(commandId: number, totalSize?: number): Uint8Array {
    const frame = new Uint8Array(COMMAND_FRAME_SIZE);
    this.writeUint16LE(frame, 0, commandId);
    if (typeof totalSize === 'number') {
      this.writeUint32LE(frame, 2, totalSize);
    }
    this.writeUint16LE(frame, 18, this.crc16(frame.subarray(0, 18)));
    return frame;
  }

  private async writeCharacteristic(characteristic: any, data: Uint8Array, withoutResponse: boolean): Promise<void> {
    const value = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (withoutResponse && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(value);
      return;
    }
    if (!withoutResponse && characteristic.writeValueWithResponse) {
      await characteristic.writeValueWithResponse(value);
      return;
    }
    await characteristic.writeValue(value);
  }

  private async ensureDevice(
    deviceId?: string,
    progress?: (progress: BleOtaProgress) => void,
    deviceName?: string,
  ): Promise<BleOtaDeviceItem> {
    const id = deviceId || this.selectedDeviceId;
    const device = id ? this.knownDevices.get(id) : this.getSelectedDevice();
    if (!device?.device) {
      const discovered = id ? this.discoveredDevices.get(id) : null;
      if (discovered) {
        return this.authorizeDiscoveredDevice(discovered, progress);
      }

      if (id) {
        return this.authorizeRememberedDevice(id, deviceName || device?.name, progress);
      }

      await this.refreshGrantedDevices();
      const grantedDevice = id ? this.knownDevices.get(id) : this.getSelectedDevice();
      if (grantedDevice?.device) {
        return grantedDevice;
      }

      throw new Error(this.t('SELECT_DEVICE_FIRST'));
    }
    return device;
  }

  private async authorizeDiscoveredDevice(
    discovered: BleOtaDeviceItem,
    progress?: (progress: BleOtaProgress) => void,
  ): Promise<BleOtaDeviceItem> {
    progress?.({ state: 'connecting', progress: 0, text: this.t('CONFIRMING_DEVICE') });
    return this.requestPreferredDevice(discovered, progress);
  }

  private async authorizeRememberedDevice(
    deviceId: string,
    deviceName?: string,
    progress?: (progress: BleOtaProgress) => void,
  ): Promise<BleOtaDeviceItem> {
    progress?.({ state: 'connecting', progress: 0, text: this.t('SEARCHING_DEVICE') });
    return this.requestPreferredDevice({
      id: deviceId,
      name: deviceName || this.t('DEFAULT_DEVICE_NAME'),
      source: 'electron-scan',
    }, progress);
  }

  private async requestPreferredDevice(
    preferredDevice: BleOtaDeviceItem,
    progress?: (progress: BleOtaProgress) => void,
  ): Promise<BleOtaDeviceItem> {
    const bluetooth = this.getBluetooth();
    if (!bluetooth?.requestDevice) {
      throw new Error(this.t('WEB_BLUETOOTH_UNSUPPORTED'));
    }

    const requestOptions = {
      filters: [{ services: [BLE_OTA_SERVICE_UUID] }],
      optionalServices: [BLE_OTA_SERVICE_UUID, DEVICE_INFORMATION_SERVICE_UUID],
    };

    this.setupElectronBluetoothBridge();
    if (this.isElectronRuntime() && window['ble']?.setPreferredDevice) {
      // Keep this before requestDevice; startDeviceListUpdates clears the preferred id in main.
      Promise.resolve(window['ble'].setPreferredDevice(preferredDevice.id))
        .then((result: any) => {
          if (result?.success === false) {
            this.debug('setPreferredDevice rejected by main', result?.error);
          }
        })
        .catch((error: any) => this.debug('setPreferredDevice failed', error?.message || error));
    }

    let timeoutTimer: any = null;
    let timedOut = false;
    const startedSearchWindow = !this.searching;

    try {
      if (startedSearchWindow) {
        this.discoveredDevices.clear();
        this.searching = true;
        this.emitDevices(true);
      }

      const requestPromise = bluetooth.requestDevice(requestOptions);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          window['ble']?.cancelDeviceRequest?.().catch?.(() => undefined);
          reject(new Error(this.t('CONFIRM_DEVICE_TIMEOUT')));
        }, DEVICE_AUTHORIZATION_TIMEOUT_MS);
      });

      const device = await Promise.race([requestPromise, timeoutPromise]);
      const item = this.cacheBluetoothDevice(device);
      this.selectedDeviceId = item.id;
      this.removeDiscoveredDuplicates(item, preferredDevice.id, preferredDevice.name);
      progress?.({ state: 'connecting', progress: 0, text: this.t('DEVICE_SELECTED_CONNECTING') });
      return item;
    } catch (error) {
      if (timedOut) throw error;

      const message = error?.message || String(error || '');
      if (/Must be handling a user gesture/i.test(message)) {
        throw new Error(this.t('USER_GESTURE_REQUIRED'));
      }
      if (/cancel|cancelled|no device selected|user cancelled/i.test(message)) {
        throw new Error(this.t('DEVICE_SELECTION_CANCELLED'));
      }
      throw error;
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (startedSearchWindow) {
        this.searching = false;
        await window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
        // Let Chromium finish the Web Bluetooth chooser/scanning cycle before GATT connect.
        await this.delay(GATT_CONNECT_SETTLE_DELAY_MS);
        this.emitDevices(false);
      }
    }
  }

  private async connectGattWithRetry(
    deviceItem: BleOtaDeviceItem,
    progress?: (progress: BleOtaProgress) => void,
  ): Promise<any> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= GATT_CONNECT_MAX_ATTEMPTS; attempt++) {
      this.throwIfCancelled();

      const retryText = attempt === 1
        ? this.t('CONNECTING_DEVICE')
        : this.t('CONNECT_RETRY', { attempt, maxAttempts: GATT_CONNECT_MAX_ATTEMPTS });
      progress?.({ state: 'connecting', progress: 0, text: retryText });

      try {
        this.debug('connecting BLE GATT', {
          id: deviceItem.id,
          name: deviceItem.name,
          attempt,
          maxAttempts: GATT_CONNECT_MAX_ATTEMPTS,
        });
        return await deviceItem.device.gatt.connect();
      } catch (error) {
        lastError = error;
        this.debug('BLE GATT connect failed', {
          id: deviceItem.id,
          name: deviceItem.name,
          attempt,
          maxAttempts: GATT_CONNECT_MAX_ATTEMPTS,
          error: error?.message || error,
        });

        if (!this.isTransientConnectionError(error) || attempt >= GATT_CONNECT_MAX_ATTEMPTS) {
          break;
        }

        this.safeDisconnectGatt(deviceItem.device);
        await this.delay(GATT_CONNECT_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError || new Error(this.t('CONNECT_FAILED'));
  }

  private safeDisconnectGatt(device: any): void {
    try {
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
    } catch {
      // ignore
    }
  }

  private cacheBluetoothDevice(device: any): BleOtaDeviceItem {
    const item: BleOtaDeviceItem = {
      id: device.id,
      name: device.name || this.t('DEFAULT_DEVICE_NAME'),
      device,
      connected: !!device.gatt?.connected,
      source: 'web-bluetooth',
    };
    try {
      device.removeEventListener?.('gattserverdisconnected', this.handleGattDisconnected);
      device.addEventListener?.('gattserverdisconnected', this.handleGattDisconnected);
    } catch {
      // ignore
    }
    this.knownDevices.set(item.id, item);
    this.removeDiscoveredDuplicates(item);
    this.emitDevices(this.isScanning());
    return item;
  }

  private cacheDiscoveredDevice(device: any): BleOtaDeviceItem | null {
    const id = device?.deviceId || device?.id || device?.device_id || device?.address;
    if (!id) return null;

    const item: BleOtaDeviceItem = {
      id,
      name: device.deviceName || device.name || device.device_name || this.t('DEFAULT_DEVICE_NAME'),
      connected: false,
      source: 'electron-scan',
    };
    this.discoveredDevices.set(item.id, item);
    return item;
  }

  private removeDiscoveredDuplicates(deviceItem: BleOtaDeviceItem, deviceId?: string, deviceName?: string): void {
    if (deviceId) {
      this.discoveredDevices.delete(deviceId);
    }

    const dedupKeys = new Set([
      this.getDeviceDedupKey(deviceItem),
      this.getDeviceDedupKey({ ...deviceItem, name: deviceName || deviceItem.name }),
    ].filter(Boolean));

    for (const [id, discovered] of this.discoveredDevices) {
      if (id === deviceItem.id || dedupKeys.has(this.getDeviceDedupKey(discovered))) {
        this.discoveredDevices.delete(id);
      }
    }
  }

  private getDeviceDedupKey(device?: Pick<BleOtaDeviceItem, 'id' | 'name'>): string {
    return (device?.name || '').trim().toLowerCase() || (device?.id || '').trim().toLowerCase();
  }

  private releaseDeviceConnection(deviceItem: BleOtaDeviceItem, reason: string): BleOtaDeviceItem {
    const device = deviceItem?.device;
    const wasConnected = !!device?.gatt?.connected;

    if (!wasConnected) {
      if (deviceItem.connected) {
        const updated = { ...deviceItem, connected: false };
        this.knownDevices.set(deviceItem.id, updated);
        return updated;
      }
      return deviceItem;
    }

    try {
      this.debug('disconnect BLE device after selection', {
        reason,
        id: deviceItem.id,
        name: deviceItem.name,
      });
      device.gatt.disconnect();
    } catch (error) {
      console.warn('断开 BLE 设备连接失败:', error);
    }

    this.server = null;
    this.recvFwCharacteristic = null;
    this.commandCharacteristic = null;
    this.rejectPendingAcks(new Error(this.t('CONNECTION_CLOSED')));
    const updated = { ...deviceItem, connected: false };
    this.knownDevices.set(deviceItem.id, updated);
    this.emitDevices(this.isScanning());
    return updated;
  }

  private setupElectronBluetoothBridge(): void {
    if (this.bridgeInitialized) return;
    this.bridgeInitialized = true;

    if (!window['ble']?.onDeviceList) {
      this.debug('electron BLE bridge missing');
      return;
    }

    this.debug('register electron BLE device list listener');
    this.removeBridgeDeviceListListener = window['ble'].onDeviceList((devices: any[]) => {
      if (!this.searching) return;

      this.debug('device list received from electron', {
        count: Array.isArray(devices) ? devices.length : -1,
        devices,
      });
      this.discoveredDevices.clear();
      for (const device of devices || []) {
        this.cacheDiscoveredDevice(device);
      }
      this.emitDevices(true);
    });
  }

  private startSearchWindow(timeoutMs: number): void {
    this.clearSearchTimeout();
    this.searching = true;
    window['ble']?.startDeviceListUpdates?.().catch?.(() => undefined);
    this.emitDevices(true);

    this.scanTimeoutTimer = setTimeout(() => {
      this.searching = false;
      window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
      this.debug('scan timeout reached', {
        timeoutMs,
        discoveredCount: this.discoveredDevices.size,
      });
      window['ble']?.cancelDeviceRequest?.().catch?.(() => undefined);
      this.emitDevices(false);
    }, Math.max(0, timeoutMs));
  }

  private clearSearchTimeout(): void {
    if (this.scanTimeoutTimer) {
      clearTimeout(this.scanTimeoutTimer);
      this.scanTimeoutTimer = null;
    }
  }

  private emitDevices(scanning: boolean): void {
    const devices = this.getDevices();
    if (!this.emitLogTimer) {
      this.emitLogTimer = setTimeout(() => {
        this.emitLogTimer = null;
        this.debug('emit devices', {
          scanning,
          count: devices.length,
          devices: devices.map(device => ({ id: device.id, name: device.name, source: device.source }))
        });
      }, 0);
    }
    this.devicesChanged.next(devices);
    this.scanStateChanged.next({ scanning, devices });
  }

  private debug(message: string, data?: any): void {
    if (!BLE_DEBUG_ENABLED) return;

    if (data !== undefined) {
      console.log('[BLE:web]', message, data);
    } else {
      console.log('[BLE:web]', message);
    }
  }

  private rejectPendingAcks(error: any): void {
    for (const pending of this.pendingCommandAcks) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const pending of this.pendingSectorAcks) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommandAcks = [];
    this.pendingSectorAcks = [];
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (this.cancelRequested || signal?.aborted) {
      throw new Error(this.t('CANCELLED'));
    }
  }

  private t(key: string, params?: Record<string, any>): string {
    return this.translate.instant(`BLE_OTA.${key}`, params);
  }

  private getCommandAckTimeoutMessage(commandId: number): string {
    return this.t('COMMAND_ACK_TIMEOUT', { commandId: commandId.toString(16) });
  }

  private getBluetooth(): any {
    return navigator?.['bluetooth'];
  }

  private isElectronRuntime(): boolean {
    return typeof window !== 'undefined'
      && (!!window['electronAPI'] || /Electron/i.test(navigator?.userAgent || ''));
  }

  private isSelectedGattConnected(): boolean {
    return !!this.getSelectedDevice()?.device?.gatt?.connected;
  }

  private isCommandAckTimeout(error: any, commandId: number): boolean {
    const message = error?.message || String(error || '');
    return message.includes(this.getCommandAckTimeoutMessage(commandId))
      || message.includes(`等待命令 ACK 超时: 0x${commandId.toString(16)}`);
  }

  private isDisconnectedError(error: any): boolean {
    const message = error?.message || String(error || '');
    return message.includes(this.t('DEVICE_DISCONNECTED'))
      || message.includes(this.t('CONNECTION_CLOSED'))
      || /BLE 设备已断开|BLE 连接已关闭|GATT Server is disconnected|device is disconnected|disconnected/i.test(message);
  }

  private isTransientConnectionError(error: any): boolean {
    const message = error?.message || String(error || '');
    return /Connection Error|Connection attempt failed|GATT operation failed|GATT Server is disconnected|NetworkError|Bluetooth device is no longer in range/i.test(message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: any = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([
      promise.finally(() => {
        if (timer) clearTimeout(timer);
      }),
      timeoutPromise,
    ]);
  }

  private getEventBytes(event: any): Uint8Array {
    const value = event?.target?.value;
    if (!value) return new Uint8Array();
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  private isFrameCrcValid(data: Uint8Array): boolean {
    if (data.byteLength < 4) return false;
    const expected = this.readUint16LE(data, data.byteLength - 2);
    return this.crc16(data.subarray(0, data.byteLength - 2)) === expected;
  }

  private crc16(data: Uint8Array): number {
    let crc = 0x0000;
    for (const byte of data) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc & 0xffff;
  }

  private readUint16LE(data: Uint8Array, offset: number): number {
    return data[offset] | (data[offset + 1] << 8);
  }

  private writeUint16LE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
  }

  private writeUint32LE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
    data[offset + 2] = (value >> 16) & 0xff;
    data[offset + 3] = (value >> 24) & 0xff;
  }

  private formatAckError(status: number, commandId?: number): string {
    const prefix = typeof commandId === 'number'
      ? this.t('ACK_COMMAND_PREFIX', { commandId: commandId.toString(16) })
      : '';
    switch (status) {
      case ACK_CRC_ERROR:
        return `${prefix}${this.t('ACK_CRC_ERROR')}`;
      case ACK_INDEX_ERROR:
        return `${prefix}${this.t('ACK_INDEX_ERROR')}`;
      case ACK_SIGNATURE_ERROR:
        return `${prefix}${this.t('ACK_SIGNATURE_ERROR')}`;
      case ACK_START_ERROR:
        return `${prefix}${this.t('ACK_START_ERROR')}`;
      default:
        return `${prefix}${this.t('ACK_UNKNOWN_STATUS', { status: status.toString(16) })}`;
    }
  }

  private collectFiles(dirPath: string, result: string[] = []): string[] {
    const entries = window['fs'].readDirSync(dirPath) || [];
    for (const entry of entries) {
      const name = entry.name || entry;
      const filePath = window['path'].join(dirPath, name);
      const isDirectory = entry._isDirectory ?? window['fs'].statSync(filePath)._isDirectory;
      const isFile = entry._isFile ?? window['fs'].statSync(filePath)._isFile;
      if (isDirectory) {
        this.collectFiles(filePath, result);
      } else if (isFile) {
        result.push(filePath);
      }
    }
    return result;
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
}
