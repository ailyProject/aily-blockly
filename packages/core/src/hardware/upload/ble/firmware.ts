import path from 'node:path'

import { listHardwareUploadArtifacts } from '../buildPath'

/**
 * 从构建产物中选择 BLE OTA 优先上传的固件文件。
 * @param buildPath - 当前构建输出目录
 */
export const resolveHardwareBleUploadFirmwareFile = (buildPath: string) => {
	const files = listHardwareUploadArtifacts(buildPath).filter(filePath => filePath.toLowerCase().endsWith('.bin'))
	const appBins = files.filter(filePath => {
		const fileName = path.basename(filePath).toLowerCase()
		return !/(bootloader|partition|boot_app0|ota_data|spiffs|littlefs|filesystem|fatfs)/.test(fileName)
	})

	return appBins.find(filePath => path.basename(filePath).toLowerCase().endsWith('.ino.bin')) || appBins[0] || ''
}
