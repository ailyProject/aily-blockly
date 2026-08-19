import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ElectronService } from './electron.service';
// import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { UpdateDialogComponent } from '../main-window/components/update-dialog/update-dialog.component';
import { version } from '../../../package.json';
import { ConfigService } from './config.service';
import { ProjectService } from './project.service';
import { UiService } from './ui.service';
import { ChildAppHostRegistryService } from './child-app-host-registry.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateService } from '@ngx-translate/core';
import { ChildAppSafetyService } from './child-app-safety.service';

export interface ApplicationUpdatePreparationResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

export type ApplicationUpdatePreparationHook = () =>
  | ApplicationUpdatePreparationResult
  | Promise<ApplicationUpdatePreparationResult>;

export type ApplicationUpdateStatus =
  | ''
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'preparing-install'
  | 'error';

export interface ApplicationUpdateInfo {
  version: string;
  [key: string]: unknown;
}

const APPLICATION_UPDATE_STATUS_TRANSITIONS: Record<
  Exclude<ApplicationUpdateStatus, ''>,
  ApplicationUpdateStatus
> = {
  checking: 'checking',
  available: 'available',
  'not-available': 'not-available',
  downloading: 'downloading',
  downloaded: 'downloaded',
  'preparing-install': 'preparing-install',
  error: 'error',
};

@Injectable({
  providedIn: 'root',
})
export class UpdateService {

  currentVersion = version;

  updateProgress = new BehaviorSubject<number>(0);

  updateStatus = new BehaviorSubject<ApplicationUpdateStatus>('');

  downloadSourceStatus = new BehaviorSubject<any>(null);

  activeUpdateInfo = new BehaviorSubject<ApplicationUpdateInfo | null>(null);

  // private updateInfo: any = null;
  private ailyBuilderUpdateDialogOpen = false;
  private installTask: Promise<boolean> | null = null;
  private updateDialogRef: NzModalRef | null = null;

  constructor(
    private electronService: ElectronService,
    // private message: NzMessageService,
    private modal: NzModalService,
    private configService: ConfigService,
    private projectService: ProjectService,
    private uiService: UiService,
    private childHostRegistry: ChildAppHostRegistryService,
    private message: NzMessageService,
    private translate: TranslateService,
    private childAppSafety: ChildAppSafetyService,
  ) { }

  init() {
    if (!this.electronService.isElectron) {
      return;
    }

    // 监听更新状态
    window['updater'].onUpdateStatus((status) => {
      // console.log('更新状态:', status);
      switch (status.status) {
        case 'checking':
          this.updateStatus.next('checking');
          break;

        case 'available':
          // 检查是否已经跳过此版本
          const skippedVersions = this.getSkippedVersions();
          if (skippedVersions.includes(status.info.version)) {
            // console.log(`已跳过版本 ${status.info.version}，不再提示`);
            this.activeUpdateInfo.next(null);
            this.updateStatus.next('not-available');
            break;
          }
          this.activeUpdateInfo.next(status.info);
          // 判断是否已下载，如果已下载则直接显示安装对话框
          if (status.info.isDownloaded) {
            this.updateProgress.next(100);
            this.updateStatus.next('downloaded');
            this.openUpdateDialog(status.info, true);
          } else {
            this.updateStatus.next('available');
            this.openUpdateDialog(status.info, false);
          }
          break;

        case 'not-available':
          this.activeUpdateInfo.next(null);
          this.updateStatus.next('not-available');
          break;

        case 'error':
          this.updateStatus.next('error');
          console.error('更新错误:', status.error);
          break;

        case 'mirror-switching':
          this.updateProgress.next(0);
          this.downloadSourceStatus.next({
            current: status.index + 1,
            total: status.total,
          });
          this.updateStatus.next('downloading');
          break;

        case 'progress':
          this.updateProgress.next(status.progress.percent || 0);
          this.updateStatus.next('downloading');
          break;

        case 'downloaded':
          if (status.info?.version) {
            this.activeUpdateInfo.next(status.info);
          }
          this.updateProgress.next(100);
          this.updateStatus.next('downloaded');
          break;
      }
    });
    // 应用启动时检查更新
    setTimeout(() => {
      this.checkForUpdates(false);
    }, 5000);
    setTimeout(() => {
      this.checkPackageUpdates(false);
    }, 3000);
  }

