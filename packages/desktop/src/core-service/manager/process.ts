import { createRequire } from 'node:module'
import { utilityProcess } from 'electron'

import type { UtilityProcess } from 'electron'
import type { AilyCoreServiceAddress } from 'shared'

const require = createRequire(import.meta.url)
const AILY_CORE_PLATFORM = 'electron'

const logDesktopCoreChildOutput = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
	const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
	const message = text.trim()
	if (!message) return

	const logger = stream === 'stderr' ? console.warn : console.log
	logger(`[aily-core:${stream}] ${message}`)
}

/**
 * 解析 standalone 入口。
 * @param entryOverride - 可选手动覆盖入口
 */
export const resolveDesktopCoreStandaloneEntrypoint = (entryOverride?: string) => {
	if (entryOverride) return entryOverride
	return require.resolve('core')
}

/**
 * 创建并启动 Core utility process。
 * @param address - Core 服务地址
 * @param options - 入口配置
 */
export const createDesktopCoreServiceChild = (
	address: AilyCoreServiceAddress,
	options: { entry: string }
): UtilityProcess => {
	const child = utilityProcess.fork(options.entry, [`--platform=${AILY_CORE_PLATFORM}`], {
		env: {
			...process.env,
			AILY_CORE_PLATFORM,
			AILY_CORE_SERVICE_HOST: address.host,
			AILY_CORE_SERVICE_PORT: String(address.port)
		},
		stdio: 'pipe',
		serviceName: 'Aily Core Service',
		allowLoadingUnsignedLibraries: process.platform === 'darwin'
	})

	child.stdout?.on('data', chunk => {
		logDesktopCoreChildOutput('stdout', chunk)
	})
	child.stderr?.on('data', chunk => {
		logDesktopCoreChildOutput('stderr', chunk)
	})
	child.on('error', (type, location, report) => {
		console.warn(`[aily-core:child-error] ${type}: ${location}`)
		if (report) {
			console.warn(report)
		}
	})
	child.on('exit', code => {
		console.log(`[aily-core] process exited with code ${code}`)
	})

	return child
}
