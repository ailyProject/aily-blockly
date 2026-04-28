import { ToolUseResult } from "./tools";
import { normalizePath } from "../services/security.service";
import { AilyHost } from '../core/host';

// 构建目录树的递归函数（真异步，通过 IPC 在主进程执行 fs 操作）
async function buildDirectoryTree(dirPath: string, currentDepth: number = 0, maxDepth: number = 3) {
    if (currentDepth > maxDepth) {
        return null;
    }

    try {
        const fs = AilyHost.get().fs;
        const pathUtils = AilyHost.get().path;

        let stats: { isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date };
        if (fs.stat) {
            stats = await fs.stat(dirPath);
        } else {
            stats = fs.statSync(dirPath);
        }
        const isDir = stats.isDirectory();
        const name = pathUtils.basename(dirPath);

        const node = {
            name,
            path: dirPath,
            isDirectory: isDir,
            size: stats.size,
            modifiedTime: stats.mtime,
            children: [] as any[]
        };

        if (isDir && currentDepth < maxDepth) {
            try {
                let files: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
                if (fs.readDir) {
                    files = await fs.readDir(dirPath);
                } else if (fs.readDirSync) {
                    files = fs.readDirSync(dirPath);
                } else {
                    const names = fs.readdirSync(dirPath);
                    files = [];
                    for (const n of names) {
                        const childStat = fs.stat ? await fs.stat(pathUtils.join(dirPath, n)) : fs.statSync(pathUtils.join(dirPath, n));
                        files.push({ name: n, isDirectory: () => childStat.isDirectory(), isFile: () => childStat.isFile() });
                    }
                }
                for (const file of files) {
                    const childPath = pathUtils.join(dirPath, file.name);
                    const childNode = await buildDirectoryTree(childPath, currentDepth + 1, maxDepth);
                    if (childNode) {
                        node.children.push(childNode);
                    }
                }
                // 按名称排序，目录在前
                node.children.sort((a, b) => {
                    if (a.isDirectory && !b.isDirectory) return -1;
                    if (!a.isDirectory && b.isDirectory) return 1;
                    return a.name.localeCompare(b.name);
                });
            } catch (error) {
                console.warn(`无法读取目录: ${dirPath}`, error);
            }
        }

        return node;
    } catch (error) {
        console.warn(`无法获取文件信息: ${dirPath}`, error);
        return null;
    }
}

/**
 * 获取目录树工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function getDirectoryTreeTool(
    params: {
        path: string;
        maxDepth?: number;
        includeFiles?: boolean;
    }
): Promise<ToolUseResult> {
    try {
        let { path: dirPath, maxDepth = 3, includeFiles = true } = params;
        
        // 路径规范化
        dirPath = normalizePath(dirPath);
        
        console.log("获取目录树: ", dirPath);

        // 验证路径是否有效
        if (!dirPath || dirPath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的目录路径: "${dirPath}"` 
            };
            return toolResult;
        }

        // 检查路径是否存在
        if (!AilyHost.get().fs.existsSync(dirPath)) {
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

        // 限制最大深度以防止性能问题
        if (maxDepth > 10) {
            maxDepth = 10;
        }

        const directoryTree = await buildDirectoryTree(dirPath, 0, maxDepth);
        
        if (!directoryTree) {
            const toolResult = { 
                is_error: true, 
                content: `无法构建目录树: ${dirPath}` 
            };
            return toolResult;
        }

        // 如果不包含文件，过滤掉文件节点
        if (!includeFiles) {
            function filterDirectoriesOnly(node: any): any {
                if (!node.isDirectory) {
                    return null;
                }
                
                return {
                    ...node,
                    children: node.children
                        .map(filterDirectoriesOnly)
                        .filter((child: any) => child !== null)
                };
            }
            
            const filteredTree = filterDirectoriesOnly(directoryTree);
            const toolResult = { 
                is_error: false, 
                content: JSON.stringify(filteredTree, null, 2) 
            };
            return toolResult;
        }

        const toolResult = { 
            is_error: false, 
            content: JSON.stringify(directoryTree, null, 2) 
        };
        return toolResult;
    } catch (error: any) {
        console.warn("获取目录树失败:", error);
        
        let errorMessage = `获取目录树失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标目录: ${params.path}` 
        };
        return toolResult;
    }
}
