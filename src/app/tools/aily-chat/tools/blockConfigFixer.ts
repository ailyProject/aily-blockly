/**
 * Blockly 块配置修复管道
 * 
 * 统一的修复入口，分两个阶段处理：
 * 1. JSON 语法修复 - 处理缺失括号、引号等语法问题
 * 2. 结构语义修复 - 处理 jsonrepair 导致的错误嵌套问题
 * 
 * 典型问题场景：
 * 错误 JSON: {"type":"controls_if","inputs":{"IF0":{"block":{...},"DO0":{...}}
 * jsonrepair 会在末尾补 }}}，导致 DO0 被错误嵌套在 IF0 内部
 * 本模块的结构修复会将 DO0 提升到正确的层级
 */

import { fixJsonString as baseFixJsonString } from './editBlockTool';

declare const Blockly: any;

// =============================================================================
// 类型定义
// =============================================================================

export interface BlockConfigFixOptions {
  /** 是否启用 JSON 语法修复（默认 true） */
  enableJsonFix?: boolean;
  /** 是否启用结构语义修复（默认 true） */
  enableStructureFix?: boolean;
  /** 是否输出详细日志（默认 false） */
  logProcess?: boolean;
  /** Blockly 工作区（用于动态检测块输入信息） */
  workspace?: any;
  /** 已知的块类型（用于裸 inputs 格式修复时直接使用，而不需要推断） */
  knownBlockType?: string;
}

export interface BlockConfigFixResult {
  /** 修复后的配置对象 */
  fixed: any;
  /** 是否进行了修复 */
  wasFixed: boolean;
  /** 修复阶段详情 */
  stages: {
    jsonRepair: {
      applied: boolean;
      changes: string[];
      error?: string;
    };
    structureFix: {
      applied: boolean;
      changes: string[];
    };
  };
  /** 原始输入（用于调试） */
  originalInput?: string | object;
}

// =============================================================================
// 块输入信息缓存（用于动态检测）
// =============================================================================

const blockInputInfoCache = new Map<string, {
  statementInputs: string[];
  valueInputs: string[];
  dummyInputs: string[];
}>();

/**
 * 清除块输入信息缓存
 */
export function clearBlockInputInfoCache(): void {
  blockInputInfoCache.clear();
}

/**
 * 动态获取块的输入信息
 * 通过创建临时块来检测其所有输入的类型
 */
function getBlockInputInfo(workspace: any, blockType: string): {
  statementInputs: string[];
  valueInputs: string[];
  dummyInputs: string[];
} | null {
  if (!workspace || !blockType) return null;
  
  // 检查缓存
  const cached = blockInputInfoCache.get(blockType);
  if (cached) return cached;
  
  try {
    const tempBlock = workspace.newBlock(blockType);
    if (!tempBlock) return null;
    
    const statementInputs: string[] = [];
    const valueInputs: string[] = [];
    const dummyInputs: string[] = [];
    
    try {
      const inputList = tempBlock.inputList || [];
      for (const input of inputList) {
        const inputName = input.name;
        if (!inputName) continue;
        
        // Blockly.inputTypes: VALUE=1, STATEMENT=3, DUMMY=5
        if (input.type === 3 || input.type === Blockly?.inputTypes?.STATEMENT) {
          statementInputs.push(inputName);
        } else if (input.type === 1 || input.type === Blockly?.inputTypes?.VALUE) {
          valueInputs.push(inputName);
        } else {
          dummyInputs.push(inputName);
        }
      }
      
      const result = { statementInputs, valueInputs, dummyInputs };
      blockInputInfoCache.set(blockType, result);
      return result;
    } finally {
      // 清理临时块
      try {
        tempBlock.dispose(false);
      } catch (e) {
        // 忽略清理错误
      }
    }
  } catch (error) {
    console.warn(`[BlockConfigFixer] 获取块输入信息失败: ${blockType}`, error);
    return null;
  }
}

/**
 * 获取块类型的所有合法输入名（包括动态输入）
 * 
 * 对于动态块（如 controls_if），会根据已知模式生成可能的输入名
 * 
 * @param blockType 块类型
 * @param workspace Blockly 工作区（可选，用于动态检测）
 * @param existingInputKeys 现有的输入 keys（用于推断动态输入范围）
 * @returns 所有合法输入名的 Set
 */
function getValidInputsForBlockType(
  blockType: string,
  workspace?: any,
  existingInputKeys?: string[],
  extraState?: any
): Set<string> {
  const validInputs = new Set<string>();
  
  // 1. 从 workspace 动态获取基础输入
  if (workspace) {
    const inputInfo = getBlockInputInfo(workspace, blockType);
    if (inputInfo) {
      inputInfo.statementInputs.forEach(name => validInputs.add(name));
      inputInfo.valueInputs.forEach(name => validInputs.add(name));
      inputInfo.dummyInputs.forEach(name => validInputs.add(name));
    }

    // console.log(`[BlockConfigFixer] 动态检测 ${blockType} 输入: [${Array.from(validInputs).join(', ')}]`);
  }
  
  // 2. 🆕 通用动态输入模式 - 不再硬编码具体块类型
  // 这些模式可以匹配大多数 Blockly 动态块的输入命名规范
  const knownDynamicInputPatterns = [
    // controls_if / controls_ifelse 系列
    { pattern: /^IF(\d+)$/, base: 'IF' },
    { pattern: /^DO(\d+)$/, base: 'DO' },
    { pattern: /^ELSE$/, base: 'ELSE' },
    { pattern: /^ELSEIF(\d+)$/, base: 'ELSEIF' },
    // text_join / lists_create_with 系列
    { pattern: /^ADD(\d+)$/, base: 'ADD' },
    { pattern: /^ITEM(\d+)$/, base: 'ITEM' },
    // switch/case 系列
    { pattern: /^CASE(\d+)$/, base: 'CASE' },
    { pattern: /^DEFAULT$/, base: 'DEFAULT' },
    // 其他常见
    { pattern: /^SUBSTACK(\d*)$/, base: 'SUBSTACK' },
  ];
  
  // 3. 🆕 根据 extraState 智能推断动态输入
  if (extraState) {
    // controls_if 系列：根据 elseIfCount 和 hasElse 推断
    if (extraState.elseIfCount !== undefined || extraState.hasElse !== undefined) {
      const elseIfCount = extraState.elseIfCount || 0;
      const hasElse = extraState.hasElse || false;
      
      // IF0, DO0 总是存在
      validInputs.add('IF0');
      validInputs.add('DO0');
      
      // 根据 elseIfCount 添加 IF1..IFn, DO1..DOn
      for (let i = 1; i <= elseIfCount; i++) {
        validInputs.add(`IF${i}`);
        validInputs.add(`DO${i}`);
      }
      
      // 如果 hasElse，添加 ELSE
      if (hasElse) {
        validInputs.add('ELSE');
      }
      
      // console.log(`[BlockConfigFixer] 从 extraState 推断输入 (elseIfCount=${elseIfCount}, hasElse=${hasElse}): [${Array.from(validInputs).join(', ')}]`);
    }
    
    // text_join / lists_create_with 系列：根据 itemCount 推断
    if (extraState.itemCount !== undefined) {
      const itemCount = extraState.itemCount || 0;
      for (let i = 0; i < itemCount; i++) {
        validInputs.add(`ADD${i}`);
      }
      // console.log(`[BlockConfigFixer] 从 extraState 推断列表输入 (itemCount=${itemCount})`);
    }
  }
  
  // 4. 🆕 信任已存在的输入 - 如果一个 key 匹配已知模式且已经存在于 inputs 中
  // 这是最通用的方案：如果用户/LLM 已经创建了合法结构，我们应该信任它
  if (existingInputKeys) {
    for (const key of existingInputKeys) {
      // 检查是否匹配任何已知的动态输入模式
      const matchesKnownPattern = knownDynamicInputPatterns.some(({ pattern }) => pattern.test(key));
      
      if (matchesKnownPattern) {
        // 匹配已知模式，添加到有效输入
        validInputs.add(key);
        
        // 对于索引输入，确保所有更小索引的输入也被添加
        const indexMatch = key.match(/^([A-Z]+)(\d+)$/);
        if (indexMatch) {
          const base = indexMatch[1];
          const index = parseInt(indexMatch[2], 10);
          for (let i = 0; i <= index; i++) {
            validInputs.add(`${base}${i}`);
          }
        }
      }
    }
    // console.log(`[BlockConfigFixer] 从现有 keys 推断输入: [${existingInputKeys.filter(k => validInputs.has(k)).join(', ')}]`);
  }
  
  // 5. 添加常见的固定输入名（这些是非动态的，大多数块都可能有）
  const commonFixedInputs = ['VALUE', 'A', 'B', 'BOOL', 'NUM', 'TEXT', 'LIST', 'INDEX', 
                            'FROM', 'TO', 'BY', 'TIMES', 'PIN', 'STATE', 'DURATION',
                            'OPERAND', 'DIVISOR', 'STACK', 'CONDITION'];
  // 只添加已经存在于 existingInputKeys 中的常见输入
  if (existingInputKeys) {
    for (const input of commonFixedInputs) {
      if (existingInputKeys.includes(input)) {
        validInputs.add(input);
      }
    }
  }
  
  return validInputs;
}

/**
 * 检查一个 input key 是否是某个块类型的合法输入
 * 
 * @param inputKey 输入名
 * @param blockType 块类型
 * @param workspace Blockly 工作区
 * @param existingInputKeys 现有的输入 keys
 * @returns 是否是合法输入
 */
function isValidInputForBlockType(
  inputKey: string,
  blockType: string,
  workspace?: any,
  existingInputKeys?: string[]
): boolean {
  const validInputs = getValidInputsForBlockType(blockType, workspace, existingInputKeys);
  return validInputs.has(inputKey);
}

// =============================================================================
// 结构修复核心逻辑
// =============================================================================

/**
 * 判断一个 key 是否可能是被错误放置的输入名
 * 使用动态检测 + 结构分析 + 模式匹配
 * 
 * 重要：对于块顶层的属性，只有当该输入确实属于当前块类型时才判定为错位
 * 
 * 注意：对于动态块（如 controls_if），动态检测可能不准确（临时块没有 mutator 状态），
 * 所以对于已知的动态块输入模式，会使用模式匹配来覆盖动态检测结果。
 */
