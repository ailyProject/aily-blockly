/**
 * desktop 根 ERPC 路由类型
 */
type RoutersFactory = (typeof import('./index'))['routers']

export type Router = RoutersFactory
