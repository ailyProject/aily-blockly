import { ToolUseResult } from "./tools";
import { normalizePath } from "../services/security.service";
import { AilyHost } from '../core/host';
import { exists as asyncExists, stat as asyncStat, readDir as asyncReadDir } from '../core/async-fs';

/**
 * 列出目录内容工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function listDirectoryTool(
    params: {
        path: string;
    }
): Promise<ToolUseResult> {
    try {
        let { path: dirPath } = params;
        
        // 路径规范化
        dirPath = normalizePath(dirPath);
        
        // console.log("列出目录内容: ", dirPath);

        // 验证路径是否有效
        if (!dirPath || dirPath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的目录路径: "${dirPath}"` 
            };
            return toolResult;
        }

        // 检查路径是否存在
        if (!await asyncExists(dirPath)) {
            const toolResult = {
                is_error: true,
                content: `目录不存在: ${dirPath}`
            };
            return toolResult;
        }

        // 检查是否为目录
        const isDirectory = AilyHost.get().fs.isDirectory(dirPath);
        if (!isDirectory) {
            const toolResult = {
                is_error: true,
                content: `路径不是目录: ${dirPath}`
            };
            return toolResult;
        }

        const files = await asyncReadDir(dirPath);
        const fileDetails = await Promise.all(
            files.map(async (file) => {
                const fullPath = AilyHost.get().path.join(dirPath, file.name);
                const stats = await asyncStat(fullPath);
                return {
                    name: file.name,
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    modifiedTime: stats.mtime,
                };
            })
        );

        // 按名称排序，目录在前
        fileDetails.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        const toolResult = { 
            is_error: false, 
            content: JSON.stringify(fileDetails, null, 2) 
        };
        return toolResult;
    } catch (error: any) {
        console.warn("列出目录内容失败:", error);
        
        let errorMessage = `列出目录内容失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标路径: ${params.path}` 
        };
        return toolResult;
    }
}
