import type { WorkspaceModelCatalogItem } from './types'

export const modelCatalog: Array<WorkspaceModelCatalogItem> = [
	{
		id: 'fruit-classifier',
		name: 'Fruit Classifier',
		author: 'SenseCraft AI',
		task: 'classification',
		board: 'XIAO ESP32S3 Sense',
		framework: 'TensorFlow Lite',
		size: '1.8 MB',
		summary: 'Recognize common fruits with an image pipeline tuned for edge cameras.',
		deployTarget: 'sscma',
		link: 'https://sensecraft.seeed.cc/ai/training'
	},
	{
		id: 'person-detector',
		name: 'Person Detector',
		author: 'SenseCraft AI',
		task: 'detection',
		board: 'Grove Vision AI V2',
		framework: 'TensorFlow Lite',
		size: '3.4 MB',
		summary: 'Detect people in low-latency camera streams for entrance and kiosk scenarios.',
		deployTarget: 'sscma',
		link: 'https://sensecraft.seeed.cc/ai/training'
	},
	{
		id: 'wake-word-lite',
		name: 'Wake Word Lite',
		author: 'ChipIntelli',
		task: 'audio',
		board: 'Easy Code ASR Module',
		framework: 'ChipIntelli Runtime',
		size: '860 KB',
		summary: 'Compact wake-word pipeline oriented to always-on audio interaction.',
		deployTarget: 'chipintelli',
		link: 'https://sensecraft.seeed.cc/ai/training'
	}
]
