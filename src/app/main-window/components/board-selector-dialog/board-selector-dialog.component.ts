import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalRef, NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';
import { isBoardCompatibleWithProjectMode } from '@shared/public-api';

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
  readonly data: { boardList: any[]; isAilyCode?: boolean } = inject(NZ_MODAL_DATA);
  private message = inject(NzMessageService);
  private cd = inject(ChangeDetectorRef);

  boardList: any[] = [];
  filteredBoardList: any[] = [];
  searchKeyword: string = '';
  selectedBoard: any = null;
  isLoading: boolean = false;
  loadingText: string = '';

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl() + '/imgs/boards/';
  }

  constructor(
    private configService: ConfigService,
    private projectService: ProjectService,
    private translate: TranslateService
  ) {

  }

  async ngOnInit(): Promise<void> {
    this.loadingText = this.translate.instant('BOARD_SELECTOR.LOADING');
    const availableBoards = (this.data.boardList || []).filter(board => board.state !== 'todo');
    // Coder 固定使用 Arduino 模板；Blockly/Python 也只能切换到同开发模式的板卡。
    this.boardList = availableBoards.filter(board => isBoardCompatibleWithProjectMode(
        board,
        this.projectService.currentPackageData,
      ));
    this.filteredBoardList = [...this.boardList];
    if (this.data.isAilyCode) {
      await this.initAilyCodeSelection();
    }
  }

  /** 预选当前工程开发板。 */
  private async initAilyCodeSelection(): Promise<void> {
    try {
      const currentModule = await this.projectService.getBoardModule();
      if (!currentModule) {
        return;
      }
      const current = this.boardList.find((board) => board.name === currentModule);
      if (current) {
        this.selectedBoard = current;
      }
    } catch {
      /* 工程尚未安装主板包时忽略 */
    } finally {
      this.cd.detectChanges();
    }
  }

  // 搜索过滤
  onSearch(): void {
    const keyword = this.searchKeyword.toLowerCase().trim();
    if (!keyword) {
      this.filteredBoardList = [...this.boardList];
    } else {
      this.filteredBoardList = this.boardList.filter(board =>
        board.name.toLowerCase().includes(keyword) ||
        (board.nickname || '').toLowerCase().includes(keyword) ||
        (board.brand || '').toLowerCase().includes(keyword) ||
        (board.description || '').toLowerCase().includes(keyword)
      );
    }
  }

  // 选择开发板
  selectBoard(board: any): void {
    this.selectedBoard = board;
  }

  get canConfirm(): boolean {
    if (!this.selectedBoard) {
      return false;
    }
    return true;
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
        disabled: !this.canConfirm || this.isLoading,
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
