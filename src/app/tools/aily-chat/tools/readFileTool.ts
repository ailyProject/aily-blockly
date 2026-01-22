import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";
import { 
    PathSecurityContext, 
    validateFileRead,
    FILE_READ_LIMITS,
    normalizePath 
} from "../services/security.service";
import { 
    logFileOperation, 
    completeAuditLog, 
    logBlockedOperation 
} from "../services/audit-log.service";

// 智能读取阈值常量
const SMART_READ_LINE_THRESHOLD = 10240; // 单行超过10KB则认为是单行大文件

/**
 * 分析文件特征，用于智能读取决策
 */
interface FileCharacteristics {
    totalLines: number;
    fileSize: number;
    avgLineLength: number;
    maxLineLength: number;
    isSingleLineLargeFile: boolean;
    hasLongLines: boolean;
}

/**
 * 快速分析文件特征（仅读取部分内容进行判断）
 */
async function analyzeFileCharacteristics(
    filePath: string, 
    encoding: BufferEncoding,
    sampleSize: number = 65536 // 默认采样64KB
): Promise<FileCharacteristics> {
    const stats = window['fs'].statSync(filePath);
    const fileSize = stats.size;
    
    // 对于小文件直接完整读取分析
    const readSize = Math.min(sampleSize, fileSize);
    const sampleContent = await window['fs'].readFileSync(filePath, encoding);
    const actualSample = sampleContent.substring(0, readSize);
    
    const lines = actualSample.split('\n');
    const totalLines = lines.length;
    const lineLengths = lines.map(line => line.length);
    const maxLineLength = Math.max(...lineLengths);
    const avgLineLength = lineLengths.reduce((a, b) => a + b, 0) / totalLines;
    
    // 判断是否为单行大文件（只有1行，或者第一行占据了大部分内容）
    const isSingleLineLargeFile = (totalLines === 1 && fileSize > 1024) || 
                                   (totalLines <= 2 && lines[0].length > fileSize * 0.9);
    
    // 判断是否有超长行
    const hasLongLines = maxLineLength > SMART_READ_LINE_THRESHOLD;
    
    return {
        totalLines: fileSize <= sampleSize ? totalLines : -1, // -1表示未完整读取
        fileSize,
        avgLineLength,
        maxLineLength,
        isSingleLineLargeFile,
        hasLongLines
    };
}

/**
 * 将行范围转换为字节范围（用于单行大文件）
 */
function convertLineRangeToByteRange(
    startLine: number | undefined,
    lineCount: number | undefined,
    fileSize: number,
    characteristics: FileCharacteristics
): { startByte: number; byteCount: number } | null {
    // 仅对单行大文件或超长行文件进行转换
    if (!characteristics.isSingleLineLargeFile && !characteristics.hasLongLines) {
        return null;
    }
    
    // 对于单行文件，行范围没有意义，转换为字节范围
    if (characteristics.isSingleLineLargeFile) {
        const start = startLine !== undefined ? Math.max(0, (startLine - 1) * Math.floor(characteristics.avgLineLength)) : 0;
        const count = lineCount !== undefined ? lineCount * Math.floor(characteristics.avgLineLength) : fileSize - start;
        return { 
            startByte: Math.min(start, fileSize), 
            byteCount: Math.min(count, fileSize - start) 
        };
    }
    
    return null;
}

