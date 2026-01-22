import { ToolUseResult } from "./tools";
import { 
    PathSecurityContext, 
    validateFileDelete,
    isCriticalRemovalTarget,
    normalizePath 
} from "../services/security.service";
import { 
    logFileOperation, 
    completeAuditLog, 
    logBlockedOperation 
} from "../services/audit-log.service";

/**
 * 删除文件工具
 * @param params 参数
 * @param securityContext 安全上下文（可选）
 * @returns 工具执行结果
 */
export async function deleteFileTool(
    params: {
        path: string;
        createBackup?: boolean;
    },
    securityContext?: PathSecurityContext
): Promise<ToolUseResult> {
    const startTime = Date.now();
    let auditLogId: string | null = null;
    
    try {
        let { path: filePath, createBackup = true } = params;
        
        // 路径规范化
        filePath = normalizePath(filePath);
        
        // console.log("删除文件: ", filePath);

        // 验证路径是否有效
        if (!filePath || filePath.trim() === '') {
            return { 
                is_error: true, 
                content: `无效的文件路径: "${filePath}"` 
            };
        }

        // ==================== 安全验证 ====================
        if (securityContext) {
            auditLogId = logFileOperation('deleteFile', filePath, params, 'high');
            
            // 检查是否为关键删除目标
            const criticalCheck = isCriticalRemovalTarget(filePath, securityContext);
            if (!criticalCheck.allowed) {
                logBlockedOperation('deleteFileTool', 'deleteFile', filePath, criticalCheck.reason || '禁止删除关键文件');
                return { 
                    is_error: true, 
                    content: `安全检查未通过: ${criticalCheck.reason}` 
                };
            }
            
            // 验证删除安全性
            const securityCheck = validateFileDelete(filePath, securityContext);
            if (!securityCheck.allowed) {
                logBlockedOperation('deleteFileTool', 'deleteFile', filePath, securityCheck.reason || '安全检查未通过');
                return { 
                    is_error: true, 
                    content: `安全检查未通过: ${securityCheck.reason}` 
                };
            }
        }
        // ==================== 安全验证结束 ====================

        // 检查文件是否存在
        if (!window['fs'].existsSync(filePath)) {
            return {
                is_error: true,
                content: `文件不存在: ${filePath}`
            };
        }

        // 检查是否为文件（不是目录）
        const isDirectory = await window['fs'].isDirectory(filePath);
        if (isDirectory) {
            return {
                is_error: true,
                content: `路径是目录而不是文件，请使用删除文件夹工具: ${filePath}`
            };
        }

        let backupPath = '';
        
        // 创建备份
        if (createBackup) {
            const dir = window['path'].dirname(filePath);
            const filename = window['path'].basename(filePath);
            const ext = window['path'].extname(filePath);
            const baseFilename = filename.replace(ext, '');
            backupPath = window['path'].join(dir, `ABIBAK_${baseFilename}${ext}`);

            const fileContent = await window['fs'].readFileSync(filePath, 'utf-8');
            await window['fs'].writeFileSync(backupPath, fileContent);
        }

        // 删除文件
        await window['fs'].unlinkSync(filePath);
        
        // 记录成功
        if (auditLogId) {
            completeAuditLog(auditLogId, true, { duration: Date.now() - startTime });
        }
        
        let resultMessage = `文件删除成功: ${filePath}`;
        if (createBackup) {
            resultMessage += `\n备份文件: ${backupPath}`;
        }
        
        return { 
            is_error: false, 
            content: resultMessage 
        };
    } catch (error: any) {
        console.warn("删除文件失败:", error);
        
        // 记录失败
        if (auditLogId) {
            completeAuditLog(auditLogId, false, { 
                duration: Date.now() - startTime,
                errorMessage: error.message 
            });
        }
        
        let errorMessage = `删除文件失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        return { 
            is_error: true, 
            content: errorMessage + `\n目标文件: ${params.path}` 
        };
    }
}
