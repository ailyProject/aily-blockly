/**
 * 安全工具包装器
 * 提供便捷的方法来创建带安全上下文的工具调用
 * 
 * @see docs/aily-security-guidelines.md
 */

import { PathSecurityContext, createSecurityContext } from './security.service';
import { auditLogService } from './audit-log.service';
import { validateCommand } from './command-security.service';

/**
 * 安全工具上下文
 */
export class SecurityToolContext {
    private context: PathSecurityContext;
    private projectRootPath: string;
    private currentProjectPath: string;
    private appDataPath: string;
    
    constructor(
        projectRootPath: string,
        currentProjectPath: string,
        appDataPath?: string
    ) {
        this.projectRootPath = projectRootPath;
        this.currentProjectPath = currentProjectPath;
        this.appDataPath = appDataPath || '';
        this.context = createSecurityContext(currentProjectPath, {
            allowProjectPathAccess: true,
            additionalAllowedPaths: appDataPath ? [appDataPath] : []
        });
    }
    
    /**
     * 获取安全上下文
     */
    getContext(): PathSecurityContext {
        return this.context;
    }
    
    /**
     * 更新项目路径
     */
    updateProjectPath(currentProjectPath: string): void {
        this.currentProjectPath = currentProjectPath;
        this.context = createSecurityContext(currentProjectPath, {
            allowProjectPathAccess: true,
            additionalAllowedPaths: this.appDataPath ? [this.appDataPath] : []
        });
    }
    
    /**
     * 获取项目根路径
     */
    getProjectRootPath(): string {
        return this.projectRootPath;
    }
    
    /**
     * 获取当前项目路径
     */
    getCurrentProjectPath(): string {
        return this.currentProjectPath;
    }
    
    /**
     * 快速验证命令
     */
    validateCommand(command: string) {
        return validateCommand(command);
    }
    
    /**
     * 获取审计日志服务
     */
    getAuditLog() {
        return auditLogService;
    }
    
    /**
     * 设置会话ID
     */
    setSessionId(sessionId: string): void {
        auditLogService.setSessionId(sessionId);
    }
}

/**
 * 全局安全工具上下文实例
 */
let globalSecurityContext: SecurityToolContext | null = null;

/**
 * 初始化全局安全上下文
 */
export function initializeSecurityContext(
    projectRootPath: string,
    currentProjectPath: string,
    appDataPath?: string
): SecurityToolContext {
    globalSecurityContext = new SecurityToolContext(projectRootPath, currentProjectPath, appDataPath);
    return globalSecurityContext;
}

/**
 * 获取全局安全上下文
 */
export function getSecurityContext(): SecurityToolContext | null {
    return globalSecurityContext;
}

/**
 * 更新全局安全上下文的项目路径
 */
export function updateSecurityContextPath(currentProjectPath: string): void {
    if (globalSecurityContext) {
        globalSecurityContext.updateProjectPath(currentProjectPath);
    }
}

/**
 * 创建安全工具调用的高阶函数
 * 自动注入安全上下文
 */
export function withSecurityContext<T extends (...args: any[]) => Promise<any>>(
    toolFn: T
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
        const context = globalSecurityContext?.getContext();
        if (context) {
            // 如果最后一个参数是对象且不是安全上下文，添加安全上下文
            const lastArg = args[args.length - 1];
            if (typeof lastArg === 'object' && lastArg !== null && !('projectRootPath' in lastArg)) {
                args = [...args, context] as Parameters<T>;
            } else if (args.length === 1 && typeof args[0] === 'object') {
                // 如果只有一个参数对象，作为第二个参数添加安全上下文
                args = [args[0], context] as any;
            }
        }
        return toolFn(...args);
    };
}

export default SecurityToolContext;
