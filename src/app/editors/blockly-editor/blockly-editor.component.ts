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
import { DevToolComponent } from './components/dev-tool/dev-tool.component';
import { HistoryService } from './services/history.service';
import { OnboardingService } from '../../services/onboarding.service';
import { BLOCKLY_ONBOARDING_CONFIG } from '../../configs/onboarding.config';

@Component({
  selector: 'app-blockly-editor',
  imports: [
    BlocklyComponent,
    LibManagerComponent,
    NotificationComponent,
    TranslateModule,
    DevToolComponent
  ],
  providers: [
    _BuilderService,
    _UploaderService,
    BitmapUploadService
  ],
  templateUrl: './blockly-editor.component.html',
  styleUrl: './blockly-editor.component.scss'
})
export class BlocklyEditorComponent {
  showLibraryManager = false;

  devmode;

  get developerMode() {
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
    private _uploadService: _UploaderService,
    private onboardingService: OnboardingService
  ) { }

  ngOnInit(): void {
    this.activatedRoute.queryParams.subscribe(params => {
      if (params['path']) {
        console.log('project path', params['path']);
        try {
          this._projectService.currentProjectPath = params['path']
          this.projectService.currentProjectPath = params['path'];
          // this._projectService.initHistory(); // 初始化历史服务
          this.loadProject(params['path']);
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
    this._projectService.destroy();
    this._builderService.cancel();
    this._builderService.destroy();
    this._uploadService.cancel();
    this._uploadService.destroy();
    this.electronService.setTitle('aily blockly');
    this.blocklyService.reset();
  }

  async loadProject(projectPath) {
    // 加载项目package.json
    const packageJson = JSON.parse(this.electronService.readFile(`${projectPath}/package.json`));
    // 加载项目开发框架
    this.devmode = packageJson.devmode || 'arduino'; // 可选项: 'arduino', 'micropython'

    this.electronService.setTitle(`aily blockly - ${packageJson.nickname}`);
    // 添加到最近打开的项目
    this.projectService.addRecentlyProject({ name: packageJson.name, path: projectPath, nickname: packageJson.nickname || packageJson.name });
    // 设置当前项目路径和package.json数据
    this._projectService.currentPackageData = packageJson;
    this.projectService.currentPackageData = packageJson;
    window['packageJson'] = packageJson;
    // 暴露 ProjectService 到全局，供 generator.js 使用
    window['projectService'] = this.projectService;

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

    await new Promise(resolve => setTimeout(resolve, 120));

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
    this.projectService.stateSubject.next('loaded');

    // 检查是否需要显示新手引导
    this.checkBlocklyOnboarding();

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
    if (this.blocklyService.checkAiWaiting()) {
      return;
    }
    this.uiService.closeToolAll();
    this.showLibraryManager = !this.showLibraryManager;
    this.cd.detectChanges();
  }

  // 检查是否需要显示新手引导
  private checkBlocklyOnboarding() {
    const hasSeenOnboarding = this.configService.data.blocklyOnboardingCompleted;
    if (!hasSeenOnboarding) {
      // 延迟显示引导，确保 Blockly 工作区已完全渲染
      setTimeout(() => {
        this.onboardingService.start(BLOCKLY_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 800);
    }
  }

  // 引导关闭或完成时的处理
  private onOnboardingClosed() {
    this.configService.data.blocklyOnboardingCompleted = true;
    this.configService.save();
  }

  // 测试用
  reload() {
    this.projectService.projectOpen();
  }
}
