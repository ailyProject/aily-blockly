import { signal } from '@angular/core'

import { dispatchProjectMutationEvent } from './project-events'

const PROJECT_PATH_STORAGE_KEY = 'aily.currentProjectPath'
const PROJECT_ROUTE_STORAGE_KEY = 'aily.currentProjectEditorRoute'

const readStoredProjectSessionValue = (key: string) => {
	if (typeof localStorage === 'undefined') return ''
	try {
		return String(localStorage.getItem(key) || '')
	} catch {
		return ''
	}
}

const writeStoredProjectSessionValue = (key: string, value: string) => {
	if (typeof localStorage === 'undefined') return
	try {
		if (value) {
			localStorage.setItem(key, value)
			return
		}
		localStorage.removeItem(key)
	} catch {
		return
	}
}

const currentProjectPathState = signal(readStoredProjectSessionValue(PROJECT_PATH_STORAGE_KEY))
const currentProjectEditorRouteState = signal<'blockly-editor' | 'code-editor' | ''>(
	(readStoredProjectSessionValue(PROJECT_ROUTE_STORAGE_KEY) as 'blockly-editor' | 'code-editor' | '') || ''
)
const currentProjectSourceCodeState = signal('')

/**
 * 读取 UI 当前共享的项目路径。
 */
export const getCurrentProjectPath = () => currentProjectPathState()

/**
 * 读取 UI 当前共享的 editor 路由。
 */
export const getCurrentProjectEditorRoute = () => currentProjectEditorRouteState()

/**
 * 读取 UI 当前共享的项目源码。
 */
export const getCurrentProjectSourceCode = () => currentProjectSourceCodeState()

/**
 * 写入 UI 当前共享的项目路径。
 * @param projectPath - 当前项目目录
 */
export const setCurrentProjectPath = (projectPath: string) => {
	const value = projectPath.trim()
	if (currentProjectPathState() === value) return
	currentProjectPathState.set(value)
	writeStoredProjectSessionValue(PROJECT_PATH_STORAGE_KEY, value)
	dispatchProjectMutationEvent({
		projectPath: value,
		type: 'session-change',
		occurredAt: new Date().toISOString()
	})
}

/**
 * 写入 UI 当前共享的 editor 路由。
 * @param route - 当前项目对应的 editor 路由
 */
export const setCurrentProjectEditorRoute = (route: 'blockly-editor' | 'code-editor' | '') => {
	currentProjectEditorRouteState.set(route)
	writeStoredProjectSessionValue(PROJECT_ROUTE_STORAGE_KEY, route)
}

/**
 * 写入 UI 当前共享的项目源码。
 * @param sourceCode - 当前编辑中的源码
 */
export const setCurrentProjectSourceCode = (sourceCode: string) => {
	currentProjectSourceCodeState.set(sourceCode)
}

/**
 * 清空 UI 当前共享的项目会话。
 */
export const clearCurrentProjectSession = () => {
	setCurrentProjectPath('')
	setCurrentProjectEditorRoute('')
	setCurrentProjectSourceCode('')
}
