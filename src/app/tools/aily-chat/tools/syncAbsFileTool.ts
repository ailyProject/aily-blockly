/**
 * ABS 文件同步工具
 * 
 * 提供 Blockly 工作区与 project.abs 文件之间的同步操作
 */

import { convertAbiToAbs, convertAbsToAbi } from './abiAbsConverter';
import { getActiveWorkspace, createBlockFromConfig } from './editBlockTool';
import { AbsAutoSyncService } from '../services/abs-auto-sync.service';
import { loadProjectBlockDefinitions, parseAbs, BlocklyAbsParser } from './absParser';

declare const Blockly: any;

// =============================================================================
// 类型定义
// =============================================================================

interface SyncAbsArgs {
  operation: 'export' | 'import' | 'status';
  includeHeader?: boolean;
}

interface SyncAbsResult {
  is_error: boolean;
  content: string;
  metadata?: {
    operation: string;
    filePath?: string;
    absPreview?: string;
    blockCount?: number;
    variableCount?: number;
    versionSaved?: boolean;
  };
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 对 rootBlocks 进行排序，确保加载顺序正确
 * 
 * 加载顺序：
 * 1. 先加载函数定义块（custom_function_def 等），让 mutator 注册函数到 registry
 * 2. 最后加载 arduino_setup 和 arduino_loop，这时函数调用块能正确获取参数信息
 * 
 * @param rootBlocks 原始 rootBlocks 数组
 * @returns 排序后的 rootBlocks 数组
 */
function sortBlocksForLoading(rootBlocks: any[]): any[] {
  // 需要放到最后加载的块类型
  const loadLastTypes = new Set(['arduino_setup', 'arduino_loop']);
  
  const normalBlocks: any[] = [];
  const lastBlocks: any[] = [];
  
  for (const block of rootBlocks) {
    if (loadLastTypes.has(block.type)) {
      lastBlocks.push(block);
    } else {
      normalBlocks.push(block);
    }
  }
  
  // 返回：先加载普通块（包括函数定义），后加载 setup/loop
  return [...normalBlocks, ...lastBlocks];
}

// =============================================================================
// 工具处理函数
// =============================================================================

/**
 * ABS 文件同步处理
 */
export async function syncAbsFileHandler(
  args: SyncAbsArgs,
  projectService: any,
  electronService: any,
  absAutoSyncService?: AbsAutoSyncService
): Promise<SyncAbsResult> {
  const { operation, includeHeader = true } = args;
  
  // 获取项目路径（优先使用当前项目路径，否则使用根路径）
  const projectPath = projectService?.currentProjectPath || projectService?.projectRootPath;
  if (!projectPath) {
    return {
      is_error: true,
      content: '无法获取当前项目路径，请先打开一个项目'
    };
  }
  
  // 加载项目的块定义
  loadProjectBlockDefinitions(projectPath);
  
  const absFilePath = `${projectPath}/project.abs`;
  const abiFilePath = `${projectPath}/project.abi`;
  
  switch (operation) {
    case 'export':
      return await exportToAbs(abiFilePath, absFilePath, includeHeader, electronService);
    
    case 'import':
      return await importFromAbs(absFilePath, abiFilePath, electronService, absAutoSyncService);
    
    case 'status':
      return await getAbsStatus(absFilePath, abiFilePath, electronService);
    
    default:
      return {
        is_error: true,
        content: `未知操作: ${operation}`
      };
  }
}

/**
 * 导出 Blockly 工作区到 ABS 文件
 */
async function exportToAbs(
  abiFilePath: string,
  absFilePath: string,
  includeHeader: boolean,
  electronService: any
): Promise<SyncAbsResult> {
  try {
    // 方法1：从工作区获取
    const workspace = getActiveWorkspace();
    let abiJson: any;
    
    if (workspace) {
      // 直接从工作区序列化
      abiJson = Blockly.serialization.workspaces.save(workspace);
    } else if (electronService.exists(abiFilePath)) {
      // 方法2：从 ABI 文件读取
      const abiContent = electronService.readFile(abiFilePath);
      abiJson = JSON.parse(abiContent);
    } else {
      return {
        is_error: true,
        content: '无法获取 Blockly 工作区或 ABI 文件'
      };
    }
    
    // 转换为 ABS 格式
    const absContent = convertAbiToAbs(abiJson, { includeHeader });
    
    // 写入 ABS 文件
    electronService.writeFile(absFilePath, absContent);
    
    // 统计信息
    const blockCount = countBlocks(abiJson);
    const variableCount = abiJson.variables?.length || 0;
    
    // 生成预览（前 30 行）
    const absLines = absContent.split('\n');
    const preview = absLines.slice(0, 30).join('\n') + 
      (absLines.length > 30 ? '\n... (more lines)' : '');
    
    return {
      is_error: false,
      content: `✅ 已导出 ABS 文件

**文件路径:** \`${absFilePath}\`
**统计:** ${blockCount} 个块, ${variableCount} 个变量

**ABS 预览:**
\`\`\`
${preview}
\`\`\`

**下一步操作建议:**
1. 使用 \`read_file\` 读取完整的 ABS 文件
2. 使用 \`edit_file\` 修改 ABS 内容
3. 修改完成后使用 \`sync_abs_file(operation: "import")\` 应用更改`,
      metadata: {
        operation: 'export',
        filePath: absFilePath,
        absPreview: preview,
        blockCount,
        variableCount
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `导出失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 从 ABS 文件导入到 Blockly 工作区
 * 使用 createBlockFromConfig 直接创建块，支持动态扩展
 */
async function importFromAbs(
  absFilePath: string,
  abiFilePath: string,
  electronService: any,
  absAutoSyncService?: AbsAutoSyncService
): Promise<SyncAbsResult> {
  try {
    // 检查 ABS 文件是否存在
    if (!electronService.exists(absFilePath)) {
      return {
        is_error: true,
        content: `ABS 文件不存在: ${absFilePath}\n\n请先使用 \`sync_abs_file(operation: "export")\` 生成 ABS 文件`
      };
    }
    
    // 在修改前保存当前版本（AI 修改时的版本控制）
    // 注意：使用 getWorkspaceAbsContent 而不是 exportToAbs，避免覆盖用户编辑的 ABS 文件
    let versionSaved = false;
    if (absAutoSyncService) {
      try {
        // 获取当前工作区内容并保存版本（不写入文件）
        const currentAbs = absAutoSyncService.getWorkspaceAbsContent();
        if (currentAbs) {
          const version = await absAutoSyncService.saveVersion(currentAbs, 'AI 修改前备份');
          versionSaved = !!version;
        }
      } catch (e) {
        console.warn('[syncAbsFile] 保存版本失败:', e);
      }
    }
    
    // 读取 ABS 文件
    const absContent = electronService.readFile(absFilePath);
    
    // 解析 ABS（不转换为 ABI JSON，而是获取 BlockConfig）
    const parser = new BlocklyAbsParser();
    const parseResult = parser.parse(absContent);
    
    // 🆕 重新排序 rootBlocks：先加载函数定义等块，最后加载 setup/loop
    // 这确保 custom_function_def 先注册到 registry，custom_function_call 才能正确获取参数信息
    const sortedRootBlocks = sortBlocksForLoading(parseResult.rootBlocks);
    parseResult.rootBlocks = sortedRootBlocks;
    // console.log(`📑 块加载顺序: ${sortedRootBlocks.map(b => b.type).join(' → ')}`);
    
    if (!parseResult.success) {
      const errorMessages = parseResult.errors
        ?.map(e => `第 ${e.line} 行: ${e.message}`)
        .join('\n') || '未知错误';
      
      return {
        is_error: true,
        content: `ABS 解析失败:\n${errorMessages}\n\n请检查 ABS 文件语法，读取对应库 reademe_ai.md 或使用 \`get_block_info_tool\` 查询正确的块定义和参数格式。`
      };
    }
    
    // 获取工作区
    const workspace = getActiveWorkspace();
    if (!workspace) {
      return {
        is_error: true,
        content: '无法获取 Blockly 工作区'
      };
    }
    
    // 备份当前 ABI 文件
    if (electronService.exists(abiFilePath)) {
      const backupPath = `${abiFilePath}.backup`;
      const currentAbi = electronService.readFile(abiFilePath);
      electronService.writeFile(backupPath, currentAbi);
    }
    
    // 收集所有变量：从 @var 声明 + 从 $varName 引用自动推断
    const allVariables = new Map<string, string>(); // name → type
    
    // 🆕 收集会被初始化块自动创建的变量（如 dht_init 的第一个参数）
    // 这些变量不需要预先创建，让 Blockly 扩展自动创建带正确类型的变量
    const autoCreatedVars = collectAutoCreatedVariables(parseResult.rootBlocks);
    if (autoCreatedVars.size > 0) {
      // console.log(`📋 检测到初始化块自动创建的变量: ${Array.from(autoCreatedVars).join(', ')}`);
    }
    
    // 1. 从显式 @var 声明中收集（如果有）
    for (const varDef of parseResult.variables) {
      allVariables.set(varDef.name, varDef.type);
    }
    
    // 2. 从 $varName 引用中自动收集（扫描所有块）
    // 🆕 排除会被初始化块自动创建的变量
    const inferredVars = collectVariableReferences(parseResult.rootBlocks);
    for (const varName of inferredVars) {
      if (!allVariables.has(varName) && !autoCreatedVars.has(varName)) {
        allVariables.set(varName, ''); // 类型未知，使用默认
        // console.log(`🔍 自动推断变量: "${varName}" (从 $${varName} 引用)`);
      } else if (autoCreatedVars.has(varName)) {
        // console.log(`⏭️ 跳过变量: "${varName}" (将由初始化块自动创建)`);
      }
    }
    
    // 清理不再需要的旧变量，保留 ABS 中会用到的变量
    // 变量库及部分库的块在加载时会自动注册变量（如 registerVariableToBlockly / addVariableToToolbox）
    // 所以只删除既不在 ABS 声明/引用中、也不会被初始化块自动创建的变量
    // 使用 VariableMap 直接操作，避免 workspace.deleteVariableById 弹出确认对话框
    const variableMap = workspace.getVariableMap();
    const existingVars = workspace.getAllVariables();
    if (variableMap && existingVars.length > 0) {
      for (const oldVar of existingVars) {
        if (!allVariables.has(oldVar.name) && !autoCreatedVars.has(oldVar.name)) {
          variableMap.deleteVariable(oldVar);
        }
      }
    }
    
    // 同步 ABS 中声明的变量到工作区（只创建不存在的，保留已有的）
    const variableNameToId = new Map<string, string>();
    
    for (const [name, type] of allVariables) {
      let variable = workspace.getVariable(name);
      if (!variable) {
        variable = workspace.createVariable(name, type || undefined);
      }
      variableNameToId.set(name, variable.getId());
    }
    // console.log(`📋 同步 ${allVariables.size} 个变量`);
    
    // 🆕 尝试增量更新
    const hasExistingBlocks = workspace.getTopBlocks(false).length > 0;
    let updateResult: { added: number; removed: number; unchanged: number; failedBlocks: any[] } | null = null;
    let useIncrementalUpdate = hasExistingBlocks;
    
    if (useIncrementalUpdate) {
      // console.log('🔄 尝试增量更新...');
      try {
        updateResult = await incrementalUpdate(
          workspace,
          parseResult.rootBlocks,
          variableNameToId,
          preprocessVariableReferences
        );
        // console.log(`📊 增量更新完成: +${updateResult.added}, -${updateResult.removed}, =${updateResult.unchanged}`);
      } catch (e) {
        console.warn('⚠️ 增量更新失败，回退到全量更新:', e);
        useIncrementalUpdate = false;
      }
    }
    
    // 如果增量更新失败或没有现有块，使用全量更新
    let totalBlocks = 0;
    const failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }> = [];
    
    if (!useIncrementalUpdate) {
      // console.log('🔄 执行全量更新（保留受保护块）...');
      
      // 🆕 收集受保护的块，稍后恢复
      const protectedBlocksMap = new Map<string, any>();
      const existingTopBlocks = workspace.getTopBlocks(false);
      for (const block of existingTopBlocks) {
        if (PROTECTED_ROOT_BLOCKS.has(block.type) && !protectedBlocksMap.has(block.type)) {
          // 记录受保护块的位置信息
          protectedBlocksMap.set(block.type, {
            block: block,
            x: block.getRelativeToSurfaceXY().x,
            y: block.getRelativeToSurfaceXY().y
          });
        }
      }
      
      // 清空非受保护块
      Blockly.Events.disable();
      try {
        for (const block of existingTopBlocks) {
          if (!PROTECTED_ROOT_BLOCKS.has(block.type)) {
            block.dispose(true);
          } else {
            // 清空受保护块的子块
            for (const input of block.inputList || []) {
              if (input.connection?.isConnected()) {
                const child = input.connection.targetBlock();
                if (child && !child.isShadow()) {
                  input.connection.disconnect();
                  child.dispose(true);
                }
              }
            }
          }
        }
      } finally {
        Blockly.Events.enable();
      }
      
      // 重新创建变量
      variableNameToId.clear();
      for (const [name, type] of allVariables) {
        let variable = workspace.getVariable(name);
        if (!variable) {
          variable = workspace.createVariable(name, type || undefined);
        }
        variableNameToId.set(name, variable.getId());
      }
      
      let yPosition = 30;
      const processedTypes = new Set<string>();
      
      for (const blockConfig of parseResult.rootBlocks) {
        // 检查是否有受保护块需要重建子块
        if (PROTECTED_ROOT_BLOCKS.has(blockConfig.type) && protectedBlocksMap.has(blockConfig.type)) {
          const protectedInfo = protectedBlocksMap.get(blockConfig.type);
          processedTypes.add(blockConfig.type);
          
          // 使用 rebuildBlockChildren 重建子块
          preprocessVariableReferences(blockConfig, variableNameToId);
          try {
            const rebuildResult = await rebuildBlockChildren(
              workspace, protectedInfo.block, blockConfig,
              variableNameToId, preprocessVariableReferences
            );
            totalBlocks++;
            if (rebuildResult.failedBlocks?.length) {
              failedBlocks.push(...rebuildResult.failedBlocks);
            }
          } catch (error) {
            console.warn(`重建受保护块子块失败: ${blockConfig.type}`, error);
            failedBlocks.push({
              blockType: blockConfig.type,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          continue;
        }
        
        // 设置位置
        const configWithPosition = {
          ...blockConfig,
          position: { x: 30, y: yPosition }
        };
        
        // 预处理：将变量名转换为变量 ID
        preprocessVariableReferences(configWithPosition, variableNameToId);
        
        try {
          const result = await createBlockFromConfig(workspace, configWithPosition);
          if (result.block) {
            totalBlocks += result.totalBlocks;
            yPosition += calculateBlockHeight(result.block) + 50;
          }
          if (result.failedBlocks && result.failedBlocks.length > 0) {
            failedBlocks.push(...result.failedBlocks);
          }
        } catch (error) {
          console.warn(`创建块失败: ${blockConfig.type}`, error);
          failedBlocks.push({
            blockType: blockConfig.type,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } else {
      // 使用增量更新结果
      totalBlocks = (updateResult?.added || 0) + (updateResult?.unchanged || 0);
      if (updateResult?.failedBlocks) {
        failedBlocks.push(...updateResult.failedBlocks);
      }
    }
    
    // 保存工作区到 ABI 文件
    const abiJson = Blockly.serialization.workspaces.save(workspace);
    electronService.writeFile(abiFilePath, JSON.stringify(abiJson, null, 2));
    
    const variableCount = allVariables.size;  // 使用收集到的所有变量数量
    
    // 警告信息
    let warnings = '';
    if (parseResult.warnings && parseResult.warnings.length > 0) {
      warnings = '\n\n**⚠️ 警告:**\n' + 
        parseResult.warnings.map(w => `- 第 ${w.line} 行: ${w.message}`).join('\n');
    }
    
    // 更新模式信息
    let updateModeInfo = '';
    if (useIncrementalUpdate && updateResult) {
      updateModeInfo = `\n**更新模式:** 增量更新 (新增 ${updateResult.added}, 删除 ${updateResult.removed}, 保持 ${updateResult.unchanged})`;
    } else {
      updateModeInfo = '\n**更新模式:** 全量重建';
    }
    
    // 失败的块
    let failedInfo = '';
    if (failedBlocks.length > 0) {
      failedInfo = '\n\n**❌ 创建失败的块 (' + failedBlocks.length + ' 个):**\n';
      
      for (const f of failedBlocks) {
        failedInfo += `- \`${f.blockType}\`: ${f.error}\n`;
      }
      
      failedInfo += '\n**🔧 修复建议:**\n';
      failedInfo += '1. 检查块类型是否拼写正确\n';
      failedInfo += '2. 直接读取库的 generator/block 等文件了解块的使用方法\n';
      failedInfo += '3. 阅读对应库的 README 了解块的使用方法\n';
      failedInfo += '4. 如果多次尝试仍失败，考虑使用 `lib-core-custom` 的自定义代码块\n';
    }
    
    // 版本信息
    const versionInfo = versionSaved ? '\n**版本:** 修改前状态已自动保存到版本历史' : '';
    
    return {
      is_error: false,
      content: `✅ 已从 ABS 文件导入

**统计:** ${totalBlocks} 个块, ${variableCount} 个变量${updateModeInfo}
**备份:** 原 ABI 文件已备份为 \`project.abi.backup\`${versionInfo}${warnings}${failedInfo}

工作区已更新，请使用get_workspace_overview_tool检查工作区实际的代码是否符合用户需求。`,
      metadata: {
        operation: 'import',
        filePath: absFilePath,
        blockCount: totalBlocks,
        variableCount,
        versionSaved
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `导入失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 从块配置中收集所有变量引用（$varName 格式）
 * 用于自动创建 Blockly 工作区变量
 */
function collectVariableReferences(blocks: any[]): Set<string> {
  const varNames = new Set<string>();
  
  function collectFromConfig(config: any): void {
    if (!config) return;
    
    // 从字段中收集变量引用
    if (config.fields) {
      for (const value of Object.values(config.fields)) {
        if (typeof value === 'object' && value !== null && (value as any).name) {
          varNames.add((value as any).name);
        }
      }
    }
    
    // 递归处理输入
    if (config.inputs) {
      for (const input of Object.values(config.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) {
          collectFromConfig(inputConfig.block);
        }
        if (inputConfig.shadow) {
          collectFromConfig(inputConfig.shadow);
        }
      }
    }
    
    // 处理 next
    if (config.next?.block) {
      collectFromConfig(config.next.block);
    }
  }
  
  for (const block of blocks) {
    collectFromConfig(block);
  }
  
  return varNames;
}

/**
 * 🆕 收集会被初始化块自动创建的变量
 * 这些块（如 dht_init, servo_init 等）的第一个字符串参数是变量名，
 * Blockly 扩展会自动创建带正确类型的变量
 */
function collectAutoCreatedVariables(blocks: any[]): Set<string> {
  const autoCreatedVars = new Set<string>();
  
  // 已知会自动创建变量的初始化块模式
  // 块类型 → 包含变量名的字段名
  const initBlockPatterns: Record<string, string> = {
    'dht_init': 'VAR',
    'servo_init': 'VAR',
    'stepper_init': 'VAR',
    'lcd_init': 'VAR',
    'oled_init': 'VAR',
    'neopixel_init': 'VAR',
    'motor_init': 'VAR',
    'ultrasonic_init': 'VAR',
    'ir_init': 'VAR',
    'mqtt_init': 'VAR',
    'ntpclient_create': 'VAR',
    // 可以根据需要添加更多
  };
  
  function collectFromConfig(config: any): void {
    if (!config) return;
    
    // 检查是否是初始化块
    const varFieldName = initBlockPatterns[config.type];
    if (varFieldName && config.fields) {
      const varValue = config.fields[varFieldName];
      if (varValue) {
        // 变量名可能是字符串或 { name: "xxx" } 对象
        const varName = typeof varValue === 'string' ? varValue : varValue.name;
        if (varName) {
          autoCreatedVars.add(varName);
        }
      }
    }
    
    // 递归处理输入
    if (config.inputs) {
      for (const input of Object.values(config.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) {
          collectFromConfig(inputConfig.block);
        }
      }
    }
    
    // 处理 next
    if (config.next?.block) {
      collectFromConfig(config.next.block);
    }
  }
  
  for (const block of blocks) {
    collectFromConfig(block);
  }
  
  return autoCreatedVars;
}

/**
 * 预处理变量引用：将 { name: "varName" } 转换为 Blockly 可识别的格式
 */
function preprocessVariableReferences(
  config: any, 
  variableNameToId: Map<string, string>
): void {
  // 处理字段中的变量引用
  if (config.fields) {
    for (const [key, value] of Object.entries(config.fields)) {
      if (typeof value === 'object' && value !== null && (value as any).name) {
        const varName = (value as any).name;
        const varId = variableNameToId.get(varName);
        if (varId) {
          // Blockly 需要 id 字段
          config.fields[key] = { id: varId, name: varName, type: '' };
        }
      }
    }
  }
  
  // 递归处理输入
  if (config.inputs) {
    for (const input of Object.values(config.inputs)) {
      const inputConfig = input as any;
      if (inputConfig.block) {
        preprocessVariableReferences(inputConfig.block, variableNameToId);
      }
      if (inputConfig.shadow) {
        preprocessVariableReferences(inputConfig.shadow, variableNameToId);
      }
    }
  }
  
  // 处理 next
  if (config.next?.block) {
    preprocessVariableReferences(config.next.block, variableNameToId);
  }
}

/**
 * 计算块的实际高度
 */
function calculateBlockHeight(block: any): number {
  if (!block) return 50;
  
  try {
    // 尝试获取块的实际高度
    if (block.height) {
      return block.height;
    }
    
    // 回退到估算
    let height = 50;
    
    // 计算子块高度
    const inputs = block.inputList || [];
    for (const input of inputs) {
      if (input.connection && input.connection.targetBlock()) {
        height += calculateBlockHeight(input.connection.targetBlock());
      }
    }
    
    // 计算 next 链
    if (block.nextConnection && block.nextConnection.targetBlock()) {
      height += calculateBlockHeight(block.nextConnection.targetBlock());
    }
    
    return height;
  } catch {
    return 50;
  }
}

/**
 * 获取 ABS 文件状态
 */
async function getAbsStatus(
  absFilePath: string,
  abiFilePath: string,
  electronService: any
): Promise<SyncAbsResult> {
  try {
    const absExists = electronService.exists(absFilePath);
    const abiExists = electronService.exists(abiFilePath);
    
    let content = `## ABS 文件状态\n\n`;
    content += `**ABS 文件:** ${absFilePath}\n`;
    content += `**状态:** ${absExists ? '✅ 存在' : '❌ 不存在'}\n\n`;
    content += `**ABI 文件:** ${abiFilePath}\n`;
    content += `**状态:** ${abiExists ? '✅ 存在' : '❌ 不存在'}\n\n`;
    
    let blockCount = 0;
    let variableCount = 0;
    let absPreview = '';
    
    if (absExists) {
      const absContent = electronService.readFile(absFilePath);
      const lines = absContent.split('\n');
      absPreview = lines.slice(0, 20).join('\n') + 
        (lines.length > 20 ? '\n... (more lines)' : '');
      
      content += `**ABS 内容预览:**\n\`\`\`\n${absPreview}\n\`\`\`\n\n`;
      
      // 统计
      const nonEmptyLines = lines.filter(l => l.trim() && !l.trim().startsWith('#'));
      content += `**ABS 行数:** ${lines.length} (非空非注释: ${nonEmptyLines.length})\n`;
    }
    
    if (abiExists) {
      const abiContent = electronService.readFile(abiFilePath);
      const abiJson = JSON.parse(abiContent);
      blockCount = countBlocks(abiJson);
      variableCount = abiJson.variables?.length || 0;
      
      content += `**ABI 块数:** ${blockCount}\n`;
      content += `**ABI 变量数:** ${variableCount}\n`;
    }
    
    content += `\n**建议操作:**\n`;
    if (!absExists && abiExists) {
      content += `- 使用 \`sync_abs_file(operation: "export")\` 生成 ABS 文件\n`;
    } else if (absExists) {
      content += `- 使用 \`read_file\` 读取完整 ABS 内容\n`;
      content += `- 使用 \`edit_file\` 修改后 \`sync_abs_file(operation: "import")\` 应用\n`;
    }
    
    return {
      is_error: false,
      content,
      metadata: {
        operation: 'status',
        filePath: absFilePath,
        absPreview,
        blockCount,
        variableCount
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `获取状态失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 统计块数量
 */
function countBlocks(abiJson: any): number {
  let count = 0;
  
  function countRecursive(block: any): void {
    if (!block) return;
    count++;
    
    // 统计输入中的块
    if (block.inputs) {
      for (const input of Object.values(block.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) countRecursive(inputConfig.block);
        if (inputConfig.shadow) countRecursive(inputConfig.shadow);
      }
    }
    
    // 统计 next 块
    if (block.next?.block) {
      countRecursive(block.next.block);
    }
  }
  
  if (abiJson.blocks?.blocks) {
    for (const block of abiJson.blocks.blocks) {
      countRecursive(block);
    }
  }
  
  return count;
}

// =============================================================================
// 增量更新辅助函数
// =============================================================================

/**
 * 规范化字段值用于签名比较
 * 统一处理变量字段、普通字段的格式差异
 */
function normalizeFieldValue(value: any): string {
  if (value === null || value === undefined) return '';
  
  if (typeof value === 'object') {
    // 变量字段：优先使用 name，因为 ABS 和工作区都有 name
    if ('name' in value) {
      return `var:${value.name}`;
    }
    if ('id' in value) {
      return `id:${value.id}`;
    }
    return JSON.stringify(value);
  }
  
  return String(value);
}

/**
 * 找到块配置中的第一个子块（用于调试对比）
 */
function findFirstChildBlock(blockConfig: any): any {
  if (!blockConfig) return null;
  
  // 优先从 inputs 中找
  if (blockConfig.inputs) {
    for (const [inputName, inputValue] of Object.entries(blockConfig.inputs) as [string, any][]) {
      if (inputValue.block) return inputValue.block;
      if (inputValue.shadow) return inputValue.shadow;
    }
  }
  
  // 然后从 next 中找
  if (blockConfig.next?.block) {
    return blockConfig.next.block;
  }
  
  return null;
}

/**
 * 计算块链的签名（用于比较是否相同）
 * 签名包含：块类型、字段值、输入连接、next 连接
 * 注意：不包含位置信息和块 ID
 */
function computeBlockChainSignature(block: any): string {
  if (!block) return '';
  
  const parts: string[] = [];
  
  // 块类型
  parts.push(`T:${block.type}`);
  
  // 需要跳过的字段（UI 相关，不影响语义）
  const isUIField = (name: string): boolean => {
    // PLUS, MINUS, PLUS1, MINUS1, MINUS2 等都是 UI 按钮图标
    if (/^(PLUS|MINUS)\d*$/i.test(name)) return true;
    return false;
  };
  
  // 标准字段名列表（这些字段名在签名中保留原名）
  const standardFieldNames = new Set(['VAR', 'TYPE', 'NAME', 'TEXT', 'NUM', 'VALUE', 'OP', 'MODE', 'BOOL', 'ITEM']);
  
  // 字段值（排序后连接，跳过空值和 UI 字段）
  // EXTRA_N 字段和非标准字段只按值参与签名，使用 _DYN_VAL:value 格式
  if (block.fields) {
    const normalFields: string[] = [];
    const dynamicValues: string[] = [];
    
    const sortedEntries = Object.entries(block.fields)
      .filter(([k, v]) => !isUIField(k) && v !== null && v !== undefined && v !== '')
      .sort(([a], [b]) => a.localeCompare(b));
    
    for (const [k, v] of sortedEntries) {
      // EXTRA_N 字段：只保留值，按索引顺序
      if (/^EXTRA_\d+$/.test(k)) {
        dynamicValues.push(normalizeFieldValue(v));
      }
      // 标准字段：保留字段名
      else if (standardFieldNames.has(k)) {
        normalFields.push(`${k}=${normalizeFieldValue(v)}`);
      }
      // 其他字段（可能是动态创建的如 PIN）：也只保留值
      else {
        dynamicValues.push(normalizeFieldValue(v));
      }
    }
    
    // 标准字段部分
    if (normalFields.length > 0) {
      parts.push(`F:{${normalFields.join(',')}}`);
    }
    // 动态字段值部分（只值不含名，排序后）
    if (dynamicValues.length > 0) {
      parts.push(`D:[${dynamicValues.sort().join(',')}]`);
    }
  }
  
  // extraState（如果有且非空）
  if (block.extraState && Object.keys(block.extraState).length > 0) {
    parts.push(`E:${JSON.stringify(block.extraState)}`);
  }
  
  // 输入连接（递归计算子块签名）
  if (block.inputs) {
    const inputSigs = Object.entries(block.inputs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, input]: [string, any]) => {
        const blockSig = input.block ? computeBlockChainSignature(input.block) : '';
        const shadowSig = input.shadow ? computeBlockChainSignature(input.shadow) : '';
        // 只有当有内容时才包含
        if (blockSig || shadowSig) {
          return `${name}:[${blockSig}|${shadowSig}]`;
        }
        return null;
      })
      .filter(Boolean);
    if (inputSigs.length > 0) {
      parts.push(`I:{${inputSigs.join(',')}}`);
    }
  }
  
  // next 连接
  if (block.next?.block) {
    parts.push(`N:${computeBlockChainSignature(block.next.block)}`);
  }
  
  return parts.join('|');
}

/**
 * 将 Blockly 工作区中的块序列化为与 ABS 解析结果相同的格式
 * 重要：输出格式必须与 ABS 解析器的 BlockConfig 格式一致
 */
function serializeWorkspaceBlock(block: any): any {
  if (!block) return null;
  
  const result: any = {
    type: block.type
  };
  
  // 序列化字段
  const fields: any = {};
  for (const input of block.inputList || []) {
    for (const field of input.fieldRow || []) {
      if (field.name && field.getValue) {
        const value = field.getValue();
        // 变量字段特殊处理：使用 { name: varName } 格式，与 ABS 解析结果一致
        if (field.getVariable) {
          const variable = field.getVariable();
          if (variable) {
            // 只保留 name，与 ABS 解析结果格式一致
            fields[field.name] = { name: variable.name };
          }
        } else if (value !== undefined && value !== null && value !== '') {
          fields[field.name] = value;
        }
      }
    }
  }
  if (Object.keys(fields).length > 0) {
    result.fields = fields;
  }
  
  // 序列化 extraState（只有非空时才添加）
  if (block.saveExtraState) {
    try {
      const extraState = block.saveExtraState();
      if (extraState && Object.keys(extraState).length > 0) {
        result.extraState = extraState;
      }
    } catch (e) {
      // 忽略
    }
  }
  
  // 序列化输入
  const inputs: any = {};
  for (const input of block.inputList || []) {
    if (input.connection && input.name) {
      const connectedBlock = input.connection.targetBlock();
      if (connectedBlock) {
        const isShadow = connectedBlock.isShadow();
        const serialized = serializeWorkspaceBlock(connectedBlock);
        if (serialized) {
          if (isShadow) {
            inputs[input.name] = { shadow: serialized };
          } else {
            inputs[input.name] = { block: serialized };
          }
        }
      }
    }
  }
  if (Object.keys(inputs).length > 0) {
    result.inputs = inputs;
  }
  
  // 序列化 next
  if (block.nextConnection) {
    const nextBlock = block.nextConnection.targetBlock();
    if (nextBlock) {
      const serialized = serializeWorkspaceBlock(nextBlock);
      if (serialized) {
        result.next = { block: serialized };
      }
    }
  }
  
  return result;
}

/**
 * 获取工作区中所有根块（顶层块）
 */
function getWorkspaceRootBlocks(workspace: any): any[] {
  const topBlocks = workspace.getTopBlocks(false);
  return topBlocks.map((block: any) => ({
    block,
    serialized: serializeWorkspaceBlock(block),
    signature: computeBlockChainSignature(serializeWorkspaceBlock(block))
  }));
}

/**
 * 就地更新块的字段值
 * 返回是否有任何字段被更新
 */
function updateBlockFields(block: any, newFields: any, variableNameToId: Map<string, string>): boolean {
  if (!newFields) return false;
  
  let updated = false;
  for (const [fieldName, newValue] of Object.entries(newFields)) {
    const field = block.getField(fieldName);
    if (!field) continue;
    
    // 变量字段特殊处理
    if (field.getVariable && typeof newValue === 'object' && newValue && 'name' in newValue) {
      const varName = (newValue as any).name;
      const varId = variableNameToId.get(varName);
      if (varId) {
        const currentVar = field.getVariable();
        if (!currentVar || currentVar.name !== varName) {
          field.setValue(varId);
          updated = true;
        }
      }
    } else if (field.getValue && field.setValue) {
      const currentValue = field.getValue();
      if (currentValue !== newValue) {
        field.setValue(newValue);
        updated = true;
      }
    }
  }
  
  return updated;
}

/**
 * 将 EXTRA_N 输入映射到块上实际存在的输入，并在需要时动态扩展块的输入数量。
 * 
 * ABS 解析时，超出块元数据已知输入的参数被标记为 EXTRA_0、EXTRA_1 等。
 * 此函数将它们映射到块上实际的未占用值输入（如 INPUT1、INPUT2）。
 * 如果块的输入不够，会通过 plus()、updateShape_() 等方式动态扩展。
 */
function remapAndExpandInputs(block: any, inputs: Record<string, any>): Record<string, any> {
  const extraInputs: Array<{ key: string; value: any; index: number }> = [];
  const normalInputs: Record<string, any> = {};

  for (const [key, value] of Object.entries(inputs)) {
    const extraMatch = key.match(/^EXTRA_(\d+)$/);
    if (extraMatch) {
      extraInputs.push({ key, value, index: parseInt(extraMatch[1], 10) });
    } else {
      const inputMatch = key.match(/^INPUT(\d+)$/);
      if (inputMatch && !block.getInput(key)) {
        extraInputs.push({ key, value, index: parseInt(inputMatch[1], 10) });
      } else {
        normalInputs[key] = value;
      }
    }
  }

  if (extraInputs.length === 0) return inputs;

  extraInputs.sort((a, b) => a.index - b.index);

  const configuredInputs = new Set(Object.keys(normalInputs));

  const getAvailable = () => {
    const list: string[] = [];
    for (const inp of block.inputList || []) {
      if (inp.name && inp.type === 1 && !configuredInputs.has(inp.name)) {
        list.push(inp.name);
      }
    }
    return list;
  };

  let availableInputs = getAvailable();

  // 动态扩展输入数量
  if (extraInputs.length > availableInputs.length) {
    const deficit = extraInputs.length - availableInputs.length;
    let expanded = false;

    if (block.plus && typeof block.plus === 'function') {
      for (let i = 0; i < deficit; i++) {
        try { block.plus(); } catch (e) { break; }
      }
      expanded = true;
    } else if (block.updateShape_ && typeof block.updateShape_ === 'function' && block.extraCount_ !== undefined) {
      const target = (block.extraCount_ || 0) + deficit;
      try { block.extraCount_ = target; block.updateShape_(target); expanded = true; } catch (e) { /* ignore */ }
    } else if (block.loadExtraState && typeof block.loadExtraState === 'function') {
      const totalNeeded = (block.extraCount_ || block.itemCount_ || 0) + deficit;
      const state = block.itemCount_ !== undefined ? { itemCount: totalNeeded } : { extraCount: totalNeeded };
      try { block.loadExtraState(state); expanded = true; } catch (e) { /* ignore */ }
    }

    if (expanded) {
      availableInputs = getAvailable();
      // console.log(`    🔧 动态扩展后可用输入: [${availableInputs.join(', ')}]`);
    }
  }

  const result = { ...normalInputs };
  for (let i = 0; i < extraInputs.length && i < availableInputs.length; i++) {
    result[availableInputs[i]] = extraInputs[i].value;
    // console.log(`    🔄 输入映射: ${extraInputs[i].key} → ${availableInputs[i]}`);
  }
  for (let i = availableInputs.length; i < extraInputs.length; i++) {
    result[extraInputs[i].key] = extraInputs[i].value;
    console.warn(`    ⚠️ 无法映射输入 ${extraInputs[i].key}，块上没有更多可用值输入`);
  }

  return result;
}

/**
 * 简化方案：保留根块，清空并重建所有子树
 * 
 * 策略：
 * 1. 保留根块本身（arduino_setup/loop/global）
 * 2. 更新根块的字段值
 * 3. 清空所有输入中的子块
 * 4. 根据新配置重建所有子块
 * 
 * 优点：简单稳定，避免 connectionDB 问题
 * 
 * @returns 包含失败块信息的对象
 */
async function rebuildBlockChildren(
  workspace: any,
  existingBlock: any,
  newConfig: any,
  variableNameToId: Map<string, string>,
  preprocessVariableReferences: (config: any, mapping: Map<string, string>) => void
): Promise<{ failedBlocks: Array<{ blockType: string; error: string }> }> {
  const failedBlocks: Array<{ blockType: string; error: string }> = [];
  // console.log(`    🔧 开始重建子树: ${existingBlock.type}`);
  
  // 1. 更新 extraState（如 custom_function_def 的 params/returnType）
  // 必须在更新字段和清空子块之前执行，以确保动态输入（如 RETURN、PARAM_TYPEn）已创建
  if (newConfig.extraState) {
    // console.log(`    🎛️ 更新 extraState: ${JSON.stringify(newConfig.extraState)}`);
    try {
      if (existingBlock.loadExtraState && typeof existingBlock.loadExtraState === 'function') {
        existingBlock.loadExtraState(newConfig.extraState);
        // console.log(`    ✅ loadExtraState 调用完成`);
      }
    } catch (e) {
      console.warn(`    ⚠️ 更新 extraState 失败:`, e);
    }
  }
  
  // 2. 更新根块的字段值（在 extraState 之后，确保动态字段已创建）
  if (newConfig.fields) {
    updateBlockFields(existingBlock, newConfig.fields, variableNameToId);
  }
  
  // 3. 收集所有需要删除的子块（先收集，后删除）
  const blocksToDelete: any[] = [];
  
  for (const input of existingBlock.inputList || []) {
    if (!input.connection) continue;
    const child = input.connection.targetBlock();
    if (child && !child.isShadow()) {
      // 收集整个子链
      let block = child;
      while (block) {
        blocksToDelete.push({ block, inputName: input.name });
        // 也收集子块的 next 链
        block = block.nextConnection?.targetBlock();
      }
    }
  }
  
  // 4. 禁用事件，清空所有子块
  if (blocksToDelete.length > 0) {
    // console.log(`    🗑️ 清空 ${blocksToDelete.length} 个子块`);
    Blockly.Events.disable();
    try {
      // 先断开所有输入连接
      for (const input of existingBlock.inputList || []) {
        if (input.connection?.isConnected()) {
          const child = input.connection.targetBlock();
          if (child && !child.isShadow()) {
            input.connection.disconnect();
          }
        }
      }
      
      // 删除所有收集的块（去重）
      const deletedIds = new Set<string>();
      for (const { block } of blocksToDelete) {
        if (!deletedIds.has(block.id) && !block.disposed) {
          block.dispose(false);
          deletedIds.add(block.id);
        }
      }
    } finally {
      Blockly.Events.enable();
    }
  }
  
  // 5. 根据新配置重建子块
  if (newConfig.inputs) {
    // 🆕 映射 EXTRA_N 输入到块上实际输入，并在需要时动态扩展
    const remappedInputs = remapAndExpandInputs(existingBlock, newConfig.inputs);
    
    for (const [inputName, inputValue] of Object.entries(remappedInputs) as [string, any][]) {
      const input = existingBlock.getInput(inputName);
      if (!input || !input.connection) {
        // console.log(`    ⚠️ 输入 ${inputName} 不存在`);
        continue;
      }
      
      const childConfig = inputValue.block || inputValue.shadow;
      if (!childConfig) continue;
      
      // console.log(`    ➕ 重建输入 ${inputName}: ${childConfig.type}`);
      
      // 预处理变量引用
      preprocessVariableReferences(childConfig, variableNameToId);
      
      try {
        const result = await createBlockFromConfig(workspace, childConfig);
        if (result.block) {
          const targetConnection = result.block.outputConnection || result.block.previousConnection;
          if (targetConnection) {
            input.connection.connect(targetConnection);
          }
        }
        // 收集嵌套块创建失败信息
        if (result.failedBlocks && result.failedBlocks.length > 0) {
          failedBlocks.push(...result.failedBlocks);
        }
      } catch (e) {
        console.warn(`    ⚠️ 重建子块失败: ${childConfig.type}`, e);
        failedBlocks.push({
          blockType: childConfig.type,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }
  
  // console.log(`    ✅ 子树重建完成: ${existingBlock.type}`);
  return { failedBlocks };
}

// =============================================================================
// 保护块类型定义
// =============================================================================

/**
 * 受保护的根块类型集合
 * 
 * 这些块在增量更新时不会被删除，只会清空/重建其内部子块：
 * - arduino_global: 全局代码块
 * - arduino_setup: setup() 函数块
 * - arduino_loop: loop() 函数块
 * 
 * 保护原因：
 * 1. 这些是 Arduino 项目的核心结构块，用户无法从工具箱手动添加
 * 2. 如果用户在 AI 加载过程中暂停，这些块消失后用户无法继续编程
 * 3. 保留这些块可以提供更好的用户体验和容错性
 */
const PROTECTED_ROOT_BLOCKS = new Set(['arduino_global', 'arduino_setup', 'arduino_loop']);

/**
 * 增量更新工作区（细粒度版本）
 * 
 * 策略（三阶段匹配）：
 * 1. 精确匹配：签名完全相同的块直接保留
 * 2. 类型匹配：同类型的块进行递归更新
 * 3. 清理/添加：删除无匹配的旧块，添加无匹配的新块
 * 
 * 🆕 保护机制：arduino_global、arduino_setup、arduino_loop 块不会被删除
 * 
 * 返回操作统计
 */
async function incrementalUpdate(
  workspace: any,
  newBlocks: any[],
  variableNameToId: Map<string, string>,
  preprocessVariableReferences: (config: any, mapping: Map<string, string>) => void
): Promise<{
  added: number;
  removed: number;
  unchanged: number;
  failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }>;
}> {
  const failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }> = [];
  
  // 获取当前工作区的根块
  const currentRootBlocks = getWorkspaceRootBlocks(workspace);
  // console.log(`\n${'='.repeat(60)}`);
  // console.log(`📊 增量更新开始`);
  // console.log(`${'='.repeat(60)}`);
  // console.log(`📋 当前工作区有 ${currentRootBlocks.length} 个根块:`);
  for (const item of currentRootBlocks) {
    // console.log(`   📦 ${item.serialized.type} (ID: ${item.block.id})`);
  }
  
  // 为新块计算签名并创建索引映射
  const newBlocksWithInfo = newBlocks.map((config, index) => ({
    config,
    index,
    signature: computeBlockChainSignature(config),
    type: config.type
  }));
  // console.log(`� 新 ABS 有 ${newBlocksWithInfo.length} 个根块:`);
  for (const item of newBlocksWithInfo) {
    // console.log(`   📄 ${item.type} (索引: ${item.index})`);
  }
  // console.log(`${'─'.repeat(60)}`);
  
  // 跟踪统计
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  let updatedCount = 0;
  
  // 已处理的块（避免重复处理）
  const processedExistingBlocks = new Set<string>();
  const processedNewBlocks = new Set<number>();
  
  // ============ 阶段 1：精确签名匹配 ============
  // 签名完全相同的块直接保留，无需任何操作
  // console.log(`🔍 阶段 1: 精确签名匹配`);
  
  // 输出签名对比信息
  // console.log(`  📝 签名对比:`);
  for (const currentItem of currentRootBlocks) {
    const matchingByType = newBlocksWithInfo.find(n => n.type === currentItem.serialized.type);
    if (matchingByType) {
      const sigMatch = currentItem.signature === matchingByType.signature;
      // console.log(`  ${sigMatch ? '✅' : '❌'} ${currentItem.serialized.type}:`);
      if (!sigMatch) {
        // 找出签名差异位置
        const currentSig = currentItem.signature;
        const newSig = matchingByType.signature;
        let diffPos = 0;
        for (let i = 0; i < Math.min(currentSig.length, newSig.length); i++) {
          if (currentSig[i] !== newSig[i]) {
            diffPos = i;
            break;
          }
        }
        // console.log(`     差异位置: ${diffPos}`);
        // console.log(`     当前 [${diffPos}-${diffPos+100}]: ...${currentSig.substring(diffPos, diffPos + 100)}...`);
        // console.log(`     新块 [${diffPos}-${diffPos+100}]: ...${newSig.substring(diffPos, diffPos + 100)}...`);
        
        // 🆕 详细输出第一个子块的字段对比，帮助调试
        const currentFirstChild = findFirstChildBlock(currentItem.serialized);
        const newFirstChild = findFirstChildBlock(matchingByType.config);
        if (currentFirstChild || newFirstChild) {
          // console.log(`     🔍 第一个子块字段对比:`);
          // console.log(`        工作区: type=${currentFirstChild?.type}, fields=${JSON.stringify(currentFirstChild?.fields)}`);
          // console.log(`        ABS文件: type=${newFirstChild?.type}, fields=${JSON.stringify(newFirstChild?.fields)}`);
        }
      }
    }
  }
  
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    
    // 查找签名完全匹配的新块
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.signature === currentItem.signature
    );
    
    if (matchingNewBlock) {
      // console.log(`  ✅ 精确匹配: ${currentItem.serialized.type} (${currentItem.block.id})`);
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      unchangedCount++;
    }
  }
  
  // 定义需要最后处理的块类型
  const loadLastTypes = new Set(['arduino_setup', 'arduino_loop']);
  
  // ============ 阶段 2：处理所有非 setup/loop 块 ============
  // 先重建/添加独立块（如 custom_function_def），确保其 mutator 先注册
  // console.log(`🔍 阶段 2: 处理非 setup/loop 块`);
  
  // 2a: 非 setup/loop 的类型匹配重建
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    const currentType = currentItem.serialized.type;
    if (loadLastTypes.has(currentType)) continue; // setup/loop 跳过，等阶段 3
    
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.type === currentType
    );
    
    if (matchingNewBlock) {
      // console.log(`  🔄 类型匹配，重建子树: ${currentType}`);
      try {
        const rebuildResult = await rebuildBlockChildren(
          workspace, currentItem.block, matchingNewBlock.config,
          variableNameToId, preprocessVariableReferences
        );
        if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
        // console.log(`    ✅ 子树重建成功: ${currentType}`);
      } catch (error) {
        console.warn(`子树重建失败: ${currentType}`, error);
        failedBlocks.push({ blockType: currentType, error: error instanceof Error ? error.message : String(error) });
      }
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      updatedCount++;
    }
  }
  
  // 2b: 添加所有未匹配的非 setup/loop 新块
  let yPosition = 30;
  const calcYPosition = () => {
    let y = 30;
    for (const block of workspace.getTopBlocks(false)) {
      const bounds = block.getBoundingRectangle();
      if (bounds) y = Math.max(y, bounds.bottom + 50);
    }
    return y;
  };
  yPosition = calcYPosition();
  
  const newNonSetupBlocks = newBlocksWithInfo.filter(
    item => !processedNewBlocks.has(item.index) && !loadLastTypes.has(item.type)
  );
  for (const newItem of newNonSetupBlocks) {
    const config = newItem.config;
    // console.log(`  ➕ 添加新块: ${config.type}`);
    const configWithPosition = { ...config, position: { x: 30, y: yPosition } };
    preprocessVariableReferences(configWithPosition, variableNameToId);
    try {
      const result = await createBlockFromConfig(workspace, configWithPosition);
      if (result.block) {
        addedCount++;
        const bounds = result.block.getBoundingRectangle();
        yPosition = bounds ? bounds.bottom + 50 : yPosition + 100;
      }
      if (result.failedBlocks?.length) failedBlocks.push(...result.failedBlocks);
      processedNewBlocks.add(newItem.index);
    } catch (error) {
      console.warn(`添加块失败: ${config.type}`, error);
      failedBlocks.push({ blockType: config.type, error: error instanceof Error ? error.message : String(error) });
    }
  }
  
  // ============ 阶段 3：处理 setup/loop 块 ============
  // 所有独立块已就绪，现在重建 setup/loop 子树
  // console.log(`🔍 阶段 3: 处理 setup/loop 块`);
  
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    const currentType = currentItem.serialized.type;
    if (!loadLastTypes.has(currentType)) continue;
    
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.type === currentType
    );
    
    if (matchingNewBlock) {
      // console.log(`  🔄 重建 ${currentType} 子树`);
      try {
        const rebuildResult = await rebuildBlockChildren(
          workspace, currentItem.block, matchingNewBlock.config,
          variableNameToId, preprocessVariableReferences
        );
        if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
        // console.log(`    ✅ ${currentType} 子树重建成功`);
      } catch (error) {
        console.warn(`子树重建失败: ${currentType}`, error);
        failedBlocks.push({ blockType: currentType, error: error instanceof Error ? error.message : String(error) });
      }
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      updatedCount++;
    }
  }
  
  // 输出匹配后的状态
  // console.log(`${'─'.repeat(60)}`);
  // console.log(`📊 匹配结果:`);
  // console.log(`   已匹配的工作区块: ${[...processedExistingBlocks].join(', ') || '无'}`);
  // console.log(`   已匹配的新块索引: ${[...processedNewBlocks].join(', ') || '无'}`);
  // console.log(`   未匹配的工作区块:`);
  for (const item of currentRootBlocks) {
    if (!processedExistingBlocks.has(item.block.id)) {
      // console.log(`      ⚠️ ${item.serialized.type} (ID: ${item.block.id})`);
    }
  }
  // console.log(`   未匹配的新块:`);
  for (const item of newBlocksWithInfo) {
    if (!processedNewBlocks.has(item.index)) {
      // console.log(`      ⚠️ ${item.type} (索引: ${item.index})`);
    }
  }
  // console.log(`${'─'.repeat(60)}`);
  
  // ============ 阶段 4：删除无匹配的旧块（保护关键块）============
  // console.log(`🔍 阶段 4: 清理无匹配的旧块（保留受保护块）`);
  
  for (const item of currentRootBlocks) {
    if (!processedExistingBlocks.has(item.block.id)) {
      const blockType = item.serialized.type;
      
      // 🆕 保护机制：对于受保护的根块，不删除块本身
      if (PROTECTED_ROOT_BLOCKS.has(blockType)) {
        // 查找 ABS 中是否有这个块类型的未处理配置
        const matchingNewConfig = newBlocksWithInfo.find(
          newItem => !processedNewBlocks.has(newItem.index) && newItem.type === blockType
        );
        
        if (matchingNewConfig) {
          // ABS 中有该块的配置，重建子块
          // console.log(`  🛡️ 保留受保护块: ${blockType} (ID: ${item.block.id})，使用 ABS 配置重建子块`);
          try {
            const rebuildResult = await rebuildBlockChildren(
              workspace, item.block, matchingNewConfig.config,
              variableNameToId, preprocessVariableReferences
            );
            if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
          } catch (error) {
            console.warn(`重建受保护块子块失败: ${blockType}`, error);
            failedBlocks.push({ blockType: blockType, error: error instanceof Error ? error.message : String(error) });
          }
          processedNewBlocks.add(matchingNewConfig.index);
        } else {
          // ABS 中没有该块的配置，只清空子块（保留空的主块）
          // console.log(`  🛡️ 保留受保护块: ${blockType} (ID: ${item.block.id})，清空其子块`);
          Blockly.Events.disable();
          try {
            // 清空受保护块的所有子块
            for (const input of item.block.inputList || []) {
              if (input.connection?.isConnected()) {
                const child = input.connection.targetBlock();
                if (child && !child.isShadow()) {
                  input.connection.disconnect();
                  child.dispose(true);
                }
              }
            }
          } catch (e) {
            console.warn(`清空受保护块子块失败: ${blockType}`, e);
          } finally {
            Blockly.Events.enable();
          }
        }
        // 标记为已处理，避免后续再次删除
        processedExistingBlocks.add(item.block.id);
        continue;
      }
      
      // console.log(`  🗑️ 删除无匹配块: ${blockType} (ID: ${item.block.id})`);
      Blockly.Events.disable();
      try {
        item.block.dispose(true);
        removedCount++;
      } catch (e) {
        console.warn(`删除块失败: ${blockType}`, e);
      } finally {
        Blockly.Events.enable();
      }
    }
  }
  
  // ============ 阶段 5：添加剩余未匹配的新块 ============
  const remainingNewItems = newBlocksWithInfo.filter(item => !processedNewBlocks.has(item.index));
  if (remainingNewItems.length > 0) {
    // console.log(`🔍 阶段 5: 添加剩余新块 (${remainingNewItems.length} 个)`);
    yPosition = calcYPosition();
    
    for (const newItem of remainingNewItems) {
      const config = newItem.config;
      // console.log(`  ➕ 添加新块: ${config.type}`);
      const configWithPosition = { ...config, position: { x: 30, y: yPosition } };
      preprocessVariableReferences(configWithPosition, variableNameToId);
      try {
        const result = await createBlockFromConfig(workspace, configWithPosition);
        if (result.block) {
          addedCount++;
          const bounds = result.block.getBoundingRectangle();
          yPosition = bounds ? bounds.bottom + 50 : yPosition + 100;
        }
        if (result.failedBlocks?.length) failedBlocks.push(...result.failedBlocks);
      } catch (error) {
        console.warn(`添加块失败: ${config.type}`, error);
        failedBlocks.push({ blockType: config.type, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  
  // console.log(`📊 增量更新完成: 精确匹配 ${unchangedCount}, 递归更新 ${updatedCount}, 删除 ${removedCount}, 添加 ${addedCount}`);
  
  // ============ 阶段 6：最终清理 - 删除所有不在 ABS 中的残留根块 ============
  // 处理创建失败残留的孤立块：获取当前所有根块，与 ABS 定义的块类型/数量进行对比
  // console.log(`🔍 阶段 6: 最终清理残留块`);
  
  // 统计 ABS 中每种块类型的数量
  const expectedBlockCounts = new Map<string, number>();
  for (const newBlock of newBlocks) {
    expectedBlockCounts.set(newBlock.type, (expectedBlockCounts.get(newBlock.type) || 0) + 1);
  }
  
  // 获取当前工作区所有根块并按类型分组
  const currentTopBlocks = workspace.getTopBlocks(false);
  const currentBlocksByType = new Map<string, any[]>();
  for (const block of currentTopBlocks) {
    const type = block.type;
    if (!currentBlocksByType.has(type)) {
      currentBlocksByType.set(type, []);
    }
    currentBlocksByType.get(type)!.push(block);
  }
  
  // 删除多余的块（类型不在 ABS 中，或者数量超出预期）
  // 🆕 但保留受保护的根块类型
  let cleanupCount = 0;
  for (const [type, blocks] of currentBlocksByType) {
    const expectedCount = expectedBlockCounts.get(type) || 0;
    
    // 🆕 保护机制：受保护的根块类型不删除
    if (PROTECTED_ROOT_BLOCKS.has(type)) {
      // console.log(`  🛡️ 跳过受保护块类型: ${type} (${blocks.length} 个)`);
      continue;
    }
    
    if (expectedCount === 0) {
      // 该类型完全不在 ABS 中，全部删除
      // console.log(`  🗑️ 删除不在 ABS 中的块类型: ${type} (${blocks.length} 个)`);
      for (const block of blocks) {
        Blockly.Events.disable();
        try {
          block.dispose(true);
          cleanupCount++;
        } catch (e) {
          console.warn(`清理块失败: ${type}`, e);
        } finally {
          Blockly.Events.enable();
        }
      }
    } else if (blocks.length > expectedCount) {
      // 数量超出预期，删除多余的（保留前 expectedCount 个）
      const toDelete = blocks.slice(expectedCount);
      // console.log(`  🗑️ 删除多余的 ${type} 块 (${toDelete.length} 个，保留 ${expectedCount} 个)`);
      for (const block of toDelete) {
        Blockly.Events.disable();
        try {
          block.dispose(true);
          cleanupCount++;
        } catch (e) {
          console.warn(`清理块失败: ${type}`, e);
        } finally {
          Blockly.Events.enable();
        }
      }
    }
  }
  
  if (cleanupCount > 0) {
    // console.log(`  ✅ 清理了 ${cleanupCount} 个残留块`);
    removedCount += cleanupCount;
  }
  
  // 强制重新渲染工作区，确保视觉状态正确
  try {
    // 方法1: 重新渲染所有块
    if (workspace.render) {
      workspace.render();
    }
    // 方法2: 重新计算连接
    if (workspace.getAllBlocks) {
      const allBlocks = workspace.getAllBlocks(false);
      for (const block of allBlocks) {
        if (block.render) {
          block.render();
        }
      }
    }
    // console.log(`🎨 工作区渲染刷新完成`);
  } catch (e) {
    console.warn(`渲染刷新失败:`, e);
  }
  
  return {
    added: addedCount,
    removed: removedCount,
    unchanged: unchangedCount + updatedCount, // 更新也算作"保留"
    failedBlocks
  };
}
