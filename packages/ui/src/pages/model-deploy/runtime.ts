import type { Core } from '@/core-service'
import type { AilyCoreServiceHealth } from 'shared'

export interface ModelDeployState {
	health: AilyCoreServiceHealth
	deployTargetCount: number
}

export const loadModelDeployState = async (core: Core): Promise<ModelDeployState> => {
	const health = await core.health.query()

	return {
		health,
		deployTargetCount: 2
	}
}
