import type { ToolUseResult } from '../core/tool-types';
import { BlockAnalyzer, LibraryBlockKnowledge, EnrichedBlockDefinition, UsagePattern, BlockRelationGraph } from "./blockAnalyzer";

// 智能块助手相关接口
export interface IntentAnalysis {
  action: string;
  target: string;
  data: string[];
  hardware: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  keywords: string[];
  category: 'sensor' | 'communication' | 'display' | 'control' | 'mixed';
}

export interface MatchedPattern {
  pattern: UsagePattern;
  library: string;
  score: number;
  reason: string;
}

export interface BlockSequenceStep {
  blockType: string;
  library: string;
  purpose: string;
  suggestedFields: Record<string, any>;
  suggestedInputs: Record<string, any>;
  position: { x: number; y: number };
  connectionTo?: {
    stepIndex: number;
    connectionType: 'next' | 'input' | 'statement';
    inputName?: string;
  };
  required: boolean;
}

export interface BlockSequenceResult {
  sequence: BlockSequenceStep[];
  explanation: string;
  alternatives: AlternativeSequence[];
  validation: ValidationResult;
  estimatedComplexity: 'beginner' | 'intermediate' | 'advanced';
}

export interface AlternativeSequence {
  name: string;
  description: string;
  sequence: BlockSequenceStep[];
  score: number;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  warnings: string[];
  suggestions: string[];
}

export interface ValidationIssue {
  type: 'missing_block' | 'invalid_connection' | 'missing_field' | 'incompatible_types';
  message: string;
  stepIndex: number;
  severity: 'error' | 'warning';
}

/**
 * 智能块助手 - 基于用户意图和实际可用块生成智能块序列
 */
export class IntelligentBlockAssistant {
  
  private static libraryKnowledgeCache = new Map<string, LibraryBlockKnowledge>();
  
  /**
   * 智能块序列生成 - 基于用户意图和实际可用块
   */
  static async generateBlockSequence(
    userIntent: string,
    targetLibraries: string[] = [],
    projectService: any = null,
    options: {
      maxBlocks?: number;
      complexityPreference?: 'simple' | 'balanced' | 'comprehensive';
    } = {}
  ): Promise<BlockSequenceResult> {
    
    // console.log(`🧠 开始智能块序列生成`);
    // console.log(`📝 用户意图: ${userIntent}`);
    // console.log(`📚 目标库: ${targetLibraries.join(', ') || '所有已安装库'}`);
    
    // 1. 获取所有相关库的块知识
    const libraryKnowledge = await this.gatherLibraryKnowledge(targetLibraries, projectService);
    // console.log(`📊 获取了 ${libraryKnowledge.size} 个库的知识`);
    
    // 2. 理解用户意图
    const intentAnalysis = await this.analyzeUserIntent(userIntent);
    // console.log(`🎯 意图分析: ${JSON.stringify(intentAnalysis)}`);
    
    // 3. 匹配合适的块和模式
    const matchedPatterns = await this.matchBlockPatterns(intentAnalysis, libraryKnowledge);
    // console.log(`🔍 找到 ${matchedPatterns.length} 个匹配模式`);
    
    // 4. 生成具体的块序列
    const blockSequence = await this.constructBlockSequence(matchedPatterns, intentAnalysis, options);
    // console.log(`🔧 生成了 ${blockSequence.length} 个块的序列`);
    
    // 5. 验证序列的正确性
    const validation = await this.validateBlockSequence(blockSequence, libraryKnowledge);
    // console.log(`✅ 序列验证${validation.isValid ? '通过' : '失败'}`);
    
    // 6. 生成替代方案
    const alternatives = await this.generateAlternatives(matchedPatterns, blockSequence, intentAnalysis);
    
    return {
      sequence: blockSequence,
      explanation: this.generateSequenceExplanation(blockSequence, intentAnalysis),
      alternatives: alternatives,
      validation: validation,
      estimatedComplexity: this.assessSequenceComplexity(blockSequence)
    };
  }
  
