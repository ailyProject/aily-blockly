import type { AilyCoreServiceAddress, AilyCoreServiceStartOptions } from './types'

/**
 * 生成 Core 服务的标准地址集合
 * @param options - 服务启动选项
 */
export declare const createAilyCoreServiceAddress: (
	options?: Pick<AilyCoreServiceStartOptions, 'host' | 'port'>
) => AilyCoreServiceAddress
