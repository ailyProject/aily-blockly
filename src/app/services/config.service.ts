import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { ElectronService } from './electron.service';

@Injectable({
  providedIn: 'root',
})
export class ConfigService {

  data: AppConfig;

  constructor(
    private http: HttpClient,
    private electronService: ElectronService
  ) { }

  init() {
    this.load();
  }

  async load() {
    let defaultConfigFilePath = window['path'].getElectronPath();
    let defaultConfigFile = window['fs'].readFileSync(`${defaultConfigFilePath}/config/config.json`);
    this.data = await JSON.parse(defaultConfigFile);

    let userConfData;
    let configFilePath = window['path'].getAppDataPath();
    // 检查配置文件是否存在，如果不存在则创建一个默认的配置文件
    if (this.electronService.exists(`${configFilePath}/config.json`)) {
      userConfData = JSON.parse(this.electronService.readFile(`${configFilePath}/config.json`));
    } else {
      userConfData = {};
    }

    // 合并用户配置和默认配置
    this.data = { ...this.data, ...userConfData };

    // 添加当前系统类型到data中
    this.data["platform"] = window['platform'].type;

    // 并行加载缓存的boards.json和libraries.json
    // await Promise.all([
    this.loadAndCacheBoardList(configFilePath);
    this.loadAndCacheLibraryList(configFilePath);
    // ]);
  }

  private async loadAndCacheBoardList(configFilePath: string): Promise<void> {
    if (this.electronService.exists(`${configFilePath}/boards.json`)) {
      this.boardList = JSON.parse(this.electronService.readFile(`${configFilePath}/boards.json`));
      let boardList = await this.loadBoardList();
      if (boardList.length > 0) {
        this.boardList = boardList;
        this.electronService.writeFile(`${configFilePath}/boards.json`, JSON.stringify(boardList));
      }
    } else {
      // 首次启动软件，创建boards.json
      this.boardList = await this.loadBoardList();
      this.electronService.writeFile(`${configFilePath}/boards.json`, JSON.stringify(this.boardList));
    }
    // 创建一个boardDict，方便通过name快速查找board信息
    this.boardList.forEach(board => {
      this.boardDict[board.name] = board;
    });
  }

  private async loadAndCacheLibraryList(configFilePath: string): Promise<void> {
    if (this.electronService.exists(`${configFilePath}/libraries.json`)) {
      this.libraryList = JSON.parse(this.electronService.readFile(`${configFilePath}/libraries.json`));
      let libraryList = await this.loadLibraryList();
      if (libraryList.length > 0) {
        this.libraryList = libraryList;
        this.electronService.writeFile(`${configFilePath}/libraries.json`, JSON.stringify(libraryList));
      }
    } else {
      // 首次启动软件，创建libraries.json
      this.libraryList = await this.loadLibraryList();
      this.electronService.writeFile(`${configFilePath}/libraries.json`, JSON.stringify(this.libraryList));
    }
    // 创建一个libraryDict，方便通过name快速查找library信息
    this.libraryList.forEach(library => {
      this.libraryDict[library.name] = library;
    });
  }

  async save() {
    let configFilePath = window['path'].getAppDataPath();
    window['fs'].writeFileSync(`${configFilePath}/config.json`, JSON.stringify(this.data, null, 2));
  }

  boardList = [];
  boardDict = {};
  async loadBoardList(): Promise<any[]> {
    try {
      let boardList: any = await lastValueFrom(
        this.http.get(this.data.resource[0] + '/boards.json', {
          responseType: 'json',
        }),
      );
      return boardList;
    } catch (error) {
      console.error('Failed to load board list:', error);
      return [];
    }
  }

  libraryList = [];
  libraryDict = {};
  async loadLibraryList(): Promise<any[]> {
    try {
      let libraryList: any = await lastValueFrom(
        this.http.get(this.data.resource[0] + '/libraries.json', {
          responseType: 'json',
        }),
      );
      return libraryList;
    } catch (error) {
      console.error('Failed to load library list:', error);
      return [];
    }
  }

  examplesList;
  async loadExamplesList() {
    this.examplesList = await lastValueFrom(
      this.http.get(this.data.resource[0] + '/examples.json', {
        responseType: 'json',
      }),
    );
    return this.examplesList;
  }

  /**
   * 记录开发板使用次数
   * @param boardName 开发板名称
   */
  recordBoardUsage(boardName: string) {
    if (!this.data.boardUsageCount) {
      this.data.boardUsageCount = {};
    }
    
    // 增加使用次数
    this.data.boardUsageCount[boardName] = (this.data.boardUsageCount[boardName] || 0) + 1;
    
    // 保存配置
    this.save();
  }

  /**
   * 获取开发板使用次数
   * @param boardName 开发板名称
   * @returns 使用次数
   */
  getBoardUsageCount(boardName: string): number {
    return this.data.boardUsageCount?.[boardName] || 0;
  }

  /**
   * 获取所有开发板的使用次数统计
   * @returns 使用次数统计对象
   */
  getAllBoardUsageCount(): Record<string, number> {
    return this.data.boardUsageCount || {};
  }

  /**
   * 根据使用次数对开发板列表进行排序
   * @param boardList 开发板列表
   * @returns 排序后的开发板列表
   */
  sortBoardsByUsage(boardList: any[]): any[] {
    const usageCount = this.getAllBoardUsageCount();
    
    return [...boardList].sort((a, b) => {
      const usageA = usageCount[a.name] || 0;
      const usageB = usageCount[b.name] || 0;
      
      // 首先按使用次数降序排列
      if (usageA !== usageB) {
        return usageB - usageA;
      }
      
      // 如果使用次数相同，按原来的顺序排列（保持稳定排序）
      return 0;
    });
  }
}

interface AppConfig {
  /** 语言设置，例如 "zh_CN" */
  lang: string;

  /** UI主题 */
  theme: string;

  /** 字体设置 */
  font: string;

  /** 系统类型 */
  platform: string;

  /** 项目数据默认路径 */
  appdata_path: {
    win32: string;
    darwin: string;
    linux: string;
  }

  /** 项目默认路径 */
  project_path: string;

  /** NPM 镜像源列表 */
  npm_registry: string[];

  /** 资源文件服务器列表 */
  resource: string[];

  /** 更新服务器列表 */
  updater: string[];

  /** 编译选项 */
  compile: {
    /** 是否显示详细日志 */
    verbose: boolean;
    /** 警告处理方式，如 "error" 表示将警告视为错误 */
    warnings: string;
  };

  /** 上传选项 */
  upload: {
    /** 是否显示详细日志 */
    verbose: boolean;
    /** 警告处理方式 */
    warnings: string;
  };

  devmode: boolean;

  blockly: {
    renderer: string; // Blockly渲染器
  }

  /** 串口监视器快速发送列表 */
  quickSendList?: Array<{ name: string, type: "signal" | "text" | "hex", data: string }>;

  /** 最近打开的项目列表 */
  recentlyProjects?: Array<{ name: string, path: string }>;

  /** 当前选择的语言 */
  selectedLanguage?: string;

  /** 跳过更新的版本列表 */
  skippedVersions?: string[];

  /** 开发板使用次数统计 */
  boardUsageCount?: Record<string, number>;
}