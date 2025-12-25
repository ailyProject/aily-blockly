import { ToolUseResult } from "./tools";
import { templateCacheService } from './services/templateCacheService';

// 核心接口定义
export interface LibraryBlockKnowledge {
  library: string;
  blocks: EnrichedBlockDefinition[];
  categories: CategoryInfo[];
  usagePatterns: UsagePattern[];
  dependencies: Map<string, string[]>;
  blockRelations: BlockRelationGraph;
  timestamp: number;
  version: string;
}

export interface EnrichedBlockDefinition {
  type: string;
  category: string;
  displayName: string;
  description: string;
  
  // 输入输出分析
  inputs: InputInfo[];
  outputs: OutputInfo[];
  
  // 字段分析
  fields: FieldInfo[];
  
  // 连接性分析
  connectionTypes: ConnectionTypeInfo;
  
  // 语义分析
  purpose: BlockPurpose;
  complexity: BlockComplexity;
  
  // 生成器信息
  generatorInfo?: GeneratorInfo;
  
  // 原始定义
  rawDefinition: any;
}

export interface InputInfo {
  name: string;
  type: 'value' | 'statement';
  expectedType?: string;
  required: boolean;
  description?: string;
}

export interface OutputInfo {
  type: string;
  description?: string;
}

export interface FieldInfo {
  name: string;
  type: 'text' | 'dropdown' | 'checkbox' | 'number' | 'colour' | 'variable' | 'custom';
  defaultValue?: any;
  options?: string[];
  required: boolean;
  description?: string;
}

export interface ConnectionTypeInfo {
  hasPrevious: boolean;
  hasNext: boolean;
  hasOutput: boolean;
  acceptsStatement: boolean;
  outputType?: string;
}

export type BlockPurpose = 'initialization' | 'control' | 'data_input' | 'data_output' | 'logic' | 'communication' | 'display' | 'sensor' | 'actuator' | 'utility';
export type BlockComplexity = 'simple' | 'moderate' | 'complex';

export interface GeneratorInfo {
  blockType: string;
  generatedCode: string;
  dependencies: string[];
  variables: string[];
  libraries: string[];
  setupCode?: string;
  loopCode?: string;
  globalCode?: string;
  includeCode?: string;
}

export interface CategoryInfo {
  name: string;
  colour?: string;
  blocks: string[];
}

export interface UsagePattern {
  id: string;
  name: string;
  description: string;
  sequence: Array<{
    blockType: string;
    purpose: string;
    optional?: boolean;
    position?: { x: number; y: number };
  }>;
  complexity: 'beginner' | 'intermediate' | 'advanced';
  estimatedBlocks: number;
  tags: string[];
}

export interface BlockRelationGraph {
  initializationBlocks: string[];
  loopBlocks: string[];
  dataBlocks: string[];
  controlBlocks: string[];
  dependencies: Map<string, string[]>;
  compatibleConnections: Map<string, string[]>;
}

/**
 * 块分析器 - 深度分析库的所有可用块
 */
export class BlockAnalyzer {
  
  /**
   * 深度分析库的所有可用块
   */
  static async analyzeLibraryBlocks(libraryName: string, projectPath?: string): Promise<LibraryBlockKnowledge> {
    // console.log(`🔍 开始分析库: ${libraryName}`);
    
    // 首先检查缓存
    const libraryPath = await this.getLibraryPath(libraryName, projectPath);
    const cachedResult = await templateCacheService.getCachedAnalysis(libraryPath);
    if (cachedResult) {
      // console.log(`📦 使用缓存的分析结果: ${libraryName}`);
      return cachedResult;
    }
    
    try {
      // console.log(`�📂 库路径: ${libraryPath}`);
      
      // 1. 解析 block.json - 获取块定义
      const blockDefinitions = await this.parseBlockDefinitions(libraryPath);
      // console.log(`📦 找到 ${blockDefinitions.length} 个块定义`);
      
      // 2. 解析 generator.js - 获取C++代码生成逻辑
      const generatorLogic = await this.parseGeneratorLogic(libraryPath);
      // console.log(`⚙️ 解析了 ${generatorLogic.size} 个生成器`);
      
      // 3. 解析 toolbox.json - 获取分类和工具箱信息
      const toolboxInfo = await this.parseToolboxInfo(libraryPath);
      // console.log(`🔧 解析了 ${toolboxInfo.categories.length} 个分类`);
      
      // 4. 关联分析 - 建立块与C++代码的映射关系
      const blockRelations = await this.analyzeBlockRelations(blockDefinitions, generatorLogic);
      // console.log(`🔗 分析了块关系图`);
      
      // 5. 生成使用知识图谱
      const usagePatterns = await this.extractUsagePatterns(blockRelations, toolboxInfo, blockDefinitions);
      // console.log(`📋 生成了 ${usagePatterns.length} 个使用模式`);
      
      // 6. 丰富块信息
      const enrichedBlocks = this.enrichBlockInformation(blockDefinitions, generatorLogic, blockRelations);
      
      const result: LibraryBlockKnowledge = {
        library: libraryName,
        blocks: enrichedBlocks,
        categories: toolboxInfo.categories,
        usagePatterns,
        dependencies: this.analyzeDependencies(blockRelations),
        blockRelations,
        timestamp: Date.now(),
        version: await this.getLibraryVersion(libraryName, projectPath)
      };
      
      // 缓存分析结果
      const filePaths = [
        `${libraryPath}/block.json`,
        `${libraryPath}/generator.js`,
        `${libraryPath}/toolbox.json`
      ];
      templateCacheService.setCachedAnalysis(libraryPath, result, filePaths);
      
      // console.log(`✅ 库分析完成: ${libraryName}`);
      return result;
      
    } catch (error) {
      console.warn(`❌ 分析库失败: ${libraryName}`, error);
      throw new Error(`分析库 ${libraryName} 失败: ${error.message}`);
    }
  }
  
