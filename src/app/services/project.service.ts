import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { ResponseModel } from '../interfaces/response.interface';
import { API } from '../configs/api.config';
import { UiService } from './ui.service';
import { NewProjectData } from '../windows/project-new/project-new.component';
import { TerminalService } from '../tools/terminal/terminal.service';
import { BlocklyService } from '../blockly/blockly.service';
import { ElectronService } from './electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';

interface ProjectData {
  name: string;
  version: string;
  author: string;
  description: string;
  path: string;
  board: string;
  type: string;
  framework: string;
}

@Injectable({
  providedIn: 'root',
})
export class ProjectService {

  stateSubject = new BehaviorSubject<'default' | 'loading' | 'loaded' | 'saving' | 'saved'>('default');

  projectData: ProjectData = {
    name: 'aily blockly',
    version: '1.0.0',
    path: '',
    author: '',
    description: '',
    board: '',
    type: 'web',
    framework: 'angular',
  };

  currentProject: string;

  isMainWindow = false;

  constructor(
    private http: HttpClient,
    private uiService: UiService,
    private terminalService: TerminalService,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private message: NzMessageService,
  ) {
    window['ipcRenderer'].on('project-update', (event, data) => {
      console.log('收到更新的: ', data);
      this.currentProject = data.path;
      this.projectOpen(this.currentProject);
    });
  }

  // 初始化UI服务，这个init函数仅供main-window使用  
  init(): void {
    if (this.electronService.isElectron) {
      this.isMainWindow = true;
      window['ipcRenderer'].on('window-receive', async (event, message) => {
        console.log('window-receive', message);
        if (message.data.action == 'open-project') {
          this.projectOpen(message.data.path);
        } else {
          return;
        }
        // 反馈完成结果
        if (message.messageId) {
          window['ipcRenderer'].send('main-window-response', {
            messageId: message.messageId,
            result: "success"
          });
        }
      });
    }
  }

  /**
   * 库列表
   * @param data
   */
  list(data: any) {
    return this.http.get<ResponseModel>(API.projectList, {
      params: data,
    });
  }

  /**
   * 库搜索
   * @param data
   * @param data.text 搜索关键字
   * @param data.size
   * @param data.from
   * @param data.quality
   * @param data.popularity
   * @param data.maintenance
   */
  search(data: any) {
    return this.http.get<ResponseModel>(API.projectSearch, {
      params: data,
    });
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData) {
    console.log('newProjectData: ', newProjectData);
    const appDataPath = window['path'].getAppData();
    const projectPath = newProjectData.path + newProjectData.name
    const boardPackage = newProjectData.board.value + '@' + newProjectData.board.version;
    const registry = 'https://registry.openjumper.cn';

    this.uiService.updateState({ state: 'loading', text: '正在创建项目...' });
    // 1. 检查开发板module是否存在, 不存在则安装
    await this.uiService.openTerminal();
    await this.terminalService.sendCmd(`npm install ${boardPackage} --prefix ${appDataPath} --registry=${registry}`);
    // 2. 创建项目目录，复制开发板module中的template到项目目录
    const templatePath = `${appDataPath}/node_modules/${newProjectData.board.value}/template`;
    // powsershell命令创建目录并复制文件（好处是可以在终端显示出过程，以后需要匹配mac os和linux的命令（陈吕洲 2025.3.4））
    await this.terminalService.sendCmd(`New-Item -Path "${projectPath}" -ItemType Directory -Force`);
    await this.terminalService.sendCmd(`Copy-Item -Path "${templatePath}\\*" -Destination "${projectPath}" -Recurse -Force`);
    // node命令创建目录并复制文件
    // window['file'].mkdirSync(projectPath);
    // window['file'].copySync(templatePath, projectPath);
    // 3. 修改package.json文件
    const packageJson = JSON.parse(window['file'].readFileSync(`${projectPath}/package.json`));
    packageJson.name = newProjectData.name;
    window['file'].writeFileSync(`${projectPath}/package.json`, JSON.stringify(packageJson, null, 2));

    this.uiService.updateState({ state: 'done', text: '项目创建成功' });
    // 此后就是打开项目(projectOpen)的逻辑，理论可复用，由于此时在新建项目窗口，因此要告知主窗口，进行打开项目操作
    await window['iWindow'].send({ to: 'main', data: { action: 'open-project', path: projectPath } });
    this.uiService.closeWindow();
  }

