import type { IpcMainInvokeEvent } from 'electron'

/**
 * 创建 ERPC 上下文时传入的宿主参数
 */
export interface CreateContextOptions {
	/** 当前 IPC 调用对应的 Electron 事件对象 */
	event: IpcMainInvokeEvent
}