  /** Development-only helper for exercising update UI without contacting an updater server. */
  simulateUpdate(
    status: Exclude<ApplicationUpdateStatus, ''> = 'available',
    versionNumber = '0.9.92',
    progress = status === 'downloaded' || status === 'preparing-install' ? 100 : 0,
  ): void {
    const normalizedVersion = String(versionNumber || '').trim() || '0.9.92';
    this.activeUpdateInfo.next({ version: normalizedVersion });
    this.updateProgress.next(Math.max(0, Math.min(100, progress)));
    this.updateStatus.next(APPLICATION_UPDATE_STATUS_TRANSITIONS[status]);
    this.openUpdateDialog();
  }

  checkForUpdates(manual: boolean = false) {
    if (this.electronService.isElectron) {
      window['updater'].checkForUpdates();
      this.checkPackageUpdates(manual);
    }
  }

  downloadUpdate() {
    this.updateProgress.next(0);
    this.downloadSourceStatus.next(null);
    this.updateStatus.next('downloading');
    window['updater'].downloadUpdate();
  }

  cancelDownload() {
    if (window['updater'].cancelDownload) {
      window['updater'].cancelDownload();
    }
    this.updateProgress.next(0);
    this.downloadSourceStatus.next(null);
    this.updateStatus.next(this.activeUpdateInfo.value ? 'available' : '');
  }

  quitAndInstall() {
    window['updater'].quitAndInstall();
  }

  registerInstallPreparationHook(id: string, hook: ApplicationUpdatePreparationHook): () => void {
    return this.childAppSafety.registerPreparationHook(id, hook);
  }

  prepareAndInstall(): Promise<boolean> {
    if (this.installTask) {
      return this.installTask;
    }

    const task = this.runInstallPreparation();
    this.installTask = task;
    void task.finally(() => {
      if (this.installTask === task) {
        this.installTask = null;
      }
    });
    return task;
  }

  private async runInstallPreparation(): Promise<boolean> {
    const activeChildAppIds = this.childAppSafety.collectActiveChildAppIds(
      this.uiService.openWindowPathList,
    );
    if (activeChildAppIds.length > 0) {
      const confirmed = await this.childAppSafety.confirmInterruption(
        'application-update',
        activeChildAppIds,
      );
      if (!confirmed) {
        return false;
      }
    }

    this.updateStatus.next('preparing-install');

    try {
      const embeddedPreparation = await this.childHostRegistry.prepareAllForApplicationUpdate();
      if (!embeddedPreparation.ok) {
        throw new Error(this.firstPreparationError(embeddedPreparation.results));
      }

      await this.prepareStandaloneChildApps();

      await this.childAppSafety.prepareRegisteredWork();

      if (this.projectService.currentProjectPath) {
        const saveResult = await this.projectService.save(this.projectService.currentProjectPath, 15_000);
        if (!saveResult.success) {
          throw new Error(saveResult.error || this.translate.instant('UPDATE_DIALOG.SAVE_FAILED'));
        }
      }

      await this.configService.save();
      this.quitAndInstall();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[Updater] Install preparation failed:', error);
      this.updateStatus.next('downloaded');
      this.message.error(
        this.translate.instant('UPDATE_DIALOG.PREPARATION_FAILED', { detail }),
        { nzDuration: 6000 },
      );
      return false;
    }
  }

  private async prepareStandaloneChildApps(): Promise<void> {
    for (const routePath of [...this.uiService.openWindowPathList]) {
      const toolId = this.childToolIdFromRoute(routePath);
      if (!toolId) {
        continue;
      }
      const command = window['subWindow']?.command;
      if (typeof command !== 'function') {
        throw new Error(`无法确认子应用 ${toolId} 的升级前保存状态`);
      }
      const result = await command(routePath, {
        toolId,
        action: 'prepareUpdate',
        strictLifecycle: true,
      });
      if (result?.ok !== true) {
        throw new Error(result.message || `子应用 ${toolId} 未完成升级前保存`);
      }
    }
  }

