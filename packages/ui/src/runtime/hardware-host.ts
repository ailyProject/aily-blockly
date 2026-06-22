import { loadDesktopHostRuntimeInfo } from '@/utils/desktop'
import { config } from '@/workspace'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { HardwareFirmwareType } from '@core'

/**
 * 加载硬件宿主快照。
 * @param core - core 服务句柄
 * @param desktop - desktop ERPC 句柄
 * @param firmwareType - 固件类型
 */
export const loadHardwareHostSnapshot = async (
	core: Core,
	desktop: NonNullable<Desktop> | null,
	firmwareType: HardwareFirmwareType
) => {
	const [health, probes, serialPorts, firmware, desktopRuntime] = await Promise.all([
		core.health.query(),
		core.hardware.listProbes.query(),
		core.hardware.listSerialPorts.query(),
		core.hardware.getFirmwareInfo.query({ config, firmwareType, version: null }),
		desktop ? loadDesktopHostRuntimeInfo(desktop) : Promise.resolve(null)
	])

	const esptool =
		desktopRuntime && desktopRuntime['available']
			? await core.hardware.detectEsptool.query({
					appDataPath: desktopRuntime['appDataPath'],
					platform: desktopRuntime['platform']
				})
			: null

	return {
		health,
		probes,
		serialPorts,
		firmware,
		desktopRuntime,
		esptool
	}
}
