import { loadHardwareHostSnapshot } from '@/runtime/hardware-host'

import type { Core } from '@/core-service'
import type { Desktop } from '@/desktop-service'
import type { ModelDeployState } from './types'

export const loadModelDeployState = async (
	core: Core,
	desktop: NonNullable<Desktop> | null
): Promise<ModelDeployState> => {
	const snapshot = await loadHardwareHostSnapshot(core, desktop, 'sscma_xiao_ai_s3')

	return {
		health: snapshot.health,
		deployTargetCount: 2,
		serialPortCount: snapshot.serialPorts.ports.length,
		platform: snapshot.serialPorts.platform,
		probeCount: snapshot.probes.probes?.length ?? 0,
		esptoolAvailable: snapshot.esptool?.installed ?? false,
		firmwareVersion: snapshot.firmware?.fwv ? String(snapshot.firmware.fwv) : null
	}
}
