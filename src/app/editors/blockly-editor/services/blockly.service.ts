import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as Blockly from 'blockly';
import { processI18n, processJsonVar, processStaticFilePath } from '../components/blockly/abf';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../../../services/electron.service';

@Injectable({
  providedIn: 'root'
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

  iconsMap = new Map();
  blockDefinitionsMap = new Map<string, any>();
  // 追踪加载的generator脚本和它们注册的函数
  loadedGenerators = new Map<string, Set<string>>(); // filePath -> Set of block types
  // 追踪已加载的库,避免重复加载
  loadedLibraries = new Set<string>(); // libPackagePath

  codeSubject = new BehaviorSubject<string>('');
  dependencySubject = new BehaviorSubject<string>('');

  boardConfig;

  draggingBlock: any;
  offsetX: number = 0;
  offsetY: number = 0;

  aiWaiting = false;
  private _aiWriting = new BehaviorSubject<boolean>(false);
  aiWriting$ = this._aiWriting.asObservable();
  private _aiWaiting = new BehaviorSubject<boolean>(false);
  aiWaiting$ = this._aiWaiting.asObservable();

  get aiWaitWriting() {
    return this._aiWaiting.value;
  }

  set aiWaitWriting(value: boolean) {
    this._aiWaiting.next(value);
  }

  get aiWriting(): boolean {
    return this._aiWriting.value;
  }

  set aiWriting(value: boolean) {
    this._aiWriting.next(value);
  }

  constructor(
    private translateService: TranslateService,
    private electronService: ElectronService
  ) {
    (window as any).__ailyBlockDefinitionsMap = this.blockDefinitionsMap;
  }

  // 加载blockly的json数据
  loadAbiJson(jsonData) {
    jsonData.blocks.blocks.forEach(block => {
      const ailyIcons = this.iconsMap.get(block.type);
      if (ailyIcons) block.icons = ailyIcons;
    });
    Blockly.serialization.workspaces.load(jsonData, this.workspace);
  }

  // 通过node_modules加载库
  async loadLibrary(libPackageName, projectPath) {
    // 统一路径分隔符，确保在Windows上使用反斜杠
    // const normalizedProjectPath = projectPath.replace(/\//g, '\\');
    // const libPackagePath = normalizedProjectPath + '\\node_modules\\' + libPackageName.replace(/\//g, '\\');

    const libPackagePath = this.electronService.pathJoin(
      projectPath,
      'node_modules',
      ...libPackageName.split('/')
    );

    // 防止重复加载
    if (this.loadedLibraries.has(libPackagePath)) {
      return;
    }

    try {
      // 加载block
      // const blockFileIsExist = this.electronService.exists(libPackagePath + '\\block.json');
      const blockFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'block.json'));

      if (blockFileIsExist) {
        // 加载generator
        // const generatorFileIsExist = this.electronService.exists(libPackagePath + '\\generator.js');
        const generatorFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'generator.js'));
        if (generatorFileIsExist) {
          await this.loadLibGenerator(this.electronService.pathJoin(libPackagePath, 'generator.js'));
        }
        // 加载blocks
        let blocks = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'block.json')));
        let i18nData = null;
        // 检查多语言文件是否存在
        const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
        if (this.electronService.exists(i18nFilePath)) {
          i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          blocks = processI18n(blocks, i18nData);
        }
        // 替换block中静态图片路径
        const staticFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'));
        this.loadLibBlocks(blocks, staticFileIsExist ? this.electronService.pathJoin(libPackagePath, 'static') : null);
        // 加载toolbox
        const toolboxFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'toolbox.json'));
        if (toolboxFileIsExist) {
          let toolbox = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'toolbox.json')));
          if (i18nData) {
            toolbox.name = i18nData.toolbox_name;
          }
          this.loadLibToolbox(toolbox);
        }
      } else {
        // block.json 不存在时，不标记为已加载
        return;
      }

      // 标记为已加载
      this.loadedLibraries.add(libPackagePath);
    } catch (error) {
      console.error('加载库失败:', libPackageName, error);
    }
  }

  // 卸载库（通过包名和项目路径）
  async unloadLibrary(libPackageName, projectPath) {
    // 统一路径分隔符，使用electronService.pathJoin处理跨平台路径
    const libPackagePath = this.electronService.pathJoin(
      projectPath,
      'node_modules',
      ...libPackageName.split('/')
    );

    // 直接调用 removeLibrary 函数
    this.removeLibrary(libPackagePath);
  }

  loadLibBlocks(blocks, libStaticPath) {
    for (let index = 0; index < blocks.length; index++) {
      let block = blocks[index];
      if (block?.type && block?.icon) {
        this.blockDefinitionsMap.set(
          block.type,
          JSON.parse(JSON.stringify(block.icon))
        );
      }
      block = processJsonVar(block, this.boardConfig); // 替换开发板相关变量
      if (libStaticPath) {
        block = processStaticFilePath(block, libStaticPath);
      }
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

  loadLibToolbox(toolboxItem) {
    // 检查是否已存在相同的toolboxItem
    const existingIndex = this.findToolboxItemIndex(toolboxItem);
    if (existingIndex !== -1) {
      return;
    }

    this.toolbox.contents.push(toolboxItem);
    this.workspace.updateToolbox(this.toolbox);
    this.workspace.render();
  }

  loadLibGenerator(filePath) {
    return new Promise((resolve, reject) => {
      // 检查是否已加载
      if (this.loadedGenerators.has(filePath)) {
        console.warn(`Generator ${filePath} 已加载,跳过重复加载`);
        resolve(true);
        return;
      }

      // 在加载前记录当前已有的generator函数
      const blockTypesBefore = this.getRegisteredGenerators();

      let script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'file:///' + filePath;
      script.setAttribute('data-generator-path', filePath); // 标记script来源

      script.onload = () => {
        // 加载后检测新增的generator函数
        const blockTypesAfter = this.getRegisteredGenerators();
        const newBlockTypes = blockTypesAfter.filter(type => !blockTypesBefore.includes(type));
        this.loadedGenerators.set(filePath, new Set(newBlockTypes));
        console.log(`Generator loaded from ${filePath}, registered blocks:`, newBlockTypes);
        resolve(true);
      };

      script.onerror = (error: any) => {
        console.error(`Generator loading failed: ${filePath}`, error);
        resolve(false);
      };

      document.getElementsByTagName('head')[0].appendChild(script);
    });
  }

  // 获取当前已注册的所有generator函数对应的block类型
  private getRegisteredGenerators(): string[] {
    const generators = [];
    // Blockly的generator通常注册在 Blockly.Arduino、Blockly.Python等对象上
    if ((Blockly as any).Arduino) {
      generators.push(...Object.keys((Blockly as any).Arduino).filter(key =>
        typeof (Blockly as any).Arduino[key] === 'function'
      ));
    }
    if ((Blockly as any).Python) {
      generators.push(...Object.keys((Blockly as any).Python).filter(key =>
        typeof (Blockly as any).Python[key] === 'function'
      ));
    }
    return generators;
  }

  removeLibrary(libPackagePath) {
    // 路径已经是标准格式，无需再次分割
    // electronService.pathJoin已经处理了路径分隔符

    // 检查是否已加载
    if (!this.loadedLibraries.has(libPackagePath)) {
      console.warn(`库 ${libPackagePath} 未加载,无需移除`);
      return;
    }

    console.log(`开始移除库: ${libPackagePath}`);

    // 读取要移除的库的信息
    // 移除block定义
    const blockFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'block.json'));
    if (blockFileIsExist) {
      let blocks = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'block.json')));
      this.removeLibBlocks(blocks);
    } else {
      // 对于JS形式加载的block，需要使用block文件名作为标识
      const blockJsPath = this.electronService.pathJoin(libPackagePath, 'block.js');
      this.removeLibBlocksJS(blockJsPath);
    }

    // 移除toolbox项
    const toolboxFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'toolbox.json'));
    if (toolboxFileIsExist) {
      let toolbox = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'toolbox.json')));
      // 检查多语言文件是否存在，（2025.5.29 修复因为多语言造成的移除不了toolbox的问题）
      let i18nData = null;
      const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
      if (this.electronService.exists(i18nFilePath)) {
        i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
        if (i18nData) toolbox.name = i18nData.toolbox_name;
      }
      this.removeLibToolbox(toolbox);
    }

    // 移除generator相关引用
    const generatorFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'generator.js'));
    if (generatorFileIsExist) {
      this.removeLibGenerator(this.electronService.pathJoin(libPackagePath, 'generator.js'));
    }

    // 从已加载库列表中移除
    this.loadedLibraries.delete(libPackagePath);
    console.log(`库 ${libPackagePath} 移除完成`);
  }

  // 移除已加载的block定义
  removeLibBlocks(blocks) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      // 从Blockly中删除block定义
      if (block.type && Blockly.Blocks[block.type]) {
        console.log(`- delete ${block.type}`);
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
    console.log(`即将移除：`, toolboxItem);
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
      if (item.name === toolboxItem.name && item.kind == toolboxItem.kind) {
        return i;
      }
    }
    return -1;
  }

  // 移除generator相关引用
  removeLibGenerator(scriptSrc) {
    // 移除注册的generator函数
    const registeredBlocks = this.loadedGenerators.get(scriptSrc);
    if (registeredBlocks && registeredBlocks.size > 0) {
      registeredBlocks.forEach(blockType => {
        // 清理各种语言的generator
        if ((Blockly as any).Arduino && (Blockly as any).Arduino[blockType]) {
          console.log(`- delete Arduino generator for ${blockType}`);
          delete (Blockly as any).Arduino[blockType];
        }
        if ((Blockly as any).Python && (Blockly as any).Python[blockType]) {
          console.log(`- delete Python generator for ${blockType}`);
          delete (Blockly as any).Python[blockType];
        }
        // 可以继续添加其他语言: JavaScript, Dart 等
        if ((Blockly as any).JavaScript && (Blockly as any).JavaScript[blockType]) {
          delete (Blockly as any).JavaScript[blockType];
        }
      });
      this.loadedGenerators.delete(scriptSrc);
    }

    // 查找并移除相关脚本标签
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) { // 倒序遍历避免索引问题
      const script = scripts[i];
      const dataPath = script.getAttribute('data-generator-path');
      if (script.src.includes(scriptSrc) || dataPath === scriptSrc) {
        script.parentNode?.removeChild(script);
        console.log(`- removed script tag for ${scriptSrc}`);
        break;
      }
    }
  }

  reset() {
    console.log('开始重置 BlocklyService...');

    this.iconsMap.clear();
    this.blockDefinitionsMap.clear();
    this.loadedGenerators.clear();
    this.loadedLibraries.clear();

    // 移除所有加载的脚本标签（block.js 和 generator.js）
    const scripts = document.getElementsByTagName('script');
    const scriptSrcsToRemove = [];

    for (let i = 0; i < scripts.length; i++) {
      const scriptSrc = scripts[i].src;
      const dataPath = scripts[i].getAttribute('data-generator-path');
      // 检查脚本是否是库相关的
      if (scriptSrc.includes('/block.js') || scriptSrc.includes('/generator.js') || dataPath) {
        scriptSrcsToRemove.push(scripts[i]);
      }
    }

    // 移除已标记的脚本标签
    scriptSrcsToRemove.forEach(script => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    });
    console.log(`移除了 ${scriptSrcsToRemove.length} 个脚本标签`);

    // 清理生成器函数
    const generatorTypes = ['Arduino', 'Python', 'JavaScript', 'Dart', 'Lua', 'PHP'];
    generatorTypes.forEach(type => {
      if ((Blockly as any)[type]) {
        const keysToDelete = Object.keys((Blockly as any)[type]).filter(key =>
          typeof (Blockly as any)[type][key] === 'function' &&
          !key.startsWith('init') && // 保留init等系统方法
          !key.startsWith('finish')
        );
        keysToDelete.forEach(key => {
          delete (Blockly as any)[type][key];
        });
        console.log(`清理了 ${type} 的 ${keysToDelete.length} 个generator函数`);
      }
    });

    // 处理工作区
    if (this.workspace) {
      this.workspace.dispose();
      // console.log('工作区已销毁');
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

    // console.log('BlocklyService 重置完成');
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

  // 检查ai是否在执行会话非block操作
  checkAiWaiting() {
    if (this.aiWriting) {
      return true;
    }
    if (this.aiWaiting) {
      this.aiWaitWriting = true;
      setTimeout(() => {
        if (!this.aiWriting) {
          this.aiWaitWriting = false;
        }
      }, 2000);
    }
    return this.aiWaiting;
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
