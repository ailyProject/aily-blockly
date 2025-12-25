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
 * 读取文件内容工具（支持行范围和字节范围读取，自动处理大文件）
 * @param params 参数
 * @returns 工具执行结果
 */
export async function readFileTool(
    params: {
        path: string;
        encoding?: BufferEncoding;
        startLine?: number;
        lineCount?: number;
        startByte?: number;
        byteCount?: number;
        maxSize?: number;
    }
): Promise<ToolUseResult> {
    try {
        let { 
            path: filePath, 
            encoding = 'utf-8',
            startLine,
            lineCount,
            startByte,
            byteCount,
            maxSize = 1048576 // 默认最大1MB
        } = params;
        
        // 路径规范化
        filePath = normalizePath(filePath);
        
        // 验证路径是否有效
        if (!filePath || filePath.trim() === '') {
            const toolResult = { 
                is_error: true, 
                content: `无效的文件路径: "${filePath}"` 
            };
            return injectTodoReminder(toolResult, 'readFileTool');
        }

        // 检查文件是否存在
        if (!window['fs'].existsSync(filePath)) {
            const toolResult = {
                is_error: true,
                content: `文件不存在: ${filePath}`
            };
            return injectTodoReminder(toolResult, 'readFileTool');
        }

        // 检查是否为文件（不是目录）
        const isDirectory = await window['fs'].isDirectory(filePath);
        if (isDirectory) {
            const toolResult = {
                is_error: true,
                content: `路径是目录而不是文件: ${filePath}`
            };
            return injectTodoReminder(toolResult, 'readFileTool');
        }

        // 获取文件大小
        const stats = window['fs'].statSync(filePath);
        const fileSize = stats.size;
        
        let resultContent: string;
        let metadata: any = {
            filePath,
            encoding,
            fileSize,
            fileSizeKB: (fileSize / 1024).toFixed(2),
            fileSizeMB: (fileSize / 1024 / 1024).toFixed(2)
        };

        // 按字节范围读取（优先级最高）
        if (startByte !== undefined || byteCount !== undefined) {
            const start = startByte || 0;
            const requestedCount = byteCount !== undefined ? byteCount : Math.min(maxSize, fileSize - start);
            const actualCount = Math.min(requestedCount, maxSize, fileSize - start);
            
            // 验证范围
            if (start < 0 || start >= fileSize) {
                const toolResult = {
                    is_error: true,
                    content: `无效的字节起始位置: ${start}（文件大小: ${fileSize} 字节）`
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
            
            // 如果文件不是很大，或者需要从头读取，可以直接读取后截取
            // 否则建议完整读取文件（Electron fs API 的限制）
            const fullContent = await window['fs'].readFileSync(filePath, encoding);
            
            // 按字符截取（更适合文本文件）
            // 注意：这里是字符偏移，不是严格的字节偏移
            resultContent = fullContent.substring(start, start + actualCount);
            
            metadata.readMode = 'bytes';
            metadata.startByte = start;
            metadata.requestedBytes = requestedCount;
            metadata.actualBytesRead = resultContent.length;
            metadata.truncated = requestedCount > actualCount || start + actualCount < fileSize;
            metadata.note = '字节范围基于字符偏移量（适用于文本文件）';
        }
        // 按行范围读取
        else if (startLine !== undefined || lineCount !== undefined) {
            // 先检查文件大小，如果太大则警告
            if (fileSize > maxSize && !byteCount) {
                const toolResult = {
                    is_error: true,
                    content: `文件过大 (${(fileSize / 1024 / 1024).toFixed(2)} MB)。建议使用字节范围读取 (startByte + byteCount) 或增加 maxSize 参数。当前限制: ${(maxSize / 1024 / 1024).toFixed(2)} MB`
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
            
            const fullContent = await window['fs'].readFileSync(filePath, encoding);
            const lines = fullContent.split('\n');
            const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
            const count = lineCount !== undefined ? lineCount : lines.length - start;
            
            // 验证范围
            if (start >= lines.length) {
                const toolResult = {
                    is_error: true,
                    content: `无效的起始行号: ${startLine}（文件总行数: ${lines.length}）`
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
            
            const selectedLines = lines.slice(start, start + count);
            resultContent = selectedLines.join('\n');
            
            // 检查读取的内容是否超过大小限制
            if (resultContent.length > maxSize) {
                resultContent = resultContent.slice(0, maxSize);
                metadata.contentTruncated = true;
                metadata.truncatedAt = maxSize;
            }
            
            metadata.readMode = 'lines';
            metadata.startLine = start + 1;
            metadata.endLine = Math.min(start + count, lines.length);
            metadata.linesRead = selectedLines.length;
            metadata.totalLines = lines.length;
            metadata.contentSize = resultContent.length;
        } 
        // 完整读取
        else {
            // 检查文件大小
            if (fileSize > maxSize) {
                const toolResult = {
                    is_error: true,
                    content: `文件过大 (${(fileSize / 1024 / 1024).toFixed(2)} MB)，超过限制 ${(maxSize / 1024 / 1024).toFixed(2)} MB。请使用以下方式之一：\n` +
                            `1. 使用字节范围读取: startByte + byteCount\n` +
                            `2. 使用行范围读取: startLine + lineCount\n` +
                            `3. 增加 maxSize 参数（不推荐）\n` +
                            `4. 使用 grep_tool 搜索特定内容`
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
            
            resultContent = await window['fs'].readFileSync(filePath, encoding);
            metadata.readMode = 'full';
            const lines = resultContent.split('\n');
            metadata.totalLines = lines.length;
            metadata.contentSize = resultContent.length;
            
            // 检查单行是否过长（可能是压缩的JSON等）
            const maxLineLength = Math.max(...lines.map(line => line.length));
            if (maxLineLength > 10000) {
                metadata.warning = `检测到超长行 (${(maxLineLength / 1024).toFixed(2)} KB)，建议使用字节范围读取`;
                metadata.maxLineLength = maxLineLength;
            }
        }
        
        const toolResult = { 
            is_error: false, 
            content: resultContent,
            metadata
        };
        return injectTodoReminder(toolResult, 'readFileTool');
    } catch (error: any) {
        console.warn("读取文件失败:", error);
        
        let errorMessage = `读取文件失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = { 
            is_error: true, 
            content: errorMessage + `\n目标文件: ${params.path}` 
        };
        return injectTodoReminder(toolResult, 'readFileTool');
    }
}
