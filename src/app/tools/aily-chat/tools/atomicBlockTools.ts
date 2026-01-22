/**
 * Blockly 块操作工具 - 原子化操作版本
 * 
 * 设计理念：
 * 1. 每个工具只做一件简单的事情
 * 2. 返回详细的状态信息，便于 LLM 做决策
 * 3. 提供智能建议和自动修复
 * 
 * 工具列表：
 * - create_single_block: 创建单个块（不支持嵌套）
 * - connect_blocks_simple: 简化的块连接（语义更清晰）
 * - set_block_field: 设置块字段值
 * - set_block_input: 设置块输入（连接已存在的块）
 * - get_workspace_blocks: 获取工作区块列表
 */

import { ToolUseResult } from "./tools";
import { getActiveWorkspace, getBlockByIdSmart, fixJsonString, getWorkspaceOverviewTool } from "./editBlockTool";
import { injectTodoReminder } from './todoWriteTool';

// 重新导出 fixJsonString 供外部使用
export { fixJsonString };

declare const Blockly: any;

// =============================================================================
// 工作区概览计数器（控制返回频率，避免过多输出）
// =============================================================================
let countForGetWorkspaceOverview = 0;
const maxCountForOverview = 4;

/**
 * 获取工作区概览信息
 * @param includeCode 是否包含生成的代码
 * @param includeTree 是否包含树状结构
 * @returns 工作区概览信息
 */
async function getWorkspaceOverviewInfo(includeCode = true, includeTree = true): Promise<{
  overview: string;
  cppCode: string;
  isError: boolean;
}> {
  try {
    const overviewResult = await getWorkspaceOverviewTool({
      includeCode,
      includeTree,
      format: 'text',
      groupBy: 'structure'
    });
    
    let overview = '';
    let cppCode = '';
    
    if (!overviewResult.is_error) {
      overview = overviewResult.content;
      // 尝试提取C++代码部分
      const codeMatch = overview.match(/```cpp([\s\S]*?)```/);
      if (codeMatch) {
        cppCode = codeMatch[1].trim();
      }
      countForGetWorkspaceOverview = 0; // 重置计数器
      return { overview, cppCode, isError: false };
    } else {
      overview = '⚠️ 工作区概览获取失败，但操作成功';
      return { overview, cppCode: '', isError: true };
    }
  } catch (error) {
    console.warn('❌ 获取工作区概览出错:', error);
    return { 
      overview: '❌ 工作区概览获取出错', 
      cppCode: '', 
      isError: true 
    };
  }
}

/**
 * 根据计数器决定是否附加工作区概览
 * @param result 原始工具返回结果
 * @param forceOverview 是否强制获取概览（忽略计数器）
 * @returns 可能附加了概览的结果
 */
async function maybeAppendWorkspaceOverview(
  result: ToolUseResult, 
  forceOverview: boolean = false
): Promise<ToolUseResult> {
  // 如果是错误结果，不附加概览
  if (result.is_error) {
    return result;
  }

  // console.log(`[workspaceOverview] count=${countForGetWorkspaceOverview}, forceOverview=${forceOverview}`);
  
  // 检查计数器
  if (forceOverview || countForGetWorkspaceOverview++ >= maxCountForOverview) {
    const { overview, isError } = await getWorkspaceOverviewInfo();
    if (!isError && overview) {
      return {
        ...result,
        content: result.content + `\n\n${overview}`
      };
    }
  }
  
  return result;
}

// =============================================================================
// 全局块 ID 映射缓存（支持跨调用引用）
// =============================================================================

/**
 * 全局块 ID 映射表
 * key: 临时 ID（如 "b1", "b2"）
 * value: 真实块 ID
 * 
 * 这允许后续调用通过临时 ID 引用之前创建的块
 */
const globalBlockIdMap = new Map<string, string>();

/**
 * 通过临时 ID 或真实 ID 查找块
 * 优先级：
 * 1. 全局映射缓存（临时 ID → 真实 ID）
 * 2. 工作区精确查找（真实 ID）
 * 3. 按类型模糊匹配
 */
export function resolveBlockId(workspace: any, idOrTempId: string): any | null {
  // 1. 先检查全局映射
  const realId = globalBlockIdMap.get(idOrTempId);
  if (realId) {
    const block = getBlockByIdSmart(workspace, realId);
    if (block) return block;
    // 映射的块已被删除，清理映射
    globalBlockIdMap.delete(idOrTempId);
  }
  
  // 2. 尝试直接作为真实 ID 查找
  const block = getBlockByIdSmart(workspace, idOrTempId);
  if (block) return block;
  
  // 3. 尝试按类型模式匹配
  return findBlockByTypePattern(workspace, idOrTempId);
}

/**
 * 注册块 ID 映射（临时 ID → 真实 ID）
 */
export function registerBlockIdMapping(tempId: string, realId: string): void {
  globalBlockIdMap.set(tempId, realId);
}

/**
 * 清除所有块 ID 映射（通常在项目切换时调用）
 */
export function clearBlockIdMappings(): void {
  globalBlockIdMap.clear();
}

/**
 * 获取当前映射表的信息（用于调试）
 */
export function getBlockIdMappings(): Record<string, string> {
  const result: Record<string, string> = {};
  globalBlockIdMap.forEach((realId, tempId) => {
    result[tempId] = realId;
  });
  return result;
}

// =============================================================================
// 类型定义
// =============================================================================

export interface CreateSingleBlockArgs {
  type: string;
  fields?: Record<string, any>;
  position?: { x: number; y: number };
  // 新增：简单 inputs 支持（仅限一层 shadow 块）
  inputs?: Record<string, {
    shadow?: {
      type: string;
      fields?: Record<string, any>;
    };
    // 或直接引用已存在的块 ID
    blockId?: string;
  }>;
  // extraState 配置（用于动态块如 text_join, lists_create_with 的输入数量）
  extraState?: Record<string, any>;
  // 创建后立即连接（可选）
  connect?: {
    action: 'put_into' | 'chain_after' | 'set_as_input';
    target: string;
    input?: string;
    moveWithChain?: boolean;
  };
}

export interface ConnectBlocksSimpleArgs {
  block: string;  // 要操作的块 ID
  action: 'put_into' | 'chain_after' | 'set_as_input';
  target: string; // 目标块 ID
  input?: string; // 目标输入名（可选）
  moveWithChain?: boolean; // 是否将块后面连接的块一起移动（默认 true）
}

export interface SetBlockFieldArgs {
  blockId: string;
  fieldName: string;
  value: any;
}

export interface SetBlockInputArgs {
  blockId: string;       // 目标块 ID
  inputName: string;     // 输入名称
  sourceBlockId?: string; // 要连接的已存在块 ID（与 newBlock 二选一）
  newBlock?: {           // 要创建并连接的新块配置（与 sourceBlockId 二选一）
    type: string;        // 块类型
    fields?: Record<string, any>;  // 块字段
    shadow?: boolean;    // 是否作为 shadow 块
  };
}

// =============================================================================
// 批量操作类型定义
// =============================================================================

/**
 * 批量创建块的配置 - 扁平化结构
 */
export interface BatchBlockConfig {
  /** 临时ID，用于后续连接引用（如 "b1", "b2"） */
  id: string;
  /** 块类型 */
  type: string;
  /** 块字段 */
  fields?: Record<string, any>;
  /** 简单inputs（一层shadow块） */
  inputs?: Record<string, {
    shadow?: {
      type: string;
      fields?: Record<string, any>;
    };
    /** 引用批量创建的其他块（使用临时ID） */
    blockRef?: string;
    /** 嵌套块（兼容 create_code_structure 格式） */
    block?: {
      id?: string;
      type: string;
      fields?: Record<string, any>;
    };
  }>;
  /** extraState 配置（用于动态块如 controls_if 的额外分支） */
  extraState?: Record<string, any>;
}

/**
 * 批量连接规则
 */
export interface BatchConnectionRule {
  /** 要操作的块（临时ID） */
  block: string;
  /** 连接动作 */
  action: 'put_into' | 'chain_after' | 'set_as_input';
  /** 目标块（临时ID 或 已存在块的真实ID） */
  target: string;
  /** 目标输入名（可选） */
  input?: string;
}

/**
 * 批量创建块的参数
 */
export interface BatchCreateBlocksArgs {
  /** 要创建的块列表（扁平化，无嵌套） */
  blocks: BatchBlockConfig[];
  /** 连接规则列表 */
  connections: BatchConnectionRule[];
  /** 起始位置（可选） */
  position?: { x: number; y: number };
}

