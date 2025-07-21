import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { UiService } from './ui.service';
import { NewProjectData } from '../windows/project-new/project-new.component';
import { BlocklyService } from '../blockly/blockly.service';
import { ElectronService } from './electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { pinyin } from "pinyin-pro";
import { Router } from '@angular/router';
import { CmdService } from './cmd.service';
import { generateDateString } from '../func/func';

const { pt } = (window as any)['electronAPI'].platform;
import { ConfigService } from './config.service';
import { ESP32_CONFIG_MENU } from '../configs/esp32.config';

interface ProjectPackageData {
  name: string;
  version?: string;
  author?: string;
  description?: string;
  path?: string;
  board?: string;
  type?: string;
  framework?: string;
}

@Injectable({
  providedIn: 'root',
})
export class ProjectService {

  stateSubject = new BehaviorSubject<'default' | 'loading' | 'loaded' | 'saving' | 'saved' | 'error'>('default');
  currentPackageData: ProjectPackageData = {
    name: 'aily blockly',
  };

  projectRootPath: string;
  currentProjectPath: string;
  currentBoardConfig: any;
  // currentProjectConfig: any[]; // 编译和上传配置

  isMainWindow = false;
  isInstalling = false;

  constructor(
    private uiService: UiService,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private router: Router,
    private cmdService: CmdService,
    private configService: ConfigService
  ) {
  }

