import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 项目应进入的编辑器类型。
 */
export type ProjectEditorRoute =
	/** Blockly 工程入口。 */
	| 'blockly-editor'
	/** 代码工程入口。 */
	| 'code-editor'

/**
 * 根据项目内容推断应打开的编辑器路由。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectEditorRoute = (projectPath: string): ProjectEditorRoute =>
	existsSync(path.join(projectPath, 'project.abi')) ? 'blockly-editor' : 'code-editor'
