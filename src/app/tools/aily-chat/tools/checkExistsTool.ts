import { ToolUseResult } from "./tools";
import { normalizePath } from "../services/security.service";

/**
 * 检查文件或文件夹是否存在工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function checkExistsTool(
    params: {
        path: string;
        type?: 'file' | 'folder' | 'any';
    }
): Promise<ToolUseResult> {
    try {
        let { path: targetPath, type = 'any' } = params;
        
        // 路径规范化
        targetPath = normalizePath(targetPath);
        
        // console.log("检查路径是否存在: ", targetPath);

        // 验证路径是否有效
        if (!targetPath || targetPath.trim() === '') {
            return { 
                is_error: true, 
                content: `无效的路径: "${targetPath}"` 
            };
        }

        const exists = window['fs'].existsSync(targetPath);
        
        if (!exists) {
            return {
                is_error: false,
                content: JSON.stringify({
                    exists: false,
                    path: targetPath,
                    message: "路径不存在"
                }, null, 2)
            };
        }

        // 检查类型
        const isDirectory = await window['fs'].isDirectory(targetPath);
        const actualType = isDirectory ? 'folder' : 'file';
        
        // 如果指定了类型，检查是否匹配
        if (type !== 'any' && type !== actualType) {
            return {
                is_error: false,
                content: JSON.stringify({
                    exists: false,
                    path: targetPath,
                    expectedType: type,
                    actualType: actualType,
                    message: `路径存在但类型不匹配，期望: ${type}，实际: ${actualType}`
                }, null, 2)
            };
        }

        // 获取文件/文件夹详细信息
        const stats = await window['fs'].statSync(targetPath);
        
        return {
            is_error: false,
            content: JSON.stringify({
                exists: true,
                path: targetPath,
                type: actualType,
                size: stats.size,
                modifiedTime: stats.mtime,
                createdTime: stats.birthtime,
                message: `${actualType === 'folder' ? '文件夹' : '文件'}存在`
            }, null, 2)
        };
    } catch (error: any) {
        console.warn("检查路径存在性失败:", error);
        
        let errorMessage = `检查路径存在性失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        return { 
            is_error: true, 
            content: errorMessage + `\n目标路径: ${params.path}` 
        };
    }
}
