import type { AilyAgentConfig, WorkspaceSecurityName, WorkspaceSecurityOption } from 'shared'

const securityLabels: Record<WorkspaceSecurityName, string> = {
	project: '项目文件',
	library: '库文件'
}

/**
 * 返回归一化后的安全工作区配置。
 * @param config - 当前 Agent 配置
 */
export const getAgentSecurityWorkspaces = (config: AilyAgentConfig) => ({
	project: config.securityWorkspaces?.project ?? true,
	library: config.securityWorkspaces?.library ?? true
})

/**
 * 判断是否允许访问项目文件。
 * @param config - 当前 Agent 配置
 */
export const isAgentProjectAccessEnabled = (config: AilyAgentConfig) => getAgentSecurityWorkspaces(config).project

/**
 * 判断是否允许访问库文件。
 * @param config - 当前 Agent 配置
 */
export const isAgentLibraryAccessEnabled = (config: AilyAgentConfig) => getAgentSecurityWorkspaces(config).library

/**
 * 更新单个安全工作区选项。
 * @param config - 当前 Agent 配置
 * @param name - 目标选项名称
 * @param enabled - 是否启用
 */
export const setAgentSecurityWorkspaceOption = (
	config: AilyAgentConfig,
	name: WorkspaceSecurityName,
	enabled: boolean
): AilyAgentConfig => ({
	...config,
	securityWorkspaces: {
		...getAgentSecurityWorkspaces(config),
		[name]: enabled
	}
})

/**
 * 生成设置界面消费的安全工作区选项列表。
 * @param config - 当前 Agent 配置
 */
export const getAgentWorkspaceSecurityOptions = (config: AilyAgentConfig): Array<WorkspaceSecurityOption> => {
	const security = getAgentSecurityWorkspaces(config)

	return (Object.keys(securityLabels) as Array<WorkspaceSecurityName>).map(name => ({
		name,
		displayName: securityLabels[name],
		enabled: security[name]
	}))
}

/**
 * 从设置页选项列表回写安全工作区配置。
 * @param config - 当前 Agent 配置
 * @param options - 设置页选项列表
 */
export const updateAgentSecurityFromOptions = (
	config: AilyAgentConfig,
	options: Array<WorkspaceSecurityOption>
): AilyAgentConfig =>
	options.reduce(
		(nextConfig, option) => setAgentSecurityWorkspaceOption(nextConfig, option.name, option.enabled),
		config
	)
