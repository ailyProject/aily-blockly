import { AgentRuntime } from './AgentRuntime'

import type { AgentRuntimeOptions } from './types'

export const createAgentRuntime = (options?: AgentRuntimeOptions) => new AgentRuntime(options)
