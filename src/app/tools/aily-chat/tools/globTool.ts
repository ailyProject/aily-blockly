import { ToolUseResult } from "./tools";

/**
 * glob 模式匹配输出结果
 */
interface GlobOutput {
    durationMs: number;
    numFiles: number;
    filenames: string[];
    truncated: boolean;
}

/**
 * 检查 glob 是否可用
 */
let globAvailable: boolean | null = null;
async function checkGlobAvailable(): Promise<boolean> {
    if (globAvailable !== null) {
        return globAvailable;
    }
    
    try {
        const electronAPI = (window as any).electronAPI;
        if (electronAPI?.glob && typeof electronAPI.glob.sync === 'function') {
            globAvailable = true;
            console.log('Glob 可用性检测:', globAvailable);
            return globAvailable;
        }
    } catch (error) {
        console.warn('检测 glob 失败:', error);
    }
    
    globAvailable = false;
    return false;
}

/**
 * 使用 glob 进行文件模式匹配（优先使用异步版本，不阻塞 UI）
 */
async function searchWithGlob(
    pattern: string,
    searchPath?: string,
    limit: number = 100
): Promise<GlobOutput | null> {
    try {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.glob) {
            return null;
        }
        
        const startTime = Date.now();
        
        // 构建 glob 选项
        const options: any = {};
        if (searchPath) {
            options.cwd = searchPath;
        }
        options.absolute = true;
        options.nodir = true;
        
        // 优先使用异步 glob 避免阻塞 UI
        let files: string[];
        if (typeof electronAPI.glob.async === 'function') {
            files = await electronAPI.glob.async(pattern, options);
        } else if (typeof electronAPI.glob.sync === 'function') {
            files = await electronAPI.glob.sync(pattern, options);
        } else {
            return null;
        }
        const durationMs = Date.now() - startTime;
        
        const truncated = files.length > limit;
        const limitedFiles = files.slice(0, limit);
        
        return {
            durationMs,
            numFiles: limitedFiles.length,
            filenames: limitedFiles,
            truncated
        };
        
    } catch (error) {
        console.warn('[Glob] 搜索失败:', error);
        return null;
    }
}

/**
 * 格式化文件路径用于显示
 */
function formatPathForDisplay(filePath: string, basePath?: string): string {
    if (!basePath) {
        return filePath;
    }
    
    // 尝试获取相对路径
    if (filePath.startsWith(basePath)) {
        const relativePath = filePath.substring(basePath.length);
        return relativePath.startsWith('/') || relativePath.startsWith('\\') 
            ? relativePath.substring(1) 
            : relativePath;
    }
    
    return filePath;
}

/**
 * 主要的 glob 工具函数
 * @param params 工具参数
 * @returns 工具使用结果
 */
export default async function globTool(params: {
    pattern: string;
    path?: string;
    limit?: number;
}): Promise<ToolUseResult> {
    const { pattern, path, limit = 100 } = params;
    
    // 验证输入参数
    if (!pattern || typeof pattern !== 'string') {
        const toolResult = {
            is_error: true,
            content: '错误: pattern 参数是必需的且必须是字符串'
        };
        return toolResult;
    }
    
    try {
        // 检查 glob 是否可用
        const isGlobAvailable = await checkGlobAvailable();
        if (!isGlobAvailable) {
            const toolResult = {
                is_error: true,
                content: '错误: Glob 功能不可用。请确保应用正确配置了 electron API。'
            };
            return toolResult;
        }
        
        // 执行搜索
        let result = await searchWithGlob(pattern, path, limit);
        
        if (!result) {
            const toolResult = {
                is_error: true,
                content: '搜索失败: 无法执行 glob 搜索操作'
            };
            return toolResult;
        }
        
        // 格式化结果
        const { durationMs, numFiles, filenames, truncated } = result;
        
        if (numFiles === 0) {
            const toolResult = {
                is_error: false,
                content: '未找到匹配的文件',
                metadata: {
                    durationMs,
                    numFiles: 0,
                    pattern,
                    path: path || '当前目录'
                }
            };
            return toolResult;
        }
        
        // 格式化文件列表
        const formattedFiles = filenames.map(file => formatPathForDisplay(file, path));
        let content = formattedFiles.join('\n');
        
        // 如果结果被截断，添加说明
        if (truncated) {
            content += `\n\n(结果已截断，显示前 ${limit} 个匹配项。考虑使用更具体的模式来缩小搜索范围。)`;
        }
        
        const toolResult = {
            is_error: false,
            content,
            metadata: {
                durationMs,
                numFiles,
                pattern,
                path: path || '当前目录',
                truncated,
                filenames: formattedFiles
            }
        };
        
        return toolResult;
    } catch (error) {
        console.warn('[Glob Tool] 执行错误:', error);
        const toolResult = {
            is_error: true,
            content: `执行错误: ${error instanceof Error ? error.message : String(error)}`
        };
        return toolResult;
    }
}
