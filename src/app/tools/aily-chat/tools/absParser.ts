/**
 * Blockly ABS 解析器 (Aily Block Syntax)
 * 
 * 将缩进格式的伪代码转换为 Blockly JSON 结构
 * 设计目标：减少 LLM 生成代码时的出错率，提高可读性
 * 
 * @example
 * ```
 * # 变量定义
 * @var count: int = 0
 * 
 * # Arduino 主程序
 * arduino_setup
 *     serial_begin(Serial, 115200)
 *     oled_begin()
 * 
 * arduino_loop
 *     serial_print(Serial, "Count: ")
 *     serial_println(Serial, $count)
 *     math_change($count, 1)
 *     delay(1000)
 * ```
 */

import { BlockConfig } from './editBlockTool';
import { 
  BlockMeta as DynamicBlockMeta,
  getGlobalBlockMetas, 
  setGlobalBlockMetas, 
  loadBlockDefinitionsFromPath 
} from '../services/block-definition.service';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 解析后的变量定义
 */
interface VariableDefinition {
  name: string;
  type: string;
  initialValue?: string;
}

/**
 * 解析后的 ABS 节点
 */
interface AbsNode {
  type: string;                    // 块类型
  fields: Record<string, any>;     // 字段值
  inputs: Record<string, AbsNode | AbsNode[]>;  // 输入（值输入或语句输入）
  children: AbsNode[];             // next 连接的子节点
  indent: number;                  // 缩进级别
  lineNumber: number;              // 源代码行号
  raw: string;                     // 原始行内容
}

/**
 * ABS 解析结果
 */
export interface AbsParseResult {
  success: boolean;
  variables: VariableDefinition[];
  rootBlocks: BlockConfig[];
  errors: Array<{
    line: number;
    message: string;
    suggestion?: string;
  }>;
  warnings: Array<{
    line: number;
    message: string;
  }>;
}

/**
 * 块定义元信息（用于智能解析）- 本地接口用于兼容
 */
interface BlockMeta {
  type: string;
  hasStatementInput?: boolean;        // 是否有语句输入
  statementInputNames?: string[];     // 语句输入名称列表
  valueInputNames?: string[];         // 值输入名称列表
  fieldNames?: string[];              // 字段名称列表
  isRootBlock?: boolean;              // 是否为根块
  isValueBlock?: boolean;             // 是否为无参数值块（如 esp32_wifi_status）
  mutator?: string;                   // mutator 类型（如 function_params_mutator）
}

// =============================================================================
// 动态块定义管理
// =============================================================================

/**
 * 从项目动态加载块定义
 * @param projectPath 项目路径
 */
export function loadProjectBlockDefinitions(projectPath: string): void {
  try {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      console.warn('[absParser] electronAPI 不可用，使用内置块定义');
      return;
    }
    
    const metas = loadBlockDefinitionsFromPath(projectPath, electronAPI);
    setGlobalBlockMetas(metas);
    // console.log(`[absParser] 已从项目加载 ${metas.size} 个块定义`);
  } catch (e) {
    console.warn('[absParser] 加载项目块定义失败:', e);
  }
}

/**
 * 获取块的元信息（优先从动态加载的定义获取）
 */
function getBlockMeta(blockType: string): Partial<BlockMeta> | undefined {
  // 优先从动态加载的块定义获取
  const dynamicMetas = getGlobalBlockMetas();
  const fallback = FALLBACK_BLOCKS[blockType];
  
  if (dynamicMetas) {
    const dynamicMeta = dynamicMetas.get(blockType);
    if (dynamicMeta) {
      const converted = convertDynamicMeta(dynamicMeta);
      
      // 🆕 合并 FALLBACK_BLOCKS 中的 fieldNames（用于动态创建的字段，如 dht_init 的 PIN）
      if (fallback?.fieldNames) {
        const existingFields = new Set(converted.fieldNames || []);
        for (const fieldName of fallback.fieldNames) {
          if (!existingFields.has(fieldName)) {
            converted.fieldNames = converted.fieldNames || [];
            converted.fieldNames.push(fieldName);
          }
        }
      }
      
      // 对于动态输入块（如 text_join），如果动态定义的 valueInputNames 为空，
      // 使用回退定义中的默认输入名称
      if (fallback?.valueInputNames && (!converted.valueInputNames || converted.valueInputNames.length === 0)) {
        converted.valueInputNames = fallback.valueInputNames;
      }
      
      return converted;
    }
  }
  
  // 回退到内置定义
  return fallback;
}

/**
 * 检查块类型是否已知
 */
function isKnownBlock(blockType: string): boolean {
  const dynamicMetas = getGlobalBlockMetas();
  if (dynamicMetas?.has(blockType)) {
    return true;
  }
  return blockType in FALLBACK_BLOCKS;
}

/**
 * 将动态块元信息转换为本地格式
 */
function convertDynamicMeta(meta: DynamicBlockMeta): Partial<BlockMeta> {
  return {
    fieldNames: meta.fieldNames.length > 0 ? meta.fieldNames : undefined,
    valueInputNames: meta.valueInputNames.length > 0 ? meta.valueInputNames : undefined,
    statementInputNames: meta.statementInputNames.length > 0 ? meta.statementInputNames : undefined,
    hasStatementInput: meta.statementInputNames.length > 0,
    isRootBlock: meta.isRootBlock,
    isValueBlock: meta.hasOutput && meta.fieldNames.length === 0 && meta.valueInputNames.length === 0,
    mutator: meta.mutator,
  };
}

// =============================================================================
// 内置块定义（作为动态加载失败时的回退）
// =============================================================================

/**
 * 内置块定义 - 仅包含核心块，作为动态加载失败时的回退
 */
