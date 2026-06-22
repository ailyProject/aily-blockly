import type { ModelCatalogDetail, ModelCatalogItem, ModelCatalogTask } from 'shared'
import type { RemoteModelDetail, RemoteModelListItem } from './types'

const modelTaskMap: Record<string, ModelCatalogTask> = {
	'1': 'detection',
	'2': 'classification',
	'3': 'segmentation',
	'4': 'pose',
	'5': 'generative',
	'6': 'audio'
}

const boardNameMap: Record<string, string> = {
	'26': 'reComputer Jetson',
	'32': 'XIAO ESP32S3 Sense',
	'36': 'Grove Vision AI V2',
	'37': 'SenseCAP Watcher',
	'40': 'reCamera',
	'41': 'SenseCAP A1102',
	'60': 'Easy Code ASR Module'
}

const toNumber = (value: string | undefined) => Number.parseInt(value || '0', 10) || 0
const normalizeSupportedBoards = (uniformTypes: Array<string>) =>
	uniformTypes.map(type => boardNameMap[type]).filter(Boolean)
const normalizeDeployTarget = (authorName: string) =>
	authorName === 'ChipIntelli' ? 'chipintelli' : authorName === 'SenseCraft AI' ? 'sscma' : 'generic'

/**
 * 归一化模型任务类型。
 * @param task - 远端任务编号
 */
export const normalizeModelTask = (task: string | undefined): ModelCatalogTask => modelTaskMap[task || ''] || 'unknown'

/**
 * 归一化远端模型列表条目。
 * @param item - 远端模型列表条目
 */
export const normalizeModelCatalogItem = (item: RemoteModelListItem): ModelCatalogItem => ({
	id: item.id,
	name: item.name,
	description: item.description,
	authorId: item.author,
	authorName: item.author_name,
	coverUrl: item.pic_url,
	modelSize: item.model_size,
	task: normalizeModelTask(item.task),
	scenario: item.scenario,
	modelFormat: item.model_format,
	aiFramework: item.ai_framework,
	precision: item.precision,
	createdAt: item.created,
	likeCount: toNumber(item.like_num),
	followCount: toNumber(item.follow_num),
	deployCount: toNumber(item.deploy_num),
	priority: toNumber(item.priority),
	adaptedTypes: item.adapteds,
	uniformTypes: item.uniform_types,
	supportedBoards: normalizeSupportedBoards(item.uniform_types),
	deployTarget: normalizeDeployTarget(item.author_name)
})

/**
 * 归一化远端模型详情。
 * @param detail - 远端模型详情
 */
export const normalizeModelCatalogDetail = (detail: RemoteModelDetail): ModelCatalogDetail => ({
	...normalizeModelCatalogItem(detail),
	content: detail.content,
	fileUrl: detail.file_url,
	preparation: detail.preparation,
	checksum: detail.checksum,
	iou: detail.attr?.iou || '',
	confidence: detail.attr?.conf || '',
	enabled: detail.is_enabled,
	version: detail.version,
	labels: detail.labels.map(label => ({ id: label.object_id, name: label.object_name }))
})
