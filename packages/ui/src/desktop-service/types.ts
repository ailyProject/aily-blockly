import type { TRPCClient } from '@trpc/client'
import type { Router } from '@ui/workspace/desktop'
import type { GlobalERPC } from '@ui/workspace/erpc-renderer'

/**
 * UI 侧 desktop ERPC 句柄的可选创建参数
 */
export interface CreateDesktopOptions {
	/** 是否允许在缺失 ERPC 环境时直接返回空客户端 */
	allowMissingBridge?: boolean
}

/**
 * UI 侧的 desktop ERPC 句柄
 */
export type Desktop = TRPCClient<Router> | null

declare global {
	interface Window {
		/** Electron preload 暴露到浏览器环境的 ERPC 桥 */
		$erpc?: GlobalERPC
	}
}
