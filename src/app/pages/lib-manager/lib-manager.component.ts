import { ChangeDetectorRef, Component, EventEmitter, Output } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NpmService } from '../../services/npm.service';
import { ConfigService } from '../../services/config.service';
import { ProjectService } from '../../services/project.service';
import { BlocklyService } from '../../blockly/blockly.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CompatibleDialogComponent } from './components/compatible-dialog/compatible-dialog.component';
import { CmdOutput, CmdService } from '../../services/cmd.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-lib-manager',
  imports: [
    FormsModule,
    CommonModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzSelectModule,
    NzTagModule,
    TranslateModule
  ],
  templateUrl: './lib-manager.component.html',
  styleUrl: './lib-manager.component.scss'
})
export class LibManagerComponent {

  @Output() close = new EventEmitter();

  keyword: string = '';
  tagList: string[] = [];
  libraryList: PackageInfo[] = [];
  _libraryList: PackageInfo[] = [];
  installedPackageList: string[] = [];
  tagListRandom;

  loading = false;

  constructor(
    private npmService: NpmService,
    private configService: ConfigService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private electronService: ElectronService
  ) { }

  ngOnInit() {
    // 使用翻译初始化标签列表
    this.tagList = [
      this.translate.instant('LIB_MANAGER.SENSORS'),
      this.translate.instant('LIB_MANAGER.ACTUATORS'),
      this.translate.instant('LIB_MANAGER.COMMUNICATION'),
      this.translate.instant('LIB_MANAGER.DISPLAY'),
      // this.translate.instant('LIB_MANAGER.SOUND'),
      this.translate.instant('LIB_MANAGER.STORAGE'),
      this.translate.instant('LIB_MANAGER.ROBOT'),
      this.translate.instant('LIB_MANAGER.AI'),
      this.translate.instant('LIB_MANAGER.IOT'),
    ];

    this.configService.loadLibraryList().then(async (data: any) => {
      this._libraryList = this.process(data);
      // this.libraryList = JSON.parse(JSON.stringify(this._libraryList));
      this.libraryList = await this.checkInstalled();
      this.cd.detectChanges();
    });
  }

  async checkInstalled(libraryList = null) {
    let isNull = false;
    if (libraryList === null) {
      isNull = true;
      libraryList = JSON.parse(JSON.stringify(this._libraryList));
    }
    // 获取已经安装的包，用于在界面上显示"移除"按钮
    let installedLibraries = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
    installedLibraries = installedLibraries.map(item => {
      item['state'] = 'installed';
      item['fulltext'] = `installed${item.name}${item.nickname}${item.keywords}${item.description}${item.brand}`.replace(/\s/g, '').toLowerCase();
      return item;
    });

    // console.log('所有库列表：', libraryList);
    // console.log('已安装的库列表：', installedLibraries);
    // 遍历installedLibraries, 如果this.libraryList存在name相同的库，则将installedLibraries中的库合并到this.libraryList中
    libraryList.forEach(lib => {
      const installedLib = installedLibraries.find(installed => installed.name === lib.name);
      if (installedLib) {
        Object.assign(lib, installedLib);
      } else {
        lib.state = 'default'; // 如果没有安装，则设置状态为默认
      }
    });

    // 将只存在于installedLibraries中但不在libraryList中的库添加到libraryList中
    if (isNull) {
      installedLibraries.forEach(installedLib => {
        const existsInLibraryList = libraryList.find(lib => lib.name === installedLib.name);
        if (!existsInLibraryList) {
          // 为新添加的库设置默认属性
          installedLib['versionList'] = [installedLib.version];
          libraryList.push(installedLib);
        }
      });
    }

    // console.log('合并后的库列表：', libraryList);
    return libraryList;
  }

  // 处理库列表数据，为显示做准备
  process(array) {
    for (let index = 0; index < array.length; index++) {
      const item = array[index];
      // 为版本选择做准备
      item['versionList'] = [item.version];
      // 为状态做准备
      item['state'] = 'default'; // default, installed, installing, uninstalling
      // 为全文搜索做准备
      item['fulltext'] = `${item.name}${item.nickname}${item.keywords}${item.description}${item.brand}`.replace(/\s/g, '').toLowerCase();
    }
    return array;
  }

