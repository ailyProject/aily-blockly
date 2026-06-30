import type { ToolUseResult } from '../core/tool-types';
import { CmdOutput, CmdService } from '../../../services/cmd.service';
import { 
    CommandSecurity, 
    validateCommand, 
    validateWorkingDirectory,
    validateFileOperationCommandPaths,
    CommandPathSecurityContext,
    COMMAND_EXECUTION_LIMITS 
} from "../services/command-security.service";
import { 
    logCommandExecution, 
    completeAuditLog, 
    logBlockedOperation 
} from "../services/audit-log.service";


export async function executeCommandTool(
    cmdService: CmdService, 
    data: any,
    securityContext?: CommandPathSecurityContext // 安全上下文参数
): Promise<ToolUseResult> {
    let toolResult = null;
    let is_error = false;
    const startTime = Date.now();
    let auditLogId: string | null = null;

    try {
        if (!data || !data.command) {
            toolResult = "执行command命令失败: 缺少必要的参数 'command'";
            is_error = true;
            return { is_error, content: toolResult };
        }

        // console.log('Executing command:', data.command, 'in directory:', data.cwd);

        if (!data.cwd) {
            toolResult = "执行command命令失败: 当前未打开项目";
            is_error = true;
            return { is_error, content: toolResult };
        }

        // ==================== 安全验证 ====================
        // 验证命令安全性
        const commandCheck = validateCommand(data.command);
        
        // 记录审计日志
        auditLogId = logCommandExecution(
            data.command, 
            data.cwd, 
            commandCheck.riskLevel === 'critical' ? 'critical' : 
            commandCheck.riskLevel === 'high' ? 'high' : 
            commandCheck.riskLevel === 'medium' ? 'medium' : 'low'
        );
        
        if (!commandCheck.allowed) {
            logBlockedOperation('executeCommandTool', 'executeCommand', data.command, commandCheck.reason || '命令被阻止');
            toolResult = `命令执行被拒绝: ${commandCheck.reason}`;
            is_error = true;
            
            if (auditLogId) {
                completeAuditLog(auditLogId, false, {
                    duration: Date.now() - startTime,
                    blockReason: commandCheck.reason
                });
            }
            
            return { is_error, content: toolResult };
        }
        
        // 验证工作目录和删除命令路径
        if (securityContext) {
            const cwdCheck = validateWorkingDirectory(data.cwd, securityContext.currentProjectPath);
            if (!cwdCheck.allowed && !cwdCheck.requiresConfirmation) {
                logBlockedOperation('executeCommandTool', 'executeCommand', data.command, cwdCheck.reason || '工作目录不允许');
                toolResult = `工作目录验证失败: ${cwdCheck.reason}`;
                is_error = true;
                
                if (auditLogId) {
                    completeAuditLog(auditLogId, false, {
                        duration: Date.now() - startTime,
                        blockReason: cwdCheck.reason
                    });
                }
                
                return { is_error, content: toolResult };
            }
            
            // 验证文件操作命令的目标路径是否在安全范围内（删除、移动、复制、修改、重定向）
            const fileOpCheck = validateFileOperationCommandPaths(
                data.command,
                data.cwd,
                securityContext
            );
            if (!fileOpCheck.allowed) {
                logBlockedOperation('executeCommandTool', 'executeCommand', data.command, fileOpCheck.reason || '文件操作路径不在允许范围内');
                toolResult = `命令执行被拒绝: ${fileOpCheck.reason}`;
                is_error = true;
                
                if (auditLogId) {
                    completeAuditLog(auditLogId, false, {
                        duration: Date.now() - startTime,
                        blockReason: fileOpCheck.reason
                    });
                }
                
                return { is_error, content: toolResult };
            }
        }
        // ==================== 安全验证结束 ====================

        // 使用 Promise 包装 Observable 来等待命令执行完成
        const result = await new Promise<{ output: string; closeEvent: CmdOutput | null }>((resolve, reject) => {
            let output = '';
            let closeEvent: CmdOutput | null = null;
            
            // 设置超时
            const timeoutId = setTimeout(() => {
                reject(new Error(`命令执行超时 (${COMMAND_EXECUTION_LIMITS.timeout / 1000}秒)`));
            }, COMMAND_EXECUTION_LIMITS.timeout);
            
            cmdService.run(data.command, data.cwd, false, true).subscribe({
                next: (chunk: CmdOutput) => {
                    // console.log(`Command output received:`, data);

                    if (chunk?.type === 'close') {
                        closeEvent = chunk;
                        return;
                    }

                    // 正确处理CmdOutput对象，提取data字段
                    let textOutput = '';
                    if (chunk && chunk.data) {
                        textOutput = chunk.data;
                    } else if (chunk && chunk.error) {
                        textOutput = chunk.error;
                    } else {
                        textOutput = '';
                    }
                    // console.log(`Command output: ${textOutput}`);
                    output += textOutput;
                    
                    // 检查输出大小限制
                    if (output.length > COMMAND_EXECUTION_LIMITS.maxOutputSize) {
                        output = output.substring(0, COMMAND_EXECUTION_LIMITS.maxOutputSize) + 
                            '\n...[输出过长，已截断]...';
                    }
                },
                error: (err) => {
                    clearTimeout(timeoutId);
                    console.warn(`Command error: ${err}`);
                    is_error = true;
                    reject(err);
                },
                complete: () => {
                    clearTimeout(timeoutId);
                    // console.log('Command execution completed');
                    resolve({ output, closeEvent });
                }
            });
        });

        const normalizedOutput = normalizeCommandOutput(result.output, result.closeEvent);
        const exitCode = result.closeEvent?.code;
        toolResult = normalizedOutput || '命令执行完成';
        if (typeof exitCode === 'number' && exitCode !== 0) {
            is_error = true;
            if (!normalizedOutput) {
                toolResult = `命令执行失败，退出码 ${exitCode}`;
            }
        }

        // 记录执行结果
        if (auditLogId) {
            completeAuditLog(auditLogId, !is_error, {
                duration: Date.now() - startTime,
                metadata: typeof exitCode === 'number' ? { exitCode } : undefined,
                errorMessage: is_error ? toolResult : undefined
            });
        }
        
    } catch (e) {
        // console.warn('执行command命令失败:', e);
        toolResult = `执行command命令失败: ${e.message}`;
        is_error = true;
        
        // 记录失败
        if (auditLogId) {
            completeAuditLog(auditLogId, false, {
                duration: Date.now() - startTime,
                errorMessage: e.message
            });
        }
    } finally {
        // console.log('executeCommandTool result:', toolResult, 'is_error:', is_error);
        return {
            is_error,
            content: toolResult
        } as ToolUseResult;
    }
}

function normalizeCommandOutput(output: string, closeEvent: CmdOutput | null): string {
    const combined = output.trim();
    if (combined) {
        return combined;
    }

    const fallback = [closeEvent?.stderr, closeEvent?.stdout]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim();

    return fallback;
}