function isMisplacedInput(
  key: string, 
  value: any, 
  parentBlockType?: string, 
  workspace?: any,
  isTopLevel: boolean = false  // 新增：标识是否是块顶层检测
): boolean {
  // 'block' 和 'shadow' 是合法的属性，不是错位的输入
  if (key === 'block' || key === 'shadow') {
    return false;
  }
  
  // 已知的动态块类型（这些块的输入取决于 mutator/extraState，动态检测可能不准确）
  const dynamicBlockTypes = new Set([
    'controls_if', 'controls_ifelse', 
    'text_join', 'lists_create_with',
    'procedures_defnoreturn', 'procedures_defreturn',
    'procedures_callnoreturn', 'procedures_callreturn'
  ]);
  
  const isDynamicBlock = parentBlockType && dynamicBlockTypes.has(parentBlockType);
  
  // 方法1：动态检测 - 检查父块是否有这个输入名
  if (parentBlockType && workspace) {
    const inputInfo = getBlockInputInfo(workspace, parentBlockType);
    if (inputInfo) {
      const allInputNames = [
        ...inputInfo.statementInputs, 
        ...inputInfo.valueInputs,
        ...inputInfo.dummyInputs
      ];
      if (allInputNames.includes(key)) {
        // console.log(`[BlockConfigFixer] 动态检测: ${key} 是 ${parentBlockType} 的有效输入，判定为错位`);
        return true;
      }
      // 🔑 关键改进：对于动态块，即使动态检测失败也要继续检查模式匹配
      // 因为动态块的临时实例可能没有完整的输入列表
      if (isTopLevel && !isDynamicBlock) {
        // console.log(`[BlockConfigFixer] 动态检测: ${key} 不是 ${parentBlockType} 的有效输入，不判定为错位`);
        return false;
      }
    }
  }
  
  // 方法2：模式匹配 - 检测常见的动态块输入名模式
  // 这对于 controls_if 等动态块非常重要，因为其输入（DO0, IF1, ELSE等）是动态添加的
  // 同时需要匹配输入模式与块类型
  const dynamicInputPatternsWithBlockTypes: Array<{pattern: RegExp, blockTypes: string[]}> = [
    { pattern: /^IF\d+$/, blockTypes: ['controls_if', 'controls_ifelse'] },
    { pattern: /^DO\d+$/, blockTypes: ['controls_if', 'controls_ifelse'] },
    { pattern: /^ELSE$/, blockTypes: ['controls_if', 'controls_ifelse'] },  // ELSE 属于启用了 else 分支的 controls_if 和 controls_ifelse
    { pattern: /^ELSEIF\d+$/, blockTypes: ['controls_if', 'controls_ifelse'] },
    { pattern: /^ADD\d+$/, blockTypes: ['text_join', 'lists_create_with'] },
    { pattern: /^ITEM\d+$/, blockTypes: ['lists_create_with'] },
    { pattern: /^CASE\d+$/, blockTypes: ['controls_switch'] },
    { pattern: /^DEFAULT$/, blockTypes: ['controls_switch'] },
    // 比较和运算块的 A/B 输入
    { pattern: /^A$/, blockTypes: ['logic_compare', 'logic_operation', 'math_arithmetic', 'math_compare', 'text_compare'] },
    { pattern: /^B$/, blockTypes: ['logic_compare', 'logic_operation', 'math_arithmetic', 'math_compare', 'text_compare'] },
  ];
  
  // 通用输入模式（可能属于多种块类型）
  const genericInputPatterns = [
    /^STACK$/,           // STACK
    /^SUBSTACK\d*$/,     // SUBSTACK, SUBSTACK2
    /^VALUE$/,           // VALUE (常见值输入)
    /^A$/,               // A (logic_compare, math_arithmetic)
    /^B$/,               // B (logic_compare, math_arithmetic)
    /^BOOL$/,            // BOOL (logic_negate)
    /^NUM$/,             // NUM (math operations)
    /^TEXT$/,            // TEXT (text operations)
    /^LIST$/,            // LIST (list operations)
  ];
  
  // 辅助函数：检查值是否包含输入结构（直接或嵌套）
  const hasInputStructure = (val: any): boolean => {
    if (typeof val !== 'object' || val === null) return false;
    // 直接包含 block 或 shadow
    if ('block' in val || 'shadow' in val) return true;
    // 检查是否包含嵌套的输入（如 IF1 的值是 { DO1: {...} }）
    for (const [k, v] of Object.entries(val)) {
      if (typeof v === 'object' && v !== null) {
        // 如果 key 看起来像输入名且值包含 block/shadow 或嵌套结构
        if (/^(IF|DO|ELSE|ELSEIF|ADD|ITEM|CASE|DEFAULT|SUBSTACK)\d*$/.test(k)) {
          if ('block' in v || 'shadow' in v || hasInputStructure(v)) {
            return true;
          }
        }
      }
    }
    return false;
  };
  
  // 检查特定块类型的输入模式
  for (const {pattern, blockTypes} of dynamicInputPatternsWithBlockTypes) {
    if (pattern.test(key)) {
      // 🔑 关键改进：对于孤儿输入，即使值被清空也应该接受
      // 因为孤儿被提取后其嵌套内容会被单独处理
      const hasContent = hasInputStructure(value);
      const isEmptyOrphan = typeof value === 'object' && value !== null && Object.keys(value).length === 0;
      
      if (hasContent || isEmptyOrphan) {
        // 如果是顶层检测，需要验证块类型匹配
        if (isTopLevel && parentBlockType) {
          if (!blockTypes.includes(parentBlockType)) {
            // console.log(`[BlockConfigFixer] 模式匹配: ${key} 符合模式但不属于 ${parentBlockType}（期望 ${blockTypes.join('|')}），跳过`);
            return false;
          }
        }
        // console.log(`[BlockConfigFixer] 模式匹配: ${key} 符合已知输入模式（hasContent=${hasContent}, isEmptyOrphan=${isEmptyOrphan}），判定为错位输入`);
        return true;
      }
    }
  }
  
  // 检查通用输入模式（只在非顶层检测时使用，或者在有 workspace 验证时使用）
  if (!isTopLevel) {
    if (genericInputPatterns.some(pattern => pattern.test(key))) {
      if (hasInputStructure(value)) {
        // console.log(`[BlockConfigFixer] 通用模式匹配: ${key} 符合已知输入模式且包含输入结构，判定为错位输入`);
        return true;
      }
    }
  }
  
  // 方法3：结构分析 - 检查值的结构是否像输入配置
  // 这是最宽松的检测，作为兜底（但对顶层检测禁用，因为可能误判）
  if (!isTopLevel && typeof value === 'object' && value !== null) {
    if ('block' in value || 'shadow' in value) {
      // console.log(`[BlockConfigFixer] 结构分析: ${key} 的值包含 block/shadow，判定为错位输入`);
      return true;
    }
  }
  
  return false;
}

/**
 * 检查一个 key-value 对是否看起来像输入配置
 * 用于孤儿输入检测（不关心它属于哪个块类型）
 */