  /**
   * 解析块定义，提取详细信息
   */
  static async parseBlockDefinitions(libraryPath: string): Promise<EnrichedBlockDefinition[]> {
    const blockJsonPath = `${libraryPath}/block.json`;
    
    try {
      // 使用 electronAPI.fs 读取文件
      const electronAPI = (window as any).electronAPI;
      const blockContent = electronAPI.fs.readFileSync(blockJsonPath, 'utf8');
      const blocks = JSON.parse(blockContent);
      
      if (!Array.isArray(blocks)) {
        throw new Error('block.json 格式不正确，应该是数组');
      }
      
      return blocks.map(block => this.enrichSingleBlock(block));
      
    } catch (error) {
      console.warn(`⚠️ 读取 block.json 失败: ${error.message}`);
      return [];
    }
  }
  
  /**
   * 丰富单个块的信息
   */
  static enrichSingleBlock(block: any): EnrichedBlockDefinition {
    return {
      type: block.type || 'unknown',
      category: this.inferCategory(block),
      displayName: this.extractDisplayName(block),
      description: this.extractDescription(block),
      
      // 输入输出分析
      inputs: this.analyzeInputs(block),
      outputs: this.analyzeOutputs(block),
      
      // 字段分析
      fields: this.analyzeFields(block),
      
      // 连接性分析
      connectionTypes: {
        hasPrevious: block.previousStatement !== undefined,
        hasNext: block.nextStatement !== undefined,
        hasOutput: block.output !== undefined,
        acceptsStatement: this.hasStatementInputs(block),
        outputType: block.output
      },
      
      // 语义分析
      purpose: this.inferPurpose(block),
      complexity: this.assessComplexity(block),
      
      // 原始定义
      rawDefinition: block
    };
  }
  
  /**
   * 推断块的分类
   */
  static inferCategory(block: any): string {
    const type = block.type?.toLowerCase() || '';
    
    if (type.includes('init') || type.includes('begin') || type.includes('setup')) {
      return 'initialization';
    }
    if (type.includes('loop') || type.includes('delay') || type.includes('repeat')) {
      return 'control';
    }
    if (type.includes('sensor') || type.includes('read') || type.includes('get')) {
      return 'input';
    }
    if (type.includes('print') || type.includes('write') || type.includes('set') || type.includes('display')) {
      return 'output';
    }
    if (type.includes('if') || type.includes('while') || type.includes('for')) {
      return 'logic';
    }
    
    return 'utility';
  }
  
  /**
   * 提取显示名称
   */
  static extractDisplayName(block: any): string {
    if (block.message0) {
      // 移除格式化标记，提取纯文本
      return block.message0.replace(/%\d+/g, '').trim();
    }
    
    // 如果没有 message0，使用 type 生成友好名称
    return block.type?.split('_').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ') || 'Unknown Block';
  }
  
  /**
   * 提取描述信息
   */
  static extractDescription(block: any): string {
    return block.tooltip || block.helpUrl || `${block.type} 块`;
  }
  
  /**
   * 分析块的输入
   */
  static analyzeInputs(block: any): InputInfo[] {
    const inputs: InputInfo[] = [];
    
    // 分析 args0, args1, args2 等
    for (let i = 0; i < 10; i++) {
      const args = block[`args${i}`];
      if (!args) continue;
      
      for (const arg of args) {
        if (arg.type === 'input_value' || arg.type === 'input_statement') {
          inputs.push({
            name: arg.name,
            type: arg.type === 'input_value' ? 'value' : 'statement',
            expectedType: arg.check,
            required: true, // 默认为必需，可以后续优化
            description: `${arg.name} 输入`
          });
        }
      }
    }
    
    return inputs;
  }
  
