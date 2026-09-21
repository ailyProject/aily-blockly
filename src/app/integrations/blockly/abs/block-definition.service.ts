/**
 * 块定义服务 - 动态从项目安装的库中加载块定义
 * 
 * 这个服务负责：
 * 1. 扫描项目 node_modules/@aily-project/lib-* 目录
 * 2. 读取每个库的 block.json 文件
 * 3. 解析块定义，提取字段、输入、输出等元信息
 * 4. 为 DSL 解析器和转换器提供块元数据
 */

import { Injectable } from '@angular/core';
import { ProjectService } from '@domain/project/public-api';

// =============================================================================
// 类型定义
// =============================================================================

export type { BlockArgDefinition, BlockMeta } from './block-definition.model';
import { BlockMeta, parseBlockDefinition } from './block-definition.model';

/**
 * 块定义缓存
 */
export interface BlockDefinitionCache {
  projectPath: string;
  blocks: Map<string, BlockMeta>;
  loadedAt: number;
}

// =============================================================================
// 服务实现
// =============================================================================

@Injectable({
  providedIn: 'root'
})
export class BlockDefinitionService {
  
  /** 块定义缓存 */
  private cache: BlockDefinitionCache | null = null;
  
  /** 缓存有效期（毫秒） */
  private readonly CACHE_TTL = 5 * 60 * 1000;  // 5 分钟
  
  constructor(private readonly projectService: ProjectService) {}
  
  // ===========================================================================
  // 公共 API
  // ===========================================================================
  
  /**
   * 获取所有已加载的块定义
   */
  async getAllBlockMetas(): Promise<Map<string, BlockMeta>> {
    await this.ensureLoaded();
    return this.cache?.blocks || new Map();
  }
  
  /**
   * 获取指定块类型的元信息
   */
  async getBlockMeta(blockType: string): Promise<BlockMeta | undefined> {
    await this.ensureLoaded();
    return this.cache?.blocks.get(blockType);
  }
  
  /**
   * 检查块类型是否存在
   */
  async hasBlock(blockType: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.cache?.blocks.has(blockType) || false;
  }
  