function looksLikeInput(key: string, value: any): boolean {
  // 1. 值必须是对象
  if (typeof value !== 'object' || value === null) {
    // console.log(`[BlockConfigFixer] looksLikeInput(${key}): 值不是对象，返回 false`);
    return false;
  }
  
  // 2. 值必须包含 block/shadow 或者包含嵌套的输入结构
  const hasDirectBlockOrShadow = 'block' in value || 'shadow' in value;
  
  // 检查是否包含嵌套的输入（如 IF1 的值是 { DO1: {...} }）
  const hasNestedInputStructure = (): boolean => {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'object' && v !== null) {
        // 如果 key 看起来像输入名且值包含 block/shadow 或嵌套结构
        if (/^(IF|DO|ELSE|ELSEIF|ADD|ITEM|CASE|DEFAULT|SUBSTACK)\d*$/.test(k)) {
          if ('block' in v || 'shadow' in v) {
            return true;
          }
          // 递归检查（但限制深度避免无限循环）
          for (const innerVal of Object.values(v as object)) {
            if (typeof innerVal === 'object' && innerVal !== null && ('block' in innerVal || 'shadow' in innerVal)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  
  if (!hasDirectBlockOrShadow && !hasNestedInputStructure()) {
    // console.log(`[BlockConfigFixer] looksLikeInput(${key}): 值不包含 block/shadow 也无嵌套输入结构，返回 false`);
    return false;
  }
  
  // 3. key 必须匹配常见的输入名模式
  const inputNamePatterns = [
    /^IF\d+$/,           // IF0, IF1... (controls_if)
    /^DO\d+$/,           // DO0, DO1... (controls_if)
    /^ELSE$/,            // ELSE (controls_ifelse)
    /^ELSEIF\d+$/,       // ELSEIF0, ELSEIF1...
    /^ADD\d+$/,          // ADD0, ADD1... (text_join)
    /^ITEM\d+$/,         // ITEM0, ITEM1... (lists)
    /^CASE\d+$/,         // CASE0, CASE1... (switch)
    /^DEFAULT$/,         // DEFAULT (switch)
    /^STACK$/,           // STACK
    /^SUBSTACK\d*$/,     // SUBSTACK, SUBSTACK2
    /^VALUE$/,           // VALUE
    /^A$/,               // A (logic_compare, math)
    /^B$/,               // B (logic_compare, math)
    /^BOOL$/,            // BOOL (logic_negate)
    /^NUM$/,             // NUM
    /^TEXT$/,            // TEXT
    /^LIST$/,            // LIST
    /^INDEX$/,           // INDEX
    /^FROM$/,            // FROM
    /^TO$/,              // TO
    /^BY$/,              // BY
    /^TIMES$/,           // TIMES (controls_repeat_ext)
    /^PIN$/,             // PIN (io blocks)
    /^DURATION$/,        // DURATION
    /^OPERAND$/,         // OPERAND
    /^DIVISOR$/,         // DIVISOR
  ];
  
  const result = inputNamePatterns.some(pattern => pattern.test(key));
  // console.log(`[BlockConfigFixer] looksLikeInput(${key}): 模式匹配结果 = ${result}`);
  return result;
}

/**
 * 递归提取输入配置中的所有嵌套错位输入
 * 
 * 例如 IF1 的值可能是：
 * {
 *   "block": {...},
 *   "DO1": {"block": {...}, "ELSE": {"block": {...}}}
 * }
 * 
 * 这个函数会：
 * 1. 清理 IF1，保留 block 和 shadow
 * 2. 提取 DO1 作为孤儿
 * 3. 递归处理 DO1，提取 ELSE 作为孤儿
 * 
 * 返回清理后的输入配置和所有提取出来的孤儿（已展平）
 */
function recursivelyExtractInputs(
  inputValue: any,
  parentBlockType: string,
  workspace?: any
): { cleaned: any; orphans: Array<[string, any]> } {
  if (!inputValue || typeof inputValue !== 'object') {
    return { cleaned: inputValue, orphans: [] };
  }
  
  const cleaned: Record<string, any> = {};
  const allOrphans: Array<[string, any]> = [];
  
  for (const [key, value] of Object.entries(inputValue)) {
    if (key === 'block') {
      // 递归修复嵌套的 block
      const nestedBlockFix = fixBlockRecursively(value, workspace);
      cleaned[key] = nestedBlockFix.fixed;
      // 收集来自嵌套块的孤儿
      if (nestedBlockFix.orphanInputs) {
        allOrphans.push(...nestedBlockFix.orphanInputs);
      }
    } else if (key === 'shadow') {
      cleaned[key] = value;
    } else if (looksLikeInput(key, value)) {
      // 递归提取这个嵌套的错位输入
      const nestedExtract = recursivelyExtractInputs(value, parentBlockType, workspace);
      // 这个输入本身作为孤儿
      allOrphans.push([key, nestedExtract.cleaned]);
      // 它内部提取出来的孤儿也添加到列表
      if (nestedExtract.orphans.length > 0) {
        allOrphans.push(...nestedExtract.orphans);
      }
    } else {
      cleaned[key] = value;
    }
  }
  
  return { cleaned, orphans: allOrphans };
}

/**
 * 清理错位输入的值，提取其中可能嵌套的其他错位输入
 * 
 * 例如 DO0 的值可能是：
 * {
 *   "block": {...},
 *   "ELSE": {"block": {...}}  // ELSE 不应该在 DO0 下面
 * }
 * 
 * 需要把 ELSE 提取出来作为孤儿返回
 */
function cleanMisplacedInputValue(
  inputValue: any,
  parentBlockType: string,
  workspace?: any
): { cleaned: any; orphans: Array<[string, any]> } {
  if (!inputValue || typeof inputValue !== 'object') {
    return { cleaned: inputValue, orphans: [] };
  }
  
  const cleaned: Record<string, any> = {};
  const orphans: Array<[string, any]> = [];
  
  for (const [key, value] of Object.entries(inputValue)) {
    if (key === 'block') {
      // 递归修复嵌套的 block
      const nestedBlockFix = fixBlockRecursively(value, workspace);
      cleaned[key] = nestedBlockFix.fixed;
      // 收集来自嵌套块的孤儿
      if (nestedBlockFix.orphanInputs) {
        orphans.push(...nestedBlockFix.orphanInputs);
      }
    } else if (key === 'shadow') {
      cleaned[key] = value;
    } else if (looksLikeInput(key, value)) {
      // 递归清理这个嵌套的错位输入
      const nestedClean = cleanMisplacedInputValue(value, parentBlockType, workspace);
      orphans.push([key, nestedClean.cleaned]);
      if (nestedClean.orphans.length > 0) {
        orphans.push(...nestedClean.orphans);
      }
    } else {
      cleaned[key] = value;
    }
  }
  
  return { cleaned, orphans };
}

/**
 * 修复错误的嵌套结构
 * 
 * jsonrepair 可能会产生这样的错误结构：
 * ```json
 * "inputs": {
 *   "DO0": {
 *     "block": {...},
 *     "ELSE": {"block": {...}}  // ELSE 应该在 inputs 下，不是在 DO0 下
 *   }
 * }
 * ```
 * 
 * 正确结构应该是：
 * ```json
 * "inputs": {
 *   "DO0": {"block": {...}},
 *   "ELSE": {"block": {...}}
 * }
 * ```
 */
function fixMisplacedInputs(
  blockDef: any, 
  workspace?: any
): { 
  fixed: any; 
  wasFixed: boolean; 
  fixInfo: string[]; 
  orphanInputs?: Array<[string, any]>;
  misplacedStructureDefParts?: { additionalBlocks: any[]; connectionRules: any[] };
} {
  const fixInfo: string[] = [];
  let wasFixed = false;
  const collectedOrphans: Array<[string, any]> = [];  // 收集来自嵌套块的孤儿
  
  if (!blockDef || !blockDef.inputs) {
    return { fixed: blockDef, wasFixed: false, fixInfo };
  }
  
  const blockType = blockDef.type;
  const fixedInputs: Record<string, any> = {};
  
  // 🆕 关键改进：首先检查 inputs 的直接子 key 是否都属于当前块类型
  // 如果某个 key 不属于当前块，它应该被提取出来作为孤儿向上冒泡
  const inputKeys = Object.keys(blockDef.inputs);
  const extraState = blockDef.extraState;  // 获取 extraState 用于智能推断
  const validInputs = getValidInputsForBlockType(blockType, workspace, inputKeys, extraState);
  
  // console.log(`[BlockConfigFixer] 块 ${blockType} 的合法输入: [${Array.from(validInputs).join(', ')}]`);
  // console.log(`[BlockConfigFixer] 块 ${blockType} 的实际输入 keys: [${inputKeys.join(', ')}]`);
  
  // 🆕 用于收集错位在 inputs 下的 structureDefinition 属性
  // 这些会被作为特殊孤儿向上冒泡，最终放到 structureDefinition 顶层
  const misplacedStructureDefParts: { additionalBlocks: any[]; connectionRules: any[] } = {
    additionalBlocks: [],
    connectionRules: []
  };
  
  // 分离属于当前块的输入和不属于的输入
  const validInputEntries: [string, any][] = [];
  const invalidInputEntries: [string, any][] = [];
  
  for (const [inputName, inputConfig] of Object.entries(blockDef.inputs)) {
    // 🆕 首先检查是否是错位的 structureDefinition 属性
    if (inputName === 'additionalBlocks' && Array.isArray(inputConfig)) {
      // console.log(`[BlockConfigFixer] ⚠️ 发现错位在 ${blockType}.inputs 下的 additionalBlocks (${inputConfig.length} 个块)`);
      misplacedStructureDefParts.additionalBlocks.push(...inputConfig);
      wasFixed = true;
      fixInfo.push(`🔧 提取: inputs.additionalBlocks 错位，应在 structureDefinition 顶层`);
      continue;
    }
    if (inputName === 'connectionRules' && Array.isArray(inputConfig)) {
      // console.log(`[BlockConfigFixer] ⚠️ 发现错位在 ${blockType}.inputs 下的 connectionRules (${inputConfig.length} 条规则)`);
      misplacedStructureDefParts.connectionRules.push(...inputConfig);
      wasFixed = true;
      fixInfo.push(`🔧 提取: inputs.connectionRules 错位，应在 structureDefinition 顶层`);
      continue;
    }
    
    if (validInputs.has(inputName)) {
      validInputEntries.push([inputName, inputConfig]);
    } else if (looksLikeInput(inputName, inputConfig)) {
      // 不属于当前块但看起来像输入，标记为孤儿
      // console.log(`[BlockConfigFixer] ⚠️ 输入 ${inputName} 不属于 ${blockType}，将作为孤儿向上冒泡`);
      invalidInputEntries.push([inputName, inputConfig]);
      wasFixed = true;
      fixInfo.push(`🔍 检测: inputs.${inputName} 不是 ${blockType} 的合法输入，作为孤儿向上冒泡`);
    } else {
      // 不确定的情况，保留在当前块
      validInputEntries.push([inputName, inputConfig]);
    }
  }
  
  // 将不属于当前块的输入添加到孤儿列表
  for (const [invalidKey, invalidValue] of invalidInputEntries) {
    // 递归提取这个输入内部可能的嵌套孤儿
    const extractedInputs = recursivelyExtractInputs(invalidValue, blockType, workspace);
    collectedOrphans.push([invalidKey, extractedInputs.cleaned]);
    
    // 处理提取出来的深层孤儿
    for (const [orphanKey, orphanValue] of extractedInputs.orphans) {
      if (validInputs.has(orphanKey)) {
        // 这个孤儿属于当前块
        validInputEntries.push([orphanKey, orphanValue]);
        fixInfo.push(`🔧 修复: 深层孤儿 ${orphanKey} 从 ${invalidKey} 提升到 ${blockType}.inputs.${orphanKey}`);
      } else {
        collectedOrphans.push([orphanKey, orphanValue]);
      }
    }
  }
  
  // 处理属于当前块的输入
  for (const [inputName, inputConfig] of validInputEntries) {
    if (!inputConfig || typeof inputConfig !== 'object') {
      fixedInputs[inputName] = inputConfig;
      continue;
    }
    
    // 检查这个 input 下是否有被错误放置的其他 input
    const misplacedInputs: [string, any][] = [];
    const cleanedConfig: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(inputConfig as object)) {
      if (key === 'block' || key === 'shadow') {
        // 🔧 关键改进：对嵌套的 block 调用完整的递归修复
        if (key === 'block' && value && typeof value === 'object') {
          const nestedBlockFix = fixBlockRecursively(value, workspace);
          cleanedConfig[key] = nestedBlockFix.fixed;
          if (nestedBlockFix.wasFixed) {
            fixInfo.push(...nestedBlockFix.fixInfo);
            wasFixed = true;
          }
          // 🆕 收集来自嵌套块的孤儿输入
          if (nestedBlockFix.orphanInputs && nestedBlockFix.orphanInputs.length > 0) {
            // console.log(`[BlockConfigFixer] 从嵌套块收到孤儿: ${nestedBlockFix.orphanInputs.map(([k]) => k).join(', ')}，当前块类型: ${blockType}`);
            // 检查这些孤儿是否属于当前块
            for (const [orphanKey, orphanValue] of nestedBlockFix.orphanInputs) {
              if (isMisplacedInput(orphanKey, orphanValue, blockType, workspace, true)) {
                // 属于当前块，添加到 inputs
                misplacedInputs.push([orphanKey, orphanValue]);
                fixInfo.push(`🔧 修复: 孤儿输入 ${orphanKey} 从嵌套块提升到 ${blockType}.inputs.${orphanKey}`);
              } else {
                // 不属于当前块，继续向上冒泡
                // console.log(`[BlockConfigFixer] 孤儿 ${orphanKey} 不属于 ${blockType}，继续向上冒泡`);
                collectedOrphans.push([orphanKey, orphanValue]);
              }
            }
          }
        } else {
          cleanedConfig[key] = value;
        }
      } else if (isMisplacedInput(key, value, blockType, workspace)) {
        // 这是一个被错误放置的输入（属于当前块）
        misplacedInputs.push([key, value]);
        wasFixed = true;
        fixInfo.push(`🔧 修复: 将 ${inputName}.${key} 提升到 inputs.${key}`);
      } else if (looksLikeInput(key, value)) {
        // 🆕 看起来像输入但不属于当前块，需要先递归提取再作为孤儿冒泡
        // 因为它内部可能还有属于当前块的输入（如 IF1 里有 DO1, ELSE）
        const extractedInputs = recursivelyExtractInputs(value, blockType, workspace);
        
        // 处理提取出来的所有孤儿（它们可能属于当前块）
        for (const [orphanKey, orphanValue] of extractedInputs.orphans) {
          if (isMisplacedInput(orphanKey, orphanValue, blockType, workspace, true)) {
            // 这个孤儿属于当前块！
            if (!fixedInputs[orphanKey]) {
              fixedInputs[orphanKey] = orphanValue;
              fixInfo.push(`🔧 修复: 嵌套孤儿输入 ${orphanKey} 从 ${inputName}.${key} 提升到 ${blockType}.inputs.${orphanKey}`);
              wasFixed = true;
            }
          } else {
            // 这个孤儿不属于当前块，继续向上冒泡
            collectedOrphans.push([orphanKey, orphanValue]);
          }
        }
        
        // 清理后的输入作为孤儿冒泡
        collectedOrphans.push([key, extractedInputs.cleaned]);
        wasFixed = true;
        fixInfo.push(`🔍 检测: ${inputName}.${key} 不属于 ${blockType}，作为孤儿向上冒泡`);
      } else {
        // 其他未知属性保留
        cleanedConfig[key] = value;
      }
    }
    
    // 添加清理后的 input
    // 🔑 关键改进：即使 cleanedConfig 为空，也要保留合法的输入名
    // 因为输入名本身（如 IF0）是有意义的，它的内容可能被提取为孤儿了
    if (Object.keys(cleanedConfig).length > 0) {
      fixedInputs[inputName] = cleanedConfig;
    } else if (/^(IF|DO|ELSE|ELSEIF|ADD|ITEM|CASE|DEFAULT|SUBSTACK)\d*$/.test(inputName)) {
      // 合法的动态输入名，保留为空对象（后续可能需要填充 block）
      // console.log(`[BlockConfigFixer] 输入 ${inputName} 清理后为空，但保留输入名`);
      fixedInputs[inputName] = {};
    }
    
    // 将错位的 input 添加到正确的位置，并递归修复其中的嵌套块
    for (const [misplacedKey, misplacedValue] of misplacedInputs) {
      if (fixedInputs[misplacedKey]) {
        console.warn(`[BlockConfigFixer] 警告: 输入 ${misplacedKey} 已存在，跳过错位的值`);
      } else {
        // 🔧 关键改进：对错位输入中的 block 也调用完整的递归修复
        if (misplacedValue && typeof misplacedValue === 'object') {
          // 🆕 检查 misplacedValue 本身是否有其他错位的输入
          const cleanedMisplacedValue: Record<string, any> = {};
          
          for (const [mvKey, mvValue] of Object.entries(misplacedValue)) {
            // console.log(`[BlockConfigFixer] 处理 misplacedInput ${misplacedKey} 的属性: ${mvKey}`);
            if (mvKey === 'block') {
              // 递归修复嵌套的 block
              const nestedBlockFix = fixBlockRecursively(mvValue, workspace);
              cleanedMisplacedValue[mvKey] = nestedBlockFix.fixed;
              if (nestedBlockFix.wasFixed) {
                fixInfo.push(...nestedBlockFix.fixInfo);
                wasFixed = true;
              }
              // 收集来自嵌套块的孤儿
              if (nestedBlockFix.orphanInputs && nestedBlockFix.orphanInputs.length > 0) {
                for (const [orphanKey, orphanValue] of nestedBlockFix.orphanInputs) {
                  if (isMisplacedInput(orphanKey, orphanValue, blockType, workspace, true)) {
                    // 属于当前块，稍后处理
                    if (!fixedInputs[orphanKey]) {
                      fixedInputs[orphanKey] = orphanValue;
                      fixInfo.push(`🔧 修复: 孤儿输入 ${orphanKey} 从 ${misplacedKey}.block 提升到 ${blockType}.inputs.${orphanKey}`);
                      wasFixed = true;
                    }
                  } else {
                    collectedOrphans.push([orphanKey, orphanValue]);
                  }
                }
              }
            } else if (mvKey === 'shadow') {
              cleanedMisplacedValue[mvKey] = mvValue;
            } else if (looksLikeInput(mvKey, mvValue)) {
              // console.log(`[BlockConfigFixer] ${mvKey} 被 looksLikeInput 识别，开始递归提取`);
              // 🆕 发现错位输入中还有其他看起来像输入的属性
              // 使用递归提取函数来处理任意深度的嵌套
              const extractedInputs = recursivelyExtractInputs(mvValue, blockType, workspace);
              
              // 检查这个输入是否属于当前块
              if (isMisplacedInput(mvKey, mvValue, blockType, workspace, true)) {
                if (!fixedInputs[mvKey]) {
                  fixedInputs[mvKey] = extractedInputs.cleaned;
                  fixInfo.push(`🔧 修复: 将 ${misplacedKey}.${mvKey} 提升到 inputs.${mvKey}`);
                  wasFixed = true;
                }
              } else {
                // 不属于当前块，作为孤儿冒泡
                collectedOrphans.push([mvKey, extractedInputs.cleaned]);
                fixInfo.push(`🔍 检测: ${misplacedKey}.${mvKey} 不属于 ${blockType}，作为孤儿向上冒泡`);
                wasFixed = true;
              }
              
              // 处理提取出来的所有孤儿
              for (const [orphanKey, orphanValue] of extractedInputs.orphans) {
                if (isMisplacedInput(orphanKey, orphanValue, blockType, workspace, true)) {
                  if (!fixedInputs[orphanKey]) {
                    fixedInputs[orphanKey] = orphanValue;
                    fixInfo.push(`🔧 修复: 深层孤儿输入 ${orphanKey} 从 ${misplacedKey}.${mvKey} 提升到 ${blockType}.inputs.${orphanKey}`);
                    wasFixed = true;
                  }
                } else {
                  collectedOrphans.push([orphanKey, orphanValue]);
                }
              }
            } else {
              // 其他属性保留
              cleanedMisplacedValue[mvKey] = mvValue;
            }
          }
          
          fixedInputs[misplacedKey] = cleanedMisplacedValue;
        } else {
          fixedInputs[misplacedKey] = misplacedValue;
        }
      }
    }
  }
  
  // 检查是否提取了 structureDefinition 属性
  const hasMisplacedStructureDef = 
    misplacedStructureDefParts.additionalBlocks.length > 0 || 
    misplacedStructureDefParts.connectionRules.length > 0;
  
  return {
    fixed: { ...blockDef, inputs: fixedInputs },
    wasFixed,
    fixInfo,
    orphanInputs: collectedOrphans.length > 0 ? collectedOrphans : undefined,
    misplacedStructureDefParts: hasMisplacedStructureDef ? misplacedStructureDefParts : undefined
  };
}

/**
 * 递归修复 inputs 对象中的错误嵌套
 * 
 * 关键改进：对每个嵌套的 block 调用完整的 fixBlockRecursively，
 * 而不仅仅是 fixMisplacedInputsInObject，确保多层嵌套都能正确修复
 */
function fixMisplacedInputsInObject(
  inputs: Record<string, any>,
  parentBlockType?: string,
  workspace?: any
): { fixed: Record<string, any>; wasFixed: boolean; fixInfo: string[] } {
  const fixInfo: string[] = [];
  let wasFixed = false;
  const fixedInputs: Record<string, any> = {};
  
  for (const [inputName, inputConfig] of Object.entries(inputs)) {
    if (!inputConfig || typeof inputConfig !== 'object') {
      fixedInputs[inputName] = inputConfig;
      continue;
    }
    
    const misplacedInputs: [string, any][] = [];
    const cleanedConfig: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(inputConfig)) {
      if (key === 'block' || key === 'shadow') {
        // 🔧 关键改进：对嵌套的 block 调用完整的递归修复
        if (key === 'block' && value && typeof value === 'object') {
          const nestedBlockFix = fixBlockRecursively(value, workspace);
          cleanedConfig[key] = nestedBlockFix.fixed;
          if (nestedBlockFix.wasFixed) {
            fixInfo.push(...nestedBlockFix.fixInfo);
            wasFixed = true;
          }
        } else {
          cleanedConfig[key] = value;
        }
      } else if (isMisplacedInput(key, value, parentBlockType, workspace)) {
        misplacedInputs.push([key, value]);
        wasFixed = true;
        fixInfo.push(`🔧 修复: 将 ${inputName}.${key} 提升到同级`);
      } else {
        cleanedConfig[key] = value;
      }
    }
    
    // 🔑 关键改进：即使 cleanedConfig 为空，也要保留合法的输入名
    if (Object.keys(cleanedConfig).length > 0) {
      fixedInputs[inputName] = cleanedConfig;
    } else if (/^(IF|DO|ELSE|ELSEIF|ADD|ITEM|CASE|DEFAULT|SUBSTACK)\d*$/.test(inputName)) {
      // 合法的动态输入名，保留为空对象
      // console.log(`[BlockConfigFixer] fixNestedMisplacedInputs: 输入 ${inputName} 清理后为空，但保留输入名`);
      fixedInputs[inputName] = {};
    }
    
    // 将错位的 input 添加到正确的位置，并递归修复其中的嵌套块
    for (const [misplacedKey, misplacedValue] of misplacedInputs) {
      if (!fixedInputs[misplacedKey]) {
        // 🔧 关键改进：对错位输入中的 block 也调用完整的递归修复
        if (misplacedValue && typeof misplacedValue === 'object' && misplacedValue.block) {
          const nestedBlockFix = fixBlockRecursively(misplacedValue.block, workspace);
          fixedInputs[misplacedKey] = {
            ...misplacedValue,
            block: nestedBlockFix.fixed
          };
          if (nestedBlockFix.wasFixed) {
            fixInfo.push(...nestedBlockFix.fixInfo);
            wasFixed = true;
          }
        } else {
          fixedInputs[misplacedKey] = misplacedValue;
        }
      }
    }
  }
  
  return { fixed: fixedInputs, wasFixed, fixInfo };
}

/**
 * 🆕 递归提取错误嵌套在 block 或 inputs 内部的 additionalBlocks 和 connectionRules
 * 这些应该放在 structureDefinition 顶层，而不是放在 block 内部
 * 
 * LLM 可能错误地生成多种错误结构：
 * 
 * 场景1: additionalBlocks 在某个 input 的值内部
 * {
 *   "inputs": {
 *     "DO0": {
 *       "block": {...},
 *       "additionalBlocks": [...],  // ❌ 错误！
 *       "connectionRules": [...]     // ❌ 错误！
 *     }
 *   }
 * }
 * 
 * 场景2: additionalBlocks 作为 inputs 的直接子属性
 * {
 *   "inputs": {
 *     "IF0": {"block": {...}},
 *     "additionalBlocks": [...],  // ❌ 错误！应该在 structureDefinition 层级
 *     "connectionRules": [...]     // ❌ 错误！应该在 structureDefinition 层级
 *   }
 * }
 * 
 * 此函数递归遍历整个 block 结构，提取这些错位的数组，并返回清理后的 block
 */
function extractMisplacedStructureDefinitionParts(
  blockConfig: any
): { 
  cleanedBlock: any; 
  additionalBlocks: any[]; 
  connectionRules: any[];
  wasExtracted: boolean;
} {
  const collectedAdditionalBlocks: any[] = [];
  const collectedConnectionRules: any[] = [];
  let wasExtracted = false;
  
  function cleanRecursively(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => cleanRecursively(item));
    }
    
    const cleaned: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // 检测 additionalBlocks 在错误位置
      if (key === 'additionalBlocks' && Array.isArray(value)) {
        // 判断是否在错误位置（不应该在 input config 或 block 内部直接出现）
        // 正确位置是 structureDefinition 顶层，此时调用此函数时已经在 rootBlock 内部
        // console.log(`[BlockConfigFixer] ⚠️ 发现错位的 additionalBlocks (${(value as any[]).length} 个块)`);
        
        // 🆕 对 additionalBlocks 中的每个块也进行递归提取清理
        for (const block of value as any[]) {
          const cleanedBlock = cleanRecursively(block);
          collectedAdditionalBlocks.push(cleanedBlock);
        }
        
        wasExtracted = true;
        continue; // 不复制到 cleaned 中
      }
      
      // 检测 connectionRules 在错误位置
      if (key === 'connectionRules' && Array.isArray(value)) {
        // console.log(`[BlockConfigFixer] ⚠️ 发现错位的 connectionRules (${(value as any[]).length} 条规则)`);
        collectedConnectionRules.push(...(value as any[]));
        wasExtracted = true;
        continue; // 不复制到 cleaned 中
      }
      
      // 递归处理 inputs
      if (key === 'inputs' && value && typeof value === 'object') {
        cleaned[key] = {};
        for (const [inputKey, inputValue] of Object.entries(value)) {
          // 🆕 检查 inputs 的直接子属性是否是错位的 additionalBlocks 或 connectionRules
          if (inputKey === 'additionalBlocks' && Array.isArray(inputValue)) {
            // console.log(`[BlockConfigFixer] ⚠️ 发现错位在 inputs 下的 additionalBlocks (${inputValue.length} 个块)`);
            for (const block of inputValue) {
              const cleanedBlock = cleanRecursively(block);
              collectedAdditionalBlocks.push(cleanedBlock);
            }
            wasExtracted = true;
            continue; // 不复制到 cleaned.inputs 中
          }
          if (inputKey === 'connectionRules' && Array.isArray(inputValue)) {
            // console.log(`[BlockConfigFixer] ⚠️ 发现错位在 inputs 下的 connectionRules (${inputValue.length} 条规则)`);
            collectedConnectionRules.push(...inputValue);
            wasExtracted = true;
            continue; // 不复制到 cleaned.inputs 中
          }
          cleaned[key][inputKey] = cleanRecursively(inputValue);
        }
        continue;
      }
      
      // 递归处理 block 和 next
      if ((key === 'block' || key === 'next') && value && typeof value === 'object') {
        cleaned[key] = cleanRecursively(value);
        continue;
      }
      
      // 普通字段直接复制
      cleaned[key] = value;
    }
    
    return cleaned;
  }
  
  const cleanedBlock = cleanRecursively(blockConfig);
  
  return {
    cleanedBlock,
    additionalBlocks: collectedAdditionalBlocks,
    connectionRules: collectedConnectionRules,
    wasExtracted
  };
}

