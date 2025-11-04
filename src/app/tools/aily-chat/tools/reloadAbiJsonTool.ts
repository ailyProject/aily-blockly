import { Injectable } from '@angular/core';
import { ProjectService } from '../../../services/project.service';
import { ToolUseResult } from "./tools";
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';

export interface ReloadAbiJsonArgs {
  projectPath?: string;
  jsonData?: any;
}

export interface ReloadAbiJsonResult {
  content: string;
  is_error: boolean;
  metadata?: {
    projectPath: string;
    dataSource: string;
    blockCount?: number;
  };
}

@Injectable({
  providedIn: 'root'
})
export class ReloadAbiJsonToolService {
  constructor(
    private blocklyService: BlocklyService,
    private projectService: ProjectService
  ) {}

  async executeReloadAbiJson(args: ReloadAbiJsonArgs): Promise<ReloadAbiJsonResult> {
    try {
      let { projectPath, jsonData } = args;
      let dataSource = '';
      let actualProjectPath = '';

      // 优先级1: 如果提供了 projectPath，从文件加载
      if (projectPath) {
        actualProjectPath = projectPath;
        const abiFilePath = `${projectPath}/project.abi`;
        
        // 检查文件是否存在
        if (!window['fs'].existsSync(abiFilePath)) {
          return {
            content: `project.abi 文件不存在: ${abiFilePath}`,
            is_error: true
          };
        }

        try {
          const fileContent = window['fs'].readFileSync(abiFilePath, 'utf-8');
          jsonData = JSON.parse(fileContent);
          dataSource = 'file';
        } catch (error: any) {
          return {
            content: `读取或解析 project.abi 文件失败: ${error.message}`,
            is_error: true
          };
        }
      }
      // 优先级2: 如果提供了 jsonData，直接使用
      else if (jsonData) {
        dataSource = 'parameter';
        actualProjectPath = this.projectService.currentProjectPath || '未知';
      }
      // 优先级3: 都没有提供，尝试从当前环境路径加载
      else {
        projectPath = this.projectService.currentProjectPath;
        if (!projectPath) {
          return {
            content: '未找到当前项目路径，请提供 projectPath 参数或 jsonData 参数',
            is_error: true
          };
        }
        
        actualProjectPath = projectPath;
        const abiFilePath = `${projectPath}/project.abi`;
        
        // 检查文件是否存在
        if (!window['fs'].existsSync(abiFilePath)) {
          return {
            content: `project.abi 文件不存在: ${abiFilePath}`,
            is_error: true
          };
        }

        try {
          const fileContent = window['fs'].readFileSync(abiFilePath, 'utf-8');
          jsonData = JSON.parse(fileContent);
          dataSource = 'file';
        } catch (error: any) {
          return {
            content: `读取或解析 project.abi 文件失败: ${error.message}`,
            is_error: true
          };
        }
      }

      // 验证 jsonData 是否有效
      if (!jsonData || typeof jsonData !== 'object') {
        return {
          content: '无效的 JSON 数据格式',
          is_error: true
        };
      }

      // 使用 BlocklyService 加载 ABI JSON 数据
      this.blocklyService.loadAbiJson(jsonData);
      
      // 计算加载的块数量（如果数据中包含块信息）
      let blockCount = 0;
      if (jsonData.blocks && Array.isArray(jsonData.blocks)) {
        blockCount = jsonData.blocks.length;
      }

      return {
        content: `成功重新加载 project.abi 数据${blockCount > 0 ? `，包含 ${blockCount} 个块` : ''}`,
        is_error: false,
        metadata: {
          projectPath: actualProjectPath,
          dataSource: dataSource,
          blockCount: blockCount > 0 ? blockCount : undefined
        }
      };

    } catch (error: any) {
      console.warn('重新加载 ABI JSON 数据失败:', error);
      
      let errorMessage = '重新加载 ABI JSON 数据失败';
      if (error.message) {
        errorMessage += `: ${error.message}`;
      }

      return {
        content: errorMessage,
        is_error: true
      };
    }
  }
}

