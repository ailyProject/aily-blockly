import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";

// 路径处理函数
function normalizePath(inputPath: string): string {
    if (!inputPath) return '';
    
    let normalizedPath = inputPath;
    
    if (typeof inputPath === 'string') {
        const isWindowsPath = /^[A-Za-z]:\\/.test(inputPath);
        
        if (isWindowsPath) {
            normalizedPath = inputPath
                .replace(/\\\\/g, '\\')
                .replace(/\//g, '\\');
        } else {
            normalizedPath = inputPath
                .replace(/\\\\/g, '/')
                .replace(/\\/g, '/')
                .replace(/\/+/g, '/');
        }
        
        if (normalizedPath.length > 1 && (normalizedPath.endsWith('/') || normalizedPath.endsWith('\\'))) {
            normalizedPath = normalizedPath.slice(0, -1);
        }
    }
    
    return normalizedPath;
}

/**
 * 创建文件夹工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function createFolderTool(
    params: {
        path: string;
        recursive?: boolean;
    }
): Promise<ToolUseResult> {
    try {
        let { path: folderPath, recursive = true } = params;
        
        // 路径规范化
        folderPath = normalizePath(folderPath);
        
        // console.log("创建文件夹: ", folderPath);

        // 验证路径是否有效
        if (!folderPath || folderPath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的文件夹路径: "${folderPath}"` 
            };
            return injectTodoReminder(toolResult, 'createFolderTool');
        }

        // 检查路径是否已存在
        if (window['fs'].existsSync(folderPath)) {
            const isDirectory = await window['fs'].isDirectory(folderPath);
            if (isDirectory) {
                const toolResult = {
                    is_error: false,
                    content: `文件夹已存在: ${folderPath}`
                };
                return injectTodoReminder(toolResult, 'createFolderTool');
            } else {
                const toolResult = {
                    is_error: true,
                    content: `路径已存在但不是文件夹: ${folderPath}`
                };
                return injectTodoReminder(toolResult, 'createFolderTool');
            }
        }

        await window['fs'].mkdirSync(folderPath, { recursive });
        
        const toolResult = { 
            is_error: false, 
            content: `文件夹创建成功: ${folderPath}` 
        };
        return injectTodoReminder(toolResult, 'createFolderTool');
    } catch (error: any) {
        console.warn("创建文件夹失败:", error);
        
        let errorMessage = `创建文件夹失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标路径: ${params.path}` 
        };
        return injectTodoReminder(toolResult, 'createFolderTool');
    }
}
