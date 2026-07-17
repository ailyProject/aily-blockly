import { ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { ElectronService } from '../../services/electron.service';
import { ProjectService } from '../../services/project.service';
import { ConfigService } from '../../services/config.service';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NpmService } from '../../services/npm.service';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Router } from '@angular/router';
import { BrandListComponent } from './components/brand-list/brand-list.component';
import { BRAND_LIST, CORE_LIST } from '../../configs/board.config';
import { PlatformService } from '../../services/platform.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { CloudService } from '../../tools/cloud-space/services/cloud.service';
import { SequentialImgDirective } from './sequential-img.directive';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { createBoardSearchIndex, searchBoards } from '../../utils/fuzzy-search.utils';
import {
  getCoderFrameworkOptions,
  resolveCoderFrameworkOption,
  resolveDefaultCoderFramework,
} from '../../utils/coder-board.mapper';
import type { AnyOrama } from '@orama/orama';
import { NzMessageService } from 'ng-zorro-antd/message';
import type { NewProjectData } from '../../types/project-new';
import { NzModalService } from 'ng-zorro-antd/modal';
import { AilyCodeProjectService } from '../../services/aily-code-project.service';
import type { AilyCodeNewProjectData } from '../../services/aily-code-project.service';
import { UnsaveDialogComponent } from '../../main-window/components/unsave-dialog/unsave-dialog.component';

