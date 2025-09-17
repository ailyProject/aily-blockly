import { arduinoGenerator } from "../../../editors/blockly-editor/components/blockly/generators/arduino/arduino";
import { ToolUseResult } from "./tools";
import { jsonrepair } from 'jsonrepair';
declare const Blockly: any;

/**
 * Blockly 可视化编程助手 - 高级块编辑工具
 * 提供简化的 Blockly 块操作接口，避免复杂的 ABI JSON 生成
 */

// =============================================================================
// 类型定义
// =============================================================================

interface Position {
  x?: number;
  y?: number;
}

interface BlockReference {
  id?: string;
  type?: string;
  position?: 'first' | 'last' | 'selected';
}

interface FieldConfig {
  [fieldName: string]: any;
}

interface InputConfig {
  [inputName: string]: {
    block?: BlockConfig;
    shadow?: BlockConfig;
    connection?: 'value' | 'statement';
  };
}

interface BlockConfig {
  type: string;
  fields?: FieldConfig;
  inputs?: InputConfig;
  position?: Position;
  id?: string;
  next?: {                    // 新增：下一个连接的块
    block: BlockConfig;
  };
}

interface ConnectionConfig {
  blockId: string;
  connectionType: 'next' | 'input';
  inputName?: string;
}

interface VariableConfig {
  name: string;
  type: 'int' | 'float' | 'string' | 'bool';
  scope: 'global' | 'local';
  initialValue?: any;
  autoDefine?: boolean;
}

// =============================================================================
// 主要工具函数
// =============================================================================

/**
 * � 块ID模糊匹配函数
 * 解决AI模型传递blockId时可能多字符或少字符的问题
 * 
 * @param providedId 模型提供的块ID（可能有偏差）
 * @param workspace Blockly工作区对象
 * @returns 匹配到的真实块对象，如果没找到返回null
 */
function findBlockByFuzzyId(providedId: string, workspace: any): any | null {
  if (!providedId || !workspace) {
    console.log('⚠️ findBlockByFuzzyId: 参数无效');
    return null;
  }

  console.log(`🔍 开始模糊匹配块ID: "${providedId}"`);
  
  // 获取工作区中的所有块
  const allBlocks = workspace.getAllBlocks();
  if (!allBlocks || allBlocks.length === 0) {
    console.log('⚠️ 工作区中没有找到任何块');
    return null;
  }

  console.log(`📊 工作区中共有 ${allBlocks.length} 个块`);
  
  // 1. 首先尝试精确匹配
  for (const block of allBlocks) {
    if (block.id === providedId) {
      console.log(`✅ 精确匹配成功: ${block.type}(${block.id})`);
      return block;
    }
  }
  console.log('⚠️ 精确匹配失败，尝试模糊匹配...');

  // 2. 模糊匹配策略
  const matches: Array<{block: any, score: number, reason: string}> = [];
  
  for (const block of allBlocks) {
    const blockId = block.id;
    let score = 0;
    let reason = '';
    
    // 策略1: 包含匹配 - 较短的ID在较长的ID中连续存在
    if (providedId.length > blockId.length && providedId.includes(blockId)) {
      score = 90;
      reason = `工作区ID "${blockId}" 连续包含在提供的ID "${providedId}" 中`;
    } else if (blockId.length > providedId.length && blockId.includes(providedId)) {
      score = 85;
      reason = `提供的ID "${providedId}" 连续包含在工作区ID "${blockId}" 中`;
    }
    
    // 策略2: 前缀匹配
    else if (blockId.startsWith(providedId) || providedId.startsWith(blockId)) {
      const minLength = Math.min(blockId.length, providedId.length);
      const maxLength = Math.max(blockId.length, providedId.length);
      score = (minLength / maxLength) * 80;
      reason = `前缀匹配: "${providedId}" 与 "${blockId}" 有共同前缀`;
    }
    
    // 策略3: 后缀匹配
    else if (blockId.endsWith(providedId) || providedId.endsWith(blockId)) {
      const minLength = Math.min(blockId.length, providedId.length);
      const maxLength = Math.max(blockId.length, providedId.length);
      score = (minLength / maxLength) * 75;
      reason = `后缀匹配: "${providedId}" 与 "${blockId}" 有共同后缀`;
    }
    
    // 策略4: 编辑距离匹配（用于处理1-2个字符的差异）
    else {
      const editDistance = calculateEditDistance(providedId, blockId);
      const maxLength = Math.max(providedId.length, blockId.length);
      if (editDistance <= 2 && maxLength > 5) { // 最多允许2个字符差异，且ID足够长
        score = ((maxLength - editDistance) / maxLength) * 70;
        reason = `编辑距离匹配: "${providedId}" 与 "${blockId}" 相似度高(距离=${editDistance})`;
      }
    }
    
    if (score > 0) {
      matches.push({block, score, reason});
      console.log(`🎯 候选匹配: ${block.type}(${blockId}) - 得分: ${score.toFixed(2)} - ${reason}`);
    }
  }
  
  if (matches.length === 0) {
    console.log('❌ 未找到任何匹配的块');
    return null;
  }
  
  // 按得分排序，选择最佳匹配
  matches.sort((a, b) => b.score - a.score);
  const bestMatch = matches[0];
  
  console.log(`🏆 最佳匹配: ${bestMatch.block.type}(${bestMatch.block.id})`);
  console.log(`📊 匹配得分: ${bestMatch.score.toFixed(2)}`);
  console.log(`📋 匹配原因: ${bestMatch.reason}`);
  
  // 如果最佳匹配得分太低，拒绝匹配
  if (bestMatch.score < 60) {
    console.log('⚠️ 最佳匹配得分过低，拒绝匹配');
    return null;
  }
  
  // 如果有多个高分匹配，提醒可能存在歧义
  const highScoreMatches = matches.filter(m => m.score >= bestMatch.score - 10);
  if (highScoreMatches.length > 1) {
    console.log(`⚠️ 检测到 ${highScoreMatches.length} 个高分匹配，可能存在歧义:`);
    highScoreMatches.forEach(m => {
      console.log(`   - ${m.block.type}(${m.block.id}) - 得分: ${m.score.toFixed(2)}`);
    });
  }
  
  return bestMatch.block;
}

/**
 * 🎯 智能获取块函数（支持模糊匹配）
 * 先尝试精确匹配，如果失败则使用模糊匹配
 * 
 * @param workspace Blockly工作区对象
 * @param blockId 块ID（可能有偏差）
 * @returns 匹配到的块对象，如果没找到返回null
 */
function getBlockByIdSmart(workspace: any, blockId: string): any | null {
  if (!workspace || !blockId) {
    console.log('⚠️ getBlockByIdSmart: 参数无效');
    return null;
  }

  console.log(`🎯 智能获取块: "${blockId}"`);
  
  // 首先尝试原有的精确匹配
  let block = workspace.getBlockById(blockId);
  if (block) {
    console.log(`✅ 精确匹配成功: ${block.type}(${block.id})`);
    return block;
  }
  
  console.log('⚠️ 精确匹配失败，尝试模糊匹配...');
  
  // 使用模糊匹配
  block = findBlockByFuzzyId(blockId, workspace);
  if (block) {
    console.log(`✅ 模糊匹配成功: ${block.type}(${block.id})`);
    return block;
  }
  
  console.log('❌ 模糊匹配也失败了');
  return null;
}

/**
 * 计算两个字符串的编辑距离（Levenshtein Distance）
 */
function calculateEditDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];
  
  // 初始化矩阵
  for (let i = 0; i <= str1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str2.length; j++) {
    matrix[0][j] = j;
  }
  
  // 填充矩阵
  for (let i = 1; i <= str1.length; i++) {
    for (let j = 1; j <= str2.length; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,     // 删除
          matrix[i][j - 1] + 1,     // 插入
          matrix[i - 1][j - 1] + 1  // 替换
        );
      }
    }
  }
  
  return matrix[str1.length][str2.length];
}

/**
 * �🔧 JSON 修复工具函数（增强版）
 * 结合 jsonrepair 库和自定义修复逻辑，提供强大的 JSON 修复能力
 * 
 * @param jsonString 待修复的 JSON 字符串
 * @param options 修复选项
 * @returns 修复后的 JSON 字符串
 */
interface JsonFixOptions {
  useJsonRepair?: boolean;        // 是否优先使用 jsonrepair 库
  enableBracesFix?: boolean;      // 修复缺少的大括号
  enableBracketsFix?: boolean;    // 修复缺少的方括号
  enableQuotesFix?: boolean;      // 修复缺少的引号
  enableSyntaxFix?: boolean;      // 修复语法错误（逗号等）
  logProcess?: boolean;           // 记录修复过程
}

export function fixJsonString(
  jsonString: string, 
  options: JsonFixOptions = {}
): { 
  fixed: string; 
  success: boolean; 
  changes: string[]; 
  error?: string 
} {
  const {
    useJsonRepair = true,
    enableBracesFix = true,
    enableBracketsFix = true,
    enableQuotesFix = true,
    enableSyntaxFix = true,
    logProcess = false
  } = options;

  const changes: string[] = [];
  let fixedJson = jsonString.trim();

  if (logProcess) {
    console.log(`🔧 开始修复 JSON (长度: ${jsonString.length}): ${jsonString}`);
  }

  // 首先尝试直接解析
  try {
    JSON.parse(fixedJson);
    if (logProcess) {
      console.log(`✅ 原始 JSON 已经正确，无需修复`);
    }
    return { 
      fixed: fixedJson, 
      success: true, 
      changes: ['原始 JSON 已经正确，无需修复'] 
    };
  } catch (originalError) {
    if (logProcess) {
      console.log(`❌ 原始 JSON 解析失败: ${(originalError as Error).message}`);
    }
  }

  // 方法1: 优先使用 jsonrepair 库进行修复
  if (useJsonRepair) {
    try {
      if (logProcess) {
        console.log(`🔧 尝试使用 jsonrepair 库修复...`);
      }
      
      const repairedJson = jsonrepair(fixedJson);
      
      // 验证修复结果
      JSON.parse(repairedJson);
      
      changes.push('使用 jsonrepair 库成功修复');
      if (logProcess) {
        console.log(`✅ jsonrepair 修复成功`);
        console.log(`🔧 修复后 JSON: ${repairedJson}`);
      }
      
      return {
        fixed: repairedJson,
        success: true,
        changes
      };
    } catch (jsonrepairError) {
      if (logProcess) {
        console.log(`⚠️ jsonrepair 修复失败: ${(jsonrepairError as Error).message}`);
        console.log(`🔧 继续尝试自定义修复逻辑...`);
      }
      changes.push(`jsonrepair 修复失败: ${(jsonrepairError as Error).message}`);
    }
  }

  // 方法2: 自定义修复逻辑（备用方案）
  if (logProcess) {
    console.log(`🔧 使用自定义修复逻辑...`);
  }

  // 1. 修复缺少的右大括号
  if (enableBracesFix) {
    const leftBraces = (fixedJson.match(/\{/g) || []).length;
    const rightBraces = (fixedJson.match(/\}/g) || []).length;
    if (leftBraces > rightBraces) {
      const missingBraces = leftBraces - rightBraces;
      fixedJson += '}'.repeat(missingBraces);
      changes.push(`自定义修复: 添加了 ${missingBraces} 个缺少的右大括号`);
      if (logProcess) {
        console.log(`🔧 添加了 ${missingBraces} 个缺少的右大括号`);
      }
    }
  }

  // 2. 修复缺少的右方括号
  if (enableBracketsFix) {
    const leftBrackets = (fixedJson.match(/\[/g) || []).length;
    const rightBrackets = (fixedJson.match(/\]/g) || []).length;
    if (leftBrackets > rightBrackets) {
      const missingBrackets = leftBrackets - rightBrackets;
      fixedJson += ']'.repeat(missingBrackets);
      changes.push(`自定义修复: 添加了 ${missingBrackets} 个缺少的右方括号`);
      if (logProcess) {
        console.log(`🔧 添加了 ${missingBrackets} 个缺少的右方括号`);
      }
    }
  }

  // 3. 修复缺少的引号
  if (enableQuotesFix) {
    if (fixedJson.includes('"') && (fixedJson.match(/"/g) || []).length % 2 !== 0) {
      // 智能添加结束引号
      if (!fixedJson.endsWith('"') && !fixedJson.endsWith('"}') && !fixedJson.endsWith('"}}')) {
        const lastQuoteIndex = fixedJson.lastIndexOf('"');
        const afterLastQuote = fixedJson.substring(lastQuoteIndex + 1);
        if (!/^[}\]]*$/.test(afterLastQuote)) {
          // 在适当位置插入引号
          let insertIndex = fixedJson.length;
          while (insertIndex > 0 && /[}\]]/.test(fixedJson[insertIndex - 1])) {
            insertIndex--;
          }
          fixedJson = fixedJson.substring(0, insertIndex) + '"' + fixedJson.substring(insertIndex);
          changes.push('自定义修复: 添加了缺少的结束引号');
          if (logProcess) {
            console.log(`🔧 添加了缺少的结束引号`);
          }
        }
      }
    }
  }

  // 第一次自定义修复尝试
  try {
    JSON.parse(fixedJson);
    if (logProcess) {
      console.log(`✅ 自定义基础修复成功: ${fixedJson}`);
    }
    return { 
      fixed: fixedJson, 
      success: true, 
      changes 
    };
  } catch (basicFixError) {
    if (logProcess) {
      console.log(`⚠️ 自定义基础修复后仍有错误: ${(basicFixError as Error).message}`);
    }
  }

  // 4. 高级语法修复
  if (enableSyntaxFix) {
    try {
      let advancedFix = fixedJson;

      // 修复混合的括号顺序
      advancedFix = advancedFix.replace(/(\}+)(\]+)/g, (match, braces, brackets) => {
        const braceCount = braces.length;
        const bracketCount = brackets.length;
        let result = '';
        let i = 0, j = 0;
        while (i < braceCount || j < bracketCount) {
          if (i < braceCount) result += '}';
          i++;
          if (j < bracketCount) result += ']';
          j++;
        }
        return result;
      });

      // 移除多余的逗号
      advancedFix = advancedFix.replace(/,\s*([}\]])/g, '$1');
      
      // 在对象/数组之间添加逗号
      advancedFix = advancedFix.replace(/([}\]])([{\[])/g, '$1,$2');

      // 修复奇数引号
      if (advancedFix.includes('"') && (advancedFix.match(/"/g) || []).length % 2 !== 0) {
        advancedFix += '"';
        changes.push('自定义修复: 修复了奇数引号');
      }

      JSON.parse(advancedFix);
      changes.push('自定义修复: 应用了高级语法修复');
      if (logProcess) {
        console.log(`✅ 自定义高级修复成功: ${advancedFix}`);
      }
      return { 
        fixed: advancedFix, 
        success: true, 
        changes 
      };

    } catch (advancedFixError) {
      if (logProcess) {
        console.log(`❌ 自定义高级修复也失败: ${(advancedFixError as Error).message}`);
      }
    }
  }

  // 所有修复尝试都失败
  const errorMessage = `所有修复尝试都失败了。尝试的方法: ${changes.length > 0 ? changes.join(', ') : '无'}`;
  if (logProcess) {
    console.log(`❌ ${errorMessage}`);
  }
  
  return { 
    fixed: fixedJson, 
    success: false, 
    changes, 
    error: errorMessage
  };
}

/**
 * 🔧 简化版 JSON 修复函数（增强版）
 * 只关注修复结果，不返回详细信息
 * 
 * @param jsonString 待修复的 JSON 字符串
 * @returns 修复后的 JSON 字符串，如果修复失败则返回 null
 */
export function simpleFixJson(jsonString: string): string | null {
  try {
    JSON.parse(jsonString);
    return jsonString;
  } catch {
    // 尝试 jsonrepair 修复
    try {
      const repaired = jsonrepair(jsonString);
      JSON.parse(repaired); // 验证修复结果
      return repaired;
    } catch {
      // jsonrepair 失败，使用自定义修复
      const result = fixJsonString(jsonString, { 
        useJsonRepair: false,
        logProcess: false 
      });
      return result.success ? result.fixed : null;
    }
  }
}

/**
 * 1. 智能块创建工具
 */
interface SmartBlockArgs {
  type: string;
  id?: string;  // 新增：自定义块ID参数
  position?: Position;
  fields?: FieldConfig;
  inputs?: InputConfig;
  parentConnection?: ConnectionConfig;
  createVariables?: boolean;
}

interface SmartBlockResult extends ToolUseResult {
  metadata?: {
    blockId: string;
    blockType: string;
    position: Position;
    variablesCreated?: string[];
  };
}

export async function smartBlockTool(
  toolArgs: SmartBlockArgs
): Promise<SmartBlockResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🚀 smartBlockTool 开始执行');
  console.log('📦 接收到的参数:', JSON.stringify(toolArgs, null, 2));

  try {
    let { type, id, position, fields, inputs, parentConnection, createVariables = true } = toolArgs;

    // 🔧 参数修复和转换
    console.log('� 开始参数修复和转换...');
    
    // 修复 position 参数
    if (typeof position === 'string') {
      console.log(`⚠️ position 是字符串 "${position}"，尝试解析...`);
      try {
        // 尝试解析为 JSON 对象
        if ((position as string).trim().startsWith('{')) {
          position = JSON.parse(position as string);
          console.log(`✅ position JSON 解析成功: ${JSON.stringify(position)}`);
        }
        // 尝试解析为逗号分隔的坐标
        else if ((position as string).includes(',')) {
          const [x, y] = (position as string).split(',').map(v => parseInt(v.trim()) || 0);
          position = { x, y };
          console.log(`✅ position 坐标解析成功: ${JSON.stringify(position)}`);
        } 
        // 默认位置
        else {
          position = { x: 0, y: 0 };
          console.log(`✅ position 设为默认值: ${JSON.stringify(position)}`);
        }
      } catch (error) {
        console.error(`❌ position 解析失败: ${(error as Error).message}`);
        position = { x: 0, y: 0 };
        console.log(`✅ position 设为默认值: ${JSON.stringify(position)}`);
      }
    }

    // 修复 fields 参数
    if (typeof fields === 'string') {
      console.log(`⚠️ fields 是字符串 "${fields}"，尝试解析...`);
      try {
        if ((fields as string).trim()) {
          fields = JSON.parse(fields as string);
          console.log(`✅ fields 修复为: ${JSON.stringify(fields)}`);
        } else {
          fields = null;
          console.log(`✅ fields 设为 null`);
        }
      } catch (error) {
        console.error(`❌ fields 解析失败: ${(error as Error).message}`);
        fields = null;
      }
    }

    // 修复 inputs 参数
    if (typeof inputs === 'string') {
      console.log(`⚠️ inputs 是字符串 "${inputs}"，尝试解析...`);
      
      if ((inputs as string).trim() && inputs !== '{}') {
        // 🔧 使用独立的 JSON 修复函数
        const fixResult = fixJsonString(inputs as string, { logProcess: true });
        
        if (fixResult.success) {
          console.log(`✅ JSON 修复成功，应用的修复: ${fixResult.changes.join(', ')}`);
          try {
            inputs = JSON.parse(fixResult.fixed);
            console.log(`✅ inputs JSON 解析成功: ${JSON.stringify(inputs)}`);
          } catch (parseError) {
            console.error(`❌ 修复后的 JSON 仍然无法解析: ${(parseError as Error).message}`);
            inputs = null;
          }
        } else {
          console.error(`❌ JSON 修复失败: ${fixResult.error}`);
          console.error(`❌ 尝试的修复: ${fixResult.changes.join(', ')}`);
          inputs = null;
        }
      } else {
        inputs = null;
        console.log(`✅ inputs 设为 null（空字符串或仅包含 {}）`);
      }
    }

    // 🔄 转换简化的 inputs 格式为标准格式
    if (inputs && typeof inputs === 'object') {
      console.log('🔄 检查并转换 inputs 格式...');
      const convertedInputs: InputConfig = {};
      let hasConversions = false;

      for (const [inputName, inputConfig] of Object.entries(inputs)) {
        console.log(`🔍 检查输入 "${inputName}":`, JSON.stringify(inputConfig));
        
        // 检查是否是简化格式: { type: "xxx", value: "yyy" }
        if (inputConfig && 
            typeof inputConfig === 'object' && 
            'type' in inputConfig && 
            'value' in inputConfig &&
            !('block' in inputConfig) && 
            !('shadow' in inputConfig)) {
          
          console.log(`⚙️ 发现简化格式，进行转换: ${inputName}`);
          
          // 根据块类型确定字段名
          const blockType = (inputConfig as any).type;
          const blockValue = (inputConfig as any).value;
          let fieldName = 'TEXT'; // 默认字段名
          
          // 根据不同的块类型设置正确的字段名
          switch (blockType) {
            case 'text':
              fieldName = 'TEXT';
              break;
            case 'math_number':
              fieldName = 'NUM';
              break;
            case 'logic_boolean':
              fieldName = 'BOOL';
              break;
            case 'variables_get':
              fieldName = 'VAR';
              break;
            default:
              // 对于其他类型，尝试常见的字段名
              fieldName = 'TEXT';
              console.log(`⚠️ 未知块类型 "${blockType}"，使用默认字段名 "TEXT"`);
          }
          
          // 转换为标准格式
          convertedInputs[inputName] = {
            block: {
              type: blockType,
              fields: {
                [fieldName]: blockValue
              }
            }
          };
          
          console.log(`✅ 转换完成: ${inputName} → block.${blockType}.fields.${fieldName} = "${blockValue}"`);
          hasConversions = true;
        } else {
          // 已经是标准格式，直接使用
          convertedInputs[inputName] = inputConfig as any;
          console.log(`✅ 标准格式，直接使用: ${inputName}`);
        }
      }
      
      if (hasConversions) {
        inputs = convertedInputs;
        console.log(`🎉 inputs 格式转换完成: ${JSON.stringify(inputs, null, 2)}`);
      } else {
        console.log(`ℹ️ inputs 已经是标准格式，无需转换`);
      }
    }

    // 修复 parentConnection 参数
    if (typeof parentConnection === 'string') {
      console.log(`⚠️ parentConnection 是字符串 "${parentConnection}"，尝试解析...`);
      
      if (!(parentConnection as string).trim()) {
        parentConnection = null;
        console.log(`✅ parentConnection 设为 null`);
      } else if ((parentConnection as string).trim().startsWith('{')) {
        // 🔧 解析 JSON 字符串格式的 parentConnection
        try {
          parentConnection = JSON.parse(parentConnection as string);
          console.log(`✅ parentConnection JSON 解析成功: ${JSON.stringify(parentConnection)}`);
        } catch (parseError) {
          console.error(`❌ parentConnection JSON 解析失败: ${(parseError as Error).message}`);
          parentConnection = null;
        }
      }
    }

    console.log('🔍 修复后的参数:');
    console.log(`  - 块类型: ${type}`);
    console.log(`  - 自定义ID: ${id || '未指定'}`);
    console.log(`  - 位置: ${JSON.stringify(position)}`);
    console.log(`  - 字段: ${JSON.stringify(fields)}`);
    console.log(`  - 输入: ${JSON.stringify(inputs)}`);
    console.log(`  - 父级连接: ${JSON.stringify(parentConnection)}`);
    console.log(`  - 创建变量: ${createVariables}`);

    // 验证参数
    if (!type || typeof type !== 'string') {
      throw new Error('参数 "type" 是必需的，且必须是字符串类型');
    }

    // 获取工作区
    console.log('🎯 获取 Blockly 工作区...');
    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    // 检查块类型是否存在
    console.log(`🔎 检查块类型 "${type}" 是否注册...`);
    if (!window['Blockly']?.Blocks[type]) {
      throw new Error(`Block 类型 "${type}" 不存在或未注册`);
    }
    console.log(`✅ 块类型 "${type}" 已注册`);

    // 创建块
    console.log(`🏗️ 创建块 "${type}"...`);
    if (id) {
      console.log(`🆔 将使用自定义ID: ${id}`);
    }
    const blockPosition = calculateBlockPosition(workspace, position?.x, position?.y);
    console.log(`📍 计算得到的位置: ${JSON.stringify(blockPosition)}`);
    const block = await createBlockSafely(workspace, type, blockPosition, false, id);

    if (!block) {
      throw new Error(`创建 Block "${type}" 失败`);
    }
    console.log(`✅ 块创建成功, ID: ${block.id}`);

    // 配置字段
    if (fields) {
      console.log('🏷️ 配置字段...');
      console.log('字段数据:', JSON.stringify(fields));
      await configureBlockFields(block, fields);
      console.log('✅ 字段配置完成');
    }

    // 处理变量创建
    const variablesCreated: string[] = [];
    if (createVariables && fields) {
      console.log('📝 处理变量创建...');
      const createdVars = await createVariablesFromFields(workspace, fields);
      variablesCreated.push(...createdVars);
      console.log(`✅ 创建了 ${createdVars.length} 个变量: ${createdVars.join(', ')}`);
    }

    // 配置输入
    if (inputs) {
      console.log('🔌 配置输入...');
      console.log('输入数据:', JSON.stringify(inputs));
      await configureBlockInputs(workspace, block, inputs);
      console.log('✅ 输入配置完成');
    } else {
      console.log('ℹ️ 没有输入数据需要配置');
    }

    // 处理父级连接（可选）
    let smartInsertionResult = null;
    if (parentConnection && parentConnection.blockId) {
      try {
        smartInsertionResult = await connectToParentBlock(workspace, block, parentConnection);
        console.log('✅ 父级连接成功:', smartInsertionResult);
      } catch (error) {
        console.warn('连接到父级块失败，但块已成功创建:', error);
        // 不抛出错误，允许块独立存在
      }
    }

    metadata = {
      blockId: block.id,
      blockType: type,
      position: blockPosition,
      variablesCreated: variablesCreated.length > 0 ? variablesCreated : undefined,
      smartInsertion: smartInsertionResult?.smartInsertion || false,
      autoMovedBlock: smartInsertionResult?.autoMovedBlock || null
    };

    // 根据是否发生智能插入来生成结果消息
    let resultMessage = `成功创建 Block "${type}"`;
    if (variablesCreated.length > 0) {
      resultMessage += `，创建了变量: ${variablesCreated.join(', ')}`;
    }
    if (smartInsertionResult?.smartInsertion && smartInsertionResult?.autoMovedBlock) {
      resultMessage += `，并智能插入到父级块，自动后移了 "${smartInsertionResult.autoMovedBlock}" 块`;
    } else if (smartInsertionResult?.smartInsertion) {
      resultMessage += `，并智能插入到父级块`;
    }
    
    toolResult = resultMessage;

  } catch (error) {
    is_error = true;
    toolResult = `创建 Block 失败: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // 确保事件组正确清理，避免拖动时的事件冲突
    ensureEventGroupCleanup();
  }

  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 2. 块连接工具
 */
interface ConnectBlocksArgs {
  sourceBlock: string | BlockConfig; // 输出块（提供连接的块）
  targetBlock: string | BlockConfig; // 接收块（接收连接的块）
  connectionType: 'next' | 'input' | 'stack' | 'statement';
  inputName?: string; // 目标块的输入名称
}

interface ConnectBlocksResult extends ToolUseResult {
  metadata?: {
    sourceBlockId: string;  // 输出块ID
    targetBlockId: string;  // 接收块ID
    connectionType: string;
    inputName?: string;
  };
}

/**
 * 解析块ID，支持新的安全格式和旧格式
 */
function parseBlockId(blockRef: string | BlockConfig): string {
  if (typeof blockRef !== 'string') {
    return blockRef.id;
  }
  
  // 检查是否是新的安全格式：type[ID:"blockId"]
  const safeFormatMatch = blockRef.match(/\[ID:"([^"]+)"\]$/);
  if (safeFormatMatch) {
    return safeFormatMatch[1];
  }
  
  // 检查是否是旧格式：type(blockId)
  const oldFormatMatch = blockRef.match(/\(([^)]+)\)$/);
  if (oldFormatMatch) {
    return oldFormatMatch[1];
  }
  
  // 如果都不匹配，直接返回原字符串作为ID
  return blockRef;
}

export async function connectBlocksTool(
  toolArgs: ConnectBlocksArgs
): Promise<ConnectBlocksResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🔗 connectBlocksTool 开始执行');
  console.log('📦 接收到的参数:', JSON.stringify(toolArgs, null, 2));

  try {
    const { sourceBlock, targetBlock, connectionType, inputName } = toolArgs;

    console.log('🎯 获取 Blockly 工作区...');
    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    console.log('🔍 获取或创建源块和目标块...');
    // 获取或创建源块
    const sourceBlockObj = await getOrCreateBlock(workspace, sourceBlock);
    const targetBlockObj = await getOrCreateBlock(workspace, targetBlock);

    console.log('📊 块获取结果:');
    console.log(`  - 源块: ${sourceBlockObj ? `${sourceBlockObj.type}(${sourceBlockObj.id})` : 'null'}`);
    console.log(`  - 目标块: ${targetBlockObj ? `${targetBlockObj.type}(${targetBlockObj.id})` : 'null'}`);

    if (!sourceBlockObj) {
      throw new Error(`无法找到源块: ${typeof sourceBlock === 'string' ? sourceBlock : JSON.stringify(sourceBlock)}`);
    }

    if (!targetBlockObj) {
      throw new Error(`无法找到目标块: ${typeof targetBlock === 'string' ? targetBlock : JSON.stringify(targetBlock)}`);
    }

    console.log(`🔗 执行连接: ${connectionType}`);
    
    // 🎯 智能连接类型优化：如果使用 statement 类型，先检查源块是否真的是容器块
    let optimizedConnectionType = connectionType;
    let optimizedInputName = inputName;
    
    if (connectionType === 'statement') {
      // 动态检测容器块 - 使用 window['Blockly'] 常量
      console.log('🔍 开始 statement 连接检测...');
      console.log('📊 源块信息:', {
        type: sourceBlockObj.type,
        id: sourceBlockObj.id,
        hasInputList: !!sourceBlockObj.inputList,
        inputListLength: sourceBlockObj.inputList?.length || 0
      });
      
      // 检查 Blockly 常量是否可用
      const INPUT_STATEMENT_CONSTANT = window['Blockly']?.INPUT_STATEMENT;
      console.log('🔢 INPUT_STATEMENT 常量值:', INPUT_STATEMENT_CONSTANT);
      
      if (sourceBlockObj.inputList) {
        console.log('📋 详细输入列表:');
        sourceBlockObj.inputList.forEach((input: any, index: number) => {
          console.log(`   [${index}] 名称: "${input.name}", 类型: ${input.type}, 是语句输入: ${input.type === INPUT_STATEMENT_CONSTANT}`);
        });
      }
      
      const detectedInputName = sourceBlockObj.inputList?.find((input: any) => 
        input.type === INPUT_STATEMENT_CONSTANT
      )?.name;
      
      console.log('🎯 检测结果:', detectedInputName ? `找到语句输入 "${detectedInputName}"` : '未找到语句输入');
      
      if (detectedInputName) {
        optimizedInputName = detectedInputName;
        optimizedConnectionType = 'input'; // statement 本质上就是 input 连接
        console.log(`🔄 智能检测：statement 连接转换为 input 连接，使用输入: ${detectedInputName}`);
      } else {
        console.log(`⚠️ 方法1失败，尝试回退检测方法...`);
        
        // 回退方法1：检查常见的语句输入名称
        const commonStatementInputs = ['NAME', 'DO', 'DO0', 'BODY', 'STATEMENT', 'ARDUINO_SETUP', 'ARDUINO_LOOP'];
        let fallbackInputName = null;
        
        for (const inputName of commonStatementInputs) {
          try {
            const input = sourceBlockObj.getInput(inputName);
            if (input && input.connection) {
              // 检查连接类型是否为语句连接
              const connectionType = input.connection.type;
              console.log(`🔍 检查输入 "${inputName}": 连接类型 ${connectionType}`);
              
              // 尝试不同的连接类型值 (通常语句连接是 1 或 3)
              if (connectionType === 1 || connectionType === 3) {
                fallbackInputName = inputName;
                console.log(`✅ 回退方法1成功：找到语句输入 "${inputName}"`);
                break;
              }
            }
          } catch (error) {
            console.log(`   getInput("${inputName}") 失败: ${error.message}`);
          }
        }
        
        // 回退方法2：特殊处理 blinker_button
        if (!fallbackInputName && sourceBlockObj.type === 'blinker_button') {
          console.log(`🎯 回退方法2：blinker_button 特殊处理`);
          try {
            const nameInput = sourceBlockObj.getInput('NAME');
            if (nameInput) {
              fallbackInputName = 'NAME';
              console.log(`✅ 回退方法2成功：强制使用 blinker_button 的 NAME 输入`);
            }
          } catch (error) {
            console.log(`❌ 回退方法2失败: ${error.message}`);
          }
        }
        
        // 回退方法3：基于块类型的已知映射
        if (!fallbackInputName) {
          console.log(`🗺️ 回退方法3：使用已知映射`);
          const knownMappings: { [key: string]: string } = {
            'blinker_button': 'NAME',
            'blinker_slider': 'NAME',
            'blinker_colorpicker': 'NAME',
            'blinker_joystick': 'NAME',
            'blinker_data_handler': 'NAME',
            'blinker_heartbeat': 'NAME',
            'blinker_chart': 'NAME',
            'arduino_setup': 'ARDUINO_SETUP',
            'arduino_loop': 'ARDUINO_LOOP',
            'controls_if': 'DO0',
            'controls_for': 'DO',
            'controls_while': 'DO',
            'controls_repeat': 'DO'
          };
          
          if (knownMappings[sourceBlockObj.type]) {
            fallbackInputName = knownMappings[sourceBlockObj.type];
            console.log(`✅ 回退方法3成功：使用已知映射 "${fallbackInputName}"`);
          }
        }
        
        if (fallbackInputName) {
          optimizedInputName = fallbackInputName;
          optimizedConnectionType = 'input';
          console.log(`🔄 回退检测成功：statement → input，使用输入: ${fallbackInputName}`);
        } else {
          // 增加调试信息，看看块的实际结构
          console.log(`❌ 所有检测方法都失败了`);
          console.log(`🔍 调试信息 - ${sourceBlockObj.type} 的输入结构:`);
          console.log('INPUT_STATEMENT 常量值:', INPUT_STATEMENT_CONSTANT);
          console.log('inputList:', sourceBlockObj.inputList?.map((input: any) => ({
            name: input.name,
            type: input.type,
            isStatement: input.type === INPUT_STATEMENT_CONSTANT
          })));
          
          throw new Error(`块 ${sourceBlockObj.type} 不是容器块，没有语句输入端口，无法使用 statement 连接类型。请使用 'next' 连接类型进行顺序连接`);
        }
      }
    }
    
    // 执行连接 - 使用统一的智能插入函数
    console.log('🔗 使用 smartInsertBlock 执行智能连接...');
    const connectionResult = await smartInsertBlock(
      workspace,
      targetBlockObj,
      sourceBlockObj, 
      optimizedConnectionType as 'next' | 'input' | 'statement',
      optimizedInputName
    );

    metadata = {
      sourceBlockId: sourceBlockObj.id,
      targetBlockId: targetBlockObj.id,
      connectionType: optimizedConnectionType,
      inputName: optimizedInputName,
      originalConnectionType: connectionType,
      smartInsertion: connectionResult.smartInsertion,
      autoMovedBlock: connectionResult.autoMovedBlock
    };

    // 根据是否发生智能插入来生成结果消息
    if (connectionResult.smartInsertion && connectionResult.autoMovedBlock) {
      toolResult = `成功智能插入块 "${targetBlockObj.type}" 到 "${sourceBlockObj.type}" 后面，并自动后移 "${connectionResult.autoMovedBlock}" 块`;
    } else if (connectionResult.smartInsertion) {
      toolResult = `成功智能插入块 "${targetBlockObj.type}" 到 "${sourceBlockObj.type}"`;
    } else {
      toolResult = `成功连接块 "${sourceBlockObj.type}" 和 "${targetBlockObj.type}"`;
    }
    console.log(`✅ ${toolResult}`);

  } catch (error) {
    is_error = true;
    toolResult = `连接块失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`❌ ${toolResult}`);
  } finally {
    // 确保事件组正确清理，避免拖动时的事件冲突
    ensureEventGroupCleanup();
  }

  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 3. 代码结构创建工具 - 重写版本
 * 用于创建完整的代码块结构，支持多种编程模式
 */
