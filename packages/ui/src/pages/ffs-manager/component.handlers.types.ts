import type { Core } from '@/utils/core'
import type { WritableSignal } from '@angular/core'
import type { FfsManagerState } from './types'

/**
 * FFS 页面交互所需的上下文。
 */
export interface FfsManagerHandlerContext {
	core: Core
	state: WritableSignal<FfsManagerState | null>
	imageBytes: WritableSignal<Uint8Array | null>
	imageName: WritableSignal<string | null>
	previewText: WritableSignal<string | null>
	previewFilePath: WritableSignal<string | null>
	actionMessage: WritableSignal<string | null>
	previewBusy: WritableSignal<boolean>
	currentPath: WritableSignal<string>
}
