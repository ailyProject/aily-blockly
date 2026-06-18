import { seedAppConfig } from '@/pages/home/data'

import type { Core } from '@/core-service'
import type { RecentModelProject } from 'shared'

export interface ModelTrainState {
	recentModels: Array<RecentModelProject>
	classificationCount: number
	detectionCount: number
}

export const loadModelTrainState = async (core: Core): Promise<ModelTrainState> => {
	const recentModels = await core.project.getRecentModelProjects.query({ config: seedAppConfig })

	return {
		recentModels,
		classificationCount: recentModels.filter(item => item.modelType === 'classification').length,
		detectionCount: recentModels.filter(item => item.modelType === 'detection').length
	}
}
