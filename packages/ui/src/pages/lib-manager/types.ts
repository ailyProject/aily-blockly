import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type { LibraryIndexItem } from '@core'
import type { MissingBlocklyLibraryInfo } from 'shared'

/**
 * lib-manager 页面里已声明 Blockly 库的原始状态。
 */
export interface LibManagerDeclaredLibraryState {
	/** 库包名。 */
	name: string
	/** package.json 中声明的版本。 */
	version: string
	/** 当前库是否已经可以被 Blockly 正常加载。 */
	ready: boolean
	/** `file:` 依赖对应的本地路径。 */
	localPath?: string
}

/**
 * lib-manager 页面展示的 Blockly 库状态。
 */
export interface LibManagerPageState {
	/** 当前项目目录。 */
	projectPath: string
	/** 当前项目声明的开发板包名。 */
	boardPackageName?: string
	/** 当前开发板简写标识。 */
	boardId?: string
	/** 当前 manifest 字段名。 */
	manifestField: string
	/** 当前项目是否存在 package.json。 */
	hasPackageJson: boolean
	/** 当前项目是否存在 project.abi。 */
	hasProjectDocument: boolean
	/** 当前声明的 Blockly 库。 */
	declaredLibraries: Array<LibManagerDeclaredLibraryState>
	/** 当前已就绪的库包名。 */
	readyLibraryPackages: Array<string>
	/** 当前仍缺失的库。 */
	missingLibraries: Array<MissingBlocklyLibraryInfo>
}

/**
 * lib-manager 页面里的包管理动作类型。
 */
export type LibManagerPackageAction =
	/** 安装或恢复项目依赖中的 Blockly 库。 */
	| 'install'
	/** 从当前项目移除 Blockly 库依赖。 */
	| 'remove'

/**
 * lib-manager 页面展示的结构化进度事件。
 */
export interface LibManagerProgressEvent {
	/** 当前阶段标识。 */
	phase: string
	/** 对应的原始日志行。 */
	line: string
	/** 已解析出的总依赖数量。 */
	resolved?: number
	/** 已复用缓存或已存在依赖的数量。 */
	reused?: number
	/** 已下载依赖的数量。 */
	downloaded?: number
	/** 已新增到项目中的依赖数量。 */
	added?: number
}

/**
 * lib-manager 页面展示的最近一次动作输出。
 */
export interface LibManagerActionOutput {
	/** 当前动作类型。 */
	action: LibManagerPackageAction
	/** 目标库包名。 */
	packageName: string
	/** 当前动作是否成功。 */
	success: boolean
	/** 标准输出。 */
	stdout: string
	/** 标准错误。 */
	stderr: string
	/** 退出码。 */
	exitCode: number
	/** 已解析的结构化进度事件。 */
	progressEvents: Array<LibManagerProgressEvent>
}

/**
 * lib-manager 页面展示的实时动作状态。
 */
export interface LibManagerLiveActionStatus {
	/** 当前动作类型。 */
	action: LibManagerPackageAction
	/** 目标库包名。 */
	packageName: string
	/** 当前是否仍在执行中。 */
	running: boolean
	/** 已采集的标准输出。 */
	stdout: string
	/** 已采集的标准错误。 */
	stderr: string
	/** 已解析的结构化进度事件。 */
	progressEvents: Array<LibManagerProgressEvent>
	/** 最近一次更新时间。 */
	updatedAt: string
}

/**
 * lib-manager 页面缓存的版本列表状态。
 */
export interface LibManagerVersionState {
	/** registry 地址。 */
	registry: string
	/** 最新版本。 */
	latestVersion?: string
	/** 可用版本列表。 */
	versions: Array<string>
	/** 当前错误文本。 */
	error?: string
}

/**
 * 已声明 Blockly 库的兼容性状态。
 */
export type LibManagerDeclaredLibraryCompatibility =
	/** 当前开发板与 catalog 记录兼容。 */
	| 'compatible'
	/** 当前开发板与 catalog 记录不兼容。 */
	| 'incompatible'
	/** 当前 catalog 中没有对应记录。 */
	| 'unknown-catalog'
	/** 当前项目还没解析出开发板标识。 */
	| 'unknown-board'

/**
 * lib-manager 页面中已声明库的展示视图。
 */
