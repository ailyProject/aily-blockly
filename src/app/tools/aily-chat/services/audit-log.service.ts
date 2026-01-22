/**
 * Aily Blockly 审计日志服务
 * 记录所有工具调用和操作，用于安全审计和异常检测
 * 
 * @see docs/aily-security-guidelines.md
 */

import { sanitizeForLogging } from './security.service';

// ==================== 类型定义 ====================

export type OperationResult = 'success' | 'failure' | 'blocked' | 'pending';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AuditLog {
    /** 日志ID */
    id: string;
    /** 记录时间戳 */
    timestamp: Date;
    /** 操作类型 */
    operation: string;
    /** 使用的工具 */
    tool: string;
    /** 操作目标（文件路径、命令等） */
    target: string;
    /** 操作参数（已脱敏） */
    params: any;
    /** 操作结果 */
    result: OperationResult;
    /** 会话 ID */
    sessionId: string;
    /** 拒绝原因（如果被拒绝） */
    blockReason?: string;
    /** 风险等级 */
    riskLevel?: RiskLevel;
    /** 执行时长（毫秒） */
    duration?: number;
    /** 错误信息 */
    errorMessage?: string;
    /** 额外元数据 */
    metadata?: Record<string, any>;
}

export interface AuditLogEntry {
    operation: string;
    tool: string;
    target: string;
    params?: any;
    sessionId?: string;
    riskLevel?: RiskLevel;
    metadata?: Record<string, any>;
}

export interface SuspiciousPatternResult {
    detected: boolean;
    patterns: string[];
    severity: 'warning' | 'alert' | 'critical';
    description?: string;
}

export interface AuditSummary {
    totalOperations: number;
    successCount: number;
    failureCount: number;
    blockedCount: number;
    pendingCount: number;
    byTool: Record<string, number>;
    byOperation: Record<string, number>;
    suspiciousActivities: number;
    timeRange: {
        start: Date;
        end: Date;
    };
}

// ==================== 常量配置 ====================

/** 日志保留数量 */
const MAX_LOG_ENTRIES = 1000;

/** 异常检测时间窗口（毫秒） */
const DETECTION_WINDOW = 60000; // 1分钟

/** 删除操作阈值 */
const DELETE_THRESHOLD = 10;

/** 目录访问阈值 */
const DIRECTORY_ACCESS_THRESHOLD = 20;

/** 被阻止操作阈值 */
const BLOCKED_THRESHOLD = 5;

// ==================== 审计日志服务类 ====================

class AuditLogService {
    private logs: AuditLog[] = [];
    private sessionId: string = '';
    private operationCounter: number = 0;

    constructor() {
        this.sessionId = this.generateSessionId();
    }

    /**
     * 生成会话ID
     */
    private generateSessionId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * 生成日志ID
     */
    private generateLogId(): string {
        this.operationCounter++;
        return `log_${Date.now()}_${this.operationCounter}`;
    }

    /**
     * 设置当前会话ID
     */
    setSessionId(sessionId: string): void {
        this.sessionId = sessionId;
    }

    /**
     * 获取当前会话ID
     */
    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * 创建新的审计日志条目
     */
    createLog(entry: AuditLogEntry): AuditLog {
        const log: AuditLog = {
            id: this.generateLogId(),
            timestamp: new Date(),
            operation: entry.operation,
            tool: entry.tool,
            target: entry.target,
            params: sanitizeForLogging(entry.params),
            result: 'pending',
            sessionId: entry.sessionId || this.sessionId,
            riskLevel: entry.riskLevel,
            metadata: entry.metadata,
        };

        this.addLog(log);
        return log;
    }

    /**
     * 记录操作开始
     */
    startOperation(entry: AuditLogEntry): string {
        const log = this.createLog(entry);
        return log.id;
    }

    /**
     * 记录操作完成
     */
    completeOperation(
        logId: string, 
        result: OperationResult, 
        options?: {
            duration?: number;
            errorMessage?: string;
            blockReason?: string;
            metadata?: Record<string, any>;
        }
    ): void {
        const log = this.logs.find(l => l.id === logId);
        if (log) {
            log.result = result;
            if (options?.duration !== undefined) {
                log.duration = options.duration;
            }
            if (options?.errorMessage) {
                log.errorMessage = options.errorMessage;
            }
            if (options?.blockReason) {
                log.blockReason = options.blockReason;
            }
            if (options?.metadata) {
                log.metadata = { ...log.metadata, ...options.metadata };
            }
        }
    }

