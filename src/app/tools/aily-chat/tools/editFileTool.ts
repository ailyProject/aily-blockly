import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";

/**
 * 文件编辑工具 - 支持多种编辑模式
 * 
 * 功能说明：
 * 1. 替换文件中的字符串（推荐方式，单匹配安全）
 * 2. 替换整个文件内容
 * 3. 在指定行插入内容
 * 4. 替换指定行或行范围
 * 5. 追加内容到文件末尾
 * 
 * 使用示例：
 * 
 * // 替换文件中的特定字符串（最安全的方式）
 * editFileTool({
 *   path: "/path/to/file.ts",
 *   oldString: "const value = 123;",
 *   newString: "const value = 456;",
 *   replaceMode: "string"
 * });
 * 
 * // 替换整个文件
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'new file content',
 *   replaceMode: "whole"
 * });
 * 
 * // 在第5行插入内容
 * editFileTool({
 *   path: "/path/to/file.txt", 
 *   content: 'new line content',
 *   insertLine: 5
 * });
 * 
 * // 替换第3-5行的内容
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'multi-line\nreplacement\ncontent',
 *   replaceStartLine: 3,
 *   replaceEndLine: 5
 * });
 * 
 * // 追加到文件末尾
 * editFileTool({
 *   path: "/path/to/file.txt",
 *   content: 'append content'
 * });
 */

/**
 * 检测文件编码（简单版）
 * 尝试以UTF-8读取，失败时尝试其他编码
 */
function detectFileEncoding(filePath: string): BufferEncoding {
    try {
        const fs = window['fs'];
        fs.readFileSync(filePath, 'utf-8');
        return 'utf-8';
    } catch (error) {
        // 尝试 utf16le
        try {
            const fs = window['fs'];
            fs.readFileSync(filePath, 'utf16le');
            return 'utf16le';
        } catch {
            // 默认返回 utf-8
            return 'utf-8';
        }
    }
}

/**
 * 路径处理函数 - 转换为绝对路径（Windows或Unix）
 */
function normalizePath(inputPath: string): string {
    if (!inputPath || inputPath.trim() === '') {
        return '';
    }
    
    const path = window['path'];
    
    // 检查是否为绝对路径（支持 Windows 和 Unix）
    const isAbsolutePath = /^([A-Za-z]:\\|\\\\|\/)/i.test(inputPath);
    
    // 如果已经是绝对路径，直接返回
    if (isAbsolutePath) {
        return inputPath;
    }
    
    // 否则相对于当前工作目录
    if (path && typeof path.resolve === 'function') {
        const cwd = window['process']?.cwd?.() || '';
        return cwd ? path.resolve(cwd, inputPath) : inputPath;
    }
    
    // 如果 path.resolve 不可用，返回原路径
    return inputPath;
}

/**
 * 编辑文件工具
 * @param params 参数
 * @returns 工具执行结果
 */
