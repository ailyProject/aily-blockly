import { config } from '@/workspace'

import type { Core } from '@/core-service'
import type { RecentModelProject } from 'shared'
import type { ModelTrainState } from './types'

export const loadModelTrainState = async (core: Core): Promise<ModelTrainState> => {
	const recentModels = await core.project.getRecentModelProjects.query({ config })

	return {
		recentModels,
		classificationCount: recentModels.filter(item => item.modelType === 'classification').length,
		detectionCount: recentModels.filter(item => item.modelType === 'detection').length
	}
}
