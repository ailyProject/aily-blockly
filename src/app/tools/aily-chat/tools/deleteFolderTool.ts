import { ToolUseResult } from "./tools";

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
 * 删除文件夹工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function deleteFolderTool(
    params: {
        path: string;
        createBackup?: boolean;
        recursive?: boolean;
    }
): Promise<ToolUseResult> {
    try {
        let { path: folderPath, createBackup = true, recursive = true } = params;
        
        // 路径规范化
        folderPath = normalizePath(folderPath);
        
        // console.log("删除文件夹: ", folderPath);

        // 验证路径是否有效
        if (!folderPath || folderPath.trim() === '') {
            return { 
                is_error: true, 
                content: `无效的文件夹路径: "${folderPath}"` 
            };
        }

        // 检查文件夹是否存在
        if (!window['fs'].existsSync(folderPath)) {
            return {
                is_error: true,
                content: `文件夹不存在: ${folderPath}`
            };
        }

        // 检查是否为文件夹（不是文件）
        const isDirectory = await window['fs'].isDirectory(folderPath);
        if (!isDirectory) {
            return {
                is_error: true,
                content: `路径是文件而不是文件夹，请使用删除文件工具: ${folderPath}`
            };
        }

        let backupPath = '';

        // 创建备份
        if (createBackup) {
            const dirName = window['path'].basename(folderPath);
            const parentDir = window['path'].dirname(folderPath);
            backupPath = window['path'].join(parentDir, `ZBAK_${dirName}`);

            await window['fs'].mkdirSync(backupPath, { recursive: true });

            // 递归复制目录内容
            async function copyDirRecursive(src: string, dest: string) {
                const entries = await window['fs'].readDirSync(src);
                for (const entry of entries) {
                    const srcPath = window['path'].join(src, entry.name);
                    const destPath = window['path'].join(dest, entry.name);

                    if (await window['fs'].isDirectory(srcPath)) {
                        await window['fs'].mkdirSync(destPath, { recursive: true });
                        await copyDirRecursive(srcPath, destPath);
                    } else {
                        const content = await window['fs'].readFileSync(srcPath, 'utf-8');
                        await window['fs'].writeFileSync(destPath, content);
                    }
                }
            }

            await copyDirRecursive(folderPath, backupPath);
        }

        // 删除文件夹
        await window['fs'].rmdirSync(folderPath, { recursive, force: true });
        
        let resultMessage = `文件夹删除成功: ${folderPath}`;
        if (createBackup) {
            resultMessage += `\n备份文件夹: ${backupPath}`;
        }
        
        return { 
            is_error: false, 
            content: resultMessage 
        };
    } catch (error: any) {
        console.warn("删除文件夹失败:", error);
        
        let errorMessage = `删除文件夹失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        return { 
            is_error: true, 
            content: errorMessage + `\n目标文件夹: ${params.path}` 
        };
    }
}
