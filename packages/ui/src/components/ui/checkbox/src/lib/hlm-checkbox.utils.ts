import { hlm } from 'spartan/utils'

import { HLM_CHECKBOX_BASE_CLASS } from './hlm-checkbox.constants'

import type { ClassValue } from 'clsx'

/**
 * 组装 Checkbox 最终样式类。
 * @param userClass - 用户传入的自定义类
 * @param errorStateClass - 错误态附加类
 */
export const resolveHlmCheckboxClass = (userClass: ClassValue, errorStateClass: string) =>
	hlm(HLM_CHECKBOX_BASE_CLASS, userClass, errorStateClass)
