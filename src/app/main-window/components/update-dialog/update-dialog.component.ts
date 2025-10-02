import { Component, Inject, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Observable, Subscription } from 'rxjs';
import { UpdateService } from '../../../services/update.service';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

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

  constructor(
    @Inject(NZ_MODAL_DATA) public data: any,
    private modal: NzModalRef,
    private updateService: UpdateService,
    private cd: ChangeDetectorRef
  ) {
    this.title = data.title || '';
    this.text = data.text || '';

    console.log('UpdateDialogComponent data:', data);

  }

  updateStatusSubscription: Subscription;
  updateProgressSubscription: Subscription;

  ngOnInit() {
    // 订阅更新状态
    this.updateStatusSubscription = this.updateService.updateStatus.subscribe((status) => {
      // console.log('更新状态:', status);
      this.mode = status;
      if (this.mode === 'downloaded') {
        this.progress = 100; 
      }
      this.cd.detectChanges();
    })
    this.updateProgressSubscription = this.updateService.updateProgress.subscribe((progress) => {
      this.progress = Math.floor(progress);
      this.cd.detectChanges();
    })
  }

  ngOnDestroy() {
    this.updateStatusSubscription?.unsubscribe();
    this.updateProgressSubscription?.unsubscribe();
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
    this.modal.close(result);
  }

  onButtonClick(action: string): void {
    if (action === 'download') {
      this.download();
    } else {
      this.modal.close(action);
    }
  }

  download() {
    this.updateService.dialogAction.next('download');
    this.mode = 'downloading';
    this.cd.detectChanges();
  }
}
