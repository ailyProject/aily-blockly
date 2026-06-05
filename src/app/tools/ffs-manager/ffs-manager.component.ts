import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MenuComponent } from '../../components/menu/menu.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { PortItem, SerialService } from '../../services/serial.service';
import { UiService } from '../../services/ui.service';
import { BAUDRATE_LIST } from '../serial-monitor/config';
import { DeviceInfoComponent } from './components/device-info/device-info.component';
import { FileImageViewerComponent, FileImageViewerData } from './components/file-image-viewer/file-image-viewer.component';
import { FileTextViewerComponent, FileTextViewerData } from './components/file-text-viewer/file-text-viewer.component';
import { FilesystemManagerComponent } from './components/filesystem-manager/filesystem-manager.component';
import { PartitionMapComponent } from './components/partition-map/partition-map.component';
import { FfsFileEntry, FfsFilesystemContentService, FfsFilesystemUsage, FfsMountedFilesystem } from './ffs-filesystem-content.service';
import { FfsDeviceInfo, FfsFilesystemType, FfsManagerService, FfsPartitionInfo } from './ffs-manager.service';

interface FfsUploadRestoreContext {
  port: string;
}

@Component({
  selector: 'app-ffs-manager',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzSwitchModule,
    NzToolTipModule,
    TranslateModule,
    ToolContainerComponent,
    SubWindowComponent,
    MenuComponent,
    DeviceInfoComponent,
    PartitionMapComponent,
    FilesystemManagerComponent
  ],
  templateUrl: './ffs-manager.component.html',
  styleUrl: './ffs-manager.component.scss'
})
export class FfsManagerComponent {
  private destroyRef = inject(DestroyRef);
  private uploadRestoreContext: FfsUploadRestoreContext | null = null;
  private restoreAfterUploadTimer: ReturnType<typeof setTimeout> | null = null;
  // ffs-manager 主动发出的 serial-monitor:* 信号不需要被自己重启动 pause/restore。
  private readonly selfSignalTag = 'ffs-manager';
  private readonly restoreAfterUploadDelayMs = 200;

  private readonly defaultBaudRate = 921600;

  currentUrl = '';
  currentPort = '';
  currentBaudRate = String(this.defaultBaudRate);
  portList: PortItem[] = [];
  baudList = BAUDRATE_LIST;
  showPortList = false;
  showBaudList = false;
  position = { x: 0, y: 0 };

  switchValue = false;
  esptoolReady = false;
  busy = false;
  aborting = false;
  statusText = '';
  errorText = '';
  deviceInfo: FfsDeviceInfo | null = null;
  partitions: FfsPartitionInfo[] = [];
  selectedPartition: FfsPartitionInfo | null = null;
  filesystemSession: FfsMountedFilesystem | null = null;
  filesystemFiles: FfsFileEntry[] = [];
  selectedFile: FfsFileEntry | null = null;
  filesystemUsage: FfsFilesystemUsage | null = null;
  filesystemDirty = false;
  filesystemStatusText = '';
  private progressLastTs = 0;
  private progressLastPercent = -1;

  constructor(
    private router: Router,
    private uiService: UiService,
    private serialService: SerialService,
    private ffsManagerService: FfsManagerService,
    private ffsFilesystemContentService: FfsFilesystemContentService,
    private message: NzMessageService,
    private modal: NzModalService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService
  ) {
    this.statusText = this.t('STATUS.SELECT_PORT_REFRESH');
    this.filesystemStatusText = this.t('STATUS.FILESYSTEM_READY_HINT');
  }

  async ngOnInit() {
    this.currentUrl = this.router.url;
    if (this.serialService.currentPort && this.isSerialPortInfo(this.serialService.currentPortInfo)) {
      this.currentPort = this.serialService.currentPort;
    }
    await this.checkEsptool();
    await this.checkAndSetDefaultPort();

    // 桥接芯片波特率自适应：当 service 把用户选择钳制到芯片上限时同步到 UI。
    this.ffsManagerService.onBaudResolved = (result, port) => {
      if (port !== this.currentPort) return;
      this.currentBaudRate = String(result.baud);
      const chipName = result.bridge?.productName || this.t('CURRENT_USB_BRIDGE');
      this.message.warning(
        this.t('MESSAGES.BAUD_RATE_CAPPED', {
          chipName,
          requested: result.requested,
          baud: result.baud,
        }),
        { nzDuration: 4000 },
      );
      this.cd.detectChanges();
    };

    // 监听工具信号，处理上传过程中的串口断开/重连
    this.uiService.actionSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((action: any) => {
        if (action?.action === 'signal' && action?.type === 'tool') {
          const signal = action.data as string;
          // 忽略自己发的信号，避免 switchConnection 后立刻被 pauseForUpload 重置。
          if (action?.payload?.source === this.selfSignalTag) {
            return;
          }
          if (signal === 'serial-monitor:disconnect') {
            console.log(`[FfsManager] 收到 disconnect 信号：switchValue=${this.switchValue}, currentPort=${this.currentPort}, uploadPort=${this.getUploadPortFromSignal(action)}`);
            this.clearRestoreAfterUploadTimer();
            const releasePromise = this.pauseForUpload(this.getUploadPortFromSignal(action));
            if (Array.isArray(action?.payload?.waitFor)) {
              action.payload.waitFor.push(releasePromise);
              console.log('[FfsManager] 已把 release Promise 推进 uploader waitFor');
            } else {
              console.warn('[FfsManager] disconnect 信号中未携带 waitFor 数组');
            }
          } else if (signal === 'serial-monitor:connect') {
            this.scheduleRestoreAfterUpload(this.getUploadPortFromSignal(action));
          }
        }
      });
  }

