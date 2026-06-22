import { normalizeProjectDocument } from './normalize'

import type { BlocklyProjectDocument } from './types'

/**
 * 用当前规范重新整理项目文档。
 * @param document - 原始文档
 */
export const normalizeDocumentLifecycleState = (document: BlocklyProjectDocument) => normalizeProjectDocument(document)
