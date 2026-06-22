import type { BrowserWindow, WebContents } from 'electron'
import type { BleDeviceItem } from 'shared'

export type { BleDeviceItem } from 'shared'

/**
 * Electron chooser 返回的原始 BLE 设备结构。
 */
export interface DesktopBleRawDevice {
	/** Electron 原生 chooser 提供的设备 ID。 */
	deviceId?: string
	/** 某些平台或适配层使用的通用设备 ID 字段。 */
	id?: string
	/** 某些历史数据结构里的设备 ID 字段。 */
	device_id?: string
	/** 设备蓝牙地址；缺失标准 ID 时作为兜底标识。 */
	address?: string
	/** Electron chooser 提供的设备显示名。 */
	deviceName?: string
	/** 某些平台或适配层使用的通用设备名字段。 */
	name?: string
	/** 某些历史数据结构里的设备名字段。 */
	device_name?: string
}

/**
 * Desktop BLE bridge 对外暴露的注册结果。
 */
export interface DesktopBleBridge {
	/** 给某个 BrowserWindow 挂接 Web Bluetooth chooser。 */
	registerChooser(window: BrowserWindow): void
	/** 绑定主进程 BLE IPC handler。 */
	registerHandlers(): void
	/** 判断当前 sender 是否已有待处理选择请求。 */
	hasPendingSelection(sender: WebContents): boolean
	/** 订阅某个 sender 的 BLE 设备列表。 */
	subscribeDeviceList(sender: WebContents, listener: (devices: Array<BleDeviceItem>) => void): () => void
	/** 选择当前待处理的设备。 */
	selectDevice(sender: WebContents, deviceId: string): Promise<{ success: boolean; error?: string }>
	/** 设置首选设备。 */
	setPreferredDevice(sender: WebContents, deviceId: string): Promise<{ success: boolean; error?: string }>
	/** 取消当前设备请求。 */
	cancelDeviceRequest(sender: WebContents): Promise<{ success: boolean; error?: string }>
	/** 开始设备列表更新。 */
	startDeviceListUpdates(sender: WebContents): Promise<{ success: boolean; error?: string }>
	/** 停止设备列表更新。 */
	stopDeviceListUpdates(sender: WebContents): Promise<{ success: boolean; error?: string }>
	/** 读取 BLE chooser 调试状态。 */
	debugState(sender: WebContents): Promise<Record<string, unknown>>
}