const FALLBACK_BLOCKS: Record<string, Partial<BlockMeta>> = {
  // Arduino 核心块
  'arduino_setup': { 
    isRootBlock: true, 
    hasStatementInput: true, 
    statementInputNames: ['ARDUINO_SETUP'] 
  },
  'arduino_loop': { 
    isRootBlock: true, 
    hasStatementInput: true, 
    statementInputNames: ['ARDUINO_LOOP'] 
  },
  
  // 串口通信
  'serial_begin': { fieldNames: ['SERIAL', 'SPEED'] },
  'serial_print': { fieldNames: ['SERIAL'], valueInputNames: ['VAR'] },
  'serial_println': { fieldNames: ['SERIAL'], valueInputNames: ['VAR'] },
  
  // 时间
  'time_delay': { valueInputNames: ['DELAY_TIME'] },
  'time_millis': { isValueBlock: true },
  
  // 变量定义
  'variable_define': { fieldNames: ['VAR', 'TYPE'], valueInputNames: ['VALUE'] },
  
  // 控制流（Blockly 内置）
  'controls_if': { 
    hasStatementInput: true, 
    statementInputNames: ['DO0', 'ELSE'],
    valueInputNames: ['IF0']
  },
  'controls_switch': {
    hasStatementInput: true,
    statementInputNames: ['DO0', 'DEFAULT'],
    valueInputNames: ['SWITCH', 'CASE0']
  },
  'controls_repeat_ext': { 
    hasStatementInput: true, 
    statementInputNames: ['DO'],
    valueInputNames: ['TIMES']
  },
  'controls_whileUntil': { 
    hasStatementInput: true, 
    statementInputNames: ['DO'],
    valueInputNames: ['BOOL'],
    fieldNames: ['MODE']
  },
  'controls_for': { 
    hasStatementInput: true, 
    statementInputNames: ['DO'],
    valueInputNames: ['FROM', 'TO', 'BY'],
    fieldNames: ['VAR']
  },
  
  // 基础块（Blockly 内置）
  'math_number': { fieldNames: ['NUM'] },
  'math_arithmetic': { fieldNames: ['OP'], valueInputNames: ['A', 'B'] },
  'math_change': { fieldNames: ['VAR'], valueInputNames: ['DELTA'] },
  'text': { fieldNames: ['TEXT'] },
  'text_join': { valueInputNames: ['ADD0', 'ADD1'] },
  'logic_compare': { fieldNames: ['OP'], valueInputNames: ['A', 'B'] },
  'logic_operation': { fieldNames: ['OP'], valueInputNames: ['A', 'B'] },
  'logic_boolean': { fieldNames: ['BOOL'] },
  'logic_negate': { valueInputNames: ['BOOL'] },
  'variables_get': { fieldNames: ['VAR'] },
  'variables_set': { fieldNames: ['VAR'], valueInputNames: ['VALUE'] },
  
  // DHT 传感器（常用）
  // 注意：PIN 是通过 updateShape_ 动态添加的字段，但 ABS 解析时需要知道这个字段名
  // 'dht_init': { fieldNames: ['VAR', 'TYPE', 'PIN'] },
  'dht_init': { fieldNames: ['VAR', 'TYPE'] },
  'dht_read_temperature': { fieldNames: ['VAR'] },
  'dht_read_humidity': { fieldNames: ['VAR'] },
  'dht_read_success': { fieldNames: ['VAR'] },
};

/**
 * 反转义字符串中的转义序列（与 abiAbsConverter 的 escapeString 对应）
 * 使用单次遍历避免 `\\n` 等多重转义的顺序问题
 */
function unescapeString(str: string): string {
  return str.replace(/\\(n|r|t|"|'|\\)/g, (_match, char) => {
    switch (char) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      default: return _match;
    }
  });
}

/**
 * 去掉字符串两端的引号
 */