  /**
   * 分析块的输出
   */
  static analyzeOutputs(block: any): OutputInfo[] {
    const outputs: OutputInfo[] = [];
    
    if (block.output) {
      outputs.push({
        type: block.output,
        description: `返回 ${block.output} 类型的值`
      });
    }
    
    return outputs;
  }
  
  /**
   * 分析块的字段
   */
  static analyzeFields(block: any): FieldInfo[] {
    const fields: FieldInfo[] = [];
    
    // 分析 args0, args1, args2 等中的字段
    for (let i = 0; i < 10; i++) {
      const args = block[`args${i}`];
      if (!args) continue;
      
      for (const arg of args) {
        if (arg.type && arg.type.startsWith('field_')) {
          const fieldType = arg.type.replace('field_', '');
          fields.push({
            name: arg.name,
            type: this.mapFieldType(fieldType),
            defaultValue: arg.value || arg.text,
            options: arg.options,
            required: true,
            description: `${arg.name} 字段`
          });
        }
      }
    }
    
    return fields;
  }
  
  /**
   * 映射字段类型
   */
  static mapFieldType(fieldType: string): FieldInfo['type'] {
    const typeMap: Record<string, FieldInfo['type']> = {
      'input': 'text',
      'dropdown': 'dropdown',
      'checkbox': 'checkbox',
      'number': 'number',
      'colour': 'colour',
      'variable': 'variable'
    };
    
    return typeMap[fieldType] || 'custom';
  }
  
  /**
   * 检查是否有语句输入
   */
  static hasStatementInputs(block: any): boolean {
    for (let i = 0; i < 10; i++) {
      const args = block[`args${i}`];
      if (!args) continue;
      
      for (const arg of args) {
        if (arg.type === 'input_statement') {
          return true;
        }
      }
    }
    return false;
  }
  
  /**
   * 推断块的用途
   */
  static inferPurpose(block: any): BlockPurpose {
    const type = block.type?.toLowerCase() || '';
    
    if (type.includes('init') || type.includes('begin') || type.includes('setup')) {
      return 'initialization';
    }
    if (type.includes('if') || type.includes('while') || type.includes('for') || type.includes('repeat')) {
      return 'control';
    }
    if (type.includes('sensor') || type.includes('read') || type.includes('get') || type.includes('input')) {
      return 'data_input';
    }
    if (type.includes('print') || type.includes('write') || type.includes('set') || type.includes('display')) {
      return 'data_output';
    }
    if (type.includes('wifi') || type.includes('bluetooth') || type.includes('mqtt') || type.includes('http')) {
      return 'communication';
    }
    if (type.includes('led') || type.includes('lcd') || type.includes('oled') || type.includes('display')) {
      return 'display';
    }
    if (type.includes('motor') || type.includes('servo') || type.includes('relay')) {
      return 'actuator';
    }
    if (type.includes('math') || type.includes('logic') || type.includes('compare')) {
      return 'logic';
    }
    
    return 'utility';
  }
  
  /**
   * 评估块的复杂度
   */
  static assessComplexity(block: any): BlockComplexity {
    let score = 0;
    
    // 根据输入数量评分
    const inputCount = this.countInputs(block);
    score += inputCount * 0.3;
    
    // 根据字段数量评分
    const fieldCount = this.countFields(block);
    score += fieldCount * 0.2;
    
    // 根据连接类型评分
    if (block.previousStatement !== undefined) score += 0.1;
    if (block.nextStatement !== undefined) score += 0.1;
    if (block.output !== undefined) score += 0.2;
    
    // 根据块名称推断复杂度
    const type = block.type?.toLowerCase() || '';
    if (type.includes('advanced') || type.includes('complex')) score += 0.5;
    if (type.includes('basic') || type.includes('simple')) score -= 0.2;
    
    if (score <= 1.0) return 'simple';
    if (score <= 2.0) return 'moderate';
    return 'complex';
  }
  
  /**
   * 计算输入数量
   */
  static countInputs(block: any): number {
    let count = 0;
    for (let i = 0; i < 10; i++) {
      const args = block[`args${i}`];
      if (!args) continue;
      
      for (const arg of args) {
        if (arg.type === 'input_value' || arg.type === 'input_statement') {
          count++;
        }
      }
    }
    return count;
  }
  
