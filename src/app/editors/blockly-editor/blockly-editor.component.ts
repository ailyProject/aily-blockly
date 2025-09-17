import { ChangeDetectorRef, Component } from '@angular/core';
import { LibManagerComponent } from './components/lib-manager/lib-manager.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { UiService } from '../../services/ui.service';
import { TranslateModule } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';
import { NpmService } from '../../services/npm.service';
import { CmdService } from '../../services/cmd.service';
import { BlocklyService } from './services/blockly.service';
import { BlocklyComponent } from './components/blockly/blockly.component';
import { _ProjectService } from './services/project.service';
import { _UploaderService } from './services/uploader.service';
import { _BuilderService } from './services/builder.service';
import { BitmapUploadService } from './services/bitmap-upload.service';
import { ProjectService } from '../../services/project.service';

@Component({
  selector: 'app-blockly-editor',
  imports: [
    BlocklyComponent,
    LibManagerComponent,
    NotificationComponent,
    TranslateModule
  ],
  providers: [
    _ProjectService,
    _BuilderService,
    _UploaderService,
    BitmapUploadService
  ],
  templateUrl: './blockly-editor.component.html',
  styleUrl: './blockly-editor.component.scss'
})
export class BlocklyEditorComponent {
  showLibraryManager = false;

  get devmode() {
    return this.configService.data.devmode;
  }

  constructor(
    private cd: ChangeDetectorRef,
    private uiService: UiService,
    private activatedRoute: ActivatedRoute,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private configService: ConfigService,
    private npmService: NpmService,
    private cmdService: CmdService,
    private projectService: ProjectService,
    private _projectService: _ProjectService,
    private _builderService: _BuilderService,
    private _uploadService: _UploaderService
  ) { }

  ngOnInit(): void {
    this.activatedRoute.queryParams.subscribe(params => {
      if (params['path']) {
        console.log('project path', params['path']);
        try {
          this._projectService.currentProjectPath = params['path']
          this.loadProject();
        } catch (error) {
          console.error('加载项目失败', error);
          this.message.error('加载项目失败，请检查项目文件是否完整');
        }
      } else {
        this.message.error('没有找到项目路径');
      }
    });

    this._projectService.init();
    this._builderService.init();
    this._uploadService.init();

    // 阻止鼠标按键前进后退
    window.history.replaceState(null, '', window.location.href);
    window.history.pushState(null, '', window.location.href);
  }

  ngOnDestroy(): void {
    this._builderService.cancel();
    this._builderService.destroy();
    this._uploadService.cancel();
    this._uploadService.destroy();
    this.electronService.setTitle('aily blockly');
    this.blocklyService.reset();
  }

  async loadProject(projectPath = this._projectService.currentProjectPath) {
    await new Promise(resolve => setTimeout(resolve, 100));
    // 加载项目package.json
    const packageJson = JSON.parse(this.electronService.readFile(`${projectPath}/package.json`));

    this.electronService.setTitle(`aily blockly - ${packageJson.name}`);
    this.projectService.currentProjectPath = projectPath;
    // 添加到最近打开的项目
    this.projectService.addRecentlyProject({ name: packageJson.name, path: projectPath });
    // 设置当前项目路径和package.json数据
    this._projectService.currentPackageData = packageJson;

    // 检查是否有node_modules目录，没有则安装依赖，有则跳过
    const nodeModulesExist = this.electronService.exists(projectPath + '/node_modules');
    if (!nodeModulesExist) {
      // 终端进入项目目录，安装项目依赖
      this.uiService.updateFooterState({ state: 'doing', text: '正在安装依赖' });
      await this.cmdService.runAsync(`npm install`, projectPath)
    }
    // 3. 加载开发板module中的board.json
    this.uiService.updateFooterState({ state: 'doing', text: '正在加载开发板配置' });
    const boardJson = await this.projectService.getBoardJson();

    this.projectService.currentBoardConfig = boardJson;
    this.blocklyService.boardConfig = boardJson;
    window['boardConfig'] = boardJson;
    // 4. 加载blockly library
    this.uiService.updateFooterState({ state: 'doing', text: '正在加载blockly库' });
    // 获取项目目录下的所有blockly库
    let libraryModuleList = (await this.npmService.getAllInstalledLibraries(projectPath)).map(item => item.name);
    for (let index = 0; index < libraryModuleList.length; index++) {
      const libPackageName = libraryModuleList[index];
      this.uiService.updateFooterState({ state: 'doing', text: '正在加载' + libPackageName });
      await this.blocklyService.loadLibrary(libPackageName, projectPath);
    }
    // 5. 加载project.abi数据
    this.uiService.updateFooterState({ state: 'doing', text: '正在加载blockly程序' });
    let jsonData = JSON.parse(this.electronService.readFile(`${projectPath}/project.abi`));
    this.blocklyService.loadAbiJson(jsonData);

    // 6. 加载项目目录中project.abi（这是blockly格式的json文本必须要先安装库才能加载这个json，因为其中可能会用到一些库）
    this.uiService.updateFooterState({ state: 'done', text: '项目加载成功' });

    // this.projectService.stateSubject.next('loaded');

    // 7. 后台安装开发板依赖
    this.npmService.installBoardDeps()
      .then(() => {
        console.log('install board dependencies success');
      })
      .catch(err => {
        console.error('install board dependencies error', err);
      });
  }

  openProjectManager() {
    this.uiService.closeToolAll();
    this.showLibraryManager = !this.showLibraryManager;
    this.cd.detectChanges();
  }

  // 测试用
  reload() {
    this.loadProject();
  }
}