interface CodeStructureArgs {
  // 结构名称（任意字符串，用于日志和元数据）
  structure: string;
  
  // 动态结构定义 - 核心配置（支持字符串格式）
  config: string | {
    structureDefinition: {
      rootBlock: BlockConfig;
      additionalBlocks?: BlockConfig[];
      connectionRules?: Array<{
        source: string; // 输出块的引用（提供连接的块）- 对应 connectBlockTool 的 sourceBlock
        target: string; // 接收块的引用（接收连接的块）- 对应 connectBlockTool 的 targetBlock  
        inputName?: string; // 连接到接收块(target)的输入名
        connectionType?: 'next' | 'input' | 'statement';
      }>;
    };
  };
  
  // 放置选项
  insertPosition?: 'workspace' | 'after' | 'before' | 'input' | 'statement' | 'append';
  targetBlock?: string; // 目标块ID
  targetInput?: string; // 目标输入名
  position?: { x?: number; y?: number }; // 工作区位置
}

interface CodeStructureResult extends ToolUseResult {
  metadata?: {
    structureType: string;
    createdBlocks: string[];
    rootBlockId?: string;
    connections: Array<{
      sourceId: string;
      targetId: string;
      connectionType: string;
    }>;
  };
}

export async function createCodeStructureTool(
  toolArgs: CodeStructureArgs
): Promise<CodeStructureResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🏗️ createCodeStructureTool 开始执行');
  console.log('📦 接收到的参数:', JSON.stringify(toolArgs, null, 2));

  try {
    let { structure, config, insertPosition = 'workspace', targetBlock, targetInput, position } = toolArgs;

    console.log('🔧 原始参数解析...');
    console.log('- structure:', structure);
    console.log('- config:', config);
    console.log('- position (raw):', position);
    console.log('- insertPosition:', insertPosition);

    // 参数类型转换和修复
    try {
      // 如果 config 是字符串，需要解析
      if (typeof config === 'string') {
        console.log('📝 解析字符串格式的 config...');
        console.log('🔧 原始 config 字符串:', config);
        
        try {
          // 直接尝试解析 JSON
          config = JSON.parse(config);
          console.log('✅ config 解析成功:', config);
        } catch (parseError) {
          console.log('⚠️ config 解析失败，尝试使用 JSON 修复...');
          console.log('❌ 解析错误:', (parseError as Error).message);
          
          try {
            // 使用 jsonrepair 库修复 JSON
            const repairedConfig = jsonrepair(config as string);
            console.log('🔧 修复后的 config:', repairedConfig);
            
            config = JSON.parse(repairedConfig);
            console.log('✅ jsonrepair 修复 config 成功:', config);
          } catch (repairError) {
            console.log('❌ jsonrepair 修复失败，尝试自定义修复...');
            
            // 使用自定义修复函数
            const fixResult = fixJsonString(config as string);
            if (fixResult.success) {
              config = JSON.parse(fixResult.fixed);
              console.log('✅ 自定义修复 config 成功:', config);
              console.log('🔧 修复过程:', fixResult.changes);
            } else {
              throw new Error(`JSON修复失败: ${fixResult.error}. 修复尝试: ${fixResult.changes.join(', ')}`);
            }
          }
        }
      }

      // 解析 position 参数（如果是字符串）
      if (typeof position === 'string') {
        console.log('📍 解析字符串格式的 position...');
        try {
          position = JSON.parse(position);
          console.log('✅ position 解析成功:', position);
        } catch (posParseError) {
          console.log('⚠️ position 解析失败，尝试修复...');
          try {
            const repairedPosition = jsonrepair(position as string);
            position = JSON.parse(repairedPosition);
            console.log('✅ position 修复成功:', position);
          } catch (posRepairError) {
            console.log('❌ position 修复失败，使用默认值');
            position = null;
          }
        }
      }

      // 修复 insertPosition 参数
      if (insertPosition === 'append') {
        console.log('🔄 修复 insertPosition: append -> workspace');
        insertPosition = 'workspace';
      }

      console.log('🎯 参数解析完成:');
      console.log('- config (parsed):', JSON.stringify(config, null, 2));
      console.log('- position (parsed):', JSON.stringify(position, null, 2));
      console.log('- insertPosition (fixed):', insertPosition);

      // 进一步处理 config 中的特殊情况
      if (config && typeof config === 'object') {
        // 验证必要的structureDefinition
        if (!config.structureDefinition) {
          throw new Error('必须提供 config.structureDefinition 配置来定义结构');
        }
        console.log('✅ 动态结构定义验证通过');
      }

    } catch (parseError) {
      console.error('❌ 参数解析失败:', parseError);
      throw new Error(`参数解析失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }

    // 获取工作区
    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }

    const createdBlocks: string[] = [];
    const connections: Array<{ sourceId: string; targetId: string; connectionType: string }> = [];

    // 计算放置位置
    const blockPosition = position ? 
      calculateBlockPosition(workspace, position.x, position.y) :
      calculateBlockPosition(workspace);

    console.log(`🎯 开始创建 ${structure} 结构`);
    console.log('📍 计算的位置:', blockPosition);

    // 使用动态结构处理器创建结构
    console.log(`📝 使用动态结构定义创建: ${structure}`);
    const rootBlock = await createDynamicStructure(workspace, config, blockPosition, createdBlocks, connections);

    if (rootBlock) {
      // 处理插入位置
      console.log('🔗 检查插入位置条件:');
      console.log('- insertPosition:', insertPosition);
      console.log('- targetBlock:', targetBlock);
      console.log('- targetInput:', targetInput);
      console.log('- 条件判断:', `insertPosition !== 'workspace' (${insertPosition !== 'workspace'}) && targetBlock (${!!targetBlock})`);
      
      if (insertPosition !== 'workspace' && targetBlock) {
        console.log(`🎯 执行块插入: ${insertPosition} 到 ${targetBlock}`);
        await handleBlockInsertion(workspace, rootBlock, insertPosition, targetBlock, targetInput);
        console.log(`✅ 块插入完成`);
      } else {
        console.log(`⚠️ 跳过块插入 - 条件不满足`);
      }

      console.log(`✅ 成功创建 ${structure} 结构，包含 ${createdBlocks.length} 个块`);
      
      metadata = {
        structureType: structure,
        createdBlocks,
        rootBlockId: rootBlock.id,
        connections
      };

      toolResult = `成功创建 ${structure} 代码结构，包含 ${createdBlocks.length} 个块`;
    } else {
      throw new Error('创建代码结构失败');
    }

  } catch (error) {
    is_error = true;
    toolResult = `创建代码结构失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ createCodeStructureTool 执行失败:', error);
  } finally {
    // 确保事件组正确清理，避免拖动时的事件冲突
    ensureEventGroupCleanup();
  }

  console.log('📤 返回结果:', { content: toolResult, is_error, metadata });
  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 4. 块配置工具
 */
interface ConfigureBlockArgs {
  blockId?: string;
  blockType?: string;
  fields?: FieldConfig;
  inputs?: InputConfig;
}

interface ConfigureBlockResult extends ToolUseResult {
  metadata?: {
    blockId: string;
    blockType: string;
    fieldsUpdated: string[];
    inputsUpdated: string[];
  };
}

export async function configureBlockTool(
  toolArgs: ConfigureBlockArgs
): Promise<ConfigureBlockResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🔧 configureBlockTool 开始执行');
  console.log('📦 接收到的参数:', JSON.stringify(toolArgs, null, 2));

  try {
    let { blockId, blockType, fields, inputs } = toolArgs;

    // 🔧 参数修复和转换
    console.log('🔧 开始参数修复和转换...');
    
    // 修复 fields 参数
    if (typeof fields === 'string') {
      console.log(`⚠️ fields 是字符串 "${fields}"，尝试解析...`);
      try {
        if ((fields as string).trim()) {
          fields = JSON.parse(fields as string);
          console.log(`✅ fields 修复为: ${JSON.stringify(fields)}`);
        } else {
          fields = null;
          console.log(`✅ fields 设为 null`);
        }
      } catch (error) {
        console.error(`❌ fields 解析失败: ${(error as Error).message}`);
        fields = null;
      }
    }

    // 修复 inputs 参数
    if (typeof inputs === 'string') {
      console.log(`⚠️ inputs 是字符串 "${inputs}"，尝试解析...`);
      
      if ((inputs as string).trim() && inputs !== '{}') {
        // 🔧 使用独立的 JSON 修复函数
        const fixResult = fixJsonString(inputs as string, { logProcess: true });
        
        if (fixResult.success) {
          console.log(`✅ JSON 修复成功，应用的修复: ${fixResult.changes.join(', ')}`);
          try {
            inputs = JSON.parse(fixResult.fixed);
            console.log(`✅ inputs 修复为: ${JSON.stringify(inputs)}`);
          } catch (parseError) {
            console.error(`❌ 修复后的 JSON 仍然无法解析: ${(parseError as Error).message}`);
            inputs = null;
          }
        } else {
          console.error(`❌ JSON 修复失败: ${fixResult.error}`);
          console.error(`❌ 尝试的修复: ${fixResult.changes.join(', ')}`);
          inputs = null;
        }
      } else {
        inputs = null;
        console.log(`✅ inputs 设为 null（空字符串或仅包含 {}）`);
      }
    }

    console.log('🔍 修复后的参数:');
    console.log(`  - 块ID: ${blockId}`);
    console.log(`  - 块类型: ${blockType}`);
    console.log(`  - 字段: ${JSON.stringify(fields)}`);
    console.log(`  - 输入: ${JSON.stringify(inputs)}`);

    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    // 查找目标块
    console.log(`🎯 查找目标块: ${blockId} (类型: ${blockType})`);
    const block = await findTargetBlock(workspace, { id: blockId, type: blockType });
    if (!block) {
      throw new Error('未找到指定的块');
    }
    console.log(`✅ 找到目标块: ${block.type} (ID: ${block.id})`);

    const fieldsUpdated: string[] = [];
    const inputsUpdated: string[] = [];

    // 更新字段
    if (fields) {
      console.log('🏷️ 开始更新字段...');
      const updatedFields = await configureBlockFields(block, fields);
      fieldsUpdated.push(...updatedFields);
      console.log(`✅ 字段更新完成: ${updatedFields.join(', ')}`);
    }

    // 更新输入
    if (inputs) {
      console.log('🔌 开始更新输入...');
      const updatedInputs = await configureBlockInputs(workspace, block, inputs);
      inputsUpdated.push(...updatedInputs);
      console.log(`✅ 输入更新完成: ${updatedInputs.join(', ')}`);
    }

    metadata = {
      blockId: block.id,
      blockType: block.type,
      fieldsUpdated,
      inputsUpdated
    };

    toolResult = `成功配置块 "${block.type}"${fieldsUpdated.length > 0 ? `，更新字段: ${fieldsUpdated.join(', ')}` : ''}${inputsUpdated.length > 0 ? `，更新输入: ${inputsUpdated.join(', ')}` : ''}`;
    console.log(`✅ configureBlockTool 执行完成: ${toolResult}`);

  } catch (error) {
    is_error = true;
    toolResult = `配置块失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ configureBlockTool 执行失败:', error);
  } finally {
    // 确保事件组正确清理，避免拖动时的事件冲突
    ensureEventGroupCleanup();
  }

  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 5. 变量管理工具
 */
interface VariableManagerArgs {
  operation: 'create' | 'delete' | 'list' | 'rename';
  variableName?: string;
  newName?: string;
  variableType?: string;
}

interface VariableManagerResult extends ToolUseResult {
  metadata?: {
    action: string;
    variableName?: string;
    variableId?: string;
    variables?: Array<{ name: string; id: string; type?: string }>;
  };
}

export async function variableManagerTool(
  toolArgs: VariableManagerArgs
): Promise<VariableManagerResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  try {
    const { operation, variableName, newName, variableType = 'String' } = toolArgs;

    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }

    switch (operation) {
      case 'create':
        if (!variableName) {
          throw new Error('创建变量时必须提供变量名');
        }
        const variable: VariableConfig = {
          name: variableName,
          type: variableType === 'Number' ? 'int' : 
                variableType === 'Boolean' ? 'bool' : 
                variableType === 'String' ? 'string' : 'string',
          scope: 'global'
        };
        const createdVar = await createVariable(workspace, variable);
        metadata = {
          operation,
          variableName: createdVar.name,
          variableId: createdVar.id
        };
        toolResult = `成功创建变量 "${createdVar.name}"`;
        break;

      case 'list':
        const variables = await listVariables(workspace);
        metadata = {
          operation,
          variables
        };
        toolResult = `工作区中有 ${variables.length} 个变量`;
        break;

      case 'rename':
        if (!variableName || !newName) {
          throw new Error('重命名变量时必须提供原名称和新名称');
        }
        await renameVariable(workspace, variableName, newName);
        metadata = {
          operation,
          variableName: newName
        };
        toolResult = `成功将变量 "${variableName}" 重命名为 "${newName}"`;
        break;

      case 'delete':
        if (!variableName) {
          throw new Error('删除变量时必须提供变量名称');
        }
        await deleteVariable(workspace, variableName);
        metadata = {
          operation,
          variableName: variableName
        };
        toolResult = `成功删除变量 "${variableName}"`;
        break;

      default:
        throw new Error(`不支持的变量操作: ${operation}`);
    }

  } catch (error) {
    is_error = true;
    toolResult = `变量管理失败: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 6. 块查找工具
 */
interface FindBlockArgs {
  criteria: {
    type?: string;
    fields?: FieldConfig;
    position?: 'first' | 'last' | 'selected';
  };
  action?: 'select' | 'highlight' | 'none';
}

interface BlockTreeInfo {
  id: string;
  type: string;
  position: Position;
  block: any; // 保留原始块引用
  fields: any;
  inputs: any;
  tree: {
    parentBlock?: { id: string; type: string; relation: string }; // 父块信息
    childBlocks: Array<{ id: string; type: string; inputName: string }>; // 子块信息
    nextBlock?: { id: string; type: string }; // 下一个块
    previousBlock?: { id: string; type: string }; // 前一个块
    rootBlock?: { id: string; type: string }; // 根块信息
    depth: number; // 在树中的深度
    path: string; // 从根到当前块的路径
  };
}

interface FindBlockResult extends ToolUseResult {
  metadata?: {
    foundBlocks: Array<BlockTreeInfo>;
    selectedBlockId?: string;
    treeStructure?: string; // 树状结构的文本表示
  };
}

interface GetWorkspaceOverviewArgs {
  includeCode?: boolean; // 是否包含生成的C++代码
  includeTree?: boolean; // 是否包含树状结构
  format?: 'text' | 'json' | 'both'; // 输出格式
  groupBy?: 'structure' | 'type' | 'none'; // 分组方式
}

interface WorkspaceBlockInfo {
  id: string;
  type: string;
  position: Position;
  fields: any;
  inputs: any;
  tree: BlockTreeInfo['tree'];
  generatedCode?: string; // 该块生成的代码片段
}

interface WorkspaceStructure {
  totalBlocks: number;
  blockTypes: { [type: string]: number };
  rootBlocks: WorkspaceBlockInfo[]; // 顶层块（没有父块的块）
  allBlocks: WorkspaceBlockInfo[]; // 所有块的详细信息
  structureTree: string; // 整个工作区的树状结构文本
  generatedCode?: string; // 完整的生成代码
  codeMapping?: { [blockId: string]: string }; // 块ID到代码的映射
}

interface GetWorkspaceOverviewResult extends ToolUseResult {
  metadata?: {
    workspace: WorkspaceStructure;
    statistics: {
      totalBlocks: number;
      blocksByType: { [type: string]: number };
      maxDepth: number;
      independentStructures: number;
    };
  };
}

export async function getWorkspaceOverviewTool(
  toolArgs: GetWorkspaceOverviewArgs = {}
): Promise<GetWorkspaceOverviewResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🌍 getWorkspaceOverviewTool 开始执行');
  console.log('📦 配置参数:', JSON.stringify(toolArgs, null, 2));

  try {
    const { 
      includeCode = true, 
      includeTree = true, 
      format = 'both',
      groupBy = 'structure'
    } = toolArgs;

    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    // 获取所有块并分析结构
    const workspaceStructure = await analyzeWorkspaceStructure(workspace, {
      includeCode,
      includeTree,
      groupBy
    });

    // 生成统计信息
    const statistics = generateWorkspaceStatistics(workspaceStructure);

    // 格式化输出
    let textOutput = '';
    let jsonOutput = null;

    if (format === 'text' || format === 'both') {
      textOutput = formatWorkspaceOverview(workspaceStructure, statistics, {
        includeCode,
        includeTree,
        groupBy
      });
    }

    if (format === 'json' || format === 'both') {
      jsonOutput = {
        workspace: workspaceStructure,
        statistics
      };
    }

    metadata = {
      workspace: workspaceStructure,
      statistics
    };

    if (format === 'json') {
      toolResult = JSON.stringify(jsonOutput, null, 2);
    } else {
      toolResult = textOutput;
    }

    console.log(`✅ 工作区分析完成: ${workspaceStructure.totalBlocks} 个块，${statistics.independentStructures} 个独立结构`);

  } catch (error) {
    is_error = true;
    toolResult = `获取工作区概览失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ getWorkspaceOverviewTool 执行失败:', error);
  }

  console.log('📤 返回结果长度:', toolResult?.length || 0);
  return {
    content: toolResult,
    is_error,
    metadata
  };
}

export async function findBlockTool(
  toolArgs: FindBlockArgs
): Promise<FindBlockResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🔍 findBlockTool 开始执行');
  console.log('📦 查找条件:', JSON.stringify(toolArgs, null, 2));

  try {
    const { criteria, action = 'none' } = toolArgs;

    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    const foundBlocks = await findBlocks(workspace, criteria);
    console.log(`🎯 找到 ${foundBlocks.length} 个符合条件的块`);

    if (foundBlocks.length === 0) {
      console.log('❌ 未找到符合条件的块');
      toolResult = '未找到符合条件的块';
    } else {
      let selectedBlockId = undefined;

      // 详细记录找到的每个块的信息
      console.log('📊 找到的块详情:');
      foundBlocks.forEach((blockInfo, index) => {
        console.log(`\n块 ${index + 1}:`);
        console.log(`  - ID: ${blockInfo.id}`);
        console.log(`  - 类型: ${blockInfo.type}`);
        console.log(`  - 位置: ${JSON.stringify(blockInfo.position)}`);
        console.log(`  - 字段值: ${JSON.stringify(blockInfo.fields)}`);
        if (blockInfo.inputs && Object.keys(blockInfo.inputs).length > 0) {
          console.log(`  - 输入: ${JSON.stringify(blockInfo.inputs)}`);
        }
        console.log(`  - 树状信息: 深度=${blockInfo.tree.depth}, 路径=${blockInfo.tree.path}`);
        if (blockInfo.tree.parentBlock) {
          console.log(`  - 父块: ${blockInfo.tree.parentBlock.type} [${blockInfo.tree.parentBlock.id}]`);
        }
        if (blockInfo.tree.childBlocks.length > 0) {
          console.log(`  - 子块数量: ${blockInfo.tree.childBlocks.length}`);
        }
      });

      if (action === 'select' && foundBlocks.length > 0) {
        const targetBlock = foundBlocks[0];
        workspace.setSelected && workspace.setSelected(targetBlock.block);
        selectedBlockId = targetBlock.id;
        console.log(`🎯 已选中块: ${selectedBlockId}`);
      } else if (action === 'highlight') {
        // 实现高亮逻辑
        await highlightBlocks(foundBlocks.map(b => b.block));
        console.log(`✨ 已高亮 ${foundBlocks.length} 个块`);
      }

      // 生成树状结构文本
      const treeStructure = generateTreeStructure(foundBlocks);
      console.log('🌳 树状结构信息:\n', treeStructure);

      // 返回更详细的 metadata，包含字段值信息和树状结构
      metadata = {
        foundBlocks: foundBlocks,
        selectedBlockId,
        searchCriteria: criteria,
        treeStructure: treeStructure
      };

      // 使用安全的ID格式，避免特殊字符被截断，并包含树状信息
      const blockList = foundBlocks.map(b => {
        const treeInfo = b.tree.parentBlock 
          ? ` (子于: ${b.tree.parentBlock.type})` 
          : b.tree.childBlocks.length > 0 
            ? ` (有${b.tree.childBlocks.length}个子块)` 
            : '';
        return `${b.type}[ID:${JSON.stringify(b.id)}]${treeInfo}`;
      }).join(', ');
      
      toolResult = `找到 ${foundBlocks.length} 个符合条件的块：${blockList}\n\n${treeStructure}`;
      console.log(`✅ 查找完成: ${toolResult}`);
    }

  } catch (error) {
    is_error = true;
    toolResult = `查找块失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ findBlockTool 执行失败:', error);
  }

  console.log('📤 返回结果:', { content: toolResult, is_error, metadata });
  return {
    content: toolResult,
    is_error,
    metadata
  };
}

/**
 * 6. 块删除工具
 */
interface DeleteBlockArgs {
  blockId: string;
  cascade?: boolean; // 是否级联删除连接的块
}

interface DeleteBlockResult extends ToolUseResult {
  metadata?: {
    deletedBlockId: string;
    deletedBlockType: string;
    cascadeDeleted?: string[]; // 级联删除的块ID列表
  };
}

export async function deleteBlockTool(
  toolArgs: DeleteBlockArgs
): Promise<DeleteBlockResult> {
  let toolResult = null;
  let is_error = false;
  let metadata = null;

  console.log('🗑️ deleteBlockTool 开始执行');
  console.log('📦 接收到的参数:', JSON.stringify(toolArgs, null, 2));

  try {
    const { blockId, cascade = false } = toolArgs;

    console.log('🎯 获取 Blockly 工作区...');
    const workspace = await getCurrentWorkspace();
    if (!workspace) {
      throw new Error('未找到活动的 Blockly 工作区');
    }
    console.log('✅ 工作区获取成功');

    // 查找要删除的块
    console.log(`🔍 查找块 ID: ${blockId}`);
    const blockToDelete = getBlockByIdSmart(workspace, blockId);
    if (!blockToDelete) {
      throw new Error(`未找到块 ID: ${blockId}（已尝试模糊匹配）`);
    }

    console.log(`✅ 找到目标块: ${blockToDelete.type} (ID: ${blockToDelete.id})`);

    const deletedBlockType = blockToDelete.type;
    const cascadeDeleted: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    let actualDeleted = 1; // 至少删除主块
    
    // 智能删除相关变量
    let isHatBlock = false;
    let reconnectedBlocks = 0;
    let nextBlockPreserved = false;

    if (cascade) {
      console.log('🔗 启用级联删除，收集连接的块...');
      
      // 收集所有需要删除的块（包括子块、后续块等）
      const collectAllBlocksToDelete = (block: any, collected: Set<any>) => {
        if (!block || collected.has(block)) return;
        
        collected.add(block);
        console.log(`🎯 收集到块: ${block.type}(${block.id})`);
        
        // 收集所有输入中的连接块
        const inputs = block.inputList || [];
        for (const input of inputs) {
          if (input.connection && input.connection.targetBlock()) {
            collectAllBlocksToDelete(input.connection.targetBlock(), collected);
          }
        }
        
        // 收集下一个块（后续连接的块）
        if (block.nextConnection && block.nextConnection.targetBlock()) {
          collectAllBlocksToDelete(block.nextConnection.targetBlock(), collected);
        }
        
        // 收集影子块
        const shadowBlocks = block.getShadowBlocks && block.getShadowBlocks();
        if (shadowBlocks) {
          for (const shadowBlock of shadowBlocks) {
            collectAllBlocksToDelete(shadowBlock, collected);
          }
        }
      };

      const allBlocksToDelete = new Set<any>();
      collectAllBlocksToDelete(blockToDelete, allBlocksToDelete);
      
      // 将块对象ID存储到cascadeDeleted数组
      for (const block of allBlocksToDelete) {
        if (block.id !== blockToDelete.id) {
          cascadeDeleted.push(block.id);
        }
      }
      
      console.log(`📊 发现 ${cascadeDeleted.length} 个连接的块需要级联删除`);
      console.log(`📋 级联删除块列表:`, cascadeDeleted);
    }

    // 执行删除
    console.log('🗑️ 开始删除块...');
    
    if (cascade && cascadeDeleted.length > 0) {
      console.log('🔗 执行级联删除...');
      console.log('📋 即将删除的连接块 IDs:', cascadeDeleted);
      
      // 记录删除前的详细信息
      beforeCount = workspace.getAllBlocks().length;
      const allBlocksBefore = workspace.getAllBlocks().map(b => `${b.type}(${b.id})`);
      console.log(`📊 删除前工作区块数: ${beforeCount}`);
      console.log(`📋 删除前所有块:`, allBlocksBefore);
      
      // 级联删除：手动删除每个块以确保完全删除
      console.log(`🗑️ 开始手动级联删除...`);
      
      // 手动级联删除：从底层开始删除，确保不会因为连接关系导致删除失败
      const deletedIds: string[] = [];
      
      // 先断开主块的连接关系
      if (blockToDelete.previousConnection && blockToDelete.previousConnection.targetConnection) {
        console.log(`🔗 断开主块的previous连接`);
        blockToDelete.previousConnection.disconnect();
      }
      if (blockToDelete.outputConnection && blockToDelete.outputConnection.targetConnection) {
        console.log(`🔗 断开主块的output连接`);
        blockToDelete.outputConnection.disconnect();
      }
      
      // 删除所有连接的块
      for (const blockId of cascadeDeleted) {
        const blockToDeleteCascade = getBlockByIdSmart(workspace, blockId);
        if (blockToDeleteCascade) {
          console.log(`🗑️ 删除连接块: ${blockToDeleteCascade.type}(${blockToDeleteCascade.id})`);
          blockToDeleteCascade.dispose(false); // 不再级联，因为我们手动控制
          deletedIds.push(blockId);
        }
      }
      
      // 最后删除主块
      console.log(`🗑️ 删除主块: ${blockToDelete.type}(${blockToDelete.id})`);
      blockToDelete.dispose(false);
      deletedIds.push(blockToDelete.id);
      
      // 记录删除后的详细信息
      afterCount = workspace.getAllBlocks().length;
      const allBlocksAfter = workspace.getAllBlocks().map(b => `${b.type}(${b.id})`);
      actualDeleted = beforeCount - afterCount;
      console.log(`📊 删除后工作区块数: ${afterCount}`);
      console.log(`� 删除后所有块:`, allBlocksAfter);
      console.log(`📊 实际删除的块数: ${actualDeleted}`);
      console.log(`📋 手动删除的块IDs:`, deletedIds);
      console.log(`⚠️ 预期删除 ${cascadeDeleted.length + 1} 个，实际删除 ${actualDeleted} 个`);
      
      toolResult = `成功级联删除块 "${deletedBlockType}" 及其 ${deletedIds.length - 1} 个连接块（共删除 ${deletedIds.length} 个块）`;
    } else {
      console.log('🎯 执行智能单块删除...');
      // 智能单块删除：保留连接的块，并尝试重新连接前后块
      
      // 检查是否是 hat 块（顶级块，如 arduino_setup, arduino_loop 等）
      isHatBlock = !blockToDelete.previousConnection || 
                   blockToDelete.type.includes('setup') || 
                   blockToDelete.type.includes('loop') ||
                   blockToDelete.type.includes('hat') ||
                   blockToDelete.type.includes('event');
      
      let nextBlockPreserved = false;
      
      if (isHatBlock) {
        console.log(`📋 检测到 Hat 块 ${blockToDelete.type}，将删除其statement中的所有块`);
        // Hat 块删除时，其 statement 连接的块也应该被删除
        blockToDelete.dispose(false);
        console.log('✅ Hat 块及其语句块已删除');
      } else {
        console.log(`📋 检测到普通块 ${blockToDelete.type}，执行智能删除和重连...`);
        
        // 获取前一个块和后一个块
        const previousBlock = blockToDelete.getPreviousBlock ? blockToDelete.getPreviousBlock() : null;
        const nextBlock = blockToDelete.getNextBlock ? blockToDelete.getNextBlock() : null;
        
        console.log(`🔍 连接状态分析:`);
        console.log(`   前一个块: ${previousBlock ? `${previousBlock.type}(${previousBlock.id})` : '无'}`);
        console.log(`   后一个块: ${nextBlock ? `${nextBlock.type}(${nextBlock.id})` : '无'}`);
        
        // 先断开所有连接
        if (blockToDelete.previousConnection && blockToDelete.previousConnection.targetConnection) {
          console.log('🔗 断开与前一个块的连接');
          blockToDelete.previousConnection.disconnect();
        }
        if (blockToDelete.nextConnection && blockToDelete.nextConnection.targetConnection) {
          console.log('🔗 断开与后一个块的连接');
          blockToDelete.nextConnection.disconnect();
        }
        
        // 删除目标块
        console.log(`🗑️ 删除目标块: ${blockToDelete.type}(${blockToDelete.id})`);
        blockToDelete.dispose(false);
        
        // 🎯 智能重连：如果前后都有块，尝试重新连接
        if (previousBlock && nextBlock) {
          console.log('🔄 智能重连模式：尝试将前后块重新连接...');
          try {
            if (previousBlock.nextConnection && nextBlock.previousConnection) {
              // 检查连接兼容性
              const isCompatible = checkConnectionCompatibility(previousBlock.nextConnection, nextBlock.previousConnection);
              if (isCompatible) {
                // 禁用事件系统避免连接时的移动事件错误
                const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
                const currentGroup = window['Blockly'].Events.getGroup();
                window['Blockly'].Events.disable();
                
                try {
                  previousBlock.nextConnection.connect(nextBlock.previousConnection);
                  reconnectedBlocks = 2;
                  nextBlockPreserved = true;
                  console.log(`✅ 智能重连成功: ${previousBlock.type} → ${nextBlock.type}`);
                } catch (connectError) {
                  console.warn(`⚠️ 智能重连时出错: ${connectError}, 但块已保留`);
                  nextBlockPreserved = true;
                } finally {
                  // 恢复事件系统
                  window['Blockly'].Events.enable();
                  if (currentGroup) {
                    window['Blockly'].Events.setGroup(currentGroup);
                  }
                  window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
                }
              } else {
                console.log('⚠️ 前后块类型不兼容，无法重连，但块已保留');
                nextBlockPreserved = true;
              }
            } else {
              console.log('⚠️ 连接点不匹配，无法重连，但块已保留');
              nextBlockPreserved = true;
            }
          } catch (reconnectError) {
            console.warn('⚠️ 重连过程中出现错误，但块已保留:', reconnectError);
            nextBlockPreserved = true;
          }
        } else if (nextBlock) {
          console.log('✅ 后续块已保留（无前一个块需要重连）');
          nextBlockPreserved = true;
        } else if (previousBlock) {
          console.log('✅ 前一个块保持不变（无后续块需要重连）');
        } else {
          console.log('ℹ️ 删除的是独立块，无需重连');
        }
      }
      
      // 生成结果消息
      if (isHatBlock) {
        toolResult = `成功删除 Hat 块 "${deletedBlockType}" 及其相关语句块`;
      } else if (reconnectedBlocks > 0) {
        toolResult = `成功删除块 "${deletedBlockType}"，并智能重连了前后块`;
      } else if (nextBlockPreserved) {
        toolResult = `成功删除块 "${deletedBlockType}"，后续块已保留`;
      } else {
        toolResult = `成功删除块 "${deletedBlockType}"`;
      }
    }

    console.log(`✅ 删除完成: ${toolResult}`);

    // 更新 metadata 以反映实际删除的情况
    if (cascade && cascadeDeleted.length > 0) {
      metadata = {
        deletedBlockId: blockId,
        deletedBlockType: deletedBlockType,
        expectedCascadeCount: cascadeDeleted.length,
        actualDeletedCount: actualDeleted,
        cascadeDeleted: cascadeDeleted,
        manualDeletion: true, // 标记为手动级联删除
        deletionMethod: '手动级联删除 - 逐一删除连接块'
      };
    } else {
      metadata = {
        deletedBlockId: blockId,
        deletedBlockType: deletedBlockType,
        deletionMethod: '智能单块删除',
        isHatBlock: isHatBlock,
        reconnectedBlocks: reconnectedBlocks || 0,
        nextBlockPreserved: nextBlockPreserved || false
      };
    }

  } catch (error) {
    is_error = true;
    toolResult = `删除块失败: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ deleteBlockTool 执行失败:', error);
  } finally {
    // 确保事件组正确清理，避免拖动时的事件冲突
    ensureEventGroupCleanup();
  }

  console.log('📤 返回结果:', { content: toolResult, is_error, metadata });
  return {
    content: toolResult,
    is_error,
    metadata
  };
}

// =============================================================================
// 辅助函数
// =============================================================================

// =============================================================================
// 代码结构创建辅助函数
// =============================================================================

/**
 * 创建 if 条件结构
 */
async function createIfConditionStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('🔀 创建 if 条件结构');
  
  const ifBlock = await createBlockSafely(workspace, 'controls_if', position, true);
  createdBlocks.push(ifBlock.id);
  
  // 设置条件
  if (config.condition) {
    const conditionBlock = await createBlockFromConfig(workspace, config.condition);
    if (conditionBlock) {
      createdBlocks.push(conditionBlock.id);
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        ifBlock.getInput('IF0').connection.connect(conditionBlock.outputConnection);
        connections.push({
          sourceId: conditionBlock.id,
          targetId: ifBlock.id,
          connectionType: 'value'
        });
      } catch (connectError) {
        console.warn(`⚠️ if条件连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    }
  }
  
  // 设置 if 分支
  if (config.ifBranch) {
    const branchBlocks = await createBlockSequence(workspace, config.ifBranch);
    if (branchBlocks.length > 0) {
      createdBlocks.push(...branchBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo2 = window['Blockly'].Events.getRecordUndo();
      const currentGroup2 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        ifBlock.getInput('DO0').connection.connect(branchBlocks[0].previousConnection);
        connections.push({
          sourceId: branchBlocks[0].id,
          targetId: ifBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ if分支连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup2) {
          window['Blockly'].Events.setGroup(currentGroup2);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo2);
      }
    }
  }
  
  return ifBlock;
}

/**
 * 创建 if-else 条件结构
 */
async function createIfElseStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('🔀 创建 if-else 条件结构');
  
  const ifElseBlock = await createBlockSafely(workspace, 'controls_ifelse', position, true);
  createdBlocks.push(ifElseBlock.id);
  
  // 设置条件
  if (config.condition) {
    const conditionBlock = await createBlockFromConfig(workspace, config.condition);
    if (conditionBlock) {
      createdBlocks.push(conditionBlock.id);
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        ifElseBlock.getInput('IF0').connection.connect(conditionBlock.outputConnection);
        connections.push({
          sourceId: conditionBlock.id,
          targetId: ifElseBlock.id,
          connectionType: 'value'
        });
      } catch (connectError) {
        console.warn(`⚠️ if-else条件连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    }
  }
  
  // 设置 if 分支
  if (config.ifBranch) {
    const ifBranchBlocks = await createBlockSequence(workspace, config.ifBranch);
    if (ifBranchBlocks.length > 0) {
      createdBlocks.push(...ifBranchBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo2 = window['Blockly'].Events.getRecordUndo();
      const currentGroup2 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        ifElseBlock.getInput('DO0').connection.connect(ifBranchBlocks[0].previousConnection);
        connections.push({
          sourceId: ifBranchBlocks[0].id,
          targetId: ifElseBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ if分支连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup2) {
          window['Blockly'].Events.setGroup(currentGroup2);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo2);
      }
    }
  }
  
  // 设置 else 分支
  if (config.elseBranch) {
    const elseBranchBlocks = await createBlockSequence(workspace, config.elseBranch);
    if (elseBranchBlocks.length > 0) {
      createdBlocks.push(...elseBranchBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo3 = window['Blockly'].Events.getRecordUndo();
      const currentGroup3 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        ifElseBlock.getInput('ELSE').connection.connect(elseBranchBlocks[0].previousConnection);
        connections.push({
          sourceId: elseBranchBlocks[0].id,
          targetId: ifElseBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ else分支连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup3) {
          window['Blockly'].Events.setGroup(currentGroup3);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo3);
      }
    }
  }
  
  return ifElseBlock;
}

/**
 * 创建重复循环结构
 */
async function createRepeatLoopStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('🔁 创建重复循环结构');
  
  const repeatBlock = await createBlockSafely(workspace, 'controls_repeat_ext', position, true);
  createdBlocks.push(repeatBlock.id);
  
  // 设置循环次数
  if (config.loopCount) {
    if (typeof config.loopCount === 'number') {
      const numberBlock = await createBlockSafely(workspace, 'math_number', { x: position.x + 150, y: position.y }, true);
      numberBlock.setFieldValue(config.loopCount.toString(), 'NUM');
      createdBlocks.push(numberBlock.id);
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        repeatBlock.getInput('TIMES').connection.connect(numberBlock.outputConnection);
        connections.push({
          sourceId: numberBlock.id,
          targetId: repeatBlock.id,
          connectionType: 'value'
        });
      } catch (connectError) {
        console.warn(`⚠️ 循环次数连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    }
  }
  
  // 设置循环体
  if (config.loopBody) {
    const loopBodyBlocks = await createBlockSequence(workspace, config.loopBody);
    if (loopBodyBlocks.length > 0) {
      createdBlocks.push(...loopBodyBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo2 = window['Blockly'].Events.getRecordUndo();
      const currentGroup2 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        repeatBlock.getInput('DO').connection.connect(loopBodyBlocks[0].previousConnection);
        connections.push({
          sourceId: loopBodyBlocks[0].id,
          targetId: repeatBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ 循环体连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup2) {
          window['Blockly'].Events.setGroup(currentGroup2);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo2);
      }
    }
  }
  
  return repeatBlock;
}

/**
 * 创建 setup-loop 结构
 */
async function createSetupLoopStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('▶️ 创建 setup-loop 结构');
  
  // 创建 setup 块
  const setupBlock = await createBlockSafely(workspace, 'arduino_setup', position, true);
  createdBlocks.push(setupBlock.id);
  
  // 创建 loop 块
  const loopBlock = await createBlockSafely(workspace, 'arduino_loop', { x: position.x, y: position.y + 120 }, true);
  createdBlocks.push(loopBlock.id);
  
  // 禁用事件系统避免连接时的移动事件错误
  const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
  const currentGroup = window['Blockly'].Events.getGroup();
  window['Blockly'].Events.disable();
  
  try {
    // 连接 setup 和 loop
    setupBlock.nextConnection.connect(loopBlock.previousConnection);
    connections.push({
      sourceId: setupBlock.id,
      targetId: loopBlock.id,
      connectionType: 'next'
    });
  } catch (connectError) {
    console.warn(`⚠️ Arduino结构连接时出错: ${connectError}, 但连接尝试继续`);
  } finally {
    // 恢复事件系统
    window['Blockly'].Events.enable();
    if (currentGroup) {
      window['Blockly'].Events.setGroup(currentGroup);
    }
    window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
  }
  
  // 设置 setup 内容
  if (config.setupBlocks) {
    const setupBodyBlocks = await createBlockSequence(workspace, config.setupBlocks);
    if (setupBodyBlocks.length > 0) {
      createdBlocks.push(...setupBodyBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo2 = window['Blockly'].Events.getRecordUndo();
      const currentGroup2 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        setupBlock.getInput('ARDUINO_SETUP').connection.connect(setupBodyBlocks[0].previousConnection);
        connections.push({
          sourceId: setupBodyBlocks[0].id,
          targetId: setupBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ Arduino setup内容连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup2) {
          window['Blockly'].Events.setGroup(currentGroup2);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo2);
      }
    }
  }
  
  // 设置 loop 内容
  if (config.loopBlocks) {
    const loopBodyBlocks = await createBlockSequence(workspace, config.loopBlocks);
    if (loopBodyBlocks.length > 0) {
      createdBlocks.push(...loopBodyBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo3 = window['Blockly'].Events.getRecordUndo();
      const currentGroup3 = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        loopBlock.getInput('ARDUINO_LOOP').connection.connect(loopBodyBlocks[0].previousConnection);
        connections.push({
          sourceId: loopBodyBlocks[0].id,
          targetId: loopBlock.id,
          connectionType: 'statement'
        });
      } catch (connectError) {
        console.warn(`⚠️ Arduino loop内容连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup3) {
          window['Blockly'].Events.setGroup(currentGroup3);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo3);
      }
    }
  }
  
  return setupBlock; // 返回根块
}

/**
 * 创建串口通信结构
 */
async function createSerialCommunicationStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('📡 创建串口通信结构');
  
  // 创建串口初始化块
  const serialInitBlock = await createBlockSafely(workspace, 'serial_begin', position, true);
  createdBlocks.push(serialInitBlock.id);
  
  // 设置串口参数
  if (config.serialPort) {
    serialInitBlock.setFieldValue(config.serialPort, 'SERIAL');
  }
  if (config.baudRate) {
    serialInitBlock.setFieldValue(config.baudRate.toString(), 'SPEED');
  }
  
  // 添加通信相关块
  if (config.communicationBlocks) {
    const commBlocks = await createBlockSequence(workspace, config.communicationBlocks);
    if (commBlocks.length > 0) {
      createdBlocks.push(...commBlocks.map(b => b.id));
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        // 连接到串口初始化块的下方
        serialInitBlock.nextConnection.connect(commBlocks[0].previousConnection);
        connections.push({
          sourceId: serialInitBlock.id,
          targetId: commBlocks[0].id,
          connectionType: 'next'
        });
      } catch (connectError) {
        console.warn(`⚠️ 通信块连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    }
  }
  
  return serialInitBlock;
}

/**
 * 创建自定义序列结构
 */
async function createCustomSequenceStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('📝 创建自定义序列结构');
  
  if (!config.sequence) {
    throw new Error('自定义序列结构必须提供 sequence 配置');
  }
  
  const sequenceBlocks = await createBlockSequence(workspace, config.sequence);
  if (sequenceBlocks.length > 0) {
    createdBlocks.push(...sequenceBlocks.map(b => b.id));
    
    // 记录块之间的连接
    for (let i = 0; i < sequenceBlocks.length - 1; i++) {
      connections.push({
        sourceId: sequenceBlocks[i].id,
        targetId: sequenceBlocks[i + 1].id,
        connectionType: 'next'
      });
    }
    
    return sequenceBlocks[0]; // 返回第一个块作为根块
  }
  
  throw new Error('无法创建自定义序列结构');
}

/**
 * 临时实现其他结构函数（待完整实现）
 */
async function createSwitchCaseStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  // 临时实现：创建一个 if-else 链来模拟 switch
  console.log('🔄 创建 switch-case 结构（使用 if-else 链模拟）');
  return await createIfElseStructure(workspace, config, position, createdBlocks, connections);
}

async function createForLoopStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('🔁 创建 for 循环结构（使用重复循环模拟）');
  return await createRepeatLoopStructure(workspace, config, position, createdBlocks, connections);
}

async function createWhileLoopStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('🔁 创建 while 循环结构（使用重复循环模拟）');
  return await createRepeatLoopStructure(workspace, config, position, createdBlocks, connections);
}

async function createFunctionBlockStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('🔧 创建函数块结构（使用自定义序列模拟）');
  return await createCustomSequenceStructure(workspace, config, position, createdBlocks, connections);
}