/**
 * 递归修复单个块配置（包括其 inputs 和 next）
 * 这是核心的递归修复函数，确保块的所有层级都被修复
 * 
 * 新增：孤儿输入冒泡机制
 * 当发现输入不属于当前块类型但看起来像某种块的输入时，
 * 将它作为"孤儿"返回给父级处理
 * 
 * 新增：错位的 structureDefinition 属性冒泡机制
 * 当发现 additionalBlocks/connectionRules 在块内部时，将它们向上冒泡
 */
function fixBlockRecursively(
  blockConfig: any,
  workspace?: any
): { 
  fixed: any; 
  wasFixed: boolean; 
  fixInfo: string[]; 
  orphanInputs?: Array<[string, any]>;
  misplacedStructureDefParts?: { additionalBlocks: any[]; connectionRules: any[] };
} {
  if (!blockConfig || typeof blockConfig !== 'object') {
    return { fixed: blockConfig, wasFixed: false, fixInfo: [] };
  }
  
  let wasFixed = false;
  const allFixInfo: string[] = [];
  let fixedBlock = { ...blockConfig };
  const collectedOrphans: Array<[string, any]> = [];
  
  // 🆕 收集错位的 structureDefinition 属性（从子块冒泡上来的）
  const collectedStructureDefParts: { additionalBlocks: any[]; connectionRules: any[] } = {
    additionalBlocks: [],
    connectionRules: []
  };
  
  // 0. 🔧 修复块顶层的错位输入属性，同时收集孤儿输入
  const topLevelInputFix = fixTopLevelMisplacedInputs(fixedBlock, workspace);
  if (topLevelInputFix.wasFixed) {
    fixedBlock = topLevelInputFix.fixed;
    wasFixed = true;
    allFixInfo.push(...topLevelInputFix.fixInfo);
  }
  // 收集不属于当前块的孤儿输入
  if (topLevelInputFix.orphanInputs && topLevelInputFix.orphanInputs.length > 0) {
    collectedOrphans.push(...topLevelInputFix.orphanInputs);
  }
  
  // 1. 修复当前块的 inputs（处理 inputs 内部的错位问题）
  if (fixedBlock.inputs) {
    const inputsFix = fixMisplacedInputs(fixedBlock, workspace);
    if (inputsFix.wasFixed) {
      fixedBlock = inputsFix.fixed;
      wasFixed = true;
      allFixInfo.push(...inputsFix.fixInfo);
    }
    // 收集来自 inputs 内部的孤儿
    if (inputsFix.orphanInputs && inputsFix.orphanInputs.length > 0) {
      // console.log(`[BlockConfigFixer] 块 ${fixedBlock.type} 收集到孤儿输入: ${inputsFix.orphanInputs.map(([k]) => k).join(', ')}`);
      collectedOrphans.push(...inputsFix.orphanInputs);
    }
    // 🆕 收集来自 inputs 的错位 structureDefinition 属性
    if (inputsFix.misplacedStructureDefParts) {
      collectedStructureDefParts.additionalBlocks.push(...inputsFix.misplacedStructureDefParts.additionalBlocks);
      collectedStructureDefParts.connectionRules.push(...inputsFix.misplacedStructureDefParts.connectionRules);
    }
  }
  
  // 2. 递归修复 next 链
  if (fixedBlock.next && fixedBlock.next.block) {
    const nextFix = fixBlockRecursively(fixedBlock.next.block, workspace);
    if (nextFix.wasFixed) {
      fixedBlock.next = { block: nextFix.fixed };
      wasFixed = true;
      allFixInfo.push(...nextFix.fixInfo);
    }
    // next 链的孤儿也要收集
    if (nextFix.orphanInputs && nextFix.orphanInputs.length > 0) {
      collectedOrphans.push(...nextFix.orphanInputs);
    }
    // 🆕 收集来自 next 链的错位 structureDefinition 属性
    if (nextFix.misplacedStructureDefParts) {
      collectedStructureDefParts.additionalBlocks.push(...nextFix.misplacedStructureDefParts.additionalBlocks);
      collectedStructureDefParts.connectionRules.push(...nextFix.misplacedStructureDefParts.connectionRules);
    }
  }
  
  // 🆕 辅助函数：检查是否有收集到的 structureDefinition 属性
  const hasMisplacedStructureDef = () => 
    collectedStructureDefParts.additionalBlocks.length > 0 || 
    collectedStructureDefParts.connectionRules.length > 0;
  
  // 3. 🆕 尝试将收集到的孤儿输入放入当前块（如果它们属于当前块）
  if (collectedOrphans.length > 0 && fixedBlock.type) {
    // console.log(`[BlockConfigFixer] 块 ${fixedBlock.type} 开始处理 ${collectedOrphans.length} 个孤儿: ${collectedOrphans.map(([k]) => k).join(', ')}`);
    const adoptedOrphans: Array<[string, any]> = [];
    const remainingOrphans: Array<[string, any]> = [];
    
    // 获取当前块的合法输入列表
    const existingInputKeys = fixedBlock.inputs ? Object.keys(fixedBlock.inputs) : [];
    const blockExtraState = fixedBlock.extraState;  // 获取 extraState 用于智能推断
    const validInputs = getValidInputsForBlockType(fixedBlock.type, workspace, [...existingInputKeys, ...collectedOrphans.map(([k]) => k)], blockExtraState);
    // console.log(`[BlockConfigFixer] 块 ${fixedBlock.type} 可接受的输入: [${Array.from(validInputs).join(', ')}]`);
    
    for (const [orphanKey, orphanValue] of collectedOrphans) {
      // 使用新的验证函数检查这个孤儿是否属于当前块类型
      if (validInputs.has(orphanKey)) {
        // 这个孤儿属于当前块！
        // console.log(`[BlockConfigFixer] ✅ 孤儿 ${orphanKey} 属于 ${fixedBlock.type}，领养成功`);
        if (!fixedBlock.inputs) {
          fixedBlock.inputs = {};
        }
        if (!fixedBlock.inputs[orphanKey]) {
          fixedBlock.inputs[orphanKey] = orphanValue;
          adoptedOrphans.push([orphanKey, orphanValue]);
          wasFixed = true;
          allFixInfo.push(`🔧 修复: 孤儿输入 ${orphanKey} 被提升到 ${fixedBlock.type}.inputs.${orphanKey}`);
        }
      } else {
        // 不属于当前块，继续向上传递
        // console.log(`[BlockConfigFixer] ❌ 孤儿 ${orphanKey} 不属于 ${fixedBlock.type}，继续向上冒泡`);
        remainingOrphans.push([orphanKey, orphanValue]);
      }
    }
    
    // 返回未被领养的孤儿
    if (remainingOrphans.length > 0) {
      return { 
        fixed: fixedBlock, 
        wasFixed, 
        fixInfo: allFixInfo, 
        orphanInputs: remainingOrphans,
        misplacedStructureDefParts: hasMisplacedStructureDef() ? collectedStructureDefParts : undefined
      };
    }
  }
  
  // 4. 🆕 自动生成 extraState（如 controls_if 需要 hasElse/elseifCount）
  const extraStateResult = autoGenerateExtraState(fixedBlock);
  if (extraStateResult.wasFixed) {
    fixedBlock = extraStateResult.fixed;
    wasFixed = true;
    allFixInfo.push(...extraStateResult.fixInfo);
  }
  
  return { 
    fixed: fixedBlock, 
    wasFixed, 
    fixInfo: allFixInfo, 
    orphanInputs: collectedOrphans.length > 0 ? collectedOrphans : undefined,
    misplacedStructureDefParts: hasMisplacedStructureDef() ? collectedStructureDefParts : undefined
  };
}