interface BlockInfo {
  id: string;
  type: string;
  inputs: Array<{
    name: string;
    type: 'value' | 'statement';
    connected: boolean;
    connectedBlockId?: string;
    connectedBlockType?: string;
  }>;
  fields: Array<{
    name: string;
    value: any;
  }>;
  connections: {
    hasPrevious: boolean;
    hasNext: boolean;
    hasOutput: boolean;
    previousConnected?: string;
    nextConnected?: string;
  };
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 获取块的详细信息
 */
function getBlockInfo(block: any): BlockInfo {
  const inputs: BlockInfo['inputs'] = [];
  const fields: BlockInfo['fields'] = [];
  
  if (block.inputList) {
    for (const input of block.inputList) {
      // 收集输入信息
      if (input.connection) {
        const connectedBlock = input.connection.targetBlock();
        // 使用连接类型判断：3=NEXT_STATEMENT（语句输入），1=INPUT_VALUE（值输入）
        const isStatement = input.connection.type === 3;
        inputs.push({
          name: input.name,
          type: isStatement ? 'statement' : 'value',
          connected: !!connectedBlock,
          connectedBlockId: connectedBlock?.id,
          connectedBlockType: connectedBlock?.type
        });
      }
      
      // 收集字段信息
      if (input.fieldRow) {
        for (const field of input.fieldRow) {
          if (field.name) {
            fields.push({
              name: field.name,
              value: field.getValue?.() ?? null
            });
          }
        }
      }
    }
  }
  
  return {
    id: block.id,
    type: block.type,
    inputs,
    fields,
    connections: {
      hasPrevious: !!block.previousConnection,
      hasNext: !!block.nextConnection,
      hasOutput: !!block.outputConnection,
      previousConnected: block.previousConnection?.targetBlock()?.id,
      nextConnected: block.nextConnection?.targetBlock()?.id
    }
  };
}

/**
 * 查找相似的块类型（用于错误提示）
 */
function findSimilarBlockTypes(searchType: string): string[] {
  const allTypes = Object.keys(Blockly.Blocks || {});
  const searchLower = searchType.toLowerCase();
  
  return allTypes
    .filter(type => {
      const typeLower = type.toLowerCase();
      return typeLower.includes(searchLower) || 
             searchLower.includes(typeLower) ||
             levenshteinDistance(typeLower, searchLower) <= 3;
    })
    .slice(0, 5);
}

/**
 * 计算编辑距离
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

/**
 * 智能检测语句输入
 * Blockly 连接类型：1=INPUT_VALUE, 2=OUTPUT_VALUE, 3=NEXT_STATEMENT, 4=PREVIOUS_STATEMENT
 */
function detectStatementInput(block: any): string | null {
  if (!block.inputList) return null;
  
  // 常见的语句输入名称优先级
  const commonNames = ['DO', 'DO0', 'STACK', 'STATEMENTS', 'ARDUINO_SETUP', 'ARDUINO_LOOP', 'input_statement'];
  
  // 首先检查常见名称 - 使用 connection.type === 3 来判断语句输入
  for (const name of commonNames) {
    const input = block.getInput(name);
    // 语句输入的连接类型是 3 (NEXT_STATEMENT)
    if (input && input.connection && input.connection.type === 3) {
      return name;
    }
  }
  
  // 然后查找任何语句类型的输入
  for (const input of block.inputList) {
    // 使用 connection.type === 3 来检测语句输入
    if (input.connection && input.connection.type === 3) {
      return input.name;
    }
  }
  
  return null;
}

/**
 * 智能检测值输入
 * Blockly 连接类型：1=INPUT_VALUE, 2=OUTPUT_VALUE, 3=NEXT_STATEMENT, 4=PREVIOUS_STATEMENT
 */
function detectValueInput(block: any): string | null {
  if (!block.inputList) return null;
  
  // 常见的值输入名称
  const commonNames = ['VALUE', 'VAR', 'A', 'B', 'NUM', 'TEXT', 'BOOL'];
  
  for (const name of commonNames) {
    const input = block.getInput(name);
    // 值输入的连接类型是 1 (INPUT_VALUE)
    if (input && input.connection && input.connection.type === 1 && !input.connection.targetBlock()) {
      return name;
    }
  }
  
  // 查找任何未连接的值输入
  for (const input of block.inputList) {
    // 使用 connection.type === 1 来检测值输入
    if (input.connection && input.connection.type === 1 && !input.connection.targetBlock()) {
      return input.name;
    }
  }
  
  return null;
}

/**
 * 获取可用的块 ID 列表（用于错误提示）
 */
function getAvailableBlockIds(workspace: any, limit: number = 15): Array<{id: string, type: string}> {
  const blocks = workspace.getAllBlocks() || [];
  return blocks.slice(0, limit).map((b: any) => ({ id: b.id, type: b.type }));
}

/**
 * 安全地检查连接是否兼容
 * 某些版本的 Blockly 可能没有 isConnectionAllowed 方法
 */
function safeCheckConnection(connection1: any, connection2: any): { allowed: boolean; reason?: string } {
  if (!connection1 || !connection2) {
    return { allowed: false, reason: '连接点不存在' };
  }
  
  try {
    // 尝试使用 isConnectionAllowed（Blockly 某些版本）
    if (typeof connection1.isConnectionAllowed === 'function') {
      return { allowed: connection1.isConnectionAllowed(connection2) };
    }
    
    // 尝试使用 canConnectWithReason（Blockly 某些版本）
    if (typeof connection1.canConnectWithReason === 'function') {
      const reason = connection1.canConnectWithReason(connection2);
      return { allowed: reason === Blockly.Connection?.CAN_CONNECT || reason === 0 };
    }
    
    // 尝试使用 checkConnection_（Blockly 内部方法）
    if (typeof connection1.checkConnection_ === 'function') {
      try {
        connection1.checkConnection_(connection2);
        return { allowed: true };
      } catch {
        return { allowed: false, reason: '连接检查失败' };
      }
    }
    
    // 基本类型检查：检查 check 数组是否兼容
    const check1 = connection1.getCheck?.() || null;
    const check2 = connection2.getCheck?.() || null;
    
    // 如果任一方没有类型限制，允许连接
    if (!check1 || !check2) {
      return { allowed: true };
    }
    
    // 检查是否有交集
    const hasOverlap = check1.some((t: string) => check2.includes(t));
    return { 
      allowed: hasOverlap, 
      reason: hasOverlap ? undefined : `类型不匹配: ${check1.join(',')} vs ${check2.join(',')}`
    };
  } catch (e) {
    // 如果检查过程出错，允许尝试连接（让 Blockly 自己处理）
    return { allowed: true };
  }
}

/**
 * 按类型模式查找块
 * 支持多种匹配方式：
 * - "arduino_setup" 匹配 "arduino_setup_block"
 * - "arduino_setup_id0" 匹配类型包含 "arduino_setup" 的块
 * - "arduino_loop" 匹配 "arduino_loop_block"
 */
function findBlockByTypePattern(workspace: any, pattern: string): any | null {
  if (!workspace || !pattern) return null;
  
  const allBlocks = workspace.getAllBlocks() || [];
  const patternLower = pattern.toLowerCase();
  
  // 提取模式中的核心部分（去除 _id0, _id1 等后缀）
  const corePattern = patternLower.replace(/_id\d*$/, '').replace(/_block$/, '');
  
  // 常见的块类型映射
  const typePatterns: Record<string, string[]> = {
    'arduino_setup': ['arduino_setup_block', 'arduino_setup'],
    'arduino_loop': ['arduino_loop_block', 'arduino_loop'],
    'setup': ['arduino_setup_block', 'arduino_setup'],
    'loop': ['arduino_loop_block', 'arduino_loop']
  };
  
  // 1. 首先尝试精确类型匹配
  const exactTypes = typePatterns[corePattern] || [corePattern, `${corePattern}_block`];
  for (const block of allBlocks) {
    if (exactTypes.includes(block.type.toLowerCase())) {
      return block;
    }
  }
  
  // 2. 然后尝试包含匹配
  for (const block of allBlocks) {
    const typeLower = block.type.toLowerCase();
    if (typeLower.includes(corePattern) || corePattern.includes(typeLower)) {
      return block;
    }
  }
  
  // 3. 最后尝试部分匹配（至少匹配一半的字符）
  const minMatchLength = Math.floor(corePattern.length / 2);
  for (const block of allBlocks) {
    const typeLower = block.type.toLowerCase();
    // 检查是否有足够长度的公共子串
    for (let i = 0; i <= corePattern.length - minMatchLength; i++) {
      const substr = corePattern.substring(i, i + minMatchLength);
      if (typeLower.includes(substr)) {
        return block;
      }
    }
  }
  
  return null;
}

/**
 * 生成下一步操作建议
 */
function generateNextStepSuggestions(block: any): string[] {
  const suggestions: string[] = [];
  const info = getBlockInfo(block);
  
  // 建议连接到父块
  if (info.connections.hasPrevious && !info.connections.previousConnected) {
    suggestions.push(`可使用 connect_blocks_simple(action: "chain_after") 连接到其他块后面`);
    suggestions.push(`可使用 connect_blocks_simple(action: "put_into") 放入容器块`);
  }
  
  // 建议填充输入
  const emptyInputs = info.inputs.filter(i => !i.connected);
  if (emptyInputs.length > 0) {
    const inputNames = emptyInputs.map(i => `${i.name}(${i.type})`).join(', ');
    suggestions.push(`未连接的输入: ${inputNames}`);
  }
  
  return suggestions;
}

// =============================================================================
// 动态块 extraState 处理
// =============================================================================

/**
 * 支持动态输入的块类型配置
 * 用于智能推断和应用 extraState
 */
const DYNAMIC_BLOCK_TYPES: Record<string, {
  inputPattern: RegExp;
  extraStateKey: string;
  defaultCount?: number;
}> = {
  'text_join': { inputPattern: /^ADD(\d+)$/, extraStateKey: 'itemCount', defaultCount: 2 },
  'lists_create_with': { inputPattern: /^ADD(\d+)$/, extraStateKey: 'itemCount', defaultCount: 3 },
  'controls_if': { inputPattern: /^(IF|DO)(\d+)$/, extraStateKey: 'elseIfCount' },
  'controls_ifelse': { inputPattern: /^(IF|DO)(\d+)$/, extraStateKey: 'elseIfCount' },
  'procedures_defnoreturn': { inputPattern: /^ARG(\d+)$/, extraStateKey: 'params' },
  'procedures_defreturn': { inputPattern: /^ARG(\d+)$/, extraStateKey: 'params' },
};

/**
 * 从 inputs 配置智能推断 extraState
 * 例如: 如果提供了 ADD0, ADD1, ADD2，则推断 itemCount = 3
 */
function inferExtraStateFromInputs(
  blockType: string,
  inputs?: Record<string, any>
): Record<string, any> | null {
  if (!inputs) return null;
  
  const config = DYNAMIC_BLOCK_TYPES[blockType];
  if (!config) return null;
  
  const inputKeys = Object.keys(inputs);
  const pattern = config.inputPattern;
  
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
  
  // 通用处理：text_join, lists_create_with 等
  const matchingInputs = inputKeys.filter(key => pattern.test(key));
  if (matchingInputs.length === 0) return null;
  
  // 提取最大编号
  const maxNumber = Math.max(...matchingInputs.map(key => {
    const match = key.match(pattern);
    return match ? parseInt(match[1], 10) : -1;
  }));
  
  if (maxNumber < 0) return null;
  
  // itemCount = maxNumber + 1（因为从0开始）
  return { [config.extraStateKey]: maxNumber + 1 };
}

/**
 * 将 extraState 应用到块上
 * 支持多种动态块类型
 */
function applyExtraStateToBlock(
  block: any,
  extraState: Record<string, any>
): { applied: boolean; message?: string; inferred?: boolean } {
  try {
    const blockType = block.type;
    
    // 方式1: 使用 loadExtraState（Blockly 标准方式）
    if (typeof block.loadExtraState === 'function') {
      block.loadExtraState(extraState);
      
      // 某些块在 loadExtraState 后需要重新渲染
      if (typeof block.render === 'function') {
        block.render();
      }
      
      return { applied: true, message: `通过 loadExtraState 应用: ${JSON.stringify(extraState)}` };
    }
    
    // 方式2: 直接设置属性并调用 updateShape_
    const config = DYNAMIC_BLOCK_TYPES[blockType];
    if (config) {
      const key = config.extraStateKey;
      const value = extraState[key];
      
      if (value !== undefined) {
        // 设置内部属性（通常带下划线后缀）
        block[`${key}_`] = value;
        
        // 调用 updateShape_ 更新块形状
        if (typeof block.updateShape_ === 'function') {
          block.updateShape_();
        }
        
        // 重新渲染
        if (typeof block.render === 'function') {
          block.render();
        }
        
        return { applied: true, message: `通过属性设置应用 ${key}: ${value}` };
      }
    }
    
    // 方式3: 处理 controls_if 的 hasElse
    if ((blockType === 'controls_if' || blockType === 'controls_ifelse') && extraState['hasElse']) {
      block.hasElse_ = true;
      if (typeof block.updateShape_ === 'function') {
        block.updateShape_();
      }
      if (typeof block.render === 'function') {
        block.render();
      }
      return { applied: true, message: `设置 hasElse: true` };
    }
    
    return { applied: false, message: '块不支持动态 extraState' };
    
  } catch (error) {
    return { applied: false, message: `应用 extraState 失败: ${(error as Error).message}` };
  }
}

// =============================================================================
// 工具 1：创建单个块
// =============================================================================

/**
 * 解析可能是字符串的 JSON 参数
 * 增强版：支持嵌套字符串、错误日志、JSON 修复
 */
function parseJsonParam<T>(param: T | string | undefined, paramName?: string): T | undefined {
  if (param === undefined || param === null) return undefined;
  if (typeof param === 'string') {
    try {
      // 先尝试修复 JSON 字符串
      const fixResult = fixJsonString(param);
      const jsonToParse = fixResult.success ? fixResult.fixed : param;
      
      const parsed = JSON.parse(jsonToParse);
      // 如果解析结果还是字符串，可能是双重编码，再解析一次
      if (typeof parsed === 'string') {
        try {
          const innerFixResult = fixJsonString(parsed);
          const innerJson = innerFixResult.success ? innerFixResult.fixed : parsed;
          return JSON.parse(innerJson);
        } catch {
          return parsed as T;
        }
      }
      return parsed;
    } catch (e) {
      console.warn(`[parseJsonParam] 解析 ${paramName || 'param'} 失败:`, e, '原始值:', param.substring(0, 200));
      return undefined;
    }
  }
  return param;
}

/**
 * 验证并设置字段值，对下拉框和变量字段进行特殊处理
 * @returns { success: boolean, message?: string }
 */
function validateAndSetFieldValue(
  field: any,  // Blockly.Field
  value: any,
  blockType: string,
  fieldName: string,
  workspace?: any  // 用于变量字段处理
): { success: boolean; message?: string } {
  // 1. 首先检查是否是变量字段（FieldVariable 也有 getOptions，所以要先检查）
  if (field.getVariable && typeof field.getVariable === 'function') {
    try {
      // 变量字段处理
      const ws = workspace || field.getSourceBlock?.()?.workspace;
      if (!ws) {
        return { success: false, message: '无法获取工作区来处理变量字段' };
      }
      
      // 解析变量值
      let varName: string = '';
      let varId: string = '';
      let varType: string = '';
      
      if (typeof value === 'object' && value !== null) {
        varName = value.name || '';
        varId = value.id || '';
        varType = value.type || '';
      } else {
        varName = String(value);
      }
      
      const variableMap = ws.getVariableMap?.();
      
      // 优先级1: 如果提供了 id，检查该 id 是否是有效的变量 ID
      if (varId && variableMap) {
        const existingVarById = variableMap.getVariableById?.(varId);
        if (existingVarById) {
          field.setValue(varId);
          return { success: true };
        }
      }
      
      // 优先级2: 检查 varName 是否已经是变量 ID
      if (varName && variableMap) {
        const existingVarById = variableMap.getVariableById?.(varName);
        if (existingVarById) {
          field.setValue(varName);
          return { success: true };
        }
      }
      
      // 优先级3: 按名称查找现有变量（不创建新变量）
      if (varName && variableMap) {
        let variable = null;
        
        // 方式1: 直接按名称查找
        variable = variableMap.getVariable(varName);
        
        // 方式2: 带类型查找
        if (!variable && varType) {
          variable = variableMap.getVariable(varName, varType);
        }
        
        // 方式3: 遍历所有变量精确匹配
        if (!variable) {
          const allVariables = variableMap.getAllVariables?.() || [];
          variable = allVariables.find((v: any) => v.name === varName);
          
          // 大小写不敏感匹配
          if (!variable) {
            variable = allVariables.find((v: any) => 
              v.name.toLowerCase() === varName.toLowerCase()
            );
          }
        }
        
        if (variable) {
          field.setValue(variable.getId());
          return { success: true };
        }
      }
      
      // 变量不存在，返回错误（不创建新变量）
      return { 
        success: false, 
        message: `变量 "${varName || varId}" 不存在。请先创建变量或检查变量名是否正确。` 
      };
    } catch (e) {
      return { success: false, message: `变量字段处理失败: ${(e as Error).message}` };
    }
  }
  
  // 2. 检查是否是下拉框字段（排除变量字段后）
  if (field.constructor.name === 'FieldDropdown' || 
      (typeof field.getOptions === 'function' && field.constructor.name !== 'FieldVariable')) {
    try {
      const dropdownField = field as any;
      const options = dropdownField.getOptions(true); // true = use cache
      const validValues = options.map((opt: [string, string]) => opt[1]); // [displayText, value]
      
      if (validValues.includes(String(value))) {
        field.setValue(value);
        return { success: true };
      } else {
        // 值不在可用选项中
        const optionsList = options.slice(0, 10).map((opt: [string, string]) => `${opt[1]}(${opt[0]})`).join(', ');
        const moreInfo = options.length > 10 ? ` ... 共${options.length}个选项` : '';
        return { 
          success: false, 
          message: `下拉选项 "${value}" 对块类型 "${blockType}" 的字段 "${fieldName}" 不可用。可用选项: [${optionsList}${moreInfo}]。💡 提示: 请先使用 get_board_parameters 工具获取当前开发板支持的引脚和参数。` 
        };
      }
    } catch (e) {
      // 获取选项失败，尝试直接设置
      field.setValue(value);
      return { success: true };
    }
  }
  
  // 3. 非下拉框、非变量字段直接设置
  field.setValue(value);
  return { success: true };
}

/**
 * 递归创建块及其嵌套输入（支持任意深度嵌套）
 * @param workspace Blockly 工作区
 * @param blockConfig 块配置 { type, fields?, inputs?, extraState? }
 * @param isShadow 是否为 shadow 块
 * @param errors 错误收集数组
 * @returns 创建的块，失败返回 null
 */
function createBlockRecursive(
  workspace: any,
  blockConfig: {
    type: string;
    fields?: Record<string, any>;
    inputs?: Record<string, any>;
    extraState?: Record<string, any>;
  },
  isShadow: boolean = false,
  errors: string[] = []
): any | null {
  // 1. 验证块类型
  if (!Blockly.Blocks[blockConfig.type]) {
    errors.push(`块类型 "${blockConfig.type}" 不存在`);
    return null;
  }
  
  // 2. 创建块
  const newBlock = workspace.newBlock(blockConfig.type);
  newBlock.initSvg();
  if (isShadow) {
    newBlock.setShadow(true);
  }
  
  // 3. 应用 extraState（动态块如 controls_if, text_join 等）
  if (blockConfig.extraState) {
    applyExtraStateToBlock(newBlock, blockConfig.extraState);
  }
  
  // 4. 设置字段
  if (blockConfig.fields) {
    for (const [fieldName, fieldValue] of Object.entries(blockConfig.fields)) {
      const field = newBlock.getField(fieldName);
      if (field) {
        if (field.constructor.name === 'FieldVariable') {
          const varName = typeof fieldValue === 'object' ? ((fieldValue as any).name || String(fieldValue)) : String(fieldValue);
          const varType = typeof fieldValue === 'object' ? ((fieldValue as any).type || '') : '';
          let variable = workspace.getVariable(varName, varType);
          if (!variable) {
            variable = workspace.createVariable(varName, varType);
          }
          if (variable) {
            field.setValue(variable.getId());
          }
        } else {
          validateAndSetFieldValue(field, fieldValue, blockConfig.type, fieldName, workspace);
        }
      }
    }
  }
  
  // 5. 递归处理 inputs
  if (blockConfig.inputs) {
    for (const [inputName, inputConfigRaw] of Object.entries(blockConfig.inputs)) {
      const inputConfig = inputConfigRaw as {
        shadow?: { type: string; fields?: Record<string, any>; inputs?: Record<string, any> };
        block?: { type: string; fields?: Record<string, any>; inputs?: Record<string, any>; extraState?: Record<string, any> };
        blockId?: string;
      };
      
      const input = newBlock.getInput(inputName);
      if (!input || !input.connection) {
        errors.push(`输入 ${inputName} 不存在于块 ${blockConfig.type}`);
        continue;
      }
      
      if (inputConfig.shadow) {
        // 递归创建 shadow 块
        const shadowBlock = createBlockRecursive(workspace, inputConfig.shadow, true, errors);
        if (shadowBlock) {
          const conn = shadowBlock.outputConnection || shadowBlock.previousConnection;
          if (conn) {
            input.connection.connect(conn);
          }
          shadowBlock.render();
        }
      } else if (inputConfig.block) {
        // 递归创建普通块
        const childBlock = createBlockRecursive(workspace, inputConfig.block, false, errors);
        if (childBlock) {
          const conn = childBlock.outputConnection || childBlock.previousConnection;
          if (conn) {
            input.connection.connect(conn);
          }
          childBlock.render();
        }
      } else if (inputConfig.blockId) {
        // 连接已存在的块
        const existingBlock = getBlockByIdSmart(workspace, inputConfig.blockId);
        if (existingBlock) {
          const conn = existingBlock.outputConnection || existingBlock.previousConnection;
          if (conn) {
            input.connection.connect(conn);
          }
        } else {
          errors.push(`块 "${inputConfig.blockId}" 不存在`);
        }
      }
    }
  }
  
  newBlock.render();
  return newBlock;
}

/**
 * 创建单个块 - 支持任意深度嵌套的 inputs
 * 这是半原子化操作，平衡了简洁性和实用性
 */
export async function createSingleBlockTool(args: CreateSingleBlockArgs): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    const { type } = args;
    