  async ngOnDestroy() {
    this.ffsManagerService.onBaudResolved = null;
    this.clearRestoreAfterUploadTimer();
    try {
      await this.ffsManagerService.release(true);
    } catch (error) {
      console.warn('[FfsManager] 释放 ESP 会话失败:', error);
    }
  }

  private getUploadPortFromSignal(action: any): string | null {
    return action?.payload?.port || this.serialService.currentPort || null;
  }

  private isSerialPortInfo(portInfo: PortItem | null | undefined): boolean {
    const type = portInfo?.type;
    return !type || type === 'serial';
  }

  private clearRestoreAfterUploadTimer(): void {
    if (this.restoreAfterUploadTimer) {
      clearTimeout(this.restoreAfterUploadTimer);
      this.restoreAfterUploadTimer = null;
    }
  }

  private scheduleRestoreAfterUpload(uploadPort: string | null): void {
    this.clearRestoreAfterUploadTimer();
    this.restoreAfterUploadTimer = setTimeout(() => {
      this.restoreAfterUploadTimer = null;
      this.restoreAfterUpload(uploadPort);
    }, this.restoreAfterUploadDelayMs);
  }

  private async pauseForUpload(uploadPort: string | null): Promise<void> {
    this.uploadRestoreContext = null;
    if (!uploadPort || !this.switchValue || this.currentPort !== uploadPort) {
      console.log(`[FfsManager] pauseForUpload 跳过：uploadPort=${uploadPort}, switchValue=${this.switchValue}, currentPort=${this.currentPort}`);
      return;
    }

    this.uploadRestoreContext = { port: uploadPort };
    this.switchValue = false;
    this.statusText = this.t('STATUS.PAUSED_FOR_UPLOAD');
    this.cd.detectChanges();

    try {
      console.log('[FfsManager] 开始 release(true)…');
      // 必须 hard_reset：否则 ESP32-S3 留在 stub 模式 + 任意波特率，
      // 后续 esptool 烧录会撞到 "port is busy or doesn't exist"。
      // 复位后 ROM 模式下 USB-CDC 端点正常，esptool 能干净接管。
      await this.ffsManagerService.release(true);
      console.log('[FfsManager] release(true) 完成，OS 句柄已释放，ESP 已 hard_reset 回 ROM');
      // ESP32-S3 USB-CDC：hard_reset 会引起 USB 设备短暂断开重新枚举。
      // 必须等端口在系统串口列表里重新稳定出现，再放行 uploader，
      // 否则 esptool 启动时 CreateFile 会拿到 ERROR_FILE_NOT_FOUND/ACCESS_DENIED。
      await this.waitForPortReady(uploadPort, 4000);
    } catch (error) {
      console.warn('[FfsManager] 上传前释放 ESP 会话失败:', error);
    }
    this.deviceInfo = null;
    this.partitions = [];
    this.selectedPartition = null;
    this.resetFilesystemState();
    this.cd.detectChanges();
  }

