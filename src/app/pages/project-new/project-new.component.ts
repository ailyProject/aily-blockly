import { Component } from '@angular/core';
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
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Router } from '@angular/router';
import { BrandListComponent } from './components/brand-list/brand-list.component';
import { BRAND_LIST } from '../../configs/board.config';

const { pt } = (window as any)['electronAPI'].platform;

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
    BrandListComponent
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent {
  currentStep = 0;
  selectedBrand: any = null;

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

  tagList = [
    { name: '显示全部', mode: 'all' },
    { name: '按品牌', mode: 'brand' },
    { name: '按核心', mode: 'core' },
    { name: '按功能', mode: 'function' },
  ];

  _boardList: any[] = [];
  boardList: any[] = [];

  get resourceUrl() {
    return this.configService.data.resource[0];
  }

  // 获取已定义的品牌列表（排除'all'和'other'）
  private getDefinedBrands(): string[] {
    return BRAND_LIST
      .filter(brand => brand.value !== 'all' && brand.value !== 'other')
      .map(brand => brand.value.toLowerCase());
  }

  constructor(
    private router: Router,
    private location: Location,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private npmService: NpmService,
  ) { }

  async ngOnInit() {
    if (this.electronService.isElectron) {
      this.newProjectData.path = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    }

    // 切换标题
    // this.electronService.setTitle('PROJECT_NEW.TITLE');

    await this.configService.init();
    
    // 先处理开发板列表数据
    let processedBoardList = this.process(this.configService.boardList);
    
    // 按使用次数排序
    this._boardList = this.configService.sortBoardsByUsage(processedBoardList);
    
    this.boardList = JSON.parse(JSON.stringify(this._boardList));
    this.currentBoard = this.boardList[0];

    this.newProjectData.board.nickname = this.currentBoard.nickname;
    this.newProjectData.board.name = this.currentBoard.name;
    this.newProjectData.board.version = this.currentBoard.version;
    this.newProjectData.name = this.projectService.generateUniqueProjectName(this.newProjectData.path, 'project_');
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
    if (keyword) {
      keyword = keyword.replace(/\s/g, '').toLowerCase();
      let filteredBoardList = this._boardList.filter(item => item.fulltext.includes(keyword));
      // 对搜索结果按使用次数排序
      this.boardList = this.configService.sortBoardsByUsage(filteredBoardList);
    } else {
      // 恢复完整列表（已按使用次数排序）
      this.boardList = JSON.parse(JSON.stringify(this._boardList));
    }
  }

  selectBoard(boardInfo: BoardInfo) {
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
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
    if (folderPath.slice(-1) !== pt) {
      this.newProjectData.path = folderPath + pt;
    }
    // 在这里对返回的 folderPath 进行后续处理
  }

  // 检查项目名称是否存在
  showIsExist = false;
  async checkPathIsExist(): Promise<boolean> {
    let path = this.newProjectData.path + pt + this.newProjectData.name;
    let isExist = window['path'].isExists(path);
    if (isExist) {
      this.showIsExist = true;
    } else {
      this.showIsExist = false;
    }
    return isExist;
  }

  async createProject() {
    // 判断是否有同名项目
    if (await this.checkPathIsExist()) {
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

  onBrandSelected(brand: any) {
    this.selectedBrand = brand;
    console.log('选中的品牌:', brand);

    // 根据选中的品牌过滤开发板列表
    if (brand && brand.value && brand.value !== 'all') {
      if (brand.value === 'other') {
        // 当选择"其他品牌"时，显示已有品牌列表未覆盖的元素
        const definedBrands = this.getDefinedBrands();
        let filteredBoardList = this._boardList.filter(board => {
          const boardBrand = board.brand ? board.brand.toLowerCase() : '';
          return !definedBrands.includes(boardBrand);
        });
        // 对过滤后的列表按使用次数排序
        this.boardList = this.configService.sortBoardsByUsage(filteredBoardList);
      } else {
        // 普通品牌过滤
        let filteredBoardList = this._boardList.filter(board => {
          const boardBrand = board.brand ? board.brand.toLowerCase() : '';
          const selectedBrandValue = brand.value.toLowerCase();
          return boardBrand === selectedBrandValue
        });
        // 对过滤后的列表按使用次数排序
        this.boardList = this.configService.sortBoardsByUsage(filteredBoardList);
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
      this.boardList = JSON.parse(JSON.stringify(this._boardList));
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
    }
  }

  changeViewMode(mode) {

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
}

export interface NewProjectData {
  name: string,
  path: string,
  board: {
    name: string,
    nickname: string,
    version: string
  }
}
