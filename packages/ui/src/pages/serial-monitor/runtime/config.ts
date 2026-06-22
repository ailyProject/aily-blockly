import { config } from '@/workspace'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { SerialMonitorConfig, SerialMonitorConnectOptions } from 'shared'
import type { SerialMonitorConfigPatch, SerialMonitorPageState, SerialMonitorPortItem } from '../types'

const SERIAL_BAUD_RATES = ['9600', '115200', '230400', '460800', '921600']
const resolvePortList = (ports: Array<SerialMonitorPortItem>) => ports.map(item => item.name || '').filter(Boolean)

const resolveNextConnectOptions = (
	core: Core,
	serialMonitor: Required<SerialMonitorConfig>,
	port: string
): Promise<SerialMonitorConnectOptions> =>
	core.config.buildSerialConnectOptions.query({
		config: {
			...config,
			serialMonitor
		},
		port
	})

/**
 * 加载串口监视器页面状态。
 * @param core - core 服务句柄
 */
export const loadSerialMonitorPageState = async (
	core: Core,
	options: { runtimeInfo?: DesktopHostRuntimeInfo | null } = {}
): Promise<SerialMonitorPageState> => {
	const [configSummary, serialPorts] = await Promise.all([
		options.runtimeInfo?.appDataPath
			? core.config.getStored.query({
					appDataPath: options.runtimeInfo.appDataPath,
					fallbackLanguage: config.lang
				})
			: core.config.get.query({ config, fallbackLanguage: config.lang }),
		core.hardware.listSerialPorts.query()
	])
	const availablePorts = resolvePortList(serialPorts.ports)
	const port = configSummary.serialMonitor.port || availablePorts[0] || ''
	const connectOptions = await resolveNextConnectOptions(core, configSummary.serialMonitor, port)
	const session = port ? await core.serial.status.query({ port }) : null

	return {
		availablePorts,
		availableBaudRates: SERIAL_BAUD_RATES,
		quickSendList: configSummary.quickSendList,
		serialMonitor: {
			...configSummary.serialMonitor,
			port
		},
		connectOptions,
		inputMode: configSummary.serialInputMode,
		viewMode: configSummary.serialViewMode,
		serialPlatform: serialPorts.platform,
		serialAvailable: serialPorts.available,
		session
	}
}

/**
 * 根据新的串口配置片段刷新页面状态。
 * @param core - core 服务句柄
 * @param state - 当前页面状态
 * @param patch - 待合并的串口配置片段
 */
export const updateSerialMonitorConfig = async (
	core: Core,
	state: SerialMonitorPageState,
	patch: SerialMonitorConfigPatch,
	options: { runtimeInfo?: DesktopHostRuntimeInfo | null } = {}
): Promise<SerialMonitorPageState> => {
	const configSummary = options.runtimeInfo?.appDataPath
		? await core.config.updateStored.mutate({
				appDataPath: options.runtimeInfo.appDataPath,
				fallbackLanguage: config.lang,
				serialMonitor: { ...state.serialMonitor, ...patch }
			})
		: await core.config.get.query({
				config: {
					...config,
					serialMonitor: { ...state.serialMonitor, ...patch }
				},
				fallbackLanguage: config.lang
			})
	const serialMonitor = configSummary.serialMonitor
	const connectOptions = await resolveNextConnectOptions(core, serialMonitor, serialMonitor.port)

	return {
		...state,
		serialMonitor,
		quickSendList: configSummary.quickSendList,
		inputMode: configSummary.serialInputMode,
		viewMode: configSummary.serialViewMode,
		connectOptions,
		session: state.session?.port === serialMonitor.port ? state.session : null
	}
}
