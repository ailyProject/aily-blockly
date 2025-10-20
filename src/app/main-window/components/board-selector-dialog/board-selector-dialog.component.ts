import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalRef, NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../../services/config.service';
import { ProjectService } from '../../../services/project.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-board-selector-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    TranslateModule,
    BaseDialogComponent
  ],
  templateUrl: './board-selector-dialog.component.html',
  styleUrl: './board-selector-dialog.component.scss'
})
export class BoardSelectorDialogComponent implements OnInit {

  readonly modal = inject(NzModalRef);
  readonly data: { boardList: any[] } = inject(NZ_MODAL_DATA);
  private message = inject(NzMessageService);
  private cd = inject(ChangeDetectorRef);

  boardList: any[] = [];
  filteredBoardList: any[] = [];
  searchKeyword: string = '';
  selectedBoard: any = null;
  isLoading: boolean = false;
  loadingText: string = '';

  get resourceUrl() {
    return this.configService.data.resource[0] + '/imgs/boards/';
  }

  constructor(
    private configService: ConfigService,
    private projectService: ProjectService,
    private translate: TranslateService
  ) {

  }

  ngOnInit(): void {
    this.loadingText = this.translate.instant('BOARD_SELECTOR.LOADING');
    this.boardList = this.data.boardList || [];
    this.filteredBoardList = [...this.boardList];
  }

  // 搜索过滤
  onSearch(): void {
    const keyword = this.searchKeyword.toLowerCase().trim();
    if (!keyword) {
      this.filteredBoardList = [...this.boardList];
    } else {
      this.filteredBoardList = this.boardList.filter(board =>
        board.name.toLowerCase().includes(keyword) ||
        (board.data?.board?.nickname || '').toLowerCase().includes(keyword) ||
        (board.data?.board?.brand || '').toLowerCase().includes(keyword) ||
        (board.data?.board?.description || '').toLowerCase().includes(keyword)
      );
    }
  }

  // 选择开发板
  selectBoard(board: any): void {
    this.selectedBoard = board;
  }

  get buttons(): DialogButton[] {
    return [
      { 
        text: 'BOARD_SELECTOR.CANCEL', 
        type: 'default', 
        action: 'cancel',
        disabled: this.isLoading
      },
      { 
        text: 'BOARD_SELECTOR.CONFIRM', 
        type: 'primary', 
        action: 'confirm',
        disabled: !this.selectedBoard || this.isLoading,
        loading: this.isLoading
      }
    ];
  }

  onClose(): void {
    if (!this.isLoading) {
      this.modal.close();
    }
  }

  onButtonClick(action: string): void {
    if (action === 'confirm') {
      this.confirm();
    } else if (action === 'cancel') {
      this.onClose();
    }
  }

  // 确认选择
  async confirm(): Promise<void> {
    if (this.selectedBoard) {
      this.isLoading = true;
      this.cd.detectChanges();
      try {
        // 执行开发板切换
        await this.projectService.changeBoard(this.selectedBoard);
        // 切换完成后关闭对话框
        this.modal.close();
      } catch (error) {
        console.error('切换开发板失败:', error);
        this.message.error(this.translate.instant('BOARD_SELECTOR.SWITCH_FAILED'));
        this.isLoading = false;
        this.cd.detectChanges();
      }
    }
  }

  cancel(): void {
    if (!this.isLoading) {
      this.modal.close();
    }
  }
}
