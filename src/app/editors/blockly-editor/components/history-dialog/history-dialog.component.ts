import { Component, EventEmitter, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HistoryService, HistoryItem } from '../../services/history.service';
import { _ProjectService } from '../../services/project.service';
import { NzModalModule, NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-history-dialog',
  standalone: true,
  imports: [CommonModule, NzModalModule, NzButtonModule, NzEmptyModule, NzTagModule, TranslateModule, BaseDialogComponent],
  templateUrl: './history-dialog.component.html',
  styleUrls: ['./history-dialog.component.scss']
})
export class HistoryDialogComponent implements OnInit {
  @Output() close = new EventEmitter<void>();
  historyList: HistoryItem[] = [];

  buttons: DialogButton[] = [
    {
      text: '关闭',
      type: 'default',
      action: 'close'
    }
  ];

  constructor(
    private historyService: HistoryService,
    private projectService: _ProjectService,
    private modal: NzModalRef
  ) { }

  ngOnInit() {
    this.historyService.historySubject.subscribe(list => {
      this.historyList = list;
    });
  }

  formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  restore(item: HistoryItem) {
    this.projectService.restoreVersion(item.id);
    // 不关闭对话框,允许用户继续切换版本
  }

  handleClose() {
    this.modal.close();
  }

  onButtonClick(action: string) {
    if (action === 'close') {
      this.handleClose();
    }
  }
}