  // 初始化UI服务，这个init函数仅供main-window使用
  async init() {
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

      // 监听来自文件关联的打开请求
      window['ipcRenderer'].on('open-project-from-file', async (event, projectPath) => {
        console.log('Received open-project-from-file event:', projectPath);
        try {
          await this.projectOpen(projectPath);
          console.log('Successfully opened project from file association');
        } catch (error) {
          console.error('Error opening project from file association:', error);
          this.message.error('无法打开项目: ' + error.message);
        }
      });

      this.projectRootPath = (await window['env'].get("AILY_PROJECT_PATH")).replace('%HOMEPATH%\\Documents', window['path'].getUserDocuments());
      this.currentProjectPath = this.projectRootPath;
    }
  }

  // 检测字符串是否包含中文字符
  containsChineseCharacters(str: string): boolean {
    const chineseRegex = /[\u4e00-\u9fa5]/;
    return chineseRegex.test(str);
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData, closeWindow: boolean = true) {
    console.log('newProjectData: ', newProjectData);
    const appDataPath = window['path'].getAppData();
    // const projectPath = (newProjectData.path + newProjectData.name).replace(/\s/g, '_');
    const projectPath = window['path'].join(newProjectData.path, newProjectData.name.replace(/\s/g, '_'));
    const boardPackage = newProjectData.board.name + '@' + newProjectData.board.version;

    this.uiService.updateFooterState({ state: 'doing', text: '正在创建项目...' });
    await this.cmdService.runAsync(`npm install ${boardPackage} --prefix "${appDataPath}"`);
    const templatePath = `${appDataPath}\\node_modules\\${newProjectData.board.name}\\template`;
    // 创建项目目录
    await this.cmdService.runAsync(`mkdir -p "${projectPath}"`);
    // 复制模板文件到项目目录
    await this.cmdService.runAsync(`cp -r "${templatePath}\\*" "${projectPath}"`);

    // 3. 修改package.json文件
    const packageJson = JSON.parse(window['fs'].readFileSync(`${projectPath}/package.json`));
    if (this.containsChineseCharacters(newProjectData.name)) {
      packageJson.name = pinyin(newProjectData.name, {
        toneType: "none",
        separator: ""
      }).replace(/\s/g, '_');
    } else {
      packageJson.name = newProjectData.name;
    }

    window['fs'].writeFileSync(`${projectPath}/package.json`, JSON.stringify(packageJson, null, 2));

    this.uiService.updateFooterState({ state: 'done', text: '项目创建成功' });
    // 此后就是打开项目(projectOpen)的逻辑，理论可复用，由于此时在新建项目窗口，因此要告知主窗口，进行打开项目操作
    await window['iWindow'].send({ to: 'main', data: { action: 'open-project', path: projectPath } });
    
    if (closeWindow) {
      this.uiService.closeWindow();
    }
  }

  // 打开项目
  async projectOpen(projectPath = this.currentProjectPath) {
    await this.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    // 判断路径是否存在
    if (!this.electronService.exists(projectPath)) {
      this.removeRecentlyProject({ path: projectPath })
      return this.message.error('项目路径不存在，请重新选择项目');
    }
    this.stateSubject.next('loading');

    // 更新当前项目路径和包数据
    this.currentProjectPath = projectPath;

    const abiIsExist = window['path'].isExists(projectPath + '/project.abi');
    if (abiIsExist) {
      // 打开blockly编辑器
      this.router.navigate(['/main/blockly-editor'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    } else {
      // 打开代码编辑器
      this.router.navigate(['/main/code-editor'], {
        queryParams: {
          path: projectPath
        },
        replaceUrl: true
      });
    }
  }

  // 保存项目
  save(path = this.currentProjectPath) {
    // 导出blockly json配置并保存
    // console.log('save path: ', path);
    const jsonData = this.blocklyService.getWorkspaceJson();
    window['fs'].writeFileSync(`${path}/project.abi`, JSON.stringify(jsonData, null, 2));
    this.stateSubject.next('saved');
  }

  saveAs(path) {
    //在当前路径下创建一个新的目录
    window['fs'].mkdirSync(path);
    // 复制项目目录到新路径
    window['fs'].copySync(this.currentProjectPath, path);
    // 修改package.json文件
    this.save(path);
    // 修改package.json文件
    const packageJson = JSON.parse(window['fs'].readFileSync(`${path}/package.json`));
    // 获取新的项目名称
    let name = path.split('\\').pop();
    packageJson.name = name;
    window['fs'].writeFileSync(`${path}/package.json`, JSON.stringify(packageJson, null, 2));
    // 修改当前项目路径
    this.currentProjectPath = path;
    this.currentPackageData = packageJson;
    this.addRecentlyProject({ name: this.currentPackageData.name, path: path });
  }

  async close() {
    this.currentProjectPath = '';
    this.currentPackageData = {
      name: 'aily blockly',
    };
    this.stateSubject.next('default');
    this.uiService.closeTerminal();
    this.currentProjectPath = (await window['env'].get("AILY_PROJECT_PATH")).replace('%HOMEPATH%\\Documents', window['path'].getUserDocuments());
    this.router.navigate(['/main/guide'], { replaceUrl: true });
  }

  // 通过ConfigService存储最近打开的项目
  get recentlyProjects(): any[] {
    return this.configService.data?.recentlyProjects || [];
  }

  set recentlyProjects(data) {
    this.configService.data.recentlyProjects = data;
    this.configService.save();
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

  // 检查项目是否未保存
  async hasUnsavedChanges(): Promise<boolean> {
    // 如果项目尚未加载，则没有未保存的更改
    if (this.stateSubject.value === 'default' || !this.currentProjectPath) {
      return false;
    }

    try {
      // 获取当前工作区的 JSON 数据
      const currentWorkspaceJson = this.blocklyService.getWorkspaceJson();

      // 读取并解析已保存的 JSON 数据
      const savedJsonStr = window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8');
      const savedJson = JSON.parse(savedJsonStr);

      // 将当前工作区 JSON 和保存的 JSON 转为字符串进行比较
      const currentJsonStr = JSON.stringify(currentWorkspaceJson);
      const normalizedSavedJsonStr = JSON.stringify(savedJson);

      // 比较两个 JSON 字符串是否相同
      return currentJsonStr !== normalizedSavedJsonStr;
    } catch (error) {
      console.error('检查未保存更改时出错:', error);
      // 出错时，保守地返回 true，表示可能有未保存的更改
      return true;
    }
  }

  generateUniqueProjectName(prjPath, prefix = 'project_'): string {
    const baseDateStr = generateDateString();
    prefix = prefix + baseDateStr;

    // 尝试使用字母后缀 a-z
    for (let charCode = 97; charCode <= 122; charCode++) {
      const suffix = String.fromCharCode(charCode);
      const projectName: string = prefix + suffix;
      const projectPath = prjPath + pt + projectName;

      if (!window['path'].isExists(projectPath)) {
        return projectName;
      }
    }

    // 如果所有字母都已使用，则使用数字后缀
    let numberSuffix = 0;
    while (true) {
      const projectName = prefix + 'a' + numberSuffix;
      const projectPath = prjPath + pt + projectName;

      if (!window['path'].isExists(projectPath)) {
        return projectName;
      }

      numberSuffix++;

      // 安全检查，防止无限循环
      if (numberSuffix > 1000) {
        return prefix + 'a' + Date.now(); // 极端情况下使用时间戳
      }
    }
  }

  // 获取当前项目的package.json
  async getPackageJson() {
    if (!this.currentProjectPath) {
      throw new Error('当前项目路径未设置');
    }
    const packageJsonPath = `${this.currentProjectPath}/package.json`;
    return JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
  }

  async setPackageJson(data: any) {
    if (!this.currentProjectPath) {
      throw new Error('当前项目路径未设置');
    }
    const packageJsonPath = `${this.currentProjectPath}/package.json`;
    // 写入新的package.json
    window['fs'].writeFileSync(packageJsonPath, JSON.stringify(data, null, 2));
  }

  // 获取开发板名称
  async getBoardModule() {
    const prjPackageJson = await this.getPackageJson();
    return Object.keys(prjPackageJson.dependencies).find(dep => dep.startsWith('@aily-project/board-'));
  }

  // 获取开发板模块的package.json
  async getBoardPackageJson() {
    const boardModule = await this.getBoardModule();
    const boardPackageJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/package.json`;
    return JSON.parse(this.electronService.readFile(boardPackageJsonPath));
  }

  // 获取开发板配置文件board.json
  async getBoardJson() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/board.json`;
    if (!window['fs'].existsSync(boardJsonPath)) {
      throw new Error('开发板配置文件不存在: ' + boardJsonPath);
    }
    return JSON.parse(this.electronService.readFile(boardJsonPath));
  }

  // 获取开发板 SDK 路径
  async getSdkPath() {
    try {
      const boardPackageJson = await this.getBoardPackageJson();
      if (!boardPackageJson || !boardPackageJson.boardDependencies) {
        throw new Error('未找到开发板 SDK 路径');
      }

      const sdkModule = Object.keys(boardPackageJson.boardDependencies).find(dep => dep.startsWith('@aily-project/sdk-'));
      if (!sdkModule) {
        throw new Error('未找到开发板 SDK 模块');
      }

      const appDataPath = window['path'].getAppData()

      const sdkLibPath = `${appDataPath}/node_modules/${sdkModule}`;
      if (!window['fs'].existsSync(sdkLibPath)) {
        throw new Error('SDK 库路径不存在: ' + sdkLibPath);
      }

      // Get all files in the SDK library path
      const sdkFiles = window['fs'].readDirSync(sdkLibPath);

      // Filter for .7z files
      const sdkZipFiles = sdkFiles.filter(file => file.name.endsWith('.7z'));

      // If there are no .7z files, throw an error
      if (sdkZipFiles.length === 0) {
        throw new Error('未找到 SDK 压缩包文件');
      }

      // Replace '@' with '_' in the filename
      const sdkZipFileName = sdkZipFiles[0].name;
      const formattedSdkZipFileName = sdkZipFileName.replace(/@/g, '_').replace(/\.7z$/i, '');

      // sdk path
      return `${await window["env"].get('AILY_SDK_PATH')}/${formattedSdkZipFileName}`;
    } catch (error) {
      console.error('获取 SDK 路径失败:', error);
      return "";
    }
  }

  // 解析boards.txt并获取ESP32配置信息
  async getEsp32BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      // 提取需要的配置项
      const esp32Config = {
        uploadSpeed: this.extractMenuOptions(boardConfig, 'UploadSpeed'),
        flashMode: this.extractMenuOptions(boardConfig, 'FlashMode'),
        flashSize: this.extractMenuOptions(boardConfig, 'FlashSize'),
        partitionScheme: this.extractMenuOptions(boardConfig, 'PartitionScheme')
      };

      return esp32Config;
    } catch (error) {
      console.error('获取ESP32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt文件内容，提取指定开发板的配置
  private parseBoardsConfig(lines: string[], boardName: string): { [key: string]: string } | null {
    const config: { [key: string]: string } = {};
    let foundBoard = false;
    let currentBoard = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // 检查是否是开发板名称定义
      const nameMatch = trimmedLine.match(/^(\w+)\.name=(.+)$/);
      if (nameMatch) {
        currentBoard = nameMatch[1];
        foundBoard = (currentBoard === boardName);
        if (foundBoard) {
          config[`${currentBoard}.name`] = nameMatch[2];
        }
        continue;
      }

      // 如果找到了目标开发板，继续收集配置
      if (foundBoard && trimmedLine.startsWith(`${boardName}.`)) {
        const configMatch = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (configMatch) {
          config[configMatch[1]] = configMatch[2];
        }
      }

      // 如果遇到了新的开发板定义且不是目标开发板，停止收集
      if (foundBoard && nameMatch && nameMatch[1] !== boardName) {
        break;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  // 比较FlashMode配置是否完全匹配
  private compareFlashModeConfig(childBuild: any, currentBuild: any): boolean {
    // FlashMode相关的配置项
    const flashModeKeys = ['flash_mode', 'boot', 'boot_freq', 'flash_freq'];

    for (const key of flashModeKeys) {
      // 如果子配置中有这个键，那么必须与当前配置匹配
      if (childBuild.hasOwnProperty(key)) {
        if (childBuild[key] !== currentBuild[key]) {
          return false;
        }
      }
    }

    return true;
  }

  // 通用的配置比较方法
  private compareConfigs(childData: any, currentData: any, configKeys: string[]): boolean {
    if (!childData || !currentData) {
      return false;
    }

    // 检查build配置
    if (childData.build && currentData.build) {
      for (const key of configKeys) {
        if (childData.build.hasOwnProperty(key)) {
          if (childData.build[key] !== currentData.build[key]) {
            return false;
          }
        }
      }
    }

    // 检查upload配置
    if (childData.upload && currentData.upload) {
      const uploadKeys = Object.keys(childData.upload);
      for (const key of uploadKeys) {
        if (childData.upload[key] !== currentData.upload[key]) {
          return false;
        }
      }
    }

    return true;
  }

  // 提取菜单选项
  private extractMenuOptions(boardConfig: { [key: string]: string }, menuType: string): any[] {
    const options: any[] = [];
    const boardName = Object.keys(boardConfig)[0].split('.')[0];
    const menuPrefix = `${boardName}.menu.${menuType}.`;

    // 首先收集所有选项的基本信息
    const optionKeys = new Set<string>();

    for (const key in boardConfig) {
      if (key.startsWith(menuPrefix)) {
        const remainingPath = key.replace(menuPrefix, '');
        const optionKey = remainingPath.split('.')[0];

        // 只处理主选项，不处理子属性
        if (!remainingPath.includes('.') || remainingPath.split('.').length === 2) {
          optionKeys.add(optionKey);
        }
      }
    }

    // 为每个选项构建完整的配置对象
    optionKeys.forEach(optionKey => {
      const mainKey = `${menuPrefix}${optionKey}`;
      const optionName = boardConfig[mainKey];

      if (optionName) {
        const option = {
          name: optionName,
          key: menuType,
          data: {
            build: {},
            upload: {}
          },
          check: false
        };

        // 收集该选项的所有相关配置
        for (const key in boardConfig) {
          if (key.startsWith(`${menuPrefix}${optionKey}.`)) {
            const configPath = key.replace(`${menuPrefix}${optionKey}.`, '');
            const pathParts = configPath.split('.');

            if (pathParts.length === 2) {
              const category = pathParts[0]; // build 或 upload
              const property = pathParts[1]; // partitions, maximum_size 等

              if (category === 'build' || category === 'upload') {
                option.data[category][property] = boardConfig[key];
              }
            }
          }
        }

        // 清理空的配置对象
        if (Object.keys(option.data.build).length === 0) {
          delete option.data.build;
        }
        if (Object.keys(option.data.upload).length === 0) {
          delete option.data.upload;
        }
        if (Object.keys(option.data).length === 0) {
          delete option.data;
        }

        options.push(option);
      }
    });
    return options;
  }

  // 更新ESP32配置菜单项
  async updateEsp32ConfigMenu(boardName: string) {
    try {
      const boardConfig = await this.getEsp32BoardConfig(boardName);
      console.log('获取到的ESP32开发板配置:', boardConfig);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      try {
        const packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      // 导入ESP32_CONFIG_MENU，需要动态导入以避免循环依赖
      // const { ESP32_CONFIG_MENU } = await import('../configs/esp32.config');
      let ESP32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(ESP32_CONFIG_MENU));

      // 更新菜单项
      ESP32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'ESP32.UPLOAD_SPEED' && boardConfig.uploadSpeed) {
          menuItem.children = boardConfig.uploadSpeed;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadSpeed) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              // 使用通用比较方法检查当前配置是否匹配
              if (this.compareConfigs(child.data, currentProjectConfig.UploadSpeed, ['speed'])) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_MODE' && boardConfig.flashMode) {
          // console.log('boardConfig.flashMode:', boardConfig.flashMode);
          menuItem.children = boardConfig.flashMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (child.data && child.data.build && currentProjectConfig.FlashMode.build) {
                // 检查FlashMode的所有相关配置项是否完全匹配
                const childBuild = child.data.build;
                const currentBuild = currentProjectConfig.FlashMode.build;

                const isMatched = this.compareFlashModeConfig(childBuild, currentBuild);
                if (isMatched) {
                  child.check = true;
                }
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_SIZE' && boardConfig.flashSize) {
          menuItem.children = boardConfig.flashSize;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashSize) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashSize, ['flash_size'])) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.PARTITION_SCHEME' && boardConfig.partitionScheme) {
          menuItem.children = boardConfig.partitionScheme;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.PartitionScheme) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.PartitionScheme, ['partitions', 'maximum_size'])) {
                child.check = true;
              }
            });
          }
        }
      });
      return ESP32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新ESP32配置菜单失败:', error);
      return null;
    }
  }

  // 获取项目配置
  async getProjectConfig() {
    try {
      const packageJson = await this.getPackageJson();
      if (!packageJson || !packageJson.projectConfig) {
        throw new Error('项目配置未找到或格式不正确');
      }

      return packageJson.projectConfig;
    } catch (error) {
      console.info('获取项目配置失败:', error);
      return {}
    }
  }

  async changeBoard(boardInfo: { "name": string, "version": string }) {
    try {
      if (!this.currentProjectPath) {
        throw new Error('当前项目路径未设置');
      }
      // 0. 保存当前项目
      this.save();
      this.message.loading('正在切换开发板...', { nzDuration: 5000 });
      // 1. 先获取项目package.json中的board依赖，如@aily-project/board-xxxx，然后npm uninstall移除这个board依赖
      const currentBoardModule = await this.getBoardModule();
      if (currentBoardModule) {
        console.log('卸载当前开发板模块:', currentBoardModule);
        this.uiService.updateFooterState({ state: 'doing', text: '正在卸载当前开发板...' });
        await this.cmdService.runAsync(`npm uninstall ${currentBoardModule}`, this.currentProjectPath);
      }
      // 2. npm install 安装boardInfo.name@boardInfo.version
      const newBoardPackage = `${boardInfo.name}@${boardInfo.version}`;
      console.log('安装新开发板模块:', newBoardPackage);
      this.uiService.updateFooterState({ state: 'doing', text: '正在安装新开发板...' });
      await this.cmdService.runAsync(`npm install ${newBoardPackage}`, this.currentProjectPath);
      // 3. 重新加载项目
      console.log('重新加载项目...');
      await this.projectOpen(this.currentProjectPath);
      this.uiService.updateFooterState({ state: 'done', text: '开发板切换完成' });
      this.message.success('开发板切换成功', { nzDuration: 3000 });
    } catch (error) {
      console.error('切换开发板失败:', error);
      this.message.error('开发板切换失败: ' + error.message);
    }
  }
}