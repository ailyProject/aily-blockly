/**
 * 终端宿主平台 Shell 类型。
 */
export type TerminalShellKind =
	/** Windows PowerShell。 */
	| 'powershell'
	/** macOS zsh。 */
	| 'zsh'
	/** Linux bash。 */
	| 'bash'

/**
 * 终端会话信息。
 */
export interface TerminalSessionInfo {
	/** 终端会话唯一标识。 */
	id: string
	/** 终端进程号。 */
	pid: number
	/** 当前 shell 类型。 */
	shell: TerminalShellKind
	/** 当前工作目录。 */
	cwd: string
	/** 当前列数。 */
	cols: number
	/** 当前行数。 */
	rows: number
}

/**
 * 一次性终端命令执行结果。
 */
export interface TerminalExecuteResult {
	/** 关联的终端会话 ID。 */
	sessionId: string
	/** 当前命令完整输出。 */
	output: string
	/** 是否因静默超时而结束采集。 */
	timedOut: boolean
	/** 当前命令的退出码；无法确定时返回空。 */
	exitCode: number | null
}

/**
 * 终端输出事件类型。
 */
export type TerminalStreamEventType =
	/** 终端标准输出或标准错误的文本片段。 */
	| 'data'
	/** 已按换行边界归一化的完整文本行。 */
	| 'line'
	/** 终端会话退出事件。 */
	| 'exit'

/**
 * 终端流事件。
 */
export interface TerminalStreamEvent {
	/** 当前事件类型。 */
	type: TerminalStreamEventType
	/** 关联的终端会话 ID。 */
	sessionId: string
	/** 文本输出内容。 */
	chunk?: string
	/** 已完成的一整行文本。 */
	line?: string
	/** 退出码。 */
	exitCode?: number
	/** 退出信号。 */
	signal?: number
}
