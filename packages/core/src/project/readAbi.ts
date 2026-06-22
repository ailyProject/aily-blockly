import { createEmptyProjectAbiSummary, createProjectAbiSummaryFromDocument } from './readAbi/helpers'
import { readProjectDocument } from './readDocument'

/**
 * 项目 ABI 页面摘要。
 */
export interface ProjectAbiPageSummary {
	/** 页面唯一标识。 */
	id: string
	/** 页面标题。 */
	title: string
	/** 当前页面块数量。 */
	blockCount: number
	/** 当前页面是否处于打开状态。 */
	opened: boolean
	/** 当前页面是否为激活页面。 */
	active: boolean
}

/**
 * 项目 ABI 摘要。
 */
export interface ProjectAbiSummary {
	/** 当前项目是否存在 `project.abi` 文件。 */
	exists: boolean
	/** `project.abi` 的实际路径。 */
	filePath: string
	/** 解析 `project.abi` 时捕获到的错误。 */
	parseError?: string
	/** 当前文档 schema 版本。 */
	schemaVersion?: number
	/** 当前激活页面 ID。 */
	activePageId?: string
	/** 当前打开页面数量。 */
	openedPageCount: number
	/** 当前页面总数。 */
	pageCount: number
	/** 当前文档总块数。 */
	totalBlockCount: number
	/** 共享变量数量。 */
	sharedVariableCount: number
	/** 共享过程块数量。 */
	sharedProcedureCount: number
	/** 页面级摘要列表。 */
	pages: Array<ProjectAbiPageSummary>
}

/**
 * 读取当前项目的 `project.abi` 摘要。
 * @param projectPath - 当前项目目录
 */
export const readProjectAbiSummary = async (projectPath: string): Promise<ProjectAbiSummary> => {
	const snapshot = await readProjectDocument(projectPath)
	if (!snapshot.exists) {
		return createEmptyProjectAbiSummary({
			exists: false,
			filePath: snapshot.filePath
		})
	}
	if (snapshot.parseError) {
		return createEmptyProjectAbiSummary({
			exists: true,
			filePath: snapshot.filePath,
			parseError: snapshot.parseError
		})
	}

	return createProjectAbiSummaryFromDocument({
		filePath: snapshot.filePath,
		document: snapshot.document
	})
}