  /**
   * 强制重新加载块定义
   */
  async reload(): Promise<void> {
    this.cache = null;
    await this.ensureLoaded();
  }
  
  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache = null;
  }
  
  /**
   * 获取用于 DSL 解析器的 KNOWN_BLOCKS 格式
   */
  async getKnownBlocksFormat(): Promise<Record<string, Partial<{
    fieldNames: string[];
    valueInputNames: string[];
    statementInputNames: string[];
    hasStatementInput: boolean;
    isRootBlock: boolean;
    isValueBlock: boolean;
  }>>> {
    const metas = await this.getAllBlockMetas();
    const result: Record<string, any> = {};
    
    for (const [type, meta] of metas) {
      result[type] = {
        fieldNames: meta.fieldNames.length > 0 ? meta.fieldNames : undefined,
        valueInputNames: meta.valueInputNames.length > 0 ? meta.valueInputNames : undefined,
        statementInputNames: meta.statementInputNames.length > 0 ? meta.statementInputNames : undefined,
        hasStatementInput: meta.statementInputNames.length > 0 ? true : undefined,
        isRootBlock: meta.isRootBlock ? true : undefined,
        isValueBlock: meta.hasOutput && meta.fieldNames.length === 0 && meta.valueInputNames.length === 0 ? true : undefined,
      };
      
      // 移除 undefined 值
      Object.keys(result[type]).forEach(key => {
        if (result[type][key] === undefined) {
          delete result[type][key];
        }
      });
    }
    
    return result;
  }
  
  // ===========================================================================
  // 内部方法
  // ===========================================================================
  
  /**
   * 确保块定义已加载
   */
  private async ensureLoaded(): Promise<void> {
    const projectPath = this.projectService.currentProjectPath;
    
    if (!projectPath) {
      console.warn('[BlockDefinitionService] 无项目路径，无法加载块定义');
      return;
    }
    
    // 检查缓存是否有效
    if (this.cache && 
        this.cache.projectPath === projectPath &&
        Date.now() - this.cache.loadedAt < this.CACHE_TTL) {
      return;
    }
    
    // 重新加载
    await this.loadBlockDefinitions(projectPath);
  }
  
  /**
   * 加载项目的所有块定义
   */
  private async loadBlockDefinitions(projectPath: string): Promise<void> {
    const blocks = new Map<string, BlockMeta>();
    
    try {
      const libsPath = window['path'].join(projectPath, 'node_modules', '@aily-project');
      
      if (!window['fs'].existsSync(libsPath)) {
        console.warn('[BlockDefinitionService] 库目录不存在:', libsPath);
        this.cache = { projectPath, blocks, loadedAt: Date.now() };
        return;
      }
      
      // 读取所有 lib-* 目录
      const entries = window['fs'].readdirSync(libsPath);
      const libDirs = entries.filter((name: string) => name.startsWith('lib-'));
      
      console.log(`[BlockDefinitionService] 发现 ${libDirs.length} 个库`);
      
      for (const libDir of libDirs) {
        const libPath = window['path'].join(libsPath, libDir);
        const blockJsonPath = window['path'].join(libPath, 'block.json');
        
        if (window['fs'].existsSync(blockJsonPath)) {
          try {
            const content = window['fs'].readFileSync(blockJsonPath, 'utf8');
            const blockDefs = JSON.parse(content);
            
            if (Array.isArray(blockDefs)) {
              for (const blockDef of blockDefs) {
                const meta = parseBlockDefinition(blockDef, libDir);
                if (meta) {
                  blocks.set(meta.type, meta);
                }
              }
            }
          } catch (e) {
            console.warn(`[BlockDefinitionService] 解析 ${libDir}/block.json 失败:`, e);
          }
        }
      }
      
      console.log(`[BlockDefinitionService] 已加载 ${blocks.size} 个块定义`);
      
    } catch (error) {
      console.error('[BlockDefinitionService] 加载块定义失败:', error);
    }
    
    this.cache = { projectPath, blocks, loadedAt: Date.now() };
  }
  

}

// =============================================================================
// 工具函数（供 DSL 模块使用）
// =============================================================================

/**
 * 同步获取块元数据（用于非异步上下文）
 * 注意：这需要先调用 loadBlockDefinitionsSync
 */
let globalBlockMetas: Map<string, BlockMeta> | null = null;

export function setGlobalBlockMetas(metas: Map<string, BlockMeta>): void {
  globalBlockMetas = metas;
}

export function getGlobalBlockMetas(): Map<string, BlockMeta> | null {
  return globalBlockMetas;
}

export function getBlockMetaSync(blockType: string): BlockMeta | undefined {
  return globalBlockMetas?.get(blockType);
}

/**
 * 从文件系统同步加载块定义（用于非 Angular 上下文）
 */
export function loadBlockDefinitionsFromPath(
  projectPath: string,
  electronAPI: any
): Map<string, BlockMeta> {
  const blocks = new Map<string, BlockMeta>();
  
  try {
    const libsPath = electronAPI.path.join(projectPath, 'node_modules', '@aily-project');
    
    if (!electronAPI.fs.existsSync(libsPath)) {
      console.warn('[loadBlockDefinitionsFromPath] 库目录不存在:', libsPath);
      return blocks;
    }
    
    const entries = electronAPI.fs.readdirSync(libsPath);
    const libDirs = entries.filter((name: string) => name.startsWith('lib-'));
    
    for (const libDir of libDirs) {
      const blockJsonPath = electronAPI.path.join(libsPath, libDir, 'block.json');
      
      if (electronAPI.fs.existsSync(blockJsonPath)) {
        try {
          const content = electronAPI.fs.readFileSync(blockJsonPath, 'utf8');
          const blockDefs = JSON.parse(content);
          
          if (Array.isArray(blockDefs)) {
            for (const blockDef of blockDefs) {
              const meta = parseBlockDefinition(blockDef, libDir);
              if (meta) {
                blocks.set(meta.type, meta);
              }
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  } catch (error) {
    console.error('[loadBlockDefinitionsFromPath] 加载失败:', error);
  }
  
  return blocks;
}