  /**
   * 等待指定端口在系统串口列表中稳定出现。
   * ESP32-S3 USB-CDC 在 hard_reset 后会断开重新枚举，必须先等设备回来再让 esptool 启动，
   * 否则 CreateFile 会拿到 ERROR_FILE_NOT_FOUND/ACCESS_DENIED（即 "busy or doesn't exist"）。
   * 端口连续两次出现在 list 中视为稳定。
   */
  private async waitForPortReady(portPath: string, timeoutMs: number): Promise<void> {
    const w = window as any;
    const list = w?.electronAPI?.SerialPort?.list;
    const createRaw = w?.electronAPI?.SerialPort?.createRaw;
    if (!list || !createRaw) {
      console.warn('[FfsManager] 无法访问 SerialPort API，跳过端口就绪等待');
      return;
    }
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    // 实测探测：自己 createRaw + open + close，能跑通说明 esptool 也能拿到句柄。
    // 比单纯 list() 更可靠：list 只看驱动是否枚举，不验证句柄是否可独占。
    const tryProbeOpen = async (): Promise<string | null> => {
      let port: any = null;
      try {
        port = createRaw({ path: portPath, baudRate: 115200, autoOpen: false });
        if (typeof port?.open !== 'function') {
          return 'createRaw 返回对象缺少 open 方法';
        }
        await new Promise<void>((resolve, reject) => {
          port.open((err: any) => err ? reject(err) : resolve());
        });
        // 立刻关掉，腾给 esptool。
        await new Promise<void>((resolve) => {
          try { port.close(() => resolve()); } catch { resolve(); }
        });
        return null;
      } catch (err: any) {
        // 在 close 失败时仍尝试关闭，避免泄漏。
        try { if (port?.isOpen) port.close(() => { }); } catch { /* ignore */ }
        return String(err?.message || err);
      }
    };

    const start = Date.now();
    let attempt = 0;
    let lastErr: string | null = null;
    while (Date.now() - start < timeoutMs) {
      // 先看端口是否在系统列表里。
      let visible = false;
      try {
        const ports: Array<{ path: string }> = await list();
        visible = !!ports?.some(p => p?.path === portPath);
      } catch (e) {
        console.warn('[FfsManager] list 端口失败:', e);
      }
      if (visible) {
        const err = await tryProbeOpen();
        if (!err) {
          console.log(`[FfsManager] 端口 ${portPath} 已就绪（探测开关成功），耗时 ${Date.now() - start}ms，attempt=${attempt}`);
          // 额外缓冲一帧，让上一次关闭彻底释放（Windows 偶发延迟）。
          await sleep(200);
          return;
        }
        lastErr = err;
        console.log(`[FfsManager] 探测开关 ${portPath} 仍失败 (attempt ${attempt}): ${err}`);
      }
      attempt++;
      await sleep(200);
    }
    console.warn(`[FfsManager] 等待 ${portPath} 就绪超时（${timeoutMs}ms），最近错误: ${lastErr ?? '(端口始终不可见)'}`);
  }


  private async restoreAfterUpload(uploadPort: string | null) {
    const context = this.uploadRestoreContext;
    this.uploadRestoreContext = null;
    if (!context || !uploadPort || context.port !== uploadPort || this.switchValue) {
      return;
    }

    this.currentPort = context.port;
    this.switchValue = true;
    this.statusText = this.t('STATUS.RECONNECTING_AFTER_UPLOAD');
    this.cd.detectChanges();

    try {
      await this.refreshAll();
      if (this.errorText || !this.deviceInfo) {
        this.switchValue = false;
        try {
          await this.ffsManagerService.release(true);
        } catch { }
      }
    } catch (error) {
      console.warn('[FfsManager] 上传后重新连接 ESP 失败:', error);
      this.switchValue = false;
    }
    this.cd.detectChanges();
  }

  get filesystemPartitions() {
    return this.partitions.filter(partition => partition.filesystemType);
  }

  get selectedFilesystemLabel() {
    return this.getFsLabel(this.selectedPartition?.filesystemType || null);
  }

  get canManageSelectedPartition() {
    return Boolean(this.currentPort && this.selectedPartition?.filesystemType && !this.busy);
  }

  get hasFilesystemSession() {
    return Boolean(this.filesystemSession);
  }

  get canSaveFilesystemContent() {
    return Boolean(this.filesystemSession && this.filesystemDirty && this.currentPort && !this.busy);
  }

  async close() {
    try {
      await this.ffsManagerService.release(true);
    } catch (error) {
      console.warn('[FfsManager] 关闭工具时释放 ESP 会话失败:', error);
    }
    this.uiService.closeTool('ffs-manager');
  }

