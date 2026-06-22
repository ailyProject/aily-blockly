import type { Session } from 'electron'

const isAllowedWebDevicePermission = (permission: string) =>
	permission === 'serial' || permission === 'bluetooth' || permission === 'bluetoothScanning'

const isAllowedWebDeviceType = (deviceType: string) =>
	deviceType === 'serial' || deviceType === 'bluetooth' || deviceType === 'bluetoothLE'

/**
 * 给 Electron session 安装 BLE/serial 相关的授权规则。
 * @param session - BrowserWindow 对应的 session
 */
export const setupDesktopBlePermissions = (session: Session) => {
	if (typeof session.setBluetoothPairingHandler === 'function') {
		session.setBluetoothPairingHandler((_details, callback) => {
			callback({ confirmed: true })
		})
	}

	session.setPermissionCheckHandler((_contents, permission) => isAllowedWebDevicePermission(permission))
	session.setPermissionRequestHandler((_contents, permission, callback) => {
		callback(isAllowedWebDevicePermission(permission))
	})
	session.setDevicePermissionHandler(details => isAllowedWebDeviceType(details.deviceType))
}