/**
 * 自动生成 extraState
 * 
 * 某些动态块（如 controls_if）需要 extraState 来声明额外的输入。
 * 当检测到块有这些输入但没有对应的 extraState 时，自动生成。
 * 
 * 支持的块类型：
 * - controls_if: 检测 ELSE, IF1/DO1 等，生成 hasElse 和 elseifCount
 * - text_join: 检测 ADD0, ADD1 等，生成 itemCount
 * - lists_create_with: 检测 ADD0, ADD1 等，生成 itemCount
 */
function autoGenerateExtraState(
  blockConfig: any
): { fixed: any; wasFixed: boolean; fixInfo: string[] } {
  if (!blockConfig || !blockConfig.type || !blockConfig.inputs) {
    return { fixed: blockConfig, wasFixed: false, fixInfo: [] };
  }
  
  const blockType = blockConfig.type;
  const inputs = blockConfig.inputs;
  const inputKeys = Object.keys(inputs);
  const fixInfo: string[] = [];
  let wasFixed = false;
  let fixedBlock = { ...blockConfig };
  
  // controls_if 块的 extraState 自动生成
  if (blockType === 'controls_if' || blockType === 'controls_ifelse') {
    // 检测是否有 ELSE 输入
    const hasElse = inputKeys.includes('ELSE');
    
    // 检测 elseif 数量（IF1/DO1, IF2/DO2, ...）
    let elseifCount = 0;
    for (const key of inputKeys) {
      const match = key.match(/^IF(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > 0 && num > elseifCount) {
          elseifCount = num;
        }
      }
    }
    
    // 检查是否需要生成 extraState
    const existingExtraState = fixedBlock.extraState || {};
    let needsUpdate = false;
    const newExtraState = { ...existingExtraState };
    
    if (hasElse && !existingExtraState.hasElse) {
      newExtraState.hasElse = true;
      needsUpdate = true;
      fixInfo.push(`🔧 修复: 检测到 ELSE 输入，自动添加 extraState.hasElse = true`);
    }
    
    if (elseifCount > 0 && (existingExtraState.elseifCount === undefined || existingExtraState.elseifCount < elseifCount)) {
      newExtraState.elseifCount = elseifCount;
      needsUpdate = true;
      fixInfo.push(`🔧 修复: 检测到 ${elseifCount} 个 else-if 分支，自动添加 extraState.elseifCount = ${elseifCount}`);
    }
    
    if (needsUpdate) {
      fixedBlock.extraState = newExtraState;
      wasFixed = true;
    }
  }
  
  // text_join 块的 extraState 自动生成
  if (blockType === 'text_join') {
    // 检测 ADD 数量
    let maxAddNum = -1;
    for (const key of inputKeys) {
      const match = key.match(/^ADD(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxAddNum) {
          maxAddNum = num;
        }
      }
    }
    
    if (maxAddNum >= 0) {
      const itemCount = maxAddNum + 1;
      const existingExtraState = fixedBlock.extraState || {};
      
      if (existingExtraState.itemCount === undefined || existingExtraState.itemCount < itemCount) {
        fixedBlock.extraState = { ...existingExtraState, itemCount };
        wasFixed = true;
        fixInfo.push(`🔧 修复: 检测到 ${itemCount} 个文本项，自动添加 extraState.itemCount = ${itemCount}`);
      }
    }
  }
  
  // lists_create_with 块的 extraState 自动生成
  if (blockType === 'lists_create_with') {
    // 检测 ADD 数量
    let maxAddNum = -1;
    for (const key of inputKeys) {
      const match = key.match(/^ADD(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxAddNum) {
          maxAddNum = num;
        }
      }
    }
    
    if (maxAddNum >= 0) {
      const itemCount = maxAddNum + 1;
      const existingExtraState = fixedBlock.extraState || {};
      
      if (existingExtraState.itemCount === undefined || existingExtraState.itemCount < itemCount) {
        fixedBlock.extraState = { ...existingExtraState, itemCount };
        wasFixed = true;
        fixInfo.push(`🔧 修复: 检测到 ${itemCount} 个列表项，自动添加 extraState.itemCount = ${itemCount}`);
      }
    }
  }
  
  // dynamic-inputs 插件的块（INPUT0, INPUT1...）extraState 自动生成
  // 通用检测：如果有 INPUT\d+ 模式的输入，推断 extraCount
  const inputInputs = inputKeys.filter(k => /^INPUT\d+$/.test(k));
  if (inputInputs.length > 0) {
    let maxInputNum = -1;
    for (const key of inputInputs) {
      const match = key.match(/^INPUT(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxInputNum) {
          maxInputNum = num;
        }
      }
    }
    
    if (maxInputNum >= 0) {
      // extraCount = 总输入数 - 1（因为 INPUT0 是默认的）
      const extraCount = maxInputNum; // maxInputNum 就是额外的输入数量
      const existingExtraState = fixedBlock.extraState || {};
      
      if (extraCount > 0 && (existingExtraState.extraCount === undefined || existingExtraState.extraCount < extraCount)) {
        fixedBlock.extraState = { ...existingExtraState, extraCount };
        wasFixed = true;
        fixInfo.push(`🔧 修复: 检测到 ${inputInputs.length} 个动态输入，自动添加 extraState.extraCount = ${extraCount}`);
      }
    }
  }
  
  return { fixed: fixedBlock, wasFixed, fixInfo };
}

