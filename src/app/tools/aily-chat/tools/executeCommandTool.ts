import { ToolUseResult } from "./tools";
import { CmdService } from "../../../services/cmd.service";
import { injectTodoReminder } from "./todoWriteTool";
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
            const toolResults = {
                is_error,
                content: toolResult
            };
            return injectTodoReminder(toolResults, 'executeCommandTool');
        }

        // console.log('Executing command:', data.command, 'in directory:', data.cwd);

        if (!data.cwd) {
            toolResult = "执行command命令失败: 当前未打开项目";
            is_error = true;
            const toolResults = {
                is_error,
                content: toolResult
            };
            return injectTodoReminder(toolResults, 'executeCommandTool');
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
            
            const toolResults = {
                is_error,
                content: toolResult
            };
            return injectTodoReminder(toolResults, 'executeCommandTool');
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
                
                const toolResults = {
                    is_error,
                    content: toolResult
                };
                return injectTodoReminder(toolResults, 'executeCommandTool');
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
                
                const toolResults = {
                    is_error,
                    content: toolResult
                };
                return injectTodoReminder(toolResults, 'executeCommandTool');
            }
        }
        // ==================== 安全验证结束 ====================

        // 使用 Promise 包装 Observable 来等待命令执行完成
        const result = await new Promise<string>((resolve, reject) => {
            let output = '';
            
            // 设置超时
            const timeoutId = setTimeout(() => {
                reject(new Error(`命令执行超时 (${COMMAND_EXECUTION_LIMITS.timeout / 1000}秒)`));
            }, COMMAND_EXECUTION_LIMITS.timeout);
            
            cmdService.run(data.command, data.cwd, false).subscribe({
                next: (data) => {
                    // console.log(`Command output received:`, data);

                    // 正确处理CmdOutput对象，提取data字段
                    let textOutput = '';
                    if (data && data.data) {
                        textOutput = data.data;
                    } else if (data && data.error) {
                        textOutput = data.error;
                    } else {
                        textOutput = JSON.stringify(data);
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
                    resolve(output);
                }
            });
        });

        toolResult = result || '命令执行完成';
        
        // 记录成功
        if (auditLogId) {
            completeAuditLog(auditLogId, true, {
                duration: Date.now() - startTime
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
        const toolResults = {
            is_error,
            content: toolResult
        };
        return injectTodoReminder(toolResults, 'executeCommandTool');
    }
}