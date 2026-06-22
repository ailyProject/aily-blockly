import { getAgentWorkspaceSecurityOptions, normalizeAilyAgentConfig } from '../../agent'
import { p } from '../trpc'
import { agentConfigInputSchema } from './schemas'

/**
 * 返回 agent 工作区安全能力的可选项。
 */
export default p
	.input(agentConfigInputSchema)
	.query(({ input }) => getAgentWorkspaceSecurityOptions(normalizeAilyAgentConfig(input.config)))