  async refreshAll() {
    if (!this.currentPort) {
      this.message.warning(this.t('STATUS.SELECT_PORT_FIRST'));
      return;
    }

    if (!this.esptoolReady) {
      await this.checkEsptool(true);
      if (!this.esptoolReady) {
        this.message.warning(this.t('STATUS.ESPTOOL_NOT_FOUND'));
        return;
      }
    }

    this.busy = true;
    this.errorText = '';
    this.statusText = this.t('STATUS.READING_DEVICE_INFO');
    this.cd.detectChanges();

    try {
      const baudRate = this.getSelectedBaudRate();
      this.deviceInfo = await this.ffsManagerService.readDeviceInfo(this.currentPort, baudRate);
      this.statusText = this.t('STATUS.READING_PARTITION_TABLE');
      this.cd.detectChanges();
      this.partitions = await this.ffsManagerService.readPartitionTable(this.currentPort, baudRate);
      this.selectedPartition = this.filesystemPartitions[0] || this.partitions[0] || null;
      this.resetFilesystemState();
      this.statusText = this.partitions.length
        ? this.t('STATUS.PARTITIONS_READ', {
          total: this.partitions.length,
          filesystem: this.filesystemPartitions.length,
        })
        : this.t('STATUS.NO_PARTITION_TABLE');
    } catch (error) {
      if (this.aborting) {
        this.errorText = '';
        this.statusText = this.t('STATUS.CANCELLED');
      } else {
        this.errorText = this.formatError(error);
        this.statusText = this.t('STATUS.READ_FAILED');
        this.message.error(this.errorText);
      }
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }

    if (!this.errorText && !this.aborting && this.selectedPartition?.filesystemType) {
      await this.loadFilesystemContent();
    }
  }

