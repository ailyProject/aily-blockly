import { createFfsManagerFileHandlers } from './files'
import { createFfsManagerPreviewHandlers } from './preview'

import type { FfsManagerHandlerContext } from '../../types'

export * from './files'
export * from './preview'

/**
 * 创建 FFS 页面事件处理集合。
 * @param context - 页面交互上下文
 */
export const createFfsManagerHandlers = (context: FfsManagerHandlerContext) => ({
	...createFfsManagerFileHandlers(context),
	...createFfsManagerPreviewHandlers(context)
})
