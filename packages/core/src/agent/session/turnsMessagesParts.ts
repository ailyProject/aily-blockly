import type { AgentToolExecution } from './turns/types'

/**
 * 将单个工具执行摘要转换为 assistant message 的 dynamic-tool part。
 * @param execution - 单次工具执行摘要
 */
export const buildToolPart = (execution: AgentToolExecution) => {
	const base = {
		type: 'dynamic-tool' as const,
		toolName: execution.toolName,
		toolCallId: execution.toolCallId
	}

	switch (execution.state) {
		case 'input-streaming':
			return {
				...base,
				state: 'input-streaming' as const,
				...(execution.input !== undefined ? { input: execution.input } : {})
			}
		case 'input-available':
			return {
				...base,
				state: 'input-available' as const,
				input: execution.input
			}
		case 'approval-requested':
			return {
				...base,
				state: 'approval-requested' as const,
				input: execution.input,
				approval: { id: execution.toolCallId }
			}
		case 'approval-responded':
			return {
				...base,
				state: 'approval-responded' as const,
				input: execution.input,
				approval: { id: execution.toolCallId, approved: true as const }
			}
		case 'output-available':
			return {
				...base,
				state: 'output-available' as const,
				input: execution.input,
				output: execution.output,
				...(execution.preliminary !== undefined ? { preliminary: execution.preliminary } : {})
			}
		case 'output-error':
			return {
				...base,
				state: 'output-error' as const,
				input: execution.input,
				errorText: execution.errorText ?? 'Tool execution failed'
			}
		case 'output-denied':
			return {
				...base,
				state: 'output-denied' as const,
				input: execution.input,
				approval: {
					id: execution.toolCallId,
					approved: false as const,
					...(execution.errorText ? { reason: execution.errorText } : {})
				}
			}
	}
}

/**
 * 将工具执行列表统一转换为 dynamic-tool part 列表。
 * @param toolExecutions - 工具执行摘要列表
 */
export const buildToolParts = (toolExecutions: Array<AgentToolExecution>) => toolExecutions.map(buildToolPart)