    // 解析可能是字符串的参数
    const fields = parseJsonParam<Record<string, any>>(args.fields as any);
    const position = parseJsonParam<{ x: number; y: number }>(args.position as any);
    const inputs = parseJsonParam<Record<string, any>>(args.inputs as any);
    const extraState = parseJsonParam<Record<string, any>>(args.extraState as any);
    const connect = parseJsonParam<{
      action: 'put_into' | 'chain_after' | 'set_as_input';
      target: string;
      input?: string;
      moveWithChain?: boolean;
    }>(args.connect as any);
    
    // 1. 验证块类型
    if (!Blockly.Blocks[type]) {
      const similar = findSimilarBlockTypes(type);
      return injectTodoReminder({
        is_error: true,
        content: `❌ 未知的块类型: "${type}"`,
        metadata: {
          errorType: 'UNKNOWN_BLOCK_TYPE',
          suggestions: similar.length > 0 
            ? `可能您想要的是: ${similar.join(', ')}`
            : '请检查块类型名称是否正确，可以先读取库的 readme 确认正确的块类型'
        }
      }, 'createSingleBlockTool');
    }
    
    // 2. 创建块
    const block = workspace.newBlock(type);
    block.initSvg();
    block.render();
    
    // 3. 设置位置
    if (position && (position.x !== undefined || position.y !== undefined)) {
      block.moveTo(new Blockly.utils.Coordinate(position.x || 0, position.y || 0));
    }
    
    // 3.5 处理 extraState（动态块如 text_join, lists_create_with, controls_if 等）
    // 必须在设置 inputs 之前执行，以确保动态输入已创建
    let extraStateResult: { applied: boolean; message?: string; inferred?: boolean } = { applied: false };
    const effectiveExtraState = extraState || inferExtraStateFromInputs(type, inputs);
    
    if (effectiveExtraState) {
      extraStateResult = applyExtraStateToBlock(block, effectiveExtraState);
      if (extraStateResult.inferred) {
        extraStateResult.message = `自动推断 extraState: ${JSON.stringify(effectiveExtraState)}`;
      }
    }
    
    // 4. 设置字段
    const fieldResults: Array<{name: string, success: boolean, message?: string}> = [];
    if (fields) {
      for (const [name, value] of Object.entries(fields)) {
        try {
          const field = block.getField(name);
          if (field) {
            // 处理变量字段
            if (field.constructor.name === 'FieldVariable') {
              const varName = typeof value === 'object' ? (value.name || String(value)) : String(value);
              const varType = typeof value === 'object' ? (value.type || '') : '';
              let variable = workspace.getVariable(varName, varType);
              if (!variable) {
                variable = workspace.createVariable(varName, varType);
              }
              if (variable) {
                field.setValue(variable.getId());
                fieldResults.push({ name, success: true });
              } else {
                fieldResults.push({ name, success: false, message: '变量创建失败' });
              }
            } else {
              // 使用辅助函数验证和设置字段值（包括下拉框和变量验证）
              const result = validateAndSetFieldValue(field, value, type, name, workspace);
              fieldResults.push({ name, ...result });
            }
          } else {
            fieldResults.push({ name, success: false, message: '字段不存在' });
          }
        } catch (e) {
          fieldResults.push({ name, success: false, message: (e as Error).message });
        }
      }
    }
    
    // 5. 处理 inputs（使用递归函数支持任意深度嵌套）
    const inputResults: Array<{name: string, success: boolean, message?: string, blockId?: string}> = [];
    if (inputs) {
      for (const [inputName, inputConfigRaw] of Object.entries(inputs)) {
        const inputConfig = inputConfigRaw as {
          shadow?: { type: string; fields?: Record<string, any>; inputs?: Record<string, any> };
          block?: { type: string; fields?: Record<string, any>; inputs?: Record<string, any>; extraState?: Record<string, any> };
          blockId?: string;
        };
        
        try {
          const input = block.getInput(inputName);
          if (!input || !input.connection) {
            inputResults.push({ name: inputName, success: false, message: '输入不存在或无连接点' });
            continue;
          }
          
          if (inputConfig.shadow) {
            // 使用递归函数创建 shadow 块
            const errors: string[] = [];
            const shadowBlock = createBlockRecursive(workspace, inputConfig.shadow, true, errors);
            if (shadowBlock) {
              const conn = shadowBlock.outputConnection || shadowBlock.previousConnection;
              if (conn) {
                input.connection.connect(conn);
              }
              inputResults.push({ 
                name: inputName, 
                success: errors.length === 0, 
                message: errors.length > 0 ? errors.join('; ') : undefined,
                blockId: shadowBlock.id 
              });
            } else {
              inputResults.push({ name: inputName, success: false, message: errors.join('; ') || 'shadow块创建失败' });
            }
          } else if (inputConfig.blockId) {
            // 连接已存在的块
            const existingBlock = getBlockByIdSmart(workspace, inputConfig.blockId);
            if (!existingBlock) {
              inputResults.push({ name: inputName, success: false, message: `块 "${inputConfig.blockId}" 不存在` });
              continue;
            }
            
            const connectionToUse = existingBlock.outputConnection || existingBlock.previousConnection;
            if (connectionToUse) {
              input.connection.connect(connectionToUse);
              inputResults.push({ name: inputName, success: true, blockId: existingBlock.id });
            } else {
              inputResults.push({ name: inputName, success: false, message: '块无连接点' });
            }
          } else if (inputConfig.block) {
            // 使用递归函数创建普通块（支持任意深度嵌套）
            const errors: string[] = [];
            const newBlock = createBlockRecursive(workspace, inputConfig.block, false, errors);
            if (newBlock) {
              const conn = newBlock.outputConnection || newBlock.previousConnection;
              if (conn) {
                input.connection.connect(conn);
              }
              inputResults.push({ 
                name: inputName, 
                success: errors.length === 0, 
                message: errors.length > 0 ? errors.join('; ') : undefined,
                blockId: newBlock.id 
              });
            } else {
              inputResults.push({ name: inputName, success: false, message: errors.join('; ') || '块创建失败' });
            }
          }
        } catch (e) {
          inputResults.push({ name: inputName, success: false, message: (e as Error).message });
        }
      }
    }
    
    // 6. 获取块信息
    const blockInfo = getBlockInfo(block);
    const failedFields = fieldResults.filter(f => !f.success);
    const failedInputs = inputResults.filter(i => !i.success);
    
    // 7. 生成结果
    let content = `✅ 创建块成功: ${type} (ID: ${block.id})`;
    
    // 添加 extraState 处理信息
    if (extraStateResult.applied) {
      content += `\n✅ 动态扩展: ${extraStateResult.message}`;
    } else if (effectiveExtraState && !extraStateResult.applied) {
      content += `\n⚠️ extraState 未应用: ${extraStateResult.message || '块不支持'}`;
    }
    
    if (failedFields.length > 0) {
      content += `\n⚠️ 部分字段设置失败: ${failedFields.map(f => `${f.name}(${f.message})`).join(', ')}`;
    }
    if (failedInputs.length > 0) {
      content += `\n⚠️ 部分输入设置失败: ${failedInputs.map(i => `${i.name}(${i.message})`).join(', ')}`;
    }
    if (inputResults.filter(i => i.success).length > 0) {
      content += `\n✅ 已连接输入: ${inputResults.filter(i => i.success).map(i => i.name).join(', ')}`;
    }
    
    // 8. 处理创建后立即连接（可选）
    if (connect && connect.target && connect.action) {
      const connectArgs: ConnectBlocksSimpleArgs = {
        block: block.id,
        action: connect.action,
        target: connect.target,
        input: connect.input,
        moveWithChain: connect.moveWithChain ?? false
      };
      
      try {
        const connectRes = await connectBlocksSimpleTool(connectArgs);
        if (connectRes.is_error) {
          content += `\n⚠️ 连接失败: ${connectRes.content}`;
        } else {
          content += `\n✅ 已自动连接到目标块`;
        }
      } catch (e) {
        content += `\n⚠️ 连接异常: ${(e as Error).message}`;
      }
    }
    
    // 9. 构造基础结果并可能附加工作区概览
    const baseResult: ToolUseResult = {
      is_error: false,
      content,
      metadata: {
        blockId: block.id,
        blockType: type,
        extraStateApplied: extraStateResult.applied,
        extraState: effectiveExtraState,
        fieldResults: fieldResults.length > 0 ? fieldResults : undefined,
        inputResults: inputResults.length > 0 ? inputResults : undefined,
        availableInputs: blockInfo.inputs.map(i => ({ name: i.name, type: i.type, connected: i.connected })),
        connectionInfo: blockInfo.connections,
        nextSteps: connect ? [] : generateNextStepSuggestions(block),
        connected: !!connect
      }
    };
    
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'createSingleBlockTool');
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 创建块失败: ${(error as Error).message}`
    }, 'createSingleBlockTool');
  }
}

// =============================================================================
// 工具 2：简化的块连接
// =============================================================================

/**
 * 简化的块连接工具 - 使用更直观的语义
 */
export async function connectBlocksSimpleTool(args: ConnectBlocksSimpleArgs): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    const { block: blockId, action, target: targetId, input, moveWithChain = true } = args;
    
    // 获取块
    const sourceBlock = getBlockByIdSmart(workspace, blockId);
    const targetBlock = getBlockByIdSmart(workspace, targetId);
    
    if (!sourceBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到源块: ${blockId}`,
        metadata: { 
          errorType: 'BLOCK_NOT_FOUND',
          availableBlocks: getAvailableBlockIds(workspace) 
        }
      }, 'connectBlocksSimpleTool');
    }
    
    if (!targetBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到目标块: ${targetId}`,
        metadata: { 
          errorType: 'BLOCK_NOT_FOUND',
          availableBlocks: getAvailableBlockIds(workspace) 
        }
      }, 'connectBlocksSimpleTool');
    }
    
    // 根据动作类型执行连接
    switch (action) {
      case 'put_into':
        return await connectPutInto(sourceBlock, targetBlock, input, moveWithChain);
        
      case 'chain_after':
        return await connectChainAfter(sourceBlock, targetBlock, moveWithChain);
        
      case 'set_as_input':
        return await connectSetAsInput(sourceBlock, targetBlock, input);
        
      default:
        return injectTodoReminder({
          is_error: true,
          content: `❌ 未知的连接动作: ${action}`,
          metadata: { validActions: ['put_into', 'chain_after', 'set_as_input'] }
        }, 'connectBlocksSimpleTool');
    }
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 连接失败: ${(error as Error).message}`
    }, 'connectBlocksSimpleTool');
  }
}

/**
 * 辅助函数：获取块的完整块链（包括连接的下一个块）
 * 添加循环检测防止无限循环
 */
function getBlockChain(block: any): any[] {
  const chain = [block];
  const visited = new Set<string>([block.id]);
  let currentBlock = block;
  
  // 沿着 next 连接收集所有后续块，添加循环检测
  while (currentBlock.nextConnection && currentBlock.nextConnection.targetBlock()) {
    const nextBlock = currentBlock.nextConnection.targetBlock();
    
    // 循环检测：如果已经访问过这个块，说明存在循环，停止遍历
    if (visited.has(nextBlock.id)) {
      console.warn('检测到块链循环引用，停止遍历');
      break;
    }
    
    visited.add(nextBlock.id);
    currentBlock = nextBlock;
    chain.push(currentBlock);
    
    // 安全限制：最多遍历 1000 个块
    if (chain.length > 1000) {
      console.warn('块链过长（超过 1000），停止遍历');
      break;
    }
  }
  
  return chain;
}

/**
 * 辅助函数：从链中提取块并重连前后块
 * 当一个块在代码链中间时，将其移走后自动重连它原来的前后块
 * @param sourceBlock 要提取的块
 * @param moveWithChain 是否将块后面连接的块一起移动（默认 true）
 * @returns 返回重连结果信息
 */
