import type { HardwareUploadPhase, HardwareUploadProgressEvent } from './types'

const normalizeHardwareUploadPercent = (value: string | undefined) => {
	if (!value) return undefined
	const parsed = Number.parseFloat(value)
	if (!Number.isFinite(parsed)) return undefined
	return Math.max(0, Math.min(100, parsed))
}

const toProgressEvent = (
	step: string,
	phase: HardwareUploadPhase,
	line: string,
	progress?: number
): HardwareUploadProgressEvent => ({
	step,
	phase,
	line,
	...(typeof progress === 'number' ? { progress } : {})
})

/**
 * 从上传日志行中提取结构化进度事件。
 * @param step - 当前步骤标签
 * @param line - 单行上传日志
 */
export const parseHardwareUploadProgressLine = (step: string, line: string): HardwareUploadProgressEvent | null => {
	const trimmed = line.trim()
	if (!trimmed) return null

	const probePhaseMatch = trimmed.match(/(Erasing|Programming|Verifying)\s+.*?(\d+)%/i)
	if (probePhaseMatch) {
		const phase = probePhaseMatch[1].toLowerCase() as HardwareUploadPhase
		return toProgressEvent(step, phase, trimmed, normalizeHardwareUploadPercent(probePhaseMatch[2]))
	}

	const probeWrittenMatch = trimmed.match(/Wrote\s+and\s+verified\s+address\s+0x[0-9a-f]+\s+\((\d+(?:\.\d+)?)%\)/i)
	if (probeWrittenMatch) {
		return toProgressEvent(step, 'verifying', trimmed, normalizeHardwareUploadPercent(probeWrittenMatch[1]))
	}

	const esptoolMatch = trimmed.match(/Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\((\d+(?:\.\d+)?)\s*%\)/i)
	if (esptoolMatch) {
		return toProgressEvent(step, 'programming', trimmed, normalizeHardwareUploadPercent(esptoolMatch[1]))
	}

	const esptoolBarMatch = trimmed.match(/Writing\s+at\s+0x[0-9a-f]+\s+\[.*?\]\s+(\d+(?:\.\d+)?)%/i)
	if (esptoolBarMatch) {
		return toProgressEvent(step, 'programming', trimmed, normalizeHardwareUploadPercent(esptoolBarMatch[1]))
	}

	const bracketBarMatch = trimmed.match(/\[\s*[=\->#]+\s*\]\s*(\d+(?:\.\d+)?)%/i)
	if (bracketBarMatch) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(bracketBarMatch[1]))
	}

	const pageFractionMatch = trimmed.match(/^(\d+(?:\.\d+)?)%\s+\d+\/\d+/)
	if (pageFractionMatch) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(pageFractionMatch[1]))
	}

	const progressWordMatch = trimmed.match(/(?:进度|Progress)[^\d]*?(\d+(?:\.\d+)?)\s*%/i)
	if (progressWordMatch) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(progressWordMatch[1]))
	}

	const trailingBarPercentMatch = trimmed.match(/\|\s*(\d+(?:\.\d+)?)%\s*$/)
	if (trailingBarPercentMatch) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(trailingBarPercentMatch[1]))
	}

	const genericBarMatch = trimmed.match(/\|\s*#+\s*\|\s*(\d+)%.*$/)
	if (genericBarMatch) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(genericBarMatch[1]))
	}

	const genericPercentMatch = trimmed.match(/\b(\d+(?:\.\d+)?)%\b/)
	if (genericPercentMatch && /(writing|upload|erase|verify|progress|wrote)/i.test(trimmed)) {
		return toProgressEvent(step, 'uploading', trimmed, normalizeHardwareUploadPercent(genericPercentMatch[1]))
	}

	if (/Finished\s+in\s+[\d.]+s/i.test(trimmed) || /Hash of data verified/i.test(trimmed)) {
		return toProgressEvent(step, 'done', trimmed, 100)
	}

	return null
}
