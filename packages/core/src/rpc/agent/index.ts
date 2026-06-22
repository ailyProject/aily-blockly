import { r } from '../trpc'
import { default as getEnabledModels } from './getEnabledModels'
import { default as getSecurityOptions } from './getSecurityOptions'
import { default as normalize } from './normalize'

/**
 * 暴露 agent 配置归一化与只读规则。
 */
export default r({
	normalize,
	getEnabledModels,
	getSecurityOptions
})