  async search(keyword = this.keyword) {
    if (keyword) {
      keyword = keyword.replace(/\s/g, '').toLowerCase();

      // 处理翻译后的特殊关键词
      const installedKey = this.translate.instant('LIB_MANAGER.INSTALLED').toLowerCase();
      const coreLibKey = this.translate.instant('LIB_MANAGER.CORE_LIBRARY').toLowerCase();

      if (keyword === installedKey) {
        keyword = 'installed';
      } else if (keyword === coreLibKey) {
        keyword = 'lib-core-';
      } else if (keyword === 'ai') {
        keyword = 'artificialintelligence';
      }

      // 使用indexOf过滤并记录关键词位置，然后按位置排序
      let libraryList = await this.checkInstalled();
      const matchedItems = libraryList
        .map(item => {
          const index = item.fulltext.indexOf(keyword);
          return { item, index };
        })
        .filter(({ index }) => index !== -1)
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item);

      this.libraryList = matchedItems;
    } else {
      this.libraryList = await this.checkInstalled();
    }
  }

  back() {
    this.close.emit();
  }

  async getVerisons(lib) {
    this.loading = true;
    lib.versionList = this.npmService.getPackageVersionList(lib.name);
    this.loading = false;
  }

  currentStreamId;
  output = '';
  isInstalling = false;
  async installLib(lib) {
    // 检查库兼容性
    // console.log('当前开发板内核：', this.projectService.currentBoardConfig.core.replace('aily:', ''));
    // console.log('当前库兼容内核：', JSON.stringify(lib.compatibility.core));
    if (!await this.checkCompatibility(lib.compatibility.core, this.projectService.currentBoardConfig.core.replace('aily:', ''))) {
      return;
    }
    // console.log('当前项目路径：', this.projectService.currentProjectPath);
    this.isInstalling = true;
    let packageList_old = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
    // console.log('当前已安装的库列表：', packageList_old);

    lib.state = 'installing';
    this.message.loading(`${lib.nickname} ${this.translate.instant('LIB_MANAGER.INSTALLING')}...`);
    this.output = '';
    await this.cmdService.runAsync(`npm install ${lib.name}@${lib.version}`, this.projectService.currentProjectPath)
    this.libraryList = await this.checkInstalled(this.libraryList);
    // lib.state = 'default';
    this.message.success(`${lib.nickname} ${this.translate.instant('LIB_MANAGER.INSTALLED')}`);

    let packageList_new = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
    // console.log('新的已安装的库列表：', packageList_new);
    // 比对相较于旧的已安装库列表，找出新增的库
    const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
    // console.log('新增的库：', newPackages);
    for (const pkg of newPackages) {
      this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
    }
    this.isInstalling = false;
  }

  async removeLib(lib) {
    // 移除库前，应先检查项目代码是否使用了该库，如果使用了，应提示用户
    lib.state = 'uninstalling';
    this.message.loading(`${lib.nickname} ${this.translate.instant('LIB_MANAGER.UNINSTALLING')}...`);
    const libPackagePath = this.projectService.currentProjectPath + '\\node_modules\\' + lib.name;
    this.blocklyService.removeLibrary(libPackagePath);
    this.output = '';
    await this.cmdService.runAsync(`npm uninstall ${lib.name}`, this.projectService.currentProjectPath);
    this.libraryList = await this.checkInstalled(this.libraryList);
    // lib.state = 'default';
    this.message.success(`${lib.nickname} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
  }

  async checkCompatibility(libCompatibility, boardCore): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!libCompatibility || libCompatibility.length == 0 || libCompatibility.includes(boardCore)) {
      return true;
    }
    // 遍历libCompatibility，判断每个元素是否包含boardCore
    for (let i = 0; i < libCompatibility.length; i++) {
      const element = libCompatibility[i];
      if (element.includes(boardCore)) {
        return true;
      }
    }

    return new Promise<boolean>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '360px',
        nzContent: CompatibleDialogComponent,
        nzData: { libCompatibility, boardCore },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
            resolve(false);
            break;
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  openExample(packageName) {
    this.electronService.openNewInStance('/main/playground/s/' + packageName.replace('@aily-project/', ''))
  }

  async importLib() {
    try {
      // 弹出文件夹选择对话框
      const folderPath = await window['ipcRenderer'].invoke('select-folder', {
        path: this.projectService.currentProjectPath,
      });

      // 如果用户取消选择，返回
      if (!folderPath || folderPath === this.projectService.currentProjectPath) {
        return;
      }

      // console.log('选择的文件夹路径：', folderPath);

      // 检查选择的路径下是否有package.json、block.json、generator.js文件
      const hasPackageJson = await this.electronService.exists(folderPath + '/package.json');
      const hasBlockJson = await this.electronService.exists(folderPath + '/block.json');
      const hasGeneratorJs = await this.electronService.exists(folderPath + '/generator.js');

      if (!hasPackageJson || !hasBlockJson || !hasGeneratorJs) {
        this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: 该路径下不是aily blockly库`);
        return;
      }

      this.message.loading(`${this.translate.instant('LIB_MANAGER.IMPORTING')}...`);

      // 获取安装前的库列表
      let packageList_old = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('导入前已安装的库列表：', packageList_old);

      // 使用 npm install 安装本地库
      await this.cmdService.runAsync(`npm install "${folderPath}"`, this.projectService.currentProjectPath);

      // 重新检查已安装的库
      await this.checkInstalled();

      this.message.success(`${this.translate.instant('LIB_MANAGER.IMPORTED')}`);

      // 获取安装后的库列表并加载新增的库
      let packageList_new = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('导入后已安装的库列表：', packageList_new);

      // 比对相较于旧的已安装库列表，找出新增的库
      const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
      // console.log('新导入的库：', newPackages);

      // 加载新增的库到 Blockly
      for (const pkg of newPackages) {
        this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
      }
    } catch (error) {
      console.error('导入库失败：', error);
      this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: ${error.message || error}`);
    }
  }

  help() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/blob/main/readme.md');
  }

  report() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/issues');
  }
}

interface PackageInfo {
  "name": string,
  "nickname": string,
  "scope"?: string,
  "description"?: string,
  "version"?: string,
  "versionList"?: string[],
  "keywords"?: string[],
  "date"?: string,
  "author"?: {
    "name"?: string
  },
  icon?: string,
  "publisher"?: any,
  "maintainers"?: any[],
  "links"?: any,
  "brand"?: string,
  "fulltext"?: string,
  tested: boolean,
  state: 'default' | 'installed' | 'installing' | 'uninstalling',
  example?: string
}
