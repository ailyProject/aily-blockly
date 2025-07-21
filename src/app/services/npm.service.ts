import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';
import { ConfigService } from './config.service';
import { UiService } from './ui.service';
import { API } from '../configs/api.config';
import { ProjectService } from './project.service';
import { CmdService } from './cmd.service';

@Injectable({
  providedIn: 'root'
})
export class NpmService {
  constructor(
    private http: HttpClient,
    private electronService: ElectronService,
    private configService: ConfigService,
    private uiService: UiService,
    private prjService: ProjectService,
    private cmdService: CmdService
  ) { }

  isInstalling = false;

  async init() {
    if (this.electronService.isElectron) {
      window['ipcRenderer'].on('window-receive', async (event, message) => {
        console.log("npm-exec: ", message);
        const action = message.data.action;
        console.log("action: ", action);
        if (action !== "npm-exec") {
          return;
        }

        const subAction = message.data.detail.action;
        const subData = message.data.detail.data;

        if (subAction === 'install-board-dependencies') {
          const packageJson = JSON.parse(window['fs'].readFileSync(subData));
          await this.installBoardDependencies(packageJson)
        } else if (subAction === 'install-board') {
          const packagePath = await this.installBoard(subData)
          console.log("packagePath: ", packagePath);
          const packageJson = JSON.parse(window['fs'].readFileSync(packagePath));
          await this.installBoardDependencies(packageJson)
        } else if (subAction === 'install-tool') {
          let tool = subData;
          if (typeof (tool) === 'string') {
            tool = JSON.parse(tool);
          }
          await this.installTool(tool);
        } else if (subAction === 'install-sdk') {
          let sdk = subData;
          if (typeof (sdk) === 'string') {
            sdk = JSON.parse(sdk);
          }
          await this.installSDK(sdk);
        } else if (subAction === 'install-compiler') {
          let compiler = subData;
          if (typeof (compiler) === 'string') {
            compiler = JSON.parse(compiler);
          }
          await this.installCompiler(compiler);
        } else if (subAction === 'uninstall-board') {
          let board = subData;
          if (typeof (board) === 'string') {
            board = JSON.parse(board);
          }
          await this.uninstallBoard(board);
        } else if (subAction === 'uninstall-tool') {
          let tool = subData;
          if (typeof (tool) === 'string') {
            tool = JSON.parse(tool);
          }

          await this.uninstallTool(tool);
        } else if (subAction === 'uninstall-sdk') {
          let sdk = subData;
          if (typeof (sdk) === 'string') {
            sdk = JSON.parse(sdk);
          }
          await this.uninstallSDK(sdk);
        } else if (subAction === 'uninstall-compiler') {
          let compiler = subData;
          if (typeof (compiler) === 'string') {
            compiler = JSON.parse(compiler);
          }
          await this.uninstallCompiler(compiler);
        }

        console.log("messageId: ", message.messageId);
        if (message.messageId) {
          console.log("发送消息: ", message.messageId);
          window['ipcRenderer'].send('main-window-response', {
            messageId: message.messageId,
            result: 'success'
          })
        }
      });
    }
  }

