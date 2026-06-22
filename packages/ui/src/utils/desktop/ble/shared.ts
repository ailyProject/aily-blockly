import type { DesktopBleBrowserApi, DesktopBleBrowserDevice } from './types'

const BLE_OTA_SERVICE_UUID = '00008018-0000-1000-8000-00805f9b34fb'
const BLE_PREFERRED_DEVICE_STORAGE_KEY = 'aily.ble.preferredDeviceId'

const getBluetooth = () => (navigator as Navigator & { bluetooth?: DesktopBleBrowserApi }).bluetooth
const knownBleDevices = new Map<string, DesktopBleBrowserDevice>()

const readStoredPreferredBleDeviceId = () => {
	if (typeof localStorage === 'undefined') return ''
	try {
		return String(localStorage.getItem(BLE_PREFERRED_DEVICE_STORAGE_KEY) || '')
	} catch {
		return ''
	}
}

const writeStoredPreferredBleDeviceId = (deviceId: string) => {
	if (typeof localStorage === 'undefined') return
	try {
		if (deviceId.trim()) {
			localStorage.setItem(BLE_PREFERRED_DEVICE_STORAGE_KEY, deviceId.trim())
			return
		}
		localStorage.removeItem(BLE_PREFERRED_DEVICE_STORAGE_KEY)
	} catch {
		return
	}
}

let selectedBleDeviceId = readStoredPreferredBleDeviceId()

/**
 * 读取当前浏览器 Bluetooth 句柄。
 */
export const getDesktopBluetooth = getBluetooth

/**
 * 读取 BLE OTA service UUID。
 */
export const getDesktopBleOtaServiceUuid = () => BLE_OTA_SERVICE_UUID

/**
 * 记录已授权 BLE 设备。
 * @param device - 浏览器 BLE 设备对象
 */
export const rememberDesktopBleDevice = (device: DesktopBleBrowserDevice) => {
	knownBleDevices.set(device.id, device)
}

/**
 * 读取当前已授权 BLE 设备对象。
 * @param deviceId - 设备 ID
 */
export const readDesktopBleDevice = (deviceId: string) => knownBleDevices.get(deviceId) ?? null

/**
 * 读取当前首选 BLE 设备 ID。
 */
export const readDesktopPreferredBleDeviceId = () => selectedBleDeviceId.trim()

/**
 * 写入当前首选 BLE 设备 ID，并同步本地持久化。
 * @param deviceId - 目标设备 ID
 */
export const writeDesktopPreferredBleDeviceId = (deviceId: string) => {
	selectedBleDeviceId = deviceId.trim()
	writeStoredPreferredBleDeviceId(selectedBleDeviceId)
}
