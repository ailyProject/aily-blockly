import type { AilyAppConfig, CloudProjectSyncResult } from 'shared'
import type { BlocklyProjectDocument } from '../document'
import type { MissingBlocklyLibraryInfo } from '../metadata'
import type { ProjectEditorRoute } from './editorEntry'

/**
 * 从 shared 复用的项目公共类型。
 */
export type {
	BoardUsageCountMap,
	BuildFlavor,
	RecentlyProjectEntry,
	RegionConfig,
	RegionConfigMap,
	RegionListItem,
	ResourceRuntimeEnvPayload,
	ResourceSourceConfig
} from 'shared'

/**
 * 最近一次构建状态。
 */
export type ProjectBuildStatus =
	/** 最近一次构建成功。 */
	| 'success'
	/** 最近一次构建失败。 */
	| 'failed'
	/** 最近一次构建被取消。 */
	| 'cancelled'

/**
 * package.json 中持久化的构建元数据。
 */
export interface ProjectBuildInfo {
	/** 最近一次构建完成时间。 */
	lastBuildTime: string
	/** 最近一次构建对应的源码哈希。 */
	lastBuildCode: string
	/** 最近一次构建状态。 */
	lastBuildStatus: ProjectBuildStatus
	/** 最近一次构建耗时，单位秒。 */
	lastBuildDuration: number
}

/**
 * 项目 package.json 的核心模型
 */
export interface ProjectPackageJson {
	/** npm 包名称或项目名称 */
	name?: string
	/** 用户可见昵称 */
	nickname?: string
	/** 版本号 */
	version?: string
	/** 作者信息 */
	author?: string
	/** 项目说明 */
	description?: string
	/** 云端项目 ID */
	cloudId?: string
	/** 当前已成功构建源码的 SHA256 哈希 */
	codeHash?: string
	/** 最近一次构建元数据 */
	buildInfo?: ProjectBuildInfo
	/** 最近一次构建对应的源码哈希 */
	lastBuildCode?: string
	/** 最近一次构建状态 */
	lastBuildStatus?: ProjectBuildStatus
	/** 最近一次构建完成时间 */
	lastBuildTime?: string
	/** 最近一次构建耗时，单位秒 */
	lastBuildDuration?: number
	/** 开发模式或框架标识 */
	devmode?: ProjectDevMode
	/** 宏定义列表 */
	MACROS?: Array<string | Array<string>>
	/** 项目级配置块 */
	projectConfig?: Record<string, unknown>
	/** 运行时依赖 */
	dependencies?: Record<string, string>
	/** 开发依赖 */
	devDependencies?: Record<string, string>
	/** 可选依赖 */
	optionalDependencies?: Record<string, string>
	/** 开发板附加依赖 */
	boardDependencies?: Record<string, string>
	/** 允许透传其它 package.json 字段 */
	[key: string]: unknown
}

/**
 * 归一化后的依赖视图
 */
export interface DeclaredDependencies {
	/** 规范化后的 dependencies */
	dependencies: Record<string, string>
	/** 规范化后的 devDependencies */
	devDependencies: Record<string, string>
	/** 规范化后的 optionalDependencies */
	optionalDependencies: Record<string, string>
	/** 三类依赖合并后的总视图 */
	all: Record<string, string>
}

/**
 * 项目开发模式
 */
export type ProjectDevMode =
	/** Arduino / C++ 工具链模式 */
	| 'arduino'
	/** MicroPython 模式 */
	| 'micropython'
	/** 其它未来扩展模式 */
	| (string & {})

/**
 * 当前本地项目与云项目的绑定摘要。
 */
export interface ProjectCloudBindingSummary {
	/** 当前本地项目路径。 */
	projectPath: string
	/** 当前 package.json 中记录的 cloudId。 */
	cloudId?: string
	/** 当前项目主名称。 */
	name?: string
	/** 当前项目昵称。 */
	nickname?: string
}

/**
 * 应用配置文件读写输入。
 */
export interface ProjectConfigFileInput {
	/** Electron userData 对应的 appDataPath。 */
	appDataPath: string
}

/**
 * 应用配置文件写回输入。
 */
export interface ProjectConfigFileWriteInput extends ProjectConfigFileInput {
	/** 要写回的完整配置对象。 */
	config: AilyAppConfig
}

/**
 * 新建项目输入。
 */
export interface ProjectCreateInput {
	/** Electron userData 对应的 appDataPath。 */
	appDataPath: string
	/** 目标项目目录。 */
	projectPath: string
	/** 项目主名称。 */
	name: string
	/** 项目展示昵称。 */
	nickname?: string
	/** 项目说明。 */
	description?: string
	/** 开发板标识，如 `xiao-esp32s3`。 */
	boardName: string
	/** 开发板显示名。 */
	boardDisplayName?: string
	/** 依赖版本，默认 `latest`。 */
	boardVersion?: string
	/** devmode 标识。 */
	devmode?: string
}

/**
 * 新建项目结果。
 */