function extractBlockAndReconnect(
  sourceBlock: any, 
  moveWithChain: boolean = true
): { 
  reconnected: boolean; 
  previousBlock?: any; 
  nextBlock?: any; 
  message?: string;
  movedChain?: any[];  // 移动的块链
} {
  const previousBlock = sourceBlock.getPreviousBlock?.();
  
  // 记录原始连接
  const hadPreviousConnection = sourceBlock.previousConnection?.isConnected?.();
  
  // 获取块链
  const blockChain = moveWithChain ? getBlockChain(sourceBlock) : [sourceBlock];
  const lastBlockInChain = blockChain[blockChain.length - 1];
  
  // 获取块链后的下一个块（如果不移动整个链，则是源块的下一个块）
  const nextBlock = moveWithChain 
    ? lastBlockInChain.getNextBlock?.() 
    : sourceBlock.getNextBlock?.();
  
  const hadNextConnection = moveWithChain
    ? lastBlockInChain.nextConnection?.isConnected?.()
    : sourceBlock.nextConnection?.isConnected?.();
  
  // 断开源块的前连接
  if (sourceBlock.previousConnection?.targetConnection) {
    sourceBlock.previousConnection.disconnect();
  }
  
  // 如果不移动整个链，断开源块的后连接
  if (!moveWithChain && sourceBlock.nextConnection?.targetConnection) {
    sourceBlock.nextConnection.disconnect();
  }
  
  // 如果移动整个链，断开链末尾的后连接
  if (moveWithChain && lastBlockInChain.nextConnection?.targetConnection) {
    lastBlockInChain.nextConnection.disconnect();
  }
  
  // 如果源块原来在链中间（有前块和后块），尝试重连前后块
  if (previousBlock && nextBlock && hadPreviousConnection && hadNextConnection) {
    try {
      if (previousBlock.nextConnection && nextBlock.previousConnection) {
        // 检查前后块是否可以连接
        const checkResult = safeCheckConnection(previousBlock.nextConnection, nextBlock.previousConnection);
        if (checkResult.allowed) {
          previousBlock.nextConnection.connect(nextBlock.previousConnection);
          return {
            reconnected: true,
            previousBlock,
            nextBlock,
            message: `已自动重连 ${previousBlock.type} → ${nextBlock.type}`,
            movedChain: blockChain.length > 1 ? blockChain : undefined
          };
        }
      }
    } catch (e) {
      console.warn('重连前后块失败:', e);
    }
  }
  
  return { 
    reconnected: false, 
    previousBlock, 
    nextBlock,
    movedChain: blockChain.length > 1 ? blockChain : undefined
  };
}

/**
 * 将块放入容器（语句输入）
 * @param moveWithChain 是否将块后面连接的块一起移动（默认 true）
 */
