import type { Router } from '@desktop'
import type { TRPCClient } from '@trpc/client'
import type { GlobalERPC } from 'erpc/renderer'
import type { BleDeviceItem } from 'shared'

/**
 * UI 侧 desktop ERPC 句柄的可选创建参数。
 */
export interface CreateDesktopOptions {
	/** 是否允许在缺失 ERPC 环境时直接返回空客户端。 */
	allowMissingBridge?: boolean
}

/**
 * UI 侧的 desktop ERPC 句柄。
 */
export type Desktop = TRPCClient<Router> | null

export type { BleDeviceItem }

/**
 * 通过 desktop 宿主选择目录的标准函数签名。
 */
export type SelectDesktopDirectory = (desktop: NonNullable<Desktop>, path: string) => Promise<string>

/**
 * 通过 desktop 宿主选择项目文件或目录的标准函数签名。
 */
export type SelectDesktopProjectPath = (desktop: NonNullable<Desktop>, path: string) => Promise<string>

/**
 * 从 desktop 宿主读取运行时信息的标准函数签名。
 */
export type LoadDesktopHostRuntimeInfo = (
	desktop: NonNullable<Desktop>
) => Promise<import('@desktop').DesktopHostRuntimeInfo>

declare global {
	interface Window {
		/** Electron preload 暴露到浏览器环境的 ERPC 桥。 */
		$erpc?: GlobalERPC
		/** 桌面 preload 最小自检标记。 */
		$desktopPreload?: {
			ready: boolean
		}
	}
}
