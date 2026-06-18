import { loadDesktopHostRuntimeInfo } from '@/desktop-service'
import { config } from '@/workspace'

import type { Core } from '@/core-service'
import type { Desktop } from '@/desktop-service'
import type { HardwareFirmwareType } from '@core'

/**
 * 加载硬件宿主快照。
 * @param {Core} core - core 服务句柄
 * @param {NonNullable<Desktop> | null} desktop - desktop ERPC 句柄
 * @param {HardwareFirmwareType} firmwareType - 固件类型
 * @returns {Promise<{
 * health: Awaited<ReturnType<Core['health']['query']>>,
 * probes: Awaited<ReturnType<Core['hardware']['listProbes']['query']>>,
 * serialPorts: Awaited<ReturnType<Core['hardware']['listSerialPorts']['query']>>,
 * firmware: Awaited<ReturnType<Core['hardware']['getFirmwareInfo']['query']>>,
 * desktopRuntime: Awaited<ReturnType<NonNullable<Desktop>['host']['getRuntimeInfo']['query']>> | null,
 * esptool: Awaited<ReturnType<Core['hardware']['detectEsptool']['query']>> | null
 * }>}
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
