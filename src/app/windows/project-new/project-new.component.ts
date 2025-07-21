import { Component } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
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

const { pt } = (window as any)['electronAPI'].platform;

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
    TranslateModule
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent {
  currentStep = 0;

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
  boardList: any[] = [];
  tagListRandom;

  get resourceUrl() {
    return this.configService.data.resource[0];
  }

  constructor(
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private npmService: NpmService
  ) { }

  async ngOnInit() {
    if (this.electronService.isElectron) {
      this.newProjectData.path = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    }
    await this.configService.init();
    this._boardList = this.process(await this.configService.loadBoardList());
    this.boardList = JSON.parse(JSON.stringify(this._boardList));
    this.currentBoard = this.boardList[0];

    // 随机提取前五个
    this.tagListRandom = this.tagList.sort(() => Math.random() - 0.5).slice(0, 5);

    this.newProjectData.board.nickname = this.currentBoard.nickname;
    this.newProjectData.board.name = this.currentBoard.name;
    this.newProjectData.board.version = this.currentBoard.version;
    this.newProjectData.name = this.projectService.generateUniqueProjectName(this.newProjectData.path)
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
      this.boardList = this._boardList.filter(item => item.fulltext.includes(keyword));
    } else {
      this.boardList = JSON.parse(JSON.stringify(this._boardList));
    }
  }

  selectBoard(boardInfo: BoardInfo) {
    // if (boardInfo.disabled) return;
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

    await this.projectService.projectNew(this.newProjectData);

    // setTimeout(() => {
    //   window['subWindow'].close();
    // }, 1000);
  }

  openUrl(url) {
    this.electronService.openUrl(url);
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
  "disabled": boolean, // 是否禁用
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
