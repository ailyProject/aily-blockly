import type { App, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { createIPCHandler } from 'erpc/main'
import type { DesktopBleBridge } from './ble'
import type { DesktopCoreServiceManager } from './core-service'
import type { Router } from './rpc'
import type { DesktopTerminalManager } from './terminal'

/**
 * Desktop tRPC 上下文
 */
export interface DesktopMainContext {
	/** 当前 desktop 管理的 core service 句柄 */
	coreService: DesktopCoreServiceManager
	/** 当前 desktop 管理的 BLE chooser bridge */
	bleBridge: DesktopBleBridge
	/** 当前 desktop 管理的 terminal 句柄 */
	terminalManager: DesktopTerminalManager
	/** 当前 IPC 调用对应的 Electron 事件 */
	event: IpcMainInvokeEvent
}

/**
 * 扩展 desktop tRPC 上下文时可附加的额外字段
 */
export interface DesktopMainContextExtension {
	/** 允许附加任意额外上下文字段 */
	[key: string]: unknown
}

/**
 * 生成额外 desktop tRPC 上下文的工厂函数
 * @param baseContext - desktop 已准备好的基础上下文
 */
export type CreateDesktopMainContext = (
	baseContext: DesktopMainContext
) => DesktopMainContextExtension | Promise<DesktopMainContextExtension>

/**
 * desktop 主进程 bootstrap 选项
 */
export interface BootstrapDesktopMainOptions {
	/** Electron App 实例，可用于注册 open-file 等桌面事件 */
	app?: App
	/** 需要接入 ERPC 的窗口列表 */
	windows?: Array<BrowserWindow>
	/** 复用外部传入的 core service manager */
	coreService?: DesktopCoreServiceManager
	/** 复用外部传入的 terminal manager */
	terminalManager?: DesktopTerminalManager
	/** 自定义补充上下文的工厂函数 */
	createContext?: CreateDesktopMainContext
}

/**
 * desktop 主进程 bootstrap 返回结果
 */
export interface BootstrapDesktopMainResult {
	/** 当前使用的 core service manager */
	coreService: DesktopCoreServiceManager
	/** 当前使用的 BLE chooser bridge */
	bleBridge: DesktopBleBridge
	/** 当前使用的 terminal manager */
	terminalManager: DesktopTerminalManager
	/** 创建出的 desktop tRPC 根路由 */
	router: Router
	/** ERPC IPC 处理器实例 */
	handler: ReturnType<typeof createIPCHandler>
}
