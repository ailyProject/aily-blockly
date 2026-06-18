import type { Core } from '@/core-service'
import type { ModelDeployState } from './types'

export const loadModelDeployState = async (core: Core): Promise<ModelDeployState> => {
	const health = await core.health.query()

	return {
		health,
		deployTargetCount: 2
	}
}