/**
 * 重新加载 project.abi 数据工具
 * @param reloadAbiJsonService ReloadAbiJsonToolService 实例
 * @param args 参数
 * @returns 工具执行结果
 */
export async function reloadAbiJsonTool(
  reloadAbiJsonService: ReloadAbiJsonToolService, 
  args: ReloadAbiJsonArgs
): Promise<ToolUseResult> {
  const result = await reloadAbiJsonService.executeReloadAbiJson(args);
  return {
    content: result.content,
    is_error: result.is_error
  };
}

/**
 * 重新加载 project.abi 数据的简化函数（用于直接调用）
 * @param params 参数
 * @returns 工具执行结果
 */
export async function reloadAbiJsonToolSimple(
  params: {
    projectPath?: string;
    jsonData?: any;
  }
): Promise<ToolUseResult> {
  try {
    // 获取必要的服务实例
    // 注意：在实际使用中，这些服务应该通过依赖注入获取
    const blocklyService = (window as any).blocklyService;
    const projectService = (window as any).projectService;
    
    if (!blocklyService) {
      return {
        content: 'BlocklyService 未找到，请确保应用已正确初始化',
        is_error: true
      };
    }

    let { projectPath, jsonData } = params;
    
    // 优先级1: 如果提供了 projectPath，从文件加载
    if (projectPath) {
      const abiFilePath = `${projectPath}/project.abi`;
      
      // 检查文件是否存在
      if (!window['fs'].existsSync(abiFilePath)) {
        return {
          content: `project.abi 文件不存在: ${abiFilePath}`,
          is_error: true
        };
      }

      try {
        const fileContent = window['fs'].readFileSync(abiFilePath, 'utf-8');
        jsonData = JSON.parse(fileContent);
      } catch (error: any) {
        return {
          content: `读取或解析 project.abi 文件失败: ${error.message}`,
          is_error: true
        };
      }
    }
    // 优先级2: 如果提供了 jsonData，直接使用
    else if (jsonData) {
      // jsonData 已存在，直接使用
    }
    // 优先级3: 都没有提供，尝试从当前环境路径加载
    else {
      projectPath = projectService?.currentProjectPath;
      if (!projectPath) {
        return {
          content: '未找到当前项目路径，请提供 projectPath 参数或 jsonData 参数',
          is_error: true
        };
      }
      
      const abiFilePath = `${projectPath}/project.abi`;
      
      // 检查文件是否存在
      if (!window['fs'].existsSync(abiFilePath)) {
        return {
          content: `project.abi 文件不存在: ${abiFilePath}`,
          is_error: true
        };
      }

      try {
        const fileContent = window['fs'].readFileSync(abiFilePath, 'utf-8');
        jsonData = JSON.parse(fileContent);
      } catch (error: any) {
        return {
          content: `读取或解析 project.abi 文件失败: ${error.message}`,
          is_error: true
        };
      }
    }

    // 验证 jsonData 是否有效
    if (!jsonData || typeof jsonData !== 'object') {
      return {
        content: '无效的 JSON 数据格式',
        is_error: true
      };
    }

    // 使用 BlocklyService 加载 ABI JSON 数据
    blocklyService.loadAbiJson(jsonData);
    
    // 计算加载的块数量（如果数据中包含块信息）
    let blockCount = 0;
    if (jsonData.blocks && Array.isArray(jsonData.blocks)) {
      blockCount = jsonData.blocks.length;
    }

    return {
      content: `成功重新加载 project.abi 数据${blockCount > 0 ? `，包含 ${blockCount} 个块` : ''}`,
      is_error: false
    };

  } catch (error: any) {
    console.warn('重新加载 ABI JSON 数据失败:', error);
    
    return {
      content: `重新加载 ABI JSON 数据失败: ${error.message || error}`,
      is_error: true
    };
  }
}

/**
 * 重新加载 project.abi 数据工具（用于直接函数调用的简化版本）
 */
export async function reloadAbiJsonToolDirect(
  params: {
    projectPath?: string;
    jsonData?: any;
  }
): Promise<ToolUseResult> {
  return reloadAbiJsonToolSimple(params);
}