  /**
   * 收集库知识
   */
  static async gatherLibraryKnowledge(targetLibraries: string[], projectService: any = null): Promise<Map<string, LibraryBlockKnowledge>> {
    const knowledge = new Map<string, LibraryBlockKnowledge>();
    
    // 如果没有指定库，分析常用库
    const librariesToAnalyze = targetLibraries.length > 0 ? targetLibraries : [
      '@aily-project/lib-blinker',
      '@aily-project/lib-core-logic'
    ];
    
    for (const library of librariesToAnalyze) {
      try {
        // 检查缓存
        if (this.libraryKnowledgeCache.has(library)) {
          const cached = this.libraryKnowledgeCache.get(library)!;
          // 检查缓存是否过期（1小时）
          if (Date.now() - cached.timestamp < 3600000) {
            knowledge.set(library, cached);
            continue;
          }
        }
        
        // 分析库 - 从 projectService 获取项目路径
        let projectPath: string | undefined = undefined;
        if (projectService) {
          try {
            // 使用与 getContextTool 相同的逻辑获取项目路径
            const currentProjectPath = projectService.currentProjectPath === projectService.projectRootPath ? "" : projectService.currentProjectPath;
            if (currentProjectPath) {
              projectPath = currentProjectPath;
              // console.log(`✅ 获取项目路径: ${projectPath}`);
            } else {
              console.warn('项目路径为空');
            }
          } catch (error) {
            console.warn('获取项目路径失败:', error);
          }
        }
        
        const libraryKnowledge = await BlockAnalyzer.analyzeLibraryBlocks(library, projectPath);
        knowledge.set(library, libraryKnowledge);
        
        // 更新缓存
        this.libraryKnowledgeCache.set(library, libraryKnowledge);
        
      } catch (error) {
        console.warn(`⚠️ 分析库失败: ${library}`, error);
      }
    }
    
    return knowledge;
  }
  
  /**
   * 分析用户意图
   */
  static async analyzeUserIntent(userIntent: string): Promise<IntentAnalysis> {
    const lowerIntent = userIntent.toLowerCase();
    
    // 提取动作
    const action = this.extractAction(lowerIntent);
    
    // 提取目标对象
    const target = this.extractTarget(lowerIntent);
    
    // 提取数据元素
    const data = this.extractDataElements(lowerIntent);
    
    // 提取硬件组件
    const hardware = this.extractHardware(lowerIntent);
    
    // 评估复杂度
    const complexity = this.estimateUserComplexity(lowerIntent);
    
    // 提取关键词
    const keywords = this.extractKeywords(lowerIntent);
    
    // 推断分类
    const category = this.inferCategory(lowerIntent, keywords);
    
    return {
      action,
      target,
      data,
      hardware,
      complexity,
      keywords,
      category
    };
  }
  
  /**
   * 提取动作词
   */
  static extractAction(intent: string): string {
    const actionWords = [
      '读取', '获取', '监测', '检测', '采集',  // 输入动作
      '显示', '输出', '打印', '发送', '控制',  // 输出动作
      '连接', '初始化', '设置', '配置',       // 初始化动作
      '处理', '计算', '转换', '分析'         // 处理动作
    ];
    
    for (const word of actionWords) {
      if (intent.includes(word)) {
        return word;
      }
    }
    
    return '控制'; // 默认动作
  }
  
  /**
   * 提取目标对象
   */
  static extractTarget(intent: string): string {
    const targets = [
      'led', '灯', '指示灯',
      '温度', '湿度', '传感器',
      '显示屏', 'oled', 'lcd', '屏幕',
      '电机', '舵机', '继电器',
      'wifi', '蓝牙', '网络'
    ];
    
    for (const target of targets) {
      if (intent.includes(target)) {
        return target;
      }
    }
    
    return '设备'; // 默认目标
  }
  
  /**
   * 提取数据元素
   */
  static extractDataElements(intent: string): string[] {
    const dataElements: string[] = [];
    const dataWords = [
      '温度', '湿度', '光照', '距离', '压力',
      '数值', '状态', '信号', '数据'
    ];
    
    for (const word of dataWords) {
      if (intent.includes(word)) {
        dataElements.push(word);
      }
    }
    
    return dataElements;
  }
  