async function connectPutInto(sourceBlock: any, targetBlock: any, inputName?: string, moveWithChain: boolean = true): Promise<ToolUseResult> {
  // 检查源块是否有 previousConnection
  if (!sourceBlock.previousConnection) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 块 ${sourceBlock.type}(${sourceBlock.id}) 不能放入容器（没有 previousConnection，可能是值块）`,
      metadata: {
        errorType: 'INVALID_CONNECTION_TYPE',
        hint: '此块是值块，请使用 set_as_input 操作',
        blockInfo: getBlockInfo(sourceBlock)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  // 🛡️ 循环检测：检查是否会形成循环连接
  if (sourceBlock.id === targetBlock.id) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 不能将块放入自己`,
      metadata: { errorType: 'CIRCULAR_CONNECTION' }
    }, 'connectBlocksSimpleTool');
  }
  
  // 检查目标块是否在源块的块链中（会形成循环）
  const sourceChain = getBlockChain(sourceBlock);
  if (sourceChain.some(b => b.id === targetBlock.id)) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 不能将块放入其块链中的块（会形成循环）`,
      metadata: { errorType: 'CIRCULAR_CONNECTION' }
    }, 'connectBlocksSimpleTool');
  }
  
  // 检测或使用指定的输入名
  let finalInputName = inputName;
  if (!finalInputName) {
    finalInputName = detectStatementInput(targetBlock);
    if (!finalInputName) {
      const targetInfo = getBlockInfo(targetBlock);
      return injectTodoReminder({
        is_error: true,
        content: `❌ 目标块 ${targetBlock.type}(${targetBlock.id}) 没有语句输入`,
        metadata: {
          errorType: 'NO_STATEMENT_INPUT',
          availableInputs: targetInfo.inputs
        }
      }, 'connectBlocksSimpleTool');
    }
  }
  
  // 获取输入
  const targetInput = targetBlock.getInput(finalInputName);
  if (!targetInput || !targetInput.connection) {
    const targetInfo = getBlockInfo(targetBlock);
    return injectTodoReminder({
      is_error: true,
      content: `❌ 找不到输入: ${finalInputName}`,
      metadata: {
        errorType: 'INPUT_NOT_FOUND',
        availableInputs: targetInfo.inputs.map(i => i.name)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  // 检查是否已有连接，如果有则插入到最前面（原有块接到源块链末尾）
  const existingBlock = targetInput.connection.targetBlock();
  
  // 在实际连接前，先提取源块并尝试重连其原来的前后块
  const extractResult = extractBlockAndReconnect(sourceBlock, moveWithChain);
  
  // 构建块链信息
  const chainInfo = extractResult.movedChain && extractResult.movedChain.length > 1 
    ? `（包含 ${extractResult.movedChain.length} 个块的链）` 
    : '';
  
  if (existingBlock) {
    // 容器中已有块，将源块插入到最前面，原有块接到源块（链）后面
    try {
      // 先检查连接是否兼容
      const checkResult = safeCheckConnection(targetInput.connection, sourceBlock.previousConnection);
      if (!checkResult.allowed) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接不兼容: ${sourceBlock.type} 不能放入 ${targetBlock.type}.${finalInputName}`,
          metadata: {
            errorType: 'TYPE_MISMATCH',
            hint: checkResult.reason || '块类型不兼容'
          }
        }, 'connectBlocksSimpleTool');
      }
      
      // 断开原有块与容器的连接
      targetInput.connection.disconnect();
      
      // 将源块连接到容器
      targetInput.connection.connect(sourceBlock.previousConnection);
      
      // 验证连接是否成功
      if (targetInput.connection.targetBlock() !== sourceBlock) {
        // 尝试恢复原有连接
        try {
          targetInput.connection.connect(existingBlock.previousConnection);
        } catch (e) {
          // 忽略恢复错误
        }
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接失败: 连接操作执行但未生效`,
          metadata: {
            hint: '可能存在类型不兼容或其他约束'
          }
        }, 'connectBlocksSimpleTool');
      }
      
      // 找到源块链的末尾块
      const blockChain = moveWithChain ? getBlockChain(sourceBlock) : [sourceBlock];
      const lastBlockInChain = blockChain[blockChain.length - 1];
      
      // 将原有块连接到源块链末尾
      if (lastBlockInChain.nextConnection && existingBlock.previousConnection) {
        lastBlockInChain.nextConnection.connect(existingBlock.previousConnection);
      }
      
      const baseResult: ToolUseResult = {
        is_error: false,
        content: `✅ 已将 ${sourceBlock.type}(${sourceBlock.id})${chainInfo} 放入 ${targetBlock.type}.${finalInputName} 的最前面（原有块 ${existingBlock.type} 已移至其后）${extractResult.reconnected ? `，${extractResult.message}` : ''}`,
        metadata: {
          connectionType: 'statement_insert',
          inputName: finalInputName,
          pushedBack: existingBlock.id,
          reconnected: extractResult.reconnected,
          reconnectMessage: extractResult.message,
          movedChain: extractResult.movedChain?.map(b => b.type)
        }
      };
      
      const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
      return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
    } catch (e) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 插入连接失败: ${(e as Error).message}`
      }, 'connectBlocksSimpleTool');
    }
  }
  
  // 直接连接
  try {
    // 先检查连接是否兼容
    const checkResult = safeCheckConnection(targetInput.connection, sourceBlock.previousConnection);
    if (!checkResult.allowed) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接不兼容: ${sourceBlock.type} 不能放入 ${targetBlock.type}.${finalInputName}`,
        metadata: {
          errorType: 'TYPE_MISMATCH',
          hint: checkResult.reason || '块类型不兼容'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    targetInput.connection.connect(sourceBlock.previousConnection);
    
    // 验证连接是否成功
    if (targetInput.connection.targetBlock() !== sourceBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接失败: 连接操作执行但未生效`,
        metadata: {
          hint: '可能存在类型不兼容或其他约束'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    const baseResult: ToolUseResult = {
      is_error: false,
      content: `✅ 已将 ${sourceBlock.type}(${sourceBlock.id})${chainInfo} 放入 ${targetBlock.type}(${targetBlock.id}).${finalInputName}${extractResult.reconnected ? `，${extractResult.message}` : ''}`,
      metadata: {
        connectionType: 'statement',
        inputName: finalInputName,
        reconnected: extractResult.reconnected,
        reconnectMessage: extractResult.message,
        movedChain: extractResult.movedChain?.map(b => b.type)
      }
    };
    
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
  } catch (e) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 连接失败: ${(e as Error).message}`
    }, 'connectBlocksSimpleTool');
  }
}

/**
 * 链接到块后面
 * @param moveWithChain 是否将块后面连接的块一起移动（默认 true）
 */
async function connectChainAfter(sourceBlock: any, targetBlock: any, moveWithChain: boolean = false): Promise<ToolUseResult> {
  // 检查源块是否有 previousConnection
  if (!sourceBlock.previousConnection) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 块 ${sourceBlock.type}(${sourceBlock.id}) 不能链接（没有 previousConnection）`,
      metadata: {
        errorType: 'INVALID_CONNECTION_TYPE',
        blockInfo: getBlockInfo(sourceBlock)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  // 检查目标块是否有 nextConnection
  if (!targetBlock.nextConnection) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 块 ${targetBlock.type}(${targetBlock.id}) 不能被链接（没有 nextConnection）`,
      metadata: {
        errorType: 'INVALID_CONNECTION_TYPE',
        blockInfo: getBlockInfo(targetBlock)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  // 🛡️ 循环检测：检查是否会形成循环连接
  if (sourceBlock.id === targetBlock.id) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 不能将块连接到自己`,
      metadata: { errorType: 'CIRCULAR_CONNECTION' }
    }, 'connectBlocksSimpleTool');
  }
  
  // 获取源块的后续链（用于检测链内重排）
  const sourceChain = getBlockChain(sourceBlock);
  
  // 检查目标块是否在源块的后续链中（链内重排场景）
  const targetIndexInChain = sourceChain.findIndex(b => b.id === targetBlock.id);
  const isChainReorder = targetIndexInChain > 0; // > 0 因为 index 0 是源块自己
  
  // 记录源块的前一个块和源块所在的容器输入（用于后续可能的重连）
  const sourcePreviousBlock = sourceBlock.getPreviousBlock?.();
  const sourceParentConnection = sourceBlock.previousConnection?.targetConnection;
  
  // 🔄 链内重排场景：需要特殊处理
  // 例如：A 中有 B-C-D，要把 B 移到 D 后面变成 C-D-B（在 A 中）
  // 或者：B-C-D 要把 C 移到 D 后面变成 B-D-C
  if (isChainReorder) {
    try {
      // 找出源块和目标块之间的块（不包括源块和目标块）
      const blocksBetween = sourceChain.slice(1, targetIndexInChain); // 源块之后、目标块之前的块
      
      // 获取目标块后面的块（这些块需要接到源块后面）
      const blocksAfterTarget = sourceChain.slice(targetIndexInChain + 1);
      
      // ⚠️ 关键：必须先断开所有连接，使所有块完全独立
      // 否则会出现 DOM 循环错误 "The new child element contains the parent"
      
      // 记录所有需要断开的连接点
      const disconnectList: Array<{ connection: any; name: string }> = [];
      
      // 1. 源块的 previous 连接（与父块或容器的连接）
      if (sourceBlock.previousConnection?.isConnected?.()) {
        disconnectList.push({ 
          connection: sourceBlock.previousConnection, 
          name: 'source.previous' 
        });
      }
      
      // 2. 遍历链中每个块的 next 连接，全部断开
      for (let i = 0; i < sourceChain.length - 1; i++) {
        const block = sourceChain[i];
        if (block.nextConnection?.isConnected?.()) {
          disconnectList.push({ 
            connection: block.nextConnection, 
            name: `chain[${i}].next (${block.type})` 
          });
        }
      }
      
      // 执行断开操作
      for (const item of disconnectList) {
        try {
          item.connection.disconnect();
        } catch (e) {
          console.warn(`断开连接失败 ${item.name}:`, e);
        }
      }
      
      // 现在所有块都是独立的，可以安全地重新连接
      
      // 第一步：如果有中间块，将第一个中间块连接到源块原来的位置
      if (blocksBetween.length > 0 && sourceParentConnection) {
        const firstBetween = blocksBetween[0];
        if (firstBetween.previousConnection) {
          sourceParentConnection.connect(firstBetween.previousConnection);
        }
      }
      
      // 第二步：重建中间块之间的连接（如果有多个中间块）
      for (let i = 0; i < blocksBetween.length - 1; i++) {
        const currentBlock = blocksBetween[i];
        const nextBlock = blocksBetween[i + 1];
        if (currentBlock.nextConnection && nextBlock.previousConnection) {
          currentBlock.nextConnection.connect(nextBlock.previousConnection);
        }
      }
      
      // 第三步：将最后一个中间块（或源块原来的父连接）连接到目标块
      if (blocksBetween.length > 0) {
        const lastBetween = blocksBetween[blocksBetween.length - 1];
        if (lastBetween.nextConnection && targetBlock.previousConnection) {
          lastBetween.nextConnection.connect(targetBlock.previousConnection);
        }
      } else if (sourceParentConnection && targetBlock.previousConnection) {
        // 没有中间块，目标块直接连到源块原来的位置
        sourceParentConnection.connect(targetBlock.previousConnection);
      }
      
      // 第四步：将源块连接到目标块后面
      if (targetBlock.nextConnection && sourceBlock.previousConnection) {
        targetBlock.nextConnection.connect(sourceBlock.previousConnection);
      }
      
      // 第五步：将目标块后面的块连接到源块后面
      if (blocksAfterTarget.length > 0 && sourceBlock.nextConnection) {
        const firstAfterTarget = blocksAfterTarget[0];
        if (firstAfterTarget.previousConnection) {
          sourceBlock.nextConnection.connect(firstAfterTarget.previousConnection);
        }
        
        // 重建目标块后面各块之间的连接
        for (let i = 0; i < blocksAfterTarget.length - 1; i++) {
          const currentBlock = blocksAfterTarget[i];
          const nextBlock = blocksAfterTarget[i + 1];
          if (currentBlock.nextConnection && nextBlock.previousConnection) {
            currentBlock.nextConnection.connect(nextBlock.previousConnection);
          }
        }
      }
      
      const baseResult: ToolUseResult = {
        is_error: false,
        content: `✅ 链内重排成功：已将 ${sourceBlock.type}(${sourceBlock.id}) 移动到 ${targetBlock.type}(${targetBlock.id}) 之后`,
        metadata: {
          connectionType: 'chain_reorder',
          originalChain: sourceChain.map(b => b.type),
          blocksBetween: blocksBetween.map(b => b.type),
          blocksAfterTarget: blocksAfterTarget.map(b => b.type)
        }
      };
      const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
      return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
    } catch (e) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 链内重排失败: ${(e as Error).message}`
      }, 'connectBlocksSimpleTool');
    }
  }
  
  // 🔄 标准场景：源块和目标块不在同一个链中
  
  // 在实际连接前，先提取源块并尝试重连其原来的前后块
  const extractResult = extractBlockAndReconnect(sourceBlock, moveWithChain);
  
  // 提取源块后，重新获取目标块的 nextConnection 目标
  // 因为提取操作可能已经改变了连接关系
  const existingNext = targetBlock.nextConnection.targetBlock();
  
  // 构建块链信息
  const chainInfo = extractResult.movedChain && extractResult.movedChain.length > 1 
    ? `（包含 ${extractResult.movedChain.length} 个块的链）` 
    : '';
  
  // 获取块链的末尾块（用于连接原有的后续块）
  const blockChain = moveWithChain ? getBlockChain(sourceBlock) : [sourceBlock];
  const lastBlockInChain = blockChain[blockChain.length - 1];
  
  try {
    // 先检查连接是否兼容
    const checkResult = safeCheckConnection(targetBlock.nextConnection, sourceBlock.previousConnection);
    if (!checkResult.allowed) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接不兼容: ${sourceBlock.type} 不能链接到 ${targetBlock.type} 之后`,
        metadata: {
          errorType: 'TYPE_MISMATCH',
          hint: checkResult.reason || '块类型不兼容'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    if (existingNext) {
      // 断开现有连接，插入新块（或块链）
      targetBlock.nextConnection.disconnect();
      targetBlock.nextConnection.connect(sourceBlock.previousConnection);
      
      // 验证连接是否成功
      if (targetBlock.nextConnection.targetBlock() !== sourceBlock) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接失败: 连接操作执行但未生效`,
          metadata: {
            hint: '可能存在类型不兼容或其他约束'
          }
        }, 'connectBlocksSimpleTool');
      }
      
      // 将原来的下一个块连接到块链末尾块后面
      if (lastBlockInChain.nextConnection && existingNext.previousConnection) {
        lastBlockInChain.nextConnection.connect(existingNext.previousConnection);
        const baseResult: ToolUseResult = {
          is_error: false,
          content: `✅ 已将 ${sourceBlock.type}(${sourceBlock.id})${chainInfo} 插入到 ${targetBlock.type}(${targetBlock.id}) 之后（原有块 ${existingNext.type} 已移至其后）${extractResult.reconnected ? `，${extractResult.message}` : ''}`,
          metadata: {
            connectionType: 'next_insert',
            insertedBefore: existingNext.id,
            reconnected: extractResult.reconnected,
            reconnectMessage: extractResult.message,
            movedChain: extractResult.movedChain?.map(b => b.type)
          }
        };
        const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
        return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
      }
    }
    
    targetBlock.nextConnection.connect(sourceBlock.previousConnection);
    
    // 验证连接是否成功
    if (targetBlock.nextConnection.targetBlock() !== sourceBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接失败: 连接操作执行但未生效`,
        metadata: {
          hint: '可能存在类型不兼容或其他约束'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    const baseResult: ToolUseResult = {
      is_error: false,
      content: `✅ 已将 ${sourceBlock.type}(${sourceBlock.id})${chainInfo} 链接到 ${targetBlock.type}(${targetBlock.id}) 之后${extractResult.reconnected ? `，${extractResult.message}` : ''}`,
      metadata: {
        connectionType: 'next',
        reconnected: extractResult.reconnected,
        reconnectMessage: extractResult.message,
        movedChain: extractResult.movedChain?.map(b => b.type)
      }
    };
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
  } catch (e) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 链接失败: ${(e as Error).message}`
    }, 'connectBlocksSimpleTool');
  }
}

/**
 * 设置为输入值
 */
async function connectSetAsInput(sourceBlock: any, targetBlock: any, inputName?: string): Promise<ToolUseResult> {
  // 检查源块是否有 outputConnection
  if (!sourceBlock.outputConnection) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 块 ${sourceBlock.type}(${sourceBlock.id}) 不能作为值（没有 outputConnection，可能是语句块）`,
      metadata: {
        errorType: 'INVALID_CONNECTION_TYPE',
        hint: '此块是语句块，请使用 put_into 或 chain_after 操作',
        blockInfo: getBlockInfo(sourceBlock)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  // 检测或使用指定的输入名
  let finalInputName = inputName;
  if (!finalInputName) {
    finalInputName = detectValueInput(targetBlock);
    if (!finalInputName) {
      const targetInfo = getBlockInfo(targetBlock);
      return injectTodoReminder({
        is_error: true,
        content: `❌ 目标块 ${targetBlock.type}(${targetBlock.id}) 没有可用的值输入`,
        metadata: {
          errorType: 'NO_VALUE_INPUT',
          availableInputs: targetInfo.inputs
        }
      }, 'connectBlocksSimpleTool');
    }
  }
  
  // 获取输入
  const targetInput = targetBlock.getInput(finalInputName);
  if (!targetInput || !targetInput.connection) {
    const targetInfo = getBlockInfo(targetBlock);
    return injectTodoReminder({
      is_error: true,
      content: `❌ 找不到输入: ${finalInputName}`,
      metadata: {
        errorType: 'INPUT_NOT_FOUND',
        availableInputs: targetInfo.inputs.map(i => i.name)
      }
    }, 'connectBlocksSimpleTool');
  }
  
  try {
    // 先检查连接是否兼容
    const checkResult = safeCheckConnection(targetInput.connection, sourceBlock.outputConnection);
    if (!checkResult.allowed) {
      const inputCheck = targetInput.connection.getCheck?.() || [];
      const outputCheck = sourceBlock.outputConnection.getCheck?.() || [];
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接不兼容: ${sourceBlock.type} 的输出类型与 ${targetBlock.type}.${finalInputName} 的输入类型不匹配`,
        metadata: {
          errorType: 'TYPE_MISMATCH',
          inputAccepts: inputCheck.length > 0 ? inputCheck : '任意类型',
          sourceOutputType: outputCheck.length > 0 ? outputCheck : '任意类型',
          hint: checkResult.reason || '请检查块的输出类型是否与输入期望的类型匹配'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    targetInput.connection.connect(sourceBlock.outputConnection);
    
    // 验证连接是否成功
    if (targetInput.connection.targetBlock() !== sourceBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 连接失败: 连接操作执行但未生效`,
        metadata: {
          hint: '可能存在类型不兼容或其他约束'
        }
      }, 'connectBlocksSimpleTool');
    }
    
    const baseResult: ToolUseResult = {
      is_error: false,
      content: `✅ 已将 ${sourceBlock.type}(${sourceBlock.id}) 设置为 ${targetBlock.type}(${targetBlock.id}).${finalInputName} 的值`,
      metadata: {
        connectionType: 'value',
        inputName: finalInputName
      }
    };
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'connectBlocksSimpleTool');
  } catch (e) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 连接失败: ${(e as Error).message}`
    }, 'connectBlocksSimpleTool');
  }
}

// =============================================================================
// 工具 3：设置字段值
// =============================================================================

/**
 * 检测字段是否是变量字段
 */
function isVariableField(field: any, fieldName: string): boolean {
  // 方法1: 检查是否有 getVariable 方法
  if (field.getVariable && typeof field.getVariable === 'function') {
    return true;
  }
  
  // 方法2: 检查构造函数名（备用）
  try {
    if (field.constructor.name === 'FieldVariable') {
      return true;
    }
  } catch {}
  
  // 方法3: 根据字段名推断
  const variableFieldNames = ['VAR', 'VARIABLE', 'VAR_NAME', 'VARIABLE_NAME'];
  if (variableFieldNames.includes(fieldName) || 
      fieldName.toLowerCase().includes('var')) {
    return true;
  }
  
  return false;
}

/**
 * 智能处理变量字段值（不创建新变量，只查找现有变量）
 * 支持：
 * 1. 直接传入变量ID
 * 2. 传入变量名（自动查找）
 * 3. 传入对象 {name: "varName", id: "varId", type: "varType"}
 */
function handleVariableFieldValue(
  workspace: any,
  field: any,
  value: any
): { success: boolean; message?: string; variableId?: string } {
  let varName: string = '';
  let varId: string = '';
  let varType: string = '';
  
  // 解析传入的值
  if (typeof value === 'object' && value !== null) {
    varName = value.name || '';
    varId = value.id || '';
    varType = value.type || '';
  } else {
    varName = String(value);
  }
  
  const variableMap = workspace.getVariableMap?.();
  
  // 情况1: 如果提供了 id，先检查该 id 是否是有效的变量 ID
  if (varId && variableMap) {
    const existingVarById = variableMap.getVariableById?.(varId);
    if (existingVarById) {
      // ID 有效，直接使用
      field.setValue(varId);
      return { success: true, variableId: varId };
    }
  }
  
  // 情况2: 检查 varName 是否已经是变量 ID
  if (varName && variableMap) {
    const existingVarById = variableMap.getVariableById?.(varName);
    if (existingVarById) {
      field.setValue(varName);
      return { success: true, variableId: varName };
    }
  }
  
  // 情况3: 按名称查找现有变量（不创建新变量）
  if (varName && variableMap) {
    let variable = null;
    
    // 方式1: 直接按名称查找
    variable = variableMap.getVariable(varName);
    
    // 方式2: 带类型查找
    if (!variable && varType) {
      variable = variableMap.getVariable(varName, varType);
    }
    
    // 方式3: 遍历所有变量精确匹配
    if (!variable) {
      const allVariables = variableMap.getAllVariables?.() || [];
      variable = allVariables.find((v: any) => v.name === varName);
      
      // 大小写不敏感匹配
      if (!variable) {
        variable = allVariables.find((v: any) => 
          v.name.toLowerCase() === varName.toLowerCase()
        );
      }
    }
    
    // 如果找到了变量，使用它的 ID
    if (variable) {
      const foundId = variable.getId();
      field.setValue(foundId);
      return { success: true, variableId: foundId };
    }
  }
  
  // 变量不存在，返回错误（不创建新变量）
  return { 
    success: false, 
    message: `变量 "${varName || varId}" 不存在。请先使用变量初始化块创建变量，或检查变量名/ID是否正确。` 
  };
}

/**
 * 单独设置块的字段值
 */
export async function setBlockFieldTool(args: SetBlockFieldArgs): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    const { blockId, fieldName } = args;
    
    // 解析可能是字符串的 value 参数（如果是 JSON 对象字符串）
    let value = args.value;
    if (typeof value === 'string') {
      try {
        // 先尝试修复 JSON 字符串
        const fixResult = fixJsonString(value);
        const jsonToParse = fixResult.success ? fixResult.fixed : value;
        
        // 尝试解析 JSON，如果失败则保持原始字符串
        const parsed = JSON.parse(jsonToParse);
        // 只有当解析结果是对象时才使用（用于变量等复杂值）
        if (typeof parsed === 'object' && parsed !== null) {
          value = parsed;
        }
      } catch {
        // 保持原始字符串值（正常的字段值如 "Hello"）
      }
    }
    
    const block = getBlockByIdSmart(workspace, blockId);
    if (!block) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到块: ${blockId}`,
        metadata: { availableBlocks: getAvailableBlockIds(workspace) }
      }, 'setBlockFieldTool');
    }
    
    const field = block.getField(fieldName);
    if (!field) {
      const blockInfo = getBlockInfo(block);
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到字段: ${fieldName}`,
        metadata: { 
          availableFields: blockInfo.fields.map(f => f.name),
          blockType: block.type
        }
      }, 'setBlockFieldTool');
    }
    
    // 检测并处理变量字段
    if (isVariableField(field, fieldName)) {
      const result = handleVariableFieldValue(workspace, field, value);
      if (!result.success) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 变量字段设置失败: ${result.message}`
        }, 'setBlockFieldTool');
      }
      
      const baseResult: ToolUseResult = {
        is_error: false,
        content: `✅ 已设置 ${block.type}(${blockId}).${fieldName} = ${result.variableId}${result.message ? ` (${result.message})` : ''}`,
        metadata: {
          blockId,
          blockType: block.type,
          fieldName,
          variableId: result.variableId,
          newValue: field.getValue()
        }
      };
      const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
      return injectTodoReminder(resultWithOverview, 'setBlockFieldTool');
    }
    
    // 非变量字段：使用 validateAndSetFieldValue 处理（支持下拉框验证等）
    const setResult = validateAndSetFieldValue(field, value, block.type, fieldName, workspace);
    if (!setResult.success) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 字段设置失败: ${setResult.message}`
      }, 'setBlockFieldTool');
    }
    
    const baseResult: ToolUseResult = {
      is_error: false,
      content: `✅ 已设置 ${block.type}(${blockId}).${fieldName} = ${JSON.stringify(value)}`,
      metadata: {
        blockId,
        blockType: block.type,
        fieldName,
        newValue: field.getValue()
      }
    };
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'setBlockFieldTool');
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 设置字段失败: ${(error as Error).message}`
    }, 'setBlockFieldTool');
  }
}

// =============================================================================
// 工具 4：设置块输入（连接已存在的块或创建新块）
// =============================================================================

/**
 * 设置块的输入 - 支持连接已存在的块或创建新块
 */
