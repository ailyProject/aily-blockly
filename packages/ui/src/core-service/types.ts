import type { TRPCClient } from '@trpc/client'
import type { BoardIndexItem, LegacyBoardItem, LegacyLibraryItem } from '@ui/workspace/core-hardware'
import type { Router } from '@ui/workspace/core-rpc'
import type { AilyAgentConfig, AilyAppConfig, AilyCoreServiceAddress, AppRegistryItem } from '@ui/workspace/shared'

/**
 * 浏览器全局注入的 Core 服务地址覆盖项
 */
export interface CoreServiceWindowConfig {
	/** 覆盖默认主机地址 */
	host?: string
	/** 覆盖默认端口 */
	port?: number
	/** 直接覆盖完整 base URL */
	baseUrl?: string
}

/**
 * 创建 UI 侧 Core tRPC 句柄时的选项
 */
export interface CreateCoreOptions {
	/** 直接指定完整 base URL */
	baseUrl?: string
	/** 通过 host / port 覆盖默认地址 */
	address?: Partial<Pick<AilyCoreServiceAddress, 'host' | 'port'>>
}

/**
 * UI 侧的 Core tRPC 句柄
 */
export type Core = TRPCClient<Router>

/**
 * 首页预览时传给 core 的上下文摘要
 */
export interface LoadHomePreviewContext {
	/** 语言缺省值，用于 selectedLanguage 缺失时回退 */
	fallbackLanguage?: string
	/** 当前页面路由地址 */
	routeUrl?: string
	/** 当前选中开发板 core 名称 */
	boardCore?: string
	/** 当前是否处于开发者模式 */
	isDevMode?: boolean
}

/**
 * 首页预览聚合查询所需输入
 */
export interface LoadHomePreviewOptions {
	/** 当前可搜索的开发板索引 */
	boardIndex: Array<BoardIndexItem>
	/** legacy 开发板清单 */
	legacyBoards: Array<LegacyBoardItem>
	/** legacy 库清单 */
	legacyLibraries: Array<LegacyLibraryItem>
	/** 当前 agent 配置 */
	agentConfig: AilyAgentConfig
	/** 当前应用配置 */
	appConfig: AilyAppConfig
	/** 工具栏应用目录 */
	toolbarApps: Array<AppRegistryItem>
	/** 预览配置写回时使用的 mutation 载荷 */
	mutationInput: Record<string, unknown>
	/** 影响可见性与默认值解析的上下文 */
	context: LoadHomePreviewContext
}

declare global {
	interface Window {
		/** 页面运行时可覆盖的 core service 地址配置 */
		__AILY_CORE_SERVICE__?: CoreServiceWindowConfig
	}
}