@Component({
  selector: 'app-project-new',
  imports: [
    CommonModule,
    FormsModule,
    NzToolTipModule,
    NzButtonModule,
    NzInputModule,
    NzStepsModule,
    NzSelectModule,
    NzTagModule,
    TranslateModule,
    BrandListComponent,
    NzRadioModule,
    SequentialImgDirective
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent implements OnDestroy {
  @ViewChild('boardSearchInput') boardSearchInput?: ElementRef<HTMLInputElement>;

  currentStep = 0;

  listMode = 'brand'; // brand | core | function

  selectedBrand: any = null;
  selectedCore: any = null;

  currentBoard: any = null;
  newProjectData: NewProjectData = {
    name: '',
    path: '',
    board: {
      name: '',
      nickname: '',
      version: '',
    },
    devmode: ''
  };

  boardVersion = '';

  // 搜索开发板关键字
  keyword = '';

  _boardList: any[] = [];
  /** Blockly 模式开发板源（boards.json，已按使用次数排序） */
  private _blocklyBoardList: any[] = [];
  /** Coder 模式开发板源（coder_board_index.json，已按使用次数排序） */
  private _coderBoardList: any[] = [];
  /** Blockly 配置文件原始顺序（未按使用次数排序） */
  private _blocklyBoardListInConfigOrder: any[] = [];
  /** Coder 配置文件原始顺序（未按使用次数排序） */
  private _coderBoardListInConfigOrder: any[] = [];
  /** 当前类别下配置文件原始顺序的开发板列表 */
  private boardListInConfigOrder: any[] = [];
  boardList: any[] = [];

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private searchIndex: AnyOrama | null = null;

  /** 基本设定页：Blockly 图形化 / Coder 代码编辑 */
  selectedProjectCategory: 'blockly' | 'coder' = 'blockly';

  /** Coder 新建：当前开发板可选的 framework（来自 frameworkPlatforms） */
  selectedCoderPlatform = '';

  get coderPlatformOptions(): { value: string; label: string }[] {
    if (this.selectedProjectCategory !== 'coder' || !this.currentBoard) {
      return [];
    }
    return getCoderFrameworkOptions(this.currentBoard).map((option) => ({
      value: option.value,
      label: this.getCoderFrameworkLabel(option.value),
    }));
  }

  /** 用户是否手动修改过项目名；未修改时随类别切换自动推荐名称 */
  private isProjectNameManuallyEdited = false;
  /** 程序写入推荐名时跳过 ngModelChange 的手动编辑标记 */
  private isApplyingRecommendedName = false;

  /** 第三步加载态：区分 Blockly 脚手架与 Aily Code 骨架的提示文案 */
  creatingMode: 'blockly' | 'aily' | null = null;
  /** 与 Aily Code 对话框一致：阻塞重复弹出未保存提示 */
  private unsaveDialogOpen = false;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
  }

  get searchShortcutHint(): string {
    return this.platformService.isMac() ? '⌘K' : 'Ctrl+K';
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

  // 获取已定义的品牌列表（排除'all'和'other'）
  private getDefinedBrands(): string[] {
    return BRAND_LIST
      .filter(brand => brand.value !== 'all' && brand.value !== 'other')
      .map(brand => brand.value.toLowerCase());
  }

  // 获取已定义的核心架构列表（排除'all'和'other'）
  private getDefinedCores(): string[] {
    return CORE_LIST
      .filter(core => core.value !== 'all' && core.value !== 'other')
      .map(core => core.value.toLowerCase());
  }

  constructor(
    private router: Router,
    private location: Location,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private npmService: NpmService,
    private platformService: PlatformService,
    private cloudService: CloudService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private message: NzMessageService,
    private ailyCodeProject: AilyCodeProjectService,
    private nzModal: NzModalService
  ) {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$)
    ).subscribe(keyword => this.doSearch(keyword));
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async ngOnInit() {
    this.newProjectData.path = await this.projectService.getDefaultProjectParentPath();

    // 切换标题
    // this.electronService.setTitle('PROJECT_NEW.TITLE');
    // await this.configService.init();

    // 分别处理 Blockly / Coder 两套开发板数据源
    this._blocklyBoardListInConfigOrder = this.process(this.configService.boardList);
    this._blocklyBoardList = this.configService.sortBoardsByUsage(this._blocklyBoardListInConfigOrder);
    this._coderBoardListInConfigOrder = this.process(this.configService.getCoderBoardList());
    this._coderBoardList = this.configService.sortBoardsByUsage(this._coderBoardListInConfigOrder);

    this.selectedProjectCategory = this.configService.getPreferredChatAgentRuntimeMode();
    this.syncActiveBoardList();
    this.applyRecommendedProjectName();
    this.refreshBoardListForCurrentFilters();
    this.checkPathInvalidChars();
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

  /** 根据当前项目类别切换开发板数据源 */
  private syncActiveBoardList(): void {
    if (this.selectedProjectCategory === 'coder') {
      this._boardList = this._coderBoardList;
      this.boardListInConfigOrder = this._coderBoardListInConfigOrder;
    } else {
      this._boardList = this._blocklyBoardList;
      this.boardListInConfigOrder = this._blocklyBoardListInConfigOrder;
    }
  }

  /** Coder 模式下隐藏尚未支持的开发板（state=todo） */
  private filterBoardsForCategory(list: any[]): any[] {
    if (this.selectedProjectCategory !== 'coder') {
      return list;
    }
    return list.filter(board => board.state !== 'todo');
  }

  /** 切换 framework 时同步 devmode，供创建项目使用 */
  onCoderPlatformChange(): void {
    this.newProjectData.devmode = this.selectedCoderPlatform;
  }

  /** 展示 framework 名称：有 i18n 则翻译，否则直接使用索引值 */
  getCoderFrameworkLabel(framework: string): string {
    const key = `PROJECT_NEW.FORM.PLATFORM_${framework.toUpperCase().replace(/-/g, '_')}`;
    const translated = this.translate.instant(key);
    return translated !== key ? translated : framework;
  }

  /** 选中开发板后，根据 frameworkPlatforms 重置可选平台 */
  private syncCoderPlatformSelection(boardInfo: any): void {
    const defaultFramework = resolveDefaultCoderFramework(boardInfo);
    const options = getCoderFrameworkOptions(boardInfo);
    if (!options.some((option) => option.value === this.selectedCoderPlatform)) {
      this.selectedCoderPlatform = defaultFramework;
    }
    this.newProjectData.devmode = this.selectedCoderPlatform;
  }

  private refreshBoardListForCurrentFilters(): void {
    if (this.keyword) {
      this.doSearch(this.keyword);
      return;
    }

    if (this.listMode === 'brand' && this.selectedBrand) {
      this.onBrandSelected(this.selectedBrand);
      return;
    }

    if (this.listMode === 'core' && this.selectedCore) {
      this.onCoreSelected(this.selectedCore);
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
    if (this.selectedProjectCategory === 'coder') {
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
    if (!keyword) {
      // 恢复完整列表（已按使用次数排序）
      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
      );
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      } else {
        this.currentBoard = null;
      }
      this.cd.detectChanges();
      return;
    }

    // 使用 Orama 进行模糊搜索
    const localizedList = this.applyLocalization(
      this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
    );
    this.searchIndex = createBoardSearchIndex(localizedList);
    const matchedNames = searchBoards(this.searchIndex, keyword);

    // 按 Orama 返回的顺序（相关度排序）还原开发板对象
    const nameIndexMap = new Map<string, number>();
    matchedNames.forEach((name, i) => nameIndexMap.set(name, i));

    this.boardList = localizedList
      .filter(board => nameIndexMap.has(board.name))
      .sort((a, b) => (nameIndexMap.get(a.name) ?? 0) - (nameIndexMap.get(b.name) ?? 0));

    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    } else {
      this.currentBoard = null;
    }
    this.cd.detectChanges();
  }

  devmodes = [];
  hasExamples = false;
  myTemplateList: CloudProjectTemplate[] = [];
  isLoadingTemplates = false;
  selectedTemplateName = '';

  get selectedTemplate(): CloudProjectTemplate | null {
    return this.myTemplateList.find(template => template.name === this.selectedTemplateName) || null;
  }

  get selectedTemplateDescription(): string {
    const description = this.selectedTemplate?.description?.trim() || '';
    if (description.length <= 20) {
      return description;
    }
    return `${description.slice(0, 20)}......`;
  }

  selectBoard(boardInfo: any) {
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo._nickname || boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
    if (this.selectedProjectCategory === 'coder') {
      this.syncCoderPlatformSelection(boardInfo);
    } else {
      this.newProjectData.devmode = boardInfo.mode ? this.currentBoard.mode[0] : 'arduino';
    }
    this.devmodes = boardInfo.mode;
    if (this.selectedProjectCategory === 'blockly') {
      this.checkHasExamples(boardInfo.name);
      this.loadMyTemplates(boardInfo.name);
    } else {
      this.hasExamples = false;
      this.myTemplateList = [];
      this.selectedTemplateName = '';
    }
  }

  checkHasExamples(boardName: string) {
    if (this.selectedProjectCategory !== 'blockly') {
      this.hasExamples = false;
      return;
    }
    this.hasExamples = false;
    this.cloudService.getPublicProjects(1, 1, '', '', boardName).subscribe(res => {
      if (res && res.status === 200 && res.data && res.data.total > 0) {
        this.hasExamples = true;
        this.cd.detectChanges();
      }
    });
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
        } else {
          this.myTemplateList = [];
        }
        this.selectedTemplateName = '';
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
    this.boardVersionList = (await this.npmService.getPackageVersionList(this.newProjectData.board.name)).reverse();
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

  // macOS 项目名称非法字符检查：/ \0 : 等（仅检查用户输入的项目名）
  showIsPathPassed = false;
  checkPathInvalidChars(): boolean {
    if (!this.platformService.isMac()) {
      this.showIsPathPassed = false;
      return false;
    }
    // macOS 文件名特殊及非法字符：/ \0 : \ * ? " < > | \n \r 等
    const invalidChars = /[\s\0:\\*?^$!#%&()=+`~'"<>|\n\r]/;
    console.log('invalidChars: ', this.newProjectData.path);
    const hasInvalid = invalidChars.test(this.newProjectData.path);
    this.showIsPathPassed = hasInvalid;
    return hasInvalid;
  }

  async createProject() {
    // 判断是否有同名项目
    if (await this.checkPathIsExist()) {
      return;
    }
    // macOS 路径非法字符检查
    if (this.checkPathInvalidChars()) {
      return;
    }
    this.creatingMode = 'blockly';
    this.currentStep = 2;

    // 记录开发板使用次数
    this.configService.recordBoardUsage(this.newProjectData.board.name);

    let success = false;
    let extractPath = '';
    try {
      if (this.selectedTemplateName) {
        const templateProject = await this.findSelectedTemplateProject();
        if (!templateProject?.archive_url) {
          throw new Error('未找到所选模板的归档文件');
        }

        const archiveUrl = `${this.cloudService.baseUrl}${templateProject.archive_url}`;
        extractPath = await firstValueFrom(this.cloudService.getProjectArchive(archiveUrl));
        success = await this.projectService.projectNewFromTemplate(this.newProjectData, extractPath);
      } else {
        success = await this.projectService.projectNew(this.newProjectData);
      }
    } catch (error: any) {
      const message = typeof error === 'string' ? error : (error?.message || '创建项目失败');
      this.message.error(message);
    } finally {
      if (extractPath) {
        this.cloudService.cleanupExtractedFiles(extractPath);
      }
    }

    if (!success) {
      this.currentStep = 1;
      this.creatingMode = null;
    }
  }

  /**
   * Blockly 向导中收集的开发板上下文，传给 AilyCodeProjectService，
   * 写入 project.aci.target，便于用户在 Aily Code 侧延续同一硬件选择。
   */
  private buildAilyWizardTarget(): NonNullable<AilyCodeNewProjectData['wizardTarget']> {
    const framework = this.selectedCoderPlatform
      || this.currentBoard?.defaultFramework
      || this.newProjectData.devmode
      || 'arduino';
    const platformOption = resolveCoderFrameworkOption(this.currentBoard, framework);
    return {
      boardPkgName: this.newProjectData.board.name,
      targetBoardId: platformOption?.boardId || this.currentBoard?.boardId || '',
      boardNickname: this.newProjectData.board.nickname,
      boardPkgVersion: this.newProjectData.board.version,
      framework,
      platform: platformOption?.platform || this.currentBoard?.defaultPlatform || '',
    };
  }

  /** 主路由下创建 Aily Code 骨架：跳过 npm 模板，成功则与对话框一致地走 projectOpen */
  async createAilyCodeProject(): Promise<void> {
    if (await this.checkPathIsExist()) {
      return;
    }
    if (this.checkPathInvalidChars()) {
      return;
    }

    // 沿用 Blockly：记录开发板使用热度
    this.configService.recordBoardUsage(this.newProjectData.board.name);
    this.creatingMode = 'aily';
    this.currentStep = 2;

    const resultRef = await this.ailyCodeProject.projectNew({
      name: String(this.newProjectData.name ?? '').trim(),
      path: String(this.newProjectData.path ?? '').trim(),
      wizardTarget: this.buildAilyWizardTarget()
    });

    if (!resultRef.ok) {
      const map: Record<string, string> = {
        NAME_EMPTY: 'AILYCODE_NEW_DIALOG.WARN_NAME_EMPTY',
        PATH_EMPTY: 'AILYCODE_NEW_DIALOG.WARN_PATH_EMPTY',
        PATH_EXISTS: 'AILYCODE_NEW_DIALOG.ERR_PATH_EXISTS'
      };
      const key = map[resultRef.error ?? ''] || 'AILYCODE_NEW_DIALOG.ERR_CREATE_FAILED';
      this.message.error(this.translate.instant(key));
      this.currentStep = 1;
      this.creatingMode = null;
      return;
    }

    this.message.success(this.translate.instant('AILYCODE_NEW_DIALOG.SUCCESS'));

    const projectPath = resultRef.projectPath;
    if (!projectPath) {
      this.creatingMode = null;
      this.currentStep = 1;
      return;
    }

    const canSwitch = await this.confirmSwitchWithUnsavedIfNeeded();
    if (!canSwitch) {
      this.currentStep = 1;
      this.creatingMode = null;
      return;
    }

    await this.projectService.projectOpen(projectPath);
  }

  /** 若当前在主编辑器且存在未保存，弹窗对齐「打开项目」行为（与 AilyCodeNewDialog 一致） */
  private isOnEditorRoute(): boolean {
    const url = this.router.url;
    return ['/main/blockly-editor', '/main/code-editor', '/main/code-editor-pro'].some((r) => url.includes(r));
  }

  /** 切换到新工程前的未保存确认；取消则停在向导第一步 */
  private async confirmSwitchWithUnsavedIfNeeded(): Promise<boolean> {
    if (!this.isOnEditorRoute()) {
      return true;
    }
    if (!(await this.projectService.hasUnsavedChanges())) {
      return true;
    }
    if (this.unsaveDialogOpen) {
      return false;
    }
    this.unsaveDialogOpen = true;
    return new Promise<boolean>((resolve) => {
      const ref = this.nzModal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: '350px',
        nzContent: UnsaveDialogComponent,
        nzData: { action: 'open' as const },
      });
      ref.afterClose.subscribe(async (res: { result?: string } | null) => {
        this.unsaveDialogOpen = false;
        if (!res) {
          resolve(false);
          return;
        }
        switch (res.result) {
          case 'save':
            await this.projectService.save();
            resolve(true);
            break;
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  private async findSelectedTemplateProject(): Promise<any> {
    const selectedTemplate = this.selectedTemplate;
    if (!selectedTemplate) {
      return null;
    }

    const pageSize = 100;
    let page = 1;
    let total = 0;

    do {
      const res = await firstValueFrom(this.cloudService.getProjects(page, pageSize));
      const projects = Array.isArray(res?.data?.list) ? res.data.list : [];
      total = Number(res?.data?.total || 0);

      const matchedProject = projects.find((project: any) => (
        project?.is_template === true &&
        project?.name === selectedTemplate.name &&
        (project?.nickname || '') === (selectedTemplate.nickname || '') &&
        (project?.description || '') === (selectedTemplate.description || '')
      ));

      if (matchedProject) {
        return matchedProject;
      }

      page += 1;
    } while ((page - 1) * pageSize < total);

    throw new Error('未找到所选模板项目');
  }

  openUrl(url) {
    this.electronService.openUrl(url);
  }

  help() {
    this.electronService.openUrl("https://github.com/ailyProject/aily-blockly-boards/blob/main/readme.md");
  }

  back() {
    // 检查是否有历史记录可以返回
    if (window.history.length > 1) {
      this.location.back();
    } else {
      // 如果没有历史记录，跳转到项目初始默认路径
      this.router.navigate(['/main/guide']);
    }
  }

  onSelected(obj: any) {
    switch (this.listMode) {
      case 'brand':
        this.onBrandSelected(obj);
        break;
      case 'core':
        this.onCoreSelected(obj);
        break;
    }
  }

  onBrandSelected(brand: any) {
    this.selectedBrand = brand;
    console.log('选中的品牌:', brand);

    // 根据选中的品牌过滤开发板列表
    if (brand && brand.value !== 'all') {
      if (brand.value === 'other') {
        // 当选择"其他品牌"时，显示已有品牌列表未覆盖的元素
        const definedBrands = this.getDefinedBrands();
        let filteredBoardList = this._boardList.filter(board => {
          const boardBrand = board.brand ? board.brand.toLowerCase() : '';
          return !definedBrands.includes(boardBrand);
        });
        // 对过滤后的列表按使用次数排序
        this.boardList = this.applyLocalization(
          this.filterBoardsForCategory(this.configService.sortBoardsByUsage(filteredBoardList))
        );
      } else {
        // 普通品牌过滤
        let filteredBoardList = this.boardListInConfigOrder.filter(board => {
          const boardBrand = board.brand ? board.brand.toLowerCase() : '';
          const selectedBrandValue = brand.value.toLowerCase();
          return boardBrand === selectedBrandValue
        });
        this.boardList = this.applyLocalization(
          this.filterBoardsForCategory(JSON.parse(JSON.stringify(filteredBoardList)))
        );
      }

      console.log('过滤后的开发板列表:', this.boardList);

      // 如果有过滤结果，选择第一个开发板
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      } else {
        this.currentBoard = null;
      }
    } else {
      // 如果选择"显示全部"或没有选中品牌，显示所有开发板（已按使用次数排序）
      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
      );
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    }
  }

  onCoreSelected(core: any) {
    this.selectedCore = core;
    console.log('选中的核心架构:', core);

    // 根据选中的核心架构过滤开发板列表
    if (core && core.value !== 'all') {
      let filteredBoardList: any[] = [];
      if (core.value === 'other') {
        // 当选择"其他核心架构"时，显示已有核心列表未覆盖的元素
        const definedCores = this.getDefinedCores();
        filteredBoardList = this.boardListInConfigOrder.filter(board => {
          if (board.type && typeof board.type === 'string') {
            const boardType = board.type.toLowerCase();
            // 检查是否包含任何已定义的核心架构
            return !definedCores.some(definedCore => boardType.includes(definedCore));
          }
          return true; // 如果没有 type 字段，也算作 other
        });
      } else {
        // 普通核心架构过滤
        filteredBoardList = this.boardListInConfigOrder.filter(board => {
          // 检查开发板的 type 字段是否包含指定的 core
          if (board.type && typeof board.type === 'string') {
            // 支持多种格式：esp32:esp32, arduino:avr, aily:esp32 等
            return board.type.toLowerCase().includes(core.value.toLowerCase());
          }
          return false;
        });
      }

      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(filteredBoardList)))
      );

      console.log('按核心架构过滤后的开发板列表:', this.boardList);

      // 如果有过滤结果，选择第一个开发板
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      } else {
        this.currentBoard = null;
      }
    } else {
      // 如果选择"显示全部"或没有选中核心架构，显示所有开发板（已按使用次数排序）
      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
      );
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    }
  }

  changeViewMode(mode: string) {
    this.listMode = mode;

    // 根据不同模式进行初始化
    if (mode === 'core') {
      // 如果切换到核心架构模式，重置选择状态
      this.selectedCore = null;
      // 显示所有开发板
      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
      );
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    } else if (mode === 'brand') {
      // 如果切换到品牌模式，重置选择状态
      this.selectedBrand = null;
      // 显示所有开发板
      this.boardList = this.applyLocalization(
        this.filterBoardsForCategory(JSON.parse(JSON.stringify(this._boardList)))
      );
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    }
  }

  nextStepFromProjectHub() {
    this.router.navigate(['main', 'playground', 'list'], { queryParams: { board: this.currentBoard.name } })
    // this.router.navigate(['/main/playground']);
  }

  private applyLocalization(list: any[]) {
    const lang = this.translate.currentLang;
    for (const board of list) {
      board._nickname = (lang && board[`nickname_${lang}`]) || board.nickname || '';
      board._description = (lang && board[`description_${lang}`]) || board.description || '';
    }
    return list;
  }
}


/** Coder 新建项目可选的 framework 值（来自 coder_board_index.json） */
export type CoderFramework = string;

export interface BoardInfo {
  "name": string, // 开发板在仓库中的名称开发板名称
  "nickname": string, // 显示的开发板名称
  "version": string,
  "img": string,
  "description": string,
  "url": string,
  "brand": string,
  "type"?: string, // 开发板类型/核心架构 (如 esp32:esp32, arduino:avr, etc)
  "mode"?: string[]
}

interface CloudProjectTemplate {
  name: string;
  nickname?: string;
  description?: string;
}
