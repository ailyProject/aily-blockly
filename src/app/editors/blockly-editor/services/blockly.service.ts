import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as Blockly from 'blockly';
import { processI18n, processJsonVar, processStaticFilePath, processToolboxI18n } from '../components/blockly/abf';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../../../services/electron.service';
import { BlockCodeMapping, CodeLineRange } from '../components/blockly/generators/arduino/arduino';
import { convertBlockTreeToAbs, convertAbiToAbsWithLineMap } from '../../../tools/aily-chat/tools/abiAbsConverter';

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

  // ==================== Block-to-Code 映射系统 ====================
  /** 当前选中的 block id */
  selectedBlockSubject = new BehaviorSubject<string | null>(null);
  /** block → 代码行号映射（每次代码生成后更新） */
  blockCodeMapSubject = new BehaviorSubject<Map<string, BlockCodeMapping>>(new Map());
  /** block → ABS 行号映射（由 abs-auto-sync 生成 ABS 时同步更新，确保与用户看到的 .abs 文件一致） */
  absBlockLineMap = new BehaviorSubject<Map<string, { startLine: number; endLine: number }>>(new Map());

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
        // 加载blocks
        let blocks = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'block.json')));
        let i18nData = null;
        // 检查多语言文件是否存在（先于 generator.js 加载，确保动态扩展能读取到 i18n 数据）
        const i18nFilePath = this.electronService.pathJoin(libPackagePath, 'i18n', this.translateService.currentLang + '.json');
        if (this.electronService.exists(i18nFilePath)) {
          i18nData = JSON.parse(this.electronService.readFile(i18nFilePath));
          // 将 i18n 数据按库名存储到全局，供动态扩展使用
          (window as any).__BLOCKLY_LIB_I18N__ = (window as any).__BLOCKLY_LIB_I18N__ || {};
          (window as any).__BLOCKLY_LIB_I18N__[libPackageName] = i18nData;
          blocks = processI18n(blocks, i18nData);
        }
        // 加载generator（必须在 i18n 数据存储后，这样动态定义的块才能读取到正确的多语言）
        const generatorFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'generator.js'));
        if (generatorFileIsExist) {
          await this.loadLibGenerator(this.electronService.pathJoin(libPackagePath, 'generator.js'));
        }
        // 替换block中静态图片路径
        const staticFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'static'));
        this.loadLibBlocks(blocks, staticFileIsExist ? this.electronService.pathJoin(libPackagePath, 'static') : null);
        // 加载toolbox
        const toolboxFileIsExist = this.electronService.exists(this.electronService.pathJoin(libPackagePath, 'toolbox.json'));
        if (toolboxFileIsExist) {
          let toolbox = JSON.parse(this.electronService.readFile(this.electronService.pathJoin(libPackagePath, 'toolbox.json')));
          // 处理 toolbox 多语言（包括 name 和 labels）
          if (i18nData) {
            toolbox = processToolboxI18n(toolbox, i18nData);
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
    this.selectedBlockSubject.next(null);
    this.blockCodeMapSubject.next(new Map());
    this.absBlockLineMap.next(new Map());

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

  // ==================== Block-to-Code 查询 API ====================

  /**
   * 获取指定 block 对应的代码映射信息
   * @param blockId 块 ID
   * @returns BlockCodeMapping 或 null
   */
  getCodeForBlock(blockId: string): BlockCodeMapping | null {
    const map = this.blockCodeMapSubject.value;
    return map.get(blockId) || null;
  }

  /**
   * 获取指定 block 对应的 C++ 代码片段文本
   * @param blockId 块 ID
   * @returns 代码文本或空字符串
   */
  getCodeSnippetForBlock(blockId: string): string {
    const mapping = this.getCodeForBlock(blockId);
    return mapping?.codeSnippet || '';
  }

  /**
   * 获取指定 block 在代码中的行号范围
   * @param blockId 块 ID
   * @returns 行号范围数组
   */
  getCodeLinesForBlock(blockId: string): CodeLineRange[] {
    const mapping = this.getCodeForBlock(blockId);
    return mapping?.lineRanges || [];
  }

  /**
   * 获取当前选中 block 的上下文信息（供 agent/LLM 使用）
   * 精简格式：块类型 + ABS 代码片段 + C++ 对应行号
   */
  getSelectedBlockContext(): {
    blockId: string;
    blockType: string;
    absSnippet: string;
    cppLineRange: string;
    absLineRange: string;
    codeRanges: CodeLineRange[];
    formatted: string;
  } | null {
    const blockId = this.selectedBlockSubject.value;
    if (!blockId || !this.workspace) return null;

    const block = this.workspace.getBlockById(blockId);
    if (!block) return null;

    // 获取该块的代码映射
    const mapping = this.getCodeForBlock(blockId);
    const ranges = mapping?.lineRanges || [];

    // 生成 C++ 行号范围（简洁格式）
    const cppLineRange = this._formatCppLineRange(ranges);

    // 生成该块子树的 ABS 代码片段
    const absSnippet = this._getBlockAbsSnippet(block);

    // 生成 ABS 行号范围
    const absLineRange = this._getBlockAbsLineRange(block, absSnippet);

    // 格式化 LLM 友好文本
    const formatted = this._formatBlockContextForLLM(block.type, absSnippet, cppLineRange, absLineRange);

    return {
      blockId,
      blockType: block.type,
      absSnippet,
      cppLineRange,
      absLineRange,
      codeRanges: ranges,
      formatted
    };
  }

  /**
   * 将 CodeLineRange 数组格式化为简洁的行号范围字符串
   * 例："22-38" / "15" / "无"
   */
  private _formatCppLineRange(ranges: CodeLineRange[]): string {
    if (!ranges || ranges.length === 0) return '无';
    let minLine = Infinity;
    let maxLine = -Infinity;
    for (const r of ranges) {
      if (r.startLine < minLine) minLine = r.startLine;
      if (r.endLine > maxLine) maxLine = r.endLine;
    }
    return minLine === maxLine ? `${minLine}` : `${minLine}-${maxLine}`;
  }

  /**
   * 获取单个块（含子树）的 ABS 代码片段
   * 通过 Blockly 序列化 API 得到块的 ABI JSON，再用 convertBlockTreeToAbs 转换
   */
  private _getBlockAbsSnippet(block: Blockly.Block): string {
    try {
      // 序列化单个块（含子块、shadow 块）为 ABI JSON
      const blockAbi = (Blockly as any).serialization.blocks.save(block, {
        addCoordinates: false,
        addInputBlocks: true,
        addNextBlocks: false,  // 不包含 next 链中的兄弟块
        doFullSerialization: false
      });

      // 获取工作区变量用于 ID → 名称转换
      const variables = this.workspace!.getAllVariables().map(v => ({
        id: v.getId(),
        name: v.name,
        type: v.type || 'int'
      }));

      return convertBlockTreeToAbs(blockAbi, variables);
    } catch (e) {
      // 序列化失败时返回块类型作为降级
      return block.type;
    }
  }

  /**
   * 格式化块上下文为 LLM 友好的精简文本
   */
  private _formatBlockContextForLLM(blockType: string, absSnippet: string, cppLineRange: string, absLineRange: string): string {
    const lines: string[] = [];
    lines.push('[用户选中的积木块]');
    lines.push(`块类型: ${blockType}`);
    lines.push(`ABS代码:`);
    lines.push(this._truncateAbsSnippet(absSnippet));
    if (absLineRange !== '无') {
      lines.push(`对应ABS代码行数: ${absLineRange}`);
    }
    lines.push(`对应C++代码行数: ${cppLineRange}`);
    return lines.join('\n');
  }

  /**
   * 截断过长的 ABS 代码片段
   * 超过 6 行时保留前 3 行和后 3 行，中间用 ... 省略
   */
  private _truncateAbsSnippet(abs: string): string {
    const lines = abs.split('\n');
    if (lines.length <= 6) return abs;
    const head = lines.slice(0, 3);
    const tail = lines.slice(-3);
    return [...head, `    ... (${lines.length - 6} lines omitted)`, ...tail].join('\n');
  }

  /**
   * 从缓存的 ABS blockLineMap 中查找选中块的行号范围
   * 该 map 由 abs-auto-sync 服务在生成 .abs 文件时同步更新，
   * 确保行号与用户实际看到的 ABS 文件完全一致。
   * 若缓存为空（abs-auto-sync 尚未运行），则即时生成作为降级
   */
  private _getBlockAbsLineRange(block: Blockly.Block, absSnippet: string): string {
    try {
      if (!absSnippet) return '无';

      let blockLineMap = this.absBlockLineMap.value;

      // 缓存为空时即时生成（降级）
      if (!blockLineMap || blockLineMap.size === 0) {
        if (!this.workspace) return '无';
        const workspaceJson = Blockly.serialization.workspaces.save(this.workspace);
        const result = convertAbiToAbsWithLineMap(workspaceJson, { includeHeader: true });
        blockLineMap = result.blockLineMap;
        // 缓存供后续使用
        this.absBlockLineMap.next(blockLineMap);
      }

      // 直接查找选中块的行号范围
      const range = blockLineMap.get(block.id);
      if (range) {
        return range.startLine === range.endLine
          ? `${range.startLine}`
          : `${range.startLine}-${range.endLine}`;
      }

      // 值块被内联到父块参数中，通过父块 ID 查找
      const parentBlock = block.getParent();
      if (parentBlock) {
        const parentRange = blockLineMap.get(parentBlock.id);
        if (parentRange) {
          return `${parentRange.startLine}`;
        }
      }

      return '无';
    } catch (e) {
      return '无';
    }
  }

  /**
   * 获取当前选中block的简短上下文标签（用于AI助手上下文列表展示）
   * 格式：blockly:C10-20（C++行号）或 blockly:A5-12（ABS行号）
   * @returns { label, formatted, blockId } 或 null
   */
  getSelectedBlockContextLabel(): { label: string; formatted: string; blockId: string } | null {
    const ctx = this.getSelectedBlockContext();
    if (!ctx) return null;

    // 构建标签：优先显示 C++ 行号和 ABS 行号
    const parts: string[] = [];
    if (ctx.absLineRange !== '无') parts.push(`A${ctx.absLineRange}`);
    if (ctx.cppLineRange !== '无') parts.push(`C${ctx.cppLineRange}`);

    const label = parts.length > 0
      ? `blockly:${parts.join('/')}`
      : `blockly:${ctx.blockType}`;

    return {
      label,
      formatted: ctx.formatted,
      blockId: ctx.blockId
    };
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
