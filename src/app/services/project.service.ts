import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { UiService } from './ui.service';
import { NewProjectData } from '../windows/project-new/project-new.component';
import { ElectronService } from './electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { pinyin } from "pinyin-pro";
import { Router } from '@angular/router';
import { CmdService } from './cmd.service';
import { generateDateString } from '../func/func';
import { ConfigService } from './config.service';
import { ESP32_CONFIG_MENU } from '../configs/esp32.config';
import { STM32_CONFIG_MENU } from '../configs/stm32.config';
import { ActionService } from './action.service';
import { PlatformService } from './platform.service';

interface ProjectPackageData {
  name: string;
  nickname?: string;
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

  // 开发板变更事件通知，只在变更时发出
  boardChangeSubject = new Subject<void>();

  currentPackageData: ProjectPackageData = {
    name: 'aily blockly',
  };

  projectRootPath: string;
  currentProjectPath: string;
  currentBoardConfig: any;
  // STM32选择开发板时定义引脚使用
  currentStm32Config: { board: any, variant: any, variant_h: any } = { board: null, variant: null, variant_h: null };

  constructor(
    private uiService: UiService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private router: Router,
    private cmdService: CmdService,
    private configService: ConfigService,
    private actionService: ActionService,
    private platformService: PlatformService,
  ) {
  }

  // 初始化UI服务，这个init函数仅供main-window使用
  async init() {
    if (this.electronService.isElectron) {
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
      // if (!this.currentProjectPath) {
      //   this.currentProjectPath = this.projectRootPath;
      // }
    }
  }

