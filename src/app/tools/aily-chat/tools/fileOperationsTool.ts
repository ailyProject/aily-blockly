import { connectionStrategies } from "@joint/core";
import { ToolUseResult } from "./tools";


// 路径处理示例
function normalizePath(inputPath: string): string {
    if (!inputPath) return '';
    
    // console.log('规范化前的路径:', inputPath);
    
    // 对于 Windows 路径，保持反斜杠格式，因为某些 Electron API 需要原生路径格式
    let normalizedPath = inputPath;
    
    // 处理常见的转义问题
    if (typeof inputPath === 'string') {
        // 检查是否是 Windows 路径格式
        const isWindowsPath = /^[A-Za-z]:\\/.test(inputPath);
        
        if (isWindowsPath) {
            // Windows 路径：保持反斜杠，但确保正确转义
            normalizedPath = inputPath
                .replace(/\\\\/g, '\\')  // 将双反斜杠转为单反斜杠
                .replace(/\//g, '\\');   // 将正斜杠转为反斜杠
        } else {
            // Unix 路径：转换为正斜杠
            normalizedPath = inputPath
                .replace(/\\\\/g, '/')   // 处理双反斜杠
                .replace(/\\/g, '/')     // 处理单反斜杠
                .replace(/\/+/g, '/');   // 合并多个斜杠
        }
        
        // 移除尾部路径分隔符（除非是根目录）
        if (normalizedPath.length > 1 && (normalizedPath.endsWith('/') || normalizedPath.endsWith('\\'))) {
            normalizedPath = normalizedPath.slice(0, -1);
        }
    }
    
    // console.log('规范化后的路径:', normalizedPath);
    return normalizedPath;
}

// 构建目录树的递归函数
async function buildDirectoryTree(dirPath: string, currentDepth: number = 0, maxDepth: number = 3) {
    if (currentDepth > maxDepth) {
        return null;
    }

    try {
        const stats = await window['fs'].statSync(dirPath);
        const isDirectory = await window['fs'].isDirectory(dirPath);
        const name = window['path'].basename(dirPath);

        const node = {
            name,
            path: dirPath,
            isDirectory,
            size: stats.size,
            modifiedTime: stats.mtime,
            children: [] as any[]
        };

        if (isDirectory && currentDepth < maxDepth) {
            try {
                const files = await window['fs'].readDirSync(dirPath);
                for (const file of files) {
                    const childPath = window['path'].join(dirPath, file.name);
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


export async function fileOperationsTool(
    params: {
        operation: 'list' | 'read' | 'create' | 'edit' | 'delete' | 'exists' | 'rename' | 'tree';
        path: string;
        name?: string;
        content?: string;
        is_folder?: boolean;
        maxDepth?: number; // 用于控制目录树的最大深度
    }
): Promise<ToolUseResult> {
    try {
        let { operation, path: basePath, name, content, is_folder = false, maxDepth = 3 } = params;

        // 输出原始参数进行调试
        console.log('原始参数:', JSON.stringify(params, null, 2));
        console.log('原始 basePath:', basePath);
        console.log('原始 name:', name);
        
        // 检测和修复路径损坏问题
        if (basePath && typeof basePath === 'string') {
            // 检查是否存在常见的转义问题
            if (basePath.includes('distlock.json')) {
                console.log('检测到路径损坏，尝试修复...');
                // 修复 \b 被解释为退格符的问题
                basePath = basePath.replace('distlock.json', 'dist\\block.json');
                console.log('修复后的 basePath:', basePath);
                
                // 如果路径包含文件名，分离路径和文件名
                const lastSeparatorIndex = Math.max(basePath.lastIndexOf('\\'), basePath.lastIndexOf('/'));
                if (lastSeparatorIndex > 0 && !name) {
                    name = basePath.substring(lastSeparatorIndex + 1);
                    basePath = basePath.substring(0, lastSeparatorIndex);
                    console.log('分离后 - basePath:', basePath, ', name:', name);
                }
            }
            
            // 通用的路径修复：检查路径是否以文件扩展名结尾但没有提供 name 参数
            if (!name && /\.(json|txt|js|ts|html|css|py|cpp|ino|h)$/i.test(basePath)) {
                console.log('检测到路径包含文件名，进行分离...');
                const lastSeparatorIndex = Math.max(basePath.lastIndexOf('\\'), basePath.lastIndexOf('/'));
                if (lastSeparatorIndex > 0) {
                    name = basePath.substring(lastSeparatorIndex + 1);
                    basePath = basePath.substring(0, lastSeparatorIndex);
                    console.log('自动分离 - basePath:', basePath, ', name:', name);
                }
            }
        }
        
        // 处理路径转义和规范化
        basePath = normalizePath(basePath);
        if (name) {
            name = normalizePath(name);
        }

        // 构建完整文件路径
        let filePath = basePath;
        if (name) {
            filePath = window['path'].join(basePath, name);
        }
        
        // 再次规范化最终路径
        filePath = normalizePath(filePath);
        
        console.log("Final filePath: ", filePath);

        // 验证路径是否有效
        if (!filePath || filePath.trim() === '') {
            return { 
                is_error: true, 
                content: `无效的文件路径: basePath="${basePath}", name="${name}"` 
            };
        }

        let is_error = false;

        switch (operation) {
            case 'list':
                const files = await window['fs'].readDirSync(filePath);
                const fileDetails = await Promise.all(
                    files.map(async (file) => {
                        const fullPath = window['path'].join(filePath, file.name);
                        const stats = await window['fs'].statSync(fullPath);
                        return {
                            name: file,
                            isDirectory: await window['fs'].isDirectory(fullPath),
                            size: stats.size,
                            modifiedTime: stats.mtime,
                        };
                    })
                );
                return { is_error, content: JSON.stringify(fileDetails, null, 2) };

            case 'read':
                const fileContent = await window['fs'].readFileSync(filePath, 'utf-8');
                return { is_error, content: fileContent };

            case 'tree':
                const directoryTree = await buildDirectoryTree(filePath, 0, maxDepth);
                if (!directoryTree) {
                    return { is_error: true, content: `无法构建目录树: ${filePath}` };
                }
                return { is_error, content: JSON.stringify(directoryTree, null, 2) };

            case 'create':
                try {
                    if (is_folder) {
                        console.log(`创建文件夹: ${filePath}`);
                        await window['fs'].mkdirSync(filePath, { recursive: true });
                        return { is_error, content: `Folder created at: ${filePath}` };
                    } else {
                        const dir = window['path'].dirname(filePath);
                        console.log(`文件目录: ${dir}`);
                        console.log(`完整文件路径: ${filePath}`);
                        
                        // 确保目录存在
                        if (!window['fs'].existsSync(dir)) {
                            console.log(`创建目录: ${dir}`);
                            await window['fs'].mkdirSync(dir, { recursive: true });
                        }
                        
                        // 写入文件
                        console.log(`写入文件内容，长度: ${(content || '').length}`);
                        await window['fs'].writeFileSync(filePath, content || '', 'utf-8');
                        return { is_error, content: `File created at: ${filePath}` };
                    }
                } catch (createError) {
                    console.error('文件创建失败:', createError);
                    return { 
                        is_error: true, 
                        content: `文件创建失败: ${createError.message}\n路径: ${filePath}\n目录: ${window['path'].dirname(filePath)}` 
                    };
                }

            case 'edit':
                try {
                    console.log(`编辑文件: ${filePath}`);
                    console.log(`写入内容长度: ${(content || '').length}`);
                    await window['fs'].writeFileSync(filePath, content || '', 'utf-8');
                    return { is_error, content: `File updated at: ${filePath}` };
                } catch (editError) {
                    console.error('文件编辑失败:', editError);
                    return { 
                        is_error: true, 
                        content: `文件编辑失败: ${editError.message}\n路径: ${filePath}` 
                    };
                }

            case 'rename':
                let backupPath;

                if (is_folder) {
                    // Create backup folder with timestamp
                    const dirName = window['path'].basename(filePath);
                    const parentDir = window['path'].dirname(filePath);
                    backupPath = window['path'].join(parentDir, `ZBAK_${dirName}`);

                    await window['fs'].mkdirSync(backupPath, { recursive: true });

                    // Copy directory contents recursively
                    async function copyDirRecursive(src, dest) {
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

                    await copyDirRecursive(filePath, backupPath);
                    await window['fs'].rmdirSync(filePath, { recursive: true });
                } else {
                    // Create backup file
                    const dir = window['path'].dirname(filePath);
                    const filename = window['path'].basename(filePath);
                    const ext = window['path'].extname(filePath);
                    const baseFilename = filename.replace(ext, '');
                    backupPath = window['path'].join(dir, `ZBAK_${baseFilename}${ext}`);

                    const fileContent = await window['fs'].readFileSync(filePath, 'utf-8');
                    await window['fs'].writeFileSync(backupPath, fileContent);
                    await window['fs'].unlinkSync(filePath);
                }

                return { is_error, content: `Deleted ${is_folder ? 'folder' : 'file'} at: ${filePath} (backup at: ${backupPath})` };

            case 'delete':
                console.log(`Deleting ${is_folder ? 'folder' : 'file'} at: ${filePath}`);
                if (is_folder) {
                    await window['fs'].rmdirSync(filePath, { recursive: true, force: true });
                    return { is_error, content: `Folder deleted at: ${filePath}` };
                }
                try {
                    await window['fs'].unlinkSync(filePath, null);
                    return { is_error, content: `File deleted at: ${filePath}` };
                } catch (err) {
                    is_error = true;
                    return { is_error, content: `File deletion failed: ${filePath}` };
                }

            case 'exists':
                const exists = window['fs'].existsSync(filePath);
                if (exists && is_folder !== undefined) {
                    const isDir = window['fs'].isDirectory(filePath);
                    if (is_folder !== isDir) {
                        return {
                            is_error,
                            content: `false (path exists but is ${isDir ? 'a directory' : 'a file'})`
                        };
                    }
                }
                return { is_error, content: exists.toString() };

            case 'tree':
                const tree = await buildDirectoryTree(filePath, 0, maxDepth);
                return { is_error, content: JSON.stringify(tree, null, 2) };

            default:
                return { is_error: true, content: `Invalid operation: ${operation}` };
        }
    } catch (error: any) {
        console.error("File operation error:", error);
        console.error("错误堆栈:", error.stack);
        console.error("操作参数:", JSON.stringify(params, null, 2));
        
        // 提供更详细的错误信息
        let errorMessage = `文件操作失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        if (error.path) {
            errorMessage += `\n错误路径: ${error.path}`;
        }
        
        return { 
            is_error: true, 
            content: errorMessage + `\n操作类型: ${params.operation}\n目标路径: ${params.path}${params.name ? '/' + params.name : ''}` 
        };
    }
}