  async switchConnection() {
    if (this.switchValue) {
      if (!this.currentPort) {
        this.message.warning(this.t('STATUS.SELECT_PORT_FIRST'));
        this.switchValue = false;
        return;
      }
      // 让 serial-monitor 等其他工具先释放同一串口，避免 Windows 上 EACCES。
      this.uiService.sendToolSignal('serial-monitor:disconnect', { port: this.currentPort, portType: 'serial', source: this.selfSignalTag });
      // 给被通知方一点时间真正关闭句柄
      await new Promise(resolve => setTimeout(resolve, 200));

      await this.refreshAll();
      // 任何步骤失败则把开关复位为关
      if (this.errorText || !this.deviceInfo) {
        this.switchValue = false;
        try {
          await this.ffsManagerService.release(true);
        } catch { }
        // 释放失败/连接失败后，把串口让回给 serial-monitor
        this.uiService.sendToolSignal('serial-monitor:connect', { port: this.currentPort, portType: 'serial', source: this.selfSignalTag });
      }
      this.cd.detectChanges();
    } else {
      const releasedPort = this.currentPort;
      const wasBusy = this.busy;
      this.aborting = wasBusy;
      if (wasBusy) {
        this.statusText = this.t('STATUS.CANCELLING');
        this.filesystemStatusText = this.t('STATUS.CANCELLING');
        this.cd.detectChanges();
      }
      try {
        // 关键：手动关闭不做 hard_reset。
        // ESP32-S3 USB-CDC 经 DTR/RTS 复位会触发 USB 重枚举，
        // 旧 HANDLE 失效，随后 transport.disconnect/port.dispose 在
        // 失效句柄上 CloseHandle 可能未真正释放，导致 Windows 仍把 COM
        // 视为占用，后续 esptool 报 "port is busy"。
        // 用户手动关闭只为释放串口；如需复位芯片，esptool 启动时会自行 DTR/RTS。
        await this.ffsManagerService.release(false);
      } catch (error) {
        console.warn('[FfsManager] 断开 ESP 会话失败:', error);
      }
      this.deviceInfo = null;
      this.partitions = [];
      this.selectedPartition = null;
      this.resetFilesystemState();
      this.statusText = wasBusy ? this.t('STATUS.CANCELLED') : this.t('STATUS.DISCONNECTED');
      if (releasedPort) {
        // 进一步保险：等 OS 真正放掉独占句柄再放行后续工具。
        await this.waitForPortReady(releasedPort, 3000).catch(() => { /* ignore */ });
        this.uiService.sendToolSignal('serial-monitor:connect', { port: releasedPort, portType: 'serial', source: this.selfSignalTag });
      }
      this.aborting = false;
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async selectPartition(partition: FfsPartitionInfo) {
    if (this.selectedPartition?.index === partition.index) return;
    if (this.filesystemDirty && !(await this.confirmDialog(
      this.t('DIALOGS.SWITCH_PARTITION_TITLE'),
      this.t('DIALOGS.SWITCH_PARTITION_CONTENT')
    ))) {
      return;
    }
    this.selectedPartition = partition;
    this.resetFilesystemState();
  }

  async loadFilesystemContent() {
    const partition = this.selectedPartition;
    if (!partition?.filesystemType || !this.currentPort) return;

    this.busy = true;
    this.errorText = '';
    const partitionName = this.getPartitionDisplayName(partition);
    this.filesystemStatusText = this.t('STATUS.READING_FILESYSTEM', { partition: partitionName });
    try {
      const readPrefix = this.t('STATUS.READING_FILESYSTEM_PROGRESS', { partition: partitionName });
      this.resetProgressThrottle();
      const image = await this.ffsManagerService.readPartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        (received, total) => this.reportProgress(readPrefix, received, total, 'filesystem')
      );
      this.filesystemSession = await this.ffsFilesystemContentService.mountPartition(partition, image);
      this.filesystemFiles = this.filesystemSession.files;
      this.filesystemUsage = this.filesystemSession.usage;
      this.filesystemDirty = false;
      this.selectedFile = null;
      this.filesystemStatusText = this.t('STATUS.FILESYSTEM_ENTRIES_READ', { count: this.filesystemFiles.length });
      this.message.success(this.t('MESSAGES.FILESYSTEM_CONTENT_READ'));
    } catch (error) {
      if (this.aborting) {
        this.errorText = '';
        this.filesystemStatusText = this.t('STATUS.CANCELLED');
      } else {
        this.errorText = this.formatError(error);
        this.filesystemStatusText = this.t('STATUS.FILESYSTEM_READ_FAILED');
        this.message.error(this.errorText);
      }
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async uploadFileToFilesystem(file: File) {
    const session = this.filesystemSession;
    if (!file || !session) return;

    const targetPath = this.ffsFilesystemContentService.getDefaultUploadPath(file.name, session.type);
    if (!targetPath || !targetPath.trim()) return;
    const fileNameError = this.ffsFilesystemContentService.validateUploadFileName(file.name, session.type);
    if (fileNameError) {
      this.errorText = fileNameError;
      this.filesystemStatusText = this.t('STATUS.UPLOAD_FAILED_NAME_TOO_LONG');
      this.message.warning(fileNameError);
      return;
    }

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.UPLOADING_FILE', { name: file.name });
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await this.ffsFilesystemContentService.writeFile(session, targetPath, data);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = this.t('STATUS.FILE_ADDED_PENDING', { name: file.name });
      this.message.success(this.t('MESSAGES.FILE_UPLOADED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.UPLOAD_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async downloadFilesystemFile(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session || entry.type !== 'file') return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.DOWNLOADING_FILE', { path: entry.path });
    try {
      const data = await this.ffsFilesystemContentService.readFile(session, entry.path);
      const saved = await this.saveBinaryFile(entry.name, data, this.t('DIALOGS.SAVE_FILE_TITLE'));
      this.filesystemStatusText = saved
        ? this.t('STATUS.FILE_DOWNLOADED', { path: entry.path })
        : this.t('STATUS.DOWNLOAD_CANCELLED');
      if (saved) {
        this.message.success(this.t('MESSAGES.FILE_DOWNLOADED'));
      }
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.DOWNLOAD_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async viewFilesystemFile(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session || entry.type !== 'file') return;

    const mode = this.getPreviewMode(entry.name);
    if (!mode) {
      this.message.warning(this.t('STATUS.PREVIEW_UNSUPPORTED'));
      return;
    }

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.READING_FILE', { path: entry.path });
    let audioUrl: string | null = null;
    try {
      const data = await this.ffsFilesystemContentService.readFile(session, entry.path);
      const sizeText = this.formatBytes(data.byteLength);
      this.filesystemStatusText = this.t('STATUS.FILE_READ', { path: entry.path, size: sizeText });

      if (mode === 'text') {
        this.modal.create<FileTextViewerComponent, FileTextViewerData>({
          nzTitle: null,
          nzFooter: null,
          nzClosable: false,
          nzWidth: '760px',
          nzBodyStyle: { padding: '0', background: 'var(--aily-bg-primary)' },
          nzContent: FileTextViewerComponent,
          nzData: { name: entry.name, data },
        });
      } else if (mode === 'image') {
        this.modal.create<FileImageViewerComponent, FileImageViewerData>({
          nzTitle: null,
          nzFooter: null,
          nzClosable: false,
          nzWidth: '80vw',
          nzBodyStyle: { padding: '0', background: '#1e1e1e' },
          nzContent: FileImageViewerComponent,
          nzData: { name: entry.name, data },
        });
      } else if (mode === 'audio') {
        const ext = entry.name.split('.').pop()?.toLowerCase() || '';
        const mime = ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`;
        audioUrl = URL.createObjectURL(new Blob([this.toBlobPart(data)], { type: mime }));
        const bodyHtml = `<div style="display:flex;align-items:center;justify-content:center;padding:16px;"><audio controls autoplay src="${audioUrl}" style="width:100%;"></audio></div>`;
        const ref = this.modal.create({
          nzTitle: `${entry.name} · ${sizeText}`,
          nzWidth: 560,
          nzFooter: null,
          nzBodyStyle: { background: 'var(--aily-bg-primary)' },
          nzContent: bodyHtml,
        });
        ref.afterClose.subscribe(() => URL.revokeObjectURL(audioUrl!));
      }
    } catch (error) {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.FILE_READ_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  private getPreviewMode(name: string): 'text' | 'image' | 'audio' | null {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
    if (['txt', 'log', 'md', 'cfg', 'ini', 'conf', 'json', 'yaml', 'yml', 'xml', 'toml',
         'js', 'ts', 'py', 'c', 'cpp', 'h', 'hpp', 'sh', 'csv', 'html', 'htm', 'css'].includes(ext)) return 'text';
    return null;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  async deleteFilesystemEntry(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.DELETING_ENTRY', { path: entry.path });
    try {
      await this.ffsFilesystemContentService.deleteEntry(session, entry);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = this.t('STATUS.ENTRY_DELETED_PENDING', { path: entry.path });
      this.message.success(this.t('MESSAGES.ENTRY_DELETED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.DELETE_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async renameFilesystemEntry(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session) return;

    const nextPath = await this.promptDialog(
      this.t('DIALOGS.RENAME_TITLE'),
      entry.path,
      this.t('DIALOGS.NEW_PATH_PLACEHOLDER')
    );
    if (nextPath === null || nextPath.trim() === entry.path) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.RENAMING_ENTRY', { path: entry.path });
    try {
      await this.ffsFilesystemContentService.renameEntry(session, entry, nextPath);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = this.t('STATUS.ENTRY_RENAMED_PENDING', { path: entry.path });
      this.message.success(this.t('MESSAGES.ENTRY_RENAMED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.RENAME_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async createFilesystemDirectory(basePath: string = '/') {
    const session = this.filesystemSession;
    if (!session) return;

    const base = basePath && basePath.startsWith('/') ? basePath : '/';
    const defaultPath = (base === '/' ? '' : base.replace(/\/$/, '')) + '/new_folder';
    const path = await this.promptDialog(this.t('DIALOGS.NEW_FOLDER_TITLE'), defaultPath, '/path/to/dir');
    if (path === null || !path.trim()) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.CREATING_DIRECTORY', { path });
    try {
      await this.ffsFilesystemContentService.mkdir(session, path);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = this.t('STATUS.DIRECTORY_CREATED_PENDING', { path });
      this.message.success(this.t('MESSAGES.DIRECTORY_CREATED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.CREATE_DIRECTORY_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async formatFilesystemContent() {
    const session = this.filesystemSession;
    if (!session) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.FORMATTING_IMAGE');
    try {
      await this.ffsFilesystemContentService.format(session);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = this.t('STATUS.IMAGE_FORMATTED_PENDING');
      this.message.success(this.t('MESSAGES.IMAGE_FORMATTED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.FORMAT_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async saveFilesystemContent() {
    const session = this.filesystemSession;
    const partition = this.selectedPartition;
    if (!session || !partition || !this.currentPort) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = this.t('STATUS.EXPORTING_AND_WRITING');
    try {
      const image = await this.ffsFilesystemContentService.toImage(session);
      if (image.length !== partition.size) {
        throw new Error(this.t('ERRORS.IMAGE_SIZE_MISMATCH', {
          imageSize: this.ffsFilesystemContentService.formatBytes(image.length),
          partitionSize: partition.sizeText,
        }));
      }
      this.resetProgressThrottle();
      await this.ffsManagerService.writePartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        image,
        (written, total) => this.reportProgress(this.t('STATUS.WRITING_FILESYSTEM_IMAGE'), written, total, 'filesystem')
      );
      session.image = image;
      this.filesystemDirty = false;
      this.filesystemStatusText = this.t('STATUS.CONTENT_WRITTEN');
      this.message.success(this.t('MESSAGES.CONTENT_WRITTEN'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = this.t('STATUS.WRITE_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  selectFilesystemFile(entry: FfsFileEntry) {
    this.selectedFile = entry;
  }

  async downloadSelectedPartition() {
    const partition = this.selectedPartition;
    if (!partition || !partition.filesystemType || !this.currentPort) return;

    this.busy = true;
    const exportPrefix = this.t('STATUS.EXPORTING_PARTITION', {
      partition: this.getPartitionDisplayName(partition),
    });
    this.statusText = `${exportPrefix}...`;
    this.resetProgressThrottle();
    try {
      const data = await this.ffsManagerService.readPartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        (received, total) => this.reportProgress(exportPrefix, received, total, 'status')
      );
      const saved = await this.saveBinaryFile(
        this.ffsManagerService.buildPartitionFileName(partition),
        data,
        this.t('DIALOGS.SAVE_PARTITION_IMAGE_TITLE'),
        [{ name: this.t('FILTERS.BINARY_IMAGE'), extensions: ['bin'] }]
      );
      this.statusText = saved ? this.t('STATUS.PARTITION_EXPORTED') : this.t('STATUS.EXPORT_CANCELLED');
      if (saved) {
        this.message.success(this.t('MESSAGES.PARTITION_EXPORTED'));
      }
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = this.t('STATUS.EXPORT_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async restoreSelectedPartition(file: File) {
    const partition = this.selectedPartition;
    if (!file || !partition || !this.currentPort) return;

    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length !== partition.size) {
      this.message.warning(this.t('MESSAGES.IMAGE_SIZE_MUST_EQUAL', { size: partition.sizeText }));
      return;
    }

    if (!(await this.confirmDialog(
      this.t('DIALOGS.RESTORE_IMAGE_TITLE'),
      this.t('DIALOGS.RESTORE_IMAGE_CONTENT', {
        name: file.name,
        partition: this.getPartitionDisplayName(partition),
      })
    ))) {
      return;
    }

    this.busy = true;
    const restorePrefix = this.t('STATUS.RESTORING_PARTITION', {
      partition: this.getPartitionDisplayName(partition),
    });
    this.statusText = `${restorePrefix}...`;
    this.resetProgressThrottle();
    try {
      await this.ffsManagerService.writePartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        data,
        (written, total) => this.reportProgress(restorePrefix, written, total, 'status')
      );
      this.statusText = this.t('STATUS.PARTITION_WRITTEN');
      this.message.success(this.t('MESSAGES.PARTITION_WRITTEN'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = this.t('STATUS.RESTORE_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async eraseSelectedPartition() {
    const partition = this.selectedPartition;
    if (!partition || !partition.filesystemType || !this.currentPort) return;
    if (!(await this.confirmDialog(
      this.t('DIALOGS.ERASE_PARTITION_TITLE'),
      this.t('DIALOGS.ERASE_PARTITION_CONTENT', {
        partition: this.getPartitionDisplayName(partition),
      })
    ))) {
      return;
    }

    this.busy = true;
    this.statusText = this.t('STATUS.ERASING_PARTITION', {
      partition: this.getPartitionDisplayName(partition),
    });
    try {
      await this.ffsManagerService.erasePartition(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition
      );
      this.statusText = this.t('STATUS.PARTITION_ERASED');
      this.message.success(this.t('MESSAGES.PARTITION_ERASED'));
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = this.t('STATUS.ERASE_FAILED');
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  openPortList(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList() {
    const ports = await this.serialService.getSerialPorts();
    this.portList = ports?.length ? ports : [{
      name: this.t('NO_DEVICE_FOUND'),
      text: '',
      type: 'serial',
      icon: 'fa-light fa-triangle-exclamation',
      disabled: true,
    }];
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem: PortItem) {
    if (!portItem.name) return;
    if (this.switchValue && this.currentPort !== portItem.name) {
      // 切换串口时先断开旧会话
      this.switchValue = false;
      this.ffsManagerService.release(true).catch(() => { });
      this.deviceInfo = null;
      this.partitions = [];
      this.selectedPartition = null;
      this.resetFilesystemState();
    }
    this.currentPort = portItem.name;
    this.serialService.currentPort = portItem.name;
    this.serialService.currentPortInfo = portItem;
    this.closePortList();
  }

  openBaudList(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.showBaudList = !this.showBaudList;
  }

  closeBaudList() {
    this.showBaudList = false;
    this.cd.detectChanges();
  }

  selectBaud(item: { name?: string; value?: number }) {
    this.currentBaudRate = String(item.value || item.name || this.currentBaudRate);
    this.closeBaudList();
  }

  getFsLabel(type: FfsFilesystemType | null): string {
    if (type === 'spiffs') return 'SPIFFS';
    if (type === 'littlefs') return 'LittleFS';
    if (type === 'fatfs') return 'FATFS';
    return this.t('COMMON.NORMAL_PARTITION');
  }

  getPartitionWidth(partition: FfsPartitionInfo): number {
    const total = this.partitions.reduce((sum, item) => sum + item.size, 0);
    if (!total) return 0;
    return Math.max(2, partition.size / total * 100);
  }

  private async checkEsptool(clearCache = false) {
    const packageInfo = await this.ffsManagerService.detectEsptool(clearCache);
    this.esptoolReady = Boolean(packageInfo?.esptoolPath);
    this.cd.detectChanges();
  }

  private async checkAndSetDefaultPort() {
    if (this.currentPort) return;
    try {
      const ports = await this.serialService.getSerialPorts();
      if (ports?.length === 1 && ports[0].name) {
        this.currentPort = ports[0].name;
        this.serialService.currentPort = ports[0].name;
        this.serialService.currentPortInfo = ports[0];
        this.cd.detectChanges();
      }
    } catch (error) {
      console.warn('[FfsManager] 获取串口列表失败:', error);
    }
  }

  private async refreshFilesystemSession(dirty: boolean) {
    if (!this.filesystemSession) return;
    this.filesystemFiles = await this.ffsFilesystemContentService.listFiles(this.filesystemSession);
    this.filesystemUsage = await this.ffsFilesystemContentService.getUsage(this.filesystemSession);
    this.filesystemSession.files = this.filesystemFiles;
    this.filesystemSession.usage = this.filesystemUsage;
    this.filesystemDirty = dirty;
    this.selectedFile = null;
  }

  private getSelectedBaudRate(): number {
    return Number(this.currentBaudRate) || this.defaultBaudRate;
  }

  private resetFilesystemState() {
    this.filesystemSession = null;
    this.filesystemFiles = [];
    this.selectedFile = null;
    this.filesystemUsage = null;
    this.filesystemDirty = false;
    this.filesystemStatusText = this.t('STATUS.FILESYSTEM_READY_HINT');
  }

  private async saveBinaryFile(
    fileName: string,
    data: Uint8Array,
    title = this.t('DIALOGS.SAVE_PARTITION_IMAGE_TITLE'),
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<boolean> {
    if (window['ipcRenderer'] && window['fs']) {
      const saveOptions: any = {
        suggestedName: fileName,
        title,
      };
      if (filters) {
        saveOptions.filters = filters;
      }
      const filePath = await window['ipcRenderer'].invoke('select-folder-saveAs', saveOptions);
      if (!filePath) {
        return false;
      }
      window['fs'].writeFileSync(filePath, data);
      return true;
    }

    const blob = new Blob([this.toBlobPart(data)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  private resetProgressThrottle() {
    this.progressLastTs = 0;
    this.progressLastPercent = -1;
  }

  private reportProgress(prefix: string, done: number, total: number, target: 'status' | 'filesystem') {
    if (!total || total <= 0) return;
    const clamped = Math.min(done, total);
    const percent = Math.floor((clamped / total) * 100);
    const now = Date.now();
    const finished = clamped >= total;
    if (!finished && percent === this.progressLastPercent && now - this.progressLastTs < 150) {
      return;
    }
    this.progressLastPercent = percent;
    this.progressLastTs = now;
    const text = `${prefix} ${percent}%, ${this.ffsFilesystemContentService.formatBytes(clamped)} / ${this.ffsFilesystemContentService.formatBytes(total)}`;
    if (target === 'status') {
      this.statusText = text;
    } else {
      this.filesystemStatusText = text;
    }
    this.cd.detectChanges();
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || this.t('COMMON.UNKNOWN_ERROR'));
  }

  private toBlobPart(data: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }

  private confirmDialog(title: string, content?: string): Promise<boolean> {
    return new Promise(resolve => {
      this.modal.confirm({
        nzTitle: title,
        nzContent: content,
        nzOkText: this.t('COMMON.CONFIRM'),
        nzCancelText: this.t('COMMON.CANCEL'),
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzOnOk: () => resolve(true),
        nzOnCancel: () => resolve(false),
      });
    });
  }

  private promptDialog(title: string, defaultValue = '', placeholder = ''): Promise<string | null> {
    return new Promise(resolve => {
      let value = defaultValue;
      const ref = this.modal.create({
        nzTitle: title,
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzContent: `<input id="ffs-prompt-input" class="ant-input" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(defaultValue)}" style="width:100%" />`,
        nzOkText: this.t('COMMON.CONFIRM'),
        nzCancelText: this.t('COMMON.CANCEL'),
        nzOnOk: () => resolve(value),
        nzOnCancel: () => resolve(null),
      });
      ref.afterOpen.subscribe(() => {
        const input = document.getElementById('ffs-prompt-input') as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.select();
          input.addEventListener('input', () => { value = input.value; });
          input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              value = input.value;
              ref.triggerOk();
            }
          });
        }
      });
    });
  }

  private escapeHtml(text: string): string {
    return String(text ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    } as Record<string, string>)[c]);
  }

  private getPartitionDisplayName(partition: FfsPartitionInfo): string {
    return partition.label || partition.offsetHex;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(`FFS_MANAGER.${key}`, params);
  }
}
