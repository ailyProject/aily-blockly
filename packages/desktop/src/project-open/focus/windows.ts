import { execDesktopProjectOpenFocusCommand } from './shared'

import type { DesktopProjectOpenFocusResult } from './shared'

const createWindowsFocusScript = (pid: number) =>
	[
		`$process = Get-Process -Id ${pid} -ErrorAction Stop`,
		'if ($process.MainWindowHandle -eq 0) { throw "Process has no main window" }',
		"Add-Type @'",
		'using System;',
		'using System.Runtime.InteropServices;',
		'public static class CodexWindowFocus {',
		'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
		'  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
		'}',
		"'@",
		'[CodexWindowFocus]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null',
		'if (-not [CodexWindowFocus]::SetForegroundWindow($process.MainWindowHandle)) {',
		'  throw "Failed to focus process window"',
		'}'
	].join('\n')

/**
 * 在 Windows 上尝试前置指定 pid 的窗口。
 * @param pid - 目标进程 ID
 */
export const focusDesktopProjectOpenProcessOnWindows = async (pid: number): Promise<DesktopProjectOpenFocusResult> => {
	try {
		await execDesktopProjectOpenFocusCommand('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-Command',
			createWindowsFocusScript(pid)
		])
		return { success: true }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}
