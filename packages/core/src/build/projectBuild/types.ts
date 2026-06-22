/**
 * 项目构建命令描述。
 */
export interface ProjectBuildCommand {
	/** 当前命令的人类可读标签。 */
	label: string
	/** 可执行程序路径。 */
	executable: string
	/** 传给可执行程序的参数列表。 */
	args: Array<string>
	/** 命令执行工作目录。 */
	cwd: string
}

/**
 * 单次构建输出日志。
 */
export interface ProjectBuildLog {
	/** 产生日志的步骤标签。 */
	step: string
	/** 标准输出全文。 */
	stdout: string
	/** 标准错误全文。 */
	stderr: string
}

/**
 * 项目构建输入。
 */
export interface ProjectBuildInput {
	/** 要构建的项目目录。 */
	projectPath: string
	/** Electron userData 路径。 */
	appDataPath: string
	/** child 目录路径。 */
	childPath: string
	/** 本次构建要写入 sketch 的 Arduino 源码；缺失时会回退到项目现有源码。 */
	code?: string
}

/**
 * 项目依赖库镜像信息。
 */
export interface ProjectBuildLibraryBinding {
	/** 项目 package.json 中声明的库包名。 */
	packageName: string
	/** 源 node_modules 包目录。 */
	sourcePath: string
	/** 构建临时区内的镜像目录。 */
	targetPath: string
}

/**
 * 项目构建所需路径集合。
 */
export interface ProjectBuildPaths {
	/** 项目根目录。 */
	projectPath: string
	/** child/aily-builder 目录。 */
	ailyBuilderPath: string
	/** 构建临时目录。 */
	tempPath: string
	/** 临时 sketch 目录。 */
	sketchPath: string
	/** sketch.ino 文件路径。 */
	sketchFilePath: string
	/** 预处理输出 JSON 路径。 */
	preprocessResultPath: string
	/** 临时库镜像目录。 */
	librariesPath: string
	/** appData/compiler 根目录。 */
	compilerRootPath: string
	/** appData/sdk 根目录。 */
	sdkRootPath: string
	/** appData/tools 根目录。 */
	toolsRootPath: string
	/** 命中的编译器目录。 */
	compilerPath: string
	/** 命中的 SDK 目录。 */
	sdkPath: string
}

/**
 * 项目构建计划。
 */
export interface ProjectBuildPlan {
	/** 当前项目路径。 */
	projectPath: string
	/** 选中的开发板包名。 */
	boardPackageName: string
	/** 编译器使用的 board 类型标识。 */
	boardType: string
	/** 板卡 core 名称。 */
	coreName?: string
	/** 归一化后的项目级板卡选项。 */
	boardOptions: Array<string>
	/** 归一化后的宏定义列表。 */
	macros: Array<string>
	/** 传给预处理器的工具版本描述。 */
	toolVersions: Array<string>
	/** 将被镜像到 .temp/libraries 的库列表。 */
	libraries: Array<ProjectBuildLibraryBinding>
	/** 构建过程使用到的关键路径。 */
	paths: ProjectBuildPaths
	/** 预处理命令。 */
	preprocessCommand: ProjectBuildCommand
	/** 编译命令。 */
	compileCommand: ProjectBuildCommand
}

/**
 * 项目构建结果。
 */
export interface ProjectBuildResult {
	/** 当前构建是否成功。 */
	success: boolean
	/** 构建总耗时。 */
	durationMs: number
	/** 编译进程退出码。 */
	exitCode: number
	/** 构建前解析出的计划。 */
	plan: ProjectBuildPlan
	/** 各步骤日志全文。 */
	logs: Array<ProjectBuildLog>
	/** 合并后的标准输出。 */
	stdout: string
	/** 合并后的标准错误。 */
	stderr: string
	/** 归纳后的错误摘要。 */
	errorText: string
}