  // 安装开发板
  async installBoard(board: any) {
    if (typeof (board) === 'string') {
      board = JSON.parse(board);
    }
    this.isInstalling = true;
    const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const cmd = `npm install ${board.name}@${board.version} --prefix "${appDataPath}"`;
    this.uiService.updateFooterState({ state: 'doing', text: `正在安装${board.name}...`, timeout: 300000 });
    // 添加超时保护和正确的参数名
    await Promise.race([
      window['npm'].run({ cmd: cmd }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('安装超时')), 300000) // 5分钟超时
      )
    ]);

    this.uiService.updateFooterState({ state: 'done', text: '开发板安装完成' });
    this.isInstalling = false;
    // return template/package.json
    return `${appDataPath}/node_modules/${board.name}/template/package.json`;
  }

  async installBoardDeps() {
    const boardPackageJson = await this.prjService.getBoardPackageJson() || {};
    console.log("boardPackageJson: ", boardPackageJson);
    await this.installBoardDependencies(boardPackageJson);
  }

  // 安装开发板依赖
  async installBoardDependencies(packageJson: any) {
    try {
      this.isInstalling = true;
      const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const boardDependencies = packageJson.boardDependencies || {};

      console.log("boardDependencies: ", boardDependencies);

      for (const [key, version] of Object.entries(boardDependencies)) {
        const depPath = `${appDataPath}/node_modules/${key}`;
        const depPathPackageJson = `${depPath}/package.json`;
        // 检查依赖是否已经安装
        if (window['path'].isExists(depPathPackageJson)) {
          const depPackageJson = JSON.parse(window['fs'].readFileSync(depPathPackageJson));
          // 检查版本是否一致
          if (depPackageJson.version === version) {
            console.log(`依赖 ${key} 已安装，版本一致`);
            continue;
          } else {
            console.log(`依赖 ${key} 已安装，但版本不一致，当前版本: ${depPackageJson.version}, 需要版本: ${version}`);
          }
        } else {
          console.log(`依赖 ${key} 未安装`);
        }

        // if (window['path'].isExists(depPath)) {
        //   console.log(`依赖 ${key} 已安装`);
        //   continue;
        // }

        this.uiService.updateFooterState({ state: 'doing', text: `正在安装${key}依赖...`, timeout: 300000 });

        try {
          // 安装成功的条件是需要安装目录指私有源或者全局已经设置私有源
          const npmCmd = `npm install ${key}@${version} --prefix "${appDataPath}"`;
          console.log(`执行命令: ${npmCmd}, 时间: ${new Date().toISOString()}`);

          // 添加超时保护和正确的参数名
          await Promise.race([
            window['npm'].run({ cmd: npmCmd }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('安装超时')), 300000) // 5分钟超时
            )
          ]);

          console.log(`依赖 ${key} 安装成功, 时间: ${new Date().toISOString()}`);
        } catch (error) {
          console.error(`依赖 ${key} 安装失败:`, error);
        }
      }

      this.uiService.updateFooterState({ state: 'done', text: '开发板依赖安装完成' });
    } catch (error) {
      console.error('安装开发板依赖时出错:', error);
      this.uiService.updateFooterState({ state: 'error', text: '开发板依赖安装失败' });
    } finally {
      this.isInstalling = false;
    }
  }

  // 卸载开发板依赖
  async uninstallBoardDependencies(depName, packageJson: any) {
    try {
      const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const boardDependenciesToUninstall = packageJson.boardDependencies || {};

      // 获取所有已安装的包
      const installedPackagesList = await this.getInstalledPackageList(appDataPath);
      const installedBoards = [];

      // 从已安装的包中找出开发板（具有template/package.json的包且包名以@aily-project/board-开头）
      for (const packageItem of installedPackagesList) {
        const packageName = '@' + packageItem.split('@')[1];

        // 排除掉被卸载包本身
        if (packageName === depName) {
          continue;
        }

        // 检查包名是否以board-开头
        if (packageName.startsWith('@aily-project/board-')) {
          const boardPath = `${appDataPath}/node_modules/${packageName}`;
          const packageJsonPath = `${boardPath}/template/package.json`;

          if (window['path'].isExists(packageJsonPath)) {
            try {
              const boardPackageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath));
              // 排除当前正在卸载的开发板
              if (packageName !== packageJson.name) {
                installedBoards.push({
                  name: packageName,
                  dependencies: boardPackageJson.boardDependencies || {}
                });
              }
            } catch (error) {
              console.error(`无法读取开发板 ${packageName} 的package.json:`, error);
            }
          }
        }
      }

      this.uiService.updateFooterState({ state: 'doing', text: '正在卸载不再需要的依赖...', timeout: 300000 });

      // 检查每个依赖是否被其他开发板使用
      console.log("installedBoards: ", installedBoards);
      for (const [depName, depVersion] of Object.entries(boardDependenciesToUninstall)) {
        const isUsedByOtherBoards = installedBoards.some(board =>
          board.dependencies && board.dependencies[depName] !== undefined
        );

        if (!isUsedByOtherBoards) {
          // 如果不被其他开发板使用，则卸载它
          try {
            const depPath = `${appDataPath}/node_modules/${depName}`;
            if (!window['path'].isExists(depPath)) {
              console.log(`依赖 ${depName} 未安装，跳过卸载`);
              continue;
            }

            const npmCmd = `npm uninstall ${depName} --prefix "${appDataPath}"`;
            console.log(`执行命令: ${npmCmd}, 时间: ${new Date().toISOString()}`);

            await Promise.race([
              window['npm'].run({ cmd: npmCmd }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('卸载超时')), 300000)
              )
            ]);

            console.log(`依赖 ${depName} 卸载成功, 时间: ${new Date().toISOString()}`);
          } catch (error) {
            console.error(`依赖 ${depName} 卸载失败:`, error);
          }
        } else {
          console.log(`依赖 ${depName} 被其他开发板使用，跳过卸载`);
        }
      }

      this.uiService.updateFooterState({ state: 'done', text: '依赖卸载完成' });
    } catch (error) {
      console.error('卸载开发板依赖时出错:', error);
      this.uiService.updateFooterState({ state: 'error', text: '依赖卸载失败' });
    }
  }

  // 卸载开发板
  async uninstallBoard(board: any) {
    const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
    const packageJson = JSON.parse(window['fs'].readFileSync(`${appDataPath}/node_modules/${board.name}/template/package.json`));
    // 卸载开发板
    const cmd = `npm uninstall ${board.name} --prefix "${appDataPath}"`;
    this.uiService.updateFooterState({ state: 'doing', text: `正在卸载${board.name}...`, timeout: 300000 });
    // 添加超时保护和正确的参数名
    window['npm'].run({ cmd: cmd });
    this.uiService.updateFooterState({ state: 'done', text: '开发板卸载完成' });

    return packageJson;
  }

  // 通用安装方法
  private async installPackage(packageInfo: any, type: string, version?: string) {
    const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());

    if (!packageInfo || !packageInfo.name) {
      throw new Error(`${type}名称不能为空`);
    }

    const packageName = version ? `${packageInfo.name}@${version}` : packageInfo.name;
    const cmd = `npm install ${packageName} --prefix "${appDataPath}"`;

    this.uiService.updateFooterState({ state: 'doing', text: `正在安装${packageInfo.name}...`, timeout: 300000 });

    try {
      // // 添加超时保护
      // await Promise.race([
      //   window['npm'].run({ cmd: cmd }),
      //   new Promise((_, reject) =>
      //     setTimeout(() => reject(new Error('安装超时')), 300000) // 5分钟超时
      //   )
      // ]);

      await this.cmdService.runAsync(cmd, appDataPath);

      this.uiService.updateFooterState({ state: 'done', text: `${packageInfo.name}安装完成` });
    } catch (error) {
      this.uiService.updateFooterState({ state: 'error', text: `${packageInfo.name}安装失败` });
      throw error;
    }
  }

  // 安装工具
  async installTool(tool: any) {
    await this.installPackage(tool, '工具');
  }

  // 安装SDK
  async installSDK(sdk: any) {
    await this.installPackage(sdk, 'SDK');
  }

  // 安装编译器
  async installCompiler(compiler: any) {
    await this.installPackage(compiler, '编译器');
  }

  // 通用卸载方法
  private async uninstallPackage(packageInfo: any, type: string) {
    const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());

    if (!packageInfo || !packageInfo.name) {
      throw new Error(`${type}名称不能为空`);
    }

    const packageNodeModulesPath = `${appDataPath}/node_modules/${packageInfo.name}`;
    if (!window['path'].isExists(packageNodeModulesPath)) {
      console.log(`${type} ${packageInfo.name} 未安装，跳过卸载`);
      return;
    }

    // 尝试执行包的清理脚本
    // let cmd = `cd /d "${packageNodeModulesPath}" && npm run uninstall`;
    // try {
    //   await window['npm'].run({ cmd: cmd });
    // } catch (error) {
    //   console.log(`${type}执行清理失败:`, error);
    // }

    this.uiService.updateFooterState({ state: 'doing', text: `正在卸载${packageInfo.name}...`, timeout: 300000 });

    let cmd = `npm run uninstall`
    console.log("PackageNodeModulesPath: ", packageNodeModulesPath);
    await this.cmdService.runAsync(cmd, packageNodeModulesPath)

    // 卸载包
    cmd = `npm uninstall ${packageInfo.name} --prefix "${appDataPath}"`;
    // await window['npm'].run({ cmd: cmd });
    await this.cmdService.runAsync(cmd, appDataPath);
    this.uiService.updateFooterState({ state: 'done', text: `${packageInfo.name}卸载完成` });
  }

  // 卸载SDK
  async uninstallSDK(sdk: any) {
    await this.uninstallPackage(sdk, 'SDK');
  }

  // 卸载工具
  async uninstallTool(tool: any) {
    await this.uninstallPackage(tool, '工具');
  }

  // 卸载编译器
  async uninstallCompiler(compiler: any) {
    await this.uninstallPackage(compiler, '编译器');
  }

  // 指定获取packageName的可用版本列表
  async getPackageVersionList(packageName: string): Promise<string[]> {
    let data = JSON.parse(await window['npm'].run({ cmd: `npm view ${packageName} versions --json` }))
    let packageVersionList = [];
    if (typeof data === 'string') {
      packageVersionList.push(data);
    } else {
      packageVersionList = data;
    }
    return packageVersionList;
  }

  async getInstalledPackageList(path) {
    let data = JSON.parse(await window['npm'].run({ cmd: `npm list --depth=0 --json --prefix "${path}"` }));
    let installedPackageList = [];
    for (let key in data.dependencies) {
      const item = data.dependencies[key];
      installedPackageList.push(key + '@' + item.version);
    }
    return installedPackageList;
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
    return this.http.get<SearchResponseModel>(API.projectSearch, {
      params: data,
    });
  }

  async getAllInstalledLibraries(path: string) {
    // let data = JSON.parse(await window['npm'].run({ cmd: `npm ls --all --json --prefix "${path}"` }));
    let data = await getInstalledPackagesByFileRead(path);
    // console.log("getInstalledPackagesByFileRead:", data);
    // 提取所有依赖项到对象数组
    const allDependencies = this.extractAllDependencies(data.dependencies || {});

    // 过滤出以 @aily-project/lib- 开头的库
    const libraryModules = allDependencies.filter(dep => dep.name.startsWith('@aily-project/lib-'));

    // 让包含@aily-project/lib-core-的模块在最前面
    libraryModules.sort((a, b) => {
      if (a.name.startsWith('@aily-project/lib-core-') && !b.name.startsWith('@aily-project/lib-core-')) {
        return -1;
      } else if (!a.name.startsWith('@aily-project/lib-core-') && b.name.startsWith('@aily-project/lib-core-')) {
        return 1;
      } else {
        return a.name.localeCompare(b.name);
      }
    });

    // console.log('libraryModules:', libraryModules);
    
    return libraryModules;
  }

  /**
   * 递归提取所有依赖项（包括子依赖）到对象数组
   * @param dependencies 依赖对象
   * @returns 包含所有依赖项完整信息的对象数组
   */
  private extractAllDependencies(dependencies: any): Array<any> {
    const dependencyMap = new Map<string, any>();

    const extractRecursively = (deps: any) => {
      if (!deps || typeof deps !== 'object') {
        return;
      }

      for (const [packageName, packageInfo] of Object.entries(deps)) {
        // 保留packageInfo的所有信息，并添加name属性
        if (packageInfo && typeof packageInfo === 'object') {
          const fullPackageInfo = {
            name: packageName,
            ...packageInfo
          };
          
          // 添加当前包的完整信息到Map中（避免重复）
          dependencyMap.set(packageName, fullPackageInfo);

          // 如果有子依赖，递归处理
          if (packageInfo['dependencies']) {
            extractRecursively(packageInfo['dependencies']);
          }
        } else {
          // 如果packageInfo不是对象，创建基本信息对象
          dependencyMap.set(packageName, {
            name: packageName,
            version: packageInfo || 'unknown'
          });
        }
      }
    };

    extractRecursively(dependencies);

    // 转换为对象数组并排序
    return Array.from(dependencyMap.values())
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export interface SearchResponseModel {
  objects: any[],
  time: string,
  total: number
}

export interface ResponseModel {
  status: number;
  messages: string;
  data: any;
}

/**
 * 通过读取文件的方式获取已安装的包信息，模拟 npm ls --all --json 的效果
 * @param projectPath 项目路径
 * @returns 类似 npm ls 的数据结构
 */
export async function getInstalledPackagesByFileRead(projectPath: string): Promise<any> {
  const nodeModulesPath = `${projectPath}/node_modules`;

  // 检查 node_modules 目录是否存在
  if (!window['path'].isExists(nodeModulesPath)) {
    return { dependencies: {} };
  }

  const dependencies = {};

  // 递归扫描 node_modules 目录
  await scanNodeModulesDirectory(nodeModulesPath, dependencies);

  return {
    name: 'project',
    version: '1.0.0',
    dependencies: dependencies
  };
}

/**
 * 递归扫描 node_modules 目录
 * @param nodeModulesPath node_modules 目录路径
 * @param dependencies 依赖对象
 */
export async function scanNodeModulesDirectory(nodeModulesPath: string, dependencies: any): Promise<void> {
  try {
    const dirs = window['fs'].readDirSync(nodeModulesPath);

    for (const dir of dirs) {
      // 跳过 .bin 等特殊目录
      if (dir.name && dir.name.startsWith('.')) {
        continue;
      }

      const dirName = dir.name || dir; // 兼容不同的 readDirSync 返回格式
      const packagePath = `${nodeModulesPath}/${dirName}`;

      // 检查是否是目录
      if (!window['fs'].isDirectory(packagePath)) {
        continue;
      }

      if (dirName.startsWith('@')) {
        // 处理 scoped packages (如 @aily-project/lib-xxx)
        await scanScopedPackages(packagePath, dependencies);
      } else {
        // 处理普通包
        await scanSinglePackage(packagePath, dirName, dependencies);
      }
    }
  } catch (error) {
    console.error('扫描 node_modules 目录失败:', error);
  }
}

/**
 * 扫描 scoped packages
 * @param scopePath scope 目录路径
 * @param dependencies 依赖对象
 */
export async function scanScopedPackages(scopePath: string, dependencies: any): Promise<void> {
  try {
    const scopeDirs = window['fs'].readDirSync(scopePath);
    const scopeName = window['path'].basename(scopePath);

    for (const dir of scopeDirs) {
      const dirName = dir.name || dir;
      const packageName = `${scopeName}/${dirName}`;
      const packagePath = `${scopePath}/${dirName}`;

      if (window['fs'].isDirectory(packagePath)) {
        await scanSinglePackage(packagePath, packageName, dependencies);
      }
    }
  } catch (error) {
    console.error('扫描 scoped packages 失败:', error);
  }
}

/**
 * 扫描单个包
 * @param packagePath 包路径
 * @param packageName 包名
 * @param dependencies 依赖对象
 */
export async function scanSinglePackage(packagePath: string, packageName: string, dependencies: any): Promise<void> {
  try {
    const packageJsonPath = `${packagePath}/package.json`;
    const toolboxJsonPath = `${packagePath}/toolbox.json`;
    // 检查 package.json 和 toolbox.json 是否存在
    if (!window['fs'].existsSync(packageJsonPath) || !window['fs'].existsSync(toolboxJsonPath)) {
      return;
    }

    // 读取 package.json
    const packageJsonContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    // 读取 toolbox.json
    const toolboxJsonContent = window['fs'].readFileSync(toolboxJsonPath, 'utf8');
    const toolboxJson = JSON.parse(toolboxJsonContent);
    // 构建包信息
    const packageInfo: any = {
      version: packageJson.version || '1.0.0',
      description: packageJson.description || '',
      author: packageJson.author || 'unknown',
      nickname: packageJson.nickname || packageJson.name,
      icon: toolboxJson.icon || 'fa-light fa-cube',
      keywords: packageJson.keywords || [],
    };

    // 检查是否有子依赖
    const subNodeModulesPath = `${packagePath}/node_modules`;
    if (window['fs'].existsSync(subNodeModulesPath)) {
      packageInfo.dependencies = {};
      await scanNodeModulesDirectory(subNodeModulesPath, packageInfo.dependencies);
    }

    dependencies[packageName] = packageInfo;
  } catch (error) {
    console.error(`扫描包 ${packageName} 失败:`, error);
  }
}

