import { normalizeDocumentLifecycleState } from '../document'
import { withProjectMutationLock } from './lock'
import { readProjectDocument } from './readDocument'
import { writeProjectDocument } from './writeDocument'

import type { BlocklyProjectDocument } from '../document'

/**
 * 读取、更新并写回项目文档。
 * @param projectPath - 当前项目目录
 * @param update - 文档更新函数
 */
export const updateProjectDocument = async (
	projectPath: string,
	update: (document: BlocklyProjectDocument) => BlocklyProjectDocument,
	owner = 'document-update'
) =>
	withProjectMutationLock(projectPath, owner, async () => {
		const snapshot = await readProjectDocument(projectPath)
		const nextDocument = normalizeDocumentLifecycleState(update(snapshot.document))
		await writeProjectDocument(snapshot.filePath, nextDocument)

		return {
			...snapshot,
			exists: true,
			document: nextDocument
		}
	})