    /**
     * 快速记录成功操作
     */
    logSuccess(entry: AuditLogEntry, duration?: number): void {
        const log = this.createLog(entry);
        log.result = 'success';
        if (duration !== undefined) {
            log.duration = duration;
        }
    }

    /**
     * 快速记录失败操作
     */
    logFailure(entry: AuditLogEntry, errorMessage: string, duration?: number): void {
        const log = this.createLog(entry);
        log.result = 'failure';
        log.errorMessage = errorMessage;
        if (duration !== undefined) {
            log.duration = duration;
        }
    }

    /**
     * 快速记录被阻止的操作
     */
    logBlocked(entry: AuditLogEntry, blockReason: string): void {
        const log = this.createLog(entry);
        log.result = 'blocked';
        log.blockReason = blockReason;
        log.riskLevel = log.riskLevel || 'high';
    }

    /**
     * 添加日志条目
     */
    private addLog(log: AuditLog): void {
        this.logs.push(log);
        
        // 限制日志数量
        if (this.logs.length > MAX_LOG_ENTRIES) {
            this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
        }
        
        // 输出到控制台（开发模式）
        if (process.env['NODE_ENV'] === 'development') {
            this.logToConsole(log);
        }
    }

    /**
     * 输出日志到控制台
     */
    private logToConsole(log: AuditLog): void {
        const statusIcon = {
            'success': '✅',
            'failure': '❌',
            'blocked': '🚫',
            'pending': '⏳'
        }[log.result];

        const riskIcon = {
            'low': '🟢',
            'medium': '🟡',
            'high': '🟠',
            'critical': '🔴'
        }[log.riskLevel || 'low'];

        console.log(
            `[Audit] ${statusIcon} ${riskIcon} [${log.tool}] ${log.operation} -> ${log.target}`,
            log.blockReason ? `(Blocked: ${log.blockReason})` : ''
        );
    }

    /**
     * 获取最近的日志
     */
    getRecentLogs(count: number = 50): AuditLog[] {
        return this.logs.slice(-count);
    }

    /**
     * 获取指定时间范围内的日志
     */
    getLogsByTimeRange(startTime: Date, endTime: Date): AuditLog[] {
        return this.logs.filter(log => 
            log.timestamp >= startTime && log.timestamp <= endTime
        );
    }

    /**
     * 获取指定工具的日志
     */
    getLogsByTool(tool: string): AuditLog[] {
        return this.logs.filter(log => log.tool === tool);
    }

    /**
     * 获取被阻止的操作日志
     */
    getBlockedLogs(): AuditLog[] {
        return this.logs.filter(log => log.result === 'blocked');
    }

    /**
     * 获取失败的操作日志
     */
    getFailedLogs(): AuditLog[] {
        return this.logs.filter(log => log.result === 'failure');
    }

    /**
     * 检测可疑操作模式
     */
    detectSuspiciousPattern(): SuspiciousPatternResult {
        const now = Date.now();
        const recentLogs = this.logs.filter(
            log => now - log.timestamp.getTime() < DETECTION_WINDOW
        );

        const detectedPatterns: string[] = [];
        let severity: 'warning' | 'alert' | 'critical' = 'warning';

        // 1. 检测短时间内大量删除操作
        const deleteOps = recentLogs.filter(
            log => log.operation === 'delete' || 
                   log.operation === 'deleteFile' || 
                   log.operation === 'deleteFolder'
        );
        if (deleteOps.length > DELETE_THRESHOLD) {
            detectedPatterns.push(`短时间内大量删除操作 (${deleteOps.length}次)`);
            severity = 'alert';
        }

        // 2. 检测频繁访问不同目录
        const uniqueDirs = new Set(
            recentLogs
                .map(log => {
                    try {
                        return window['path'].dirname(log.target);
                    } catch {
                        return log.target;
                    }
                })
                .filter(Boolean)
        );
        if (uniqueDirs.size > DIRECTORY_ACCESS_THRESHOLD) {
            detectedPatterns.push(`频繁访问不同目录 (${uniqueDirs.size}个)`);
            severity = 'alert';
        }

        // 3. 检测多次被阻止的操作
        const blockedOps = recentLogs.filter(log => log.result === 'blocked');
        if (blockedOps.length > BLOCKED_THRESHOLD) {
            detectedPatterns.push(`多次被阻止的操作 (${blockedOps.length}次)`);
            severity = 'critical';
        }

        // 4. 检测连续失败的操作
        const failedOps = recentLogs.filter(log => log.result === 'failure');
        if (failedOps.length > 5) {
            detectedPatterns.push(`连续失败的操作 (${failedOps.length}次)`);
            if (severity === 'warning') {
                severity = 'alert';
            }
        }

        // 5. 检测敏感路径访问尝试
        const sensitiveAccess = recentLogs.filter(
            log => log.riskLevel === 'high' || log.riskLevel === 'critical'
        );
        if (sensitiveAccess.length > 3) {
            detectedPatterns.push(`敏感路径访问尝试 (${sensitiveAccess.length}次)`);
            severity = 'critical';
        }

        return {
            detected: detectedPatterns.length > 0,
            patterns: detectedPatterns,
            severity,
            description: detectedPatterns.length > 0 
                ? `检测到可疑活动: ${detectedPatterns.join('; ')}` 
                : undefined
        };
    }

