import {
	AILY_CORE_SERVICE_HEALTH_PATH,
	AILY_CORE_SERVICE_HOST,
	AILY_CORE_SERVICE_PORT,
	AILY_CORE_SERVICE_TRPC_PATH
} from '../constants'

import type { AilyCoreServiceAddress, AilyCoreServiceStartOptions } from './types'

const normalizeHost = (host?: string) => host?.trim() || AILY_CORE_SERVICE_HOST

const normalizePort = (port?: number) =>
	Number.isInteger(port) && Number(port) > 0 ? Number(port) : AILY_CORE_SERVICE_PORT

/**
 * 生成 Core 服务的标准地址集合
 * @param options - 服务启动选项
 */
export const createAilyCoreServiceAddress = (
	options: Pick<AilyCoreServiceStartOptions, 'host' | 'port'> = {}
): AilyCoreServiceAddress => {
	const host = normalizeHost(options.host)
	const port = normalizePort(options.port)
	const baseUrl = `http://${host}:${port}`

	return {
		host,
		port,
		baseUrl,
		trpcPath: AILY_CORE_SERVICE_TRPC_PATH,
		trpcUrl: `${baseUrl}${AILY_CORE_SERVICE_TRPC_PATH}`,
		healthPath: AILY_CORE_SERVICE_HEALTH_PATH,
		healthUrl: `${baseUrl}${AILY_CORE_SERVICE_HEALTH_PATH}`
	}
}
