/**
 * Esptool 宿主平台
 */
export type HardwareEsptoolPlatform =
	/** Windows 平台 */
	| 'windows'
	/** macOS 平台 */
	| 'macos'
	/** Linux 平台 */
	| 'linux'

/**
 * Esptool 包信息
 */
export interface HardwareEsptoolPackageInfo {
	/** 包名称 */
	name: string
	/** 包版本 */
	version: string
	/** 是否已安装 */
	installed: boolean
	/** esptool 可执行文件路径 */
	esptoolPath?: string
	/** Python 可执行文件路径 */
	pythonPath?: string
}

/**
 * Esptool 安装结果
 */
export interface HardwareEsptoolInstallResult {
	/** 当前是否安装成功 */
	success: boolean
	/** 安装后的包信息 */
	packageInfo?: HardwareEsptoolPackageInfo | null
	/** 面向用户的消息 */
	message?: string
	/** 错误文本 */
	error?: string
}

/**
 * Esptool 烧录文件项
 */
export interface HardwareEsptoolFlashFileItem {
	/** 二进制数据 */
	data: string
	/** 烧录地址 */
	address: number
}

/**
 * Esptool 烧录选项
 */
export interface HardwareEsptoolFlashOptions {
	/** 串口路径 */
	port: string
	/** 波特率 */
	baudRate?: number
	/** 烧录文件列表 */
	flashFiles: Array<HardwareEsptoolFlashFileItem>
	/** 芯片类型 */
	chip?: string
	/** 烧录前动作 */
	beforeFlash?: 'default_reset' | 'no_reset'
	/** 烧录后动作 */
	afterFlash?: 'hard_reset' | 'no_reset'
}
