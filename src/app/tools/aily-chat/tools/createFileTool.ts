import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";
import { lintAndFormat, shouldLint } from "../services/lintService";
import { 
    PathSecurityContext, 
    validateFileWrite,
    FILE_WRITE_LIMITS,
    normalizePath 
} from "../services/security.service";
import { 
    logFileOperation, 
    completeAuditLog, 
    logBlockedOperation 
} from "../services/audit-log.service";

/**
 * 创建文件工具
 * @param params 参数
 * @param securityContext 安全上下文（可选）
 * @returns 工具执行结果
 */
export async function createFileTool(
    params: {
        path: string;
        content?: string;
        encoding?: string;
        overwrite?: boolean;
    },
    securityContext?: PathSecurityContext
): Promise<ToolUseResult> {
    const startTime = Date.now();
    let auditLogId: string | null = null;
    
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

        // ==================== 安全验证 ====================
        if (securityContext) {
            auditLogId = logFileOperation('createFile', filePath, { contentLength: content.length }, 'medium');
            
            // 验证写入安全性
            const securityCheck = validateFileWrite(filePath, securityContext, content.length);
            if (!securityCheck.allowed) {
                logBlockedOperation('createFileTool', 'createFile', filePath, securityCheck.reason || '安全检查未通过');
                const toolResult = { 
                    is_error: true, 
                    content: `安全检查未通过: ${securityCheck.reason}` 
                };
                return injectTodoReminder(toolResult, 'createFileTool');
            }
            
            // 检查写入大小限制
            if (content.length > FILE_WRITE_LIMITS.maxWriteSize) {
                const toolResult = { 
                    is_error: true, 
                    content: `写入内容过大: ${(content.length / 1024 / 1024).toFixed(2)}MB，超过限制 ${FILE_WRITE_LIMITS.maxWriteSize / 1024 / 1024}MB` 
                };
                return injectTodoReminder(toolResult, 'createFileTool');
            }
        }
        // ==================== 安全验证结束 ====================

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
        
        // 创建备份（如果文件存在且配置了备份）
        if (securityContext && FILE_WRITE_LIMITS.createBackup && window['fs'].existsSync(filePath)) {
            try {
                const ext = window['path'].extname(filePath);
                const baseName = window['path'].basename(filePath, ext);
                const dirName = window['path'].dirname(filePath);
                const backupPath = window['path'].join(dirName, `${FILE_WRITE_LIMITS.backupPrefix}${baseName}${ext}`);
                const originalContent = await window['fs'].readFileSync(filePath, 'utf-8');
                await window['fs'].writeFileSync(backupPath, originalContent);
            } catch (backupError) {
                console.warn('备份文件失败:', backupError);
            }
        }
        
        // 写入文件
        // console.log(`写入文件内容，长度: ${content.length}`);
        await window['fs'].writeFileSync(filePath, content, encoding);
        
        // 对 .json 和 .js 文件进行 lint 检测
        let lintMessage = '';
        if (shouldLint(filePath) && content) {
            lintMessage = lintAndFormat(content, filePath);
        }
        
        // 如果有 lint 错误，返回带警告的结果
        if (lintMessage) {
            const toolResult = { 
                is_error: true, 
                content: `文件创建成功: ${filePath}${lintMessage}` 
            };
            return injectTodoReminder(toolResult, 'createFileTool');
        }

        // 记录成功
        if (auditLogId) {
            completeAuditLog(auditLogId, true, { duration: Date.now() - startTime });
        }
        
        const toolResult = { 
            is_error: false, 
            content: `文件创建成功: ${filePath}` 
        };
        return injectTodoReminder(toolResult, 'createFileTool');
    } catch (error: any) {
        console.warn("创建文件失败:", error);
        
        // 记录失败
        if (auditLogId) {
            completeAuditLog(auditLogId, false, { 
                duration: Date.now() - startTime,
                errorMessage: error.message 
            });
        }
        
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
