import { computed, signal } from '@angular/core'

import { buildFfsBreadcrumbs, buildFfsExplorerEntries } from './explorer'

import type { FfsManagerState } from '../types'

/**
 * 创建 FFS 页面本地视图模型。
 * @param state - 页面主状态信号
 */
export const createFfsManagerViewModel = (state: ReturnType<typeof signal<FfsManagerState | null>>) => {
	const imageBytes = signal<Uint8Array | null>(null)
	const imageName = signal<string | null>(null)
	const previewText = signal<string | null>(null)
	const previewFilePath = signal<string | null>(null)
	const actionMessage = signal<string | null>(null)
	const previewBusy = signal(false)
	const currentPath = signal('/')
	const breadcrumbs = computed(() => buildFfsBreadcrumbs(currentPath()))
	const explorerEntries = computed(() => {
		const current = state()
		if (!current) return []

		return buildFfsExplorerEntries({
			currentPath: currentPath(),
			files: current.preview.files.map(file => ({
				path: file.fullPath,
				name: file.name,
				type: file.type,
				size: file.size,
				sizeText: file.sizeText
			}))
		})
	})

	return {
		imageBytes,
		imageName,
		previewText,
		previewFilePath,
		actionMessage,
		previewBusy,
		currentPath,
		breadcrumbs,
		explorerEntries
	}
}