export async function setBlockInputTool(args: SetBlockInputArgs): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    const { blockId, inputName, sourceBlockId } = args;
    
    // 解析 newBlock 参数（可能是 JSON 字符串）
    let newBlock = args.newBlock;
    if (typeof newBlock === 'string') {
      // 先尝试修复 JSON 字符串
      const fixResult = fixJsonString(newBlock);
      if (!fixResult.success) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ newBlock 参数格式错误，无法解析 JSON: ${fixResult.error}`
        }, 'setBlockInputTool');
      }
      try {
        newBlock = JSON.parse(fixResult.fixed);
      } catch (e) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ newBlock 参数格式错误，无法解析 JSON: ${(e as Error).message}`
        }, 'setBlockInputTool');
      }
    }
    
    // 验证参数：sourceBlockId 和 newBlock 必须二选一
    if (!sourceBlockId && !newBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 必须提供 sourceBlockId（连接已存在的块）或 newBlock（创建新块）之一`
      }, 'setBlockInputTool');
    }
    
    if (sourceBlockId && newBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ sourceBlockId 和 newBlock 不能同时提供，请选择其一`
      }, 'setBlockInputTool');
    }
    
    const targetBlock = getBlockByIdSmart(workspace, blockId);
    if (!targetBlock) {
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到目标块: ${blockId}`,
        metadata: { availableBlocks: getAvailableBlockIds(workspace) }
      }, 'setBlockInputTool');
    }
    
    const input = targetBlock.getInput(inputName);
    if (!input || !input.connection) {
      const blockInfo = getBlockInfo(targetBlock);
      return injectTodoReminder({
        is_error: true,
        content: `❌ 找不到输入: ${inputName}`,
        metadata: { 
          availableInputs: blockInfo.inputs,
          blockType: targetBlock.type
        }
      }, 'setBlockInputTool');
    }
    
    let sourceBlock: any;
    let createdNewBlock = false;
    let newBlockId: string | undefined;
    
    if (sourceBlockId) {
      // 模式1：连接已存在的块
      sourceBlock = getBlockByIdSmart(workspace, sourceBlockId);
      if (!sourceBlock) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 找不到源块: ${sourceBlockId}`,
          metadata: { availableBlocks: getAvailableBlockIds(workspace) }
        }, 'setBlockInputTool');
      }
    } else if (newBlock) {
      // 模式2：创建新块并连接
      if (!Blockly.Blocks[newBlock.type]) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 块类型不存在: ${newBlock.type}`
        }, 'setBlockInputTool');
      }
      
      sourceBlock = workspace.newBlock(newBlock.type);
      sourceBlock.initSvg();
      
      // 设置字段
      if (newBlock.fields) {
        for (const [fieldName, fieldValue] of Object.entries(newBlock.fields)) {
          const field = sourceBlock.getField(fieldName);
          if (field) {
            // 处理变量字段
            if (field.constructor.name === 'FieldVariable') {
              const varName = typeof fieldValue === 'object' ? (fieldValue.name || String(fieldValue)) : String(fieldValue);
              const varType = typeof fieldValue === 'object' ? (fieldValue.type || '') : '';
              let variable = workspace.getVariable(varName, varType);
              if (!variable) {
                variable = workspace.createVariable(varName, varType);
              }
              if (variable) {
                field.setValue(variable.getId());
              }
            } else {
              field.setValue(fieldValue);
            }
          }
        }
      }
      
      // 设置为 shadow 块（如果指定）
      if (newBlock.shadow) {
        sourceBlock.setShadow(true);
      }
      
      sourceBlock.render();
      createdNewBlock = true;
      newBlockId = sourceBlock.id;
    }
    
    // 根据输入连接类型选择连接方式
    // Blockly 连接类型：1=INPUT_VALUE, 3=NEXT_STATEMENT (语句输入)
    const isStatementInput = input.connection.type === 3;
    
    if (isStatementInput) {
      // 语句输入
      if (!sourceBlock.previousConnection) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 源块 ${sourceBlock.type} 不能连接到语句输入（没有 previousConnection）`
        }, 'setBlockInputTool');
      }
      
      // 检查连接是否兼容
      const checkResult = safeCheckConnection(input.connection, sourceBlock.previousConnection);
      if (!checkResult.allowed) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接不兼容: ${sourceBlock.type} 不能连接到 ${targetBlock.type}.${inputName}`,
          metadata: {
            reason: checkResult.reason || '类型检查失败，可能是块类型不匹配',
            sourceBlockType: sourceBlock.type,
            targetInputName: inputName
          }
        }, 'setBlockInputTool');
      }
      
      input.connection.connect(sourceBlock.previousConnection);
      
      // 验证连接是否成功
      if (input.connection.targetBlock() !== sourceBlock) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接失败: 连接操作执行但未生效`,
          metadata: {
            hint: '可能存在类型不兼容或其他约束'
          }
        }, 'setBlockInputTool');
      }
    } else {
      // 值输入
      if (!sourceBlock.outputConnection) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 源块 ${sourceBlock.type} 不能连接到值输入（没有 outputConnection）`
        }, 'setBlockInputTool');
      }
      
      // 检查连接是否兼容
      const checkResult = safeCheckConnection(input.connection, sourceBlock.outputConnection);
      if (!checkResult.allowed) {
        // 获取更详细的类型信息
        const inputCheck = input.connection.getCheck?.() || [];
        const outputCheck = sourceBlock.outputConnection.getCheck?.() || [];
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接不兼容: ${sourceBlock.type} 的输出类型与 ${targetBlock.type}.${inputName} 的输入类型不匹配`,
          metadata: {
            reason: checkResult.reason || '类型检查失败',
            inputAccepts: inputCheck.length > 0 ? inputCheck : '任意类型',
            sourceOutputType: outputCheck.length > 0 ? outputCheck : '任意类型',
            hint: '请检查块的输出类型是否与输入期望的类型匹配'
          }
        }, 'setBlockInputTool');
      }
      
      input.connection.connect(sourceBlock.outputConnection);
      
      // 验证连接是否成功
      if (input.connection.targetBlock() !== sourceBlock) {
        return injectTodoReminder({
          is_error: true,
          content: `❌ 连接失败: 连接操作执行但未生效`,
          metadata: {
            hint: '可能存在类型不兼容或其他约束'
          }
        }, 'setBlockInputTool');
      }
    }
    
    // 构建返回消息
    const actionDesc = createdNewBlock 
      ? `创建 ${sourceBlock.type} 并连接`
      : `连接 ${sourceBlock.type}(${sourceBlockId})`;
    
    const baseResult: ToolUseResult = {
      is_error: false,
      content: `✅ 已${actionDesc}到 ${targetBlock.type}(${blockId}).${inputName}`,
      metadata: {
        targetBlockId: blockId,
        sourceBlockId: newBlockId || sourceBlockId,
        inputName,
        inputType: isStatementInput ? 'statement' : 'value',
        createdNewBlock,
        newBlockType: createdNewBlock ? sourceBlock.type : undefined
      }
    };
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult);
    return injectTodoReminder(resultWithOverview, 'setBlockInputTool');
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 设置输入失败: ${(error as Error).message}`
    }, 'setBlockInputTool');
  }
}

// =============================================================================
// 工具 5：批量创建块并建立连接（高效版）
// =============================================================================

/**
 * 批量创建块并建立连接 - 一次调用完成整个结构
 * 使用扁平化结构避免深层嵌套，通过临时ID引用
 */
export async function batchCreateBlocksTool(args: BatchCreateBlocksArgs): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    
    // 解析可能是字符串的参数（增强日志）
    // console.log('[batchCreateBlocksTool] 原始参数:', {
    //   blocksType: typeof args.blocks,
    //   connectionsType: typeof args.connections,
    //   positionType: typeof args.position
    // });
    
    const blocks = parseJsonParam<BatchBlockConfig[]>(args.blocks as any, 'blocks') || [];
    const connections = parseJsonParam<BatchConnectionRule[]>(args.connections as any, 'connections') || [];
    const position = parseJsonParam<{ x: number; y: number }>(args.position as any, 'position');
    
    // console.log('[batchCreateBlocksTool] 解析后:', {
    //   blocksCount: blocks.length,
    //   connectionsCount: connections.length,
    //   position
    // });
    
    if (blocks.length === 0) {
      const rawBlocks = args.blocks as any;
      return injectTodoReminder({
        is_error: true,
        content: `❌ 批量创建失败: blocks 数组为空。原始参数类型: ${typeof rawBlocks}`,
        metadata: {
          rawBlocksType: typeof rawBlocks,
          rawBlocksPreview: typeof rawBlocks === 'string' ? (rawBlocks as string).substring(0, 500) : 'not a string'
        }
      }, 'batchCreateBlocksTool');
    }
    
    // 临时ID → 实际块 的映射
    const blockMap = new Map<string, any>();
    
    // 记录创建结果
    const createResults: Array<{
      tempId: string;
      realId: string;
      type: string;
      success: boolean;
      message?: string;
    }> = [];
    
    // 记录连接结果
    const connectionResults: Array<{
      rule: BatchConnectionRule;
      success: boolean;
      message?: string;
    }> = [];
    
    // 1. 按顺序创建所有块
    let posX = position?.x || 50;
    let posY = position?.y || 50;
    
    for (const blockConfig of blocks) {
      try {
        // 验证块类型
        if (!Blockly.Blocks[blockConfig.type]) {
          const similar = findSimilarBlockTypes(blockConfig.type);
          createResults.push({
            tempId: blockConfig.id,
            realId: '',
            type: blockConfig.type,
            success: false,
            message: `未知块类型${similar.length > 0 ? `，可能是: ${similar.join(', ')}` : ''}`
          });
          continue;
        }
        
        // 创建块
        const block = workspace.newBlock(blockConfig.type);
        block.initSvg();
        
        // 处理 extraState（如 controls_if 的额外分支，text_join 的输入数量）
        // 支持显式提供或从 inputs 自动推断
        const effectiveExtraState = blockConfig.extraState || inferExtraStateFromInputs(blockConfig.type, blockConfig.inputs);
        if (effectiveExtraState) {
          const extraStateResult = applyExtraStateToBlock(block, effectiveExtraState);
          if (!extraStateResult.applied) {
            console.warn(`[batchCreateBlocksTool] extraState 应用失败: ${extraStateResult.message}`);
          }
        }
        
        block.render();
        
        // 设置位置（错开放置）
        block.moveTo(new Blockly.utils.Coordinate(posX, posY));
        posY += 60; // 下一个块往下偏移
        
        // 设置字段
        const fieldErrors: string[] = [];
        if (blockConfig.fields) {
          for (const [fieldName, fieldValue] of Object.entries(blockConfig.fields)) {
            try {
              const field = block.getField(fieldName);
              if (field) {
                if (field.constructor.name === 'FieldVariable') {
                  const varName = typeof fieldValue === 'object' ? (fieldValue.name || String(fieldValue)) : String(fieldValue);
                  const varType = typeof fieldValue === 'object' ? (fieldValue.type || '') : '';
                  let variable = workspace.getVariable(varName, varType);
                  if (!variable) {
                    variable = workspace.createVariable(varName, varType);
                  }
                  if (variable) {
                    field.setValue(variable.getId());
                  }
                } else {
                  // 使用验证函数（包括下拉框和变量验证）
                  const result = validateAndSetFieldValue(field, fieldValue, blockConfig.type, fieldName, workspace);
                  if (!result.success) {
                    fieldErrors.push(result.message || `字段 ${fieldName} 设置失败`);
                  }
                }
              }
            } catch (e) {
              fieldErrors.push(`字段 ${fieldName} 设置失败: ${(e as Error).message}`);
            }
          }
        }
        
        // 处理 inputs（使用递归函数支持任意深度嵌套）
        if (blockConfig.inputs) {
          for (const [inputName, inputConfig] of Object.entries(blockConfig.inputs)) {
            try {
              const input = block.getInput(inputName);
              if (!input || !input.connection) {
                console.warn(`[batchCreateBlocksTool] 块 ${blockConfig.type} 没有输入 ${inputName}`);
                continue;
              }
              
              if (inputConfig.shadow) {
                // 使用递归函数创建 shadow 块（支持任意深度嵌套）
                const errors: string[] = [];
                const shadowBlock = createBlockRecursive(workspace, inputConfig.shadow, true, errors);
                if (shadowBlock) {
                  const conn = shadowBlock.outputConnection || shadowBlock.previousConnection;
                  if (conn) {
                    input.connection.connect(conn);
                  }
                }
                if (errors.length > 0) {
                  fieldErrors.push(...errors);
                }
              } else if ((inputConfig as any).block) {
                // 使用递归函数创建嵌套块（支持任意深度嵌套）
                const nestedBlockConfig = (inputConfig as any).block;
                const errors: string[] = [];
                const nestedBlock = createBlockRecursive(workspace, nestedBlockConfig, false, errors);
                if (nestedBlock) {
                  const conn = nestedBlock.outputConnection || nestedBlock.previousConnection;
                  if (conn) {
                    input.connection.connect(conn);
                  }
                  
                  // 如果嵌套块有临时ID，也保存到映射
                  if (nestedBlockConfig.id) {
                    blockMap.set(nestedBlockConfig.id, nestedBlock);
                    // 注册到全局映射（支持跨调用引用）
                    registerBlockIdMapping(nestedBlockConfig.id, nestedBlock.id);
                  }
                }
                if (errors.length > 0) {
                  fieldErrors.push(...errors);
                }
              } else if (inputConfig.blockRef) {
                // 引用其他已创建的块（稍后处理）
                // 这里先记录，在连接阶段处理
              }
            } catch (e) {
              console.warn(`输入 ${inputName} 设置失败: ${(e as Error).message}`);
            }
          }
        }
        
        // 保存到映射
        blockMap.set(blockConfig.id, block);
        // 注册到全局映射（支持跨调用引用）
        registerBlockIdMapping(blockConfig.id, block.id);
        
        // 如果有字段错误，标记为部分成功
        if (fieldErrors.length > 0) {
          createResults.push({
            tempId: blockConfig.id,
            realId: block.id,
            type: blockConfig.type,
            success: false,
            message: fieldErrors.join('; ')
          });
        } else {
          createResults.push({
            tempId: blockConfig.id,
            realId: block.id,
            type: blockConfig.type,
            success: true
          });
        }
        
      } catch (e) {
        createResults.push({
          tempId: blockConfig.id,
          realId: '',
          type: blockConfig.type,
          success: false,
          message: (e as Error).message
        });
      }
    }
    
    // 2. 处理 inputs 中的 blockRef（需要在所有块创建后）
    for (const blockConfig of blocks) {
      if (!blockConfig.inputs) continue;
      
      const block = blockMap.get(blockConfig.id);
      if (!block) continue;
      
      for (const [inputName, inputConfig] of Object.entries(blockConfig.inputs)) {
        if (!inputConfig.blockRef) continue;
        
        const input = block.getInput(inputName);
        if (!input || !input.connection) continue;
        
        // 查找引用的块（优先本批次，其次全局映射）
        let refBlock = blockMap.get(inputConfig.blockRef);
        if (!refBlock) {
          // 使用全局映射解析（支持跨调用引用）
          refBlock = resolveBlockId(workspace, inputConfig.blockRef);
        }
        
        if (refBlock) {
          const conn = refBlock.outputConnection || refBlock.previousConnection;
          if (conn) {
            try {
              input.connection.connect(conn);
            } catch (e) {
              console.warn(`blockRef 连接失败: ${inputConfig.blockRef} → ${inputName}`);
            }
          }
        }
      }
    }
    
    // 3. 处理连接规则
    // 跟踪已经被连接过的块，用于自动克隆
    const connectedBlocks = new Set<string>();  // 存储已连接块的临时ID或真实ID
    const clonedBlocksInfo: Array<{originalId: string, clonedId: string, type: string, reason: string}> = [];
    
    for (const rule of connections) {
      try {
        // 查找块（优先本批次映射，其次全局映射/工作区查找，最后按类型匹配）
        let sourceBlock = blockMap.get(rule.block);
        if (!sourceBlock) {
          // 使用全局映射解析（支持跨调用引用）
          sourceBlock = resolveBlockId(workspace, rule.block);
        }
        
        let targetBlock = blockMap.get(rule.target);
        if (!targetBlock) {
          // 使用全局映射解析（支持跨调用引用）
          targetBlock = resolveBlockId(workspace, rule.target);
        }
        
        if (!sourceBlock) {
          connectionResults.push({
            rule,
            success: false,
            message: `找不到源块: ${rule.block}`
          });
          continue;
        }
        
        if (!targetBlock) {
          // 提供更详细的错误信息，包括全局映射信息
          const mappings = getBlockIdMappings();
          const mappingInfo = Object.keys(mappings).length > 0 
            ? `已知映射: ${Object.entries(mappings).slice(0, 5).map(([k, v]) => `${k}→${v.substring(0, 8)}...`).join(', ')}`
            : '无已知映射';
          const availableBlocks = workspace.getAllBlocks()?.slice(0, 10).map((b: any) => `${b.type}(${b.id.substring(0, 8)}...)`).join(', ') || '无';
          connectionResults.push({
            rule,
            success: false,
            message: `找不到目标块: ${rule.target}。${mappingInfo}。可用块: ${availableBlocks}`
          });
          continue;
        }
        
        // 检查源块是否已经被连接过（自动克隆逻辑）
        const sourceBlockKey = rule.block;  // 使用临时ID作为key
        let wasCloned = false;
        
        if (connectedBlocks.has(sourceBlockKey)) {
          // 源块已被连接过，需要克隆一个新块
          const originalBlock = sourceBlock;
          const originalConfig = blocks.find(b => b.id === rule.block);
          
          if (originalConfig) {
            try {
              // 创建克隆块
              const clonedBlock = workspace.newBlock(originalBlock.type);
              clonedBlock.initSvg();
              
              // 复制字段值
              if (originalConfig.fields) {
                for (const [fieldName, fieldValue] of Object.entries(originalConfig.fields)) {
                  const field = clonedBlock.getField(fieldName);
                  if (field) {
                    if (field.constructor.name === 'FieldVariable') {
                      const varName = typeof fieldValue === 'object' ? ((fieldValue as any).name || String(fieldValue)) : String(fieldValue);
                      const varType = typeof fieldValue === 'object' ? ((fieldValue as any).type || '') : '';
                      let variable = workspace.getVariable(varName, varType);
                      if (!variable) {
                        variable = workspace.createVariable(varName, varType);
                      }
                      if (variable) {
                        field.setValue(variable.getId());
                      }
                    } else {
                      field.setValue(fieldValue);
                    }
                  }
                }
              }
              
              // 复制 inputs 中的 shadow 块
              if (originalConfig.inputs) {
                for (const [inputName, inputConfig] of Object.entries(originalConfig.inputs)) {
                  const input = clonedBlock.getInput(inputName);
                  if (!input || !input.connection) continue;
                  
                  if (inputConfig.shadow) {
                    const shadowConfig = inputConfig.shadow;
                    if (Blockly.Blocks[shadowConfig.type]) {
                      const shadowBlock = workspace.newBlock(shadowConfig.type);
                      shadowBlock.initSvg();
                      
                      // 先设置 shadow 并连接
                      const conn = shadowBlock.outputConnection || shadowBlock.previousConnection;
                      if (conn) {
                        shadowBlock.setShadow(true);
                        input.connection.connect(conn);
                      }
                      
                      // 连接后设置字段值
                      if (shadowConfig.fields) {
                        for (const [fn, fv] of Object.entries(shadowConfig.fields)) {
                          const sf = shadowBlock.getField(fn);
                          if (sf) sf.setValue(fv);
                        }
                      }
                      
                      // 最后渲染
                      shadowBlock.render();
                    }
                  }
                }
              }
              
              clonedBlock.render();
              sourceBlock = clonedBlock;
              wasCloned = true;
              
              clonedBlocksInfo.push({
                originalId: rule.block,
                clonedId: clonedBlock.id,
                type: clonedBlock.type,
                reason: `块 ${rule.block} 已被连接，自动克隆`
              });
              
            } catch (e) {
              connectionResults.push({
                rule,
                success: false,
                message: `块 ${rule.block} 已被连接，克隆失败: ${(e as Error).message}`
              });
              continue;
            }
          } else {
            connectionResults.push({
              rule,
              success: false,
              message: `块 ${rule.block} 已被连接到其他位置，无法再次使用（未找到原始配置无法克隆）`
            });
            continue;
          }
        }
        
        // 执行连接
        let success = false;
        let message = '';
        
        switch (rule.action) {
          case 'put_into': {
            // 放入语句输入
            if (!sourceBlock.previousConnection) {
              // 检查是否是值块（有outputConnection）
              const isValueBlock = !!sourceBlock.outputConnection;
              if (isValueBlock) {
                message = `${sourceBlock.type} 是值块（返回值的表达式），不能用 put_into 放入语句容器。应该用 set_value 连接到其他块的值输入中`;
              } else {
                message = `${sourceBlock.type} 不能放入容器（无 previousConnection）`;
              }
              break;
            }
            
            // 检测输入名
            let inputName = rule.input;
            if (!inputName) {
              inputName = detectStatementInput(targetBlock);
            }
            
            if (!inputName) {
              message = `${targetBlock.type} 没有语句输入`;
              break;
            }
            
            const stmtInput = targetBlock.getInput(inputName);
            if (!stmtInput || !stmtInput.connection) {
              message = `找不到输入: ${inputName}`;
              break;
            }
            
            // 如果已有块，插入到最前面，原有块接到源块后面
            const existingBlock = stmtInput.connection.targetBlock();
            if (existingBlock) {
              // 断开原有块
              stmtInput.connection.disconnect();
              // 将源块连接到容器
              stmtInput.connection.connect(sourceBlock.previousConnection);
              success = stmtInput.connection.targetBlock() === sourceBlock;
              
              if (success) {
                // 找到源块链的末尾，将原有块接到后面
                let lastInSourceChain = sourceBlock;
                while (lastInSourceChain.nextConnection?.targetBlock()) {
                  lastInSourceChain = lastInSourceChain.nextConnection.targetBlock();
                }
                if (lastInSourceChain.nextConnection && existingBlock.previousConnection) {
                  lastInSourceChain.nextConnection.connect(existingBlock.previousConnection);
                }
              } else {
                // 连接失败，尝试恢复
                try {
                  stmtInput.connection.connect(existingBlock.previousConnection);
                } catch (e) {}
                message = '插入到最前面失败';
              }
            } else {
              stmtInput.connection.connect(sourceBlock.previousConnection);
              success = stmtInput.connection.targetBlock() === sourceBlock;
              if (!success) message = '连接未生效';
            }
            break;
          }
          
          case 'chain_after': {
            // 链接到块后面
            if (!sourceBlock.previousConnection) {
              const isValueBlock = !!sourceBlock.outputConnection;
              if (isValueBlock) {
                message = `${sourceBlock.type} 是值块，不能用 chain_after 链接。应该用 set_value 连接到其他块的值输入中`;
              } else {
                message = `${sourceBlock.type} 不能链接（无 previousConnection）`;
              }
              break;
            }
            if (!targetBlock.nextConnection) {
              const isValueBlock = !!targetBlock.outputConnection;
              if (isValueBlock) {
                message = `${targetBlock.type} 是值块，不能被 chain_after 链接。值块应该放在其他块的值输入中`;
              } else {
                message = `${targetBlock.type} 不能被链接（无 nextConnection）`;
              }
              break;
            }
            
            // 处理现有的下一个块
            const existingNext = targetBlock.nextConnection.targetBlock();
            if (existingNext) {
              targetBlock.nextConnection.disconnect();
              targetBlock.nextConnection.connect(sourceBlock.previousConnection);
              // 将原来的块连接到新块后面
              if (sourceBlock.nextConnection && existingNext.previousConnection) {
                sourceBlock.nextConnection.connect(existingNext.previousConnection);
              }
            } else {
              targetBlock.nextConnection.connect(sourceBlock.previousConnection);
            }
            
            success = targetBlock.nextConnection.targetBlock() === sourceBlock;
            if (!success) message = '连接未生效';
            break;
          }
          
          case 'set_as_input': {
            // 设为值输入
            if (!sourceBlock.outputConnection) {
              message = `${sourceBlock.type} 不能作为值（无 outputConnection）`;
              break;
            }
            
            // 检测输入名
            let inputName = rule.input;
            if (!inputName) {
              inputName = detectValueInput(targetBlock);
            }
            
            if (!inputName) {
              message = `${targetBlock.type} 没有可用的值输入`;
              break;
            }
            
            const valueInput = targetBlock.getInput(inputName);
            if (!valueInput || !valueInput.connection) {
              message = `找不到输入: ${inputName}`;
              break;
            }
            
            valueInput.connection.connect(sourceBlock.outputConnection);
            success = valueInput.connection.targetBlock() === sourceBlock;
            if (!success) message = '连接未生效';
            break;
          }
        }
        
        // 记录已连接的块（用于后续自动克隆判断）
        if (success) {
          connectedBlocks.add(sourceBlockKey);
        }
        
        // 记录结果（包含克隆信息）
        const resultMessage = wasCloned 
          ? `${message || '成功'}（自动克隆了新块 ${sourceBlock.id.substring(0, 8)}...）`
          : message;
        connectionResults.push({ rule, success, message: resultMessage });
        
      } catch (e) {
        connectionResults.push({
          rule,
          success: false,
          message: (e as Error).message
        });
      }
    }
    
    // 4. 生成结果摘要
    const successBlocks = createResults.filter(r => r.success);
    const failedBlocks = createResults.filter(r => !r.success);
    const successConns = connectionResults.filter(r => r.success);
    const failedConns = connectionResults.filter(r => !r.success);
    
    const hasErrors = failedBlocks.length > 0 || failedConns.length > 0;
    
    // 构建 ID 映射表（临时ID → 真实ID）
    const idMapping: Record<string, string> = {};
    for (const result of successBlocks) {
      idMapping[result.tempId] = result.realId;
    }
    
    // 生成摘要文本
    let content = `📦 批量创建完成:\n`;
    content += `✅ 成功创建 ${successBlocks.length}/${blocks.length} 个块\n`;
    content += `✅ 成功建立 ${successConns.length}/${connections.length} 个连接\n`;
    
    // 显示自动克隆信息
    if (clonedBlocksInfo.length > 0) {
      content += `\n🔄 自动克隆的块 (${clonedBlocksInfo.length} 个):\n`;
      for (const ci of clonedBlocksInfo) {
        content += `  - ${ci.originalId} → 新块 ${ci.clonedId.substring(0, 8)}... (${ci.type})\n`;
      }
    }
    
    if (failedBlocks.length > 0) {
      content += `\n❌ 创建失败的块:\n`;
      for (const fb of failedBlocks) {
        content += `  - ${fb.tempId} (${fb.type}): ${fb.message}\n`;
      }
    }
    
    if (failedConns.length > 0) {
      content += `\n❌ 连接失败:\n`;
      for (const fc of failedConns) {
        content += `  - ${fc.rule.block} → ${fc.rule.target}: ${fc.message}\n`;
      }
    }
    
    content += `\n🗺️ ID映射表:\n`;
    for (const [tempId, realId] of Object.entries(idMapping)) {
      const blockType = createResults.find(r => r.tempId === tempId)?.type || '';
      content += `  ${tempId} → ${realId} (${blockType})\n`;
    }
    
    const baseResult: ToolUseResult = {
      is_error: hasErrors,
      content,
      metadata: {
        totalBlocks: blocks.length,
        successBlocks: successBlocks.length,
        totalConnections: connections.length,
        successConnections: successConns.length,
        clonedBlocks: clonedBlocksInfo.length,
        idMapping,
        createResults,
        connectionResults,
        clonedBlocksInfo: clonedBlocksInfo.length > 0 ? clonedBlocksInfo : undefined,
        failedBlocks: failedBlocks.length > 0 ? failedBlocks : undefined,
        failedConnections: failedConns.length > 0 ? failedConns : undefined
      }
    };
    
    // 批量创建完成后总是获取工作区概览（强制获取）
    const resultWithOverview = await maybeAppendWorkspaceOverview(baseResult, true);
    return injectTodoReminder(resultWithOverview, 'batchCreateBlocksTool');
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 批量创建失败: ${(error as Error).message}`
    }, 'batchCreateBlocksTool');
  }
}