  // 打开项目
  async projectOpen(projectPath) {
    this.stateSubject.next('loading');
    const registry = 'https://registry.openjumper.cn';
    this.uiService.updateState({ state: 'loading', text: '正在打开项目...' });
    // this.uiService.
    // 0. 判断路径是否存在
    const pathExist = window['path'].isExists(projectPath);
    if (!pathExist) {
      console.error('path not exist: ', projectPath);
      this.message.warning('该项目路径不存在');
      this.removeRecentlyProject({ path: projectPath })
      return false;
    }
    // 加载项目package.json
    const packageJson = JSON.parse(window['file'].readFileSync(`${projectPath}/package.json`));
    // 添加到最近打开的项目
    this.addRecentlyProject({ name: packageJson.name, path: projectPath });
    // 1. 终端进入项目目录
    await this.uiService.openTerminal();
    console.log('currentPid: ', this.terminalService.currentPid);
    await this.terminalService.sendCmd(`cd ${projectPath}`);
    // 2. 安装项目依赖
    this.uiService.updateState({ state: 'loading', text: '正在安装依赖' });
    await this.terminalService.sendCmd(`npm install --registry=${registry}`);
    // 3. 加载开发板module中的board.json
    this.uiService.updateState({ state: 'loading', text: '正在加载开发板配置' });
    const boardModule = Object.keys(packageJson.dependencies).find(dep => dep.startsWith('@aily-project/board-'));
    console.log('boardModule: ', boardModule);
    let boardJsonPath = projectPath + '\\node_modules\\' + boardModule + '\\board.json';
    console.log('boardJsonPath: ', boardJsonPath);
    const boardJson = JSON.parse(window['file'].readFileSync(boardJsonPath));
    this.blocklyService.loadBoardConfig(boardJson);
    // 4. 加载blockly library
    this.uiService.updateState({ state: 'loading', text: '正在加载blockly库' });
    const libraryModuleList = Object.keys(packageJson.dependencies).filter(dep => dep.startsWith('@aily-project/lib-'));
    console.log('libraryModuleList: ', libraryModuleList);
    for (let index = 0; index < libraryModuleList.length; index++) {
      const libPackageName = libraryModuleList[index];
      const libPackagePath = projectPath + '\\node_modules\\' + libPackageName;
      this.blocklyService.loadLibrary(libPackagePath);
    }
    // 5. 加载project.abi数据
    this.uiService.updateState({ state: 'loading', text: '正在加载blockly程序' });
    let jsonData = JSON.parse(window['file'].readFileSync(`${projectPath}/project.abi`));
    this.blocklyService.loadAbiJson(jsonData);

    // 6. 加载项目目录中project.abi（这是blockly格式的json文本必须要先安装库才能加载这个json，因为其中可能会用到一些库）
    this.uiService.updateState({ state: 'done', text: '项目加载成功' });
    this.stateSubject.next('loaded');
    // 7. 后台安装开发板依赖
    this.installBoardDependencies();
    // this.uiService.updateState({ state: 'loading', text: '项目加载中...' });

    // // 读取package.json文件
    // const packageJsonContent = window['file'].readFileSync(`${path}/package.json`);
    // if (!packageJsonContent) {
    //   console.error('package.json not exist: ', path);
    //   return false;
    // }
    // this.projectData = JSON.parse(packageJsonContent);
    // this.currentProject = path;

    // // 设置项目路径到环境变量
    // window["env"].set({ key: "AILY_PRJ_PATH", value: path });

    // // 判断是否需要安装package.json依赖
    // if (!window['path'].isExists(`${path}/node_modules`)) {
    //   await this.dependencies_install(`${path}/package.json`);
    // }
    // this.loaded.next(true);

  }