export interface LibManagerDeclaredLibraryView {
	/** 库包名。 */
	name: string
	/** package.json 中声明的版本。 */
	version: string
	/** `file:` 依赖解析出的本地路径。 */
	localPath?: string
	/** 当前库是否已就绪。 */
	ready: boolean
	/** catalog 命中的展示名。 */
	displayName?: string
	/** 兼容性状态。 */
	compatibility: LibManagerDeclaredLibraryCompatibility
	/** 面向界面的兼容性文案。 */
	compatibilityText: string
	/** catalog 命中的标签。 */
	tags: Array<string>
	/** 当前安装来源标签。 */
	sourceLabel: string
}

/**
 * lib-manager 页面中 catalog 库的展示视图。
 */
export interface LibManagerCatalogLibraryView {
	/** 库包名。 */
	name: string
	/** catalog 展示名。 */
	displayName: string
	/** 库描述。 */
	description?: string
	/** 搜索和展示标签。 */
	tags: Array<string>
	/** 当前项目上的兼容性状态。 */
	compatibility: LibManagerDeclaredLibraryCompatibility
	/** 面向界面的兼容性文案。 */
	compatibilityText: string
	/** 当前 catalog 原始条目。 */
	catalogItem: LibraryIndexItem
	/** 当前默认安装来源标签。 */
	sourceLabel: string
}

/**
 * lib-manager 页面中 registry 搜索结果的展示视图。
 */
export interface LibManagerRegistryLibraryView {
	/** 库包名。 */
	name: string
	/** 展示名。 */
	displayName: string
	/** 最新版本。 */
	latestVersion?: string
	/** 描述文本。 */
	description?: string
	/** 关键词。 */
	keywords: Array<string>
	/** 当前来源标签。 */
	sourceLabel: string
}

/**
 * lib-manager 页面当前激活的视图筛选。
 */
export type LibManagerLibraryScope =
	/** 展示全部区块。 */
	| 'all'
	/** 仅聚焦当前已安装/已就绪的声明库。 */
	| 'installed'
	/** 仅聚焦缺失库恢复。 */
	| 'missing'
	/** 仅聚焦 catalog 搜索与安装。 */
	| 'catalog'

/**
 * 安装前兼容确认提示。
 */
export interface LibManagerInstallPrompt {
	/** 待安装的库包名。 */
	packageName: string
	/** 面向用户展示的库名称。 */
	displayName: string
	/** 当前项目解析出的开发板标识。 */
	currentBoardId: string
	/** catalog 标记的兼容开发板列表。 */
	supportedBoards: Array<string>
	/** 面向界面的兼容性提示文案。 */
	compatibilityText: string
	/** 安装时要写入的版本。 */
	version?: string
	/** `file:` 安装时使用的本地路径。 */
	localPath?: string
}

/**
 * lib-manager 页面动作依赖。
 */
export interface LibManagerActionContext {
	/** Core tRPC 句柄。 */
	core: Core
	/** desktop ERPC 句柄。 */
	desktop: NonNullable<Desktop> | null
	/** 目录选择函数。 */
	selectDesktopDirectory: SelectDesktopDirectory
	/** 当前页面状态快照读取函数。 */
	state: () => LibManagerPageState | null
	/** 当前执行中的动作键。 */
	actionBusyKey: WritableSignal<string | null>
	/** 面向界面的状态文案。 */
	statusMessage: WritableSignal<string | null>
	/** 最近一次安装/移除动作结果。 */
	lastActionOutput: WritableSignal<LibManagerActionOutput | null>
	/** 当前轮询中的实时动作状态。 */
	liveActionStatus: WritableSignal<LibManagerLiveActionStatus | null>
	/** 安装前待确认的兼容性提示。 */
	pendingInstallPrompt: WritableSignal<LibManagerInstallPrompt | null>
	/** 当前是否正在搜索远程 registry。 */
	registrySearchBusy: WritableSignal<boolean>
	/** 当前 registry 搜索结果列表。 */
	registrySearchResults: WritableSignal<Array<LibManagerRegistryLibraryView>>
	/** 当前正在加载版本列表的库包名。 */
	versionLoadingPackage: WritableSignal<string | null>
	/** 当前页面缓存的版本列表状态。 */
	libraryVersionsByPackage: WritableSignal<Record<string, LibManagerVersionState>>
	/** 当前页面使用的 npm registry 地址。 */
	npmRegistry: WritableSignal<string>
	/** 重新加载页面状态。 */
	refresh: () => Promise<void>
}
