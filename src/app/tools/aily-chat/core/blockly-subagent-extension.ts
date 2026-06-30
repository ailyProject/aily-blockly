/**
 * Blockly SubAgent Extension — provides the AgentExecutor to the AgentTool.
 *
 * AgentTool (in aily-lex) calls:
 *   context.host.getExtension<AgentExecutor>('agentExecutor')
 *
 * This helper retrieves the singleton AgentExecutor from the current agent
 * instance and returns it for registration under the 'agentExecutor' key.
 *
 * AgentExecutor provides:
 *  - runSync()    — sync subagent execution (replaces SubAgentManager)
 *  - launchAsync() — background async task
 *  - Depth tracking + lifecycle hooks
 */

import type { AgentExecutor } from 'aily-lex/browser';

type AilyLexModule = typeof import('aily-lex/browser');
type AgentInstance = InstanceType<AilyLexModule['AilyLexAgent']>;

/**
 * Return the AgentExecutor from the given agent instance.
 * Register the result as 'agentExecutor' extension so AgentTool can find it.
 *
 * @param agent - The current AilyLexAgent instance (must be non-null at call time).
 */
export function createBlocklySubagentExtension(
  agent: AgentInstance,
): AgentExecutor {
  return agent.getAgentExecutor();
}
