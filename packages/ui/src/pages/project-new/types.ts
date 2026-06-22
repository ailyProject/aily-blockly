import type { WritableSignal } from '@angular/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CloudProjectSummary } from 'shared'

/**
 * 新建项目页最近项目条目
 */
export interface ProjectNewRecentItem {
	/** 最近项目名称 */
	name: string
	/** 最近项目路径 */
	path: string
	/** 回填到输入框的昵称 */
	nickname?: string
}

/**
 * 新建项目页的当前板卡云端状态。
 */
export interface ProjectNewBoardCloudState {
	/** 当前板卡可导入的模板列表。 */
	templates: Array<ProjectNewCloudTemplate>
	/** 当前板卡是否存在公开示例项目。 */
	hasExamples: boolean
}

/**
 * 项目模板来源模式。
 */
export type ProjectNewTemplateSourceMode =
	/** 优先读取当前用户可见的模板列表。 */
	| 'mine'
	/** 使用匿名可见模板列表。 */
	| 'public'

export type ProjectNewCloudTemplate = CloudProjectSummary

/**
 * Project New 页面信号集合。
 */
export interface ProjectNewSignals {
	/** 页面加载中的状态。 */
	loading: WritableSignal<boolean>
	/** 页面级错误信息。 */
	error: WritableSignal<string | null>
	/** 当前 bearer token。 */
	authToken: WritableSignal<string>
	/** 当前项目名称。 */
	projectName: WritableSignal<string>
	/** 当前选中的开发板展示名。 */
	selectedBoardName: WritableSignal<string>
	/** 当前根目录。 */
	rootPath: WritableSignal<string>
	/** 解析出的项目路径。 */
	resolvedProjectPath: WritableSignal<string>
	/** 最近项目列表。 */
	recentProjects: WritableSignal<Array<ProjectNewRecentItem>>
	/** 当前可见模板列表。 */
	templates: WritableSignal<Array<ProjectNewCloudTemplate>>
	/** 当前板卡是否存在公开示例。 */
	hasExamples: WritableSignal<boolean>
	/** 当前选中的模板 ID。 */
	selectedTemplateId: WritableSignal<string | null>
	/** 当前目标路径是否冲突。 */
	pathConflict: WritableSignal<boolean | null>
	/** 项目名称校验消息。 */
	nameValidationMessage: WritableSignal<string | null>
	/** 当前导入/创建动作是否忙碌。 */
	importBusy: WritableSignal<boolean>
	/** 页面提示信息。 */
	importMessage: WritableSignal<string | null>
	/** 当前模板来源模式。 */
	templateSourceMode: WritableSignal<ProjectNewTemplateSourceMode>
	/** desktop 宿主运行时信息。 */
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
}