function stripQuotes(str: string): string {
  if ((str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

/**
 * 特殊语法糖映射
 */
const SYNTAX_SUGAR: Record<string, (args: string[]) => { type: string; fields?: Record<string, any>; inputs?: Record<string, any> }> = {
  // $varName -> variables_get
  'var': (args) => ({
    type: 'variables_get',
    fields: { VAR: { name: args[0] } }
  }),
  
  // text("...") -> text block（去掉参数中的引号）
  'text': (args) => ({
    type: 'text',
    fields: { TEXT: stripQuotes(args[0] || '') }
  }),
  
  // number(123) -> math_number
  'number': (args) => ({
    type: 'math_number',
    fields: { NUM: args[0] || '0' }
  }),
  
  // HIGH/LOW -> logic_boolean 或数字
  'HIGH': () => ({
    type: 'math_number',
    fields: { NUM: '1' }
  }),
  'LOW': () => ({
    type: 'math_number',
    fields: { NUM: '0' }
  }),
  
  // true/false -> logic_boolean
  'true': () => ({
    type: 'logic_boolean',
    fields: { BOOL: 'TRUE' }
  }),
  'false': () => ({
    type: 'logic_boolean',
    fields: { BOOL: 'FALSE' }
  }),
};

// =============================================================================
// 主解析器类
// =============================================================================

export class BlocklyAbsParser {
  private lines: string[] = [];
  private currentLine = 0;
  private variables: VariableDefinition[] = [];
  private errors: AbsParseResult['errors'] = [];
  private warnings: AbsParseResult['warnings'] = [];
  private indentSize = 4;  // 默认缩进大小
  
  /**
   * 解析 ABS 代码
   * @param code ABS 源代码
   * @returns 解析结果
   */
  parse(code: string): AbsParseResult {
    this.reset();
    
    // 预处理：合并跨行的括号内容
    const preprocessedCode = this.mergeMultilineParentheses(code);
    this.lines = preprocessedCode.split('\n');
    
    // 自动检测缩进大小
    this.detectIndentSize();
    
    const rootNodes: AbsNode[] = [];
    
    while (this.currentLine < this.lines.length) {
      const line = this.lines[this.currentLine];
      const trimmed = line.trim();
      
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        this.currentLine++;
        continue;
      }
      
      // 处理变量定义
      if (trimmed.startsWith('@var ')) {
        this.parseVariableDefinition(trimmed);
        this.currentLine++;
        continue;
      }
      
      // 处理命名输入标记（@condition:, @do: 等）
      if (trimmed.startsWith('@') && trimmed.includes(':')) {
        // 这应该在块内部处理，顶层出现是错误
        this.errors.push({
          line: this.currentLine + 1,
          message: `命名输入标记 "${trimmed}" 不能出现在顶层`,
          suggestion: '命名输入应该在块内部使用'
        });
        this.currentLine++;
        continue;
      }
      
      // 解析根块
      const node = this.parseBlock(0);
      if (node) {
        rootNodes.push(node);
      }
    }
    
    // 转换为 BlockConfig
    const rootBlocks = rootNodes.map(node => this.nodeToBlockConfig(node));
    
    return {
      success: this.errors.length === 0,
      variables: this.variables,
      rootBlocks,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  
  /**
   * 重置解析器状态
   */
  private reset(): void {
    this.lines = [];
    this.currentLine = 0;
    this.variables = [];
    this.errors = [];
    this.warnings = [];
  }
  
  /**
   * 预处理：合并跨行的括号内容
   * 
   * 当一个块调用跨越多行时（括号未闭合），将其合并成单行。
   * 例如:
   * ```
   * logic_operation(AND,
   *     logic_compare(EQ, $a, math_number(1)),
   *     logic_compare(EQ, $b, math_number(2)))
   * ```
   * 合并为:
   * ```
   * logic_operation(AND, logic_compare(EQ, $a, math_number(1)), logic_compare(EQ, $b, math_number(2)))
   * ```
   */
  private mergeMultilineParentheses(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let pendingLine = '';
    let parenDepth = 0;
    let baseIndent = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // 跳过空行和注释（但如果在括号内，需要继续）
      if (parenDepth === 0 && (!trimmed || trimmed.startsWith('#'))) {
        result.push(line);
        continue;
      }
      
      // 如果当前没有待合并的行
      if (parenDepth === 0) {
        // 计算括号深度
        const openCount = (line.match(/\(/g) || []).length;
        const closeCount = (line.match(/\)/g) || []).length;
        parenDepth = openCount - closeCount;
        
        if (parenDepth > 0) {
          // 括号未闭合，开始收集
          pendingLine = line;
          // 保存基础缩进
          const indentMatch = line.match(/^(\s*)/);
          baseIndent = indentMatch ? indentMatch[1] : '';
        } else {
          // 括号已闭合，直接添加
          result.push(line);
        }
      } else {
        // 在括号内，继续收集
        // 更新括号深度
        const openCount = (trimmed.match(/\(/g) || []).length;
        const closeCount = (trimmed.match(/\)/g) || []).length;
        parenDepth += openCount - closeCount;
        
        // 合并到待处理行（用空格连接，去掉额外的缩进）
        pendingLine += ' ' + trimmed;
        
        // 如果括号已闭合
        if (parenDepth <= 0) {
          result.push(pendingLine);
          pendingLine = '';
          parenDepth = 0;
          baseIndent = '';
        }
      }
    }
    
    // 如果还有未完成的行（括号未闭合）
    if (pendingLine) {
      result.push(pendingLine);
      this.warnings.push({
        line: lines.length,
        message: '括号未正确闭合，可能导致解析错误'
      });
    }
    
    return result.join('\n');
  }
  
  /**
   * 自动检测缩进大小
   */
  private detectIndentSize(): void {
    for (const line of this.lines) {
      if (line.length > 0 && line[0] === ' ') {
        const spaces = line.match(/^( +)/);
        if (spaces) {
          this.indentSize = spaces[1].length;
          break;
        }
      }
      if (line[0] === '\t') {
        this.indentSize = 1;  // Tab 模式
        break;
      }
    }
  }
  
  /**
   * 获取行的缩进级别
   */
  private getIndentLevel(line: string): number {
    if (!line) return 0;
    const match = line.match(/^([ \t]*)/);
    if (!match) return 0;
    
    const indent = match[1];
    if (indent.includes('\t')) {
      return indent.length;  // Tab 模式
    }
    return Math.floor(indent.length / this.indentSize);
  }
  
  /**
   * 解析变量定义
   * 格式: @var name: type = value
   */
  private parseVariableDefinition(line: string): void {
    // @var count: int = 0
    // @var name: String = "hello"
    const match = line.match(/@var\s+(\w+)\s*:\s*(\w+)\s*(?:=\s*(.+))?/);
    
    if (!match) {
      this.errors.push({
        line: this.currentLine + 1,
        message: `无效的变量定义: ${line}`,
        suggestion: '格式应为: @var name: type = value'
      });
      return;
    }
    
    this.variables.push({
      name: match[1],
      type: match[2],
      initialValue: match[3]?.trim()
    });
  }
  
  /**
   * 解析块
   * @param expectedIndent 期望的缩进级别
   * @returns 解析后的节点
   */
  private parseBlock(expectedIndent: number): AbsNode | null {
    if (this.currentLine >= this.lines.length) {
      return null;
    }
    
    const line = this.lines[this.currentLine];
    const trimmed = line.trim();
    const actualIndent = this.getIndentLevel(line);
    
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      this.currentLine++;
      return this.parseBlock(expectedIndent);
    }
    
    // 如果缩进小于期望，说明块结束
    if (actualIndent < expectedIndent) {
      return null;
    }
    
    // 解析当前行
    const { type, fields, inlineInputs } = this.parseBlockLine(trimmed);
    
    if (!type) {
      this.errors.push({
        line: this.currentLine + 1,
        message: `无法解析块: ${trimmed}`
      });
      this.currentLine++;
      return null;
    }
    
    const node: AbsNode = {
      type,
      fields,
      inputs: { ...inlineInputs },
      children: [],
      indent: actualIndent,
      lineNumber: this.currentLine + 1,
      raw: trimmed
    };
    
    this.currentLine++;
    
    // 解析子块（缩进更深的行）
    const childIndent = expectedIndent + 1;
    const blockMeta = getBlockMeta(type) || {};
    
    // 收集所有缩进更深的行作为子内容
    const childNodes: AbsNode[] = [];
    const namedInputs: Record<string, AbsNode[]> = {};
    let currentInputName: string | null = null;
    
    while (this.currentLine < this.lines.length) {
      const nextLine = this.lines[this.currentLine];
      const nextTrimmed = nextLine.trim();
      const nextIndent = this.getIndentLevel(nextLine);
      
      // 跳过空行和注释
      if (!nextTrimmed || nextTrimmed.startsWith('#')) {
        this.currentLine++;
        continue;
      }
      
      // 如果缩进回到同级或更少，结束子块解析
      if (nextIndent <= actualIndent) {
        break;
      }
      
      // 检查是否是命名输入标记
      if (nextTrimmed.startsWith('@') && nextTrimmed.includes(':')) {
        const inputMatch = nextTrimmed.match(/@(\w+):\s*(.*)?/);
        if (inputMatch) {
          currentInputName = this.normalizeInputName(inputMatch[1]);
          
          // 如果同一行有内容，解析为值输入
          if (inputMatch[2] && inputMatch[2].trim()) {
            const valueNode = this.parseInlineValue(inputMatch[2].trim());
            if (valueNode) {
              node.inputs[currentInputName] = valueNode;
            }
            currentInputName = null;  // 重置，因为已经处理了
          }
          
          this.currentLine++;
          continue;
        }
      }
      
      // 解析子块
      const childNode = this.parseBlock(childIndent);
      if (childNode) {
        if (currentInputName) {
          // 添加到命名输入
          if (!namedInputs[currentInputName]) {
            namedInputs[currentInputName] = [];
          }
          namedInputs[currentInputName].push(childNode);
        } else {
          childNodes.push(childNode);
        }
      }
    }
    
    // 处理子节点
    if (childNodes.length > 0) {
      if (blockMeta.hasStatementInput && blockMeta.statementInputNames) {
        // 如果块有语句输入，将子节点放入第一个语句输入
        const inputName = blockMeta.statementInputNames[0];
        node.inputs[inputName] = childNodes;
      } else {
        // 否则作为 next 连接
        node.children = childNodes;
      }
    }
    
    // 处理命名输入
    for (const [inputName, nodes] of Object.entries(namedInputs)) {
      if (nodes.length === 1) {
        node.inputs[inputName] = nodes[0];
      } else {
        node.inputs[inputName] = nodes;
      }
    }
    
    return node;
  }
  
  /**
   * 解析块行
   * 格式: block_type(arg1, arg2, ...) 或 block_type 或 block_type()
   */
  private parseBlockLine(line: string): {
    type: string;
    fields: Record<string, any>;
    inlineInputs: Record<string, AbsNode>;
  } {
    const fields: Record<string, any> = {};
    const inlineInputs: Record<string, AbsNode> = {};
    
    // 匹配 block_type(args) 或 block_type 或 block_type()（空括号）
    const match = line.match(/^(\w+)(?:\((.*)\))?$/);
    
    if (!match) {
      return { type: '', fields, inlineInputs };
    }
    
    const type = match[1];
    const argsString = match[2];
    
    if (argsString) {
      const args = this.parseArguments(argsString);
      this.assignArguments(type, args, fields, inlineInputs);
    }
    
    return { type, fields, inlineInputs };
  }
  
  /**
   * 解析参数列表
   * 支持嵌套括号和字符串
   */
  private parseArguments(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];
      
      // 处理字符串
      if ((char === '"' || char === "'") && (i === 0 || argsString[i - 1] !== '\\')) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        current += char;
        continue;
      }
      
      if (inString) {
        current += char;
        continue;
      }
      
      // 处理括号嵌套
      if (char === '(' || char === '[' || char === '{') {
        depth++;
        current += char;
      } else if (char === ')' || char === ']' || char === '}') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    if (current.trim()) {
      args.push(current.trim());
    }
    
    return args;
  }
  
  /**
   * 分配参数到字段和输入
   */
  private assignArguments(
    blockType: string,
    args: string[],
    fields: Record<string, any>,
    inlineInputs: Record<string, AbsNode>
  ): void {
    const meta = getBlockMeta(blockType);
    
    // 首先提取命名参数（KEY=value 格式）
    const namedArgs: Record<string, string> = {};
    const positionalArgs: string[] = [];
    
    for (const arg of args) {
      // 检查是否是命名参数（KEY=value 格式）
      // 格式：标识符=值，值可以是任何表达式（包括函数调用）
      const namedMatch = arg.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/i);
      if (namedMatch) {
        // 确保 = 左边是纯标识符（不是比较表达式的一部分）
        const keyPart = namedMatch[1];
        const valuePart = namedMatch[2];
        // 如果 key 是有效的输入名（大写字母开头），视为命名参数
        if (/^[A-Z_][A-Z0-9_]*$/i.test(keyPart)) {
          namedArgs[keyPart.toUpperCase()] = valuePart;
          continue;
        }
      }
      positionalArgs.push(arg);
    }
    
    // 处理命名参数
    for (const [fieldName, value] of Object.entries(namedArgs)) {
      if (this.isComplexExpression(value)) {
        const valueNode = this.parseInlineValue(value);
        if (valueNode) {
          inlineInputs[fieldName] = valueNode;
        }
      } else {
        fields[fieldName] = this.parseFieldValue(value);
      }
    }
    
    // 处理位置参数
    if (meta) {
      // 使用已知的块定义
      let argIndex = 0;
      
      // 先分配字段（跳过已通过命名参数设置的）
      if (meta.fieldNames) {
        for (const fieldName of meta.fieldNames) {
          if (fieldName in fields || fieldName in inlineInputs) continue; // 已设置
          if (argIndex < positionalArgs.length) {
            fields[fieldName] = this.parseFieldValue(positionalArgs[argIndex]);
            argIndex++;
          }
        }
      }
      
      // 再分配值输入（跳过已通过命名参数设置的）
      if (meta.valueInputNames) {
        for (const inputName of meta.valueInputNames) {
          if (inputName in fields || inputName in inlineInputs) continue; // 已设置
          if (argIndex < positionalArgs.length) {
            const valueNode = this.parseInlineValue(positionalArgs[argIndex]);
            if (valueNode) {
              inlineInputs[inputName] = valueNode;
            }
            argIndex++;
          }
        }
      }
      
      // 处理剩余的位置参数（可能是动态扩展添加的输入或字段）
      // 使用 EXTRA_N 模式，后续由 remapExtraFieldsToActualFields 映射到实际名称
      let extraIndex = 0;
      
      while (argIndex < positionalArgs.length) {
        const arg = positionalArgs[argIndex];
        
        // 🔑 使用 EXTRA_N 模式：统一由 editBlockTool 的映射函数处理
        const extraName = `EXTRA_${extraIndex}`;
        
        if (!this.isComplexExpression(arg)) {
          fields[extraName] = this.parseFieldValue(arg);
        } else {
          const valueNode = this.parseInlineValue(arg);
          if (valueNode) {
            inlineInputs[extraName] = valueNode;
          }
        }
        argIndex++;
        extraIndex++;
      }
    } else {
      // 未知块类型，尝试智能分配
      this.smartAssignArguments(blockType, positionalArgs, fields, inlineInputs);
    }
  }
  
  /**
   * 智能分配参数（用于未知块类型）
   */
  private smartAssignArguments(
    blockType: string,
    args: string[],
    fields: Record<string, any>,
    inlineInputs: Record<string, AbsNode>
  ): void {
    // 检查是否是已知的核心动态块
    const coreConfig = CORE_DYNAMIC_BLOCKS[blockType];
    
    // 常见的字段名模式
    const commonFieldNames = ['WIDGET', 'SERIAL', 'PIN', 'MODE', 'OP', 'SPEED', 'VALUE', 'TEXT', 'NUM', 'VAR'];
    const commonInputNames = ['VAR', 'VALUE', 'A', 'B', 'NUM', 'BOOL', 'TEXT', 'PIN'];
    
    let fieldIndex = 0;
    let inputIndex = 0;
    
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      // 检查是否是复杂表达式（包含函数调用或变量引用）
      if (this.isComplexExpression(arg)) {
        // 确定输入名 - 优先使用核心块配置，否则默认 INPUT 前缀
        let inputName: string;
        if (coreConfig) {
          // 核心动态块：使用已知的输入模式
          const patternStr = coreConfig.inputPattern.source;
          const prefixMatch = patternStr.match(/^\^?\(?([A-Z]+)/);
          const prefix = prefixMatch ? prefixMatch[1] : 'INPUT';
          inputName = `${prefix}${inputIndex}`;
        } else {
          // 未知块：默认使用 INPUT 前缀（适用于 dynamic-inputs 插件）
          // 这样可以自动支持任何使用 dynamic-inputs 插件的块
          inputName = `INPUT${inputIndex}`;
        }
        
        const valueNode = this.parseInlineValue(arg);
        if (valueNode) {
          inlineInputs[inputName] = valueNode;
        }
        inputIndex++;
      } else {
        // 简单值作为字段
        const fieldName = fieldIndex < commonFieldNames.length ? commonFieldNames[fieldIndex] : `FIELD${fieldIndex}`;
        fields[fieldName] = this.parseFieldValue(arg);
        fieldIndex++;
      }
    }
  }
  
  /**
   * 检查是否是复杂表达式
   */
  private isComplexExpression(value: string): boolean {
    // 包含函数调用
    if (/\w+\(.+\)/.test(value)) {
      return true;
    }
    // 变量引用 $varName
    if (value.startsWith('$')) {
      return true;
    }
    // 特殊语法糖
    if (SYNTAX_SUGAR[value]) {
      return true;
    }
    return false;
  }
  
  /**
   * 解析字段值
   */
  private parseFieldValue(value: string): any {
    // 移除引号并处理转义序列
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return unescapeString(value.slice(1, -1));
    }
    
    // 变量字段 $varName
    if (value.startsWith('$')) {
      return { name: value.slice(1) };
    }
    
    // 数字
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return value;
    }
    
    // 布尔值
    if (value.toLowerCase() === 'true') return 'TRUE';
    if (value.toLowerCase() === 'false') return 'FALSE';
    
    // 其他作为字符串
    return value;
  }
  
  /**
   * 解析内联值表达式
   * 将表达式转换为 AbsNode
   */
  private parseInlineValue(value: string): AbsNode | null {
    value = value.trim();
    
    // 变量引用 $varName
    if (value.startsWith('$')) {
      const varName = value.slice(1);
      return {
        type: 'variables_get',
        fields: { VAR: { name: varName } },
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 检查语法糖
    if (SYNTAX_SUGAR[value]) {
      const result = SYNTAX_SUGAR[value]([]);
      return {
        type: result.type,
        fields: result.fields || {},
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 函数调用 func(args)
    const funcMatch = value.match(/^(\w+)\((.*)?\)$/);
    if (funcMatch) {
      const funcName = funcMatch[1];
      const argsString = funcMatch[2] || '';
      const args = argsString ? this.parseArguments(argsString) : [];
      
      // 检查是否是语法糖
      if (SYNTAX_SUGAR[funcName]) {
        const result = SYNTAX_SUGAR[funcName](args);
        return {
          type: result.type,
          fields: result.fields || {},
          inputs: result.inputs || {},
          children: [],
          indent: 0,
          lineNumber: this.currentLine + 1,
          raw: value
        };
      }
      
      // 普通块调用
      const fields: Record<string, any> = {};
      const inputs: Record<string, AbsNode> = {};
      this.assignArguments(funcName, args, fields, inputs);
      
      return {
        type: funcName,
        fields,
        inputs,
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 字符串字面量
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return {
        type: 'text',
        fields: { TEXT: unescapeString(value.slice(1, -1)) },
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 数字字面量
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return {
        type: 'math_number',
        fields: { NUM: value },
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 检查是否是已知的块类型
    if (isKnownBlock(value)) {
      return {
        type: value,
        fields: {},
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 检查是否看起来像块类型名（snake_case 标识符）
    if (/^[a-z][a-z0-9_]*$/i.test(value) && value.includes('_')) {
      // 可能是未知的块类型，尝试作为块处理
      this.warnings.push({
        line: this.currentLine + 1,
        message: `"${value}" 被识别为块类型（未在已加载的库中定义）`
      });
      return {
        type: value,
        fields: {},
        inputs: {},
        children: [],
        indent: 0,
        lineNumber: this.currentLine + 1,
        raw: value
      };
    }
    
    // 无法解析，返回文本块
    this.warnings.push({
      line: this.currentLine + 1,
      message: `无法识别的表达式 "${value}"，将作为文本处理`
    });
    
    return {
      type: 'text',
      fields: { TEXT: value },
      inputs: {},
      children: [],
      indent: 0,
      lineNumber: this.currentLine + 1,
      raw: value
    };
  }
  
  /**
   * 规范化输入名称 - 仅转换大小写
   */
  private normalizeInputName(name: string): string {
    return name.toUpperCase();
  }
  
  /**
   * 将 AbsNode 转换为 BlockConfig
   */
  private nodeToBlockConfig(node: AbsNode, position?: { x: number; y: number }): BlockConfig {
    const config: BlockConfig = {
      type: node.type,
      fields: {},
      inputs: {},
    };
    
    if (position) {
      config.position = position;
    }
    
    // 转换字段
    for (const [key, value] of Object.entries(node.fields)) {
      config.fields![key] = value;
    }
    
    // 转换输入
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) {
        // 语句输入（多个块）
        if (value.length > 0) {
          // 第一个块作为输入
          const firstBlock = this.nodeToBlockConfig(value[0]);
          
          // 后续块通过 next 连接
          let currentBlock = firstBlock;
          for (let i = 1; i < value.length; i++) {
            const nextBlock = this.nodeToBlockConfig(value[i]);
            currentBlock.next = { block: nextBlock };
            currentBlock = nextBlock;
          }
          
          config.inputs![key] = { block: firstBlock };
        }
      } else {
        // 值输入（单个块）
        const inputBlock = this.nodeToBlockConfig(value);
        // 统一使用 block 连接，让 Blockly 块定义自己处理 shadow
        // 注意：某些块定义中已内置默认 shadow，我们只需提供实际值块
        config.inputs![key] = { block: inputBlock };
      }
    }
    
    // 处理 next 连接（同级的下一个块）
    if (node.children.length > 0) {
      // 将 children 转换为 next 链
      let currentConfig = config;
      for (const child of node.children) {
        const childConfig = this.nodeToBlockConfig(child);
        currentConfig.next = { block: childConfig };
        currentConfig = childConfig;
      }
    }
    
    // 特殊处理使用 function_params_mutator 的块：将 EXTRA_N 字段转换为 extraState.params，
    // 并将 EXTRA_N 输入重映射到 RETURN
    const blockMutator = getBlockMeta(node.type)?.mutator;
    if (blockMutator === 'function_params_mutator') {
      // 1. 收集 EXTRA_N 字段（参数类型/名称对）
      const extraFields: Array<{ index: number; value: any }> = [];
      for (const [key, value] of Object.entries(config.fields || {})) {
        const extraMatch = key.match(/^EXTRA_(\d+)$/);
        if (extraMatch) {
          extraFields.push({ index: parseInt(extraMatch[1], 10), value });
        }
      }
      
      // 2. 收集 EXTRA_N 输入（如返回值块）
      const extraInputs: Array<{ index: number; value: any }> = [];
      for (const [key, value] of Object.entries(config.inputs || {})) {
        const extraMatch = key.match(/^EXTRA_(\d+)$/);
        if (extraMatch) {
          extraInputs.push({ index: parseInt(extraMatch[1], 10), value });
        }
      }
      
      const returnType = config.fields?.['RETURN_TYPE'] || 'void';
      
      // 3. 转换 EXTRA 字段为 params
      const params: Array<{ type: string; name: string }> = [];
      if (extraFields.length > 0) {
        extraFields.sort((a, b) => a.index - b.index);
        // EXTRA 字段成对出现：类型和名称
        for (let i = 0; i + 1 < extraFields.length; i += 2) {
          params.push({
            type: String(extraFields[i].value),
            name: String(extraFields[i + 1].value)
          });
        }
        // 如果是奇数个，最后一个单独作为类型，名称使用默认值
        if (extraFields.length % 2 !== 0) {
          params.push({
            type: String(extraFields[extraFields.length - 1].value),
            name: 'param' + (params.length)
          });
        }
        // 移除已转换的 EXTRA_N 字段
        for (const ef of extraFields) {
          delete config.fields![`EXTRA_${ef.index}`];
        }
      }
      
      // 4. 将 EXTRA_N 输入重映射到 RETURN（非 void 返回类型时）
      if (extraInputs.length > 0 && returnType !== 'void') {
        extraInputs.sort((a, b) => a.index - b.index);
        // 第一个 EXTRA 输入映射为 RETURN
        config.inputs!['RETURN'] = extraInputs[0].value;
        // 移除已转换的 EXTRA_N 输入
        for (const ei of extraInputs) {
          delete config.inputs![`EXTRA_${ei.index}`];
        }
      } else if (extraInputs.length > 0) {
        // void 返回类型但有多余输入，清理掉
        for (const ei of extraInputs) {
          delete config.inputs![`EXTRA_${ei.index}`];
        }
      }
      
      // 5. 设置 extraState
      if (params.length > 0 || returnType !== 'void') {
        config.extraState = {
          params,
          returnType
        } as BlockConfig['extraState'];
      }
    }

    // 自动推断动态块的 extraState
    // 例如: controls_if 的 elseIfCount/hasElse, text_join 的 itemCount
    if (!config.extraState) {
      const extraState = inferExtraStateFromInputs(node.type, config.inputs || {});
      if (extraState) {
        config.extraState = extraState as BlockConfig['extraState'];
      }
    }
    
    return config;
  }

  /**
   * 判断块类型是否应该作为 shadow 块
   * 基础值类型（text, math_number, logic_boolean, variables_get）使用 shadow
   */
  private isShadowBlockType(blockType: string): boolean {
    const shadowTypes = new Set([
      'text',
      'math_number',
      'logic_boolean',
      'variables_get'
    ]);
    return shadowTypes.has(blockType);
  }
}

// =============================================================================
// 动态块 extraState 自动推断
// =============================================================================

/**
 * 核心 Blockly 块的硬编码配置（作为后备）
 * 只包含 Blockly 核心块，其他块通过动态检测
 */
const CORE_DYNAMIC_BLOCKS: Record<string, {
  inputPattern: RegExp;
  extraStateKey: string;
  defaultCount?: number;
  baseCount?: number;
}> = {
  'text_join': { inputPattern: /^ADD(\d+)$/, extraStateKey: 'itemCount', defaultCount: 2 },
  'lists_create_with': { inputPattern: /^ADD(\d+)$/, extraStateKey: 'itemCount', defaultCount: 3 },
  'controls_if': { inputPattern: /^(IF|DO)(\d+)$/, extraStateKey: 'elseIfCount' },
  'controls_ifelse': { inputPattern: /^(IF|DO)(\d+)$/, extraStateKey: 'elseIfCount' },
  'controls_switch': { inputPattern: /^(CASE|DO)(\d+)$/, extraStateKey: 'caseCount', defaultCount: 1 },
};

/**
 * 动态检测输入模式
 * 根据输入名称自动推断动态块配置
 */
function detectDynamicInputPattern(inputKeys: string[]): {
  inputPattern: RegExp;
  extraStateKey: string;
  baseCount: number;
  prefix: string;
} | null {
  // 检测 ADD 模式 (text_join, lists_create_with)
  const addInputs = inputKeys.filter(key => /^ADD\d+$/.test(key));
  if (addInputs.length > 0) {
    return {
      inputPattern: /^ADD(\d+)$/,
      extraStateKey: 'itemCount',
      baseCount: 0,  // itemCount = 总数量
      prefix: 'ADD'
    };
  }
  
  // 检测 INPUT 模式 (dynamic-inputs 插件)
  const inputInputs = inputKeys.filter(key => /^INPUT\d+$/.test(key));
  if (inputInputs.length > 0) {
    return {
      inputPattern: /^INPUT(\d+)$/,
      extraStateKey: 'extraCount',
      baseCount: 1,  // extraCount = 总数量 - 1 (默认有 INPUT0)
      prefix: 'INPUT'
    };
  }
  
  // 检测 ARG 模式 (procedures)
  const argInputs = inputKeys.filter(key => /^ARG\d+$/.test(key));
  if (argInputs.length > 0) {
    return {
      inputPattern: /^ARG(\d+)$/,
      extraStateKey: 'params',
      baseCount: 0,
      prefix: 'ARG'
    };
  }
  
  return null;
}

/**
 * 获取块的动态配置
 * 优先使用核心块配置，否则尝试动态检测
 */
function getDynamicBlockConfig(blockType: string, inputKeys: string[]): {
  inputPattern: RegExp;
  extraStateKey: string;
  baseCount: number;
  prefix: string;
} | null {
  // 优先使用核心块配置
  const coreConfig = CORE_DYNAMIC_BLOCKS[blockType];
  if (coreConfig) {
    // 从 inputPattern 提取前缀
    const patternStr = coreConfig.inputPattern.source;
    const prefixMatch = patternStr.match(/^\^?\(?([A-Z]+)/);
    return {
      inputPattern: coreConfig.inputPattern,
      extraStateKey: coreConfig.extraStateKey,
      baseCount: coreConfig.baseCount || 0,
      prefix: prefixMatch ? prefixMatch[1] : 'INPUT'
    };
  }
  
  // 动态检测
  return detectDynamicInputPattern(inputKeys);
}

/**
 * 从 inputs 配置智能推断 extraState
 * 例如: 如果提供了 IF1, DO1，则推断 elseIfCount = 1
 */
function inferExtraStateFromInputs(
  blockType: string,
  inputs: Record<string, any>
): Record<string, any> | null {
  if (!inputs) return null;
  
  const inputKeys = Object.keys(inputs);
  if (inputKeys.length === 0) return null;
  
  // 特殊处理 controls_if/controls_ifelse
  if (blockType === 'controls_if' || blockType === 'controls_ifelse') {
    // 计算 IF 输入的最大编号（不包括 IF0）
    const ifNumbers = inputKeys
      .filter(key => /^IF\d+$/.test(key) && key !== 'IF0')
      .map(key => parseInt(key.replace('IF', ''), 10))
      .filter(n => !isNaN(n));
    
    const hasElse = inputKeys.includes('ELSE');
    
    const result: Record<string, any> = {};
    if (ifNumbers.length > 0) {
      result['elseIfCount'] = Math.max(...ifNumbers);
    }
    if (hasElse) {
      result['hasElse'] = true;
    }
    
    return Object.keys(result).length > 0 ? result : null;
  }
  
  // 特殊处理 controls_switch
  if (blockType === 'controls_switch') {
    // 计算 CASE 输入的最大编号
    const caseNumbers = inputKeys
      .filter(key => /^CASE\d+$/.test(key))
      .map(key => parseInt(key.replace('CASE', ''), 10))
      .filter(n => !isNaN(n));
    
    // 也检查 DO 输入（因为可能只有 DO 没有 CASE）
    const doNumbers = inputKeys
      .filter(key => /^DO\d+$/.test(key))
      .map(key => parseInt(key.replace('DO', ''), 10))
      .filter(n => !isNaN(n));
    
    // 合并并取最大值
    const allNumbers = [...caseNumbers, ...doNumbers];
    const hasDefault = inputKeys.includes('DEFAULT');
    
    const result: Record<string, any> = {};
    
    if (allNumbers.length > 0) {
      const maxNumber = Math.max(...allNumbers);
      // caseCount 是额外添加的 case 数量（不包括默认的 CASE0/DO0）
      // 如果 maxNumber = 1，表示有 CASE0 和 CASE1，额外添加了 1 个
      if (maxNumber > 0) {
        result['caseCount'] = maxNumber;
      }
    }
    
    // hasDefault 控制是否显示 DEFAULT 输入
    // 必须显式设置，因为 Blockly 默认 hasDefault_ = true
    result['hasDefault'] = hasDefault;
    
    return result;
  }
  
  // 通用处理：使用动态检测
  const config = getDynamicBlockConfig(blockType, inputKeys);
  if (!config) return null;
  
  const pattern = config.inputPattern;
  const matchingInputs = inputKeys.filter(key => pattern.test(key));
  if (matchingInputs.length === 0) return null;
  
  // 提取最大编号
  const maxNumber = Math.max(...matchingInputs.map(key => {
    const match = key.match(pattern);
    return match ? parseInt(match[1] || match[2], 10) : -1;
  }));
  
  if (maxNumber < 0) return null;
  
  // 计算 extraStateKey 的值
  // - 对于 text_join, lists_create_with: itemCount = maxNumber + 1（因为从0开始）
  // - 对于 dynamic-inputs 块: extraCount = 输入数量 - baseCount（额外输入数量）
  const totalInputs = maxNumber + 1;  // 从0开始计数
  const extraCount = totalInputs - config.baseCount;
  
  return { [config.extraStateKey]: extraCount > 0 ? extraCount : totalInputs };
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 快速解析 ABS 代码
 * @param code ABS 源代码
 * @returns 解析结果
 */
export function parseAbs(code: string): AbsParseResult {
  const parser = new BlocklyAbsParser();
  return parser.parse(code);
}

/**
 * 生成 ABS 语法帮助文档
 */
export function getAbsSyntaxHelp(): string {
  return `
# Blockly ABS 语法指南 (Aily Block Syntax)

## 基本语法

### 变量定义
\`\`\`
@var count: int = 0
@var message: String = "hello"
\`\`\`

### 块调用
\`\`\`
block_type(arg1, arg2, ...)
\`\`\`

### 缩进表示层级
- 缩进的行表示在父块的语句输入内
- 同级换行表示 next 连接

## 特殊语法

### 变量引用
\`\`\`
$varName          # 引用变量
\`\`\`

### 字面量与语法糖
\`\`\`
"text"            # 文本 -> 自动创建 text 块
number(123)       # 数字 -> 创建 math_number 块
true / false      # 布尔值 -> 创建 logic_boolean 块
HIGH / LOW        # 高低电平 -> math_number(1/0)
\`\`\`

### 命名输入
\`\`\`
controls_if
    @condition: logic_compare(EQ, $a, $b)
    @do:
        serial_println(Serial, "Equal!")
    @else:
        serial_println(Serial, "Not equal")
\`\`\`

### 条件分支（if/elseif/else）
\`\`\`
# 简单 if
controls_if
    @IF0: logic_compare(GT, $count, number(10))
    @DO0:
        serial_println(Serial, "Greater than 10")

# if-else
controls_if
    @IF0: logic_compare(GT, $count, number(10))
    @DO0:
        serial_println(Serial, "Greater than 10")
    @ELSE:
        serial_println(Serial, "Not greater")

# if-elseif-else（extraState 自动推断）
controls_if
    @IF0: logic_compare(GT, $count, number(10))
    @DO0:
        serial_println(Serial, "Greater than 10")
    @IF1: logic_compare(GT, $count, number(5))
    @DO1:
        serial_println(Serial, "Greater than 5")
    @ELSE:
        serial_println(Serial, "5 or less")
\`\`\`

## 示例

### Arduino 基础程序
\`\`\`
@var count: int = 0

arduino_setup
    serial_begin(Serial, 115200)
    pin_mode(13, OUTPUT)

arduino_loop
    digital_write(13, HIGH)
    time_delay(number(500))
    digital_write(13, LOW)
    time_delay(number(500))
    math_change($count, number(1))
    serial_println(Serial, $count)
\`\`\`

### 条件判断
\`\`\`
controls_if
    @condition: logic_compare(GT, $count, number(10))
    @do:
        serial_println(Serial, "Count > 10")
        variables_set($count, number(0))
\`\`\`

### 循环
\`\`\`
controls_repeat_ext
    @times: number(5)
    @do:
        serial_println(Serial, "Hello")
        time_delay(number(1000))
\`\`\`
`;
}