/**
 * 读取文件内容工具（支持行范围和字节范围读取，自动处理大文件和单行文件）
 * @param params 参数
 * @param securityContext 安全上下文（可选）
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
    },
    securityContext?: PathSecurityContext
): Promise<ToolUseResult> {
    const startTime = Date.now();
    let auditLogId: string | null = null;
    
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

        // ==================== 安全验证 ====================
        if (securityContext) {
            auditLogId = logFileOperation('readFile', filePath, { fileSize }, 'low');
            
            // 验证读取安全性
            const securityCheck = validateFileRead(filePath, securityContext, fileSize);
            if (!securityCheck.allowed) {
                logBlockedOperation('readFileTool', 'readFile', filePath, securityCheck.reason || '安全检查未通过');
                const toolResult = { 
                    is_error: true, 
                    content: `安全检查未通过: ${securityCheck.reason}` 
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
            
            // 检查文件扩展名
            const ext = window['path'].extname(filePath).toLowerCase();
            if (FILE_READ_LIMITS.blockedExtensions.includes(ext)) {
                logBlockedOperation('readFileTool', 'readFile', filePath, `禁止读取此类型文件: ${ext}`);
                const toolResult = { 
                    is_error: true, 
                    content: `禁止读取此类型文件: ${ext}` 
                };
                return injectTodoReminder(toolResult, 'readFileTool');
            }
        }
        // ==================== 安全验证结束 ====================
        
        let resultContent: string;
        let metadata: any = {
            filePath,
            encoding,
            fileSize,
            fileSizeKB: (fileSize / 1024).toFixed(2),
            fileSizeMB: (fileSize / 1024 / 1024).toFixed(2)
        };

        // 参数类型转换（LLM可能传递字符串类型的数字）
        if (typeof startByte === 'string') startByte = parseInt(startByte, 10) || undefined;
        if (typeof byteCount === 'string') byteCount = parseInt(byteCount, 10) || undefined;
        if (typeof startLine === 'string') startLine = parseInt(startLine, 10) || undefined;
        if (typeof lineCount === 'string') lineCount = parseInt(lineCount, 10) || undefined;

        // 忽略无效的字节参数（0 或 NaN 视为未指定）
        if (startByte === 0 && (byteCount === undefined || byteCount === 0)) {
            startByte = undefined;
        }
        if (byteCount === 0) {
            byteCount = undefined;
        }

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
            
            // 智能读取：分析文件特征
            const characteristics = await analyzeFileCharacteristics(filePath, encoding);
            
            // 对于单行大文件或超长行文件，自动转换为字节范围读取
            if (characteristics.isSingleLineLargeFile || characteristics.hasLongLines) {
                const byteRange = convertLineRangeToByteRange(startLine, lineCount, fileSize, characteristics);
                
                if (byteRange) {
                    // 自动切换为字节模式读取
                    const fullContent = await window['fs'].readFileSync(filePath, encoding);
                    const start = byteRange.startByte;
                    const count = Math.min(byteRange.byteCount, maxSize);
                    
                    resultContent = fullContent.substring(start, start + count);
                    
                    metadata.readMode = 'bytes (auto-converted from lines)';
                    metadata.originalRequest = { startLine, lineCount };
                    metadata.startByte = start;
                    metadata.actualBytesRead = resultContent.length;
                    metadata.truncated = start + count < fileSize;
                    metadata.smartReadInfo = {
                        reason: characteristics.isSingleLineLargeFile 
                            ? '检测到单行大文件，自动切换为字节读取' 
                            : '检测到超长行，自动切换为字节读取',
                        fileCharacteristics: {
                            totalLines: characteristics.totalLines,
                            maxLineLength: characteristics.maxLineLength,
                            avgLineLength: Math.round(characteristics.avgLineLength)
                        }
                    };
                    
                    const toolResult = { 
                        is_error: false, 
                        content: resultContent,
                        metadata
                    };
                    return injectTodoReminder(toolResult, 'readFileTool');
                }
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
        
        // 记录成功
        if (auditLogId) {
            completeAuditLog(auditLogId, true, { duration: Date.now() - startTime });
        }
        
        const toolResult = { 
            is_error: false, 
            content: resultContent,
            metadata
        };
        return injectTodoReminder(toolResult, 'readFileTool');
    } catch (error: any) {
        console.warn("读取文件失败:", error);
        
        // 记录失败
        if (auditLogId) {
            completeAuditLog(auditLogId, false, { 
                duration: Date.now() - startTime,
                errorMessage: error.message 
            });
        }
        
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
