import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";

/**
 * 文件编辑工具
 * 
 * 功能说明：
 * 1. 替换整个文件内容（默认行为，保持向后兼容）
 * 2. 在指定行插入内容
 * 3. 替换指定行或指定范围的行（新功能）
 * 4. 追加内容到文件末尾
 * 
 * 使用示例：
 * 
 * // 替换整个文件（默认行为）
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'new file content',
 *   replaceMode: true // 可省略，默认为true
 * });
 * 
 * // 在第5行插入内容
 * editFileTool({
 *   path: "/path/to/file.txt", 
 *   content: 'new line content',
 *   insertLine: 5,
 *   replaceMode: false
 * });
 * 
 * // 替换第3行的内容
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'replacement content',
 *   replaceStartLine: 3,
 *   replaceMode: false
 * });
 * 
 * // 替换第3-5行的内容
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'multi-line\nreplacement\ncontent',
 *   replaceStartLine: 3,
 *   replaceEndLine: 5,
 *   replaceMode: false
 * });
 * 
 * // 追加到文件末尾
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'append content',
 *   replaceMode: false
 * });
 */

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
 * 编辑文件工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function editFileTool(
    params: {
        path: string;
        content: string;
        encoding?: string;
        createIfNotExists?: boolean;
        insertLine?: number; // 插入行号（从1开始），如果指定则在该行插入内容
        replaceStartLine?: number; // 替换起始行号（从1开始）
        replaceEndLine?: number; // 替换结束行号（从1开始），如果不指定则只替换起始行
        replaceMode?: boolean; // 是否替换整个文件内容（默认true，保持向后兼容）
    }
): Promise<ToolUseResult> {
    try {
        const {
            path: filePath, 
            content, 
            encoding = 'utf-8', 
            createIfNotExists = false,
            insertLine,
            replaceStartLine,
            replaceEndLine,
            replaceMode = true
        } = params;
        
        // 路径规范化
        const normalizedFilePath = normalizePath(filePath);
        
        console.log("编辑文件: ", normalizedFilePath);

        // 验证路径是否有效
        if (!normalizedFilePath || normalizedFilePath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的文件路径: "${filePath}"` 
            };
            return injectTodoReminder(toolResult, 'editFileTool');
        }

        // 检查文件是否存在
        let fileExists = window['fs'].existsSync(normalizedFilePath);
        if (!fileExists) {
            if (createIfNotExists) {
                // 如果文件不存在且允许创建，先创建目录
                const dir = window['path'].dirname(normalizedFilePath);
                if (!window['fs'].existsSync(dir)) {
                    await window['fs'].mkdirSync(dir, { recursive: true });
                }
                
                // 如果指定了插入行或替换行但文件不存在，创建空文件
                if ((insertLine !== undefined || replaceStartLine !== undefined) && !replaceMode) {
                    await window['fs'].writeFileSync(normalizedFilePath, '', encoding);
                    fileExists = true;
                }
            } else {
                const toolResult = {
                    is_error: true,
                    content: `文件不存在: ${normalizedFilePath}。如需创建新文件，请设置 createIfNotExists 参数为 true。`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
        } else {
            // 检查是否为文件（不是目录）
            const isDirectory = await window['fs'].isDirectory(normalizedFilePath);
            if (isDirectory) {
                const toolResult = {
                    is_error: true,
                    content: `路径是目录而不是文件: ${normalizedFilePath}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
        }

        let finalContent: string;
        let operationDescription: string;

        // 根据模式处理内容，优先使用replaceStartLine
        if (replaceStartLine !== undefined) {
            // 替换指定行或行范围（最高优先级）
            if (replaceStartLine < 1) {
                const toolResult = {
                    is_error: true,
                    content: `替换起始行号必须大于0，当前为: ${replaceStartLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }

            // 读取现有文件内容
            const existingContent = await window['fs'].readFileSync(normalizedFilePath, encoding);
            const lines = existingContent.split('\n');
            
            // 验证起始行号是否有效
            if (replaceStartLine > lines.length) {
                const toolResult = {
                    is_error: true,
                    content: `替换起始行号 ${replaceStartLine} 超出文件行数 ${lines.length}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }

            // 确定结束行号
            const endLine = replaceEndLine !== undefined ? replaceEndLine : replaceStartLine;
            
            // 验证结束行号
            if (endLine < replaceStartLine) {
                const toolResult = {
                    is_error: true,
                    content: `替换结束行号 ${endLine} 不能小于起始行号 ${replaceStartLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            if (endLine > lines.length) {
                const toolResult = {
                    is_error: true,
                    content: `替换结束行号 ${endLine} 超出文件行数 ${lines.length}`
                };
            }

            // 替换指定范围的行
            const startIndex = replaceStartLine - 1; // 转换为0基索引
            const deleteCount = endLine - replaceStartLine + 1; // 要删除的行数
            const contentLines = content.split('\n');
            
            // 替换内容
            lines.splice(startIndex, deleteCount, ...contentLines);
            finalContent = lines.join('\n');
            
            if (replaceStartLine === endLine) {
                operationDescription = `替换第 ${replaceStartLine} 行内容（${contentLines.length} 行）`;
                console.log(`替换第 ${replaceStartLine} 行，新行数: ${contentLines.length}`);
            } else {
                operationDescription = `替换第 ${replaceStartLine}-${endLine} 行内容（${deleteCount} 行 → ${contentLines.length} 行）`;
                console.log(`替换第 ${replaceStartLine}-${endLine} 行，原行数: ${deleteCount}，新行数: ${contentLines.length}`);
            }
        } else if (replaceMode || (!fileExists && insertLine === undefined)) {
            // 替换整个文件内容（默认行为）
            finalContent = content;
            operationDescription = "替换整个文件内容";
            console.log(`替换文件内容长度: ${content.length}`);
        } else if (insertLine !== undefined) {
            // 在指定行插入内容
            if (insertLine < 1) {
                const toolResult = {
                    is_error: true,
                    content: `插入行号必须大于0，当前为: ${insertLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }

            // 读取现有文件内容
            const existingContent = await window['fs'].readFileSync(normalizedFilePath, encoding);
            const lines = existingContent.split('\n');
            
            // 验证行号是否有效
            if (insertLine > lines.length + 1) {
                const toolResult = {
                    is_error: true,
                    content: `插入行号 ${insertLine} 超出文件行数 ${lines.length}。最大可插入行号为 ${lines.length + 1}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }

            // 在指定行插入内容
            const insertIndex = insertLine - 1; // 转换为0基索引
            const contentLines = content.split('\n');
            
            // 插入新内容
            lines.splice(insertIndex, 0, ...contentLines);
            finalContent = lines.join('\n');
            
            operationDescription = `在第 ${insertLine} 行插入 ${contentLines.length} 行内容`;
            console.log(`在第 ${insertLine} 行插入内容，新增行数: ${contentLines.length}`);
        } else {
            // 追加到文件末尾
            const existingContent = await window['fs'].readFileSync(normalizedFilePath, encoding);
            finalContent = existingContent + (existingContent.endsWith('\n') ? '' : '\n') + content;
            operationDescription = "追加内容到文件末尾";
            console.log(`追加文件内容长度: ${content.length}`);
        }

        // 写入文件
        await window['fs'].writeFileSync(normalizedFilePath, finalContent, encoding);
        
        const toolResult = { 
            is_error: false, 
            content: `文件编辑成功: ${normalizedFilePath}\n操作: ${operationDescription}` 
        };
        return injectTodoReminder(toolResult, 'editFileTool');
    } catch (error: any) {
        console.warn("编辑文件失败:", error);
        
        let errorMessage = `编辑文件失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标文件: ${params.path}` 
        };
        return injectTodoReminder(toolResult, 'editFileTool');
    }
}
