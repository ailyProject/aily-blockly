export const modelTrainTabs = [
	{ href: '/model-train', label: 'Overview' },
	{ href: '/model-train/vision', label: 'Vision' },
	{ href: '/model-train/vision/classification', label: 'Classification' },
	{ href: '/model-train/vision/detection', label: 'Detection' }
]

export const classificationChecklist = [
	'prepare labeled image folders',
	'check class balance before training',
	'pick export target for deploy'
]

export const detectionChecklist = [
	'validate bounding box quality',
	'confirm board-side memory budget',
	'preview detector output thresholds'
]