/**
 * 修复块顶层的错位输入属性
 * 
 * 当括号修复后，可能出现这种结构：
 * {"id": "b10", "inputs": {"IF0": {...}}, "DO0": {...}}
 * 
 * DO0 应该在 inputs 里，而不是块的顶层。这个函数检测这种情况并修复。
 * 
 * 新增：孤儿输入收集
 * 当检测到一个属性看起来像输入但不属于当前块类型时，
 * 将它作为孤儿返回，让父级处理。
 */
function fixTopLevelMisplacedInputs(
  blockConfig: any,
  workspace?: any
): { fixed: any; wasFixed: boolean; fixInfo: string[]; orphanInputs?: Array<[string, any]> } {
  if (!blockConfig || typeof blockConfig !== 'object' || !blockConfig.type) {
    return { fixed: blockConfig, wasFixed: false, fixInfo: [] };
  }
  
  const blockType = blockConfig.type;
  const fixInfo: string[] = [];
  let wasFixed = false;
  
  // 已知的块定义合法属性（不应该被移动到 inputs 的属性）
  const validBlockProperties = new Set([
    'id', 'type', 'inputs', 'fields', 'extra', 'extraState', 
    'next', 'x', 'y', 'collapsed', 'enabled', 'data',
    'icons', 'deletable', 'movable', 'editable', 'inline',
    'inputsInline', 'shadow', 'mutation', 'comment'
  ]);
  
  const misplacedInputs: [string, any][] = [];
  const orphanInputs: [string, any][] = [];  // 不属于当前块的孤儿输入
  const cleanedBlock: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(blockConfig)) {
    // console.log(`[BlockConfigFixer] fixTopLevelMisplacedInputs 检查属性: ${key}, blockType: ${blockType}`);
    if (validBlockProperties.has(key)) {
      // 这是块定义的合法属性
      cleanedBlock[key] = value;
    } else if (isMisplacedInput(key, value, blockType, workspace, true)) {  // isTopLevel = true
      // 这个输入属于当前块类型，移动到 inputs
      misplacedInputs.push([key, value]);
      wasFixed = true;
      fixInfo.push(`🔧 修复: 将块顶层的 ${key} 移动到 inputs.${key}（块类型: ${blockType}）`);
    } else if (looksLikeInput(key, value)) {
      // 看起来像输入但不属于当前块类型，作为孤儿向上传递
      // console.log(`[BlockConfigFixer] ${key} 被识别为孤儿输入，不属于 ${blockType}，向上冒泡`);
      orphanInputs.push([key, value]);
      wasFixed = true;
      fixInfo.push(`🔍 检测: ${key} 不属于 ${blockType}，标记为孤儿输入，向上冒泡`);
    } else {
      // 未知属性，保留在顶层
      // console.log(`[BlockConfigFixer] ${key} 未被识别为输入，保留在顶层`);
      cleanedBlock[key] = value;
    }
  }
  
  // 将错位的输入移动到 inputs 里
  if (misplacedInputs.length > 0) {
    if (!cleanedBlock['inputs']) {
      cleanedBlock['inputs'] = {};
    }
    
    for (const [inputKey, inputValue] of misplacedInputs) {
      if (!cleanedBlock['inputs'][inputKey]) {
        cleanedBlock['inputs'][inputKey] = inputValue;
      } else {
        console.warn(`[BlockConfigFixer] 输入 ${inputKey} 已存在于 inputs 中，跳过顶层的错位值`);
      }
    }
  }
  
  return { 
    fixed: cleanedBlock, 
    wasFixed, 
    fixInfo,
    orphanInputs: orphanInputs.length > 0 ? orphanInputs : undefined
  };
}

