/**
 * 跨端共享的 BLE 设备条目。
 */
export interface BleDeviceItem {
	/** 用于后续授权、选择和上传的稳定设备标识。 */
	deviceId: string
	/** 展示给用户的设备名称；可能来自系统蓝牙名称或厂商广播名。 */
	deviceName: string
}
