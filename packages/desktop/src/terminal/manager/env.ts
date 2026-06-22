import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TerminalShellKind } from 'shared'

/**
 * 默认终端列数。
 */
export const DEFAULT_TERMINAL_COLS = 120

/**
 * 默认终端行数。
 */
export const DEFAULT_TERMINAL_ROWS = 32

/**
 * 解析当前平台应使用的 shell 类型。
 */
export const resolveTerminalShellKind = (): TerminalShellKind =>
	process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'zsh' : 'bash'

/**
 * 解析 shell 可执行命令。
 * @param shell - shell 类型
 */
export const resolveTerminalShellCommand = (shell: TerminalShellKind) =>
	shell === 'powershell' ? 'powershell.exe' : shell === 'zsh' ? 'zsh' : 'bash'

/**
 * 解析 shell 启动参数。
 * @param shell - shell 类型
 */
export const resolveTerminalShellArgs = (shell: TerminalShellKind) =>
	shell === 'powershell' ? ['-NoProfile', '-NoLogo'] : shell === 'zsh' ? ['-f'] : ['--noprofile', '--norc']

/**
 * 生成隔离后的终端环境变量。
 */
export const resolveTerminalEnv = () => {
	const env = { ...process.env }
	if (process.platform === 'darwin') {
		const zdotdir = path.join(os.tmpdir(), 'aily-blockly-zsh')
		mkdirSync(zdotdir, { recursive: true })
		env['ZDOTDIR'] = zdotdir
	}
	return env
}

/**
 * 解析默认工作目录。
 */
export const resolveTerminalDefaultCwd = () =>
	(process.platform === 'win32' ? process.env['USERPROFILE'] : process.env['HOME']) || os.tmpdir()
