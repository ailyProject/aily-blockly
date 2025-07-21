import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, lastValueFrom } from 'rxjs';
import * as Blockly from 'blockly';
import { processI18n, processJsonVar } from './abf';
import { NoticeService } from '../services/notice.service';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../services/electron.service';

@Injectable({
  providedIn: 'root',
})
export class BlocklyService {
  workspace: Blockly.WorkspaceSvg;

  toolbox = {
    kind: 'categoryToolbox',
    contents: [
      {
        'kind': 'search',
        'name': 'Search',
        'contents': [],
      }
    ],
  };

  codeSubject = new BehaviorSubject<string>('');

  boardConfig;

  draggingBlock: any;
  offsetX: number = 0;
  offsetY: number = 0;

  constructor(
    private http: HttpClient,
    private notice: NoticeService,
    private translateService: TranslateService,
    private electronService: ElectronService
  ) { }

  // 加载blockly的json数据
  loadAbiJson(jsonData) {
    Blockly.serialization.workspaces.load(jsonData, this.workspace);
  }

  getAbiJson() {
    let json = Blockly.serialization.workspaces.save(this.workspace);
    return json;
  }

  // async loadLibrariesByUrl() {
  //   let coreLibraries = await lastValueFrom(
  //     this.http.get<any[]>('arduino/core/core.json', { responseType: 'json' }),
  //   );
  //   let otherLibraries = await lastValueFrom(
  //     this.http.get<any[]>('arduino/libraries/libraries.json', {
  //       responseType: 'json',
  //     }),
  //   );
  //   for (let index = 0; index < coreLibraries.length; index++) {
  //     const libName = coreLibraries[index];
  //     await this.loadLibraryByUrl(libName, 'core');
  //   }
  //   // core和第三方库之间加一个分割线
  //   // this.addToolboxSep();
  //   for (let index = 0; index < otherLibraries.length; index++) {
  //     const libName = otherLibraries[index];
  //     await this.loadLibraryByUrl(libName);
  //   }
  // }

  // async loadLibraryByUrl(libName: String, path: String = 'libraries') {
  //   let blocks;
  //   blocks = await lastValueFrom(
  //     this.http.get<LibData>(`arduino/${path}/${libName}/block.json`, {
  //       responseType: 'json',
  //     }),
  //   ).catch((error) => {
  //     blocks = null;
  //   });
  //   // console.log(blocks);

  //   if (blocks) {
  //     this.loadLibBlocks(blocks);
  //   } else {
  //     //  加载js形式的block定义
  //     this.loadLibBlocksJS(`arduino/${path}/${libName}/block.js`);
  //   }
  //   let toolbox = await lastValueFrom(
  //     this.http.get<Blockly.utils.toolbox.ToolboxDefinition>(
  //       `arduino/${path}/${libName}/toolbox.json`,
  //       { responseType: 'json' },
  //     ),
  //   );
  //   if (toolbox) this.loadLibToolbox(toolbox);
  //   this.loadLibGenerator(`arduino/${path}/${libName}/generator.js`);
  // }

