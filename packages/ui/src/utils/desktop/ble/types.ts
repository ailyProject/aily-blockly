/**
 * 浏览器侧 BLE GATT 连接句柄。
 */
export interface DesktopBleBrowserGatt {
	/** 当前设备是否已处于连接态。 */
	connected: boolean
	/** 建立到远端 BLE 设备的 GATT 连接。 */
	connect(): Promise<unknown>
	/** 主动断开当前 GATT 连接。 */
	disconnect(): void
}

/**
 * 浏览器侧已授权 BLE 设备。
 */
export interface DesktopBleBrowserDevice {
	/** 浏览器分配给该设备的稳定标识。 */
	id: string
	/** 设备对用户展示的名称。 */
	name?: string
	/** 设备的 GATT 连接入口；缺失时表示当前设备不可直接建立会话。 */
	gatt?: DesktopBleBrowserGatt
}

/**
 * 浏览器环境里的 Bluetooth API 最小子集。
 */
export interface DesktopBleBrowserApi {
	/** 触发系统设备选择器，并按过滤条件请求授权。 */
	requestDevice(options: {
		filters: Array<{ services: Array<string> }>
		optionalServices?: Array<string>
	}): Promise<DesktopBleBrowserDevice>
	/** 读取当前浏览器中已授权过的设备集合。 */
	getDevices?(): Promise<Array<DesktopBleBrowserDevice>>
}