export interface ProjectCreateResult {
	/** 最终项目目录。 */
	projectPath: string
	/** 写回的 package.json 路径。 */
	packageJsonPath: string
	/** 是否复制了板卡模板。 */
	usedBoardTemplate: boolean
	/** 板卡包名。 */
	boardPackageName: string
}

/**
 * 项目文档文件快照。
 */
export interface ProjectDocumentSnapshot {
	/** 当前项目是否存在 `project.abi` 文件。 */
	exists: boolean
	/** `project.abi` 文件路径。 */
	filePath: string
	/** `project.abi.temp` 文件路径。 */
	tempFilePath: string
	/** 实际读取到的文档来源路径。 */
	sourceFilePath?: string
	/** 当前文档是否是从临时镜像恢复的。 */
	recoveredFromTemp?: boolean
	/** 解析 `project.abi` 时捕获到的错误。 */
	parseError?: string
	/** 归一化后的项目文档。 */
	document: BlocklyProjectDocument
}

/**
 * 当前项目库动作的进度阶段。
 */
export type ProjectBlocklyLibraryProgressPhase =
	/** 正在解析依赖与锁文件。 */
	| 'resolving'
	/** 正在下载包内容。 */
	| 'downloading'
	/** 正在写入依赖与链接产物。 */
	| 'linking'
	/** 命令已成功完成。 */
	| 'done'
	/** 命令输出中已出现错误迹象。 */
	| 'error'

/**
 * 当前项目库动作的结构化进度事件。
 */
export interface ProjectBlocklyLibraryProgressEvent {
	/** 当前进度阶段。 */
	phase: ProjectBlocklyLibraryProgressPhase
	/** 原始输出行。 */
	line: string
	/** 当前已解析的 resolved 数量。 */
	resolved?: number
	/** 当前已复用的 reused 数量。 */
	reused?: number
	/** 当前已下载的 downloaded 数量。 */
	downloaded?: number
	/** 当前已写入的 added 数量。 */
	added?: number
}

/**
 * 当前项目的 Blockly 库依赖动作结果。
 */
export interface ProjectBlocklyLibraryMutationResult {
	/** 当前动作是否成功。 */
	success: boolean
	/** 当前动作类型。 */
	action: 'install' | 'remove'
	/** 目标项目目录。 */
	projectPath: string
	/** 目标库包名。 */
	packageName: string
	/** 实际使用的版本。 */
	version?: string
	/** 命令标准输出。 */
	stdout: string
	/** 命令标准错误。 */
	stderr: string
	/** 退出码。 */
	exitCode: number
	/** 从命令输出中规整出的进度事件。 */
	progressEvents: Array<ProjectBlocklyLibraryProgressEvent>
	/** 面向上层展示的消息。 */
	message: string
}

/**
 * 当前正在进行的 Blockly 库动作实时状态。
 */
export interface ProjectBlocklyLibraryActionStatus {
	/** 当前动作类型。 */
	action: 'install' | 'remove'
	/** 目标项目目录。 */
	projectPath: string
	/** 目标库包名。 */
	packageName: string
	/** 当前是否仍在执行中。 */
	running: boolean
	/** 已采集的标准输出。 */
	stdout: string
	/** 已采集的标准错误。 */
	stderr: string
	/** 已解析的结构化进度事件。 */
	progressEvents: Array<ProjectBlocklyLibraryProgressEvent>
	/** 最近一次更新时间。 */
	updatedAt: string
}

/**
 * 当前 Blockly 库在 registry 中可见的版本列表。
 */
export interface ProjectBlocklyLibraryVersionListResult {
	/** 目标库包名。 */
	packageName: string
	/** 实际使用的 registry 地址。 */
	registry: string
	/** 解析出的最新版本。 */
	latestVersion?: string
	/** 可用版本列表，按新到旧排序。 */
	versions: Array<string>
}

/**
 * registry 搜索返回的 Blockly 库条目。
 */
export interface ProjectBlocklyLibraryRegistrySearchItem {
	/** 库包名。 */
	name: string
	/** registry 中展示的标题。 */
	displayName: string
	/** 最新版本。 */
	latestVersion?: string
	/** 描述文本。 */
	description?: string
	/** 关键词。 */
	keywords?: Array<string>
}

/**
 * 当前 query 对应的 registry 搜索结果。
 */
export interface ProjectBlocklyLibraryRegistrySearchResult {
	/** 实际使用的 registry 地址。 */
	registry: string
	/** 原始搜索词。 */
	query: string
	/** 结果列表。 */
	items: Array<ProjectBlocklyLibraryRegistrySearchItem>
}

/**
 * 本地 Blockly 库目录检查结果。
 */
export interface ProjectBlocklyLibrarySourceInspection {
	/** 当前目录是否通过基础检查。 */
	valid: boolean
	/** 当前检查的绝对路径。 */
	localPath: string
	/** 识别出的库包名。 */
	packageName?: string
	/** 展示名称。 */
	displayName?: string
	/** 描述文本。 */
	description?: string
	/** 缺失的关键文件列表。 */
	missingFiles?: Array<string>
	/** 失败原因。 */
	error?: string
}

/**
 * 已声明 Blockly 库的状态项。
 */