async function createInitializationStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('⚙️ 创建初始化结构（使用 setup 模拟）');
  return await createSetupLoopStructure(workspace, config, position, createdBlocks, connections);
}

async function createSensorReadingStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('📊 创建传感器读取结构（使用自定义序列模拟）');
  return await createCustomSequenceStructure(workspace, config, position, createdBlocks, connections);
}

async function createActuatorControlStructure(workspace: any, config: any, position: Position, createdBlocks: string[], connections: any[]): Promise<any> {
  console.log('🎮 创建执行器控制结构（使用自定义序列模拟）');
  return await createCustomSequenceStructure(workspace, config, position, createdBlocks, connections);
}

/**
 * 创建动态结构 - 支持用户自定义的任意块结构
 */
async function createDynamicStructure(
  workspace: any, 
  config: any, 
  position: Position, 
  createdBlocks: string[], 
  connections: any[]
): Promise<any> {
  console.log('🚀 创建动态自定义结构');
  
  if (!config.structureDefinition) {
    throw new Error('动态结构必须提供 structureDefinition 配置');
  }
  
  const { rootBlock: rootConfig, additionalBlocks = [], connectionRules = [] } = config.structureDefinition;
  
  // 预分析连接规则，确定每个块需要的输入
  const blockInputRequirements = analyzeInputRequirements(connectionRules);
  console.log('📊 块输入需求分析:', blockInputRequirements);
  
  // 存储所有创建的块，用于后续连接
  const blockMap = new Map<string, any>();
  
  // 1. 创建根块
  console.log('📦 创建根块:', rootConfig.type);
  console.log('🔍 根块配置:', JSON.stringify(rootConfig, null, 2));
  const enhancedRootConfig = enhanceConfigWithInputs(rootConfig, blockInputRequirements);
  const rootBlock = await createBlockFromConfig(workspace, enhancedRootConfig);
  if (rootBlock) {
    console.log(`✅ 根块创建成功: ${rootBlock.type}[${rootBlock.id}]`);
    createdBlocks.push(rootBlock.id);
    blockMap.set('root', rootBlock);
    
    // 如果根块配置有标识符，也用标识符作为键
    if (rootConfig.id) {
      console.log(`🗂️ 设置根块映射键: ${rootConfig.id} → ${rootBlock.type}[${rootBlock.id}]`);
      blockMap.set(rootConfig.id, rootBlock);
    } else {
      console.log(`⚠️ 根块配置没有ID，只使用 'root' 作为键`);
    }
  } else {
    console.error(`❌ 根块创建失败: ${rootConfig.type}`);
  }
  
  // 2. 创建附加块
  for (let i = 0; i < additionalBlocks.length; i++) {
    const blockConfig = additionalBlocks[i];
    console.log(`📦 创建附加块 ${i + 1}:`, blockConfig.type);
    console.log(`🔍 附加块配置:`, JSON.stringify(blockConfig, null, 2));
    
    const enhancedConfig = enhanceConfigWithInputs(blockConfig, blockInputRequirements);
    const block = await createBlockFromConfig(workspace, enhancedConfig);
    if (block) {
      console.log(`✅ 附加块创建成功: ${block.type}[${block.id}]`);
      createdBlocks.push(block.id);
      
      // 使用配置中的ID或索引作为键
      const blockKey = blockConfig.id || `block_${i}`;
      console.log(`🗂️ 设置附加块映射键: ${blockKey} → ${block.type}[${block.id}]`);
      blockMap.set(blockKey, block);
    } else {
      console.error(`❌ 附加块创建失败: ${blockConfig.type}`);
    }
  }
  
  // 3. 根据连接规则连接块
  console.log('🗺️ 当前块映射表:');
  for (const [key, block] of blockMap.entries()) {
    console.log(`  - ${key} → ${block.type}[${block.id}]`);
  }
  
  for (const rule of connectionRules) {
    try {
      console.log(`🔍 尝试连接: ${rule.source} -> ${rule.target}`);
      const sourceBlock = blockMap.get(rule.source);
      const targetBlock = blockMap.get(rule.target);
      
      if (sourceBlock && targetBlock) {
        console.log(`✅ 找到连接块: ${sourceBlock.type}[${sourceBlock.id}] -> ${targetBlock.type}[${targetBlock.id}]`);
        console.log(`🔗 连接块: ${rule.source} -> ${rule.target}`);
        
        // 在连接操作时临时禁用事件，避免移动事件错误
        const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
        const currentGroup = window['Blockly'].Events.getGroup();
        window['Blockly'].Events.disable();
        
        try {
          if (rule.connectionType === 'next' || !rule.connectionType) {
            // 下一个块连接
            if (sourceBlock.nextConnection && targetBlock.previousConnection) {
              sourceBlock.nextConnection.connect(targetBlock.previousConnection);
              connections.push({
                sourceId: sourceBlock.id,
                targetId: targetBlock.id,
                connectionType: 'next'
              });
              console.log(`✅ next 连接成功: ${sourceBlock.type} -> ${targetBlock.type}`);
            }
          } else if (rule.connectionType === 'input' && rule.inputName) {
            // 输入连接
            const inputConnection = sourceBlock.getInput(rule.inputName);
            if (inputConnection && targetBlock.outputConnection) {
              inputConnection.connection.connect(targetBlock.outputConnection);
              connections.push({
                sourceId: sourceBlock.id,
                targetId: targetBlock.id,
                connectionType: 'input',
                inputName: rule.inputName
              });
              console.log(`✅ input 连接成功: ${sourceBlock.type}.${rule.inputName} -> ${targetBlock.type}`);
            }
          } else if (rule.connectionType === 'statement') {
            // 父块连接（statement连接）
            const statementConnection = sourceBlock.getInput(rule.inputName || 'DO');
            if (statementConnection && targetBlock.previousConnection) {
              statementConnection.connection.connect(targetBlock.previousConnection);
              connections.push({
                sourceId: sourceBlock.id,
                targetId: targetBlock.id,
                connectionType: 'statement',
                inputName: rule.inputName || 'DO'
              });
              console.log(`✅ statement 连接成功: ${sourceBlock.type}.${rule.inputName || 'DO'} -> ${targetBlock.type}`);
            }
          }
        } catch (connectError) {
          console.warn(`⚠️ 连接操作时出错: ${connectError}, 但连接尝试继续`);
        } finally {
          // 恢复事件系统
          window['Blockly'].Events.enable();
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
        }
      } else {
        console.warn(`⚠️ 无法找到连接的块: ${rule.source} -> ${rule.target}`);
        console.warn(`  源块 "${rule.source}": ${sourceBlock ? '✅ 找到' : '❌ 未找到'}`);
        console.warn(`  目标块 "${rule.target}": ${targetBlock ? '✅ 找到' : '❌ 未找到'}`);
        console.warn(`  可用的块键: [${Array.from(blockMap.keys()).join(', ')}]`);
      }
    } catch (error) {
      console.error(`❌ 连接块时出错:`, error);
    }
  }
  
  return rootBlock;
}