  // 检测字符串是否包含中文字符
  containsChineseCharacters(str: string): boolean {
    const chineseRegex = /[\u4e00-\u9fa5]/;
    return chineseRegex.test(str);
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData, closeWindow: boolean = true) {
    // console.log('newProjectData: ', newProjectData);
    const appDataPath = window['path'].getAppDataPath();
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

    // if (closeWindow) {
    //   this.uiService.closeWindow();
    // }
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
    this.actionService.dispatch('project-save', { path }, result => {
      if (result.success) {
        this.stateSubject.next('saved');
      } else {
        console.warn('项目保存失败:', result.error);
      }
    });
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

    return new Promise((resolve) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        console.log(result);
        resolve(result.data.hasUnsavedChanges);
      });
    });
  }

  // 获取当前项目的package.json
  async getPackageJson() {
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

    this.boardChangeSubject.next();
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

  // 获取开发板特殊配置文件，如 STM32 需要的特殊配置
  async getJsonConfig(fileName: string) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const configPath = `${this.currentProjectPath}/node_modules/${boardModule}/${fileName}`;
    if (!window['fs'].existsSync(configPath)) {
      throw new Error('配置文件不存在: ' + configPath);
    }
    return JSON.parse(this.electronService.readFile(configPath));
  }

  // 修改开发板配置文件board.json， 如 STM32需要，传入新的data
  async setBoardJson(data: any) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardJsonPath = `${this.currentProjectPath}/node_modules/${boardModule}/board.json`;
    if (!window['fs'].existsSync(boardJsonPath)) {
      throw new Error('开发板配置文件不存在: ' + boardJsonPath);
    }

    // 保存当前项目
    this.save();
    this.message.loading('正在切换开发板配置...', { nzDuration: 5000 });

    const boardJson = JSON.parse(this.electronService.readFile(boardJsonPath));
    Object.assign(boardJson, data);
    window['fs'].writeFileSync(boardJsonPath, JSON.stringify(boardJson, null, 2));

    // 重新加载项目
    console.log('重新加载项目...');
    await this.projectOpen(this.currentProjectPath);

    // 通知开发板变更
    this.boardChangeSubject.next();
    this.uiService.updateFooterState({ state: 'done', text: '开发板切换完成' });
    this.message.success('开发板切换成功', { nzDuration: 3000 });
  }

  // 获取开发板package路径
  async getBoardPackagePath() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardPackagePath = `${this.currentProjectPath}/node_modules/${boardModule}`;
    return boardPackagePath;
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

      const appDataPath = window['path'].getAppDataPath()

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

  // // 解析boards.txt并获取配置信息
  // async getBoardConfig(boardName: string, boardType: string) {

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
        uploadMode: this.extractMenuOptions(boardConfig, 'UploadMode'),
        flashMode: this.extractMenuOptions(boardConfig, 'FlashMode'),
        flashSize: this.extractMenuOptions(boardConfig, 'FlashSize'),
        partitionScheme: this.extractMenuOptions(boardConfig, 'PartitionScheme'),
        cdcOnBoot: this.extractMenuOptions(boardConfig, 'CDCOnBoot')
      };

      return esp32Config;
    } catch (error) {
      console.error('获取ESP32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt并获取STM32配置信息
  async getStm32BoardConfig(boardName: string) {
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

      // console.log('====boardConfig:', boardConfig);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      const stm32Config = {
        board: this.extractMenuOptions(boardConfig, 'pnum'),
        usb: this.extractMenuOptions(boardConfig, 'usb'),
        upload_method: this.extractMenuOptions(boardConfig, 'upload_method'),
      };

      // 只保留 name 字段中包含 "Generic" 的选项，其它全部去掉
      if (stm32Config.board && Array.isArray(stm32Config.board)) {
        stm32Config.board = stm32Config.board.filter(item => item.name && item.name.includes('Generic'));
      }

      return stm32Config;
    } catch (error) {
      console.error('获取STM32开发板配置失败:', error);
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

      // 以boardName.开头的行表示当前开发板的配置
      if (!foundBoard) {
        if (trimmedLine.startsWith(`${boardName}.`)) {
          foundBoard = true;
          currentBoard = boardName;
        }
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
  private compareConfigs(childData: any, currentData: any): boolean {
    if (!childData || !currentData) {
      return false;
    }

    if (childData && currentData) {
      if (childData !== currentData) {
        return false;
      }
    }
    // // 检查build配置
    // if (childData.build && currentData.build) {
    //   for (const key of configKeys) {
    //     if (childData.build.hasOwnProperty(key)) {
    //       if (childData.build[key] !== currentData.build[key]) {
    //         return false;
    //       }
    //     }
    //   }
    // }

    // // 检查upload配置
    // if (childData.upload && currentData.upload) {
    //   const uploadKeys = Object.keys(childData.upload);
    //   for (const key of uploadKeys) {
    //     if (childData.upload[key] !== currentData.upload[key]) {
    //       return false;
    //     }
    //   }
    // }

    return true;
  }

  // 提取菜单选项
  private extractMenuOptions(boardConfig: { [key: string]: string }, menuType: string): any[] {
    const options: any[] = [];
    const boardName = Object.keys(boardConfig)[0].split('.')[0];
    const menuPrefix = `${boardName}.menu.${menuType}.`;

    // 首先收集所有选项的基本信息
    const optionDatas = new Set<string>();

    for (const key in boardConfig) {
      if (key.startsWith(menuPrefix)) {
        const remainingPath = key.replace(menuPrefix, '');
        const optionData = remainingPath.split('.')[0];

        // 只处理主选项，不处理子属性
        if (!remainingPath.includes('.') || remainingPath.split('.').length === 2) {
          optionDatas.add(optionData);
          // console.log('Found option data:', optionData);
        }
      }
    }

    // 构建选项列表，只包含key和data，key为menuType，data为optionData
    optionDatas.forEach(optionData => {
      const option = {
        name: boardConfig[`${menuPrefix}${optionData}`] || optionData,
        key: menuType,
        data: optionData,
        check: false,
        // // 其他属性 如 build.variant
        extra: {
          build: {
            variant: boardConfig[`${menuPrefix}${optionData}.build.variant`] || '',
            variant_h: boardConfig[`${menuPrefix}${optionData}.build.variant_h`] || ''
          }
        }
      }

      // console.log(`==========>>>${menuPrefix}${optionData}:`, boardConfig[`${menuPrefix}${optionData}.build.variant`] || '');
      // console.log('option:', option);

      // 清理空的配置对象
      if (Object.keys(option.data).length === 0) {
        delete option.data;
      }

      options.push(option);
    });

    // // 为每个选项构建完整的配置对象
    // optionKeys.forEach(optionKey => {
    //   const mainKey = `${menuPrefix}${optionKey}`;
    //   const optionName = boardConfig[mainKey];

    //   if (optionName) {
    //     const option = {
    //       name: optionName,
    //       key: menuType,
    //       data: {
    //         build: {},
    //         upload: {}
    //       },
    //       check: false
    //     };

    //     // 收集该选项的所有相关配置
    //     for (const key in boardConfig) {
    //       if (key.startsWith(`${menuPrefix}${optionKey}.`)) {
    //         const configPath = key.replace(`${menuPrefix}${optionKey}.`, '');
    //         const pathParts = configPath.split('.');

    //         if (pathParts.length === 2) {
    //           const category = pathParts[0]; // build 或 upload
    //           const property = pathParts[1]; // partitions, maximum_size 等

    //           if (category === 'build' || category === 'upload') {
    //             option.data[category][property] = boardConfig[key];
    //           }
    //         }
    //       }
    //     }

    //     // 清理空的配置对象
    //     if (Object.keys(option.data.build).length === 0) {
    //       delete option.data.build;
    //     }
    //     if (Object.keys(option.data.upload).length === 0) {
    //       delete option.data.upload;
    //     }
    //     if (Object.keys(option.data).length === 0) {
    //       delete option.data;
    //     }

    //     options.push(option);
    //   }
    // });
    return options;
  }

  // 更新ESP32配置菜单项
  async updateEsp32ConfigMenu(boardName: string) {
    try {
      const boardConfig = await this.getEsp32BoardConfig(boardName);
      // console.log('获取到的ESP32开发板配置:', boardConfig);

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
              if (this.compareConfigs(child.data, currentProjectConfig.UploadSpeed)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.UPLOAD_MODE' && boardConfig.uploadMode) {
          menuItem.children = boardConfig.uploadMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.UploadMode)) {
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
              if (this.compareConfigs(child.data, currentProjectConfig.FlashMode)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_SIZE' && boardConfig.flashSize) {
          menuItem.children = boardConfig.flashSize;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashSize) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashSize)) {
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
              if (this.compareConfigs(child.data, currentProjectConfig.PartitionScheme)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.CDC_ON_BOOT' && boardConfig.cdcOnBoot) {
          menuItem.children = boardConfig.cdcOnBoot;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.CDCOnBoot) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.CDCOnBoot)) {
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

  // 更新STM32配置菜单项
  async updateStm32ConfigMenu(boardName: string) {
    try {
      const boardConfig = await this.getStm32BoardConfig(boardName);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      let packageJson: any = {};
      try {
        packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      let STM32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(STM32_CONFIG_MENU));

      // 更新菜单项
      STM32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'STM32.BOARD' && boardConfig.board) {
          menuItem.children = boardConfig.board;
          // 根据当前项目配置设置check状态
          // console.log('menuItem.children:', menuItem.children);
          if (currentProjectConfig.pnum) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              if (this.compareConfigs(child.data, currentProjectConfig.pnum)) {
                child.check = true;
                // console.log('=============================================');
                // console.log('child:', child);
                this.currentStm32Config.board = child.data;
                this.currentStm32Config.variant = child.extra?.build.variant || null;
                this.currentStm32Config.variant_h = child.extra?.build.variant_h || null;
                // console.log('Selected STM32 pin config:', this.currentStm32Config);
                // console.log('=============================================');
              }
            });
          } else {
            // 如果项目配置中没有pnum，则默认选中第一个
            if (menuItem.children.length > 0) {
              menuItem.children[0].check = true;
              packageJson['projectConfig'] = packageJson['projectConfig'] || {};
              packageJson['projectConfig']['pnum'] = menuItem.children[0].data;
              // 更新项目配置
              this.setPackageJson(packageJson);
              this.compareStm32PinConfig(menuItem.children[0]);
            }
          }
        } else if (menuItem.name === 'STM32.USB' && boardConfig.usb) {
          menuItem.children = boardConfig.usb;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.usb) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.usb)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'STM32.UPLOAD_METHOD' && boardConfig.upload_method) {
          menuItem.children = boardConfig.upload_method;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.upload_method) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.upload_method)) {
                child.check = true;
              }
            });
          }
        }
      });
      return STM32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新STM32配置菜单失败:', error);
      return null;
    }
  }

  // 比较stm32引脚配置
  async compareStm32PinConfig(pinConfig: any): Promise<boolean> {
    // console.log('=============================================');
    // console.log('Comparing STM32 pin config:', pinConfig, "||", this.currentStm32Config);
    if (pinConfig.data == this.currentStm32Config.board) {
      return true;
    } else if (pinConfig.extra?.build.variant == this.currentStm32Config.variant) {
      return true;
    } else {
      let newPinConfig = pinConfig;

      // newPinConfig = this.parseGenericConfig(newPinConfig);
      // console.log('=============================================');
      // console.log('newPinConfig:', newPinConfig);

      let variant = newPinConfig.extra?.build.variant || null;
      let variant_h = newPinConfig.extra?.build.variant_h || 'variant_generic.h';

      const setPinConfig = await this.getVariantConfig(variant, variant_h);
      const currentBoardJson = await this.getBoardJson();

      let isChanged = false;

      if (typeof setPinConfig === 'object' && setPinConfig !== null) {
        Object.keys(setPinConfig).forEach(key => {
          if (Array.isArray(setPinConfig[key])) {
            if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(setPinConfig[key])) {
              currentBoardJson[key] = setPinConfig[key];
              isChanged = true;
            }
          }
        });
      }

      // 保存更新后的board.json
      if (isChanged) {
        await this.setBoardJson(currentBoardJson);
        this.currentStm32Config.board = pinConfig.data;
        this.currentStm32Config.variant = variant;
        this.currentStm32Config.variant_h = variant_h;
        // console.log('Updated STM32 pin config:', this.currentStm32Config);
      }

      // // // 获取到的config格式为“STM32F1xx/F100C(4-6)T”
      // // // 我们需要转换为“F1XXC”
      // // // 支持 STM32F1xx/F103C、STM32F4xx/F407V、STM32H7xx/H767Z、STM32C0xx/C030F 等
      // // const match = newPinConfig.match(/STM32([A-Z]\d?)xx\/[A-Z]\d{3}([A-Z])/i);
      // // if (match) {
      // //   // match[1] 可能是 F1、F4、H7、C0 等，match[2] 是主型号字母
      // //   newPinConfig = match[1].toUpperCase() + 'XX' + match[2].toUpperCase();
      // // }
      // // console.log('newPinConfig:', newPinConfig);
      // // 读取特殊配置文件
      // const newPinJson = await this.getJsonConfig(newPinConfig + '.pins.json');
      // // console.log('newPinJson:', newPinJson);
      // const currentBoardJson = await this.getBoardJson();
      // // console.log('currentBoardJson:', currentBoardJson);
      // let isChanged = false;
      // // 遍历newPinJson中的每一项，更新currentBoardJson中的对应项
      // if (typeof newPinJson === 'object' && newPinJson !== null) {
      //   // 如果 newPinJson 结构为 {analog: [...], digital: [...]}，则直接整体替换 currentBoardJson 的同名属性
      //   Object.keys(newPinJson).forEach(key => {
      //     // console.log(`Comparing key: ${key}`);
      //     if (Array.isArray(newPinJson[key])) {
      //       if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(newPinJson[key])) {
      //         currentBoardJson[key] = newPinJson[key];
      //         isChanged = true;
      //       }
      //     }
      //   });
      // } else {
      //   console.error('newPinJson 不是对象:', newPinJson);
      // }
      // // 保存更新后的board.json
      // if (isChanged) {
      //   await this.setBoardJson(currentBoardJson);
      //   this.currentStm32pinConfig = pinConfig;
      // }
      return false;
    }
  }

  // 根据传入的引脚信息解析引脚配置 如STM32F1xx/F100C(4-6)T
  async getVariantConfig(variant: string, variant_h: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const variantFilePath = `${sdkPath}/variants/${variant}/${variant_h}`;
      // console.log('variantFilePath:', variantFilePath);
      if (!window['fs'].existsSync(variantFilePath)) {
        throw new Error('引脚配置文件不存在: ' + variantFilePath);
      }

      const variantContent = window['fs'].readFileSync(variantFilePath, 'utf8');

      return this.parseVariantConfig(variantContent);
    } catch (error) {
      console.error('解析STM32引脚配置失败:', error);
    }
  }

  private parseVariantConfig(content: string): any {
    const analogPins: any[] = [];
    const digitalPins: any[] = [];
    const i2cPins: any = { Wire: [] };
    const spiPins: any = { SPI: [] };

    const lines = content.split(/\r?\n/);
    const digitalSet = new Set<string>();
    const i2cMap: any = {};
    const spiMap: any = {};

    // 宽松匹配多种 define 写法：PA0 PIN_A0 或 PIN_A0 PA0 等
    const analogRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(PIN_A\d+)\b/; // PA0  PIN_A0
    const analogRe2 = /^\s*#\s*define\s+(PIN_A\d+)\s+([A-Z]{1,3}\d{1,3})\b/; // PIN_A0 PA0

    const digitalRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(\d+|PIN_A\d+)\b/; // PA1  1  或 PA1 PIN_A0
    const digitalRe2 = /^\s*#\s*define\s+(PIN_[A-Z0-9_]+)\s+(\d+|[A-Z]{1,3}\d{1,3})\b/; // PIN_LED 13 或 PIN_A0 PA0

    const i2cRe = /^\s*#\s*define\s+PIN_WIRE_(SDA|SCL)\s+([A-Z]{1,3}\d{1,3})\b/;
    const i2cReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_WIRE_(SDA|SCL)\b/;

    const spiRe = /^\s*#\s*define\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\s+([A-Z]{1,3}\d{1,3})\b/;
    const spiReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\b/;

    for (const line of lines) {
      // 去掉行尾注释
      const pureLine = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\/\s*$/, '');

      // analog
      let m = analogRe1.exec(pureLine) || analogRe2.exec(pureLine);
      if (m) {
        // 统一为 [pinMacro, port]，优先保留 PIN_Ax 做第一个元素以兼容 gen_boards 输出
        if (m[1].startsWith('PIN_A')) {
          analogPins.push([m[1], m[2]]);
        } else {
          analogPins.push([m[2], m[1]]);
        }
      }

      // digital
      m = digitalRe1.exec(pureLine) || digitalRe2.exec(pureLine);
      if (m) {
        // m[1] 是名字或 PIN_ 前缀，根据捕获组位置不同处理
        let name = m[1];
        let val = m[2];
        // 如果捕获到 PIN_* 在第一位（digitalRe2），将 name 与 val 调换以保持一致
        if (name.startsWith('PIN_')) {
          // 如果包含SPI WIRE SERIAL等关键字，则跳过
          if (name.includes('PIN_SPI_') || name.includes('PIN_WIRE_') || name.includes('PIN_SERIAL_')) {
            continue;
          }
          // 保证唯一性，使用宏名或引脚名作为标识
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        } else {
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        }
      }

      // i2c
      m = i2cRe.exec(pureLine);
      if (m) {
        i2cMap[m[1]] = m[2];
      } else {
        m = i2cReAlt.exec(pureLine);
        if (m) {
          i2cMap[m[2]] = m[1]; // alt captures port then PIN_WIRE_x
        }
      }

      // spi
      m = spiRe.exec(pureLine);
      if (m) {
        let key = m[1];
        if (key.startsWith('SS')) key = 'SS';
        spiMap[key] = m[2];
      } else {
        m = spiReAlt.exec(pureLine);
        if (m) {
          let key = m[2];
          if (key.startsWith('SS')) key = 'SS';
          spiMap[key] = m[1];
        }
      }
    }

    // i2c 输出顺序 SDA, SCL
    if (i2cMap['SDA']) i2cPins.Wire.push(['SDA', i2cMap['SDA']]);
    if (i2cMap['SCL']) i2cPins.Wire.push(['SCL', i2cMap['SCL']]);

    // SPI 输出固定顺序 MOSI, MISO, SCK, SS
    const spiOrder = ['MOSI', 'MISO', 'SCK', 'SS'];
    for (const k of spiOrder) {
      if (spiMap[k]) spiPins.SPI.push([k, spiMap[k]]);
    }

    // 结果格式与 gen_boards.js 相同
    return {
      analogPins,
      digitalPins,
      pwmPins: digitalPins,
      servoPins: digitalPins,
      interruptPins: digitalPins,
      i2cPins,
      spiPins
    };
  }

  private parseGenericConfig(config: string): string {
    // 匹配 GENERIC_F100C4TX、GENERIC_F103CB、GENERIC_F407VG 等格式
    // 识别后 输出F1XXC、F4XXV等格式
    // const match = config.match(/GENERIC_([A-Z])(\d{1,2})\d*[A-Z]?([A-Z])/i);
    // const match = config.match(/GENERIC_([A-Z])(\d?)\d*[A-Z]?([A-Z])/i);
    const match = config.match(/GENERIC_([A-Z])(\d)\d*([A-Z])/i);
    if (match) {
      // match[1] 提取主系列（如 F）
      // match[2] 提取数字部分（如 1、4、7、0）
      // match[3] 提取主型号字母（如 C、V、Z、F）
      return `${match[1]}${match[2]}XX${match[3]}`.toUpperCase();
    }
    console.warn('无法解析 GENERIC 配置:', config);
    return config; // 如果无法解析，返回原始字符串
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

      // 记录开发板使用次数
      this.configService.recordBoardUsage(boardInfo.name);

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

      // 触发开发板变更事件
      this.boardChangeSubject.next();

      this.uiService.updateFooterState({ state: 'done', text: '开发板切换完成' });
      this.message.success('开发板切换成功', { nzDuration: 3000 });
    } catch (error) {
      console.error('切换开发板失败:', error);
      this.message.error('开发板切换失败: ' + error.message);
    }
  }

  generateUniqueProjectName(prjPath, prefix = 'project_'): string {
    const baseDateStr = generateDateString();
    prefix = prefix + baseDateStr;
    const pt = this.platformService.getPlatformSeparator();

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
}