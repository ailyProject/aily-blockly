import type { Operation } from '@trpc/client'
import type { TRPCResponseMessage } from '@trpc/server/rpc'

/**
 * 发起一次普通 tRPC 操作的主进程消息
 */
export interface ETRPCOperationRequest {
	/** 消息方法名，表示执行一次请求 */
	method: 'request'
	/** 当前要执行的 tRPC 操作描述 */
	operation: Operation
}

/**
 * 停止订阅流的主进程消息
 */
export interface ETRPCSubscriptionStopRequest {
	/** 消息方法名，表示停止一个已有订阅 */
	method: 'subscription.stop'
	/** 需要停止的订阅消息 ID */
	id: number
}

/**
 * ERPC 渲染进程到主进程的请求消息
 */
export type ETRPCRequest =
	/** 发起普通请求 */
	| ETRPCOperationRequest
	/** 停止已有订阅 */
	| ETRPCSubscriptionStopRequest

/**
 * 挂载在全局对象上的 ERPC 通信桥
 */
export interface GlobalERPC {
	/** 向主进程发送一条 ERPC 请求消息 */
	sendMessage: (args: ETRPCRequest) => void
	/** 订阅主进程返回的响应消息 */
	onMessage: (callback: (args: TRPCResponseMessage) => void) => void
}
