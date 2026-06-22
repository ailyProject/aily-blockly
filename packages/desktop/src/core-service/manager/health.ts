import type { AilyCoreServiceAddress, AilyCoreServiceHealth } from 'shared'

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_HEALTHCHECK_INTERVAL_MS = 250

const sleep = async (timeout: number) => {
	await new Promise(resolve => setTimeout(resolve, timeout))
}

/**
 * 探测当前 Core 服务健康接口是否可达。
 * @param healthUrl - 健康检查地址
 */
export const isDesktopCoreServiceHealthy = async (healthUrl: string) => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 1_000)

	try {
		const response = await fetch(healthUrl, { signal: controller.signal })
		return response.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

/**
 * 读取当前 Core 服务健康载荷。
 * @param healthUrl - 健康检查地址
 */
export const readDesktopCoreServiceHealth = async (healthUrl: string): Promise<AilyCoreServiceHealth | null> => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 1_000)

	try {
		const response = await fetch(healthUrl, { signal: controller.signal })
		if (!response.ok) return null
		return (await response.json()) as AilyCoreServiceHealth
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

/**
 * 轮询等待 Core 服务变为可达。
 * @param address - Core 服务地址
 * @param options - 超时与轮询参数
 */
export const waitForDesktopCoreServiceHealthy = async (
	address: AilyCoreServiceAddress,
	options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
	while (Date.now() < deadline) {
		if (await isDesktopCoreServiceHealthy(address.healthUrl)) {
			return true
		}

		if ((options.intervalMs ?? DEFAULT_HEALTHCHECK_INTERVAL_MS) > 0) {
			await sleep(options.intervalMs ?? DEFAULT_HEALTHCHECK_INTERVAL_MS)
		}
	}

	return false
}