export async function editFileTool(
    params: {
        path: string;
        // String replace mode（推荐）
        oldString?: string;
        newString?: string;
        
        // 其他模式
        content?: string;
        encoding?: BufferEncoding;
        createIfNotExists?: boolean;
        insertLine?: number;
        replaceStartLine?: number;
        replaceEndLine?: number;
        replaceMode?: "string" | "whole" | "line" | "append";
    }
): Promise<ToolUseResult> {
    try {
        const {
            path: filePath,
            oldString,
            newString,
            content,
            encoding: specifiedEncoding,
            createIfNotExists = false,
            insertLine,
            replaceStartLine,
            replaceEndLine,
            replaceMode = "string"
        } = params;
        
        const fs = window['fs'];
        const path = window['path'];
        
        // 路径规范化
        const normalizedFilePath = normalizePath(filePath);
        
        // 验证路径是否有效
        if (!normalizedFilePath || normalizedFilePath.trim() === '') {
            const toolResult = {
                is_error: true,
                content: `❌ 无效的文件路径: "${filePath}"`
            };
            return injectTodoReminder(toolResult, 'editFileTool');
        }
        
        // 检查是否是 Jupyter Notebook 文件
        if (normalizedFilePath.endsWith('.ipynb')) {
            const toolResult = {
                is_error: true,
                content: `❌ 不支持编辑 Jupyter Notebook 文件 (.ipynb)。请使用专门的 Notebook 编辑工具。\n文件路径: ${normalizedFilePath}`
            };
            return injectTodoReminder(toolResult, 'editFileTool');
        }
        
        // 检查文件是否存在
        let fileExists = fs.existsSync(normalizedFilePath);
        
        // 验证是否为文件（不是目录）
        if (fileExists) {
            const stats = fs.statSync(normalizedFilePath);
            if (stats.isDirectory?.()) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 路径是目录而不是文件: ${normalizedFilePath}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
        }
        
        // ========== String Replace Mode（推荐，最安全）==========
        if (replaceMode === "string" || (oldString !== undefined && newString !== undefined)) {
            if (oldString === undefined || newString === undefined) {
                const toolResult = {
                    is_error: true,
                    content: `❌ String replace 模式需要同时提供 oldString 和 newString 参数`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            if (oldString === newString) {
                const toolResult = {
                    is_error: true,
                    content: `⚠️  新旧字符串完全相同，无需修改`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            // 处理新建文件情况（oldString 为空）
            if (oldString === '') {
                if (fileExists) {
                    const toolResult = {
                        is_error: true,
                        content: `❌ 文件已存在，无法创建新文件。如需覆盖，请使用 replaceMode: "whole"`
                    };
                    return injectTodoReminder(toolResult, 'editFileTool');
                }
                
                // 创建新文件
                const dir = path.dirname ? path.dirname(normalizedFilePath) : normalizedFilePath.substring(0, normalizedFilePath.lastIndexOf('\\'));
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(normalizedFilePath, newString, 'utf-8');
                
                const toolResult = {
                    is_error: false,
                    content: `✅ 新文件创建成功\n文件: ${normalizedFilePath}\n行数: ${newString.split('\n').length}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            // 编辑现有文件
            if (!fileExists) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 文件不存在: ${normalizedFilePath}\n若需创建新文件，请设置 oldString 为空字符串`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            // 检测文件编码
            const encoding = specifiedEncoding || detectFileEncoding(normalizedFilePath);
            const originalContent = fs.readFileSync(normalizedFilePath, encoding);
            
            // 检查 old_string 是否在文件中
            if (!originalContent.includes(oldString)) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 要替换的字符串在文件中未找到\n\n预期查找的字符串长度: ${oldString.length} 字符\n文件路径: ${normalizedFilePath}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            // 检查是否有多个匹配（为了安全性，只允许单个匹配）
            const matches = originalContent.split(oldString).length - 1;
            if (matches > 1) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 找到 ${matches} 个匹配的字符串。为了安全起见，本工具只支持单个匹配。\n\n建议:\n1. 在 oldString 中添加更多上下文代码（至少3-5行）以唯一标识该位置\n2. 分多次调用，每次替换一个匹配项\n文件: ${normalizedFilePath}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            // 执行替换
            const updatedContent = originalContent.replace(oldString, newString);
            fs.writeFileSync(normalizedFilePath, updatedContent, encoding);
            
            // 计算修改的行信息
            const beforeLines = originalContent.substring(0, originalContent.indexOf(oldString)).split('\n').length;
            const changedLines = newString.split('\n').length;
            const oldLines = oldString.split('\n').length;
            
            const toolResult = {
                is_error: false,
                content: `✅ 文件编辑成功\n文件: ${normalizedFilePath}\n修改位置: 第 ${beforeLines} 行\n行数变化: ${oldLines} → ${changedLines} 行`
            };
            return injectTodoReminder(toolResult, 'editFileTool');
        }
        
        // ========== Other Modes ==========
        if (!fileExists && !createIfNotExists) {
            const toolResult = {
                is_error: true,
                content: `❌ 文件不存在: ${normalizedFilePath}。若需创建，请设置 createIfNotExists: true`
            };
            return injectTodoReminder(toolResult, 'editFileTool');
        }
        
        if (!fileExists && createIfNotExists) {
            const dir = path.dirname ? path.dirname(normalizedFilePath) : normalizedFilePath.substring(0, Math.max(normalizedFilePath.lastIndexOf('\\'), normalizedFilePath.lastIndexOf('/')));
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(normalizedFilePath, '', 'utf-8');
        }
        
        // 检测文件编码
        const encoding = specifiedEncoding || detectFileEncoding(normalizedFilePath);
        
        let finalContent: string;
        let operationDescription: string;
        
        // Whole file replace
        if (replaceMode === "whole") {
            finalContent = content || '';
            operationDescription = "替换整个文件内容";
        } 
        // Line-based operations
        else if (replaceStartLine !== undefined) {
            const existingContent = fs.readFileSync(normalizedFilePath, encoding);
            const lines = existingContent.split('\n');
            
            if (replaceStartLine < 1) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 替换起始行号必须 >= 1，当前: ${replaceStartLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            if (replaceStartLine > lines.length) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 替换起始行号 ${replaceStartLine} 超出文件总行数 ${lines.length}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            const endLine = replaceEndLine !== undefined ? replaceEndLine : replaceStartLine;
            
            if (endLine < replaceStartLine) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 结束行号 ${endLine} 不能小于起始行号 ${replaceStartLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            if (endLine > lines.length) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 替换结束行号 ${endLine} 超出文件总行数 ${lines.length}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            const contentLines = (content || '').split('\n');
            const startIndex = replaceStartLine - 1;
            const deleteCount = endLine - replaceStartLine + 1;
            
            lines.splice(startIndex, deleteCount, ...contentLines);
            finalContent = lines.join('\n');
            
            operationDescription = replaceStartLine === endLine
                ? `替换第 ${replaceStartLine} 行（${contentLines.length} 行内容）`
                : `替换第 ${replaceStartLine}-${endLine} 行（${deleteCount} 行 → ${contentLines.length} 行）`;
        } 
        // Insert at specific line
        else if (insertLine !== undefined) {
            const existingContent = fs.readFileSync(normalizedFilePath, encoding);
            const lines = existingContent.split('\n');
            
            if (insertLine < 1) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 插入行号必须 >= 1，当前: ${insertLine}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            if (insertLine > lines.length + 1) {
                const toolResult = {
                    is_error: true,
                    content: `❌ 插入行号 ${insertLine} 超出范围。最大可插入行号: ${lines.length + 1}`
                };
                return injectTodoReminder(toolResult, 'editFileTool');
            }
            
            const contentLines = (content || '').split('\n');
            const insertIndex = insertLine - 1;
            
            lines.splice(insertIndex, 0, ...contentLines);
            finalContent = lines.join('\n');
            
            operationDescription = `在第 ${insertLine} 行插入 ${contentLines.length} 行内容`;
        } 
        // Append mode
        else {
            const existingContent = fs.readFileSync(normalizedFilePath, encoding);
            const hasTrailingNewline = existingContent.endsWith('\n');
            finalContent = hasTrailingNewline 
                ? existingContent + (content || '')
                : existingContent + '\n' + (content || '');
            operationDescription = "追加内容到文件末尾";
        }
        
        // 写入文件
        fs.writeFileSync(normalizedFilePath, finalContent, encoding);
        
        const toolResult = {
            is_error: false,
            content: `✅ 文件编辑成功\n文件: ${normalizedFilePath}\n操作: ${operationDescription}`
        };
        return injectTodoReminder(toolResult, 'editFileTool');
        
    } catch (error: any) {
        console.error("编辑文件失败:", error);
        
        let errorMessage = `❌ 编辑文件失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = {
            is_error: true,
            content: errorMessage + `\n文件路径: ${params.path}`
        };
        return injectTodoReminder(toolResult, 'editFileTool');
    }
}
