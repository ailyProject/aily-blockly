/** TYPES */
/**
 * 绑定到单一上游订阅的 Promise 视图。
 *
 * 调用 `unsubscribe()` 后，会解除对上游订阅的引用，避免继续保留
 * 当前订阅 Promise 的生命周期。
 */
export interface SubscribedPromise<T> extends Promise<T> {
	/** 取消当前订阅并释放相关引用 */
	unsubscribe: () => void
}
/**
 * Promise 的代理接口，但链式调用会继续返回可订阅的 Promise 版本。
 */
export interface ProxyPromise<T> extends Promise<T> {
	/** 创建一个绑定到上游的订阅 Promise */
	subscribe: () => SubscribedPromise<T>
	/** 注册完成/失败回调，并保持返回值可继续订阅 */
	then: <TResult1 = T, TResult2 = never>(
		/** Promise 成功完成时执行的回调 */
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		/** Promise 失败时执行的回调 */
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
	) => SubscribedPromise<TResult1 | TResult2>
	/** 注册失败回调，并保持返回值可继续订阅 */
	catch: <TResult = never>(
		/** Promise 失败时执行的回调 */
		onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
	) => SubscribedPromise<T | TResult>
	/** 注册 finally 回调，并保持返回值可继续订阅 */
	finally: (
		/** Promise 结束后总会执行的回调 */
		onfinally?: (() => void) | null
	) => SubscribedPromise<T>
}
/**
 * 创建 Promise 时使用的执行器签名。
 */
export type PromiseExecutor<T> = (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void
/**
 * 可显式 resolve / reject 的 Promise 组合对象。
 *
 * 该类型遵循 ES2023 `Promise.withResolvers()` 的常见结构。
 */
export interface PromiseWithResolvers<T> {
	/** 实际暴露给外部消费的 Promise 实例 */
	promise: Promise<T>
	/** 以成功状态完成 Promise */
	resolve: (value: T | PromiseLike<T>) => void
	/** 以失败状态结束 Promise */
	reject: (reason?: any) => void
}
/** Given an array, this is the union of its members' types. */
