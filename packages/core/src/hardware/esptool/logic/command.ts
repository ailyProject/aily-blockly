import type { HardwareEsptoolFlashFileItem, HardwareEsptoolFlashOptions } from '../types'

/**
 * 构建单文件烧录命令。
 * @param input - 命令输入
 */
export const buildHardwareEsptoolFlashCommand = (input: {
	esptoolPath: string
	file: HardwareEsptoolFlashFileItem
	options: Omit<HardwareEsptoolFlashOptions, 'flashFiles'>
	tempFilePath: string
}) => {
	const chip = input.options.chip || 'esp32s3'
	const baudRate = input.options.baudRate || 460800
	const beforeFlash = input.options.beforeFlash || 'default_reset'
	const afterFlash = input.options.afterFlash || 'hard_reset'
	const address = `0x${input.file.address.toString(16)}`

	return `& "${input.esptoolPath}" --chip ${chip} --port ${input.options.port} --baud ${baudRate} --before ${beforeFlash} --after ${afterFlash} write_flash -z --flash_mode dio --flash_freq 80m --flash_size detect ${address} "${input.tempFilePath}"`
}
