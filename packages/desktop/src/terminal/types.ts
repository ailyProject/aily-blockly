import type { TerminalExecuteResult, TerminalSessionInfo, TerminalStreamEvent } from 'shared'

/**
 * 终端会话创建选项。
 */
export interface DesktopTerminalCreateOptions {
	/** 工作目录。 */
	cwd?: string
	/** 终端列数。 */
	cols?: number
	/** 终端行数。 */
	rows?: number
}

/**
 * 终端会话管理器。
 */
export interface DesktopTerminalManager {
	/** 创建终端会话。 */
	createSession(options?: DesktopTerminalCreateOptions): Promise<TerminalSessionInfo>
	/** 向终端写入输入。 */
	write(sessionId: string, data: string): Promise<void>
	/** 执行一次命令并等待输出稳定。 */
	executeOnce(sessionId: string, command: string, idleTimeoutMs?: number): Promise<TerminalExecuteResult>
	/** 向终端发送 Ctrl+C 中断。 */
	interrupt(sessionId: string): Promise<void>
	/** 调整终端大小。 */
	resize(sessionId: string, cols: number, rows: number): Promise<void>
	/** 关闭终端会话。 */
	close(sessionId: string): Promise<void>
	/** 订阅终端输出流。 */
	subscribe(sessionId: string, listener: (event: TerminalStreamEvent) => void): () => void
}