  /**
   * 计算字段数量
   */
  static countFields(block: any): number {
    let count = 0;
    for (let i = 0; i < 10; i++) {
      const args = block[`args${i}`];
      if (!args) continue;
      
      for (const arg of args) {
        if (arg.type && arg.type.startsWith('field_')) {
          count++;
        }
      }
    }
    return count;
  }
  
  /**
   * 解析生成器逻辑
   */
  static async parseGeneratorLogic(libraryPath: string): Promise<Map<string, GeneratorInfo>> {
    const generatorPath = `${libraryPath}/generator.js`;
    const generatorMap = new Map<string, GeneratorInfo>();
    
    try {
      const electronAPI = (window as any).electronAPI;
      const generatorContent = electronAPI.fs.readFileSync(generatorPath, 'utf8');
      
      // 基础解析 - 提取块生成器模式
      const blockGenerators = this.extractBlockGenerators(generatorContent);
      
      for (const [blockType, generatorCode] of blockGenerators) {
        const info = this.analyzeGeneratorCode(blockType, generatorCode);
        generatorMap.set(blockType, info);
      }
      
    } catch (error) {
      console.warn(`⚠️ 读取 generator.js 失败: ${error.message}`);
    }
    
    return generatorMap;
  }
  
  /**
   * 提取块生成器
   */
  static extractBlockGenerators(generatorContent: string): Map<string, string> {
    const generators = new Map<string, string>();
    
    // 匹配 Blockly.Arduino['block_type'] = function(block) { ... }
    const regex = /Blockly\.Arduino\['([^']+)'\]\s*=\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\};/g;
    let match;
    
    while ((match = regex.exec(generatorContent)) !== null) {
      const blockType = match[1];
      const functionBody = match[2];
      generators.set(blockType, functionBody);
    }
    
