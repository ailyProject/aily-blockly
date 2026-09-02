import { ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { ElectronService, PlatformService } from '@core/platform/public-api';
import {
  ProjectService,
  runProjectCreationWorkflow,
  type ProjectCreationMode,
  type ProjectCreationTemplateSelection,
} from '@domain/project/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NpmService } from '@domain/dependencies/public-api';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UiService } from '@core/app-shell/public-api';
import { CloudService } from '../../tools/cloud-space/services/cloud.service';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { NzMessageService } from 'ng-zorro-antd/message';
import type { NewProjectData } from '../../types/project-new';
import {
  resolveInitialProjectCategory,
  type ProjectCreationCategory,
} from '../../utils/project-creation-category';
import {
  isBoardCompatibleWithProjectMode,
  normalizeBoardModes,
} from '@shared/public-api';
import { filterAndRankBoards } from '../../utils/fuzzy-search.utils';

@Component({
  selector: 'app-project-new',
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    NzButtonModule,
    NzInputModule,
    NzStepsModule,
    NzSelectModule,
    NzTagModule,
    NzRadioModule,
    TranslateModule
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent implements OnDestroy {
  @ViewChild('boardSearchInput') boardSearchInput?: ElementRef<HTMLInputElement>;

  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  currentStep = 0;

  myTemplateList: ProjectCreationTemplateSelection[] = [];
  isLoadingTemplates = false;
  selectedTemplateName = '';

  currentBoard: any = null;
  newProjectData: NewProjectData = {
    name: '',
    path: '',
    board: {
      name: '',
      nickname: '',
      version: '',
    }
  };

  boardVersion = '';

  // 搜索开发板关键字
  keyword = '';
  tagList = ['Arduino', 'ESP32', 'WiFiduino', 'XIAO', 'Seeed', 'OpenJumper', 'seekfree', 'keyesrobot', 'emakefun', 'Raspberry Pi'];
  _boardList: any[] = [];
  /** Blockly / Coder 共用开发板源（boards.json） */
  private _blocklyBoardList: any[] = [];
  boardList: any[] = [];
  tagListRandom;

  /** 基本设定页：Blockly 图形化 / Coder 代码编辑 */
  selectedProjectCategory: ProjectCreationCategory = 'blockly';

  /** 用户是否手动修改过项目名；未修改时随类别切换自动推荐名称 */
  private isProjectNameManuallyEdited = false;
  /** 程序写入推荐名时跳过 ngModelChange 的手动编辑标记 */
  private isApplyingRecommendedName = false;

  /** 向导第三步：Blockly 脚手架与 Aily Code 骨架共用 loading UI，用这个区分文案 */
  creatingMode: 'blockly' | 'aily' | null = null;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl() + '/imgs/boards/';
  }

  get searchShortcutHint(): string {
    return this.platformService.isMac() ? '⌘K' : 'Ctrl+K';
  }

  /** 只有显式配置 coder.enabled=true 时显示项目类型选择。 */
  get coderEnabled(): boolean {
    return this.configService.isCoderEnabled();
  }

  get coderProduct(): boolean {
    return this.configService.isCoderProduct();
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if (this.currentStep !== 0) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.boardSearchInput?.nativeElement?.focus();
      this.boardSearchInput?.nativeElement?.select();
    }
  }

  constructor(
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private npmService: NpmService,
    private uiService: UiService,
    private platformService: PlatformService,
    private cloudService: CloudService,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private translate: TranslateService
  ) {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$),
    ).subscribe(keyword => this.doSearch(keyword));

    // 语言切换后重新应用开发板 nickname/description 本地化字段
    this.translate.onLangChange.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.refreshBoardListForCurrentFilters();
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get selectedTemplate(): ProjectCreationTemplateSelection | null {
    return this.myTemplateList.find(template => template.name === this.selectedTemplateName) || null;
  }

  get selectedTemplateDescription(): string {
    const description = this.selectedTemplate?.description?.trim() || '';
    if (description.length <= 20) {
      return description;
    }
    return `${description.slice(0, 20)}......`;
  }

  async ngOnInit() {
    this.newProjectData.path = await this.projectService.getDefaultProjectParentPath();
    // await this.configService.init();
    const boardList = await this.configService.getBoardListWhenReady();
    this._blocklyBoardList = this.configService.sortBoardsByUsage(this.process(boardList));
    this.selectedProjectCategory = resolveInitialProjectCategory(
      this.coderEnabled,
      undefined,
      this.configService.getPreferredChatAgentRuntimeMode(),
      'blockly',
      this.coderProduct,
    );
    this.syncActiveBoardList();

    // 随机提取前五个
    this.tagListRandom = this.tagList.sort(() => Math.random() - 0.5).slice(0, 5);

    // macOS：默认 Documents 路径无非法字符，仍统一跑一遍以保持与向导内「选择文件夹」一致
    this.checkPathInvalidChars();
    this.applyRecommendedProjectName();

    this.refreshBoardListForCurrentFilters();
  }

  /** 按类别生成推荐项目名：Blockly → project_xxx，Coder → project_coder_xxx */
  private applyRecommendedProjectName(): void {
    if (this.isProjectNameManuallyEdited) {
      return;
    }
    const prefix = this.selectedProjectCategory === 'coder' ? 'project_coder_' : 'project_';
    this.isApplyingRecommendedName = true;
    this.newProjectData.name = this.projectService.generateUniqueProjectName(this.newProjectData.path, prefix);
    this.isApplyingRecommendedName = false;
    this.checkPathIsExist();
  }

  /** 项目名称输入变更：标记为手动编辑并校验路径 */
  onProjectNameChange(): void {
    if (!this.isApplyingRecommendedName) {
      this.isProjectNameManuallyEdited = true;
    }
    this.checkPathIsExist();
  }

  /** 两种项目类型共用同一份 Blockly 主板源。 */
  private syncActiveBoardList(): void {
    this._boardList = this._blocklyBoardList;
  }

  private filterBoardsForCategory(list: any[]): any[] {
    if (this.selectedProjectCategory !== 'coder') {
      return list;
    }
    return list.filter(board => isBoardCompatibleWithProjectMode(board, { devmode: 'arduino' }));
  }

  onProjectCategoryChange(): void {
    this.selectedProjectCategory = resolveInitialProjectCategory(
      this.coderEnabled,
      this.selectedProjectCategory,
      undefined,
      'blockly',
      this.coderProduct,
    );
    this.applyRecommendedProjectName();
    this.refreshBoardListForCurrentFilters();
  }

  private refreshBoardListForCurrentFilters(): void {
    if (this.keyword) {
      this.doSearch(this.keyword);
      return;
    }

    this.boardList = this.applyLocalization(
      this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
    );
    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    } else {
      this.currentBoard = null;
    }
    this.cd.detectChanges();
  }

  /** 按当前语言填充 `_nickname` / `_description`（boards.json 的 nickname_zh_cn 等字段） */
  private applyLocalization(list: any[]) {
    const lang = this.translate.currentLang || this.translate.defaultLang;
    for (const board of list) {
      board._nickname = (lang && board[`nickname_${lang}`]) || board.nickname || '';
      board._description = (lang && board[`description_${lang}`]) || board.description || '';
    }
    return list;
  }

  /** 在首个逗号处拆成两行展示项目类型描述（换行时不保留逗号） */
  splitCategoryDesc(text: string): string[] {
    const commaIndex = text.search(/[,，,\u060C、]/);
    if (commaIndex < 0) {
      return [text];
    }
    const head = text.slice(0, commaIndex).trimEnd();
    const tail = text.slice(commaIndex + 1).trimStart();
    return tail ? [head, tail] : [head];
  }

  /** 根据顶部所选类别创建对应类型项目 */
  async onCreateProject(): Promise<void> {
    if (this.coderEnabled && this.selectedProjectCategory === 'coder') {
      await this.createAilyCodeProject();
      return;
    }
    await this.createProject();
  }

  process(array) {
    let _array = JSON.parse(JSON.stringify(array));
    for (let index = 0; index < _array.length; index++) {
      const item = _array[index];
      // 为全文搜索做准备
      item['fulltext'] = `${item.nickname}${item.brand}${item.description}${item.keywords}`.replace(/\s/g, '').toLowerCase();
    }
    return _array;
  }

  search(keyword = this.keyword) {
    this.keyword = keyword;
    this.searchSubject.next(keyword);
  }

  private doSearch(keyword: string) {
    const localizedList = this.applyLocalization(
      this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
    );
    this.boardList = keyword
      ? filterAndRankBoards(localizedList, keyword)
      : localizedList;

    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    } else {
      this.currentBoard = null;
    }
    this.cd.detectChanges();
  }

  selectBoard(boardInfo: BoardInfo) {
    // if (boardInfo.disabled) return;
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo._nickname || boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
    if (this.selectedProjectCategory === 'coder') {
      this.newProjectData.devmode = 'arduino';
    } else {
      this.newProjectData.devmode = normalizeBoardModes(boardInfo)[0] || 'arduino';
    }
    if (this.selectedProjectCategory === 'blockly') {
      this.loadMyTemplates(boardInfo.name);
    } else {
      this.myTemplateList = [];
      this.selectedTemplateName = '';
    }
  }

  loadMyTemplates(boardName: string) {
    if (this.selectedProjectCategory !== 'blockly') {
      this.myTemplateList = [];
      this.selectedTemplateName = '';
      this.isLoadingTemplates = false;
      return;
    }
    this.myTemplateList = [];
    this.selectedTemplateName = '';
    if (!boardName?.trim()) {
      this.isLoadingTemplates = false;
      this.cd.detectChanges();
      return;
    }

    this.isLoadingTemplates = true;
    this.cloudService.getMyTemplates(1, 20, boardName).subscribe({
      next: (res) => {
        if (res?.status === 200 && Array.isArray(res?.data?.list)) {
          this.myTemplateList = res.data.list;
          this.selectedTemplateName = '';
        } else {
          this.myTemplateList = [];
          this.selectedTemplateName = '';
        }
        this.isLoadingTemplates = false;
        this.cd.detectChanges();
      },
      error: () => {
        this.myTemplateList = [];
        this.selectedTemplateName = '';
        this.isLoadingTemplates = false;
        this.cd.detectChanges();
      }
    });
  }

  // 可用版本列表
  boardVersionList: any[] = [];
  async nextStep() {
    this.boardVersionList = [this.newProjectData.board.version];
    this.currentStep = this.currentStep + 1;
    // 项目尚未创建，按所选板的 mode 决定从 Linux 还是默认 Arduino npm 来源查询版本。
    this.boardVersionList = (await this.npmService.getPackageVersionList(
      this.newProjectData.board.name,
      this.configService.getNpmRegistryForBoard(this.currentBoard),
    )).reverse();
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: this.newProjectData.path,
    });
    // console.log('选中的文件夹路径：', folderPath);
    const pt = this.platformService.getPlatformSeparator();
    if (folderPath.slice(-1) !== pt) {
      this.newProjectData.path = folderPath + pt;
    }
    this.checkPathInvalidChars();
  }

  /** macOS 下父路径非法字符（与主窗口 ProjectNewComponent 对齐） */
  showIsPathPassed = false;
  checkPathInvalidChars(): boolean {
    if (!this.platformService.isMac()) {
      this.showIsPathPassed = false;
      return false;
    }
    const invalidChars = /[\s\0:\\*?^$!#%&()=+`~'"<>|\n\r]/;
    this.showIsPathPassed = invalidChars.test(this.newProjectData.path);
    return this.showIsPathPassed;
  }

  // 检查项目名称是否存在
  showIsExist = false;
  async checkPathIsExist(): Promise<boolean> {
    const pt = this.platformService.getPlatformSeparator();
    let path = this.newProjectData.path + pt + this.newProjectData.name;
    let isExist = window['path'].isExists(path);
    if (isExist) {
      this.showIsExist = true;
    } else {
      this.showIsExist = false;
    }
    this.checkPathInvalidChars();
    return isExist;
  }

  async createProject() {
    await this.runCreationWorkflow('blockly');
  }

  /**
   * 子窗口使用同一主板包下的 template_arduino 创建并打开工程。
   */
  async createAilyCodeProject(): Promise<void> {
    await this.runCreationWorkflow('coder');
  }

  private async runCreationWorkflow(mode: ProjectCreationMode): Promise<void> {
    await runProjectCreationWorkflow(
      {
        mode,
        project: this.newProjectData,
        templateSelected: mode === 'blockly' && !!this.selectedTemplateName,
        selectedTemplate: mode === 'blockly' ? this.selectedTemplate : null,
      },
      {
        validate: async () => {
          if (await this.checkPathIsExist()) {
            return 'path-exists';
          }
          return this.checkPathInvalidChars() ? 'invalid-path' : null;
        },
        onCreating: creationMode => {
          this.creatingMode = creationMode === 'coder' ? 'aily' : 'blockly';
          this.currentStep = 2;
        },
        recordBoardUsage: boardName => this.configService.recordBoardUsage(boardName),
        listTemplateProjects: async (page, pageSize) => {
          const res = await firstValueFrom(this.cloudService.getProjects(page, pageSize));
          return {
            list: Array.isArray(res?.data?.list) ? res.data.list : [],
            total: Number(res?.data?.total || 0),
          };
        },
        resolveTemplateArchiveUrl: templateProject => templateProject.archive_url
          ? `${this.cloudService.baseUrl}${templateProject.archive_url}`
          : '',
        downloadTemplateArchive: archiveUrl => firstValueFrom(this.cloudService.getProjectArchive(archiveUrl)),
        cleanupExtractedFiles: extractPath => this.cloudService.cleanupExtractedFiles(extractPath),
        createProject: creationMode => creationMode === 'coder'
          ? this.projectService.projectNew(this.newProjectData, {
            templateDirectory: 'template_arduino',
          })
          : this.projectService.projectNew(this.newProjectData),
        createProjectFromTemplate: extractPath => (
          this.projectService.projectNewFromTemplate(this.newProjectData, extractPath)
        ),
        onCreated: creationMode => {
          if (creationMode === 'coder') {
            this.message.success(this.translate.instant('AILYCODE_NEW_DIALOG.SUCCESS'));
          }
          this.uiService.closeWindow();
        },
        onFailed: () => this.resetCreationState(),
        reportError: error => {
          const message = typeof error === 'string'
            ? error
            : ((error as any)?.message || '创建项目失败');
          this.message.error(message);
        },
      },
    );
  }

  private resetCreationState(): void {
    this.currentStep = 1;
    this.creatingMode = null;
  }

  openUrl(url) {
    this.electronService.openUrl(url);
  }

  help() {
    this.electronService.openUrl("https://github.com/ailyProject/aily-blockly-boards/blob/main/readme.md");
  }
}


export interface BoardInfo {
  "name": string, // 开发板在仓库中的名称开发板名称
  "nickname": string, // 显示的开发板名称
  "_nickname"?: string, // 按当前语言本地化后的显示名
  "version": string,
  "img": string,
  "description": string,
  "_description"?: string, // 按当前语言本地化后的介绍
  "url": string,
  "brand": string,
  "disabled": boolean, // 是否禁用
  "type"?: string, // 开发板类型/核心架构 (如 esp32:esp32, arduino:avr, etc)
}
