import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalRef, NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../../services/config.service';
import { ProjectService } from '../../../services/project.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';
import {
  getCoderFrameworkOptions,
  resolveDefaultCoderFramework,
} from '../../../utils/coder-board.mapper';

@Component({
  selector: 'app-board-selector-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzSelectModule,
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
  /** Aily Code：所选开发板对应的硬件平台（framework） */
  selectedCoderPlatform = '';
  isLoading: boolean = false;
  loadingText: string = '';

  get showPlatformSelector(): boolean {
    return !!this.data.isAilyCode && !!this.selectedBoard && this.coderPlatformOptions.length > 0;
  }

  get coderPlatformOptions(): { value: string; label: string }[] {
    if (!this.data.isAilyCode || !this.selectedBoard) {
      return [];
    }
    return getCoderFrameworkOptions(this.selectedBoard).map((option) => ({
      value: option.value,
      label: this.getCoderFrameworkLabel(option.value),
    }));
  }

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
    this.boardList = (this.data.boardList || []).filter(board => board.state !== 'todo');
    this.filteredBoardList = [...this.boardList];
    if (this.data.isAilyCode) {
      await this.initAilyCodeSelection();
    }
  }

  private readCurrentAilyCodeFramework(): string {
    const root = this.projectService.currentProjectPath;
    if (!root) {
      return '';
    }
    const aciPath = `${root}/project.aci`;
    if (!window['fs']?.existsSync?.(aciPath)) {
      return '';
    }
    try {
      const aci = JSON.parse(window['fs'].readFileSync(aciPath, 'utf8'));
      return String(aci?.target?.framework ?? aci?.devmode ?? '').trim();
    } catch {
      return '';
    }
  }

  /** 预选当前工程开发板与硬件平台 */
  private async initAilyCodeSelection(): Promise<void> {
    const framework = this.readCurrentAilyCodeFramework();
    if (framework) {
      this.selectedCoderPlatform = framework;
    }
    try {
      const currentModule = await this.projectService.getBoardModule();
      if (!currentModule) {
        return;
      }
      const current = this.boardList.find((board) => board.name === currentModule);
      if (current) {
        this.selectedBoard = current;
        this.syncCoderPlatformSelection(current);
      }
    } catch {
      /* 工程尚未安装主板包时忽略 */
    } finally {
      this.cd.detectChanges();
    }
  }

  getCoderFrameworkLabel(framework: string): string {
    const key = `PROJECT_NEW.FORM.PLATFORM_${framework.toUpperCase().replace(/-/g, '_')}`;
    const translated = this.translate.instant(key);
    return translated !== key ? translated : framework;
  }

  private syncCoderPlatformSelection(boardInfo: any): void {
    const defaultFramework = resolveDefaultCoderFramework(boardInfo);
    const options = getCoderFrameworkOptions(boardInfo);
    if (!options.some((option) => option.value === this.selectedCoderPlatform)) {
      this.selectedCoderPlatform = defaultFramework;
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
    if (this.data.isAilyCode) {
      this.syncCoderPlatformSelection(board);
    }
  }

  get canConfirm(): boolean {
    if (!this.selectedBoard) {
      return false;
    }
    if (this.showPlatformSelector && !this.selectedCoderPlatform) {
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
        const boardPayload = this.data.isAilyCode && this.selectedCoderPlatform
          ? { ...this.selectedBoard, selectedFramework: this.selectedCoderPlatform }
          : this.selectedBoard;
        await this.projectService.changeBoard(boardPayload);
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