/**
 * 尝试修复 "裸 inputs" 格式
 * 
 * 当 LLM 返回的 JSON 只有 inputs 内容而没有外层块定义时，
 * 根据输入的 key 推断块类型并包装成正确的块结构。
 * 
 * 示例：
 * 输入: { "IF0": {"block": {...}}, "DO0": {"block": {...}} }
 * 输出: { "type": "controls_if", "inputs": { "IF0": {...}, "DO0": {...} } }
 * 
 * 注意：普通的 inputs 对象如 { "PIN": {...}, "STATE": {...} } 不需要包装，
 * 因为它们本身就是有效的 inputs 对象。只有动态输入名模式（IF0, DO0, ADD0 等）
 * 才需要包装成完整块定义。
 * 
 * @param config 配置对象
 * @param workspace Blockly 工作区
 * @param knownBlockType 已知的块类型（如果调用者已经知道）
 */
function tryFixBareInputsFormat(
  config: any,
  workspace?: any,
  knownBlockType?: string
): { fixed: any; wasFixed: boolean; fixInfo: string[] } {
  const keys = Object.keys(config);
  
  if (keys.length === 0) {
    return { fixed: config, wasFixed: false, fixInfo: [] };
  }
  
  // 检查所有 key 是否都像是 inputs 的 key（包含 block 或 shadow）
  const allKeysLookLikeInputs = keys.every(key => {
    const value = config[key];
    return typeof value === 'object' && value !== null && ('block' in value || 'shadow' in value);
  });
  
  if (!allKeysLookLikeInputs) {
    return { fixed: config, wasFixed: false, fixInfo: [] };
  }
  
  // 🔑 关键判断：只有当 keys 匹配**动态输入名模式**时才需要包装
  // 动态输入名模式：IF0, DO0, ELSE, ADD0, ITEM0, CASE0, INPUT0 等（通常由动态块使用）
  // 普通输入名：PIN, STATE, VALUE, A, B, BOOL 等（不需要包装）
  const dynamicInputNamePatterns = [
    /^IF\d+$/,           // IF0, IF1... (controls_if)
    /^DO\d+$/,           // DO0, DO1... (controls_if)
    /^ELSE$/,            // ELSE (controls_ifelse)
    /^ELSEIF\d+$/,       // ELSEIF0, ELSEIF1...
    /^ADD\d+$/,          // ADD0, ADD1... (text_join)
    /^ITEM\d+$/,         // ITEM0, ITEM1... (lists_create_with)
    /^CASE\d+$/,         // CASE0, CASE1... (switch)
    /^DEFAULT$/,         // DEFAULT (switch)
    /^SUBSTACK\d*$/,     // SUBSTACK, SUBSTACK2
    /^INPUT\d+$/,        // INPUT0, INPUT1... (dynamic-inputs plugin)
    /^ARG\d+$/,          // ARG0, ARG1... (procedures)
  ];
  
  // 检查是否有任何 key 匹配动态输入名模式
  const hasDynamicInputKeys = keys.some(key => 
    dynamicInputNamePatterns.some(pattern => pattern.test(key))
  );
  
  if (!hasDynamicInputKeys) {
    // 没有动态输入名，这是一个普通的 inputs 对象，不需要包装
    // console.log(`[BlockConfigFixer] keys [${keys.join(', ')}] 是普通输入名，不需要包装`);
    return { fixed: config, wasFixed: false, fixInfo: [] };
  }
  
  // 有动态输入名，需要推断或使用已知块类型进行包装
  let blockType = knownBlockType;
  if (!blockType) {
    blockType = inferBlockTypeFromInputKeys(keys, workspace);
  }
  
  if (!blockType) {
    console.warn(`[BlockConfigFixer] 无法从 keys [${keys.join(', ')}] 推断块类型，且未提供 knownBlockType`);
    return { fixed: config, wasFixed: false, fixInfo: [] };
  }
  
  // 包装成正确的块结构
  const wrappedConfig = {
    type: blockType,
    inputs: config
  };
  
  const source = knownBlockType ? '使用已知块类型' : '推断块类型为';
  return {
    fixed: wrappedConfig,
    wasFixed: true,
    fixInfo: [`🔧 修复: 检测到裸 inputs 格式，${source} ${blockType}，已包装为完整块定义`]
  };
}

/**
 * 根据 input keys 推断块类型
 * 
 * 使用多种策略：
 * 1. 模式匹配：根据已知的输入名模式
 * 2. 动态检测：如果有 workspace，尝试匹配已知块类型
 */
function inferBlockTypeFromInputKeys(keys: string[], workspace?: any): string | null {
  // 策略1：模式匹配 - 根据特定的输入组合推断块类型
  const keySet = new Set(keys);
  
  // controls_if / controls_ifelse 的特征：IF0, DO0, IF1, DO1, ELSE...
  const hasIfPattern = keys.some(k => /^IF\d+$/.test(k));
  const hasDoPattern = keys.some(k => /^DO\d+$/.test(k));
  const hasElse = keySet.has('ELSE');
  
  if (hasIfPattern && hasDoPattern) {
    const inferredType = hasElse ? 'controls_ifelse' : 'controls_if';
    // console.log(`[BlockConfigFixer] 根据 IF/DO 模式推断块类型: ${inferredType}`);
    return inferredType;
  }
  
  // text_join 的特征：ADD0, ADD1, ADD2...
  const hasAddPattern = keys.some(k => /^ADD\d+$/.test(k));
  if (hasAddPattern && keys.every(k => /^ADD\d+$/.test(k))) {
    // console.log(`[BlockConfigFixer] 根据 ADD 模式推断块类型: text_join`);
    return 'text_join';
  }
  
  // lists_create_with 的特征：ITEM0, ITEM1, ITEM2...
  const hasItemPattern = keys.some(k => /^ITEM\d+$/.test(k));
  if (hasItemPattern && keys.every(k => /^ITEM\d+$/.test(k))) {
    // console.log(`[BlockConfigFixer] 根据 ITEM 模式推断块类型: lists_create_with`);
    return 'lists_create_with';
  }
  
  // logic_operation 的特征：A, B
  if (keySet.has('A') && keySet.has('B') && keys.length === 2) {
    // console.log(`[BlockConfigFixer] 根据 A/B 模式推断块类型: logic_operation`);
    return 'logic_operation';
  }
  
  // logic_compare 的特征也是 A, B，但通常在上下文中可以区分
  // 这里默认返回 logic_operation，因为它更常见
  
  // 策略2：动态检测 - 如果有 workspace，尝试匹配
  if (workspace) {
    // 尝试获取所有已注册的块类型，检查哪个块类型的输入匹配
    // 这里可以进一步扩展
  }
  
  console.warn(`[BlockConfigFixer] 无法从 keys [${keys.join(', ')}] 推断块类型`);
  return null;
}

/**
 * 递归修复整个配置对象（包括 next 链）
 * 这是对外暴露的入口，内部调用 fixBlockRecursively
 * 
 * 支持多种配置格式：
 * 1. 单个块定义 { type: "...", inputs: {...} }
 * 2. structureDefinition 格式 { structureDefinition: { rootBlock: {...}, additionalBlocks: [...] } }
 * 3. 块数组 [{ type: "..." }, { type: "..." }]
 * 4. 🆕 裸 inputs 格式 { IF0: {...}, DO0: {...} } - 会尝试推断块类型并包装
 * 
 * @param config 配置对象
 * @param workspace Blockly 工作区
 * @param knownBlockType 已知的块类型（用于裸 inputs 格式）
 */
