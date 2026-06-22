import { AILY_API_SERVER, AILY_MODEL_DETAIL_PATH, AILY_MODEL_LIST_PATH, DEFAULT_REGION_KEY } from 'shared'

import { getCurrentApiServer, getSelectedLanguage } from '../project'
import { getModelCatalogFallback } from './fixtures'
import { normalizeModelCatalogDetail, normalizeModelCatalogItem } from './normalize'

import type { AilyAppConfig, ModelCatalogDetail, ModelCatalogListResult } from 'shared'
import type {
	ModelCatalogDetailRequest,
	ModelCatalogRequest,
	RemoteModelDetailResponse,
	RemoteModelListResponse
} from './types'

const trimTrailingSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url)
const fallback = getModelCatalogFallback()

const resolveApiServer = (config?: AilyAppConfig) =>
	trimTrailingSlash(getCurrentApiServer(config?.regions, config?.region, DEFAULT_REGION_KEY) || AILY_API_SERVER)

const resolveLanguage = (config?: AilyAppConfig, language?: string) =>
	language || getSelectedLanguage(config, config?.lang || 'en')

/**
 * 加载模型目录列表。
 * @param input - 模型目录查询参数
 */
export const listModelCatalog = async (input: ModelCatalogRequest = {}): Promise<ModelCatalogListResult> => {
	const page = input.query?.page ?? 1
	const pageSize = input.query?.pageSize ?? 24

	try {
		const params = new URLSearchParams({
			page: String(page),
			length: String(pageSize),
			uniform_type: input.query?.uniformType ?? '',
			lang: resolveLanguage(input.config, input.query?.language),
			search: input.query?.search ?? ''
		})
		const response = await fetch(`${resolveApiServer(input.config)}${AILY_MODEL_LIST_PATH}?${params.toString()}`)
		if (!response.ok) throw new Error(`model list request failed: ${response.status}`)

		const payload = (await response.json()) as RemoteModelListResponse
		const items = (payload.data?.list || []).map(normalizeModelCatalogItem)
		const total = Number.parseInt(payload.data?.total || '0', 10) || items.length

		return {
			items,
			total,
			totalPages: Math.max(1, Math.ceil(total / pageSize)),
			page,
			pageSize,
			source: 'remote'
		}
	} catch {
		const items = fallback.items.filter(item => {
			const search = (input.query?.search || '').trim().toLowerCase()
			if (!search) return true
			return `${item.name} ${item.authorName} ${item.description} ${item.scenario}`.toLowerCase().includes(search)
		})

		return {
			items,
			total: items.length,
			totalPages: 1,
			page,
			pageSize,
			source: 'fallback'
		}
	}
}

/**
 * 加载模型目录详情。
 * @param input - 模型详情查询参数
 */
export const getModelCatalogDetail = async (input: ModelCatalogDetailRequest): Promise<ModelCatalogDetail | null> => {
	try {
		const params = new URLSearchParams({
			model_id: input.modelId,
			lang: resolveLanguage(input.config, input.language)
		})
		const response = await fetch(`${resolveApiServer(input.config)}${AILY_MODEL_DETAIL_PATH}?${params.toString()}`)
		if (!response.ok) throw new Error(`model detail request failed: ${response.status}`)

		const payload = (await response.json()) as RemoteModelDetailResponse
		return payload.data ? normalizeModelCatalogDetail(payload.data) : null
	} catch {
		return fallback.details[input.modelId] || null
	}
}