    return generators;
  }
  
  /**
   * 分析生成器代码
   */
  static analyzeGeneratorCode(blockType: string, generatorCode: string): GeneratorInfo {
    return {
      blockType,
      generatedCode: this.extractCodeTemplate(generatorCode),
      dependencies: this.extractDependencies(generatorCode),
      variables: this.extractVariables(generatorCode),
      libraries: this.extractLibraries(generatorCode),
      setupCode: this.extractSetupCode(generatorCode),
      loopCode: this.extractLoopCode(generatorCode),
      globalCode: this.extractGlobalCode(generatorCode),
      includeCode: this.extractIncludeCode(generatorCode)
    };
  }
  
  /**
   * 提取代码模板
   */
  static extractCodeTemplate(generatorCode: string): string {
    // 查找 return 语句中的代码
    const returnMatch = generatorCode.match(/return\s+['"`]([^'"`]*?)['"`]/);
    if (returnMatch) {
      return returnMatch[1];
    }
    
    // 查找变量赋值中的代码
    const codeMatch = generatorCode.match(/var\s+code\s*=\s*['"`]([^'"`]*?)['"`]/);
    if (codeMatch) {
      return codeMatch[1];
    }
    
    return '';
  }
  
  /**
   * 提取依赖
   */
  static extractDependencies(generatorCode: string): string[] {
    const deps: string[] = [];
    
    // 查找 getValue 调用
    const valueMatches = generatorCode.match(/getValue\([^)]+\)/g);
    if (valueMatches) {
      deps.push(...valueMatches);
    }
    
    return deps;
  }
  
  /**
   * 提取变量
   */
  static extractVariables(generatorCode: string): string[] {
    const variables: string[] = [];
    
    // 查找变量定义
    const varMatches = generatorCode.match(/var\s+(\w+)/g);
    if (varMatches) {
      variables.push(...varMatches.map(match => match.replace('var ', '')));
    }
    
    return variables;
  }
  
  /**
   * 提取库依赖
   */
  static extractLibraries(generatorCode: string): string[] {
    const libraries: string[] = [];
    
    // 查找 #include 语句
    const includeMatches = generatorCode.match(/#include\s*[<"][^>"]+[>"]/g);
    if (includeMatches) {
      libraries.push(...includeMatches);
    }
    
    return libraries;
  }
  
  /**
   * 提取 setup 代码
   */
  static extractSetupCode(generatorCode: string): string | undefined {
    const setupMatch = generatorCode.match(/addSetup\([^)]+\)/);
    return setupMatch ? setupMatch[0] : undefined;
  }
  
  /**
   * 提取 loop 代码
   */
  static extractLoopCode(generatorCode: string): string | undefined {
    const loopMatch = generatorCode.match(/addLoop\([^)]+\)/);
    return loopMatch ? loopMatch[0] : undefined;
  }
  
  /**
   * 提取全局代码
   */
  static extractGlobalCode(generatorCode: string): string | undefined {
    const globalMatch = generatorCode.match(/addGlobal\([^)]+\)/);
    return globalMatch ? globalMatch[0] : undefined;
  }
  
  /**
   * 提取包含代码
   */
  static extractIncludeCode(generatorCode: string): string | undefined {
    const includeMatch = generatorCode.match(/addInclude\([^)]+\)/);
    return includeMatch ? includeMatch[0] : undefined;
  }
  
  /**
   * 解析工具箱信息
   */
  static async parseToolboxInfo(libraryPath: string): Promise<{ categories: CategoryInfo[] }> {
    const toolboxPath = `${libraryPath}/toolbox.json`;
    
    try {
      const electronAPI = (window as any).electronAPI;
      const toolboxContent = electronAPI.fs.readFileSync(toolboxPath, 'utf8');
      const toolbox = JSON.parse(toolboxContent);
      
      const categories: CategoryInfo[] = [];
      
      if (toolbox.name && toolbox.blocks) {
        categories.push({
          name: toolbox.name,
          colour: toolbox.colour,
          blocks: Array.isArray(toolbox.blocks) ? toolbox.blocks.map(b => b.type || b) : []
        });
      }
      
      return { categories };
      
    } catch (error) {
      console.warn(`⚠️ 读取 toolbox.json 失败: ${error.message}`);
      return { categories: [] };
    }
  }
  
  /**
   * 分析块关系
   */
  static async analyzeBlockRelations(
    blocks: EnrichedBlockDefinition[],
    generators: Map<string, GeneratorInfo>
  ): Promise<BlockRelationGraph> {
    
    const relations: BlockRelationGraph = {
      initializationBlocks: [],
      loopBlocks: [],
      dataBlocks: [],
      controlBlocks: [],
      dependencies: new Map(),
      compatibleConnections: new Map()
    };
    
    for (const block of blocks) {
      const generator = generators.get(block.type);
      
      // 分类块的作用
      if (block.purpose === 'initialization' || generator?.setupCode) {
        relations.initializationBlocks.push(block.type);
      }
      
      if (block.connectionTypes.hasNext && block.connectionTypes.hasPrevious) {
        relations.loopBlocks.push(block.type);
      }
      
      if (block.connectionTypes.hasOutput || block.purpose === 'data_input' || block.purpose === 'data_output') {
        relations.dataBlocks.push(block.type);
      }
      
      if (block.purpose === 'control' || block.purpose === 'logic') {
        relations.controlBlocks.push(block.type);
      }
      
      // 分析兼容的连接
      const compatibleTargets = this.findCompatibleConnections(block, blocks);
      relations.compatibleConnections.set(block.type, compatibleTargets);
    }
    
    return relations;
  }
  
  /**
   * 查找兼容的连接
   */
  static findCompatibleConnections(block: EnrichedBlockDefinition, allBlocks: EnrichedBlockDefinition[]): string[] {
    const compatible: string[] = [];
    
    for (const otherBlock of allBlocks) {
      if (block.type === otherBlock.type) continue;
      
      // 如果当前块有 next 连接，可以连接有 previous 连接的块
      if (block.connectionTypes.hasNext && otherBlock.connectionTypes.hasPrevious) {
        compatible.push(otherBlock.type);
      }
      
      // 如果当前块有 output，可以连接到有对应 input 的块
      if (block.connectionTypes.hasOutput) {
        for (const input of otherBlock.inputs) {
          if (input.type === 'value' && (!input.expectedType || input.expectedType === block.connectionTypes.outputType)) {
            compatible.push(otherBlock.type);
            break;
          }
        }
      }
      
      // 如果当前块接受语句，可以连接有 previous 的块
      if (block.connectionTypes.acceptsStatement && otherBlock.connectionTypes.hasPrevious) {
        compatible.push(otherBlock.type);
      }
    }
    
    return compatible;
  }
  
  /**
   * 提取使用模式
   */
  static async extractUsagePatterns(
    relations: BlockRelationGraph,
    toolboxInfo: { categories: CategoryInfo[] },
    blocks: EnrichedBlockDefinition[]
  ): Promise<UsagePattern[]> {
    
    const patterns: UsagePattern[] = [];
    
    // 1. 基础初始化模式
    for (const initBlock of relations.initializationBlocks.slice(0, 3)) {
      const compatibleBlocks = relations.compatibleConnections.get(initBlock) || [];
      const blockInfo = blocks.find(b => b.type === initBlock);
      
      patterns.push({
        id: `${initBlock}_basic_pattern`,
        name: `${blockInfo?.displayName || initBlock} 基础使用`,
        description: `使用 ${blockInfo?.displayName || initBlock} 进行基础初始化和控制`,
        sequence: [
          { blockType: 'arduino_setup', purpose: 'setup_container', position: { x: 20, y: 20 } },
          { blockType: initBlock, purpose: 'initialization', position: { x: 20, y: 100 } },
          { blockType: 'arduino_loop', purpose: 'loop_container', position: { x: 20, y: 200 } },
          ...compatibleBlocks.slice(0, 2).map((blockType, index) => ({
            blockType,
            purpose: 'main_logic',
            position: { x: 20, y: 280 + index * 80 }
          }))
        ],
        complexity: 'beginner',
        estimatedBlocks: 3 + Math.min(compatibleBlocks.length, 2),
        tags: ['basic', 'initialization', initBlock]
      });
    }
    
    // 2. 数据流模式
    const dataProducers = relations.dataBlocks.filter(blockType => {
      const block = blocks.find(b => b.type === blockType);
      return block?.purpose === 'data_input' || block?.purpose === 'sensor';
    }).slice(0, 3);
    
    const dataConsumers = relations.dataBlocks.filter(blockType => {
      const block = blocks.find(b => b.type === blockType);
      return block?.purpose === 'data_output' || block?.purpose === 'display';
    }).slice(0, 2);
    
    for (const producer of dataProducers) {
      for (const consumer of dataConsumers) {
        const producerInfo = blocks.find(b => b.type === producer);
        const consumerInfo = blocks.find(b => b.type === consumer);
        
        patterns.push({
          id: `${producer}_to_${consumer}_pattern`,
          name: `${producerInfo?.displayName || producer} 数据处理`,
          description: `读取 ${producerInfo?.displayName || producer} 数据并通过 ${consumerInfo?.displayName || consumer} 输出`,
          sequence: [
            { blockType: 'arduino_setup', purpose: 'setup_container', position: { x: 20, y: 20 } },
            { blockType: 'arduino_loop', purpose: 'loop_container', position: { x: 20, y: 120 } },
            { blockType: producer, purpose: 'data_source', position: { x: 20, y: 200 } },
            { blockType: consumer, purpose: 'data_sink', position: { x: 20, y: 280 } }
          ],
          complexity: 'intermediate',
          estimatedBlocks: 4,
          tags: ['data-flow', producer, consumer]
        });
      }
    }
    
    return patterns.sort((a, b) => {
      const complexityOrder = { 'beginner': 0, 'intermediate': 1, 'advanced': 2 };
      return complexityOrder[a.complexity] - complexityOrder[b.complexity];
    });
  }
  
  /**
   * 丰富块信息
   */
  static enrichBlockInformation(
    blocks: EnrichedBlockDefinition[],
    generators: Map<string, GeneratorInfo>,
    relations: BlockRelationGraph
  ): EnrichedBlockDefinition[] {
    
    return blocks.map(block => ({
      ...block,
      generatorInfo: generators.get(block.type)
    }));
  }
  
  /**
   * 分析依赖关系
   */
  static analyzeDependencies(relations: BlockRelationGraph): Map<string, string[]> {
    const dependencies = new Map<string, string[]>();
    
    // 初始化块通常被其他块依赖
    for (const initBlock of relations.initializationBlocks) {
      const dependents: string[] = [];
      
      // 查找可能依赖此初始化块的其他块
      for (const [blockType, compatibleBlocks] of relations.compatibleConnections) {
        if (compatibleBlocks.includes(initBlock)) {
          dependents.push(blockType);
        }
      }
      
      dependencies.set(initBlock, dependents);
    }
    
    return dependencies;
  }
  
  /**
   * 获取库路径
   */
  static async getLibraryPath(libraryName: string, projectPath?: string): Promise<string> {
    try {
      // 获取当前项目路径
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.path) {
        throw new Error('Electron API 不可用');
      }
      
      // 从参数或项目服务获取当前项目路径
      let currentProjectPath = projectPath;
      if (!currentProjectPath) {
        currentProjectPath = this.getCurrentProjectPath();
        if (!currentProjectPath) {
          throw new Error('未找到当前项目路径');
        }
      }
      
      // 1. 首先尝试精确匹配
      const exactLibraryPath = electronAPI.path.join(
        currentProjectPath,
        'node_modules',
        libraryName
      );
      
      // console.log(`🔍 库路径解析: ${libraryName} -> ${exactLibraryPath}`);
      
      // 验证精确路径是否存在
      if (electronAPI.fs && electronAPI.fs.existsSync(exactLibraryPath)) {
        return exactLibraryPath;
      }
      
      // 2. 精确匹配失败，尝试模糊匹配
      // console.log(`🔍 精确匹配失败，开始模糊匹配: ${libraryName}`);
      const fuzzyMatchPath = await this.findLibraryByFuzzyMatch(libraryName, currentProjectPath);
      if (fuzzyMatchPath) {
        // console.log(`✅ 模糊匹配成功: ${libraryName} -> ${fuzzyMatchPath}`);
        return fuzzyMatchPath;
      }
      
      throw new Error(`库路径不存在: ${exactLibraryPath}，也未找到模糊匹配`);
      
    } catch (error) {
      throw new Error(`无法获取库路径 ${libraryName}: ${error.message}`);
    }
  }
  
  /**
   * 从 package.json 的 dependencies 中获取已安装库列表
   */
  static getInstalledLibraries(projectPath?: string): string[] {
    try {
      const electronAPI = (window as any).electronAPI;
      const currentProjectPath = projectPath || this.getCurrentProjectPath();
      
      if (!currentProjectPath) {
        console.warn('无法获取项目路径，无法读取 package.json');
        return [];
      }
      
      const packageJsonPath = electronAPI.path.join(currentProjectPath, 'package.json');
      
      if (!electronAPI.fs.existsSync(packageJsonPath)) {
        console.warn('package.json 不存在:', packageJsonPath);
        return [];
      }
      
      const packageContent = electronAPI.fs.readFileSync(packageJsonPath, 'utf8');
      const packageData = JSON.parse(packageContent);
      
      // 获取 dependencies 中的库名列表
      const dependencies = packageData.dependencies || {};
      const libraryNames = Object.keys(dependencies);
      
      // console.log(`📦 从 package.json 读取到 ${libraryNames.length} 个依赖:`, libraryNames);
      
      return libraryNames;
    } catch (error) {
      console.warn('读取 package.json 失败:', error);
      return [];
    }
  }

  /**
   * 智能匹配最佳库名
   */
  static findBestLibraryMatch(partialName: string, candidates: string[]): string | null {
    const partialNameLower = partialName.toLowerCase();
    
    // 匹配策略（按优先级排序）
    const strategies = [
      // 1. 精确匹配
      (name: string) => name.toLowerCase() === partialNameLower,
      
      // 2. 包含完整部分名称（去除前缀）
      (name: string) => {
        const cleanName = name.replace(/^@[\w-]+\/lib-/, '').replace(/^lib-/, '');
        return cleanName.toLowerCase() === partialNameLower;
      },
      
      // 3. 包含部分名称作为子字符串
      (name: string) => name.toLowerCase().includes(partialNameLower),
      
      // 4. 部分名称包含在清理后的名称中
      (name: string) => {
        const cleanName = name.replace(/^@[\w-]+\/lib-/, '').replace(/^lib-/, '');
        return cleanName.toLowerCase().includes(partialNameLower);
      },
      
      // 5. 模糊匹配：检查是否包含部分名称的关键字符
      (name: string) => {
        const cleanName = name.replace(/^@[\w-]+\/lib-/, '').replace(/^lib-/, '').toLowerCase();
        // 检查是否包含输入的所有字符（按顺序）
        let nameIndex = 0;
        for (let i = 0; i < partialNameLower.length; i++) {
          const char = partialNameLower[i];
          nameIndex = cleanName.indexOf(char, nameIndex);
          if (nameIndex === -1) return false;
          nameIndex++;
        }
        return true;
      }
    ];
    
    // 按策略优先级尝试匹配
    for (const strategy of strategies) {
      const matches = candidates.filter(strategy);
      
      if (matches.length === 1) {
        return matches[0];
      } else if (matches.length > 1) {
        // 多个匹配时，选择最短的（通常是最相关的）
        return matches.reduce((a, b) => a.length <= b.length ? a : b);
      }
    }
    
    return null;
  }

  /**
   * 模糊匹配库名称（优先使用 package.json）
   */
  static async findLibraryByFuzzyMatch(partialName: string, projectPath: string): Promise<string | null> {
    try {
      const electronAPI = (window as any).electronAPI;
      
      // 首先尝试从 package.json 获取已安装库列表
      const installedLibraries = this.getInstalledLibraries(projectPath);
      
      if (installedLibraries.length > 0) {
        // console.log(`🔍 使用 package.json 进行模糊匹配: "${partialName}"`);
        
        // 使用智能匹配策略匹配库名
        const bestMatch = this.findBestLibraryMatch(partialName, installedLibraries);
        
        if (bestMatch) {
          // 构建库路径
          const libraryPath = electronAPI.path.join(projectPath, 'node_modules', bestMatch);
          
          // 验证路径是否有效
          if (this.isValidLibraryPath(libraryPath)) {
            // console.log(`🎯 找到匹配库: "${partialName}" -> "${bestMatch}"`);
            return libraryPath;
          }
        }
      }
      
      // 如果 package.json 方法失败，回退到目录扫描
      // console.log(`📁 回退到目录扫描进行模糊匹配: "${partialName}"`);
      return this.findLibraryByDirectoryScan(partialName, projectPath);
      
    } catch (error) {
      console.warn('模糊匹配失败:', error);
      return null;
    }
  }

  /**
   * 回退方案：通过目录扫描进行模糊匹配
   */
  private static findLibraryByDirectoryScan(partialName: string, projectPath: string): Promise<string | null> {
    try {
      const electronAPI = (window as any).electronAPI;
      const nodeModulesPath = electronAPI.path.join(projectPath, 'node_modules');
      
      if (!electronAPI.fs.existsSync(nodeModulesPath)) {
        return Promise.resolve(null);
      }
      
      // 搜索策略：
      // 1. 查找 @aily-project 目录下包含部分名称的库
      // 2. 查找根目录下包含部分名称的库
      const searchPaths = [
        electronAPI.path.join(nodeModulesPath, '@aily-project'),
        nodeModulesPath
      ];
      
      const partialNameLower = partialName.toLowerCase();
      
      for (const searchPath of searchPaths) {
        if (!electronAPI.fs.existsSync(searchPath)) {
          continue;
        }
        
        try {
          const entries = electronAPI.fs.readdirSync(searchPath, { withFileTypes: true });
          
          // 收集所有目录名进行智能匹配
          const directories = entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
          
          // console.log(`📁 在 ${searchPath} 中找到 ${directories.length} 个目录`);
          
          // 使用更智能的匹配策略
          const bestMatch = this.findBestLibraryMatch(partialNameLower, directories);
          
          if (bestMatch) {
            const candidatePath = electronAPI.path.join(searchPath, bestMatch);
            
            // 验证候选路径是否包含必需的文件
            if (this.isValidLibraryPath(candidatePath)) {
              const fullLibraryName = searchPath.includes('@aily-project') 
                ? `@aily-project/${bestMatch}`
                : bestMatch;
              
              // console.log(`🎯 找到匹配库: "${partialName}" -> "${fullLibraryName}"`);
              return Promise.resolve(candidatePath);
            }
          }
        } catch (readError) {
          console.warn(`读取目录失败: ${searchPath}`, readError);
        }
      }
      
      return Promise.resolve(null);
    } catch (error) {
      console.warn('目录扫描模糊匹配失败:', error);
      return Promise.resolve(null);
    }
  }

  /**
   * 验证是否为有效的库路径
   */
  static isValidLibraryPath(libraryPath: string): boolean {
    try {
      const electronAPI = (window as any).electronAPI;
      
      // 检查是否包含必需的文件
      const requiredFiles = ['block.json', 'package.json'];
      
      for (const file of requiredFiles) {
        const filePath = electronAPI.path.join(libraryPath, file);
        if (!electronAPI.fs.existsSync(filePath)) {
          return false;
        }
      }
      
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * 获取当前项目路径
   */
  private static getCurrentProjectPath(): string | null {
    try {
      // 尝试从全局状态获取项目路径
      if ((window as any).projectService?.currentProjectPath) {
        return (window as any).projectService.currentProjectPath;
      }
      
      // 尝试从 Angular 注入器获取
      if ((window as any).ng) {
        const appElement = document.querySelector('app-root');
        if (appElement) {
          try {
            const componentRef = (window as any).ng.getComponent(appElement);
            if (componentRef && componentRef.projectService?.currentProjectPath) {
              return componentRef.projectService.currentProjectPath;
            }
          } catch (error) {
            console.warn('无法从组件获取项目路径:', error);
          }
        }
      }
      
      // 作为备用，尝试从本地存储获取
      try {
        const savedProjectPath = localStorage.getItem('currentProjectPath');
        if (savedProjectPath) {
          // console.log('从本地存储获取项目路径:', savedProjectPath);
          return savedProjectPath;
        }
      } catch (error) {
        console.warn('无法从本地存储获取项目路径:', error);
      }
      
      // console.warn('无法获取当前项目路径，所有方法都失败了');
      return null;
      
    } catch (error) {
      console.warn('获取项目路径时出错:', error);
      return null;
    }
  }
  
  /**
   * 获取库版本
   */
  static async getLibraryVersion(libraryName: string, projectPath?: string): Promise<string> {
    try {
      const libraryPath = await this.getLibraryPath(libraryName, projectPath);
      const packagePath = `${libraryPath}/package.json`;
      const electronAPI = (window as any).electronAPI;
      const packageContent = electronAPI.fs.readFileSync(packagePath, 'utf8');
      const packageData = JSON.parse(packageContent);
      return packageData.version || '1.0.0';
    } catch (error) {
      return '1.0.0';
    }
  }
}