  /**
   * 提取硬件组件
   */
  static extractHardware(intent: string): string[] {
    const hardware: string[] = [];
    const hardwareWords = [
      'esp32', 'arduino', 'uno',
      'dht22', 'ds18b20', 'bmp280',
      'oled', 'lcd1602', '数码管',
      'led', '按钮', '开关'
    ];
    
    for (const word of hardwareWords) {
      if (intent.includes(word)) {
        hardware.push(word);
      }
    }
    
    return hardware;
  }
  
  /**
   * 估计复杂度
   */
  static estimateUserComplexity(intent: string): IntentAnalysis['complexity'] {
    let complexity = 0;
    
    // 根据提及的组件数量
    const componentCount = (intent.match(/(?:传感器|显示|控制|wifi|蓝牙|电机)/g) || []).length;
    complexity += componentCount * 0.3;
    
    // 根据关键词复杂度
    const complexWords = ['网络', '通信', '数据库', '云端', '算法', '处理'];
    const simpleWords = ['基础', '简单', '入门', '基本'];
    
    for (const word of complexWords) {
      if (intent.includes(word)) complexity += 0.5;
    }
    
    for (const word of simpleWords) {
      if (intent.includes(word)) complexity -= 0.3;
    }
    
    if (complexity <= 0.5) return 'simple';
    if (complexity <= 1.5) return 'moderate';
    return 'complex';
  }
  
  /**
   * 提取关键词
   */
  static extractKeywords(intent: string): string[] {
    // 移除标点符号，按空格分词
    const words = intent
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 1);
    