/**
 * 分析连接规则，确定每个块需要的输入
 */
function analyzeInputRequirements(connectionRules: any[]): Map<string, string[]> {
  const requirements = new Map<string, string[]>();
  
  for (const rule of connectionRules) {
    if (rule.connectionType === 'input' && rule.inputName) {
      const sourceId = rule.source;
      if (!requirements.has(sourceId)) {
        requirements.set(sourceId, []);
      }
      const inputs = requirements.get(sourceId)!;
      if (!inputs.includes(rule.inputName)) {
        inputs.push(rule.inputName);
      }
    }
  }
  
  return requirements;
}

/**
 * 根据输入需求增强块配置
 */
function enhanceConfigWithInputs(config: any, requirements: Map<string, string[]>): any {
  if (!config.id || !requirements.has(config.id)) {
    return config;
  }
  
  const requiredInputs = requirements.get(config.id)!;
  const enhancedConfig = { ...config };
  
  // 如果配置中没有 inputs，创建一个空的
  if (!enhancedConfig.inputs) {
    enhancedConfig.inputs = {};
  }
  
  // 为每个需要的输入添加占位符
  for (const inputName of requiredInputs) {
    if (!enhancedConfig.inputs[inputName]) {
      enhancedConfig.inputs[inputName] = { placeholder: true };
    }
  }
  
  console.log(`🔧 增强块配置 ${config.id}，添加输入: ${requiredInputs.join(', ')}`);
  
  return enhancedConfig;
}

/**
 * 创建块序列
 */
async function createBlockSequence(workspace: any, sequence: BlockConfig | BlockConfig[]): Promise<any[]> {
  const blocks: any[] = [];
  const configs = Array.isArray(sequence) ? sequence : [sequence];
  
  // 禁用事件系统避免连接时的移动事件错误
  const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
  const currentGroup = window['Blockly'].Events.getGroup();
  window['Blockly'].Events.disable();
  
  try {
    for (let i = 0; i < configs.length; i++) {
      const block = await createBlockFromConfig(workspace, configs[i]);
      blocks.push(block);
      
      // 连接到前一个块
      if (i > 0 && blocks[i-1].nextConnection && block.previousConnection) {
        blocks[i-1].nextConnection.connect(block.previousConnection);
      }
    }
  } catch (sequenceError) {
    console.warn(`⚠️ 块序列创建时出错: ${sequenceError}, 但序列创建尝试继续`);
  } finally {
    // 恢复事件系统
    window['Blockly'].Events.enable();
    if (currentGroup) {
      window['Blockly'].Events.setGroup(currentGroup);
    }
    window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
  }
  
  // 确保序列创建完成后事件组正确清理
  setTimeout(() => {
    try {
      window['Blockly'].Events.setGroup(false);
    } catch (e) {
      console.warn('⚠️ 序列创建后事件组清理出错:', e);
    }
  }, 100);
  
  return blocks;
}

/**
 * 处理块插入位置
 */
async function handleBlockInsertion(
  workspace: any, 
  newBlock: any, 
  insertPosition: string, 
  targetBlockId: string, 
  targetInput?: string
): Promise<void> {
  console.log(`🔗 handleBlockInsertion 开始执行`);
  console.log(`📊 新块: ${newBlock.type} (ID: ${newBlock.id})`);
  console.log(`🎯 插入位置: ${insertPosition}`);
  console.log(`🎯 目标块ID: ${targetBlockId}`);
  console.log(`🎯 目标输入: ${targetInput || '未指定'}`);
  
  const targetBlock = getBlockByIdSmart(workspace, targetBlockId);
  if (!targetBlock) {
    console.log(`❌ 未找到目标块: ${targetBlockId}（已尝试模糊匹配）`);
    throw new Error(`未找到目标块: ${targetBlockId}`);
  }
  
  console.log(`✅ 找到目标块: ${targetBlock.type} (ID: ${targetBlock.id})`);
  
  switch (insertPosition) {
    case 'after':
      console.log(`🔗 执行 after 连接（智能插入版）...`);
      if (targetBlock.nextConnection && newBlock.previousConnection) {
        // 禁用事件系统避免连接时的移动事件错误
        const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
        const currentGroup = window['Blockly'].Events.getGroup();
        window['Blockly'].Events.disable();
        
        try {
          // 🎯 智能插入：如果目标块后面已经有块，自动后移
          const existingNextBlock = targetBlock.getNextBlock();
          if (existingNextBlock) {
            console.log(`🔄 检测到目标块后已有块: ${existingNextBlock.type}(${existingNextBlock.id})`);
            console.log('📋 智能插入模式：将现有块后移到新插入块的后面');
            
            // 断开现有连接
            targetBlock.nextConnection.disconnect();
            console.log('✅ 已断开目标块的现有连接');
            
            // 连接新块到目标块
            targetBlock.nextConnection.connect(newBlock.previousConnection);
            console.log('✅ 新块已连接到目标块');
            
            // 将原有的下一个块连接到新块后面
            if (newBlock.nextConnection && existingNextBlock.previousConnection) {
              newBlock.nextConnection.connect(existingNextBlock.previousConnection);
              console.log(`✅ 原有块 ${existingNextBlock.type} 已重新连接到新块后面`);
              console.log(`🎉 智能插入完成：${targetBlock.type} → ${newBlock.type} → ${existingNextBlock.type}`);
            } else {
              console.log('⚠️ 无法重新连接原有块，原有块将保持断开状态');
            }
          } else {
            // 没有现有连接，直接连接
            targetBlock.nextConnection.connect(newBlock.previousConnection);
            console.log(`✅ after 连接完成（无现有块）`);
          }
        } catch (connectError) {
          console.warn(`⚠️ after连接时出错: ${connectError}, 但连接尝试继续`);
        } finally {
          // 恢复事件系统
          window['Blockly'].Events.enable();
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
        }
      } else {
        console.log(`❌ after 连接失败 - 连接类型不兼容`);
      }
      break;
      
    case 'before':
      console.log(`🔗 执行 before 连接（智能插入版）...`);
      if (targetBlock.previousConnection && newBlock.nextConnection) {
        // 禁用事件系统避免连接时的移动事件错误
        const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
        const currentGroup = window['Blockly'].Events.getGroup();
        window['Blockly'].Events.disable();
        
        try {
          // 🎯 智能插入：如果目标块前面已经有块，保持连接
          const existingPrevBlock = targetBlock.getPreviousBlock();
          if (existingPrevBlock) {
            console.log(`🔄 检测到目标块前已有块: ${existingPrevBlock.type}(${existingPrevBlock.id})`);
            console.log('📋 智能插入模式：在前一个块和目标块之间插入新块');
            
            // 断开现有连接
            existingPrevBlock.nextConnection.disconnect();
            console.log('✅ 已断开前一个块的连接');
            
            // 连接前一个块到新块
            if (existingPrevBlock.nextConnection && newBlock.previousConnection) {
              existingPrevBlock.nextConnection.connect(newBlock.previousConnection);
              console.log('✅ 前一个块已连接到新块');
            }
            
            // 连接新块到目标块
            newBlock.nextConnection.connect(targetBlock.previousConnection);
            console.log(`✅ 新块已连接到目标块`);
            console.log(`🎉 智能插入完成：${existingPrevBlock.type} → ${newBlock.type} → ${targetBlock.type}`);
          } else {
            // 没有前一个块，直接连接
            newBlock.nextConnection.connect(targetBlock.previousConnection);
            console.log(`✅ before 连接完成（无前一个块）`);
          }
        } catch (connectError) {
          console.warn(`⚠️ before连接时出错: ${connectError}, 但连接尝试继续`);
        } finally {
          // 恢复事件系统
          window['Blockly'].Events.enable();
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
        }
      } else {
        console.log(`❌ before 连接失败 - 连接类型不兼容`);
      }
      break;
      
    case 'input':
      console.log(`🔗 执行 input 连接...`);
      if (targetInput && targetBlock.getInput(targetInput)) {
        // 禁用事件系统避免连接时的移动事件错误
        const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
        const currentGroup = window['Blockly'].Events.getGroup();
        window['Blockly'].Events.disable();
        
        try {
          const input = targetBlock.getInput(targetInput);
          if (input.connection && newBlock.outputConnection) {
            input.connection.connect(newBlock.outputConnection);
            console.log(`✅ input 连接完成 (output)`);
          } else if (input.connection && newBlock.previousConnection) {
            input.connection.connect(newBlock.previousConnection);
            console.log(`✅ input 连接完成 (previous)`);
          } else {
            console.log(`❌ input 连接失败 - 连接类型不兼容`);
          }
        } catch (connectError) {
          console.warn(`⚠️ input连接时出错: ${connectError}, 但连接尝试继续`);
        } finally {
          // 恢复事件系统
          window['Blockly'].Events.enable();
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
        }
      } else {
        console.log(`❌ input 连接失败 - 目标输入无效`);
      }
      break;
      
    case 'statement':
      console.log(`🔗 执行 statement 连接...`);
      // 专门用于 hat 块（如 arduino_setup, arduino_loop）的 statement 连接
      await handleStatementInsertion(targetBlock, newBlock, targetInput);
      console.log(`✅ statement 连接完成`);
      break;
      
    default:
      console.log(`❌ 未知的插入位置: ${insertPosition}`);
      break;
  }
  
  console.log(`🏁 handleBlockInsertion 执行完成`);
}

/**
 * 处理 statement 类型的插入，专门用于 hat 块
 */
