import { Component, Inject, OnInit, OnDestroy, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Observable, Subscription } from 'rxjs';
import { UpdateService } from '@core/app-shell/public-api';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';
import { ConfigService } from '@core/preferences/public-api';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';

@Component({
  selector: 'app-update-dialog',
  imports: [CommonModule, NzProgressModule, NzIconModule, TranslateModule, BaseDialogComponent],
  templateUrl: './update-dialog.component.html',
  styleUrls: ['./update-dialog.component.scss']
})
export class UpdateDialogComponent implements OnInit, OnDestroy {
  title: string;
  text: string;
  mode: string;
  progress: number = 0;
  version: string;
  currentVersion: string;
  downloadSourceStatus: any = null;

  @ViewChild('markdown', { static: false }) markdownEl: ElementRef<HTMLDivElement>;

  constructor(
    @Inject(NZ_MODAL_DATA) public data: any,
    private modal: NzModalRef,
    private updateService: UpdateService,
    private cd: ChangeDetectorRef,
    private configService: ConfigService,
    private http: HttpClient,
    private translate: TranslateService
  ) {
    this.version = data.version || '';
    this.currentVersion = data.currentVersion || '';
    this.mode = data.mode || 'available';
    this.updateTitleAndText();
  }

  private updateTitleAndText() {
    const params = { version: this.version, currentVersion: this.currentVersion };
    if (this.mode === 'downloaded') {
      this.title = this.translate.instant('UPDATE_DIALOG.TITLE_READY');
      this.text = this.translate.instant('UPDATE_DIALOG.TEXT_DOWNLOADED', params);
    } else {
      this.title = this.translate.instant('UPDATE_DIALOG.TITLE_NEW_VERSION', params);
      this.text = this.translate.instant('UPDATE_DIALOG.TEXT_AVAILABLE', params);
    }
  }

  updateStatusSubscription: Subscription;
  updateProgressSubscription: Subscription;
  downloadSourceStatusSubscription: Subscription;

  ngOnInit() {
    // 订阅更新状态
    this.updateStatusSubscription = this.updateService.updateStatus.subscribe((status) => {
      // console.log('更新状态:', status);
      this.mode = status;
      if (this.mode === 'downloaded') {
        this.progress = 100;
        this.updateTitleAndText();
      }
      this.cd.detectChanges();
    })
    this.updateProgressSubscription = this.updateService.updateProgress.subscribe((progress) => {
      this.progress = Math.floor(progress);
      this.cd.detectChanges();
    })
    this.downloadSourceStatusSubscription = this.updateService.downloadSourceStatus.subscribe((status) => {
      this.downloadSourceStatus = status;
      this.cd.detectChanges();
    });
    this.loadChangelog();
  }

  ngOnDestroy() {
    this.updateStatusSubscription?.unsubscribe();
    this.updateProgressSubscription?.unsubscribe();
    this.downloadSourceStatusSubscription?.unsubscribe();
  }

  get buttons(): DialogButton[] {
    switch (this.mode) {
      case 'available':
        return [
          { text: 'UPDATE_DIALOG.REMIND_LATER', type: 'default', action: 'remind' },
          { text: 'UPDATE_DIALOG.SKIP_VERSION', type: 'default', danger: true, action: 'skip' },
          { text: 'UPDATE_DIALOG.UPDATE_NOW', type: 'primary', action: 'download' }
        ];
      case 'downloading':
        return [
          { text: 'UPDATE_DIALOG.DOWNLOAD_IN_BACKGROUND', type: 'default', action: 'background' },
          { text: 'UPDATE_DIALOG.CANCEL_DOWNLOAD', type: 'default', danger: true, action: 'download_stop' }
        ];
      case 'downloaded':
        return [
          { text: 'UPDATE_DIALOG.INSTALL_LATER', type: 'default', action: 'remind' },
          { text: 'UPDATE_DIALOG.INSTALL_NOW', type: 'primary', action: 'install' }
        ];
      case 'error':
        return [
          { text: 'UPDATE_DIALOG.CLOSE', type: 'default', action: 'close' },
          { text: 'UPDATE_DIALOG.RETRY', type: 'primary', action: 'download' }
        ];
      default:
        return [];
    }
  }

  onClose(result: string = ''): void {
    this.modal.close(result || 'background');
  }

  get installPreparationMessageKey(): string {
    return this.updateService.hasOpenProject
      ? 'UPDATE_DIALOG.SAVING_BEFORE_INSTALL'
      : 'UPDATE_DIALOG.PREPARING_BEFORE_INSTALL';
  }

  onMinimize(): void {
    this.modal.close('background');
  }

  async onButtonClick(action: string): Promise<void> {
    if (action === 'download') {
      this.download();
    } else if (action === 'install') {
      await this.updateService.prepareAndInstall();
    } else if (action === 'background') {
      this.modal.close('background');
    } else {
      this.modal.close(action);
    }
  }

  download() {
    this.mode = 'downloading';
    this.cd.detectChanges();
    this.updateService.downloadUpdate();
  }

  private loadChangelog() {
    const lang = this.translate.currentLang || this.translate.defaultLang || '';
    const isChinese = lang.toLowerCase().startsWith('zh');
    const filename = isChinese ? 'CHANGELOG_ZH.md' : 'CHANGELOG.md';
    let updaterUrl = '';
    try {
      updaterUrl = this.configService.getCurrentUpdaterUrl();
    } catch (error) {
      console.warn('[Updater] Changelog URL is not available:', error);
      return;
    }
    if (!updaterUrl) {
      return;
    }
    const url = updaterUrl + '/' + filename;
    this.http.get(url, { responseType: 'text' }).subscribe({
      next: async (md) => {
        const html = await marked(md);
        if (this.markdownEl?.nativeElement) {
          this.markdownEl.nativeElement.innerHTML = html as string;
        }
        this.cd.detectChanges();
      },
      error: () => {}
    });
  }
}
