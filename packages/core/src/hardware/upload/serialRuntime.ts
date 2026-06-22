import { SerialPort } from 'serialport'

const sleep = (timeout: number) => new Promise(resolve => setTimeout(resolve, timeout))

const listPortPaths = async () => (await SerialPort.list()).map(port => port.path)

/**
 * 执行 1200bps touch，触发特定开发板进入 bootloader。
 * @param serialPort - 当前串口路径
 */
export const performHardwareUpload1200bpsTouch = (serialPort: string) =>
	new Promise<void>((resolve, reject) => {
		const port = new SerialPort({
			path: serialPort,
			baudRate: 1200,
			autoOpen: false
		})

		port.open(error => {
			if (error) {
				reject(error)
				return
			}

			setTimeout(() => {
				port.close(closeError => {
					if (closeError) {
						reject(closeError)
						return
					}

					setTimeout(() => resolve(), 250)
				})
			}, 250)
		})
	})

/**
 * 轮询等待新的上传串口重新枚举。
 * @param beforePorts - 操作前串口列表
 * @param timeoutMs - 超时时间
 * @param intervalMs - 轮询间隔
 */
export const waitForHardwareUploadPort = async (beforePorts: Array<string>, timeoutMs = 3000, intervalMs = 200) => {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const ports = await listPortPaths()
		const detected = ports.find(port => !beforePorts.includes(port))
		if (detected) return detected
		await sleep(intervalMs)
	}

	return null
}

/**
 * 根据 legacy 上传配置准备最终串口。
 * @param input - 串口上传准备输入
 */
export const prepareHardwareUploadPort = async (input: {
	serialPort: string
	use1200bpsTouch?: boolean
	waitForUpload?: boolean
}) => {
	const beforePorts = input.use1200bpsTouch || input.waitForUpload ? await listPortPaths() : []
	if (input.use1200bpsTouch) {
		await performHardwareUpload1200bpsTouch(input.serialPort).catch(() => undefined)
	}

	if (input.use1200bpsTouch || input.waitForUpload) {
		return (await waitForHardwareUploadPort(beforePorts)) || input.serialPort
	}

	return input.serialPort
}
