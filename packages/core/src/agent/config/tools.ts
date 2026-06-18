import type { AgentToolsConfig, AilyAgentConfig } from '@shared'

const emptyToolsConfig = (): AgentToolsConfig => ({ enabledTools: [], disabledTools: [] })

/**
 * 读取指定 Agent 的工具配置，并兼容旧版顶层字段。
 * @param config - 当前 Agent 配置
 * @param agentName - Agent 名称
 */
export const getAgentToolsConfig = (config: AilyAgentConfig, agentName: string): AgentToolsConfig => {
	const agentConfig = config.agentTools?.[agentName]
	if (agentConfig) {
		return {
			enabledTools: [...(agentConfig.enabledTools ?? [])],
			disabledTools: [...(agentConfig.disabledTools ?? [])]
		}
	}

	if (agentName === 'mainAgent') {
		return {
			enabledTools: [...(config.enabledTools ?? [])],
			disabledTools: [...(config.disabledTools ?? [])]
		}
	}

	return emptyToolsConfig()
}

/**
 * 更新指定 Agent 的工具配置，并同步 mainAgent 的旧版顶层字段。
 * @param config - 当前 Agent 配置
 * @param agentName - Agent 名称
 * @param agentConfig - 新工具配置
 */
export const setAgentToolsConfig = (
	config: AilyAgentConfig,
	agentName: string,
	agentConfig: AgentToolsConfig
): AilyAgentConfig => {
	const nextConfig: AilyAgentConfig = {
		...config,
		agentTools: {
			...(config.agentTools ?? {}),
			[agentName]: {
				enabledTools: [...agentConfig.enabledTools],
				disabledTools: [...agentConfig.disabledTools]
			}
		}
	}

	if (agentName === 'mainAgent') {
		nextConfig.enabledTools = [...agentConfig.enabledTools]
		nextConfig.disabledTools = [...agentConfig.disabledTools]
	}

	return nextConfig
}
