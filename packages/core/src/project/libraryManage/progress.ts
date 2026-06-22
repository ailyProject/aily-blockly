import type { ProjectBlocklyLibraryProgressEvent, ProjectBlocklyLibraryProgressPhase } from '../types'

const parseProgressCount = (line: string, key: string) => {
	const match = line.match(new RegExp(`${key}\\s+(\\d+)`, 'i'))
	return match ? Number.parseInt(match[1], 10) : undefined
}

const createProgressEvent = (
	phase: ProjectBlocklyLibraryProgressPhase,
	line: string,
	input: {
		resolved?: number
		reused?: number
		downloaded?: number
		added?: number
	}
): ProjectBlocklyLibraryProgressEvent => ({
	phase,
	line,
	resolved: input.resolved,
	reused: input.reused,
	downloaded: input.downloaded,
	added: input.added
})

const parsePnpmProgressLine = (line: string): ProjectBlocklyLibraryProgressEvent | null => {
	const trimmed = line.trim()
	if (!trimmed) return null

	if (/^Progress:/i.test(trimmed)) {
		const resolved = parseProgressCount(trimmed, 'resolved')
		const reused = parseProgressCount(trimmed, 'reused')
		const downloaded = parseProgressCount(trimmed, 'downloaded')
		const added = parseProgressCount(trimmed, 'added')

		let phase: ProjectBlocklyLibraryProgressPhase = 'resolving'
		if ((downloaded ?? 0) > 0) {
			phase = 'downloading'
		}
		if ((added ?? 0) > 0) {
			phase = 'linking'
		}

		return createProgressEvent(phase, trimmed, {
			resolved,
			reused,
			downloaded,
			added
		})
	}

	if (/^Packages:\s+/i.test(trimmed)) {
		return createProgressEvent('resolving', trimmed, {})
	}

	if (/already up to date/i.test(trimmed) || /^Done in /i.test(trimmed)) {
		return createProgressEvent('done', trimmed, {})
	}

	if (/ERR_PNPM_/i.test(trimmed) || /^ ERR_/i.test(trimmed) || /^ERROR\b/i.test(trimmed)) {
		return createProgressEvent('error', trimmed, {})
	}

	return null
}

/**
 * 从包管理器完整输出中提取结构化进度事件。
 * @param stdout - 标准输出文本
 * @param stderr - 标准错误文本
 */
export const parseProjectLibraryProgressEvents = (
	stdout: string,
	stderr: string
): Array<ProjectBlocklyLibraryProgressEvent> => {
	const progressEvents: Array<ProjectBlocklyLibraryProgressEvent> = []
	const seen = new Set<string>()

	for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
		const event = parsePnpmProgressLine(line)
		if (!event) continue

		const dedupeKey = `${event.phase}:${event.line}`
		if (seen.has(dedupeKey)) continue
		seen.add(dedupeKey)
		progressEvents.push(event)
	}

	return progressEvents
}
