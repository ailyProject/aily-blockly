/**
 * 项目名校验结果。
 */
export interface ProjectNameValidationResult {
	/** 当前名称是否可用。 */
	valid: boolean
	/** 失败原因。 */
	reason?: string
}

const DEFAULT_INVALID_NAME_PATTERN = /[\/\\\0:\*\?"<>\|\n\r]/
const MAC_EXTRA_INVALID_NAME_PATTERN = /[\s\^$!#%&()=+`~']/

/**
 * 根据宿主平台校验项目名是否合法。
 * @param name - 原始项目名
 * @param platform - 当前宿主平台
 */
export const validateProjectName = (name: string, platform?: string): ProjectNameValidationResult => {
	const trimmedName = name.trim()
	if (!trimmedName) {
		return {
			valid: false,
			reason: '项目名称不能为空'
		}
	}

	if (DEFAULT_INVALID_NAME_PATTERN.test(trimmedName)) {
		return {
			valid: false,
			reason: '项目名称包含非法文件路径字符'
		}
	}

	const isMac = String(platform || '')
		.toLowerCase()
		.includes('mac')
	if (isMac && MAC_EXTRA_INVALID_NAME_PATTERN.test(trimmedName)) {
		return {
			valid: false,
			reason: 'macOS 下项目名称不能包含空格或特殊符号'
		}
	}

	return {
		valid: true
	}
}
