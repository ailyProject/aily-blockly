import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
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
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { createBoardSearchIndex, searchBoards } from '../../utils/fuzzy-search.utils';
import type { AnyOrama } from '@orama/orama';

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
  boardList: any[] = [];

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private searchIndex: AnyOrama | null = null;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
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
    private translate: TranslateService
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
    if (this.electronService.isElectron) {
      const pt = this.platformService.getPlatformSeparator();
      this.newProjectData.path = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    }

    // 切换标题
    // this.electronService.setTitle('PROJECT_NEW.TITLE');

    await this.configService.init();

    // 先处理开发板列表数据
    let processedBoardList = this.process(this.configService.boardList);

    // 按使用次数排序
    this._boardList = this.configService.sortBoardsByUsage(processedBoardList);

    this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));

    // 使用 selectBoard 方法来初始化，确保触发 checkHasExamples
    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    }
    this.newProjectData.name = this.projectService.generateUniqueProjectName(this.newProjectData.path, 'project_');
    this.checkPathInvalidChars();
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
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
      this.cd.detectChanges();
      return;
    }

    // 使用 Orama 进行模糊搜索
    const localizedList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
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
  selectBoard(boardInfo: any) {
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo._nickname || boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
    this.newProjectData.devmode = boardInfo.mode ? this.currentBoard.mode[0] : 'arduino';
    this.devmodes = boardInfo.mode;
    this.checkHasExamples(boardInfo.name);
  }

  checkHasExamples(boardName: string) {
    this.hasExamples = false;
    this.cloudService.getPublicProjects(1, 1, '', '', boardName).subscribe(res => {
      if (res && res.status === 200 && res.data && res.data.total > 0) {
        this.hasExamples = true;
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
    this.currentStep = 2;

    // 记录开发板使用次数
    this.configService.recordBoardUsage(this.newProjectData.board.name);

    await this.projectService.projectNew(this.newProjectData);
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
        this.boardList = this.applyLocalization(this.configService.sortBoardsByUsage(filteredBoardList));
      } else {
        // 普通品牌过滤
        let filteredBoardList = this._boardList.filter(board => {
          const boardBrand = board.brand ? board.brand.toLowerCase() : '';
          const selectedBrandValue = brand.value.toLowerCase();
          return boardBrand === selectedBrandValue
        });
        // 对过滤后的列表按使用次数排序
        this.boardList = this.applyLocalization(this.configService.sortBoardsByUsage(filteredBoardList));
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
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
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
        filteredBoardList = this._boardList.filter(board => {
          if (board.type && typeof board.type === 'string') {
            const boardType = board.type.toLowerCase();
            // 检查是否包含任何已定义的核心架构
            return !definedCores.some(definedCore => boardType.includes(definedCore));
          }
          return true; // 如果没有 type 字段，也算作 other
        });
      } else {
        // 普通核心架构过滤
        filteredBoardList = this._boardList.filter(board => {
          // 检查开发板的 type 字段是否包含指定的 core
          if (board.type && typeof board.type === 'string') {
            // 支持多种格式：esp32:esp32, arduino:avr, aily:esp32 等
            return board.type.toLowerCase().includes(core.value.toLowerCase());
          }
          return false;
        });
      }

      // 对过滤后的列表按使用次数排序
      this.boardList = this.applyLocalization(this.configService.sortBoardsByUsage(filteredBoardList));

      console.log('按核心架构过滤后的开发板列表:', this.boardList);

      // 如果有过滤结果，选择第一个开发板
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      } else {
        this.currentBoard = null;
      }
    } else {
      // 如果选择"显示全部"或没有选中核心架构，显示所有开发板（已按使用次数排序）
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
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
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    } else if (mode === 'brand') {
      // 如果切换到品牌模式，重置选择状态
      this.selectedBrand = null;
      // 显示所有开发板
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
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

export interface NewProjectData {
  name: string,
  path: string,
  board: {
    name: string,
    nickname: string,
    version: string
  },
  devmode?: string
}
