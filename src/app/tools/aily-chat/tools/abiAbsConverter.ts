/**
 * ABI JSON ↔ ABS 双向转换器
 * 
 * 提供 Blockly ABI JSON 格式与 ABS 格式之间的转换
 */

import { parseAbs, BlocklyAbsParser } from './absParser';
import { getGlobalBlockMetas } from '../services/block-definition.service';

declare const Blockly: any;

// =============================================================================
// ABI JSON → ABS 转换
// =============================================================================

/**
 * ABI JSON 转 ABS 的配置
 */
export interface AbiToAbsOptions {
  /** 是否包含注释头 */
  includeHeader?: boolean;
  /** 缩进字符串（默认 4 空格） */
  indentStr?: string;
  /** 是否包含块 ID（调试用） */
  includeBlockIds?: boolean;
  /** 是否使用明确的块类型（不使用语法糖） */
  explicitBlockTypes?: boolean;
}

/**
 * 将完整的 ABI JSON 转换为 ABS 格式
 */
export function convertAbiToAbs(abiJson: any, options: AbiToAbsOptions = {}): string {
  const {
    includeHeader = true,
    indentStr = '    ',
    includeBlockIds = false,
    explicitBlockTypes = true
  } = options;
  
  const lines: string[] = [];
  const context = new ConversionContext(indentStr, includeBlockIds, explicitBlockTypes);
  
  // 文件头
  if (includeHeader) {
    lines.push('# ============================================');
    lines.push('# Blockly ABS File');
    lines.push(`# Generated: ${new Date().toISOString()}`);
    if (explicitBlockTypes) {
      lines.push('# Mode: Explicit block types (no syntax sugar)');
    }    lines.push('# ============================================');
    lines.push('');
  }
  
  // 提取并注册变量（用于将变量ID转换为变量名）
  // 注意：不再输出 @var 声明，因为：
  // 1. @var 是 Blockly 工作区内部变量，不生成 C++ 代码
  // 2. variable_define 等块才会生成实际的 C++ 变量声明
  // 3. 避免 LLM 混淆两种不同的变量概念
  if (abiJson.variables && Array.isArray(abiJson.variables)) {
    if (abiJson.variables.length > 0) {
      // 仅注册变量用于ID→名称转换，不输出到ABS
      for (const variable of abiJson.variables) {
        context.registerVariable(variable.id, variable.name, variable.type || 'int');
      }
      // 输出为注释，供参考但不影响导入
      lines.push('# Global definitions can be created as standalone blocks or within arduino_global blocks, eg:');
      lines.push('# arduino_global()');
      lines.push('#    variable_define("variable", int, math_number(0))');
      lines.push('');
      lines.push('# Blockly workspace variables (auto-managed, do not edit):');
      for (const variable of abiJson.variables) {
        lines.push(`# - ${variable.name}: ${variable.type || 'int'}`);
      }
      lines.push('');
    }
  }
  
  // 设置 lineOffset 为当前 header 行数（后续块转换时使用）
  context.lineOffset = lines.length;
  
  // 转换块（按 y 坐标排序，确保输出顺序与视觉布局一致）
  if (abiJson.blocks?.blocks && Array.isArray(abiJson.blocks.blocks)) {
    const sortedBlocks = [...abiJson.blocks.blocks].sort((a: any, b: any) => {
      const ay = a.y ?? 0, by = b.y ?? 0;
      if (ay !== by) return ay - by;
      return (a.x ?? 0) - (b.x ?? 0);
    });
    for (let i = 0; i < sortedBlocks.length; i++) {
      const block = sortedBlocks[i];
      const blockAbs = convertBlockToAbs(block, 0, context);
      lines.push(...blockAbs);
      
      // 块之间空行
      if (i < sortedBlocks.length - 1) {
        lines.push('');
        context.lineOffset++;
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * 生成 ABS 并返回每个 blockId 对应的行号范围
 * 行号为 1-based，与用户在编辑器中看到的行号一致
 */
export function convertAbiToAbsWithLineMap(
  abiJson: any,
  options: AbiToAbsOptions = {}
): { abs: string; blockLineMap: Map<string, { startLine: number; endLine: number }> } {
  const {
    includeHeader = true,
    indentStr = '    ',
    includeBlockIds = false,
    explicitBlockTypes = true
  } = options;
  
  const lines: string[] = [];
  const context = new ConversionContext(indentStr, includeBlockIds, explicitBlockTypes);
  
  // 文件头
  if (includeHeader) {
    lines.push('# ============================================');
    lines.push('# Blockly ABS File');
    lines.push(`# Generated: ${new Date().toISOString()}`);
    if (explicitBlockTypes) {
      lines.push('# Mode: Explicit block types (no syntax sugar)');
    }    lines.push('# ============================================');
    lines.push('');
  }
  
  if (abiJson.variables && Array.isArray(abiJson.variables)) {
    if (abiJson.variables.length > 0) {
      for (const variable of abiJson.variables) {
        context.registerVariable(variable.id, variable.name, variable.type || 'int');
      }
      lines.push('# Global definitions can be created as standalone blocks or within arduino_global blocks, eg:');
      lines.push('# arduino_global()');
      lines.push('#    variable_define("variable", int, math_number(0))');
      lines.push('');
      lines.push('# Blockly workspace variables (auto-managed, do not edit):');
      for (const variable of abiJson.variables) {
        lines.push(`# - ${variable.name}: ${variable.type || 'int'}`);
      }
      lines.push('');
    }
  }
  
  context.lineOffset = lines.length;
  
  // 按 y 坐标排序，确保与 convertAbiToAbs 输出顺序一致
  if (abiJson.blocks?.blocks && Array.isArray(abiJson.blocks.blocks)) {
    const sortedBlocks = [...abiJson.blocks.blocks].sort((a: any, b: any) => {
      const ay = a.y ?? 0, by = b.y ?? 0;
      if (ay !== by) return ay - by;
      return (a.x ?? 0) - (b.x ?? 0);
    });
    for (let i = 0; i < sortedBlocks.length; i++) {
      const block = sortedBlocks[i];
      const blockAbs = convertBlockToAbs(block, 0, context);
      lines.push(...blockAbs);
      if (i < sortedBlocks.length - 1) {
        lines.push('');
        context.lineOffset++;
      }
    }
  }
  
  return {
    abs: lines.join('\n'),
    blockLineMap: context.blockLineMap
  };
}

/**
 * 转换上下文
 */
class ConversionContext {
  private variables = new Map<string, { name: string; type: string }>();
  /** 追踪每个 blockId 在输出中的行号范围（1-based） */
  blockLineMap = new Map<string, { startLine: number; endLine: number }>();
  /** 当前已累计的总行数偏移（用于计算绝对行号） */
  lineOffset = 0;
  
  constructor(
    public indentStr: string,
    public includeBlockIds: boolean,
    public explicitBlockTypes: boolean = false
  ) {}
  
  registerVariable(id: string, name: string, type: string): void {
    this.variables.set(id, { name, type });
  }
  
  getVariableName(idOrName: string): string {
    const varInfo = this.variables.get(idOrName);
    return varInfo ? varInfo.name : idOrName;
  }
  
  indent(level: number): string {
    return this.indentStr.repeat(level);
  }

  /** 记录一个块产生的行范围 */
  recordBlockLines(blockId: string | undefined, startLine: number, lineCount: number): void {
    if (!blockId) return;
    const endLine = startLine + lineCount - 1;
    // 如果同一个 blockId 已有记录，扩展范围（不会发生，但保险起见）
    const existing = this.blockLineMap.get(blockId);
    if (existing) {
      existing.startLine = Math.min(existing.startLine, startLine);
      existing.endLine = Math.max(existing.endLine, endLine);
    } else {
      this.blockLineMap.set(blockId, { startLine, endLine });
    }
  }

  /**
   * 递归记录值块树中所有块的行号
   * 值块（如 logic_compare、math_number 等）被内联在父块参数中，共享同一行号
   */
  recordValueBlockTree(block: any, lineNumber: number): void {
    if (!block || !block.id) return;
    this.recordBlockLines(block.id, lineNumber, 1);
    // 递归处理所有输入中的子块
    if (block.inputs) {
      for (const inputValue of Object.values(block.inputs)) {
        const input = inputValue as any;
        const childBlock = input?.block || input?.shadow;
        if (childBlock) {
          this.recordValueBlockTree(childBlock, lineNumber);
        }
      }
    }
  }
}

/**
 * 转换单个块为 ABS
 */
function convertBlockToAbs(block: any, indentLevel: number, context: ConversionContext): string[] {
  const startLine = context.lineOffset + 1; // 1-based
  const lines: string[] = [];
  const indent = context.indent(indentLevel);
  
  // 特殊处理 controls_if：始终使用命名输入格式
  if (block.type === 'controls_if') {
    const result = convertControlsIfToAbs(block, indentLevel, context);
    // controls_if 内部已处理 lineOffset，此处记录整个块范围
    context.recordBlockLines(block.id, startLine, result.length);
    return result;
  }
  
  // 特殊处理 controls_switch：使用命名输入格式
  if (block.type === 'controls_switch') {
    const result = convertControlsSwitchToAbs(block, indentLevel, context);
    context.recordBlockLines(block.id, startLine, result.length);
    return result;
  }
  
  // 构建主块行
  const blockCall = buildBlockCall(block, context);
  const idComment = context.includeBlockIds ? `  # id: ${block.id}` : '';
  lines.push(`${indent}${blockCall}${idComment}`);
  const mainLineNum = context.lineOffset + 1;  // 当前行的 1-based 行号
  context.lineOffset++;
  
  // 记录值输入块（内联在主块行参数中的值块）的行号
  if (block.inputs) {
    const statementInputNames = new Set(getStatementInputs(block));
    for (const [inputName, inputValue] of Object.entries(block.inputs)) {
      if (statementInputNames.has(inputName)) continue;
      const input = inputValue as any;
      const childBlock = input?.block || input?.shadow;
      if (childBlock) {
        context.recordValueBlockTree(childBlock, mainLineNum);
      }
    }
  }
  
  // 处理语句输入（缩进的子块）
  if (block.inputs) {
    const statementInputs = getStatementInputs(block);
    
    for (const inputName of statementInputs) {
      const input = block.inputs[inputName];
      if (input?.block) {
        // 如果有多个语句输入，添加命名标记
        if (statementInputs.length > 1) {
          const normalizedName = normalizeInputNameForAbs(inputName);
          lines.push(`${indent}${context.indentStr}@${normalizedName}:`);
          context.lineOffset++;
          const childLines = convertBlockChainToAbs(input.block, indentLevel + 2, context);
          lines.push(...childLines);
        } else {
          const childLines = convertBlockChainToAbs(input.block, indentLevel + 1, context);
          lines.push(...childLines);
        }
      }
    }
  }
  
  // 记录当前块的行范围
  context.recordBlockLines(block.id, startLine, lines.length);
  
  return lines;
}

/**
 * 特殊处理 controls_if 块
 * 始终使用 @IF0:/@DO0:/@ELSE: 格式，确保导入时能正确还原
 */
function convertControlsIfToAbs(block: any, indentLevel: number, context: ConversionContext): string[] {
  const lines: string[] = [];
  const indent = context.indent(indentLevel);
  const childIndent = context.indent(indentLevel + 1);
  const contentIndent = context.indent(indentLevel + 2);
  
  // 主块行
  const idComment = context.includeBlockIds ? `  # id: ${block.id}` : '';
  lines.push(`${indent}controls_if()${idComment}`);
  context.lineOffset++;
  
  if (block.inputs) {
    // 收集所有 IF/DO 对的索引（同时检查 IF 和 DO，因为可能一个有内容另一个没有）
    const indicesSet = new Set<number>();
    for (const inputName of Object.keys(block.inputs)) {
      const ifMatch = inputName.match(/^IF(\d+)$/);
      if (ifMatch) {
        indicesSet.add(parseInt(ifMatch[1]));
      }
      const doMatch = inputName.match(/^DO(\d+)$/);
      if (doMatch) {
        indicesSet.add(parseInt(doMatch[1]));
      }
    }
    const ifIndices = Array.from(indicesSet).sort((a, b) => a - b);
    
    // 输出每个 IF/DO 对
    for (const idx of ifIndices) {
      const ifInput = block.inputs[`IF${idx}`];
      const doInput = block.inputs[`DO${idx}`];
      
      // @IFn: 条件
      if (ifInput?.block) {
        const conditionAbs = formatBlockAsValue(ifInput.block, context);
        lines.push(`${childIndent}@IF${idx}: ${conditionAbs}`);
        // 记录条件值块（如 logic_compare）及其子块的行号（当前行 = lineOffset + 1）
        const currentLineNum = context.lineOffset + 1;
        context.lineOffset++;
        context.recordValueBlockTree(ifInput.block, currentLineNum);
      }
      
      // @DOn: 执行体
      if (doInput?.block) {
        lines.push(`${childIndent}@DO${idx}:`);
        context.lineOffset++;
        const doLines = convertBlockChainToAbs(doInput.block, indentLevel + 2, context);
        lines.push(...doLines);
      }
    }
    
    // @ELSE: else 分支
    const elseInput = block.inputs['ELSE'];
    if (elseInput?.block) {
      lines.push(`${childIndent}@ELSE:`);
      context.lineOffset++;
      const elseLines = convertBlockChainToAbs(elseInput.block, indentLevel + 2, context);
      lines.push(...elseLines);
    }
  }
  
  return lines;
}

/**
 * 特殊处理 controls_switch 块
 * 使用 @SWITCH:/@CASE0:/@DO0:/@DEFAULT: 格式
 * 
 * 结构：
 * controls_switch()
 *     @SWITCH: <值>
 *     @CASE0: <值>
 *     @DO0:
 *         <语句>
 *     @CASE1: <值>
 *     @DO1:
 *         <语句>
 *     @DEFAULT:
 *         <语句>
 */
function convertControlsSwitchToAbs(block: any, indentLevel: number, context: ConversionContext): string[] {
  const lines: string[] = [];
  const indent = context.indent(indentLevel);
  const childIndent = context.indent(indentLevel + 1);
  
  // 主块行
  const idComment = context.includeBlockIds ? `  # id: ${block.id}` : '';
  lines.push(`${indent}controls_switch()${idComment}`);
  context.lineOffset++;
  
  if (block.inputs) {
    // @SWITCH: 选择值
    const switchInput = block.inputs['SWITCH'];
    if (switchInput?.block) {
      const switchAbs = formatBlockAsValue(switchInput.block, context);
      lines.push(`${childIndent}@SWITCH: ${switchAbs}`);
      const currentLineNum = context.lineOffset + 1;
      context.lineOffset++;
      context.recordValueBlockTree(switchInput.block, currentLineNum);
    }
    
    // 收集所有 CASE/DO 对的索引（同时检查 CASE 和 DO，因为可能一个有内容另一个没有）
    const indicesSet = new Set<number>();
    for (const inputName of Object.keys(block.inputs)) {
      const caseMatch = inputName.match(/^CASE(\d+)$/);
      if (caseMatch) {
        indicesSet.add(parseInt(caseMatch[1]));
      }
      const doMatch = inputName.match(/^DO(\d+)$/);
      if (doMatch) {
        indicesSet.add(parseInt(doMatch[1]));
      }
    }
    const caseIndices = Array.from(indicesSet).sort((a, b) => a - b);
    
    // 输出每个 CASE/DO 对
    for (const idx of caseIndices) {
      const caseInput = block.inputs[`CASE${idx}`];
      const doInput = block.inputs[`DO${idx}`];
      
      // @CASEn: 条件值
      if (caseInput?.block) {
        const caseAbs = formatBlockAsValue(caseInput.block, context);
        lines.push(`${childIndent}@CASE${idx}: ${caseAbs}`);
        const currentLineNum = context.lineOffset + 1;
        context.lineOffset++;
        context.recordValueBlockTree(caseInput.block, currentLineNum);
      }
      
      // @DOn: 执行体
      if (doInput?.block) {
        lines.push(`${childIndent}@DO${idx}:`);
        context.lineOffset++;
        const doLines = convertBlockChainToAbs(doInput.block, indentLevel + 2, context);
        lines.push(...doLines);
      }
    }
    
    // @DEFAULT: 默认分支
    const defaultInput = block.inputs['DEFAULT'];
    if (defaultInput?.block) {
      lines.push(`${childIndent}@DEFAULT:`);
      context.lineOffset++;
      const defaultLines = convertBlockChainToAbs(defaultInput.block, indentLevel + 2, context);
      lines.push(...defaultLines);
    }
  }
  
  return lines;
}

/**
 * 转换块链（处理 next 连接）
 */
function convertBlockChainToAbs(block: any, indentLevel: number, context: ConversionContext): string[] {
  const lines: string[] = [];
  let currentBlock: any = block;
  
  while (currentBlock) {
    // 转换当前块（不包括 next）
    const blockLines = convertBlockToAbs(currentBlock, indentLevel, context);
    lines.push(...blockLines);
    
    // 移动到下一个块
    currentBlock = currentBlock.next?.block;
  }
  
  return lines;
}

/**
 * 构建块调用字符串
 * 
 * 使用简单的位置参数格式，保持 ABS 语法简洁易学。
 * 导入时，系统会在创建块并触发动态扩展后，自动获取块上实际的输入并按顺序连接。
 */
function buildBlockCall(block: any, context: ConversionContext): string {
  const args: string[] = [];
  
  // 收集字段参数（按定义顺序）
  if (block.fields) {
    for (const [fieldName, fieldValue] of Object.entries(block.fields)) {
      const formattedValue = formatFieldValue(block.type, fieldName, fieldValue, context);
      if (formattedValue !== null) {
        args.push(formattedValue);
      }
    }
  }
  
  // 收集值输入参数（非语句输入）- 使用位置参数格式
  if (block.inputs) {
    const statementInputs = new Set(getStatementInputs(block));
    
    for (const [inputName, inputValue] of Object.entries(block.inputs)) {
      if (statementInputs.has(inputName)) continue;
      
      const input = inputValue as any;
      const formattedValue = formatInputValue(input, context);
      if (formattedValue !== null) {
        args.push(formattedValue);
      }
    }
  }
  
  // 构建调用 - 始终使用括号格式，确保导入时能正确识别为块
  if (args.length > 0) {
    return `${block.type}(${args.join(', ')})`;
  }
  // 无参数块也使用空括号，如 esp32_wifi_status()
  return `${block.type}()`;
}

/**
 * 格式化字段值
 * @param blockType 块类型（用于查询块定义）
 * @param fieldName 字段名
 * @param value 字段值
 * @param context 转换上下文
 */
function formatFieldValue(blockType: string, fieldName: string, value: any, context: ConversionContext): string | null {
  if (value === null || value === undefined) return null;
  
  // 变量字段
  if (typeof value === 'object') {
    if (value.name) {
      return `$${value.name}`;
    }
    if (value.id) {
      const varName = context.getVariableName(value.id);
      return `$${varName}`;
    }
    return null;
  }
  
  // 字符串
  if (typeof value === 'string') {
    // 特殊标识符不需要引号
    if (isIdentifier(value) || isEnumValue(blockType, fieldName, value)) {
      return value;
    }
    // 数字字符串
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return value;
    }
    // 其他字符串加引号
    return `"${escapeString(value)}"`;
  }
  
  // 数字
  if (typeof value === 'number') {
    return String(value);
  }
  
  // 布尔
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  
  return null;
}

/**
 * 格式化输入值
 */
function formatInputValue(input: any, context: ConversionContext): string | null {
  // 优先使用 block，其次 shadow
  const sourceBlock = input.block || input.shadow;
  if (!sourceBlock) return null;
  
  return formatBlockAsValue(sourceBlock, context);
}

/**
 * 将块格式化为值表达式
 */
function formatBlockAsValue(block: any, context: ConversionContext): string {
  // 如果使用显式块类型模式，不使用语法糖
  if (context.explicitBlockTypes) {
    return buildBlockCall(block, context);
  }
  
  switch (block.type) {
    case 'math_number':
      // 使用 number() 语法糖，确保导入时能正确创建 math_number 块
      const num = block.fields?.NUM?.toString() || '0';
      return `number(${num})`;
    
    case 'text':
      const text = block.fields?.TEXT || '';
      // 使用 text() 显式语法，避免引号解析问题
      return `text("${escapeString(text)}")`;
    
    case 'logic_boolean':
      return block.fields?.BOOL === 'TRUE' ? 'true' : 'false';
    
    case 'variables_get':
      const varField = block.fields?.VAR;
      if (typeof varField === 'object') {
        // 优先使用 name，其次通过 id 查找
        if (varField.name) {
          return `$${varField.name}`;
        }
        if (varField.id) {
          const varName = context.getVariableName(varField.id);
          return `$${varName}`;
        }
      }
      if (typeof varField === 'string') {
        return `$${context.getVariableName(varField)}`;
      }
      return '$unknown';
    
    default:
      // 复杂块，生成内联调用
      return buildBlockCall(block, context);
  }
}

// 运行时查询缓存：blockType -> Set<语句输入名>
const runtimeStatementInputCache = new Map<string, Set<string>>();

/**
 * 通过 Blockly 运行时查询块的语句输入名称
 * 这是最可靠的方式，因为它直接从块定义中获取，包括 mutator 动态添加的输入
 */
function queryStatementInputsFromBlockly(blockType: string): Set<string> | null {
  // 检查缓存
  if (runtimeStatementInputCache.has(blockType)) {
    return runtimeStatementInputCache.get(blockType)!;
  }
  
  // 检查 Blockly 是否可用
  if (typeof Blockly === 'undefined' || !Blockly.Blocks || !Blockly.Blocks[blockType]) {
    return null;
  }
  
  try {
    // 获取工作区用于创建临时块
    const workspace = Blockly.getMainWorkspace?.();
    if (!workspace) return null;
    
    // 创建临时块来查询输入类型
    const tempBlock = workspace.newBlock(blockType);
    const statementInputs = new Set<string>();
    
    if (tempBlock.inputList) {
      for (const input of tempBlock.inputList) {
        // connection.type === 3 表示 NEXT_STATEMENT（语句输入）
        if (input.connection && input.connection.type === 3) {
          statementInputs.add(input.name);
        }
      }
    }
    
    // 清理临时块
    tempBlock.dispose();
    
    // 缓存结果
    runtimeStatementInputCache.set(blockType, statementInputs);
    return statementInputs;
  } catch (e) {
    console.warn(`[abiAbsConverter] Failed to query block ${blockType} from Blockly:`, e);
    return null;
  }
}

/**
 * 获取块的语句输入名称
 * 
 * 采用三层检测策略（按优先级）：
 * 1. 【最可靠】从 Blockly 运行时查询（直接获取块定义，包括 mutator 动态输入）
 * 2. 从静态块元数据获取（来自 block.json 的 input_statement）
 * 3. 【回退】启发式规则（用于 Blockly 不可用时）
 */
function getStatementInputs(block: any): string[] {
  if (!block.inputs) return [];
  
  const inputNames = Object.keys(block.inputs);
  const result = new Set<string>();
  
  // 1. 优先从 Blockly 运行时查询（最可靠）
  const runtimeInputs = queryStatementInputsFromBlockly(block.type);
  if (runtimeInputs) {
    for (const inputName of inputNames) {
      if (runtimeInputs.has(inputName)) {
        result.add(inputName);
      }
    }
    // 运行时查询成功，直接返回
    return Array.from(result);
  }
  
  // 2. 从静态块元数据获取
  const dynamicMetas = getGlobalBlockMetas();
  if (dynamicMetas) {
    const meta = dynamicMetas.get(block.type);
    if (meta && meta.statementInputNames.length > 0) {
      for (const name of meta.statementInputNames) {
        if (block.inputs[name]) {
          result.add(name);
        }
      }
    }
  }
  
  // 3. 启发式规则（回退方案）
  // 仅当前面的方法都无法判断时使用
  for (const inputName of inputNames) {
    if (!result.has(inputName) && isLikelyStatementInput(inputName)) {
      result.add(inputName);
    }
  }
  
  return Array.from(result);
}

/**
 * 【回退方案】判断输入名是否可能是语句输入
 * 
 * 此函数仅在 Blockly 运行时不可用且静态元数据缺失时使用。
 * 优先应使用 queryStatementInputsFromBlockly() 从 Blockly 运行时查询。
 * 
 * @deprecated 优先使用 Blockly 运行时查询
 */
export function isLikelyStatementInput(inputName: string): boolean {
  const patterns = [
    /^DO\d*$/,           // DO, DO0, DO1...
    /^ELSE$/,            // ELSE
    /^DEFAULT$/,         // DEFAULT (switch-case)
    /^HANDLER$/,         // HANDLER
    /^STACK$/,           // STACK
    /^SUBSTACK\d*$/,     // SUBSTACK, SUBSTACK1...
    /STATEMENT/i,        // 包含 STATEMENT
    /^ARDUINO_/,         // ARDUINO_SETUP, ARDUINO_LOOP
  ];
  
  return patterns.some(p => p.test(inputName));
}

/**
 * 规范化输入名用于 ABS 显示
 */
export function normalizeInputNameForAbs(inputName: string): string {
  const mapping: Record<string, string> = {
    'DO0': 'do',
    'DO': 'do',
    'ELSE': 'else',
    'DEFAULT': 'default',
    'IF0': 'condition',
    'HANDLER': 'handler',
    'ARDUINO_SETUP': 'setup',
    'ARDUINO_LOOP': 'loop',
  };
  
  // 直接映射
  if (mapping[inputName]) {
    return mapping[inputName];
  }
  
  // 处理带编号的 DO (DO1, DO2...) -> do1, do2...
  const doMatch = inputName.match(/^DO(\d+)$/);
  if (doMatch) {
    const index = parseInt(doMatch[1]);
    return index === 0 ? 'do' : `do${index}`;
  }
  
  // 处理带编号的 CASE (CASE0, CASE1...) -> case0, case1...
  const caseMatch = inputName.match(/^CASE(\d+)$/);
  if (caseMatch) {
    return `case${caseMatch[1]}`;
  }
  
  return inputName.toLowerCase();
}

/**
 * 判断是否是标识符
 */
function isIdentifier(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

/**
 * 判断是否是枚举/下拉菜单值
 * 动态从块定义中判断字段类型
 */
function isEnumValue(blockType: string, fieldName: string, value: string): boolean {
  // 优先从动态加载的块定义获取
  const dynamicMetas = getGlobalBlockMetas();
  if (dynamicMetas) {
    const meta = dynamicMetas.get(blockType);
    if (meta && meta.fieldTypes) {
      const fieldType = meta.fieldTypes.get(fieldName);
      // field_dropdown 和 field_variable 的值不需要引号
      if (fieldType === 'field_dropdown' || fieldType === 'field_variable') {
        return true;
      }
      // 其他字段类型（如 field_input）可能需要引号
      if (fieldType) {
        return false;
      }
    }
  }
  
  // 回退：硬编码的常见枚举字段名
  const enumFields = new Set([
    'SERIAL', 'OP', 'MODE', 'STATE', 'PIN', 'SPEED', 'TYPE', 
    'PROPERTY', 'BOOL', 'BASE', 'CONSTANT', 'DIRECTION'
  ]);
  return enumFields.has(fieldName);
}

/**
 * 转义字符串
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// =============================================================================
// ABS → ABI JSON 转换（复用 absParser）
// =============================================================================

export interface AbsToAbiResult {
  success: boolean;
  abiJson?: any;
  errors?: Array<{ line: number; message: string }>;
  warnings?: Array<{ line: number; message: string }>;
}

/**
 * 将 ABS 转换为 ABI JSON
 */
export function convertAbsToAbi(abs: string): AbsToAbiResult {
  const parser = new BlocklyAbsParser();
  const parseResult = parser.parse(abs);
  
  if (!parseResult.success) {
    return {
      success: false,
      errors: parseResult.errors,
      warnings: parseResult.warnings
    };
  }
  
  // 构建 ABI JSON
  const abiJson: any = {
    blocks: {
      languageVersion: 0,
      blocks: []
    },
    variables: []
  };
  
  // 构建变量名到ID的映射
  const variableNameToId = new Map<string, string>();
  
  // 添加变量
  for (const varDef of parseResult.variables) {
    const varId = generateUniqueId();
    variableNameToId.set(varDef.name, varId);
    abiJson.variables.push({
      name: varDef.name,
      type: varDef.type,
      id: varId
    });
  }
  
  // 转换根块
  let yPosition = 30;
  for (const blockConfig of parseResult.rootBlocks) {
    const abiBlock = convertBlockConfigToAbi(blockConfig, 30, yPosition, variableNameToId);
    abiJson.blocks.blocks.push(abiBlock);
    yPosition += calculateBlockHeight(blockConfig) + 50;
  }
  
  return {
    success: true,
    abiJson,
    warnings: parseResult.warnings
  };
}

/**
 * 将 BlockConfig 转换为 ABI 块
 * @param config 块配置
 * @param x X坐标
 * @param y Y坐标  
 * @param variableNameToId 变量名到ID的映射
 */
function convertBlockConfigToAbi(
  config: any, 
  x: number, 
  y: number,
  variableNameToId: Map<string, string> = new Map()
): any {
  const block: any = {
    type: config.type,
    id: generateUniqueId(),
    x,
    y
  };
  
  // 转换字段
  if (config.fields && Object.keys(config.fields).length > 0) {
    block.fields = {};
    for (const [key, value] of Object.entries(config.fields)) {
      // 处理变量引用：{ name: "varName" } -> { id: "varId" }
      if (typeof value === 'object' && value !== null && (value as any).name) {
        const varName = (value as any).name;
        const varId = variableNameToId.get(varName);
        if (varId) {
          // 使用 ID 引用
          block.fields[key] = { id: varId };
        } else {
          // 变量未声明，保持 name 格式（Blockly 可能会自动创建）
          block.fields[key] = value;
        }
      } else {
        block.fields[key] = value;
      }
    }
  }
  
  // 转换输入
  if (config.inputs && Object.keys(config.inputs).length > 0) {
    block.inputs = {};
    for (const [inputName, inputConfig] of Object.entries(config.inputs)) {
      const input = inputConfig as any;
      
      if (input.block) {
        block.inputs[inputName] = {
          block: convertBlockConfigToAbi(input.block, 0, 0, variableNameToId)
        };
        // 移除子块的坐标（只有根块需要坐标）
        delete block.inputs[inputName].block.x;
        delete block.inputs[inputName].block.y;
      }
      if (input.shadow) {
        block.inputs[inputName] = {
          ...block.inputs[inputName],
          shadow: convertBlockConfigToAbi(input.shadow, 0, 0, variableNameToId)
        };
        delete block.inputs[inputName].shadow.x;
        delete block.inputs[inputName].shadow.y;
      }
    }
  }
  
  // 转换 next
  if (config.next?.block) {
    block.next = {
      block: convertBlockConfigToAbi(config.next.block, 0, 0, variableNameToId)
    };
    delete block.next.block.x;
    delete block.next.block.y;
  }
  
  return block;
}

/**
 * 生成唯一 ID
 */
function generateUniqueId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;=?@[]^_`{|}~';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * 计算块高度
 */
function calculateBlockHeight(config: any): number {
  let height = 50;
  
  // 递归计算输入块高度
  if (config.inputs) {
    for (const input of Object.values(config.inputs)) {
      const inputConfig = input as any;
      if (inputConfig.block) {
        height += calculateBlockHeight(inputConfig.block);
      }
    }
  }
  
  // 计算 next 链高度
  if (config.next?.block) {
    height += calculateBlockHeight(config.next.block);
  }
  
  return height;
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 验证 ABS 语法
 */
export function validateAbs(abs: string): { valid: boolean; errors: string[] } {
  const result = convertAbsToAbi(abs);
  
  if (result.success) {
    return { valid: true, errors: [] };
  }
  
  return {
    valid: false,
    errors: result.errors?.map(e => `Line ${e.line}: ${e.message}`) || []
  };
}

/**
 * 格式化 ABS（美化）
 */
export function formatAbs(abs: string): string {
  // 先解析再转回来，实现格式化
  const result = convertAbsToAbi(abs);
  if (result.success && result.abiJson) {
    return convertAbiToAbs(result.abiJson, { includeHeader: false });
  }
  return abs;
}

/**
 * 将单个块的 ABI JSON（来自 Blockly.serialization.blocks.save()）转换为 ABS 格式
 * 包含整个块子树（含子块、next 链）
 * 
 * @param blockAbiJson 单个块的 ABI JSON 对象
 * @param variables 工作区变量列表（用于将变量 ID 转为名称），格式 [{id, name, type}]
 * @returns ABS 文本
 */
export function convertBlockTreeToAbs(
  blockAbiJson: any,
  variables?: { id: string; name: string; type?: string }[]
): string {
  const context = new ConversionContext('    ', false, true);

  // 注册变量以支持 ID → 名称转换
  if (variables) {
    for (const v of variables) {
      context.registerVariable(v.id, v.name, v.type || 'int');
    }
  }

  const lines = convertBlockChainToAbs(blockAbiJson, 0, context);
  return lines.join('\n');
}
