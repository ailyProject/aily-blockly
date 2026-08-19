import { Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { ActionState, UiService } from '../../../services/ui.service';
import { FOOTER_BTNS, IMenuItem } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import {
  ApplicationUpdateStatus,
  UpdateService,
} from '../../../services/update.service';

@Component({
  selector: 'app-footer',
  imports: [NzToolTipModule, TranslateModule],
  templateUrl: './footer.component.html',
  styleUrl: './footer.component.scss'
})
export class FooterComponent implements OnDestroy {
  actionData: ActionState | null;
  timer;

  updateStatus: ApplicationUpdateStatus = '';
  updateProgress = 0;
  updateVersion = '';

  private readonly subscriptions = new Subscription();

  FOOTER_BTNS = FOOTER_BTNS;

  constructor(
    private uiService: UiService,
    private cd: ChangeDetectorRef,
    private updateService: UpdateService,
    private translate: TranslateService,
  ) {
    this.subscriptions.add(this.uiService.stateSubject.subscribe((state: ActionState) => {
      this.changeState(state);
    }));
    this.subscriptions.add(this.updateService.updateStatus.subscribe((status) => {
      this.updateStatus = status;
      this.cd.markForCheck();
    }));
    this.subscriptions.add(this.updateService.updateProgress.subscribe((progress) => {
      this.updateProgress = Math.max(0, Math.min(100, Math.floor(progress || 0)));
      this.cd.markForCheck();
    }));
    this.subscriptions.add(this.updateService.activeUpdateInfo.subscribe((info) => {
      this.updateVersion = info?.version || '';
      this.cd.markForCheck();
    }));
    // 其他窗口通过electron侧改变主窗口状态
    window['ipcRenderer']?.on?.('state-update', (event, state: ActionState) => {
      this.changeState(state);
    });
  }

  changeState(e: ActionState) {
    this.actionData = e;
    this.cd.detectChanges();
    // 默认超时设置10秒, warn 和 error 不超时 
    if (!this.actionData.timeout && this.actionData.state === 'loading' || this.actionData.state === 'done') {
      this.actionData.timeout = 10000;
    }
    if (this.actionData.timeout) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.actionData = null;
        this.cd.detectChanges();
      }, this.actionData.timeout);
    }
  }

  async process(item: IMenuItem) {
    switch (item.action) {
      case 'log-open':
        this.uiService.turnBottomSider('log');
        break;
      case 'terminal-open':
        this.uiService.turnBottomSider('terminal');
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  isButtonActive(item: IMenuItem): boolean {
    switch (item.action) {
      case 'log-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'log';
      case 'terminal-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'terminal';
      default:
        return false;
    }
  }

  get showUpdateIndicator(): boolean {
    return !!this.updateVersion && [
      'available',
      'downloading',
      'downloaded',
      'preparing-install',
      'error',
    ].includes(this.updateStatus);
  }

  get updateIndicatorTooltip(): string {
    const params = {
      version: this.updateVersion,
      progress: this.updateProgress,
    };
    switch (this.updateStatus) {
      case 'downloading':
        return this.translate.instant('UPDATE_DIALOG.DOWNLOADING_TOOLTIP', params);
      case 'downloaded':
        return this.translate.instant('UPDATE_DIALOG.UPDATE_READY_TOOLTIP', params);
      case 'preparing-install':
        return this.translate.instant('UPDATE_DIALOG.PREPARING_TOOLTIP', params);
      case 'error':
        return this.translate.instant('UPDATE_DIALOG.DOWNLOAD_ERROR_TOOLTIP', params);
      default:
        return this.translate.instant('UPDATE_DIALOG.UPDATE_AVAILABLE_TOOLTIP', params);
    }
  }

  get updateProgressOffset(): number {
    return 65.97 * (1 - this.updateProgress / 100);
  }

  openUpdateDialog(event?: MouseEvent): void {
    if ((event?.detail || 0) > 0) {
      (event?.currentTarget as HTMLElement | null)?.blur?.();
    }
    this.updateService.openUpdateDialog();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    clearTimeout(this.timer);
  }
}
