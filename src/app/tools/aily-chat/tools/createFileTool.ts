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
 * 创建文件工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function createFileTool(
    params: {
        path: string;
        content?: string;
        encoding?: string;
        overwrite?: boolean;
    }
): Promise<ToolUseResult> {
    try {
        let { path: filePath, content = '', encoding = 'utf-8', overwrite = true } = params;
        
        // 路径规范化
        filePath = normalizePath(filePath);
        
        // console.log("创建文件: ", filePath);

        // 验证路径是否有效
        if (!filePath || filePath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的文件路径: "${filePath}"` 
            };
            return injectTodoReminder(toolResult, 'createFileTool');
        }

        // 检查文件是否已存在
        if (window['fs'].existsSync(filePath) && !overwrite) {
            const toolResult = {
                is_error: true,
                content: `文件已存在: ${filePath}。如需覆盖，请设置 overwrite 参数为 true。`
            };
            return injectTodoReminder(toolResult, 'createFileTool');
        }

        const dir = window['path'].dirname(filePath);
        // console.log(`文件目录: ${dir}`);
        
        // 确保目录存在
        if (!window['fs'].existsSync(dir)) {
            // console.log(`创建目录: ${dir}`);
            await window['fs'].mkdirSync(dir, { recursive: true });
        }
        
        // 写入文件
        // console.log(`写入文件内容，长度: ${content.length}`);
        await window['fs'].writeFileSync(filePath, content, encoding);
        
        const toolResult = { 
            is_error: false, 
            content: `文件创建成功: ${filePath}` 
        };
        return injectTodoReminder(toolResult, 'createFileTool');
    } catch (error: any) {
        console.warn("创建文件失败:", error);
        
        let errorMessage = `创建文件失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标文件: ${params.path}` 
        };
        return injectTodoReminder(toolResult, 'createFileTool');
    }
}
