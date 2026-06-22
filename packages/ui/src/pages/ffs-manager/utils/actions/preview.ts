import { toFfsByteArray } from './shared'

import type { Core } from '@/utils/core'
import type { FfsExplorerEntry, FfsManagerState } from '../../types'

/**
 * 读取文本文件预览。
 * @param options - 预览输入
 */
export const readFfsTextPreview = async (options: {
	core: Core
	currentState: FfsManagerState
	imageBytes: Uint8Array
	entry: Pick<FfsExplorerEntry, 'fullPath'>
}) =>
	options.core.ffs.readImageFilePreview.query({
		partition: options.currentState.preview.partition,
		bytes: toFfsByteArray(options.imageBytes),
		path: options.entry.fullPath
	})