  // 通过node_modules加载库
  async loadLibrary(libPackageName, projectPath) {
    const libPackagePath = projectPath + '/node_modules/' + libPackageName;
    // console.log('loadLibrary', libPackagePath);
    try {
      // 加载block
      const blockFileIsExist = window['path'].isExists(libPackagePath + '/block.json');
      if (blockFileIsExist) {
        // 加载generator
        const generatorFileIsExist = window['path'].isExists(libPackagePath + '/generator.js');
        if (generatorFileIsExist) {
          await this.loadLibGenerator(libPackagePath + '/generator.js');
        }

        let blocks = JSON.parse(window['fs'].readFileSync(libPackagePath + '/block.json'));
        let i18nData = null;
        // 检查多语言文件是否存在
        const i18nFilePath = libPackagePath + '/i18n/' + this.translateService.currentLang + '.json';
        if (this.electronService.exists(i18nFilePath)) {
          i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          blocks = processI18n(blocks, i18nData);
        }
        this.loadLibBlocks(blocks);
        // else {
        //   //  加载js形式的block定义
        //   this.loadLibBlocksJS(libPackagePath + '/block.js');
        // }
        // 加载toolbox
        const toolboxFileIsExist = window['path'].isExists(libPackagePath + '/toolbox.json');
        if (toolboxFileIsExist) {
          let toolbox = JSON.parse(window['fs'].readFileSync(libPackagePath + '/toolbox.json'));
          if (i18nData) toolbox.name = i18nData.toolbox_name;
          this.loadLibToolbox(toolbox);
        }
      }
    } catch (error) {
      console.error(error);
      // this.noticeService.update({
      //   title: '加载库失败',
      //   text: `失败项目: ${libPackageName}`,
      //   state: 'error',
      //   detail: JSON.stringify(error)
      // })
    }
  }

  loadLibBlocks(blocks) {
    for (let index = 0; index < blocks.length; index++) {
      let block = blocks[index];
      block = processJsonVar(block, this.boardConfig); // 替换开发板相关变量
      Blockly.defineBlocksWithJsonArray([block]);
    }
  }

  loadLibBlocksJS(filePath) {
    return new Promise((resolve, reject) => {
      let script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = filePath;
      script.onload = () => {
        resolve(true);
      };
      script.onerror = (error: any) => resolve(false);
      document.getElementsByTagName('head')[0].appendChild(script);
    });
  }

  // addToolboxSep() {
  //   this.toolbox.contents.push({
  //     "kind": "sep",
  //     "cssConfig": {
  //       "container": "sepLine"
  //     }
  //   })
  //   this.workspace.updateToolbox(this.toolbox)
  // }

  loadLibToolbox(toolboxItem) {
    this.toolbox.contents.push(toolboxItem);
    this.workspace.updateToolbox(this.toolbox);
    this.workspace.render();
  }

  loadLibGenerator(filePath) {
    return new Promise((resolve, reject) => {
      let script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'file:///' + filePath;
      script.onload = () => {
        resolve(true);
      };
      script.onerror = (error: any) => resolve(false);
      document.getElementsByTagName('head')[0].appendChild(script);
    });
  }

  removeLibrary(libPackagePath) {
    // 读取要移除的库的信息
    // 移除block定义
    const blockFileIsExist = window['path'].isExists(libPackagePath + '/block.json');
    if (blockFileIsExist) {
      let blocks = JSON.parse(window['fs'].readFileSync(libPackagePath + '/block.json'));
      this.removeLibBlocks(blocks);
    } else {
      // 对于JS形式加载的block，需要使用block文件名作为标识
      const blockJsPath = libPackagePath + '/block.js';
      this.removeLibBlocksJS(blockJsPath);
    }

    // 移除toolbox项
    const toolboxFileIsExist = window['path'].isExists(libPackagePath + '/toolbox.json');
    if (toolboxFileIsExist) {
      let toolbox = JSON.parse(window['fs'].readFileSync(libPackagePath + '/toolbox.json'));
      // 检查多语言文件是否存在，（2025.5.29 修复因为多语言造成的移除不了toolbox的问题）
      let i18nData = null;
      const i18nFilePath = libPackagePath + '/i18n/' + this.translateService.currentLang + '.json';
      if (this.electronService.exists(i18nFilePath)) {
        i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
        if (i18nData) toolbox.name = i18nData.toolbox_name;
      }
      this.removeLibToolbox(toolbox);
    }

    // 移除generator相关引用
    const generatorFileIsExist = window['path'].isExists(libPackagePath + '/generator.js');
    if (generatorFileIsExist) {
      this.removeLibGenerator(libPackagePath + '/generator.js');
    }
  }

