import { normalizeAilyAgentConfig } from '../../agent'
import { p } from '../trpc'
import { agentConfigInputSchema } from './schemas'

/**
 * 归一化 agent 配置，补齐缺省模型、工具和安全选项。
 */
export default p.input(agentConfigInputSchema).query(({ input }) => normalizeAilyAgentConfig(input.config))