// =============================================================================
// 工具 6：获取工作区块列表
// =============================================================================

/**
 * 获取工作区当前的块列表
 */
export async function getWorkspaceBlocksTool(): Promise<ToolUseResult> {
  try {
    const workspace = getActiveWorkspace();
    const allBlocks = workspace.getAllBlocks() || [];
    
    // 分类统计
    const rootBlocks = allBlocks.filter((b: any) => !b.getParent());
    const orphanBlocks = allBlocks.filter((b: any) => {
      const hasParent = b.getParent();
      const hasChildren = b.getChildren?.().length > 0;
      const hasNext = b.nextConnection?.targetBlock();
      return !hasParent && !hasChildren && !hasNext;
    });
    
    // 按类型分组
    const blocksByType: Record<string, number> = {};
    for (const block of allBlocks) {
      blocksByType[block.type] = (blocksByType[block.type] || 0) + 1;
    }
    
    // 详细的块列表
    const blockList = allBlocks.map((b: any) => {
      const info = getBlockInfo(b);
      return {
        id: b.id,
        type: b.type,
        isRoot: !b.getParent(),
        hasChildren: (b.getChildren?.() || []).length > 0,
        emptyInputs: info.inputs.filter(i => !i.connected).map(i => i.name)
      };
    });
    
    // 生成摘要
    const summary = [
      `📊 工作区块统计:`,
      `- 总块数: ${allBlocks.length}`,
      `- 根块数: ${rootBlocks.length}`,
      `- 孤立块数: ${orphanBlocks.length}`,
      ``,
      `📋 块列表:`
    ];
    
    for (const block of blockList.slice(0, 20)) {
      const prefix = block.isRoot ? '🏠' : '  └';
      const emptyInfo = block.emptyInputs.length > 0 ? ` [空输入: ${block.emptyInputs.join(',')}]` : '';
      summary.push(`${prefix} ${block.type} (${block.id})${emptyInfo}`);
    }
    
    if (blockList.length > 20) {
      summary.push(`... 还有 ${blockList.length - 20} 个块`);
    }
    
    return injectTodoReminder({
      is_error: false,
      content: summary.join('\n'),
      metadata: {
        totalBlocks: allBlocks.length,
        rootBlocks: rootBlocks.length,
        orphanBlocks: orphanBlocks.length,
        blocksByType,
        blocks: blockList
      }
    }, 'getWorkspaceBlocksTool');
    
  } catch (error) {
    return injectTodoReminder({
      is_error: true,
      content: `❌ 获取块列表失败: ${(error as Error).message}`
    }, 'getWorkspaceBlocksTool');
  }
}