    /**
     * 生成审计摘要
     */
    generateSummary(timeRange?: { start: Date; end: Date }): AuditSummary {
        const logs = timeRange 
            ? this.getLogsByTimeRange(timeRange.start, timeRange.end)
            : this.logs;

        const byTool: Record<string, number> = {};
        const byOperation: Record<string, number> = {};

        let successCount = 0;
        let failureCount = 0;
        let blockedCount = 0;
        let pendingCount = 0;

        logs.forEach(log => {
            // 统计结果
            switch (log.result) {
                case 'success': successCount++; break;
                case 'failure': failureCount++; break;
                case 'blocked': blockedCount++; break;
                case 'pending': pendingCount++; break;
            }

            // 按工具统计
            byTool[log.tool] = (byTool[log.tool] || 0) + 1;

            // 按操作统计
            byOperation[log.operation] = (byOperation[log.operation] || 0) + 1;
        });

        const suspiciousResult = this.detectSuspiciousPattern();

        return {
            totalOperations: logs.length,
            successCount,
            failureCount,
            blockedCount,
            pendingCount,
            byTool,
            byOperation,
            suspiciousActivities: suspiciousResult.patterns.length,
            timeRange: {
                start: logs.length > 0 ? logs[0].timestamp : new Date(),
                end: logs.length > 0 ? logs[logs.length - 1].timestamp : new Date()
            }
        };
    }

    /**
     * 导出日志（JSON格式）
     */
    exportLogs(): string {
        return JSON.stringify(this.logs, null, 2);
    }

    /**
     * 清除所有日志
     */
    clearLogs(): void {
        this.logs = [];
        this.operationCounter = 0;
    }

    /**
     * 清除指定会话的日志
     */
    clearSessionLogs(sessionId: string): void {
        this.logs = this.logs.filter(log => log.sessionId !== sessionId);
    }
}

// ==================== 单例实例 ====================

export const auditLogService = new AuditLogService();

// ==================== 便捷函数 ====================

/**
 * 记录文件操作
 */
export function logFileOperation(
    operation: string,
    filePath: string,
    params?: any,
    riskLevel?: RiskLevel
): string {
    return auditLogService.startOperation({
        operation,
        tool: 'fileOperation',
        target: filePath,
        params,
        riskLevel
    });
}

/**
 * 记录命令执行
 */
export function logCommandExecution(
    command: string,
    cwd: string,
    riskLevel?: RiskLevel
): string {
    return auditLogService.startOperation({
        operation: 'executeCommand',
        tool: 'command',
        target: command,
        params: { cwd },
        riskLevel
    });
}

/**
 * 记录块操作
 */
export function logBlockOperation(
    operation: string,
    blockId: string,
    params?: any
): string {
    return auditLogService.startOperation({
        operation,
        tool: 'blockly',
        target: blockId,
        params,
        riskLevel: 'low'
    });
}

/**
 * 完成操作记录
 */
export function completeAuditLog(
    logId: string,
    success: boolean,
    options?: {
        duration?: number;
        errorMessage?: string;
        blockReason?: string;
    }
): void {
    auditLogService.completeOperation(
        logId,
        success ? 'success' : 'failure',
        options
    );
}

/**
 * 记录被阻止的操作
 */
export function logBlockedOperation(
    tool: string,
    operation: string,
    target: string,
    reason: string,
    riskLevel: RiskLevel = 'high'
): void {
    auditLogService.logBlocked({
        operation,
        tool,
        target,
        riskLevel
    }, reason);
}

// ==================== 导出 ====================

export {
    AuditLogService,
    auditLogService as default
};
