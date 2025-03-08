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
import { generateDateString } from '../../func/func';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { TerminalService } from '../../tools/terminal/terminal.service';
import { UiService } from '../../services/ui.service';
import { NpmService } from '../../services/npm.service';

@Component({
  selector: 'app-project-new',
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    NzButtonModule,
    NzInputModule,
    NzStepsModule,
    NzSelectModule
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent {
  currentStep = 0;

  boardList: any[] = [];
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

  constructor(
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private terminalService: TerminalService,
    private uiService: UiService,
    private npmService: NpmService
  ) { }

  async ngOnInit() {
    if (this.electronService.isElectron) {
      this.newProjectData.path = window['path'].getUserDocuments() + '\\';
    }
    this.boardList = await this.configService.loadBoardList();
    this.currentBoard = this.boardList[0];

    this.newProjectData.board.nickname = this.currentBoard.nickname;
    this.newProjectData.board.name = this.currentBoard.name;
    this.newProjectData.board.version = this.currentBoard.version;
    this.newProjectData.name = 'project_' + generateDateString();

    // 终端操作
    let { pid } = await this.uiService.openTerminal();
    console.log('终端pid：', pid);

    this.terminalService.currentPid = pid;
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
    this.newProjectData.path = folderPath + '\\';
    // 在这里对返回的 folderPath 进行后续处理
  }

  // 检查项目名称是否存在
  showIsExist = false;
  async checkPathIsExist(): Promise<boolean> {
    let path = this.newProjectData.path + '/' + this.newProjectData.name;
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
    if (this.electronService.isElectron) {
      window['other'].openByBrowser(url);
    }
  }
}


export interface BoardInfo {
  "name": string, // 开发板在仓库中的名称开发板名称
  "nickname": string, // 显示的开发板名称
  "version": string,
  "img": string,
  "description": string,
  "url": string,
  "brand": string
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