// =============================================================================
// 工具定义（用于注册到工具系统）
// =============================================================================

export const ATOMIC_BLOCK_TOOLS = [
  {
    name: "create_single_block",
    description: `【原子化工具-推荐】创建单个 Blockly 块，支持 inputs（一层 shadow 块）、动态块配置和创建时直接连接。

**核心特点**：
- ✅ 支持 inputs 中的简单 shadow 块（避免多步创建）
- ✅ 支持 extraState 配置动态块（如 text_join, lists_create_with, controls_if）
- ✅ 智能推断 extraState（根据 inputs 自动计算）
- ✅ 支持创建时直接连接（可选 connect 参数）
- ✅ 返回块 ID，后续可用 connect_blocks_simple 连接

**创建并直接连接示例**：
\`\`\`json
// 创建 serial_begin 并直接放入 arduino_setup
{
  "type": "serial_begin",
  "fields": {"SERIAL": "Serial", "SPEED": "9600"},
  "connect": {"action": "put_into", "target": "arduino_setup"}
}

// 创建 math_number 并设为 delay 的 TIME 输入
{
  "type": "math_number",
  "fields": {"NUM": 1000},
  "connect": {"action": "set_as_input", "target": "delay_id", "input": "TIME"}
}
\`\`\`

**text_join 示例**（动态输入块，3个文本拼接）：
\`\`\`json
{
  "type": "text_join",
  "extraState": {"itemCount": 3},
  "inputs": {
    "ADD0": {"shadow": {"type": "text", "fields": {"TEXT": "humi"}}},
    "ADD1": {"shadow": {"type": "text", "fields": {"TEXT": "temp"}}},
    "ADD2": {"shadow": {"type": "text", "fields": {"TEXT": "测量"}}}
  }
}
\`\`\`
**注意**: text_join 默认只有2个输入(ADD0, ADD1)，需要通过 extraState.itemCount 指定输入数量！

**lists_create_with 示例**（创建列表，4个元素）：
\`\`\`json
{
  "type": "lists_create_with",
  "extraState": {"itemCount": 4},
  "inputs": {
    "ADD0": {"shadow": {"type": "math_number", "fields": {"NUM": 1}}},
    "ADD1": {"shadow": {"type": "math_number", "fields": {"NUM": 2}}},
    "ADD2": {"shadow": {"type": "math_number", "fields": {"NUM": 3}}},
    "ADD3": {"shadow": {"type": "math_number", "fields": {"NUM": 4}}}
  }
}
\`\`\`

**controls_if 示例**（带 else if 和 else）：
\`\`\`json
{
  "type": "controls_if",
  "extraState": {"elseIfCount": 1, "hasElse": true}
}
\`\`\`

**io_digitalwrite 示例**（一步创建完整块）：
\`\`\`json
{
  "type": "io_digitalwrite",
  "inputs": {
    "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
    "STATE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
  }
}
\`\`\`

**serial_begin 示例**（无 inputs，只有 fields）：
\`\`\`json
{
  "type": "serial_begin",
  "fields": {"SERIAL": "Serial", "SPEED": "9600"}
}
\`\`\`

**使用场景**：
- 创建动态输入块（text_join, lists_create_with）
- 创建条件块（controls_if 带多个 else if）
- 创建有多个输入的块（如 io_digitalwrite, io_pinmode）
- 创建简单块（如 serial_begin, math_number）`,
    input_schema: {
      type: 'object',
      properties: {
        type: { 
          type: 'string', 
          description: '块类型，如 serial_begin, io_digitalwrite, text_join 等' 
        },
        fields: { 
          type: 'object', 
          description: '块字段值，如 {SERIAL: "Serial", SPEED: "9600"}' 
        },
        inputs: {
          type: 'object',
          description: '块输入配置。每个输入可以是: {"shadow": {"type": "块类型", "fields": {...}}} 或 {"blockId": "已存在的块ID"}',
          additionalProperties: {
            type: 'object',
            properties: {
              shadow: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'shadow块类型' },
                  fields: { type: 'object', description: 'shadow块字段' }
                },
                required: ['type']
              },
              blockId: { type: 'string', description: '已存在的块ID' }
            }
          }
        },
        extraState: {
          type: 'object',
          description: '动态块的额外状态配置。text_join/lists_create_with 用 {itemCount: N}; controls_if 用 {elseIfCount: N, hasElse: true}',
          properties: {
            itemCount: { type: 'number', description: 'text_join/lists_create_with 的输入数量' },
            elseIfCount: { type: 'number', description: 'controls_if 的 else if 分支数量' },
            hasElse: { type: 'boolean', description: 'controls_if 是否有 else 分支' }
          }
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X坐标' },
            y: { type: 'number', description: 'Y坐标' }
          },
          description: '可选，块的位置'
        },
        connect: {
          type: 'object',
          description: '可选，创建后立即连接到目标块（参考 connect_blocks_simple）',
          properties: {
            action: {
              type: 'string',
              enum: ['put_into', 'chain_after', 'set_as_input'],
              description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
            },
            target: {
              type: 'string',
              description: '目标块 ID 或类型名（如 "arduino_setup", "arduino_loop"）'
            },
            input: {
              type: 'string',
              description: '目标输入名（可选，会自动检测）'
            },
            moveWithChain: {
              type: 'boolean',
              description: '是否将块后面连接的块一起移动（默认 false）',
              default: false
            }
          },
          required: ['action', 'target']
        }
      },
      required: ['type']
    }
  },
  
  {
    name: "connect_blocks_simple",
    description: `【原子化工具-推荐】连接两个 Blockly 块，使用直观的语义。

**连接动作**：
| action | 说明 | 适用块类型 |
|--------|------|-----------|
| put_into | 放入容器的语句输入 | 语句块 → 容器块 |
| chain_after | 链接到块后面 | 语句块 → 语句块 |
| set_as_input | 设为值输入 | 值块 → 任意块 |

**moveWithChain 选项**：
- true（默认）：移动块时，将其后面连接的所有块一起移动
- false：只移动单个块，原来连接在其后面的块会保持在原位置

**示例**：
\`\`\`json
// 将 serial_begin 放入 arduino_setup
{"block": "serial_begin_id", "action": "put_into", "target": "arduino_setup_id"}

// 将 delay 链接到 serial_println 后面
{"block": "delay_id", "action": "chain_after", "target": "serial_println_id"}

// 将 math_number 设为 delay 的 TIME 输入
{"block": "math_number_id", "action": "set_as_input", "target": "delay_id", "input": "TIME"}

// 只移动单个块（不带后面连接的块）
{"block": "some_block_id", "action": "chain_after", "target": "target_id", "moveWithChain": false}
\`\`\`

**与 connect_blocks_tool 的区别**：
- 语义更清晰：put_into/chain_after/set_as_input
- 自动检测输入名（input 参数可选）
- 支持 moveWithChain 选项控制是否移动整个块链
- 更详细的错误提示`,
    input_schema: {
      type: 'object',
      properties: {
        block: { 
          type: 'string', 
          description: '要操作的块 ID（来自 create_single_block 的返回值）' 
        },
        action: {
          type: 'string',
          enum: ['put_into', 'chain_after', 'set_as_input'],
          description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
        },
        target: { 
          type: 'string', 
          description: '目标块 ID' 
        },
        input: { 
          type: 'string', 
          description: '目标输入名（可选，会自动检测）' 
        },
        moveWithChain: {
          type: 'boolean',
          description: '是否将块后面连接的块一起移动（默认 true）。设为 false 时只移动单个块'
        }
      },
      required: ['block', 'action', 'target']
    }
  },
  
  {
    name: "set_block_field",
    description: `【原子化工具】设置块的字段值。用于修改已创建块的字段。

**示例**：
\`\`\`json
{"blockId": "abc123", "fieldName": "SPEED", "value": "115200"}
{"blockId": "abc123", "fieldName": "VAR", "value": {"name": "myVar", "type": "DHT"}}
\`\`\``,
    input_schema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '块 ID' },
        fieldName: { type: 'string', description: '字段名' },
        value: { description: '字段值（字符串、数字或变量对象）' }
      },
      required: ['blockId', 'fieldName', 'value']
    }
  },
  
  {
    name: "set_block_input",
    description: `【原子化工具】将一个块连接到另一个块的指定输入。

**与 connect_blocks_simple 的区别**：
- 更精确：必须指定输入名
- 适用于需要精确控制连接位置的场景

**示例**：
\`\`\`json
{"blockId": "if_block_id", "inputName": "IF0", "sourceBlockId": "condition_block_id"}
\`\`\``,
    input_schema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '目标块 ID' },
        inputName: { type: 'string', description: '输入名称' },
        sourceBlockId: { type: 'string', description: '要连接的块 ID' }
      },
      required: ['blockId', 'inputName', 'sourceBlockId']
    }
  },
  
  {
    name: "get_workspace_blocks",
    description: `【原子化工具】获取工作区当前的所有块列表。

**用途**：
- 查看已创建的块和它们的 ID
- 检查哪些块有空输入需要填充
- 分析块之间的连接关系

**返回信息**：
- 每个块的 ID、类型、是否为根块
- 空输入列表（提示需要连接）
- 块按类型分组统计`,
    input_schema: {
      type: 'object',
      properties: {}
    }
  },

  {
    name: "batch_create_blocks",
    description: `【高效批量工具-强烈推荐】一次调用创建多个块并建立连接，大幅提高效率！

**核心优势**：
- ⚡ 一次调用完成整个代码结构（vs 原子工具需要多次调用）
- 📋 扁平化结构：blocks 数组 + connections 数组（避免深层嵌套）
- 🔗 使用临时ID（如 "b1", "b2"）引用块，连接时自动解析
- 📊 详细的执行报告和ID映射
- ✅ 智能推断 extraState（根据 inputs 自动计算动态输入数量）

**适用场景**：
- 创建完整的传感器读取+处理+输出结构
- 创建 if-else 条件判断结构
- 创建循环结构
- 创建动态输入块（text_join, lists_create_with）
- 任何需要多个块+连接的场景

**text_join 文本拼接示例**（3个文本）：
\`\`\`json
{
  "blocks": [
    {"id": "b1", "type": "text_join", "extraState": {"itemCount": 3}, "inputs": {
      "ADD0": {"shadow": {"type": "text", "fields": {"TEXT": "humi"}}},
      "ADD1": {"shadow": {"type": "text", "fields": {"TEXT": "temp"}}},
      "ADD2": {"shadow": {"type": "text", "fields": {"TEXT": "测量"}}}
    }}
  ],
  "connections": []
}
\`\`\`
**注意**: text_join 默认只有2个输入，需要 extraState.itemCount 指定数量！

**DHT温度读取+LED控制 完整示例**：
\`\`\`json
{
  "blocks": [
    {"id": "b1", "type": "dht_init", "fields": {"VAR": {"name": "dht", "type": "DHT"}, "TYPE": "DHT22", "PIN": "2"}},
    {"id": "b2", "type": "dht_read_temperature", "fields": {"VAR": {"name": "dht", "type": "DHT"}}},
    {"id": "b3", "type": "controls_if", "extraState": {"hasElse": true}},
    {"id": "b4", "type": "logic_compare", "fields": {"OP": "GT"}},
    {"id": "b5", "type": "math_number", "fields": {"NUM": 30}},
    {"id": "b6", "type": "io_digitalwrite", "inputs": {
      "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
      "STATE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
    }},
    {"id": "b7", "type": "io_digitalwrite", "inputs": {
      "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
      "STATE": {"shadow": {"type": "io_state", "fields": {"STATE": "LOW"}}}
    }}
  ],
  "connections": [
    {"block": "b1", "action": "put_into", "target": "arduino_setup"},
    {"block": "b2", "action": "put_into", "target": "arduino_loop"},
    {"block": "b3", "action": "chain_after", "target": "b2"},
    {"block": "b4", "action": "set_as_input", "target": "b3", "input": "IF0"},
    {"block": "b2", "action": "set_as_input", "target": "b4", "input": "A"},
    {"block": "b5", "action": "set_as_input", "target": "b4", "input": "B"},
    {"block": "b6", "action": "put_into", "target": "b3", "input": "DO0"},
    {"block": "b7", "action": "put_into", "target": "b3", "input": "ELSE"}
  ]
}
\`\`\`

**连接动作说明**：
| action | 说明 | 适用块类型 |
|--------|------|-----------|
| put_into | 放入容器的语句输入 | 语句块 → 容器块 |
| chain_after | 链接到块后面 | 语句块 → 语句块 |
| set_as_input | 设为值输入 | 值块 → 任意块 |

**动态块 extraState 配置**：
| 块类型 | extraState | 说明 |
|--------|------------|------|
| text_join | {"itemCount": N} | 文本拼接输入数量 |
| lists_create_with | {"itemCount": N} | 列表元素数量 |
| controls_if | {"elseIfCount": N, "hasElse": true} | else if 和 else 分支 |

**注意事项**：
- blocks 中的 id 是临时ID，用于 connections 中引用
- connections 中的 target 可以是临时ID（新块）或真实ID（已存在的块如 arduino_setup）
- inputs 中可使用 blockRef 引用其他新建块
- extraState 用于动态块配置，也可省略让系统从 inputs 自动推断`,
    input_schema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          description: '要创建的块列表（扁平化数组）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '临时ID，用于 connections 中引用（如 "b1", "b2"）' },
              type: { type: 'string', description: '块类型（如 "dht_init", "controls_if"）' },
              fields: { type: 'object', description: '块字段值' },
              inputs: { 
                type: 'object', 
                description: '输入配置，支持 shadow 块或 blockRef 引用'
              },
              extraState: { type: 'object', description: '动态块的额外状态（如 controls_if 的 {hasElse: true}）' }
            },
            required: ['id', 'type']
          }
        },
        connections: {
          type: 'array',
          description: '连接规则列表',
          items: {
            type: 'object',
            properties: {
              block: { type: 'string', description: '要操作的块（临时ID）' },
              action: { 
                type: 'string', 
                enum: ['put_into', 'chain_after', 'set_as_input'],
                description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值'
              },
              target: { type: 'string', description: '目标块（临时ID 或 已存在块的真实ID）' },
              input: { type: 'string', description: '目标输入名（可选，会自动检测）' }
            },
            required: ['block', 'action', 'target']
          }
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' }
          },
          description: '起始位置（可选）'
        }
      },
      required: ['blocks', 'connections']
    }
  }
];