function fixConfigRecursively(
  config: any,
  workspace?: any,
  knownBlockType?: string
): { fixed: any; wasFixed: boolean; fixInfo: string[] } {
  if (!config || typeof config !== 'object') {
    return { fixed: config, wasFixed: false, fixInfo: [] };
  }
  
  let wasFixed = false;
  const allFixInfo: string[] = [];
  let fixedConfig = config;
  
  // 🔧 处理 structureDefinition 格式
  if (config.structureDefinition) {
    const structDef = config.structureDefinition;
    let fixedStructDef = { ...structDef };
    
    // 🆕 首先提取错误嵌套在 rootBlock 或 inputs 内部的 additionalBlocks 和 connectionRules
    const extracted = extractMisplacedStructureDefinitionParts(structDef.rootBlock);
    if (extracted.wasExtracted) {
      // console.log('[BlockConfigFixer] 🔧 从 rootBlock 中提取了错位的 additionalBlocks/connectionRules');
      
      // 合并提取的 additionalBlocks
      if (extracted.additionalBlocks.length > 0) {
        const existing = fixedStructDef.additionalBlocks || [];
        fixedStructDef.additionalBlocks = [...existing, ...extracted.additionalBlocks];
        wasFixed = true;
        allFixInfo.push(`🔧 提取了 ${extracted.additionalBlocks.length} 个错位的 additionalBlocks`);
      }
      
      // 合并提取的 connectionRules
      if (extracted.connectionRules.length > 0) {
        const existing = fixedStructDef.connectionRules || [];
        fixedStructDef.connectionRules = [...existing, ...extracted.connectionRules];
        wasFixed = true;
        allFixInfo.push(`🔧 提取了 ${extracted.connectionRules.length} 个错位的 connectionRules`);
      }
      
      // 使用清理后的 rootBlock
      fixedStructDef.rootBlock = extracted.cleanedBlock;
    }
    
    // 修复 rootBlock
    if (fixedStructDef.rootBlock) {
      const rootFix = fixBlockRecursively(fixedStructDef.rootBlock, workspace);
      if (rootFix.wasFixed) {
        fixedStructDef.rootBlock = rootFix.fixed;
        wasFixed = true;
        allFixInfo.push(...rootFix.fixInfo);
      }
      
      // 🆕 处理从 rootBlock 递归修复中冒泡上来的 misplacedStructureDefParts
      if (rootFix.misplacedStructureDefParts) {
        if (rootFix.misplacedStructureDefParts.additionalBlocks.length > 0) {
          const existing = fixedStructDef.additionalBlocks || [];
          fixedStructDef.additionalBlocks = [...existing, ...rootFix.misplacedStructureDefParts.additionalBlocks];
          wasFixed = true;
          allFixInfo.push(`🔧 从 rootBlock 递归修复中提取了 ${rootFix.misplacedStructureDefParts.additionalBlocks.length} 个错位的 additionalBlocks`);
        }
        if (rootFix.misplacedStructureDefParts.connectionRules.length > 0) {
          const existing = fixedStructDef.connectionRules || [];
          fixedStructDef.connectionRules = [...existing, ...rootFix.misplacedStructureDefParts.connectionRules];
          wasFixed = true;
          allFixInfo.push(`🔧 从 rootBlock 递归修复中提取了 ${rootFix.misplacedStructureDefParts.connectionRules.length} 个错位的 connectionRules`);
        }
      }
    }
    
    // 修复 additionalBlocks 数组中的每个块
    if (Array.isArray(fixedStructDef.additionalBlocks)) {
      const fixedAdditionalBlocks: any[] = [];
      for (const block of fixedStructDef.additionalBlocks) {
        const blockFix = fixBlockRecursively(block, workspace);
        fixedAdditionalBlocks.push(blockFix.fixed);
        if (blockFix.wasFixed) {
          wasFixed = true;
          allFixInfo.push(...blockFix.fixInfo);
        }
      }
      fixedStructDef.additionalBlocks = fixedAdditionalBlocks;
    }
    
    fixedConfig = { ...config, structureDefinition: fixedStructDef };
    return { fixed: fixedConfig, wasFixed, fixInfo: allFixInfo };
  }
  
  // 🔧 处理数组格式（块数组）
  if (Array.isArray(config)) {
    const fixedArray: any[] = [];
    for (const item of config) {
      const itemFix = fixBlockRecursively(item, workspace);
      fixedArray.push(itemFix.fixed);
      if (itemFix.wasFixed) {
        wasFixed = true;
        allFixInfo.push(...itemFix.fixInfo);
      }
    }
    return { fixed: fixedArray, wasFixed, fixInfo: allFixInfo };
  }
  
  // 🔧 检测并修复 "裸 inputs" 格式
  // 当 LLM 返回的 JSON 只有 inputs 内容，没有块定义时
  // 例如: { "IF0": {...}, "DO0": {...} } 而不是 { "type": "controls_if", "inputs": {...} }
  if (!config.type && !config.structureDefinition) {
    const bareInputsFix = tryFixBareInputsFormat(config, workspace, knownBlockType);
    if (bareInputsFix.wasFixed) {
      // console.log(`[BlockConfigFixer] 检测到裸 inputs 格式，已包装为块定义`);
      // 对包装后的块定义进行递归修复
      const wrappedFix = fixBlockRecursively(bareInputsFix.fixed, workspace);
      return {
        fixed: wrappedFix.fixed,
        wasFixed: true,
        fixInfo: [...bareInputsFix.fixInfo, ...wrappedFix.fixInfo]
      };
    }
  }
  
  // 🔧 处理单个块定义
  return fixBlockRecursively(config, workspace);
}

// =============================================================================
// 主入口函数
// =============================================================================

/**
 * 统一的块配置修复管道
 * 
 * 分两个阶段处理：
 * 1. JSON 语法修复（如果输入是字符串）
 * 2. 结构语义修复（处理错误嵌套）
 * 
 * @param input JSON 字符串或已解析的配置对象
 * @param options 修复选项
 * @returns 修复结果
 * 
 * @example
 * // 字符串输入
 * const result = fixBlockConfig('{"type":"controls_if","inputs":{"IF0":{"block":{...},"DO0":{...}}', { workspace });
 * 
 * // 对象输入
 * const result = fixBlockConfig(parsedConfig, { workspace });
 */
export function fixBlockConfig(
  input: string | object,
  options: BlockConfigFixOptions = {}
): BlockConfigFixResult {
  const {
    enableJsonFix = true,
    enableStructureFix = true,
    logProcess = false,
    workspace,
    knownBlockType
  } = options;
  
  const result: BlockConfigFixResult = {
    fixed: null,
    wasFixed: false,
    stages: {
      jsonRepair: { applied: false, changes: [] },
      structureFix: { applied: false, changes: [] }
    },
    originalInput: input
  };
  
  let parsedConfig: any;
  
  // ==========================================================================
  // 阶段1: JSON 语法修复
  // ==========================================================================
  if (typeof input === 'string') {
    if (enableJsonFix) {
      if (logProcess) {
        // console.log('[BlockConfigFixer] 阶段1: JSON 语法修复');
      }
      
      const jsonFixResult = baseFixJsonString(input, {
        useJsonRepair: true,
        enableBracesFix: true,
        enableBracketsFix: true,
        enableQuotesFix: true,
        enableSyntaxFix: true,
        logProcess
      });
      
      result.stages.jsonRepair.applied = jsonFixResult.success;
      result.stages.jsonRepair.changes = jsonFixResult.changes;
      
      if (!jsonFixResult.success) {
        result.stages.jsonRepair.error = jsonFixResult.error;
        result.fixed = input; // 返回原始输入
        return result;
      }
      
      try {
        parsedConfig = JSON.parse(jsonFixResult.fixed);
        if (jsonFixResult.changes.length > 0) {
          result.wasFixed = true;
        }
      } catch (e) {
        result.stages.jsonRepair.error = `JSON 解析失败: ${(e as Error).message}`;
        result.fixed = input;
        return result;
      }
    } else {
      // 不启用 JSON 修复，直接解析
      try {
        parsedConfig = JSON.parse(input);
      } catch (e) {
        result.stages.jsonRepair.error = `JSON 解析失败: ${(e as Error).message}`;
        result.fixed = input;
        return result;
      }
    }
  } else {
    // 输入已经是对象
    parsedConfig = input;
  }
  
  // ==========================================================================
  // 阶段2: 结构语义修复
  // ==========================================================================
  if (enableStructureFix && parsedConfig && typeof parsedConfig === 'object') {
    // console.log('[BlockConfigFixer] 阶段2: 开始结构语义修复');
    
    // 处理数组（批量块定义）
    if (Array.isArray(parsedConfig)) {
      const fixedArray: any[] = [];
      for (const item of parsedConfig) {
        const itemFix = fixConfigRecursively(item, workspace, knownBlockType);
        fixedArray.push(itemFix.fixed);
        if (itemFix.wasFixed) {
          result.wasFixed = true;
          result.stages.structureFix.applied = true;
          result.stages.structureFix.changes.push(...itemFix.fixInfo);
        }
      }
      parsedConfig = fixedArray;
    } else {
      // 处理单个块定义（或 structureDefinition 格式，或裸 inputs 格式）
      const configType = parsedConfig.structureDefinition 
        ? 'structureDefinition格式' 
        : parsedConfig.type 
          ? `块定义(${parsedConfig.type})` 
          : knownBlockType
            ? `裸inputs格式（已知类型: ${knownBlockType}）`
            : '未知格式（可能是裸inputs）';
      // console.log(`[BlockConfigFixer] 检测配置类型: ${configType}`);
      const structureFix = fixConfigRecursively(parsedConfig, workspace, knownBlockType);
      if (structureFix.wasFixed) {
        parsedConfig = structureFix.fixed;
        result.wasFixed = true;
        result.stages.structureFix.applied = true;
        result.stages.structureFix.changes = structureFix.fixInfo;
      }
    }
    
    if (result.stages.structureFix.changes.length > 0) {
      // console.log('[BlockConfigFixer] 结构修复详情:');
      result.stages.structureFix.changes.forEach(change => {
        // console.log(`  ${change}`);
      });
      // 输出修复后的 JSON 结构（用于调试）
      // console.log('[BlockConfigFixer] 修复后的 JSON 结构:');
      // console.log(JSON.stringify(parsedConfig, null, 2));
    } else {
      // console.log('[BlockConfigFixer] 结构检查完成，无需修复');
    }
  }
  
  // 🔑 关键：当提供了 knownBlockType 时，说明调用者期望返回 inputs 对象
  // 如果修复过程中把裸 inputs 包装成了完整块定义，需要提取 inputs 部分返回
  if (knownBlockType && 
      parsedConfig && 
      typeof parsedConfig === 'object' && 
      parsedConfig.type === knownBlockType && 
      parsedConfig.inputs) {
    // console.log(`[BlockConfigFixer] 已知块类型 ${knownBlockType}，提取 inputs 返回`);
    result.fixed = parsedConfig.inputs;
  } else {
    result.fixed = parsedConfig;
  }
  
  return result;
}

/**
 * 简化版修复函数 - 直接返回修复后的配置
 * 
 * @param input JSON 字符串或配置对象
 * @param workspace Blockly 工作区（可选，用于更精确的修复）
 * @returns 修复后的配置对象，如果修复失败返回 null
 */
export function fixBlockConfigSimple(
  input: string | object,
  workspace?: any
): any | null {
  const result = fixBlockConfig(input, { workspace });
  return result.fixed;
}

/**
 * 仅进行结构修复（输入已经是有效的对象）
 * 
 * @param config 已解析的配置对象
 * @param workspace Blockly 工作区
 * @returns 修复结果
 */
export function fixBlockStructure(
  config: any,
  workspace?: any
): { fixed: any; wasFixed: boolean; changes: string[] } {
  const result = fixConfigRecursively(config, workspace);
  return {
    fixed: result.fixed,
    wasFixed: result.wasFixed,
    changes: result.fixInfo
  };
}