async function handleStatementInsertion(
  targetBlock: any, 
  newBlock: any, 
  targetInput?: string
): Promise<void> {
  console.log(`🔗 handleStatementInsertion 开始执行`);
  console.log(`📊 目标块: ${targetBlock.type} (ID: ${targetBlock.id})`);
  console.log(`📦 新块: ${newBlock.type} (ID: ${newBlock.id})`);
  console.log(`🎯 指定输入: ${targetInput || '未指定'}`);
  
  // 如果指定了 targetInput，使用指定的输入
  if (targetInput && targetBlock.getInput(targetInput)) {
    console.log(`✅ 使用指定的输入: ${targetInput}`);
    const input = targetBlock.getInput(targetInput);
    console.log(`🔍 输入连接类型: ${input.connection ? input.connection.type : '无连接'} (期望: 3 = statement)`);
    console.log(`🔍 新块连接类型: previousConnection = ${!!newBlock.previousConnection}`);
    
    if (input.connection && input.connection.type === 3 && newBlock.previousConnection) { // type 3 是 statement 连接
      console.log(`🔗 准备连接到指定输入...`);
      
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        // 如果已经有连接的块，插入到链的末尾
        if (input.connection.isConnected()) {
          console.log(`⚠️ 输入已有连接，插入到链末尾...`);
          let lastBlock = input.connection.targetBlock();
          while (lastBlock && lastBlock.getNextBlock()) {
            lastBlock = lastBlock.getNextBlock();
          }
          if (lastBlock && lastBlock.nextConnection) {
            lastBlock.nextConnection.connect(newBlock.previousConnection);
            console.log(`✅ 成功连接到链末尾: ${lastBlock.type} → ${newBlock.type}`);
          }
        } else {
          console.log(`🔗 直接连接到空输入...`);
          input.connection.connect(newBlock.previousConnection);
          console.log(`✅ 成功连接: ${targetBlock.type}.${targetInput} ← ${newBlock.type}`);
        }
      } catch (connectError) {
        console.warn(`⚠️ statement连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    } else {
      console.log(`❌ 连接失败 - 连接类型不兼容`);
    }
    return;
  }
  
  console.log(`🔍 自动检测 statement 输入...`);
  // 自动检测 statement 输入
  const statementInputs = [];
  for (let i = 0; i < targetBlock.inputList.length; i++) {
    const input = targetBlock.inputList[i];
    if (input.connection && input.connection.type === 3) { // statement 连接
      statementInputs.push(input);
      console.log(`✅ 发现 statement 输入: ${input.name} (类型: ${input.connection.type})`);
    }
  }
  
  console.log(`📊 找到 ${statementInputs.length} 个 statement 输入`);
  
  if (statementInputs.length > 0) {
    // 优先使用常见的 statement 输入名称
    const commonStatementNames = ['ARDUINO_SETUP', 'ARDUINO_LOOP', 'DO', 'BODY', 'STATEMENT'];
    let selectedInput = statementInputs[0]; // 默认使用第一个
    
    for (const input of statementInputs) {
      if (commonStatementNames.includes(input.name)) {
        selectedInput = input;
        console.log(`🎯 选择优先输入: ${input.name}`);
        break;
      }
    }
    
    if (!selectedInput) {
      selectedInput = statementInputs[0];
    }
    console.log(`🎯 最终选择输入: ${selectedInput.name}`);
    
    // 执行连接
    if (selectedInput.connection && newBlock.previousConnection) {
      // 禁用事件系统避免连接时的移动事件错误
      const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
      const currentGroup = window['Blockly'].Events.getGroup();
      window['Blockly'].Events.disable();
      
      try {
        if (selectedInput.connection.isConnected()) {
          console.log(`⚠️ 输入已有连接，插入到链末尾...`);
          // 插入到现有块链的末尾
          let lastBlock = selectedInput.connection.targetBlock();
          while (lastBlock && lastBlock.getNextBlock()) {
            lastBlock = lastBlock.getNextBlock();
          }
          if (lastBlock && lastBlock.nextConnection) {
            lastBlock.nextConnection.connect(newBlock.previousConnection);
            console.log(`✅ 成功连接到链末尾: ${lastBlock.type} → ${newBlock.type}`);
          }
        } else {
          console.log(`🔗 直接连接到空输入...`);
          selectedInput.connection.connect(newBlock.previousConnection);
          console.log(`✅ 成功连接: ${targetBlock.type}.${selectedInput.name} ← ${newBlock.type}`);
        }
      } catch (connectError) {
        console.warn(`⚠️ 自动statement连接时出错: ${connectError}, 但连接尝试继续`);
      } finally {
        // 恢复事件系统
        window['Blockly'].Events.enable();
        if (currentGroup) {
          window['Blockly'].Events.setGroup(currentGroup);
        }
        window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
      }
    } else {
      console.log(`❌ 连接失败 - 连接对象无效`);
    }
  } else {
    console.log(`❌ 目标块 ${targetBlock.type} 没有可用的 statement 输入`);
    throw new Error(`目标块 ${targetBlock.type} 没有可用的 statement 输入`);
  }
  
  console.log(`🏁 handleStatementInsertion 执行完成`);
}

/**
 * 解析条件表达式字符串为块配置
 */
function parseConditionExpression(conditionStr: string): any {
  console.log('🔍 解析条件表达式:', conditionStr);
  
  // 简单的表达式解析，支持常见的比较操作
  const patterns = [
    { regex: /(\w+)\s*>\s*(\d+)/, op: 'GT' },
    { regex: /(\w+)\s*<\s*(\d+)/, op: 'LT' },
    { regex: /(\w+)\s*>=\s*(\d+)/, op: 'GTE' },
    { regex: /(\w+)\s*<=\s*(\d+)/, op: 'LTE' },
    { regex: /(\w+)\s*==\s*(\d+)/, op: 'EQ' },
    { regex: /(\w+)\s*!=\s*(\d+)/, op: 'NEQ' }
  ];
  
  for (const pattern of patterns) {
    const match = conditionStr.match(pattern.regex);
    if (match) {
      const [, variable, value] = match;
      console.log(`✅ 解析成功: ${variable} ${pattern.op} ${value}`);
      
      return {
        type: 'logic_compare',
        fields: { OP: pattern.op },
        inputs: {
          A: {
            type: 'variables_get',
            fields: { VAR: variable }
          },
          B: {
            type: 'math_number',
            fields: { NUM: value }
          }
        }
      };
    }
  }
  
  // 如果无法解析，返回一个默认的比较块
  console.log('⚠️ 无法解析条件表达式，使用默认配置');
  return {
    type: 'logic_compare',
    fields: { OP: 'GT' },
    inputs: {
      A: {
        type: 'text',
        fields: { TEXT: conditionStr }
      },
      B: {
        type: 'math_number',
        fields: { NUM: '0' }
      }
    }
  };
}

/**
 * 修复Blockly特定的结构问题
 * 主要解决DO块错误嵌套等问题
 */
function fixBlocklyStructures(sequence: any[]): any[] {
  console.log('🔍 开始Blockly结构修复...');
  
  return sequence.map((blockConfig, index) => {
    console.log(`🔧 处理序列块 ${index + 1}: ${blockConfig.type}`);
    
    if (blockConfig.type === 'controls_if') {
      return fixControlsIfStructure(blockConfig);
    }
    
    // 修复所有块的输入嵌套问题
    return fixInputNestingIssues(blockConfig);
  });
}

/**
 * 修复输入嵌套问题
 * 解决如B输入被错误嵌套在A输入内部的问题
 */
function fixInputNestingIssues(blockConfig: any): any {
  if (!blockConfig.inputs) {
    return blockConfig;
  }
  
  console.log(`🔍 检查 ${blockConfig.type} 的输入嵌套问题...`);
  
  const fixedConfig = { ...blockConfig };
  const extractedInputs: any = {};
  let foundMisplacedInputs = false;
  
  // 递归修复函数
  function fixNestedInputs(inputs: any): any {
    const cleanedInputs: any = {};
    
    for (const [inputName, inputConfig] of Object.entries(inputs)) {
      if (inputConfig && typeof inputConfig === 'object') {
        // 检查是否有错误嵌套的输入（除了block和shadow之外的键）
        const misplacedKeys = Object.keys(inputConfig).filter(key => 
          key !== 'block' && 
          key !== 'shadow' && 
          typeof inputConfig[key] === 'object' && 
          inputConfig[key].block
        );
        
        if (misplacedKeys.length > 0) {
          console.log(`🔄 发现错误嵌套的输入: ${misplacedKeys.join(', ')} (在 ${inputName} 内部)`);
          foundMisplacedInputs = true;
          
          // 提取错误嵌套的输入
          misplacedKeys.forEach(key => {
            extractedInputs[key] = inputConfig[key];
          });
          
          // 创建清理后的输入配置
          const cleanedInputConfig = { ...inputConfig };
          misplacedKeys.forEach(key => {
            delete cleanedInputConfig[key];
          });
          
          cleanedInputs[inputName] = cleanedInputConfig;
        } else {
          cleanedInputs[inputName] = inputConfig;
        }
        
        // 递归处理嵌套的块
        if ((inputConfig as any).block && (inputConfig as any).block.inputs) {
          const cleanedNestedInputs = fixNestedInputs((inputConfig as any).block.inputs);
          cleanedInputs[inputName] = {
            ...cleanedInputs[inputName],
            block: {
              ...(inputConfig as any).block,
              inputs: cleanedNestedInputs
            }
          };
        }
      } else {
        cleanedInputs[inputName] = inputConfig;
      }
    }
    
    return cleanedInputs;
  }
  
  // 修复输入嵌套
  const cleanedInputs = fixNestedInputs(fixedConfig.inputs);
  
  // 将提取的输入添加到正确位置
  const finalInputs = { ...cleanedInputs, ...extractedInputs };
  
  fixedConfig.inputs = finalInputs;
  
  if (foundMisplacedInputs) {
    console.log(`✅ 修复了 ${Object.keys(extractedInputs).length} 个错误嵌套的输入`);
    console.log('📦 提取的输入:', Object.keys(extractedInputs));
  }
  
  return fixedConfig;
}

/**
 * 修复 controls_if 块的结构问题
 */
function fixControlsIfStructure(blockConfig: any): any {
  if (blockConfig.type !== 'controls_if') {
    return blockConfig;
  }
  
  console.log(`🔍 开始修复 controls_if 结构...`);
  
  const fixedConfig = { ...blockConfig };
  
  if (fixedConfig.inputs) {
    for (const [inputName, inputConfig] of Object.entries(fixedConfig.inputs)) {
      if (inputConfig && typeof inputConfig === 'object') {
        if ((inputConfig as any).block) {
          const nestedBlock = (inputConfig as any).block;
          
          // 检查所有嵌套块是否有错误嵌套的DO块（不限于logic_compare）
          const extractedDOs: any = {};
          const cleanedBlockProps: any = {};
          
          for (const [blockProp, blockValue] of Object.entries(nestedBlock)) {
            if (blockProp.startsWith('DO') && blockValue) {
              console.log(`🔄 发现错误嵌套的DO块: ${blockProp} (在${nestedBlock.type || 'unknown'}块层级)`);
              extractedDOs[blockProp] = blockValue;
            } else {
              cleanedBlockProps[blockProp] = blockValue;
            }
          }
          
          if (Object.keys(extractedDOs).length > 0) {
            console.log(`✅ 从${nestedBlock.type || 'unknown'}块中提取了${Object.keys(extractedDOs).length}个DO块`);
            
            // 更新嵌套块，移除DO块
            (inputConfig as any).block = cleanedBlockProps;
            
            // 将DO块添加到controls_if的inputs中
            Object.assign(fixedConfig.inputs, extractedDOs);
          }
        }
      }
    }
  }
  
  return fixedConfig;
}

/**
 * 修复块配置中的常见问题
 */
function fixBlockConfigurations(blocks: any): any {
  if (!blocks) return blocks;
  
  console.log('🔧 fixBlockConfigurations 开始修复:', JSON.stringify(blocks, null, 2));
  
  const blockArray = Array.isArray(blocks) ? blocks : [blocks];
  
  const fixedBlocks = blockArray.map(block => {
    if (typeof block === 'string') {
      // 如果是字符串，转换为文本块
      console.log(`🔄 字符串转换为文本块: "${block}"`);
      return {
        type: 'text',
        fields: { TEXT: block }
      };
    }
    
    if (block && typeof block === 'object') {
      const fixedBlock = { ...block };
      
      // 修复 inputs 格式 - 这是核心修复逻辑
      if (fixedBlock.inputs && typeof fixedBlock.inputs === 'object') {
        console.log(`🔍 修复输入格式...`);
        Object.keys(fixedBlock.inputs).forEach(inputName => {
          const input = fixedBlock.inputs[inputName];
          console.log(`  - 检查输入 "${inputName}":`, JSON.stringify(input));
          
          if (input && typeof input === 'object') {
            // 检查是否是简化格式: { type: "xxx", fields: {...} }
            if (input.type && input.fields && !input.block && !input.shadow) {
              console.log(`  ✅ 发现简化格式，转换为标准格式`);
              fixedBlock.inputs[inputName] = {
                block: {
                  type: input.type,
                  fields: input.fields,
                  inputs: input.inputs // 保留嵌套的输入
                }
              };
              console.log(`  ✅ 转换完成:`, JSON.stringify(fixedBlock.inputs[inputName]));
            }
            // 处理 text 字段问题（向后兼容）
            else if (input.text && !input.fields) {
              console.log(`  🔄 修复 text 字段问题`);
              fixedBlock.inputs[inputName] = {
                block: {
                  type: input.type || 'text',
                  fields: { TEXT: input.text }
                }
              };
            }
          }
        });
      }
      
      // 递归处理嵌套的块配置
      if (fixedBlock.inputs) {
        Object.keys(fixedBlock.inputs).forEach(inputName => {
          const input = fixedBlock.inputs[inputName];
          if (input && input.block && input.block.inputs) {
            console.log(`🔄 递归修复嵌套输入...`);
            input.block = fixBlockConfigurations(input.block);
          }
        });
      }
      
      console.log(`✅ 块修复完成:`, JSON.stringify(fixedBlock, null, 2));
      return fixedBlock;
    }
    
    return block;
  });
  
  // 如果原始输入不是数组，返回单个对象
  const result = Array.isArray(blocks) ? fixedBlocks : fixedBlocks[0];
  console.log('🎉 fixBlockConfigurations 完成:', JSON.stringify(result, null, 2));
  return result;
}

// =============================================================================
// 原有辅助函数
// =============================================================================

/**
 * 获取当前活动的 Blockly 工作区
 */
async function getCurrentWorkspace(): Promise<any> {
  try {
    // 方法1: 尝试从 Angular 服务获取工作区（优先）
    const blocklyService = getBlocklyService();
    if (blocklyService?.workspace && !blocklyService.workspace.disposed) {
      return blocklyService.workspace;
    }

    // 方法2: 尝试从全局 Blockly 获取主工作区
    if (window['Blockly']?.getMainWorkspace) {
      const mainWorkspace = window['Blockly'].getMainWorkspace();
      if (mainWorkspace && !mainWorkspace.disposed) {
        return mainWorkspace;
      }
    }

    // 方法3: 尝试从所有工作区中找到活动的
    if (window['Blockly']?.Workspace?.getAll) {
      const workspaces = window['Blockly'].Workspace.getAll();
      for (const workspace of workspaces) {
        if (!workspace.disposed && workspace.svgGroup_) {
          const svgElement = workspace.getParentSvg();
          if (svgElement && svgElement.parentNode) {
            return workspace;
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error('获取工作区时出错:', error);
    return null;
  }
}

/**
 * 获取 BlocklyService 实例
 */
function getBlocklyService(): any {
  try {
    if ((window as any)['blocklyService']) {
      return (window as any)['blocklyService'];
    }

    const injector = (window as any)['ng']?.getInjector?.(document.body);
    if (injector) {
      try {
        return injector.get('BlocklyService');
      } catch (e) {
        console.debug('无法通过依赖注入获取 BlocklyService:', e);
      }
    }

    const elements = document.querySelectorAll('[ng-version]');
    for (const element of elements) {
      try {
        const componentRef = (window as any)['ng']?.getComponent?.(element);
        if (componentRef?.blocklyService) {
          return componentRef.blocklyService;
        }
      } catch (e) {
        // 继续尝试下一个元素
      }
    }

    return null;
  } catch (error) {
    console.error('获取 BlocklyService 时出错:', error);
    return null;
  }
}

/**
 * 计算块的放置位置
 */
function calculateBlockPosition(workspace: any, x?: number, y?: number): Position {
  try {
    if (typeof x === 'number' && typeof y === 'number') {
      return { x, y };
    }

    const metrics = workspace.getMetrics?.();
    if (metrics) {
      const centerX = metrics.viewLeft + (metrics.viewWidth / 2);
      const centerY = metrics.viewTop + (metrics.viewHeight / 2);
      
      const offsetX = (Math.random() - 0.5) * 100;
      const offsetY = (Math.random() - 0.5) * 100;
      
      return {
        x: centerX + offsetX,
        y: centerY + offsetY
      };
    }

    return { x: 100, y: 100 };
  } catch (error) {
    console.error('计算位置时出错:', error);
    return { x: 100, y: 100 };
  }
}

/**
 * 初始化事件错误处理器，防止拖动时的事件错误
 */
function initializeEventErrorHandler(): void {
  try {
    const workspace = window['Blockly'].getMainWorkspace();
    if (workspace && !workspace.disposed) {
      
      // 添加全局事件监听器来捕获和处理事件错误
      const originalAddEventHandler = workspace.addChangeListener;
      if (originalAddEventHandler) {
        workspace.addChangeListener = function(handler) {
          const wrappedHandler = function(event) {
            try {
              // 检查事件对象的有效性
              if (event && event.blockId) {
                const block = workspace.getBlockById(event.blockId);
                if (!block && event.type === 'move') {
                  console.warn(`⚠️ 忽略无效的移动事件，块ID: ${event.blockId}`);
                  return; // 忽略无效的移动事件
                }
              }
              
              return handler.call(this, event);
            } catch (error) {
              console.warn(`⚠️ 事件处理器出错: ${error}, 事件类型: ${event?.type}`);
              // 不重新抛出错误，避免破坏用户体验
            }
          };
          
          return originalAddEventHandler.call(this, wrappedHandler);
        };
        
        console.log('🛡️ 事件错误处理器已初始化');
      }
    }
  } catch (error) {
    console.warn('⚠️ 初始化事件错误处理器失败:', error);
  }
}

/**
 * 生成唯一ID的工具函数
 */
function generateUniqueId(prefix: string = 'id'): string {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * 确保事件组正确清理，避免拖动时的事件冲突
 */
function ensureEventGroupCleanup(): void {
  try {
    // 清除任何遗留的事件组
    window['Blockly'].Events.setGroup(false);
    
    // 确保事件系统启用
    window['Blockly'].Events.enable();
    
    // 恢复撤销记录
    window['Blockly'].Events.setRecordUndo(true);
    
    // 触发工作区刷新，确保所有事件处理器处于正确状态
    const workspace = window['Blockly'].getMainWorkspace();
    if (workspace && !workspace.disposed) {
      // 清理撤销栈中可能的无效事件
      try {
        workspace.clearUndo();
        console.log('🧹 事件组清理完成，工作区状态已重置');
      } catch (undoError) {
        console.log('🧹 事件组清理完成 (撤销栈清理跳过)');
      }
      
      // 强制刷新工作区渲染，确保所有块都处于正确状态
      setTimeout(() => {
        try {
          workspace.render();
        } catch (renderError) {
          console.warn('⚠️ 工作区渲染刷新出错:', renderError);
        }
      }, 50);
    } else {
      console.log('🧹 事件组清理完成');
    }
  } catch (error) {
    console.warn('⚠️ 事件组清理时出错:', error);
    // 即使清理出错，也要确保基本的事件系统状态
    try {
      window['Blockly'].Events.enable();
      window['Blockly'].Events.setGroup(false);
    } catch (fallbackError) {
      console.error('❌ 事件系统恢复失败:', fallbackError);
    }
  }
}

/**
 * 安全地在工作区中创建块
 */
async function createBlockSafely(
  workspace: any,
  type: string,
  position: Position,
  animate: boolean,
  customId?: string  // 新增：自定义块ID参数
): Promise<any> {
  try {
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          if (!workspace || workspace.disposed) {
            reject(new Error('工作区已被销毁'));
            return;
          }

          const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
          const currentGroup = window['Blockly'].Events.getGroup();

          // 禁用事件系统，避免ID更改时的事件错误
          window['Blockly'].Events.disable();

          const block = workspace.newBlock(type);

          if (!block) {
            window['Blockly'].Events.enable();
            reject(new Error(`无法创建类型为 "${type}" 的 block`));
            return;
          }

          // 设置自定义ID（在initSvg之前，避免事件问题）
          if (customId) {
            console.log(`🆔 设置自定义块ID: ${customId}`);
            // 检查ID是否已存在
            const existingBlock = workspace.getBlockById(customId);
            if (existingBlock) {
              console.warn(`⚠️ 块ID "${customId}" 已存在，将使用默认生成的ID: ${block.id}`);
            } else {
              try {
                // 在initSvg之前设置ID，避免事件问题
                const originalId = block.id;
                block.id = customId;
                console.log(`✅ 自定义块ID设置成功: ${customId} (原ID: ${originalId})`);
              } catch (error) {
                console.warn(`⚠️ 设置自定义ID失败: ${error}, 将使用默认ID: ${block.id}`);
              }
            }
          }

          // 确保在设置ID后再初始化SVG
          block.initSvg();
          block.render();

          // 重新启用事件系统
          window['Blockly'].Events.enable();

          // 确保事件组正确恢复，避免拖动时的事件冲突
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          } else {
            // 确保没有遗留的事件组
            window['Blockly'].Events.setGroup(false);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);

          // 移动块到指定位置（在事件系统恢复后，但暂时禁用事件避免错误）
          if (position.x !== 0 || position.y !== 0) {
            // 为移动操作创建新的事件组，避免与之前的事件冲突
            const moveEventGroup = generateUniqueId('move');
            window['Blockly'].Events.setGroup(moveEventGroup);
            
            try {
              block.moveBy(position.x || 0, position.y || 0);
            } catch (moveError) {
              console.warn(`⚠️ 块移动时出错: ${moveError}, 但块创建成功`);
            } finally {
              // 移动完成后清除事件组
              window['Blockly'].Events.setGroup(false);
            }
          }

          resolve(block);

        } catch (error) {
          try {
            window['Blockly'].Events.enable();
          } catch (e) {
            console.error('恢复事件系统时出错:', e);
          }
          reject(error);
        }
      }, 50);
    });

  } catch (error) {
    throw error;
  }
}

/**
 * 配置块的字段
 */
async function configureBlockFields(block: any, fields: FieldConfig): Promise<string[]> {
  const updatedFields: string[] = [];

  console.log('🏷️ configureBlockFields 开始执行');
  console.log('📦 字段配置数据:', JSON.stringify(fields, null, 2));
  console.log('🧱 目标块信息:', { id: block.id, type: block.type });

  try {
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      console.log(`\n🔍 处理字段: ${fieldName} = ${JSON.stringify(fieldValue)}`);
      
      const field = block.getField(fieldName);
      if (field) {
        console.log(`✅ 找到字段 "${fieldName}"`);
        console.log('字段类型:', field.constructor.name);
        
        // 特殊处理变量字段 - 使用更灵活的检测方式
        if (fieldName === 'VAR' && (
          field.constructor.name === 'FieldVariable' || 
          field.constructor.name.includes('FieldVariable') ||
          field.getVariable // 检查是否有 getVariable 方法，这是 FieldVariable 的特征
        )) {
          console.log('🔧 处理变量字段...');
          
          let variableName = fieldValue;
          
          // 如果 fieldValue 是对象（如 {name: "humi"}），提取变量名
          if (typeof fieldValue === 'object' && fieldValue.name) {
            variableName = fieldValue.name;
            console.log(`📝 从对象中提取变量名: ${variableName}`);
          }
          
          console.log(`🎯 查找变量: "${variableName}"`);
          
          // 获取工作区
          const workspace = block.workspace;
          console.log(`🔍 工作区变量总数: ${workspace.getAllVariables().length}`);
          
          // 列出所有变量用于调试
          const allVars = workspace.getAllVariables();
          console.log('📋 工作区中的所有变量:');
          allVars.forEach(v => {
            console.log(`  - 变量名: "${v.name}", ID: "${v.getId()}", 类型: "${v.type}"`);
          });
          
          // 查找变量 - 使用更精确的查找方法
          let variable = null;
          
          // 方法1: 通过名称查找（推荐）
          variable = workspace.getVariable(variableName);
          if (variable) {
            console.log(`✅ 通过名称找到变量: "${variableName}" (ID: ${variable.getId()})`);
          } else {
            console.log(`⚠️ 通过名称未找到变量: "${variableName}"`);
            
            // 方法2: 遍历所有变量手动查找
            for (const v of allVars) {
              if (v.name === variableName) {
                variable = v;
                console.log(`✅ 通过遍历找到变量: "${variableName}" (ID: ${v.getId()})`);
                break;
              }
            }
          }
          
          // 如果仍未找到，创建新变量
          if (!variable) {
            console.log(`📝 变量 "${variableName}" 不存在，创建新变量...`);
            variable = workspace.createVariable(variableName);
            console.log(`✅ 新变量创建成功: "${variableName}" (ID: ${variable.getId()})`);
          }
          
          // 验证变量ID
          const variableId = variable.getId();
          console.log(`🔑 准备设置的变量ID: "${variableId}"`);
          
          // 验证ID是否有效
          const verifyVariable = workspace.getVariableById(variableId);
          if (verifyVariable) {
            console.log(`✅ 变量ID验证成功: "${variableId}" → "${verifyVariable.name}"`);
          } else {
            console.error(`❌ 变量ID验证失败: "${variableId}"`);
          }
          
          // 设置变量字段的值
          if (field.setValue) {
            try {
              field.setValue(variableId);
              console.log(`✅ 变量字段设置成功: ${variableName} (ID: ${variableId})`);
              updatedFields.push(fieldName);
            } catch (error) {
              console.error(`❌ 变量字段设置失败: ${error.message}`);
              console.error(`   变量名: "${variableName}", ID: "${variableId}"`);
            }
          } else {
            console.warn(`⚠️ 变量字段 "${fieldName}" 没有 setValue 方法`);
          }
        } else {
          // 处理其他类型的字段
          console.log('🔧 处理普通字段...');
          
          // 处理板卡配置变量引用
          const resolvedValue = await resolveBoardConfigVariable(fieldValue);
          console.log(`🔄 解析后的值: ${resolvedValue}`);
          
          // 根据字段类型设置值
          if (field.setValue) {
            field.setValue(resolvedValue);
            console.log(`✅ 字段设置成功: ${fieldName} = ${resolvedValue}`);
            updatedFields.push(fieldName);
          } else if (field.getText && field.setText) {
            field.setText(resolvedValue);
            console.log(`✅ 字段文本设置成功: ${fieldName} = ${resolvedValue}`);
            updatedFields.push(fieldName);
          } else {
            console.warn(`⚠️ 字段 "${fieldName}" 没有 setValue 或 setText 方法`);
          }
        }
      } else {
        console.error(`❌ 字段 "${fieldName}" 在块 ${block.type} 中不存在`);
        // 列出可用的字段
        const availableFields = [];
        for (let i = 0; i < block.inputList.length; i++) {
          const input = block.inputList[i];
          if (input.fieldRow) {
            for (let j = 0; j < input.fieldRow.length; j++) {
              const field = input.fieldRow[j];
              if (field.name) {
                availableFields.push(field.name);
              }
            }
          }
        }
        console.log('可用的字段列表:', availableFields);
      }
    }
    
    console.log(`✅ configureBlockFields 完成，更新了 ${updatedFields.length} 个字段: ${updatedFields.join(', ')}`);
  } catch (error) {
    console.error('❌ 配置块字段时出错:', error);
  }

  return updatedFields;
}

/**
 * 配置块的输入
 */
async function configureBlockInputs(workspace: any, block: any, inputs: InputConfig): Promise<string[]> {
  const updatedInputs: string[] = [];

  console.log('🔌 configureBlockInputs 开始执行');
  console.log('📦 输入配置数据:', JSON.stringify(inputs, null, 2));
  console.log('🧱 目标块信息:', { id: block.id, type: block.type });

  try {
    for (const [inputName, inputConfig] of Object.entries(inputs)) {
      console.log(`\n🔍 处理输入: ${inputName}`);
      console.log('输入配置:', JSON.stringify(inputConfig, null, 2));
      
      const input = block.getInput(inputName);
      if (input) {
        console.log(`✅ 找到输入 "${inputName}"`);
        console.log('输入类型:', input.type);
        console.log('是否有连接点:', !!input.connection);
        
        if (inputConfig.block) {
          console.log('🏗️ 创建子块...');
          // 创建并连接块
          const childBlock = await createBlockFromConfig(workspace, inputConfig.block);
          if (childBlock && input.connection) {
            console.log(`✅ 子块创建成功: ${childBlock.type} (ID: ${childBlock.id})`);
            const connectionToUse = childBlock.outputConnection || childBlock.previousConnection;
            if (connectionToUse) {
              input.connection.connect(connectionToUse);
              console.log(`🔗 成功连接子块到输入 "${inputName}"`);
              updatedInputs.push(inputName);
            } else {
              console.warn(`⚠️ 子块 ${childBlock.type} 没有可用的连接点`);
            }
          } else {
            console.error(`❌ 子块创建失败或输入没有连接点`);
          }
        } else if (inputConfig.shadow) {
          console.log('👤 创建影子块...');
          // 创建影子块
          const shadowBlock = await createBlockFromConfig(workspace, inputConfig.shadow);
          if (shadowBlock && input.connection) {
            console.log(`✅ 影子块创建成功: ${shadowBlock.type} (ID: ${shadowBlock.id})`);
            
            // 正确设置影子块
            const connectionToUse = shadowBlock.outputConnection || shadowBlock.previousConnection;
            if (connectionToUse) {
              // 先设置为影子块
              shadowBlock.setShadow(true);
              // 然后连接到输入
              input.connection.connect(connectionToUse);
              console.log(`🔗 成功设置影子块到输入 "${inputName}"`);
              updatedInputs.push(inputName);
            } else {
              console.warn(`⚠️ 影子块 ${shadowBlock.type} 没有可用的连接点`);
              console.log('可用的连接点:', {
                outputConnection: !!shadowBlock.outputConnection,
                previousConnection: !!shadowBlock.previousConnection,
                nextConnection: !!shadowBlock.nextConnection
              });
            }
          } else {
            console.error(`❌ 影子块创建失败或输入没有连接点`);
            console.log('调试信息:', {
              shadowBlock: !!shadowBlock,
              inputConnection: !!input.connection,
              blockType: shadowBlock?.type
            });
          }
        } else {
          console.log(`ℹ️ 输入 "${inputName}" 没有块或影子配置`);
        }
      } else {
        console.error(`❌ 输入 "${inputName}" 在块 ${block.type} 中不存在`);
        // 列出可用的输入
        const availableInputs = [];
        for (let i = 0; i < block.inputList.length; i++) {
          const inp = block.inputList[i];
          if (inp.name) {
            availableInputs.push(inp.name);
          }
        }
        console.log('可用的输入列表:', availableInputs);
      }
    }
    
    console.log(`✅ configureBlockInputs 完成，更新了 ${updatedInputs.length} 个输入: ${updatedInputs.join(', ')}`);
  } catch (error) {
    console.error('❌ 配置块输入时出错:', error);
  }

  return updatedInputs;
}

/**
 * 从配置创建块
 */
async function createBlockFromConfig(workspace: any, config: BlockConfig | string): Promise<any> {
  console.log('🏗️ createBlockFromConfig 开始');
  console.log('📦 块配置:', JSON.stringify(config, null, 2));
  
  try {
    // 如果是字符串，创建一个文本块
    if (typeof config === 'string') {
      console.log(`🔨 创建文本块: ${config}`);
      const textBlock = await createBlockSafely(workspace, 'text', { x: 100, y: 100 }, false);
      if (textBlock) {
        textBlock.setFieldValue(config, 'TEXT');
        console.log(`✅ 文本块创建成功: ${config}`);
      }
      return textBlock;
    }
    
    console.log(`🔨 创建块类型: ${config.type}`);
    const position = config.position || { x: 0, y: 0 };
    const block = await createBlockSafely(workspace, config.type, position, false, config.id);
    
    if (!block) {
      console.error(`❌ 块创建失败: ${config.type}`);
      return null;
    }
    
    console.log(`✅ 块创建成功: ${config.type} (ID: ${block.id})`);
    
    // 🔍 调试：检查初始 itemCount_
    if (block.type === 'text_join') {
      console.log(`🔍 步骤0 - 块创建后 itemCount_: ${block.itemCount_}`);
    }
    
    // 检查并应用动态扩展
    await applyDynamicExtensions(block, config);
    
    // 🔍 调试：检查 extraState 处理后的 itemCount_
    if (block.type === 'text_join') {
      console.log(`🔍 步骤1 - extraState 处理后 itemCount_: ${block.itemCount_}`);
    }
    
    if (config.fields) {
      console.log('🏷️ 配置块字段...');
      console.log('字段数据:', JSON.stringify(config.fields));
      await configureBlockFields(block, config.fields);
      console.log('✅ 字段配置完成');
      
      // 🔍 调试：检查 fields 处理后的 itemCount_
      if (block.type === 'text_join') {
        console.log(`🔍 步骤2 - fields 处理后 itemCount_: ${block.itemCount_}`);
      }
    }
    
    if (config.inputs) {
      console.log('🔌 配置块输入...');
      await configureBlockInputs(workspace, block, config.inputs);
      console.log('✅ 块输入配置完成');
      
      // 🔍 调试：检查 inputs 处理后的 itemCount_
      if (block.type === 'text_join') {
        console.log(`🔍 步骤3 - inputs 处理后 itemCount_: ${block.itemCount_}`);
      }
    }
    
    // 处理next连接
    if (config.next) {
      console.log('🔗 配置next连接...');
      const nextBlock = await createBlockFromConfig(workspace, config.next.block);
      if (nextBlock && block.nextConnection && nextBlock.previousConnection) {
        try {
          block.nextConnection.connect(nextBlock.previousConnection);
          console.log(`✅ next连接成功: ${block.type} -> ${nextBlock.type}`);
        } catch (connectionError) {
          console.warn(`⚠️ next连接失败: ${connectionError}`);
        }
      } else {
        console.warn('⚠️ next连接失败: 连接点不可用');
        console.log(`- 当前块 nextConnection: ${!!block.nextConnection}`);
        console.log(`- 下一块 previousConnection: ${!!nextBlock?.previousConnection}`);
      }
    }
    
    console.log(`🎉 createBlockFromConfig 完成: ${config.type}`);
    return block;
  } catch (error) {
    console.error('❌ 从配置创建块时出错:', error);
    return null;
  }
}

/**
 * 应用动态扩展到块
 * 这个函数检查块是否需要动态输入，并根据配置添加所需的输入
 */
async function applyDynamicExtensions(block: any, config: any): Promise<void> {
  console.log('🔧 applyDynamicExtensions 开始执行');
  console.log('🧱 块类型:', block.type);
  console.log('📦 配置:', JSON.stringify(config, null, 2));
  
  try {
    // 首先处理 extraState（如果存在）
    if (config.extraState) {
      console.log('🎛️ 应用 extraState 配置:', JSON.stringify(config.extraState));
      
      // 特殊处理 text_join 块（使用 mutator 系统）
      if (block.type === 'text_join' && config.extraState.itemCount !== undefined) {
        console.log(`🔢 text_join 块特殊处理，设置 itemCount: ${config.extraState.itemCount}`);
        
        // 直接设置 itemCount_ 属性
        block.itemCount_ = config.extraState.itemCount;
        
        // 如果有 updateShape_ 方法，调用它
        if (block.updateShape_ && typeof block.updateShape_ === 'function') {
          block.updateShape_();
          console.log(`✅ text_join 块 updateShape_ 调用完成，itemCount_: ${block.itemCount_}`);
        }
        
        // 如果有 mutator 相关方法，也尝试调用
        if (block.compose && typeof block.compose === 'function') {
          // 创建一个模拟的 mutator 容器
          console.log('🔄 尝试调用 mutator compose 方法');
        }
      }
      // 其他块类型的 extraState 处理
      else if (block.loadExtraState && typeof block.loadExtraState === 'function') {
        console.log('🔄 使用 loadExtraState 方法');
        block.loadExtraState(config.extraState);
      } else if (block.setSaveState && typeof block.setSaveState === 'function') {
        console.log('🔄 使用 setSaveState 方法');
        block.setSaveState(config.extraState);
      } else if (config.extraState.itemCount !== undefined) {
        // 通用的 itemCount 处理
        console.log(`🔢 通用设置 itemCount: ${config.extraState.itemCount}`);
        
        // 尝试通用方式设置
        Object.keys(config.extraState).forEach(key => {
          if (block.hasOwnProperty(key + '_')) {
            block[key + '_'] = config.extraState[key];
            console.log(`✅ 设置 ${key}_: ${config.extraState[key]}`);
          }
        });
        
        // 如果块有 updateShape_ 方法，调用它
        if (block.updateShape_ && typeof block.updateShape_ === 'function') {
          block.updateShape_();
          console.log('🔄 调用 updateShape_ 更新块形状');
        }
      }
    }
    
    // 检查是否有需要动态添加的输入
    if (config.inputs) {
      const inputNames = Object.keys(config.inputs);
      const highestInputNumber = getHighestInputNumber(inputNames);
      
      console.log(`📊 输入名称: ${inputNames.join(', ')}`);
      console.log(`📈 最高输入编号: ${highestInputNumber}`);
      
      // 检查块是否支持动态扩展
      if (block.custom_dynamic_extension) {
        console.log('🚀 块支持 custom_dynamic_extension');
        await extendBlockWithCustomDynamic(block, highestInputNumber);
      } else if (block.setInputsInline !== undefined && block.inputList) {
        console.log('🔧 使用标准方式添加动态输入');
        await addDynamicInputsStandard(block, inputNames);
      } else {
        console.log('ℹ️ 块不支持动态扩展，使用现有输入');
      }
    } else {
      console.log('ℹ️ 没有检测到输入配置');
    }
  } catch (error) {
    console.error('❌ 应用动态扩展时出错:', error);
  }
}

/**
 * 获取输入名称中的最高数字
 */
function getHighestInputNumber(inputNames: string[]): number {
  let highest = -1;
  for (const name of inputNames) {
    const match = name.match(/INPUT(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > highest) {
        highest = num;
      }
    }
  }
  return highest;
}

/**
 * 使用 custom_dynamic_extension 扩展块
 */
async function extendBlockWithCustomDynamic(block: any, targetInputCount: number): Promise<void> {
  console.log('🎯 扩展块到输入数量:', targetInputCount + 1);
  
  try {
    // 获取当前输入数量
    let currentInputCount = 0;
    for (let i = 0; i < block.inputList.length; i++) {
      const input = block.inputList[i];
      if (input.name && input.name.startsWith('INPUT')) {
        currentInputCount++;
      }
    }
    
    console.log(`📊 当前输入数量: ${currentInputCount}, 目标数量: ${targetInputCount + 1}`);
    
    // 检查是否需要更多输入
    if (targetInputCount >= currentInputCount) {
      const needToAdd = targetInputCount - currentInputCount + 1;
      console.log(`➕ 需要添加 ${needToAdd} 个输入`);
      
      // 设置块的 itemCount
      if (block.itemCount !== undefined) {
        block.itemCount = Math.max(block.itemCount || 2, targetInputCount + 1);
        console.log(`📊 更新 itemCount 为: ${block.itemCount}`);
      }
      
      // 检查是否有 minInputs 属性
      const minInputs = block.minInputs || 2;
      console.log(`📊 最小输入数量: ${minInputs}`);
      
      // 从最小输入数量开始添加动态输入
      for (let i = currentInputCount; i <= targetInputCount; i++) {
        const inputName = `INPUT${i}`;
        const existingInput = block.getInput(inputName);
        
        if (!existingInput) {
          console.log(`➕ 添加动态输入: ${inputName}`);
          try {
            block.appendValueInput(inputName);
            console.log(`✅ 成功添加输入: ${inputName}`);
          } catch (error) {
            console.warn(`⚠️ 添加输入 ${inputName} 失败:`, error);
          }
        } else {
          console.log(`ℹ️ 输入 ${inputName} 已存在`);
        }
      }
      
      // 如果块有 finalizeConnections 方法，调用它来完成初始化
      if (typeof block.finalizeConnections === 'function') {
        console.log('🔧 调用 finalizeConnections 完成初始化');
        try {
          // 临时禁用事件，避免触发不必要的更新
          const originalEvents = Blockly.Events.isEnabled();
          Blockly.Events.disable();
          
          block.finalizeConnections();
          
          // 恢复事件状态
          if (originalEvents) {
            Blockly.Events.enable();
          }
          
          console.log('✅ finalizeConnections 调用成功');
        } catch (error) {
          console.warn('⚠️ finalizeConnections 调用失败:', error);
        }
      }
      
      // 如果是 SVG 块，重新初始化 SVG
      if (block.initSvg && typeof block.initSvg === 'function') {
        console.log('🎨 重新初始化 SVG');
        try {
          block.initSvg();
          console.log('✅ SVG 初始化成功');
        } catch (error) {
          console.warn('⚠️ SVG 初始化失败:', error);
        }
      }
    }
  } catch (error) {
    console.error('❌ 使用 custom_dynamic_extension 扩展块时出错:', error);
  }
}

/**
 * 使用标准方式添加动态输入
 */
async function addDynamicInputsStandard(block: any, inputNames: string[]): Promise<void> {
  console.log('🔧 使用标准方式添加动态输入');
  
  for (const inputName of inputNames) {
    const existingInput = block.getInput(inputName);
    if (!existingInput) {
      console.log(`➕ 尝试添加输入: ${inputName}`);
      
      try {
        // 尝试添加值输入
        block.appendValueInput(inputName);
        console.log(`✅ 成功添加值输入: ${inputName}`);
      } catch (error) {
        console.warn(`⚠️ 无法添加输入 ${inputName}:`, error);
      }
    } else {
      console.log(`ℹ️ 输入 ${inputName} 已存在`);
    }
  }
}

/**
 * 解析板卡配置变量
 */
async function resolveBoardConfigVariable(value: any): Promise<any> {
  if (typeof value !== 'string' || !value.startsWith('${') || !value.endsWith('}')) {
    return value;
  }

  try {
    // 提取变量路径，如 ${board.serialPort}
    const varPath = value.slice(2, -1);
    const [configType, configKey] = varPath.split('.');
    
    if (configType === 'board') {
      // 获取板卡配置
      const boardConfig = await getBoardConfig();
      if (boardConfig && boardConfig[configKey]) {
        // 如果是数组（下拉选项），返回第一个选项的值
        if (Array.isArray(boardConfig[configKey]) && boardConfig[configKey].length > 0) {
          return boardConfig[configKey][0][1] || boardConfig[configKey][0][0];
        }
        return boardConfig[configKey];
      }
    }
    
    return value; // 无法解析时返回原值
  } catch (error) {
    console.error('解析板卡配置变量时出错:', error);
    return value;
  }
}

/**
 * 获取板卡配置
 */
async function getBoardConfig(): Promise<any> {
  try {
    const blocklyService = getBlocklyService();
    if (blocklyService?.boardConfig) {
      return blocklyService.boardConfig;
    }
    
    // 尝试从其他地方获取板卡配置
    // 这里可以根据实际项目结构调整
    return null;
  } catch (error) {
    console.error('获取板卡配置时出错:', error);
    return null;
  }
}

/**
 * 从变量字段创建变量定义
 */
async function createVariablesFromFields(workspace: any, fields: FieldConfig): Promise<string[]> {
  const createdVariables: string[] = [];

  try {
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      // 检查是否是变量字段且需要创建变量定义
      if (typeof fieldValue === 'object' && fieldValue.id) {
        const variableName = fieldValue.name || `var_${Date.now()}`;
        
        // 创建变量定义块
        const varDefBlock = await createBlockSafely(workspace, 'variable_define', { x: 50, y: 50 }, false);
        if (varDefBlock) {
          const varField = varDefBlock.getField('VAR');
          if (varField) {
            varField.setValue(variableName);
            createdVariables.push(variableName);
          }
        }
      }
    }
  } catch (error) {
    console.error('创建变量时出错:', error);
  }

  return createdVariables;
}

/**
 * 智能插入块到指定位置，支持自动后移已连接的块
 */
async function smartInsertBlock(
  workspace: any,
  newBlock: any,
  parentBlock: any,
  connectionType: 'next' | 'input' | 'statement',
  inputName?: string
): Promise<{ smartInsertion: boolean; autoMovedBlock: string | null }> {
  console.log(`🎯 smartInsertBlock 开始执行: ${connectionType}`);
  console.log(`📊 新块: ${newBlock.type} (ID: ${newBlock.id})`);
  console.log(`📊 父块: ${parentBlock.type} (ID: ${parentBlock.id})`);
  
  switch (connectionType) {
    case 'next':
      // 对于next连接，使用已有的智能插入逻辑
      return await performBlockConnection(parentBlock, newBlock, 'next');
      
    case 'input':
      // 对于input连接，实现智能插入逻辑
      if (!inputName) {
        throw new Error('input连接需要指定inputName参数');
      }
      
      const inputConnection = parentBlock.getInput(inputName);
      if (!inputConnection || !inputConnection.connection) {
        throw new Error(`父块 ${parentBlock.type} 没有名为 "${inputName}" 的输入`);
      }
      
      // 检查是否已有连接的块
      const existingConnectedBlock = inputConnection.connection.targetBlock();
      if (existingConnectedBlock) {
        console.log(`🔄 检测到输入 "${inputName}" 已有连接块: ${existingConnectedBlock.type}(${existingConnectedBlock.id})`);
        console.log('📋 智能插入模式：暂时断开现有连接');
        
        // 断开现有连接
        inputConnection.connection.disconnect();
        
        // 连接新块
        if (newBlock.outputConnection) {
          inputConnection.connection.connect(newBlock.outputConnection);
          console.log('✅ 新块已连接到输入');
          
          // 如果新块有输入，尝试将原有块连接到新块的输入
          if (newBlock.inputList && newBlock.inputList.length > 0) {
            for (const newBlockInput of newBlock.inputList) {
              if (newBlockInput.connection && !newBlockInput.connection.targetBlock()) {
                console.log(`🔗 尝试将原有块连接到新块的输入 "${newBlockInput.name}"`);
                try {
                  newBlockInput.connection.connect(existingConnectedBlock.outputConnection);
                  console.log('✅ 原有块已重新连接到新块');
                  return { smartInsertion: true, autoMovedBlock: existingConnectedBlock.type };
                } catch (error) {
                  console.warn('⚠️ 无法重新连接原有块:', error);
                }
                break;
              }
            }
          }
          
          console.log('⚠️ 无法重新连接原有块，原有块将保持断开状态');
          return { smartInsertion: true, autoMovedBlock: null };
        } else {
          throw new Error('新块没有输出连接，无法连接到输入');
        }
      } else {
        // 没有现有连接，直接连接
        if (newBlock.outputConnection) {
          inputConnection.connection.connect(newBlock.outputConnection);
          console.log('✅ 新块已直接连接到输入');
          return { smartInsertion: false, autoMovedBlock: null };
        } else {
          throw new Error('新块没有输出连接，无法连接到输入');
        }
      }
      
    case 'statement':
      // 对于statement连接，暂时使用基本逻辑
      console.log('📝 statement连接暂时使用基本逻辑');
      console.log(`📍 查找输入名称: ${inputName}`);
      
      // 首先尝试使用指定的输入名称
      let statementInput = null;
      if (inputName) {
        statementInput = parentBlock.getInput(inputName);
        console.log(`🔍 尝试获取指定输入 "${inputName}": ${statementInput ? '✅ 找到' : '❌ 未找到'}`);
      }
      
      // 如果指定的输入名称没找到，尝试常见的statement输入名称
      if (!statementInput) {
        const commonNames = ['DO', 'ARDUINO_LOOP', 'ARDUINO_SETUP', 'STACK', 'NAME', 'DO0', 'ELSE'];
        for (const name of commonNames) {
          statementInput = parentBlock.getInput(name);
          if (statementInput) {
            console.log(`🔍 找到常见输入名称 "${name}"`);
            break;
          }
        }
      }
      
      // 如果还是没找到，尝试查找第一个statement类型的输入
      if (!statementInput) {
        const statementInputs = parentBlock.inputList?.filter((input: any) => 
          input.type === window['Blockly']?.INPUT_STATEMENT
        );
        
        if (statementInputs && statementInputs.length > 0) {
          statementInput = statementInputs[0];
          console.log(`🔍 使用第一个statement输入: ${statementInput.name}`);
        }
      }
      
      if (statementInput && statementInput.connection) {
        console.log(`✅ 找到有效的statement输入: ${statementInput.name}`);
        
        // 禁用事件系统避免连接时的移动事件错误
        const wasRecordingUndo = window['Blockly'].Events.getRecordUndo();
        const currentGroup = window['Blockly'].Events.getGroup();
        window['Blockly'].Events.disable();
        
        try {
          // 检查是否已有连接的语句块
          const existingStatementBlock = statementInput.connection.targetBlock();
          if (existingStatementBlock) {
            console.log(`🔄 检测到语句输入已有块: ${existingStatementBlock.type}(${existingStatementBlock.id})`);
            
            // 找到语句链的末尾
            let lastBlock = existingStatementBlock;
            while (lastBlock.getNextBlock && lastBlock.getNextBlock()) {
              lastBlock = lastBlock.getNextBlock();
            }
            
            // 将新块连接到末尾
            if (lastBlock.nextConnection && newBlock.previousConnection) {
              lastBlock.nextConnection.connect(newBlock.previousConnection);
              console.log('✅ 新块已连接到语句链末尾');
              return { smartInsertion: true, autoMovedBlock: existingStatementBlock.type };
            }
          } else {
            // 直接连接
            if (newBlock.previousConnection) {
              statementInput.connection.connect(newBlock.previousConnection);
              console.log('✅ 新块已直接连接到语句输入');
              return { smartInsertion: false, autoMovedBlock: null };
            }
          }
        } catch (connectError) {
          console.warn(`⚠️ statement连接时出错: ${connectError}, 但连接尝试继续`);
          throw connectError;
        } finally {
          // 恢复事件系统
          window['Blockly'].Events.enable();
          if (currentGroup) {
            window['Blockly'].Events.setGroup(currentGroup);
          } else {
            window['Blockly'].Events.setGroup(false);
          }
          window['Blockly'].Events.setRecordUndo(wasRecordingUndo);
        }
      }
      
      // 如果到这里还没有成功，输出调试信息
      console.error(`❌ 无法找到有效的statement输入`);
      console.error(`📊 父块类型: ${parentBlock.type}`);
      console.error(`📊 父块ID: ${parentBlock.id}`);
      console.error(`📊 请求的输入名称: ${inputName}`);
      console.error(`📊 父块的所有输入:`, parentBlock.inputList?.map((input: any) => ({
        name: input.name,
        type: input.type,
        hasConnection: !!input.connection
      })));
      
      throw new Error(`无法执行statement连接到块 ${parentBlock.type}`);
      
    default:
      throw new Error(`不支持的连接类型: ${connectionType}`);
  }
}

/**
 * 连接块到父级块
 */
async function connectToParentBlock(
  workspace: any, 
  childBlock: any, 
  parentConnection: ConnectionConfig
): Promise<{ smartInsertion: boolean; autoMovedBlock: string | null }> {
  console.log('🔗 connectToParentBlock 开始执行（智能插入版）');
  console.log('📦 父级连接配置:', JSON.stringify(parentConnection));
  
  try {
    // 查找父级块
    const parentBlock = getBlockByIdSmart(workspace, parentConnection.blockId);
    if (!parentBlock) {
      throw new Error(`未找到父级块 ID: ${parentConnection.blockId}（已尝试模糊匹配）`);
    }
    
    console.log(`📊 父级块: ${parentBlock.type} (ID: ${parentBlock.id})`);
    console.log(`📊 子级块: ${childBlock.type} (ID: ${childBlock.id})`);
    
    // 添加详细的父级块输入调试信息
    if (parentBlock.inputList) {
      console.log('🔍 父级块的所有输入:');
      parentBlock.inputList.forEach((input: any, index: number) => {
        console.log(`  ${index}: 名称="${input.name}", 类型=${input.type}, 有连接=${!!input.connection}`);
      });
    }
    
    // 使用智能插入功能
    const result = await smartInsertBlock(
      workspace,
      childBlock,
      parentBlock,
      parentConnection.connectionType as 'next' | 'input' | 'statement',
      parentConnection.inputName
    );
    
    if (result.smartInsertion) {
      console.log(`🎉 智能插入完成，自动处理了已连接的块: ${result.autoMovedBlock || '无'}`);
    } else {
      console.log('✅ 标准连接完成');
    }
    
    return result;
    
  } catch (error) {
    console.error('❌ 父级连接失败:', error);
    throw error;
  }
}

/**
 * 检查连接兼容性
 */
function checkConnectionCompatibility(connection1: any, connection2: any): boolean {
  try {
    // 方法1: 尝试使用新版本的 API
    if (connection1.checkConnection && typeof connection1.checkConnection === 'function') {
      return connection1.checkConnection(connection2);
    }
    
    // 方法2: 尝试使用旧版本的 checkType_ 方法
    if (connection1.checkType_ && typeof connection1.checkType_ === 'function') {
      return connection1.checkType_(connection2);
    }
    
    // 方法3: 检查连接类型
    if (connection1.type !== undefined && connection2.type !== undefined) {
      // 对于语句连接：next 应该连接到 previous
      if (connection1.type === window['Blockly']?.NEXT_STATEMENT && 
          connection2.type === window['Blockly']?.PREVIOUS_STATEMENT) {
        return true;
      }
      
      // 对于值连接：output 应该连接到 input
      if (connection1.type === window['Blockly']?.OUTPUT_VALUE && 
          connection2.type === window['Blockly']?.INPUT_VALUE) {
        return true;
      }
      
      // 反向检查
      if (connection2.type === window['Blockly']?.NEXT_STATEMENT && 
          connection1.type === window['Blockly']?.PREVIOUS_STATEMENT) {
        return true;
      }
      
      if (connection2.type === window['Blockly']?.OUTPUT_VALUE && 
          connection1.type === window['Blockly']?.INPUT_VALUE) {
        return true;
      }
    }
    
    // 方法4: 基本兼容性检查 - 如果其他方法都失败，尝试简单连接
    console.log('⚠️ 使用基本兼容性检查');
    return true; // 最后的回退方案
    
  } catch (error) {
    console.warn('检查连接兼容性时出错，假设兼容:', error);
    return true; // 容错处理
  }
}

/**
 * 执行块连接操作
 */
async function performBlockConnection(
  sourceBlock: any, 
  targetBlock: any, 
  connectionType: string, 
  inputName?: string
): Promise<{ smartInsertion: boolean; autoMovedBlock: string | null }> {
  console.log(`🔗 performBlockConnection 开始执行连接: ${connectionType}`);
  console.log(`📊 源块: ${sourceBlock.type} (ID: ${sourceBlock.id})`);
  console.log(`📊 目标块: ${targetBlock.type} (ID: ${targetBlock.id})`);
  
  // 🎯 智能块类型检测和连接处理
  
  // 动态检测容器块：任何有 input_statement 的块都是容器块
  const detectContainerBlock = (block: any): string | null => {
    if (!block.inputList) return null;
    
    console.log(`🔍 detectContainerBlock - 检查 ${block.type}:`);
    console.log(`   inputList 长度: ${block.inputList?.length || 0}`);
    
    if (block.inputList) {
      block.inputList.forEach((input: any, index: number) => {
        console.log(`   [${index}] "${input.name}" (类型: ${input.type})`);
      });
    }
    
    // 方法1: 尝试使用 Blockly 常量
    let INPUT_STATEMENT_CONSTANT = window['Blockly']?.INPUT_STATEMENT;
    if (INPUT_STATEMENT_CONSTANT !== undefined) {
      const statementInput = block.inputList.find((input: any) => 
        input.type === INPUT_STATEMENT_CONSTANT
      );
      if (statementInput) {
        console.log(`   ✅ 方法1成功: 找到语句输入 "${statementInput.name}"`);
        return statementInput.name;
      }
    }
    
    // 方法2: 回退检测 - 检查常见的连接类型值
    console.log(`   ⚠️ 方法1失败，尝试回退检测...`);
    for (const input of block.inputList) {
      if (input.connection) {
        const connectionType = input.connection.type;
        console.log(`   🔍 检查输入 "${input.name}": 连接类型 ${connectionType}`);
        
        // 语句连接通常是类型 1 或 3
        if (connectionType === 1 || connectionType === 3) {
          console.log(`   ✅ 回退方法成功: 找到语句输入 "${input.name}"`);
          return input.name;
        }
      }
    }
    
    console.log(`   🎯 检测结果: 未找到语句输入`);
    return null;
  };

  // 动态检测值输入块：有 input_value 的块
  const detectValueInputs = (block: any): string[] => {
    if (!block.inputList) return [];
    
    return block.inputList
      .filter((input: any) => input.type === window['Blockly']?.INPUT_VALUE)
      .map((input: any) => input.name);
  };

  // 已知的特殊语句块配置（这些仍需要手动配置，因为可能有多个语句输入）
  const specialStatementBlocks: { [key: string]: string[] } = {
    'controls_if': ['IF0', 'DO0', 'ELSE'],
    'controls_for': ['DO'],
    'controls_while': ['DO'], 
    'controls_repeat': ['DO']
  };
  
  // 智能连接类型检测和转换
  if (connectionType === 'next') {
    // next 连接保持纯粹：不做任何智能转换，直接进行顺序连接
    console.log(`� 执行纯粹的 next 连接：${sourceBlock.type} → ${targetBlock.type}`);
    // 不做任何转换，让后续的 next 连接逻辑处理
  }
  
  try {
    switch (connectionType) {
      case 'next':
        // 顺序连接：sourceBlock -> targetBlock
        console.log('🔍 检查连接点可用性...');
        console.log(`📊 源块连接点:`, {
          nextConnection: !!sourceBlock.nextConnection,
          nextConnectionType: sourceBlock.nextConnection?.type
        });
        console.log(`📊 目标块连接点:`, {
          previousConnection: !!targetBlock.previousConnection,
          previousConnectionType: targetBlock.previousConnection?.type
        });
        
        // 更灵活的连接点检查
        const hasSourceNext = sourceBlock.nextConnection || 
                             (sourceBlock.outputConnection && sourceBlock.type.includes('setup')) ||
                             sourceBlock.type.includes('statement') ||
                             sourceBlock.type.includes('setup') ||
                             sourceBlock.type.includes('loop');
                             
        const hasTargetPrevious = targetBlock.previousConnection ||
                                 (targetBlock.outputConnection && targetBlock.type.includes('init')) ||
                                 targetBlock.type.includes('statement') ||
                                 targetBlock.type.includes('init') ||
                                 targetBlock.type.includes('wifi');
        
        if (hasSourceNext && hasTargetPrevious) {
          console.log('✅ 连接点检查通过，尝试连接...');
          
          try {
            // 尝试直接连接，如果连接点存在的话
            if (sourceBlock.nextConnection && targetBlock.previousConnection) {
              // 检查连接类型是否兼容
              const isCompatible = checkConnectionCompatibility(sourceBlock.nextConnection, targetBlock.previousConnection);
              if (isCompatible) {
                // 🎯 智能插入逻辑：如果源块已经有下一个块，将其后移到目标块后面
                let existingNextBlock = null;
                if (sourceBlock.getNextBlock && sourceBlock.getNextBlock()) {
                  existingNextBlock = sourceBlock.getNextBlock();
                  console.log(`🔄 检测到源块已有下一个块: ${existingNextBlock.type}(${existingNextBlock.id})`);
                  console.log('📋 智能插入模式：将现有块后移到新插入块的后面');
                  
                  // 先断开现有连接
                  sourceBlock.nextConnection.disconnect();
                  console.log('✅ 已断开源块的现有连接');
                }
                
                // 如果目标块已经有前一个块，先断开
                if (targetBlock.getPreviousBlock && targetBlock.getPreviousBlock()) {
                  console.log('⚠️ 目标块已有前一个块，先断开连接');
                  targetBlock.previousConnection.disconnect();
                }
                
                console.log('🔗 执行 next 连接：源块 → 目标块...');
                sourceBlock.nextConnection.connect(targetBlock.previousConnection);
                console.log('✅ 主连接完成');
                
                // 🎯 自动后移：将之前的下一个块连接到新插入的目标块后面
                if (existingNextBlock && targetBlock.nextConnection && existingNextBlock.previousConnection) {
                  console.log(`🔗 自动后移：将 ${existingNextBlock.type} 连接到 ${targetBlock.type} 后面...`);
                  try {
                    // 如果目标块已经有下一个块，需要先断开
                    if (targetBlock.getNextBlock && targetBlock.getNextBlock()) {
                      console.log('⚠️ 目标块已有下一个块，先断开');
                      targetBlock.nextConnection.disconnect();
                    }
                    
                    // 连接现有块到目标块后面
                    targetBlock.nextConnection.connect(existingNextBlock.previousConnection);
                    console.log('✅ 自动后移连接成功');
                    
                    // 更新结果描述
                    console.log(`🎉 智能插入完成：${sourceBlock.type} → ${targetBlock.type} → ${existingNextBlock.type}`);
                  } catch (autoMoveError) {
                    console.warn('⚠️ 自动后移失败，但主连接仍然成功:', autoMoveError);
                  }
                } else if (existingNextBlock) {
                  console.log('⚠️ 无法自动后移：连接点不兼容或不存在');
                  console.log(`   目标块nextConnection: ${!!targetBlock.nextConnection}`);
                  console.log(`   现有块previousConnection: ${!!existingNextBlock.previousConnection}`);
                }
                
                console.log('✅ next 连接流程完成');
                
                // 返回智能插入结果
                return {
                  smartInsertion: !!existingNextBlock,
                  autoMovedBlock: existingNextBlock ? existingNextBlock.type : null
                };
              } else {
                console.log('⚠️ 连接类型不兼容，但仍尝试强制连接...');
                sourceBlock.nextConnection.connect(targetBlock.previousConnection);
                console.log('✅ 强制连接成功');
                return { smartInsertion: false, autoMovedBlock: null };
              }
            } else {
              // 如果标准连接点不存在，尝试其他方法
              console.log('⚠️ 标准连接点不存在，尝试替代连接方法...');
              
              // 方法1: 尝试通过 Blockly API 强制连接
              if (sourceBlock.setNext && targetBlock.setPrevious) {
                sourceBlock.setNext(targetBlock);
                console.log('✅ 通过 setNext 连接成功');
              } 
              // 方法2: 尝试通过工作区移动来建立连接
              else if (targetBlock.moveBy) {
                const sourcePos = sourceBlock.getRelativeToSurfaceXY ? sourceBlock.getRelativeToSurfaceXY() : { x: 0, y: 0 };
                
                // 使用事件保护进行移动
                const moveEventGroup = generateUniqueId('connect_move');
                window['Blockly'].Events.setGroup(moveEventGroup);
                
                try {
                  targetBlock.moveBy(sourcePos.x, sourcePos.y + 50);
                  console.log('✅ 通过位置移动建立连接');
                } catch (moveError) {
                  console.warn(`⚠️ 连接移动时出错: ${moveError}`);
                } finally {
                  window['Blockly'].Events.setGroup(false);
                }
              }
              // 方法3: 最后的回退方案
              else {
                console.log('✅ 使用基本连接方案，假设连接成功');
              }
              return { smartInsertion: false, autoMovedBlock: null };
            }
          } catch (connectionError) {
            console.warn('⚠️ 连接过程中出现错误，但继续执行:', connectionError);
            // 不抛出错误，允许连接继续
            return { smartInsertion: false, autoMovedBlock: null };
          }
        } else {
          // 提供更详细的错误信息，但不阻止连接
          console.warn(`⚠️ 连接点检查失败，但仍尝试连接:`);
          console.warn(`  - 源块 ${sourceBlock.type}: nextConnection=${!!sourceBlock.nextConnection}, hasSourceNext=${hasSourceNext}`);
          console.warn(`  - 目标块 ${targetBlock.type}: previousConnection=${!!targetBlock.previousConnection}, hasTargetPrevious=${hasTargetPrevious}`);
          
          // 尝试强制连接而不是抛出错误
          try {
            if (sourceBlock.nextConnection && targetBlock.previousConnection) {
              sourceBlock.nextConnection.connect(targetBlock.previousConnection);
              console.log('✅ 强制连接成功');
            } else {
              console.log('ℹ️ 跳过连接，因为连接点真的不存在');
              // 但不抛出错误，让操作继续
            }
          } catch (forceError) {
            console.warn('⚠️ 强制连接也失败了:', forceError);
            // 仍然不抛出错误
          }
          return { smartInsertion: false, autoMovedBlock: null };
        }
        break;
        
      case 'input':
        // 输入连接：targetBlock 作为 sourceBlock 的输入
        if (!inputName) {
          throw new Error('输入连接需要指定 inputName 参数');
        }
        
        console.log(`🔍 查找输入连接点: ${inputName}`);
        const inputConnection = sourceBlock.getInput(inputName);
        if (!inputConnection || !inputConnection.connection) {
          console.error(`❌ 源块 ${sourceBlock.type} 没有名为 "${inputName}" 的输入`);
          
          // 调试：列出所有可用的输入
          if (sourceBlock.inputList) {
            console.log('📋 可用的输入列表:');
            sourceBlock.inputList.forEach((input: any, index: number) => {
              console.log(`  ${index}: ${input.name} (类型: ${input.type})`);
            });
          }
          
          throw new Error(`源块 ${sourceBlock.type} 没有名为 "${inputName}" 的输入`);
        }
        
        console.log(`📊 输入连接信息:`, {
          inputName,
          inputType: inputConnection.type,
          hasConnection: !!inputConnection.connection,
          connectionType: inputConnection.connection?.type
        });
        
        console.log(`📊 目标块连接信息:`, {
          type: targetBlock.type,
          hasOutputConnection: !!targetBlock.outputConnection,
          hasPreviousConnection: !!targetBlock.previousConnection,
          outputType: targetBlock.outputConnection?.type,
          previousType: targetBlock.previousConnection?.type
        });
        
        if (targetBlock.outputConnection) {
          // 值连接（value connection）
          console.log('🔗 尝试值连接...');
          const isCompatible = checkConnectionCompatibility(inputConnection.connection, targetBlock.outputConnection);
          if (isCompatible) {
            // 如果输入已经连接了其他块，先断开
            if (inputConnection.connection.targetBlock()) {
              console.log(`⚠️ 输入 "${inputName}" 已连接其他块，先断开`);
              inputConnection.connection.disconnect();
            }
            
            console.log(`🔗 执行值连接到 "${inputName}"...`);
            inputConnection.connection.connect(targetBlock.outputConnection);
            console.log('✅ 值连接成功');
          } else {
            console.warn(`⚠️ 值连接兼容性检查失败，尝试强制连接...`);
            try {
              if (inputConnection.connection.targetBlock()) {
                inputConnection.connection.disconnect();
              }
              inputConnection.connection.connect(targetBlock.outputConnection);
              console.log('✅ 强制值连接成功');
            } catch (error) {
              throw new Error(`块类型不兼容：无法将 ${targetBlock.type} 连接到 ${sourceBlock.type} 的输入 "${inputName}"`);
            }
          }
        } else if (targetBlock.previousConnection) {
          // 语句连接（statement connection）- 这是容器块的主要连接方式
          console.log('🔗 尝试语句连接（容器块模式）...');
          const isCompatible = checkConnectionCompatibility(inputConnection.connection, targetBlock.previousConnection);
          if (isCompatible) {
            // 如果输入已经连接了其他块，需要特殊处理
            const existingBlock = inputConnection.connection.targetBlock();
            if (existingBlock) {
              console.log(`📋 输入 "${inputName}" 已有块连接，将新块连接到链末尾`);
              
              // 找到语句链的末尾
              let lastBlock = existingBlock;
              while (lastBlock.getNextBlock && lastBlock.getNextBlock()) {
                lastBlock = lastBlock.getNextBlock();
              }
              
              // 将新块连接到链末尾
              if (lastBlock.nextConnection) {
                lastBlock.nextConnection.connect(targetBlock.previousConnection);
                console.log('✅ 新块已连接到语句链末尾');
              } else {
                console.log('⚠️ 无法连接到链末尾，替换第一个块');
                inputConnection.connection.disconnect();
                inputConnection.connection.connect(targetBlock.previousConnection);
                console.log('✅ 语句连接成功（替换模式）');
              }
            } else {
              console.log(`🔗 执行语句连接到 "${inputName}"...`);
              inputConnection.connection.connect(targetBlock.previousConnection);
              console.log('✅ 语句连接成功');
            }
          } else {
            console.warn(`⚠️ 语句连接兼容性检查失败，尝试强制连接...`);
            try {
              // 对于语句输入，通常兼容性检查可以宽松一些
              console.log(`🔗 强制执行语句连接到 "${inputName}"...`);
              
              const existingBlock = inputConnection.connection.targetBlock();
              if (existingBlock) {
                // 如果已有块，连接到末尾
                let lastBlock = existingBlock;
                while (lastBlock.getNextBlock && lastBlock.getNextBlock()) {
                  lastBlock = lastBlock.getNextBlock();
                }
                if (lastBlock.nextConnection && targetBlock.previousConnection) {
                  lastBlock.nextConnection.connect(targetBlock.previousConnection);
                } else {
                  inputConnection.connection.disconnect();
                  inputConnection.connection.connect(targetBlock.previousConnection);
                }
              } else {
                inputConnection.connection.connect(targetBlock.previousConnection);
              }
              
              console.log('✅ 强制语句连接成功');
            } catch (error) {
              throw new Error(`块类型不兼容：无法将 ${targetBlock.type} 连接到 ${sourceBlock.type} 的输入 "${inputName}"`);
            }
          }
        } else {
          throw new Error(`目标块 ${targetBlock.type} 没有可用的连接点（需要 outputConnection 或 previousConnection）`);
        }
        return { smartInsertion: false, autoMovedBlock: null };
        break;
        
      case 'statement':
        // 语句连接：专门用于向容器块或事件处理块添加语句
        console.log(`🎯 执行语句连接模式`);
        
        // 自动检测正确的输入名称
        let statementInputName = inputName;
        if (!statementInputName) {
          // 使用动态检测方法自动选择输入名称
          statementInputName = detectContainerBlock(sourceBlock);
          
          if (!statementInputName) {
            // 尝试常见的语句输入名称（包含原 stack 连接的输入名称）
            const commonStatementInputs = ['NAME', 'DO', 'DO0', 'THEN', 'BODY', 'STACK', 'ELSE'];
            for (const inputName of commonStatementInputs) {
              const input = sourceBlock.getInput(inputName);
              if (input && input.connection) {
                statementInputName = inputName;
                break;
              }
            }
          }
        }
        
        if (!statementInputName) {
          throw new Error(`无法为 ${sourceBlock.type} 确定语句输入名称`);
        }
        
        console.log(`📝 使用语句输入: ${statementInputName}`);
        const statementInput = sourceBlock.getInput(statementInputName);
        
        if (!statementInput || !statementInput.connection) {
          throw new Error(`源块 ${sourceBlock.type} 没有名为 "${statementInputName}" 的语句输入`);
        }
        
        if (!targetBlock.previousConnection) {
          throw new Error(`目标块 ${targetBlock.type} 没有可连接的 previousConnection`);
        }
        
        // 执行语句连接
        const existingBlock = statementInput.connection.targetBlock();
        if (existingBlock) {
          console.log(`📋 语句输入 "${statementInputName}" 已有块连接，将新块连接到链末尾`);
          
          // 找到语句链的末尾
          let lastBlock = existingBlock;
          while (lastBlock.getNextBlock && lastBlock.getNextBlock()) {
            lastBlock = lastBlock.getNextBlock();
          }
          
          // 将新块连接到链末尾
          if (lastBlock.nextConnection) {
            lastBlock.nextConnection.connect(targetBlock.previousConnection);
            console.log('✅ 新块已连接到语句链末尾');
          } else {
            console.log('⚠️ 无法连接到链末尾，替换第一个块');
            statementInput.connection.disconnect();
            statementInput.connection.connect(targetBlock.previousConnection);
            console.log('✅ 语句连接成功（替换模式）');
          }
        } else {
          console.log(`🔗 执行语句连接到 "${statementInputName}"...`);
          statementInput.connection.connect(targetBlock.previousConnection);
          console.log('✅ 语句连接成功');
        }
        return { smartInsertion: false, autoMovedBlock: null };
        break;
        
      default:
        throw new Error(`不支持的连接类型: ${connectionType}`);
    }
    
    console.log('🎉 块连接操作完成');
    return { smartInsertion: false, autoMovedBlock: null };
    
  } catch (error) {
    console.error('❌ 块连接失败:', error);
    throw error;
  }
}

/**
 * 获取或创建块
 */
async function getOrCreateBlock(workspace: any, blockRef: string | BlockConfig): Promise<any> {
  console.log('🔍 getOrCreateBlock 开始执行');
  console.log('📦 块引用:', JSON.stringify(blockRef, null, 2));
  
  if (typeof blockRef === 'string') {
    // 解析块ID，支持新旧格式
    const blockId = parseBlockId(blockRef);
    console.log(`🔎 查找现有块 ID: "${blockId}" (原始: "${blockRef}")`);
    
    // 查找现有块（使用智能匹配）
    const block = getBlockByIdSmart(workspace, blockId);
    
    if (block) {
      console.log(`✅ 找到块: ${block.type} (ID: ${block.id})`);
      return block;
    } else {
      console.error(`❌ 未找到块 ID: "${blockId}"（已尝试模糊匹配）`);
      
      // 列出所有可用的块ID进行调试
      const allBlocks = workspace.getAllBlocks();
      console.log(`📊 工作区中总共有 ${allBlocks.length} 个块`);
      
      if (allBlocks.length > 0) {
        const availableIds = allBlocks.map((b: any) => `${b.type}[ID:${JSON.stringify(b.id)}]`).slice(0, 10); // 只显示前10个
        console.log('🎯 可用的块列表（前10个）:', availableIds.join(', '));
        
        // 检查是否有相似的 ID
        const similarIds = allBlocks
          .map((b: any) => b.id)
          .filter((id: string) => id.includes(blockId.substring(0, 5)) || blockId.includes(id.substring(0, 5)));
        
        if (similarIds.length > 0) {
          console.log('🔍 发现相似的块 ID:', similarIds.join(', '));
        }
      } else {
        console.log('⚠️ 工作区中没有任何块');
      }
      
      return null;
    }
  } else {
    console.log('🏗️ 创建新块...');
    // 创建新块
    const newBlock = await createBlockFromConfig(workspace, blockRef);
    if (newBlock) {
      console.log(`✅ 新块创建成功: ${newBlock.type} (ID: ${newBlock.id})`);
    } else {
      console.error('❌ 新块创建失败');
    }
    return newBlock;
  }
}

/**
 * 连接两个块
 */
async function connectBlocks(sourceBlock: any, targetBlock: any, connectionType: string, inputName?: string): Promise<void> {
  try {
    switch (connectionType) {
      case 'next':
        if (sourceBlock.nextConnection && targetBlock.previousConnection) {
          sourceBlock.nextConnection.connect(targetBlock.previousConnection);
        }
        break;
      
      case 'input':
        if (inputName && sourceBlock.getInput(inputName)) {
          const input = sourceBlock.getInput(inputName);
          if (input.connection && (targetBlock.outputConnection || targetBlock.previousConnection)) {
            const connection = targetBlock.outputConnection || targetBlock.previousConnection;
            input.connection.connect(connection);
          }
        }
        break;
      
      case 'statement':
        // 语句连接：智能检测语句输入
        let statementInputName = inputName;
        if (!statementInputName) {
          // 尝试常见的语句输入名称
          const commonInputs = ['STACK', 'DO', 'DO0', 'BODY', 'THEN', 'ELSE', 'NAME'];
          for (const name of commonInputs) {
            if (sourceBlock.getInput(name)) {
              statementInputName = name;
              break;
            }
          }
        }
        
        if (statementInputName && sourceBlock.getInput(statementInputName)) {
          const input = sourceBlock.getInput(statementInputName);
          if (input.connection && targetBlock.previousConnection) {
            input.connection.connect(targetBlock.previousConnection);
          }
        }
        break;
    }
  } catch (error) {
    console.error('连接块时出错:', error);
    throw error;
  }
}

/**
 * 创建序列结构
 */
async function createSequenceStructure(workspace: any, blocks: BlockConfig[], createdBlocks: string[]): Promise<any> {
  let previousBlock = null;
  let rootBlock = null;

  for (const blockConfig of blocks) {
    const block = await createBlockFromConfig(workspace, blockConfig);
    if (block) {
      createdBlocks.push(block.id);
      
      if (!rootBlock) {
        rootBlock = block;
      }
      
      if (previousBlock && previousBlock.nextConnection && block.previousConnection) {
        previousBlock.nextConnection.connect(block.previousConnection);
      }
      
      previousBlock = block;
    }
  }

  return rootBlock;
}

/**
 * 创建条件结构
 */
async function createConditionStructure(workspace: any, blocks: BlockConfig[], createdBlocks: string[]): Promise<any> {
  // 创建 if 块作为容器
  const ifBlock = await createBlockSafely(workspace, 'controls_if', { x: 100, y: 100 }, false);
  if (!ifBlock) {
    throw new Error('无法创建条件块');
  }
  
  createdBlocks.push(ifBlock.id);

  // 连接条件和语句
  if (blocks.length >= 1) {
    // 条件块
    const conditionBlock = await createBlockFromConfig(workspace, blocks[0]);
    if (conditionBlock) {
      createdBlocks.push(conditionBlock.id);
      const ifInput = ifBlock.getInput('IF0');
      if (ifInput && ifInput.connection && conditionBlock.outputConnection) {
        ifInput.connection.connect(conditionBlock.outputConnection);
      }
    }
  }

  if (blocks.length >= 2) {
    // 执行语句
    const doBlock = await createBlockFromConfig(workspace, blocks[1]);
    if (doBlock) {
      createdBlocks.push(doBlock.id);
      const doInput = ifBlock.getInput('DO0');
      if (doInput && doInput.connection && doBlock.previousConnection) {
        doInput.connection.connect(doBlock.previousConnection);
      }
    }
  }

  return ifBlock;
}

/**
 * 创建高级条件结构（支持复杂条件和else分支）
 */
async function createAdvancedConditionStructure(
  workspace: any, 
  config: { condition?: BlockConfig, ifBranch?: BlockConfig | BlockConfig[], elseBranch?: BlockConfig | BlockConfig[] }, 
  createdBlocks: string[]
): Promise<any> {
  console.log('🏗️ 开始创建高级条件结构');
  console.log('📦 条件配置:', JSON.stringify(config, null, 2));

  // 创建基础的 if 块
  const ifBlock = await createBlockSafely(workspace, 'controls_if', { x: 100, y: 100 }, false);
  if (!ifBlock) {
    throw new Error('无法创建条件块');
  }
  
  createdBlocks.push(ifBlock.id);
  console.log(`✅ 创建了 if 块: ${ifBlock.id}`);

  // 如果有else分支，需要添加else部分
  if (config.elseBranch) {
    // 设置 if 块包含 else
    ifBlock.setFieldValue('1', 'ELSE');
    console.log('✅ 启用了 else 分支');
  }

  // 1. 连接条件表达式
  if (config.condition) {
    console.log('🔗 开始连接条件表达式');
    const conditionBlock = await createBlockFromConfig(workspace, config.condition);
    if (conditionBlock) {
      createdBlocks.push(conditionBlock.id);
      const ifInput = ifBlock.getInput('IF0');
      if (ifInput && ifInput.connection && conditionBlock.outputConnection) {
        ifInput.connection.connect(conditionBlock.outputConnection);
        console.log(`✅ 条件表达式已连接: ${conditionBlock.id}`);
      } else {
        console.warn('❌ 无法连接条件表达式，连接点不匹配');
      }
    }
  }

  // 2. 连接if分支
  if (config.ifBranch) {
    console.log('🔗 开始连接 if 分支');
    const ifBranches = Array.isArray(config.ifBranch) ? config.ifBranch : [config.ifBranch];
    let lastBlock = null;
    
    for (let i = 0; i < ifBranches.length; i++) {
      const branchBlock = await createBlockFromConfig(workspace, ifBranches[i]);
      if (branchBlock) {
        createdBlocks.push(branchBlock.id);
        
        if (i === 0) {
          // 第一个块连接到 DO0 输入
          const doInput = ifBlock.getInput('DO0');
          if (doInput && doInput.connection && branchBlock.previousConnection) {
            doInput.connection.connect(branchBlock.previousConnection);
            console.log(`✅ if分支第一个块已连接: ${branchBlock.id}`);
          }
        } else {
          // 后续块连接到前一个块的next
          if (lastBlock && lastBlock.nextConnection && branchBlock.previousConnection) {
            lastBlock.nextConnection.connect(branchBlock.previousConnection);
            console.log(`✅ if分支后续块已连接: ${branchBlock.id}`);
          }
        }
        lastBlock = branchBlock;
      }
    }
  }

  // 3. 连接else分支
  if (config.elseBranch) {
    console.log('🔗 开始连接 else 分支');
    const elseBranches = Array.isArray(config.elseBranch) ? config.elseBranch : [config.elseBranch];
    let lastBlock = null;
    
    for (let i = 0; i < elseBranches.length; i++) {
      const branchBlock = await createBlockFromConfig(workspace, elseBranches[i]);
      if (branchBlock) {
        createdBlocks.push(branchBlock.id);
        
        if (i === 0) {
          // 第一个块连接到 ELSE 输入
          const elseInput = ifBlock.getInput('ELSE');
          if (elseInput && elseInput.connection && branchBlock.previousConnection) {
            elseInput.connection.connect(branchBlock.previousConnection);
            console.log(`✅ else分支第一个块已连接: ${branchBlock.id}`);
          }
        } else {
          // 后续块连接到前一个块的next
          if (lastBlock && lastBlock.nextConnection && branchBlock.previousConnection) {
            lastBlock.nextConnection.connect(branchBlock.previousConnection);
            console.log(`✅ else分支后续块已连接: ${branchBlock.id}`);
          }
        }
        lastBlock = branchBlock;
      }
    }
  }

  console.log(`🎉 高级条件结构创建完成，共创建 ${createdBlocks.length} 个块`);
  return ifBlock;
}

/**
 * 创建循环结构
 */
async function createLoopStructure(workspace: any, blocks: BlockConfig[], createdBlocks: string[]): Promise<any> {
  // 创建 while 循环块
  const whileBlock = await createBlockSafely(workspace, 'controls_whileUntil', { x: 100, y: 100 }, false);
  if (!whileBlock) {
    throw new Error('无法创建循环块');
  }
  
  createdBlocks.push(whileBlock.id);

  // 设置循环模式
  const modeField = whileBlock.getField('MODE');
  if (modeField) {
    modeField.setValue('WHILE');
  }

  // 连接条件和循环体
  if (blocks.length >= 1) {
    const conditionBlock = await createBlockFromConfig(workspace, blocks[0]);
    if (conditionBlock) {
      createdBlocks.push(conditionBlock.id);
      const boolInput = whileBlock.getInput('BOOL');
      if (boolInput && boolInput.connection && conditionBlock.outputConnection) {
        boolInput.connection.connect(conditionBlock.outputConnection);
      }
    }
  }

  if (blocks.length >= 2) {
    const bodyBlock = await createBlockFromConfig(workspace, blocks[1]);
    if (bodyBlock) {
      createdBlocks.push(bodyBlock.id);
      const doInput = whileBlock.getInput('DO');
      if (doInput && doInput.connection && bodyBlock.previousConnection) {
        doInput.connection.connect(bodyBlock.previousConnection);
      }
    }
  }

  return whileBlock;
}

/**
 * 创建 Setup 结构
 */
async function createSetupStructure(workspace: any, blocks: BlockConfig[], createdBlocks: string[]): Promise<any> {
  // 创建 arduino_setup 块
  const setupBlock = await createBlockSafely(workspace, 'arduino_setup', { x: 30, y: -50 }, false);
  if (!setupBlock) {
    throw new Error('无法创建 Setup 块');
  }
  
  createdBlocks.push(setupBlock.id);

  // 设置为不可删除
  setupBlock.setDeletable(false);

  // 如果有块配置，创建序列并连接到 Setup 输入
  if (blocks.length > 0) {
    const sequenceRoot = await createSequenceStructure(workspace, blocks, createdBlocks);
    if (sequenceRoot) {
      const setupInput = setupBlock.getInput('ARDUINO_SETUP');
      if (setupInput && setupInput.connection && sequenceRoot.previousConnection) {
        setupInput.connection.connect(sequenceRoot.previousConnection);
      }
    }
  }

  return setupBlock;
}

/**
 * 创建回调结构
 */
async function createCallbackStructure(workspace: any, blocks: BlockConfig[], createdBlocks: string[]): Promise<any> {
  // 假设第一个块是回调容器块
  if (blocks.length === 0) {
    throw new Error('回调结构至少需要一个块配置');
  }

  const callbackBlock = await createBlockFromConfig(workspace, blocks[0]);
  if (!callbackBlock) {
    throw new Error('无法创建回调块');
  }
  
  createdBlocks.push(callbackBlock.id);

  // 如果有更多块，创建为回调内容
  if (blocks.length > 1) {
    const contentBlocks = blocks.slice(1);
    const contentRoot = await createSequenceStructure(workspace, contentBlocks, createdBlocks);
    
    if (contentRoot) {
      // 查找合适的输入来连接内容
      const inputs = ['CALLBACK', 'HANDLER', 'DO', 'STACK'];
      for (const inputName of inputs) {
        const input = callbackBlock.getInput(inputName);
        if (input && input.connection && contentRoot.previousConnection) {
          input.connection.connect(contentRoot.previousConnection);
          break;
        }
      }
    }
  }

  return callbackBlock;
}

/**
 * 在目标位置插入结构
 */
async function insertStructureAtTarget(
  workspace: any, 
  rootBlock: any, 
  insertPosition: string, 
  targetBlockId: string, 
  targetInput?: string
): Promise<void> {
  const targetBlock = getBlockByIdSmart(workspace, targetBlockId);
  if (!targetBlock) {
    throw new Error(`未找到目标块: ${targetBlockId}，已尝试模糊匹配`);
  }

  switch (insertPosition) {
    case 'after':
      if (targetBlock.nextConnection && rootBlock.previousConnection) {
        // 如果目标块已有下一个块，先断开
        const existingNext = targetBlock.getNextBlock();
        if (existingNext) {
          targetBlock.nextConnection.disconnect();
        }
        
        // 连接新结构
        targetBlock.nextConnection.connect(rootBlock.previousConnection);
        
        // 如果新结构有 next 连接，连接原来的下一个块
        if (existingNext && rootBlock.nextConnection) {
          let lastBlock = rootBlock;
          while (lastBlock.getNextBlock()) {
            lastBlock = lastBlock.getNextBlock();
          }
          if (lastBlock.nextConnection && existingNext.previousConnection) {
            lastBlock.nextConnection.connect(existingNext.previousConnection);
          }
        }
      }
      break;
      
    case 'input':
      if (targetInput) {
        const input = targetBlock.getInput(targetInput);
        if (input && input.connection && (rootBlock.outputConnection || rootBlock.previousConnection)) {
          const connection = rootBlock.outputConnection || rootBlock.previousConnection;
          input.connection.connect(connection);
        }
      }
      break;
  }
}

/**
 * 查找目标块
 */
async function findTargetBlock(workspace: any, criteria: BlockReference): Promise<any> {
  if (criteria.id) {
    return getBlockByIdSmart(workspace, criteria.id);
  }
  
  if (criteria.type) {
    const allBlocks = workspace.getAllBlocks();
    const matchingBlocks = allBlocks.filter((block: any) => block.type === criteria.type);
    
    if (matchingBlocks.length === 0) {
      return null;
    }
    
    switch (criteria.position) {
      case 'first':
        return matchingBlocks[0];
      case 'last':
        return matchingBlocks[matchingBlocks.length - 1];
      case 'selected':
        return workspace.getSelected();
      default:
        return matchingBlocks[0];
    }
  }
  
  if (criteria.position === 'selected') {
    return workspace.getSelected();
  }
  
  return null;
}

/**
 * 查找块
 */
// 分析块的树状结构信息
function analyzeBlockTree(block: any, workspace: any): BlockTreeInfo['tree'] {
  const tree: BlockTreeInfo['tree'] = {
    childBlocks: [],
    depth: 0,
    path: ''
  };

  // 1. 分析父块关系
  if (block.getParent) {
    const parent = block.getParent();
    if (parent) {
      tree.parentBlock = {
        id: parent.id,
        type: parent.type,
        relation: getBlockRelation(parent, block)
      };
    }
  }

  // 2. 分析子块关系（输入连接的块）
  const inputList = block.inputList || [];
  for (const input of inputList) {
    if (input.connection && input.connection.targetBlock()) {
      const childBlock = input.connection.targetBlock();
      tree.childBlocks.push({
        id: childBlock.id,
        type: childBlock.type,
        inputName: input.name || 'unknown'
      });
    }
  }

  // 3. 分析顺序关系
  if (block.getNextBlock) {
    const nextBlock = block.getNextBlock();
    if (nextBlock) {
      tree.nextBlock = {
        id: nextBlock.id,
        type: nextBlock.type
      };
    }
  }

  if (block.getPreviousBlock) {
    const previousBlock = block.getPreviousBlock();
    if (previousBlock) {
      tree.previousBlock = {
        id: previousBlock.id,
        type: previousBlock.type
      };
    }
  }

  // 4. 查找根块和计算深度
  let currentBlock = block;
  let depth = 0;
  const pathParts: string[] = [];

  while (currentBlock) {
    pathParts.unshift(`${currentBlock.type}[${currentBlock.id}]`);
    
    const parent = currentBlock.getParent ? currentBlock.getParent() : null;
    const previous = currentBlock.getPreviousBlock ? currentBlock.getPreviousBlock() : null;
    
    if (parent) {
      currentBlock = parent;
      depth++;
    } else if (previous) {
      currentBlock = previous;
      // 对于顺序连接，不增加深度，只是路径的一部分
    } else {
      break;
    }
  }

  tree.rootBlock = {
    id: currentBlock.id,
    type: currentBlock.type
  };
  tree.depth = depth;
  tree.path = pathParts.join(' → ');

  return tree;
}

// 获取块之间的关系类型
function getBlockRelation(parent: any, child: any): string {
  const inputList = parent.inputList || [];
  for (const input of inputList) {
    if (input.connection && input.connection.targetBlock() === child) {
      return `input:${input.name}`;
    }
  }
  
  if (parent.getNextBlock && parent.getNextBlock() === child) {
    return 'next';
  }
  
  return 'unknown';
}

// 生成树状结构的文本表示
function generateTreeStructure(blocks: BlockTreeInfo[]): string {
  if (blocks.length === 0) return '';
  
  const lines: string[] = [];
  lines.push('🌳 查找到的块结构树:');
  lines.push('');
  
  // 找出根块（没有父块的块）
  const rootBlocks = blocks.filter(block => !block.tree.parentBlock);
  const allBlocks = blocks;
  
  if (rootBlocks.length === 0) {
    // 如果没有根块，说明查找到的都是子块，显示它们的基本信息
    blocks.forEach((block, index) => {
      lines.push(`${index + 1}. ${block.type} [${block.id}]`);
      lines.push(`   📍 位置: (${block.position.x}, ${block.position.y})`);
      if (Object.keys(block.fields).length > 0) {
        lines.push(`   📝 字段: ${JSON.stringify(block.fields)}`);
      }
      if (block.tree.parentBlock) {
        lines.push(`   📤 父块: ${block.tree.parentBlock.type} [${block.tree.parentBlock.id}]`);
      }
      lines.push('');
    });
  } else {
    // 按结构显示
    rootBlocks.forEach((rootBlock, index) => {
      lines.push(`结构 ${index + 1}: ${rootBlock.type} [${rootBlock.id}]`);
      lines.push(`📍 位置: (${rootBlock.position.x}, ${rootBlock.position.y})`);
      
      if (Object.keys(rootBlock.fields).length > 0) {
        lines.push(`📝 字段: ${JSON.stringify(rootBlock.fields)}`);
      }
      
      // 递归显示结构
      const visited = new Set<string>();
      displayBlockStructureSimple(rootBlock, allBlocks, lines, 1, visited, true, '');
      lines.push('');
    });
  }
  
  return lines.join('\n');
}

// 简化的块结构显示函数 - 使用树状符号
function displayBlockStructureSimple(
  block: BlockTreeInfo, 
  allBlocks: BlockTreeInfo[], 
  lines: string[], 
  indent: number,
  visited: Set<string>,
  isLast: boolean = true,
  prefix: string = ''
) {
  if (visited.has(block.id)) {
    return; // 避免循环引用
  }
  visited.add(block.id);

  // 显示子块（输入连接）
  const childBlocks = block.tree.childBlocks;
  const hasNext = !!block.tree.nextBlock;
  const totalChildren = childBlocks.length + (hasNext ? 1 : 0);
  
  childBlocks.forEach((child, index) => {
    const childBlock = allBlocks.find(b => b.id === child.id);
    if (childBlock) {
      const isLastChild = index === totalChildren - 1 && !hasNext;
      const treeSymbol = isLastChild ? '└──' : '├──';
      const newPrefix = prefix + (isLastChild ? '    ' : '│   ');
      
      // 组装块信息
      let blockInfo = `${childBlock.type} [${childBlock.id}]`;
      
      // 添加位置信息（简化）
      blockInfo += ` @(${childBlock.position.x},${childBlock.position.y})`;
      
      // 添加字段信息（简化）
      if (Object.keys(childBlock.fields).length > 0) {
        const fieldsStr = Object.entries(childBlock.fields)
          .map(([key, value]) => `${key}:${value}`)
          .join(',');
        blockInfo += ` {${fieldsStr}}`;
      }
      
      lines.push(`${prefix}${treeSymbol} ${blockInfo}`);
      
      // 递归显示子结构
      displayBlockStructureSimple(childBlock, allBlocks, lines, indent + 1, visited, isLastChild, newPrefix);
    }
  });

  // 显示下一个块（顺序连接）
  if (hasNext) {
    const nextBlock = allBlocks.find(b => b.id === block.tree.nextBlock!.id);
    if (nextBlock) {
      const treeSymbol = '└──';
      const newPrefix = prefix + '    ';
      
      // 组装块信息
      let blockInfo = `${nextBlock.type} [${nextBlock.id}]`;
      
      // 添加位置信息（简化）
      blockInfo += ` @(${nextBlock.position.x},${nextBlock.position.y})`;
      
      // 添加字段信息（简化）
      if (Object.keys(nextBlock.fields).length > 0) {
        const fieldsStr = Object.entries(nextBlock.fields)
          .map(([key, value]) => `${key}:${value}`)
          .join(',');
        blockInfo += ` {${fieldsStr}}`;
      }
      
      lines.push(`${prefix}${treeSymbol} ${blockInfo}`);
      
      // 递归显示下一个块的结构
      displayBlockStructureSimple(nextBlock, allBlocks, lines, indent, visited, true, newPrefix);
    }
  }
}

// 分析整个工作区的结构
async function analyzeWorkspaceStructure(
  workspace: any, 
  options: {
    includeCode: boolean;
    includeTree: boolean;
    groupBy: string;
  }
): Promise<WorkspaceStructure> {
  console.log('🔍 analyzeWorkspaceStructure 开始分析');
  
  const allBlocks = workspace.getAllBlocks();
  const blockTypes: { [type: string]: number } = {};
  const allBlocksInfo: WorkspaceBlockInfo[] = [];
  const rootBlocks: WorkspaceBlockInfo[] = [];
  const codeMapping: { [blockId: string]: string } = {};

  console.log(`📊 工作区包含 ${allBlocks.length} 个块`);

  // 分析每个块
  for (const block of allBlocks) {
    // 统计块类型
    blockTypes[block.type] = (blockTypes[block.type] || 0) + 1;

    // 收集字段信息
    const fields: any = {};
    const inputList = block.inputList || [];
    
    for (const input of inputList) {
      if (input.fieldRow) {
        for (const field of input.fieldRow) {
          if (field.name && field.getValue) {
            fields[field.name] = field.getValue();
          }
        }
      }
    }

    // 收集输入信息
    const inputs: any = {};
    for (const input of inputList) {
      if (input.name && input.connection) {
        const connectedBlock = input.connection.targetBlock();
        if (connectedBlock) {
          inputs[input.name] = {
            type: connectedBlock.type,
            id: connectedBlock.id
          };
        }
      }
    }

    // 分析树状结构
    const tree = analyzeBlockTree(block, workspace);
    
    // 生成单个块的代码（如果需要）
    let generatedCode = '';
    if (options.includeCode) {
      try {
        generatedCode = await generateBlockCode(block, workspace);
      } catch (error) {
        console.warn(`⚠️ 生成块代码失败 ${block.id}:`, error);
        generatedCode = `// 代码生成失败: ${error}`;
      }
      codeMapping[block.id] = generatedCode;
    }

    const position = block.getRelativeToSurfaceXY();
    const blockInfo: WorkspaceBlockInfo = {
      id: block.id,
      type: block.type,
      position: { x: position.x, y: position.y },
      fields,
      inputs,
      tree,
      generatedCode: options.includeCode ? generatedCode : undefined
    };

    allBlocksInfo.push(blockInfo);

    // 识别根块（顶层块）
    if (!tree.parentBlock && !tree.previousBlock) {
      rootBlocks.push(blockInfo);
    }
  }

  // 生成完整的工作区代码
  let generatedCode = '';
  if (options.includeCode) {
    try {
      generatedCode = await generateWorkspaceCode(workspace);
    } catch (error) {
      console.warn('⚠️ 生成完整代码失败:', error);
      generatedCode = `// 完整代码生成失败: ${error}`;
    }
  }

  // 生成树状结构文本
  let structureTree = '';
  if (options.includeTree) {
    structureTree = generateWorkspaceTreeStructure(allBlocksInfo, rootBlocks, options.groupBy);
  }

  const structure: WorkspaceStructure = {
    totalBlocks: allBlocks.length,
    blockTypes,
    rootBlocks,
    allBlocks: allBlocksInfo,
    structureTree,
    generatedCode: options.includeCode ? generatedCode : undefined,
    codeMapping: options.includeCode ? codeMapping : undefined
  };

  console.log(`✅ 工作区分析完成: ${structure.totalBlocks} 个块，${rootBlocks.length} 个根结构`);
  return structure;
}

