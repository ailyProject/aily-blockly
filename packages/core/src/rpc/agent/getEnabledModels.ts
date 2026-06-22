import { getEnabledAgentModels, normalizeAilyAgentConfig } from '../../agent'
import { p } from '../trpc'
import { agentConfigInputSchema } from './schemas'

/**
 * 返回当前 agent 配置中可用的模型清单。
 */
export default p
	.input(agentConfigInputSchema)
	.query(({ input }) => getEnabledAgentModels(normalizeAilyAgentConfig(input.config)))