    return [...new Set(words)];
  }
  
  /**
   * 推断分类
   */
  static inferCategory(intent: string, keywords: string[]): IntentAnalysis['category'] {
    const categoryKeywords = {
      sensor: ['传感器', '读取', '检测', '监测', '采集', '温度', '湿度', '距离'],
      communication: ['wifi', '蓝牙', '网络', '连接', '通信', '发送', '接收'],
      display: ['显示', '屏幕', 'oled', 'lcd', '输出', '打印'],
      control: ['控制', '电机', '舵机', '继电器', '开关', '调节']
    };
    
    let maxScore = 0;
    let bestCategory: IntentAnalysis['category'] = 'mixed';
    
    for (const [category, words] of Object.entries(categoryKeywords)) {
      const score = words.reduce((sum, word) => {
        return sum + (intent.includes(word) ? 1 : 0);
      }, 0);
      
      if (score > maxScore) {
        maxScore = score;
        bestCategory = category as IntentAnalysis['category'];
      }
    }
    
    // 如果多个分类得分相近，归为混合类型
    if (maxScore <= 1) {
      bestCategory = 'mixed';
    }
    
    return bestCategory;
  }
  
  /**
   * 匹配块模式
   */
  static async matchBlockPatterns(
    intent: IntentAnalysis,
    knowledge: Map<string, LibraryBlockKnowledge>
  ): Promise<MatchedPattern[]> {
    
    const allPatterns: MatchedPattern[] = [];
    
    for (const [library, libraryKnowledge] of knowledge) {
      for (const pattern of libraryKnowledge.usagePatterns) {
        const score = this.calculatePatternMatch(pattern, intent, libraryKnowledge);
        
        if (score > 0.3) {
          allPatterns.push({
            pattern,
            library,
            score,
            reason: this.explainPatternMatch(pattern, intent, score)
          });
        }
      }
    }
    
    return allPatterns
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }
  
  /**
   * 计算模式匹配分数
   */
  static calculatePatternMatch(
    pattern: UsagePattern,
    intent: IntentAnalysis,
    libraryKnowledge: LibraryBlockKnowledge
  ): number {
    let score = 0;
    
    // 1. 关键词匹配 (40%)
    const keywordMatch = intent.keywords.reduce((acc, keyword) => {
      const inName = pattern.name.toLowerCase().includes(keyword) ? 0.3 : 0;
      const inDescription = pattern.description.toLowerCase().includes(keyword) ? 0.2 : 0;
      const inTags = pattern.tags.some(tag => tag.toLowerCase().includes(keyword)) ? 0.5 : 0;
      return acc + Math.max(inName, inDescription, inTags);
    }, 0) / Math.max(intent.keywords.length, 1);
    
    score += keywordMatch * 0.4;
    
    // 2. 复杂度匹配 (20%)
    const complexityMatch = this.matchComplexity(pattern.complexity, intent.complexity);
    score += complexityMatch * 0.2;
    
    // 3. 分类匹配 (20%)
    const categoryMatch = this.matchCategory(pattern, intent.category);
    score += categoryMatch * 0.2;
    
    // 4. 动作匹配 (10%)
    const actionMatch = this.matchAction(pattern, intent.action);
    score += actionMatch * 0.1;
    
    // 5. 硬件匹配 (10%)
    const hardwareMatch = this.matchHardware(pattern, intent.hardware);
    score += hardwareMatch * 0.1;
    
    return Math.min(score, 1.0);
  }
  
  /**
   * 匹配复杂度
   */
  static matchComplexity(patternComplexity: string, intentComplexity: string): number {
    const complexityMap = { 'beginner': 0, 'intermediate': 1, 'advanced': 2 };
    const intentMap = { 'simple': 0, 'moderate': 1, 'complex': 2 };
    
    const patternLevel = complexityMap[patternComplexity] || 1;
    const intentLevel = intentMap[intentComplexity] || 1;
    
    const diff = Math.abs(patternLevel - intentLevel);
    return Math.max(0, 1 - diff * 0.3);
  }
  
  /**
   * 匹配分类
   */
  static matchCategory(pattern: UsagePattern, intentCategory: string): number {
    // 根据模式标签推断其分类
    const patternCategories = this.inferPatternCategories(pattern);
    
    if (intentCategory === 'mixed') {
      return 0.8; // 混合类型给中等分数
    }
    
    return patternCategories.includes(intentCategory) ? 1.0 : 0.3;
  }
  
  /**
   * 推断模式分类
   */
  static inferPatternCategories(pattern: UsagePattern): string[] {
    const categories: string[] = [];
    const tags = pattern.tags.join(' ').toLowerCase();
    const desc = pattern.description.toLowerCase();
    
    if (tags.includes('sensor') || desc.includes('传感器') || desc.includes('读取')) {
      categories.push('sensor');
    }
    if (tags.includes('wifi') || tags.includes('bluetooth') || desc.includes('连接')) {
      categories.push('communication');
    }
    if (tags.includes('display') || desc.includes('显示') || desc.includes('输出')) {
      categories.push('display');
    }
    if (tags.includes('control') || desc.includes('控制')) {
      categories.push('control');
    }
    
    return categories.length > 0 ? categories : ['mixed'];
  }
  
  /**
   * 匹配动作
   */
  static matchAction(pattern: UsagePattern, intentAction: string): number {
    const desc = pattern.description.toLowerCase();
    return desc.includes(intentAction) ? 1.0 : 0.5;
  }
  
  /**
   * 匹配硬件
   */
  static matchHardware(pattern: UsagePattern, intentHardware: string[]): number {
    if (intentHardware.length === 0) return 0.5;
    
    const desc = pattern.description.toLowerCase();
    const tags = pattern.tags.join(' ').toLowerCase();
    
    const matches = intentHardware.filter(hw => 
      desc.includes(hw) || tags.includes(hw)
    );
    
    return matches.length / intentHardware.length;
  }
  
  /**
   * 解释模式匹配原因
   */
  static explainPatternMatch(pattern: UsagePattern, intent: IntentAnalysis, score: number): string {
    const reasons: string[] = [];
    
    if (score > 0.8) {
      reasons.push('高度匹配用户需求');
    } else if (score > 0.6) {
      reasons.push('较好匹配用户需求');
    } else {
      reasons.push('部分匹配用户需求');
    }
    
    // 添加具体匹配原因
    const matchedKeywords = intent.keywords.filter(kw => 
      pattern.name.toLowerCase().includes(kw) || 
      pattern.description.toLowerCase().includes(kw) ||
      pattern.tags.some(tag => tag.toLowerCase().includes(kw))
    );
    
    if (matchedKeywords.length > 0) {
      reasons.push(`关键词匹配: ${matchedKeywords.join(', ')}`);
    }
    
    return reasons.join('; ');
  }
  
  /**
   * 构建块序列
   */
  static async constructBlockSequence(
    patterns: MatchedPattern[],
    intent: IntentAnalysis,
    options: { maxBlocks?: number; complexityPreference?: string } = {}
  ): Promise<BlockSequenceStep[]> {
    
    if (patterns.length === 0) {
      // 如果没有匹配的模式，生成基础序列
      return this.generateBasicSequence(intent);
    }
    
    const bestPattern = patterns[0];
    const sequence: BlockSequenceStep[] = [];
    
    // console.log(`🎯 使用最佳模式: ${bestPattern.pattern.name} (得分: ${bestPattern.score.toFixed(2)})`);
    
    for (let i = 0; i < bestPattern.pattern.sequence.length; i++) {
      const step = bestPattern.pattern.sequence[i];
      
      // 检查块数量限制
      if (options.maxBlocks && sequence.length >= options.maxBlocks) {
        break;
      }
      
      // 验证块是否存在
      const blockExists = await this.verifyBlockExists(step.blockType, bestPattern.library);
      if (!blockExists) {
        console.warn(`⚠️ 块 ${step.blockType} 不存在，跳过`);
        continue;
      }
      
      const sequenceStep: BlockSequenceStep = {
        blockType: step.blockType,
        library: bestPattern.library,
        purpose: step.purpose,
        suggestedFields: await this.suggestFieldValues(step.blockType, intent, bestPattern.library),
        suggestedInputs: await this.suggestInputValues(step.blockType, intent, bestPattern.library),
        position: step.position || this.calculatePosition(sequence.length),
        connectionTo: this.findConnectionTarget(step, sequence, i),
        required: !step.optional
      };
      
      sequence.push(sequenceStep);
    }
    
    return sequence;
  }
  
  /**
   * 生成基础序列（当没有匹配模式时）
   */
  static async generateBasicSequence(intent: IntentAnalysis): Promise<BlockSequenceStep[]> {
    const sequence: BlockSequenceStep[] = [];
    
    // 基础结构：setup + loop
    sequence.push({
      blockType: 'arduino_setup',
      library: '@aily-project/lib-core-logic',
      purpose: 'setup_container',
      suggestedFields: {},
      suggestedInputs: {},
      position: { x: 20, y: 20 },
      required: true
    });
    
    sequence.push({
      blockType: 'arduino_loop',
      library: '@aily-project/lib-core-logic',
      purpose: 'loop_container',
      suggestedFields: {},
      suggestedInputs: {},
      position: { x: 20, y: 200 },
      required: true
    });
    
    return sequence;
  }
  
  /**
   * 验证块是否存在
   */
  static async verifyBlockExists(blockType: string, library: string): Promise<boolean> {
    try {
      const knowledge = this.libraryKnowledgeCache.get(library);
      if (!knowledge) return false;
      
      return knowledge.blocks.some(block => block.type === blockType);
    } catch (error) {
      return false;
    }
  }
  
  /**
   * 建议字段值
   */
  static async suggestFieldValues(
    blockType: string, 
    intent: IntentAnalysis, 
    library: string
  ): Promise<Record<string, any>> {
    const suggestions: Record<string, any> = {};
    
    // 根据块类型和用户意图提供智能建议
    if (blockType.includes('init') || blockType.includes('begin')) {
      // 初始化块的建议
      if (intent.hardware.includes('esp32')) {
        suggestions['BOARD'] = 'ESP32';
      }
    }
    
    // 根据用户提到的硬件组件提供建议
    for (const hw of intent.hardware) {
      if (hw.includes('led')) {
        suggestions['PIN'] = '13'; // 默认LED引脚
      }
      if (hw.includes('dht22')) {
        suggestions['TYPE'] = 'DHT22';
        suggestions['PIN'] = '2';
      }
    }
    
    return suggestions;
  }
  
  /**
   * 建议输入值
   */
  static async suggestInputValues(
    blockType: string, 
    intent: IntentAnalysis, 
    library: string
  ): Promise<Record<string, any>> {
    const suggestions: Record<string, any> = {};
    
    // 根据块类型提供输入建议
    // 这里可以根据块的输入定义和用户意图进行智能匹配
    
    return suggestions;
  }
  
  /**
   * 计算位置
   */
  static calculatePosition(index: number): { x: number; y: number } {
    return {
      x: 20,
      y: 20 + index * 80
    };
  }
  
  /**
   * 查找连接目标
   */
  static findConnectionTarget(
    step: any, 
    sequence: BlockSequenceStep[], 
    currentIndex: number
  ): BlockSequenceStep['connectionTo'] | undefined {
    
    if (currentIndex === 0) return undefined;
    
    // 简单策略：连接到前一个块
    const previousStep = sequence[currentIndex - 1];
    if (previousStep) {
      return {
        stepIndex: currentIndex - 1,
        connectionType: 'next'
      };
    }
    
    return undefined;
  }
  
  /**
   * 验证块序列
   */
  static async validateBlockSequence(
    sequence: BlockSequenceStep[],
    knowledge: Map<string, LibraryBlockKnowledge>
  ): Promise<ValidationResult> {
    
    const issues: ValidationIssue[] = [];
    const warnings: string[] = [];
    
    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i];
      
      // 验证块是否存在
      const blockExists = await this.verifyBlockExists(step.blockType, step.library);
      if (!blockExists) {
        issues.push({
          type: 'missing_block',
          message: `块类型 ${step.blockType} 在库 ${step.library} 中不存在`,
          stepIndex: i,
          severity: 'error'
        });
      }
      
      // 验证连接关系
      if (step.connectionTo && step.connectionTo.stepIndex < i) {
        const canConnect = await this.validateConnection(step, sequence[step.connectionTo.stepIndex], knowledge);
        if (!canConnect) {
          issues.push({
            type: 'invalid_connection',
            message: `${step.blockType} 无法连接到 ${sequence[step.connectionTo.stepIndex].blockType}`,
            stepIndex: i,
            severity: 'error'
          });
        }
      }
      
      // 检查必需字段
      const requiredFields = await this.getRequiredFields(step.blockType, step.library, knowledge);
      for (const field of requiredFields) {
        if (!step.suggestedFields[field]) {
          warnings.push(`${step.blockType} 的必需字段 ${field} 需要用户配置`);
        }
      }
    }
    
    return {
      isValid: issues.filter(i => i.severity === 'error').length === 0,
      issues,
      warnings,
      suggestions: this.generateValidationSuggestions(issues, warnings)
    };
  }
  
  /**
   * 验证连接
   */
  static async validateConnection(
    sourceStep: BlockSequenceStep,
    targetStep: BlockSequenceStep,
    knowledge: Map<string, LibraryBlockKnowledge>
  ): Promise<boolean> {
    
    const sourceKnowledge = knowledge.get(sourceStep.library);
    const targetKnowledge = knowledge.get(targetStep.library);
    
    if (!sourceKnowledge || !targetKnowledge) return false;
    
    const sourceBlock = sourceKnowledge.blocks.find(b => b.type === sourceStep.blockType);
    const targetBlock = targetKnowledge.blocks.find(b => b.type === targetStep.blockType);
    
    if (!sourceBlock || !targetBlock) return false;
    
    // 检查连接兼容性
    if (sourceStep.connectionTo?.connectionType === 'next') {
      return sourceBlock.connectionTypes.hasNext && targetBlock.connectionTypes.hasPrevious;
    }
    
    return true; // 默认兼容
  }
  
  /**
   * 获取必需字段
   */
  static async getRequiredFields(
    blockType: string,
    library: string,
    knowledge: Map<string, LibraryBlockKnowledge>
  ): Promise<string[]> {
    
    const libraryKnowledge = knowledge.get(library);
    if (!libraryKnowledge) return [];
    
    const block = libraryKnowledge.blocks.find(b => b.type === blockType);
    if (!block) return [];
    
    return block.fields.filter(f => f.required).map(f => f.name);
  }
  
  /**
   * 生成验证建议
   */
  static generateValidationSuggestions(issues: ValidationIssue[], warnings: string[]): string[] {
    const suggestions: string[] = [];
    
    if (issues.length > 0) {
      suggestions.push('建议检查并修复所有错误后再继续');
    }
    
    if (warnings.length > 0) {
      suggestions.push('请配置所有必需的字段以确保代码正常工作');
    }
    
    return suggestions;
  }
  
  /**
   * 生成序列说明
   */
  static generateSequenceExplanation(sequence: BlockSequenceStep[], intent: IntentAnalysis): string {
    if (sequence.length === 0) {
      return '无法生成有效的块序列';
    }
    
    const setupBlocks = sequence.filter(s => s.purpose.includes('setup') || s.purpose.includes('init'));
    const mainBlocks = sequence.filter(s => s.purpose.includes('main') || s.purpose.includes('logic'));
    
    let explanation = `为实现"${intent.action}${intent.target}"的需求，生成了包含 ${sequence.length} 个块的序列：\n`;
    
    if (setupBlocks.length > 0) {
      explanation += `\n📋 初始化部分 (${setupBlocks.length}个块)：设置硬件和配置参数`;
    }
    
    if (mainBlocks.length > 0) {
      explanation += `\n🔄 主要逻辑 (${mainBlocks.length}个块)：实现核心功能`;
    }
    
    return explanation;
  }
  
  /**
   * 生成替代方案
   */
  static async generateAlternatives(
    patterns: MatchedPattern[],
    currentSequence: BlockSequenceStep[],
    intent: IntentAnalysis
  ): Promise<AlternativeSequence[]> {
    
    const alternatives: AlternativeSequence[] = [];
    
    // 从其他匹配的模式生成替代方案
    for (let i = 1; i < Math.min(patterns.length, 3); i++) {
      const pattern = patterns[i];
      
      const altSequence = await this.constructBlockSequence([pattern], intent);
      
      alternatives.push({
        name: `方案 ${i + 1}: ${pattern.pattern.name}`,
        description: pattern.pattern.description,
        sequence: altSequence,
        score: pattern.score
      });
    }
    
    return alternatives;
  }
  
  /**
   * 评估序列复杂度
   */
  static assessSequenceComplexity(sequence: BlockSequenceStep[]): 'beginner' | 'intermediate' | 'advanced' {
    let complexity = 0;
    
    // 根据块数量
    complexity += sequence.length * 0.2;
    
    // 根据连接复杂度
    const connections = sequence.filter(s => s.connectionTo).length;
    complexity += connections * 0.3;
    
    // 根据字段配置复杂度
    const configuredFields = sequence.reduce((sum, s) => sum + Object.keys(s.suggestedFields).length, 0);
    complexity += configuredFields * 0.1;
    
    if (complexity <= 2) return 'beginner';
    if (complexity <= 4) return 'intermediate';
    return 'advanced';
  }
  
  /**
   * 验证块类型列表是否存在
   */
  static async verifyBlockTypes(
    blockTypes: string[],
    libraries: string[] = [],
    projectService: any = null
  ): Promise<{ [blockType: string]: { exists: boolean; library?: string; alternatives?: string[] } }> {
    
    const result: { [blockType: string]: { exists: boolean; library?: string; alternatives?: string[] } } = {};
    
    // 获取库知识
    const knowledge = await this.gatherLibraryKnowledge(libraries, projectService);
    
    for (const blockType of blockTypes) {
      let found = false;
      let foundLibrary = '';
      
      // 在所有库中查找
      for (const [library, libraryKnowledge] of knowledge) {
        const blockExists = libraryKnowledge.blocks.some(block => block.type === blockType);
        if (blockExists) {
          found = true;
          foundLibrary = library;
          break;
        }
      }
      
      const alternatives: string[] = [];
      if (!found) {
        // 查找相似的块
        for (const [library, libraryKnowledge] of knowledge) {
          for (const block of libraryKnowledge.blocks) {
            if (this.calculateSimilarity(blockType, block.type) > 0.6) {
              alternatives.push(block.type);
            }
          }
        }
      }
      
      result[blockType] = {
        exists: found,
        library: found ? foundLibrary : undefined,
        alternatives: alternatives.slice(0, 3) // 最多3个替代建议
      };
    }
    
    return result;
  }
  
  /**
   * 计算字符串相似度
   */
  static calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }
  
  /**
   * 计算编辑距离
   */
  static levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }
}