  private childToolIdFromRoute(routePath: string): string {
    const match = String(routePath || '').match(/^\/?child-tool\/([^/?#]+)/);
    if (!match?.[1]) {
      return '';
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private firstPreparationError(results: Array<Record<string, unknown>>): string {
    const failed = results.find(result => result['ok'] === false);
    return typeof failed?.['message'] === 'string' && failed['message'].trim()
      ? failed['message'].trim()
      : this.translate.instant('UPDATE_DIALOG.SESSION_SAVE_FAILED');
  }

  skipVersion(version: string) {
    if (!version) return;
    const skippedVersions = this.getSkippedVersions();
    if (!skippedVersions.includes(version)) {
      skippedVersions.push(version);
      this.configService.data.skippedVersions = skippedVersions;
      this.configService.save();
      // console.log(`已将版本 ${version} 添加到跳过列表`);
    }
    if (this.activeUpdateInfo.value?.version === version) {
      this.activeUpdateInfo.next(null);
      this.updateProgress.next(0);
      this.downloadSourceStatus.next(null);
      this.updateStatus.next('not-available');
    }
  }

  private getSkippedVersions(): string[] {
    return this.configService.data?.skippedVersions || [];
  }

  clearSkipVersions() {
    this.configService.data.skippedVersions = [];
    this.configService.save();
  }

  get hasOpenProject(): boolean {
    return !!this.projectService.currentProjectPath;
  }

  private async checkPackageUpdates(showOptional: boolean) {
    if (!window['builder']?.status || !window['builder']?.update) {
      return;
    }

    try {
      const status = await window['builder'].status();
      const needsInstall = status && !status.error && !status.installed;
      if (!needsInstall || this.ailyBuilderUpdateDialogOpen) {
        return;
      }
      if (!showOptional) {
        return;
      }

      this.ailyBuilderUpdateDialogOpen = true;
      const builderLabel = status.packageName || status.key || 'aily-builder';
      const modalRef = this.modal.confirm({
        nzTitle: `安装 ${builderLabel}`,
        nzContent: `${builderLabel} 尚未安装，是否现在安装最新版本？`,
        nzOkText: '安装',
        nzCancelText: '稍后',
        nzMaskClosable: false,
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzOnOk: async () => {
          await window['builder'].update();
        }
      });
      modalRef.afterClose.subscribe(() => {
        this.ailyBuilderUpdateDialogOpen = false;
      });
    } catch (error) {
      console.error('检查 aily-builder 更新失败:', error);
      this.ailyBuilderUpdateDialogOpen = false;
    }
  }

  openUpdateDialog(
    info: ApplicationUpdateInfo | null = this.activeUpdateInfo.value,
    isDownloaded: boolean = false,
  ): void {
    if (!info || this.updateDialogRef) {
      return;
    }

    this.activeUpdateInfo.next(info);
    const currentStatus = this.updateStatus.value;
    const resumableStatuses: ApplicationUpdateStatus[] = [
      'available',
      'downloading',
      'downloaded',
      'preparing-install',
      'error',
    ];
    const mode = isDownloaded
      ? 'downloaded'
      : resumableStatuses.includes(currentStatus)
        ? currentStatus
        : 'available';

    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '500px',
      nzContent: UpdateDialogComponent,
      nzData: {
        mode: mode,
        progress: 0,
        version: info.version,
        currentVersion: this.currentVersion,
      },
      nzMaskClosable: false,
    });
    this.updateDialogRef = modalRef;

    modalRef.afterClose.subscribe(async result => {
      if (this.updateDialogRef === modalRef) {
        this.updateDialogRef = null;
      }
      switch (result) {
        case 'skip':
          // 跳过版本
          this.skipVersion(info.version);
          break;
        case 'install':
          // 安装更新
          await this.prepareAndInstall();
          break;
        case 'download_stop':
          // 取消下载
          this.cancelDownload();
          break;
        default:
          // 弹窗收起后，下载和状态监听继续在后台运行。
          break;
      }
    });
  }
}