export interface ProjectBlocklyLibraryItem {
	/** 库包名。 */
	name: string
	/** package.json 中声明的版本。 */
	version: string
	/** file: 依赖解析出的本地路径。 */
	localPath?: string
	/** 当前库是否已就绪。 */
	ready: boolean
}

/**
 * 当前项目的 Blockly 库状态摘要。
 */
export interface ProjectBlocklyLibraryStatus {
	/** 当前项目目录。 */
	projectPath: string
	/** 当前项目声明的开发板包名。 */
	boardPackageName?: string
	/** 去掉包名前缀后的开发板标识。 */
	boardId?: string
	/** 当前 used-library manifest 字段名。 */
	manifestField: string
	/** 当前项目是否存在 package.json。 */
	hasPackageJson: boolean
	/** 当前项目是否存在 project.abi。 */
	hasProjectDocument: boolean
	/** 当前声明的 Blockly 库。 */
	declaredLibraries: Array<ProjectBlocklyLibraryItem>
	/** 当前已就绪的 Blockly 库包名。 */
	readyLibraryPackages: Array<string>
	/** 当前仍缺失的 Blockly 库。 */
	missingLibraries: Array<MissingBlocklyLibraryInfo>
}

/**
 * 当前项目生命周期状态摘要。
 */
export interface ProjectLifecycleStatus {
	/** 当前项目目录。 */
	projectPath: string
	/** 当前项目是否存在 package.json。 */
	hasPackageJson: boolean
	/** 当前项目是否存在 project.abi。 */
	hasProjectDocument: boolean
	/** 当前项目是否存在 project.abi.temp。 */
	hasTempDocument: boolean
	/** 当前项目是否有活跃 mutation lock。 */
	hasMutationLock: boolean
	/** 当前 mutation lock 是否已失效。 */
	mutationLockStale?: boolean
	/** mutation lock 持有者。 */
	mutationLockOwner?: string
	/** mutation lock 持有者进程号。 */
	mutationLockPid?: number
	/** 当前项目是否有活跃 open session lock。 */
	hasOpenSessionLock: boolean
	/** 当前 open session lock 是否已失效。 */
	openSessionLockStale?: boolean
	/** open session lock 持有者。 */
	openSessionLockOwner?: string
	/** open session lock 持有者进程号。 */
	openSessionLockPid?: number
	/** 当前文档是否从 project.abi.temp 恢复。 */
	recoveredFromTemp: boolean
	/** 实际读取到的文档来源路径。 */
	sourceFilePath?: string
	/** 主文档解析失败时的错误信息。 */
	parseError?: string
	/** 当前应进入的编辑器路由。 */
	editorRoute: ProjectEditorRoute
	/** 当前开发板包名。 */
	boardPackageName?: string
	/** 当前开发板依赖版本。 */
	boardPackageVersion?: string
	/** 当前开发板包是否已具备关键文件。 */
	boardPackageReady?: boolean
	/** 当前声明的 Blockly 库依赖清单，格式为 `name@version`。 */
	declaredLibraryDependencies: Array<string>
	/** 用于轻量对比依赖变化的稳定签名。 */
	dependencySignature: string
	/** 当前声明的 Blockly 库数量。 */
	declaredLibraryCount: number
	/** 当前已就绪的 Blockly 库数量。 */
	readyLibraryCount: number
	/** 当前缺失的 Blockly 库数量。 */
	missingLibraryCount: number
	/** 当前源码哈希。 */
	codeHash?: string
	/** 最近一次构建元数据。 */
	buildInfo?: ProjectBuildInfo
}

/**
 * 项目级 mutation lock 状态。
 */
export interface ProjectMutationLockStatus {
	/** 当前项目目录。 */
	projectPath: string
	/** lock 文件路径。 */
	lockFilePath: string
	/** 当前是否已有 lock。 */
	locked: boolean
	/** 当前 lock 是否看起来已经失效。 */
	stale?: boolean
	/** lock 持有者标识。 */
	owner?: string
	/** 持有者进程号。 */
	pid?: number
	/** lock 创建时间。 */
	createdAt?: string
}

/**
 * 项目打开会话锁状态。
 */
export interface ProjectOpenSessionLockStatus extends ProjectMutationLockStatus {}

/**
 * 项目归档打包结果。
 */
export interface ProjectArchivePackageResult {
	/** 生成出的归档文件路径。 */
	archivePath: string
	/** 当前临时工作目录。 */
	tempRoot: string
	/** 归档最终字节数。 */
	size: number
}

/**
 * 当前本地项目同步到云端时使用的输入。
 */
export interface ProjectSyncCloudInput {
	/** 当前项目目录。 */
	projectPath: string
	/** 当前用户访问云项目接口的 Bearer token。 */
	authToken: string
}

/**
 * 当前本地项目同步到云端后的结果。
 */
export interface ProjectSyncCloudResult extends CloudProjectSyncResult {
	/** 同步时使用的归档文件字节数。 */
	archiveSize: number
	/** 是否把新的 cloudId 写回了本地 package.json。 */
	cloudIdUpdated: boolean
}
