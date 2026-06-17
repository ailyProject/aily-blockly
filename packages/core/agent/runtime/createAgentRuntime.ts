import { AgentRuntime } from './AgentRuntime'

import type { AgentRuntimeOptions } from './AgentRuntime'

export const createAgentRuntime = (options?: AgentRuntimeOptions) => new AgentRuntime(options)
