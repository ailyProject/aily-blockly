import { LibraryBlockKnowledge } from '../blockAnalyzer';

interface CacheEntry {
  data: LibraryBlockKnowledge;
  lastUpdated: number;
  filePaths: string[];
}

interface CacheFileInfo {
  path: string;
  lastModified: number;
  size: number;
}

/**
 * 模板缓存服务 - 管理块分析结果的缓存以提高性能
 */
export class TemplateCacheService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_EXPIRY = 5 * 60 * 1000; // 5分钟缓存过期
  private readonly MAX_CACHE_SIZE = 50; // 最大缓存条目数

  /**
   * 获取缓存的库分析结果
   */
  async getCachedAnalysis(libraryPath: string): Promise<LibraryBlockKnowledge | null> {
    const entry = this.cache.get(libraryPath);
    if (!entry) {
      return null;
    }

    // 检查缓存是否过期
    if (Date.now() - entry.lastUpdated > this.CACHE_EXPIRY) {
      this.cache.delete(libraryPath);
      return null;
    }

    // 检查文件是否被修改
    if (await this.hasLibraryChanged(entry.filePaths)) {
      this.cache.delete(libraryPath);
      return null;
    }

    return entry.data;
  }

  /**
   * 缓存库分析结果
   */
  setCachedAnalysis(libraryPath: string, data: LibraryBlockKnowledge, filePaths: string[]): void {
    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(libraryPath, {
      data,
      lastUpdated: Date.now(),
      filePaths
    });
  }

  /**
   * 清除指定库的缓存
   */
  clearCache(libraryPath?: string): void {
    if (libraryPath) {
      this.cache.delete(libraryPath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * 检查库文件是否已更改
   */
  private async hasLibraryChanged(filePaths: string[]): Promise<boolean> {
    try {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.fs) {
        return true; // 如果无法检查，假设已更改
      }

      for (const filePath of filePaths) {
        try {
          const stats = await electronAPI.fs.stat(filePath);
          // 这里可以添加更复杂的检查逻辑，比如比较文件修改时间
          // 目前简单地假设如果文件仍然存在就没有更改
        } catch (error) {
          // 文件不存在，认为已更改
          return true;
        }
      }

      return false;
    } catch (error) {
      console.warn('检查文件更改失败:', error);
      return true;
    }
  }

  /**
   * 预热缓存 - 为常用库预先加载分析结果
   */
  async preloadCommonLibraries(libraryPaths: string[]): Promise<void> {
    const { BlockAnalyzer } = await import('../blockAnalyzer');

    for (const libraryPath of libraryPaths) {
      try {
        if (!this.cache.has(libraryPath)) {
          console.log(`预加载库分析: ${libraryPath}`);
          const analysis = await BlockAnalyzer.analyzeLibraryBlocks(libraryPath);
          const filePaths = await this.getLibraryFilePaths(libraryPath);
          this.setCachedAnalysis(libraryPath, analysis, filePaths);
        }
      } catch (error) {
        console.warn(`预加载库失败: ${libraryPath}`, error);
      }
    }
  }

  /**
   * 获取库的所有相关文件路径
   */
  private async getLibraryFilePaths(libraryPath: string): Promise<string[]> {
    const paths: string[] = [];
    const basePath = libraryPath.replace(/\\/g, '/');
    
    // 添加可能的文件路径
    paths.push(
      `${basePath}/block.json`,
      `${basePath}/generator.js`,
      `${basePath}/toolbox.json`
    );

    return paths;
  }
}

// 导出单例实例
export const templateCacheService = new TemplateCacheService();