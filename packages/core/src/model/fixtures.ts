import type { ModelCatalogDetail, ModelCatalogItem } from 'shared'
import type { ModelCatalogFallback } from './types'

const fallbackItems: Array<ModelCatalogItem> = [
	{
		id: 'fruit-classifier',
		name: 'Fruit Classifier',
		description: 'Recognize common fruits with an image pipeline tuned for edge cameras.',
		authorId: 'sensecraft-ai',
		authorName: 'SenseCraft AI',
		coverUrl: '',
		modelSize: '1.8 MB',
		task: 'classification',
		scenario: 'Edge image recognition',
		modelFormat: 'TF Lite',
		aiFramework: 'TensorFlow Lite',
		precision: 'INT8',
		createdAt: '2026-06-10',
		likeCount: 28,
		followCount: 12,
		deployCount: 9,
		priority: 10,
		adaptedTypes: ['7'],
		uniformTypes: ['32'],
		supportedBoards: ['XIAO ESP32S3 Sense'],
		deployTarget: 'sscma'
	},
	{
		id: 'person-detector',
		name: 'Person Detector',
		description: 'Detect people in low-latency camera streams for kiosk and entry scenarios.',
		authorId: 'sensecraft-ai',
		authorName: 'SenseCraft AI',
		coverUrl: '',
		modelSize: '3.4 MB',
		task: 'detection',
		scenario: 'Edge object detection',
		modelFormat: 'TF Lite',
		aiFramework: 'TensorFlow Lite',
		precision: 'INT8',
		createdAt: '2026-06-08',
		likeCount: 21,
		followCount: 8,
		deployCount: 7,
		priority: 8,
		adaptedTypes: ['11'],
		uniformTypes: ['36'],
		supportedBoards: ['Grove Vision AI V2'],
		deployTarget: 'sscma'
	},
	{
		id: 'wake-word-lite',
		name: 'Wake Word Lite',
		description: 'Compact wake-word pipeline oriented to always-on voice interaction.',
		authorId: 'chipintelli',
		authorName: 'ChipIntelli',
		coverUrl: '',
		modelSize: '860 KB',
		task: 'audio',
		scenario: 'Low-power audio trigger',
		modelFormat: 'ChipIntelli Runtime',
		aiFramework: 'ChipIntelli Runtime',
		precision: 'INT8',
		createdAt: '2026-06-06',
		likeCount: 15,
		followCount: 4,
		deployCount: 5,
		priority: 6,
		adaptedTypes: ['20'],
		uniformTypes: ['60'],
		supportedBoards: ['Easy Code ASR Module'],
		deployTarget: 'chipintelli'
	}
]

const createFallbackDetail = (item: ModelCatalogItem): ModelCatalogDetail => ({
	...item,
	content: `${item.name} is available through the fallback catalog while the remote model service is unavailable.`,
	fileUrl: '',
	preparation: ['prepare input assets', 'confirm target board', 'open deploy flow'],
	checksum: '',
	iou: '0.5',
	confidence: '0.5',
	enabled: true,
	version: 'fallback',
	labels: []
})

/**
 * 获取模型目录 fallback 数据。
 * @returns {ModelCatalogFallback}
 */
export const getModelCatalogFallback = (): ModelCatalogFallback => ({
	items: fallbackItems,
	details: Object.fromEntries(fallbackItems.map(item => [item.id, createFallbackDetail(item)]))
})