  installBoardDependencies() {
    // 检查开发板依赖是否安装，未安装则安装

    // 7. 检查开发板依赖（compiler、sdk、tool）是否安装，安装开发板依赖（开发板依赖要编译时才用到，用户可以先编程，开发板依赖在后台安装）
    let board = 'xxxxx';
    this.uiService.updateState({ state: 'loading', text: '正在安装' + board });
    // 8. 完成
    this.uiService.updateState({ state: 'done', text: board + '安装成功' });
    // 9. 安装开发板依赖（开发板依赖要编译时才用到，用户可以先编程，开发板依赖在后台安装）
    this.stateSubject.next('loaded');
  }

  // 保存项目
  projectSave() {
    // 导出blockly json配置并保存


  }


  // 另存为项目
  projectSaveAs() { }

  // 读取package.json文件
  readPackageJson(path) {
    const packageJsonContent = window['file'].readFileSync(path);
    if (!packageJsonContent) {
      console.error('package.json not exist: ', path);
      return {};
    }

    return JSON.parse(packageJsonContent);
  }

  /**
   * 依赖安装
   * @param packageJsonPath 项目package.json文件路径
   * @returns 
   */
  async dependencies_install(packageJsonPath) {
    // 安装依赖
    await this.install_package({ file: packageJsonPath });
  }


  /**
   * 板子核心依赖安装
   * @param packageJsonPath 项目package.json文件路径
   * @returns 
   */
  async board_dependencies_install(packageJsonPath) {
    // 获取packageJson所在目录
    const path = packageJsonPath.substring(0, packageJsonPath.lastIndexOf('/'));

    const packageJsonContent = this.readPackageJson(packageJsonPath);
    if (!packageJsonContent) {
      console.error('package.json not exist: ', packageJsonPath);
      return false;
    }
    const boardDeps = Object.keys(packageJsonContent.dependencies || {}).filter(dep => dep.startsWith('@aily-project/board-'));
    for (const dep of boardDeps) {
      // 分解依赖项名称
      const depParts = dep.split('/');
      const depParent = depParts[0];
      const depName = depParts[1];

      const depPath = path + '/node_modules/' + depParent + '/' + depName;
      const pkgPackageJsonPath = depPath + '/package.json';

      // 读取板子的package.json文件
      const pkgPackageJsonContent = this.readPackageJson(pkgPackageJsonPath);
      if (!pkgPackageJsonContent) {
        console.error('package.json not exist: ', pkgPackageJsonPath);
        continue;
      }
      const boardDependencies = pkgPackageJsonContent.boardDependencies || {};

      console.log('boardDependencies: ', boardDependencies);

      for (const [depName, depVersion] of Object.entries(boardDependencies)) {
        const pkg = `${depName}@${depVersion}`;

        this.uiService.updateState({ state: 'loading', text: '安装依赖: ' + pkg });
        await this.install_package({
          package: pkg,
          global: true,
        });
      }
    }
    this.uiService.updateState({ state: 'done', text: '开发板依赖安装成功', timeout: 5000 });
  }

  // 安装依赖
  async install_package(data) {
    console.log("install Data: ", data);
    const installResult = await window['dependencies'].install(data);
    if (!installResult.success) {
      console.error('install failed: ', installResult);
      return false;
    }
  }

  // 通过localStorage存储最近打开的项目
  get recentlyProjects(): any[] {
    let data;
    let dataStr = localStorage.getItem('recentlyProjects')
    if (dataStr) {
      data = JSON.parse(dataStr);
    } else {
      data = [];
    }
    return data
  }

  set recentlyProjects(data) {
    localStorage.setItem('recentlyProjects', JSON.stringify(data));
  }

  addRecentlyProject(data: { name: string, path: string }) {
    let temp: any[] = this.recentlyProjects
    temp.unshift(data);
    temp = temp.filter((item, index) => {
      return temp.findIndex((item2) => item2.path === item.path) === index;
    });
    if (temp.length > 6) {
      temp.pop();
    }
    this.recentlyProjects = temp;
  }

  removeRecentlyProject(data: { path: string }) {
    let temp: any[] = this.recentlyProjects
    temp = temp.filter((item) => {
      return item.path !== data.path;
    });
    this.recentlyProjects = temp;
  }

}