  // 移除已加载的block定义
  removeLibBlocks(blocks) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      // 从Blockly中删除block定义
      if (block.type && Blockly.Blocks[block.type]) {
        delete Blockly.Blocks[block.type];
      }
    }
  }

  // 移除通过JS加载的block定义
  removeLibBlocksJS(scriptSrc) {
    // 查找并移除相关脚本标签
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      if (scripts[i].src.includes(scriptSrc)) {
        scripts[i].parentNode.removeChild(scripts[i]);
        break;
      }
    }
    // 注意：已执行的JS代码效果无法直接撤销，这里只是移除了脚本标签
  }

  // 从toolbox中移除项
  removeLibToolbox(toolboxItem) {
    // 通过比较找到要移除的toolbox项
    const index = this.findToolboxItemIndex(toolboxItem);
    if (index !== -1) {
      this.toolbox.contents.splice(index, 1);
      this.workspace.updateToolbox(this.toolbox);
    }
  }

  // 查找toolbox项在contents数组中的索引
  findToolboxItemIndex(toolboxItem) {
    for (let i = 0; i < this.toolbox.contents.length; i++) {
      const item = this.toolbox.contents[i];
      // 使用name、categoryId等属性进行匹配
      if (JSON.stringify(item) === JSON.stringify(toolboxItem)) {
        return i;
      }
    }
    return -1;
  }

  // 移除generator相关引用
  removeLibGenerator(scriptSrc) {
    // 查找并移除相关脚本标签
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      if (scripts[i].src.includes(scriptSrc)) {
        scripts[i].parentNode.removeChild(scripts[i]);
        break;
      }
    }
    // 注意：已注册的generator函数可能无法直接移除
  }

  reset() {
    // 移除所有加载的脚本标签（block.js 和 generator.js）
    const scripts = document.getElementsByTagName('script');
    const scriptSrcsToRemove = [];

    for (let i = 0; i < scripts.length; i++) {
      const scriptSrc = scripts[i].src;
      // 检查脚本是否是库相关的
      if (scriptSrc.includes('/block.js') || scriptSrc.includes('/generator.js')) {
        scriptSrcsToRemove.push(scripts[i]);
      }
    }

    // 移除已标记的脚本标签
    scriptSrcsToRemove.forEach(script => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    });

    // // 清理生成器函数
    // if (Blockly.Arduino) {
    //   // 重置任何可能已注册的Arduino生成器函数
    //   // 注意：具体实现可能需要根据您的生成器结构进行调整
    //   Blockly.Arduino = {}; // 或者保留基本结构但清除自定义函数
    // }

    // 处理工作区
    if (this.workspace) {
      this.workspace.dispose();
    }

    // 重置工具箱
    this.toolbox = {
      kind: 'categoryToolbox',
      contents: [{
        'kind': 'search',
        'name': 'Search',
        'contents': [],
      }],
    };

    // 重置其他可能的状态
    this.codeSubject.next('');
  }

  getWorkspaceJson() {
    return Blockly.serialization.workspaces.save(this.workspace);
  }

  // 创建变量用
  prompt(message: string, defaultValue: string = '') {
    // const dialogRef = this.dialog.open(PromptDialogComponent, {
    //   width: '300px',
    //   data: { message, defaultValue }
    // });

    // return dialogRef.afterClosed();
  }
}

export interface LibData {
  name: string;
  blocks?: string;
  generator?: string;
  toolbox?: string;
  json?: any;
  show?: boolean;
}

export interface LibDataBlock {
  inputsInline: boolean;
  message0?: string;
  type?: string;
  args0?: any;
  previousStatement?: any;
  nextStatement?: any;
  colour?: number;
  tooltip?: string;
  helpUrl?: string;
  generator: string;
}

export interface LibDataGenerator {
  code: string;
  macros?: string;
  libraries?: string;
  variables?: string;
  objects?: string;
  functions?: string;
  setups?: string;
  userSetups?: string;
  loop?: string;
  userLoop?: string;
}
