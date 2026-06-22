import { createFfsManagerFileHandlers } from './component.handlers.files'
import { createFfsManagerPreviewHandlers } from './component.handlers.preview'

import type { FfsManagerHandlerContext } from './component.handlers.types'

export * from './component.handlers.files'
export * from './component.handlers.preview'

/**
 * 创建 FFS 页面事件处理集合。
 * @param context - 页面交互上下文
 */
export const createFfsManagerHandlers = (context: FfsManagerHandlerContext) => ({
	...createFfsManagerFileHandlers(context),
	...createFfsManagerPreviewHandlers(context)
})