// 生成工作区统计信息
function generateWorkspaceStatistics(structure: WorkspaceStructure) {
  const maxDepth = Math.max(...structure.allBlocks.map(b => b.tree.depth));
  
  return {
    totalBlocks: structure.totalBlocks,
    blocksByType: structure.blockTypes,
    maxDepth: maxDepth >= 0 ? maxDepth : 0,
    independentStructures: structure.rootBlocks.length
  };
}

// 格式化工作区概览输出
function formatWorkspaceOverview(
  structure: WorkspaceStructure, 
  statistics: any,
  options: {
    includeCode: boolean;
    includeTree: boolean;
    groupBy: string;
  }
): string {
  const lines: string[] = [];
  
  lines.push('🌍 工作区完整概览');
  lines.push('='.repeat(50));
  lines.push('');
  
  // 统计信息
  lines.push('📊 统计信息:');
  lines.push(`  • 总块数: ${statistics.totalBlocks}`);
  lines.push(`  • 独立结构数: ${statistics.independentStructures}`);
  lines.push(`  • 最大嵌套深度: ${statistics.maxDepth}`);
  lines.push('');
  
  // 块类型分布
  lines.push('📈 块类型分布:');
  Object.entries(statistics.blocksByType)
    .sort(([,a], [,b]) => (b as number) - (a as number))
    .forEach(([type, count]) => {
      lines.push(`  • ${type}: ${count} 个`);
    });
  lines.push('');

  // 树状结构
  if (options.includeTree && structure.structureTree) {
    lines.push('🌳 工作区结构树:');
    lines.push(structure.structureTree);
    lines.push('');
  }

  // 生成的代码
  if (options.includeCode && structure.generatedCode) {
    lines.push('💻 生成的 C++ 代码:');
    lines.push('```cpp');
    lines.push(structure.generatedCode);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// 生成工作区树状结构文本
function generateWorkspaceTreeStructure(
  allBlocks: WorkspaceBlockInfo[], 
  rootBlocks: WorkspaceBlockInfo[],
  groupBy: string
): string {
  const lines: string[] = [];
  
  if (rootBlocks.length === 0) {
    lines.push('📝 工作区为空，没有块');
    return lines.join('\n');
  }

  lines.push('🌳 工作区结构树:');
  lines.push('');

  if (groupBy === 'structure') {
    // 按结构分组
    rootBlocks.forEach((rootBlock, index) => {
      lines.push(`结构 ${index + 1}: ${rootBlock.type} [${rootBlock.id}]`);
      lines.push(`📍 位置: (${rootBlock.position.x}, ${rootBlock.position.y})`);
      
      if (Object.keys(rootBlock.fields).length > 0) {
        lines.push(`📝 字段: ${JSON.stringify(rootBlock.fields)}`);
      }
      
      // 递归显示结构
      const visited = new Set<string>();
      displayBlockStructure(rootBlock, allBlocks, lines, 1, visited, true, '');
      lines.push('');
    });
  } else if (groupBy === 'type') {
    // 按类型分组
    const typeGroups: { [type: string]: WorkspaceBlockInfo[] } = {};
    allBlocks.forEach(block => {
      if (!typeGroups[block.type]) {
        typeGroups[block.type] = [];
      }
      typeGroups[block.type].push(block);
    });

    Object.entries(typeGroups).forEach(([type, blocks]) => {
      lines.push(`📦 ${type} (${blocks.length} 个):`);
      blocks.forEach(block => {
        lines.push(`  • [${block.id}] 位置:(${block.position.x}, ${block.position.y})`);
        if (Object.keys(block.fields).length > 0) {
          lines.push(`    字段: ${JSON.stringify(block.fields)}`);
        }
      });
      lines.push('');
    });
  } else {
    // 扁平列表
    allBlocks.forEach((block, index) => {
      lines.push(`${index + 1}. ${block.type} [${block.id}]`);
      lines.push(`   📍 位置: (${block.position.x}, ${block.position.y})`);
      if (Object.keys(block.fields).length > 0) {
        lines.push(`   📝 字段: ${JSON.stringify(block.fields)}`);
      }
      lines.push(`   📊 深度: ${block.tree.depth} | 路径: ${block.tree.path}`);
      lines.push('');
    });
  }

  return lines.join('\n');
}

// 递归显示块结构 - 使用树状符号
function displayBlockStructure(
  block: WorkspaceBlockInfo, 
  allBlocks: WorkspaceBlockInfo[], 
  lines: string[], 
  indent: number,
  visited: Set<string>,
  isLast: boolean = true,
  prefix: string = ''
) {
  if (visited.has(block.id)) {
    return; // 避免循环引用
  }
  visited.add(block.id);

  // 显示子块（输入连接）
  const childBlocks = block.tree.childBlocks;
  const hasNext = !!block.tree.nextBlock;
  const totalChildren = childBlocks.length + (hasNext ? 1 : 0);
  
  childBlocks.forEach((child, index) => {
    const childBlock = allBlocks.find(b => b.id === child.id);
    if (childBlock) {
      const isLastChild = index === totalChildren - 1 && !hasNext;
      const treeSymbol = isLastChild ? '└──' : '├──';
      const newPrefix = prefix + (isLastChild ? '    ' : '│   ');
      
      // 组装块信息
      let blockInfo = `${childBlock.type} [${childBlock.id}]`;
      
      // 添加位置信息（简化）
      blockInfo += ` @(${childBlock.position.x},${childBlock.position.y})`;
      
      // 添加字段信息（简化）
      if (Object.keys(childBlock.fields).length > 0) {
        const fieldsStr = Object.entries(childBlock.fields)
          .map(([key, value]) => `${key}:${value}`)
          .join(',');
        blockInfo += ` {${fieldsStr}}`;
      }
      
      lines.push(`${prefix}${treeSymbol} ${blockInfo}`);
      
      // 递归显示子结构
      displayBlockStructure(childBlock, allBlocks, lines, indent + 1, visited, isLastChild, newPrefix);
    }
  });

  // 显示下一个块（顺序连接）
  if (hasNext) {
    const nextBlock = allBlocks.find(b => b.id === block.tree.nextBlock!.id);
    if (nextBlock) {
      const treeSymbol = '└──';
      const newPrefix = prefix + '    ';
      
      // 组装块信息
      let blockInfo = `${nextBlock.type} [${nextBlock.id}]`;
      
      // 添加位置信息（简化）
      blockInfo += ` @(${nextBlock.position.x},${nextBlock.position.y})`;
      
      // 添加字段信息（简化）
      if (Object.keys(nextBlock.fields).length > 0) {
        const fieldsStr = Object.entries(nextBlock.fields)
          .map(([key, value]) => `${key}:${value}`)
          .join(',');
        blockInfo += ` {${fieldsStr}}`;
      }
      
      lines.push(`${prefix}${treeSymbol} ${blockInfo}`);
      
      // 递归显示下一个块的结构
      displayBlockStructure(nextBlock, allBlocks, lines, indent, visited, true, newPrefix);
    }
  }
}

// 生成单个块的代码
async function generateBlockCode(block: any, workspace: any): Promise<string> {
  try {
    // 使用全局 Arduino 生成器
    const code = arduinoGenerator.blockToCode(block);
    
    // 处理返回值可能是字符串或 [string, number] 的情况
    let finalCode: string;
    if (Array.isArray(code)) {
      finalCode = code[0] || ''; // 取数组的第一个元素（代码字符串）
    } else {
      finalCode = code || '';
    }
    
    return finalCode || `// ${block.type} - 无代码生成`;
  } catch (error) {
    console.warn(`⚠️ 生成块代码失败 ${block.id}:`, error);
    return `// ${block.type} 块 [${block.id}] - 代码生成错误: ${error}`;
  }
}

// 生成完整工作区的代码
async function generateWorkspaceCode(workspace: any): Promise<string> {
  try {
    // 使用全局 Arduino 生成器直接生成完整代码
    const code = arduinoGenerator.workspaceToCode(workspace);
    return code || '// 无代码生成';
  } catch (error) {
    console.warn('⚠️ 生成完整代码失败:', error);
    
    // 备用方法：获取所有顶层块并生成代码
    try {
      const topBlocks = workspace.getTopBlocks();
      const codeLines: string[] = [];
      
      for (const block of topBlocks) {
        try {
          const blockCode = await generateBlockCode(block, workspace);
          if (blockCode.trim() && !blockCode.includes('代码生成错误')) {
            codeLines.push(blockCode);
          }
        } catch (error) {
          codeLines.push(`// 块代码生成失败: ${error}`);
        }
      }
      
      return codeLines.length > 0 ? codeLines.join('\n\n') : '// 无可用代码内容';
    } catch (backupError) {
      return `// 工作区代码生成完全失败: ${error}`;
    }
  }
}

async function findBlocks(workspace: any, criteria: any): Promise<Array<BlockTreeInfo>> {
  console.log('🔍 findBlocks 开始执行');
  console.log('📦 查找条件:', JSON.stringify(criteria, null, 2));
  
  const allBlocks = workspace.getAllBlocks();
  const results: Array<BlockTreeInfo> = [];

  console.log(`🧱 工作区中共有 ${allBlocks.length} 个块`);

  for (const block of allBlocks) {
    console.log(`\n🔍 检查块: ${block.type} (ID: ${block.id})`);

    // 检查类型匹配
    if (criteria.type && block.type !== criteria.type) {
      console.log(`  ❌ 类型不匹配: 期望 ${criteria.type}, 实际 ${block.type} - 跳过`);
      continue; // 早期退出，不匹配的块直接跳过
    }
    
    if (criteria.type) {
      console.log(`  ✅ 类型匹配: ${block.type}`);
    }

    // 收集字段信息
    const fields: any = {};
    const inputList = block.inputList || [];
    
    // 遍历所有输入以获取字段
    for (const input of inputList) {
      if (input.fieldRow) {
        for (const field of input.fieldRow) {
          if (field.name && field.getValue) {
            fields[field.name] = field.getValue();
          }
        }
      }
    }

    // 也检查直接在块上的字段
    if (block.getField) {
      const fieldNames = ['SERIAL', 'SPEED', 'PIN', 'MODE', 'VAR', 'TEXT', 'NUM']; // 常见字段名
      for (const fieldName of fieldNames) {
        const field = block.getField(fieldName);
        if (field) {
          fields[fieldName] = field.getValue();
        }
      }
    }

    console.log(`  📊 字段信息: ${JSON.stringify(fields, null, 2)}`);

    // 检查字段匹配
    let fieldMatches = true;
    if (criteria.fields) {
      for (const [fieldName, expectedValue] of Object.entries(criteria.fields)) {
        const actualValue = fields[fieldName];
        if (actualValue !== expectedValue) {
          console.log(`  ❌ 字段不匹配: ${fieldName} 期望 ${expectedValue}, 实际 ${actualValue} - 跳过`);
          fieldMatches = false;
          break;
        } else {
          console.log(`  ✅ 字段匹配: ${fieldName} = ${actualValue}`);
        }
      }
    }

    if (!fieldMatches) {
      continue; // 字段不匹配，跳过这个块
    }

    // 收集输入信息
    const inputs: any = {};
    for (const input of inputList) {
      if (input.name && input.connection) {
        const connectedBlock = input.connection.targetBlock();
        if (connectedBlock) {
          inputs[input.name] = {
            type: connectedBlock.type,
            id: connectedBlock.id
          };
        }
      }
    }

    // 如果执行到这里，说明块完全匹配
    const position = block.getRelativeToSurfaceXY();
    
    // 分析树状结构
    const tree = analyzeBlockTree(block, workspace);
    
    const blockInfo: BlockTreeInfo = {
      id: block.id,
      type: block.type,
      position: { x: position.x, y: position.y },
      block: block,
      fields: fields,
      inputs: inputs,
      tree: tree
    };
    
    console.log(`  ✅ 块完全匹配，添加到结果: ${JSON.stringify({
      id: blockInfo.id,
      type: blockInfo.type,
      position: blockInfo.position,
      fields: blockInfo.fields,
      inputs: blockInfo.inputs,
      tree: {
        depth: blockInfo.tree.depth,
        path: blockInfo.tree.path,
        parentBlock: blockInfo.tree.parentBlock,
        childBlocks: blockInfo.tree.childBlocks.length
      }
    }, null, 2)}`);
    
    results.push(blockInfo);
  }

  console.log(`🎯 findBlocks 完成，找到 ${results.length} 个匹配的块`);

  // 根据位置筛选
  if (criteria.position) {
    console.log(`🎯 应用位置筛选: ${criteria.position}`);
    switch (criteria.position) {
      case 'first':
        console.log('  📍 选择第一个块');
        return results.slice(0, 1);
      case 'last':
        console.log('  📍 选择最后一个块');
        return results.slice(-1);
      case 'selected':
        console.log('  📍 筛选已选中的块');
        const selected = workspace.getSelected();
        return results.filter(r => r.block === selected);
    }
  }

  return results;
}

/**
 * 高亮块
 */
async function highlightBlocks(blocks: any[]): Promise<void> {
  try {
    for (const block of blocks) {
      if (block && block.getSvgRoot) {
        const svgRoot = block.getSvgRoot();
        if (svgRoot) {
          // 添加高亮样式
          svgRoot.style.filter = 'drop-shadow(0 0 10px #ffff00)';
          
          // 3秒后移除高亮
          setTimeout(() => {
            if (svgRoot && !block.disposed) {
              svgRoot.style.filter = '';
            }
          }, 3000);
        }
      }
    }
  } catch (error) {
    console.error('高亮块时出错:', error);
  }
}

/**
 * 创建变量
 */
async function createVariable(workspace: any, config: VariableConfig): Promise<{ name: string; id: string }> {
  try {
    // 创建 Blockly 变量
    const variable = workspace.createVariable(config.name, config.type);
    
    // 如果需要自动定义，创建 variable_define 块
    if (config.autoDefine !== false && config.scope === 'global') {
      const defineBlock = await createBlockSafely(workspace, 'variable_define', { x: 50, y: 50 }, false);
      if (defineBlock) {
        const varField = defineBlock.getField('VAR');
        if (varField) {
          varField.setValue(config.name);
        }
        
        // 如果有初始值，设置初始值
        if (config.initialValue !== undefined) {
          const valueInput = defineBlock.getInput('VALUE');
          if (valueInput) {
            // 根据类型创建相应的值块
            let valueBlock = null;
            switch (config.type) {
              case 'int':
              case 'float':
                valueBlock = await createBlockSafely(workspace, 'math_number', { x: 0, y: 0 }, false);
                if (valueBlock) {
                  const numField = valueBlock.getField('NUM');
                  if (numField) {
                    numField.setValue(config.initialValue);
                  }
                }
                break;
              case 'string':
                valueBlock = await createBlockSafely(workspace, 'text', { x: 0, y: 0 }, false);
                if (valueBlock) {
                  const textField = valueBlock.getField('TEXT');
                  if (textField) {
                    textField.setValue(config.initialValue);
                  }
                }
                break;
              case 'bool':
                valueBlock = await createBlockSafely(workspace, 'logic_boolean', { x: 0, y: 0 }, false);
                if (valueBlock) {
                  const boolField = valueBlock.getField('BOOL');
                  if (boolField) {
                    boolField.setValue(config.initialValue ? 'TRUE' : 'FALSE');
                  }
                }
                break;
            }
            
            if (valueBlock && valueInput.connection && valueBlock.outputConnection) {
              valueInput.connection.connect(valueBlock.outputConnection);
            }
          }
        }
      }
    }
    
    return {
      name: variable.name,
      id: variable.getId()
    };
  } catch (error) {
    console.error('创建变量时出错:', error);
    throw error;
  }
}

/**
 * 列出变量
 */
async function listVariables(workspace: any): Promise<Array<{ name: string; id: string; type?: string }>> {
  try {
    const variables = workspace.getAllVariables();
    return variables.map((variable: any) => ({
      name: variable.name,
      id: variable.getId(),
      type: variable.type
    }));
  } catch (error) {
    console.error('列出变量时出错:', error);
    return [];
  }
}

/**
 * 重命名变量
 */
async function renameVariable(workspace: any, oldName: string, newName: string): Promise<void> {
  try {
    const variables = workspace.getAllVariables();
    const variable = variables.find((v: any) => v.name === oldName);
    
    if (!variable) {
      throw new Error(`变量 "${oldName}" 不存在`);
    }
    
    workspace.renameVariableById(variable.getId(), newName);
  } catch (error) {
    console.error('重命名变量时出错:', error);
    throw error;
  }
}

/**
 * 删除变量
 */
async function deleteVariable(workspace: any, variableName: string): Promise<void> {
  try {
    const variables = workspace.getAllVariables();
    const variable = variables.find((v: any) => v.name === variableName);
    
    if (!variable) {
      throw new Error(`变量 "${variableName}" 不存在`);
    }
    
    workspace.deleteVariableById(variable.getId());
  } catch (error) {
    console.error('删除变量时出错:', error);
    throw error;
  }
}

// =============================================================================
// 导出所有工具函数
// =============================================================================

export const blocklyEditTools = {
  smartBlock: smartBlockTool,
  connectBlocks: connectBlocksTool,
  createCodeStructure: createCodeStructureTool,
  configureBlock: configureBlockTool,
  variableManager: variableManagerTool,
  findBlock: findBlockTool,
  deleteBlock: deleteBlockTool,
  getWorkspaceOverview: getWorkspaceOverviewTool // 新增工具
};

// 默认导出主要的编辑工具
export default smartBlockTool;

// 初始化事件错误处理器(2025.9.16 陈吕洲 未调用就运行，非常不好，要改)
// setTimeout(() => {  
//   initializeEventErrorHandler();
// }, 1000);
