import {
  createTurnResponseCommand,
  type TurnRequest,
  type TurnRequestCommandKind,
} from 'aily-lex/browser';

export interface UserTurnRoutingCommandResolverContext {
  readonly agentId?: string;
  readonly name: string;
  readonly kind: TurnRequestCommandKind;
}

export interface UserTurnRoutingOptions {
  readonly resolveCommand?: (context: UserTurnRoutingCommandResolverContext) => TurnRequest['metadata'] extends { command?: infer T } ? T | undefined : never;
}

export interface UserTurnPayload {
  llmText: string;
  displayText: string;
  requestMetadata?: TurnRequest['metadata'];
}

export function extractUserTurnRoutingMetadata(
  text: string,
  options?: UserTurnRoutingOptions,
): TurnRequest['metadata'] | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const resolveCommand = (name: string, kind: TurnRequestCommandKind, agentId?: string) => {
    const resolved = options?.resolveCommand?.({ agentId, name, kind });
    return resolved
      ? createTurnResponseCommand(resolved.name, resolved)
      : createTurnResponseCommand(name);
  };

  const agentMatch = /^@([^\s@/]+)(?=\s|$)/.exec(trimmed);
  if (agentMatch) {
    const agentId = agentMatch[1];
    const afterAgent = trimmed.slice(agentMatch[0].length).trimStart();
    const subCommandMatch = /^\/([^\s/]+)(?=\s|$)/.exec(afterAgent);
    if (!subCommandMatch) {
      return {
        agentId,
        requestRouting: {
          customAgentTarget: agentId,
        },
        explicitAgentInvocation: {
          kind: 'explicit-agent-invocation',
          targetAgent: agentId,
          strippedPrompt: afterAgent,
          originalText: trimmed,
          source: 'mention',
        },
        parsedParts: [{ kind: 'agent', agentId, text: `@${agentId}`, promptText: '' }],
      };
    }

    const command = resolveCommand(subCommandMatch[1], 'subcommand', agentId);
    const strippedPrompt = afterAgent.slice(subCommandMatch[0].length).trimStart();
    const childRequest = command
      ? {
        command,
        commandKind: 'subcommand' as const,
        parsedParts: [{ kind: 'subcommand' as const, command, text: `/${command.name}`, promptText: '' as const }],
      }
      : undefined;

    return {
      agentId,
      requestRouting: {
        customAgentTarget: agentId,
      },
      explicitAgentInvocation: {
        kind: 'explicit-agent-invocation',
        targetAgent: agentId,
        strippedPrompt,
        originalText: trimmed,
        source: 'mention',
        ...(childRequest ? { childRequest } : {}),
      },
      parsedParts: [
        { kind: 'agent', agentId, text: `@${agentId}`, promptText: '' },
        ...(command
          ? [{ kind: 'subcommand' as const, command, text: `/${command.name}`, promptText: '' as const }]
          : []),
      ],
    };
  }

  const slashCommandMatch = /^\/([^\s/]+)(?=\s|$)/.exec(trimmed);
  if (!slashCommandMatch) {
    return undefined;
  }

  const command = resolveCommand(slashCommandMatch[1], 'slash');
  return command
    ? {
      command,
      commandKind: 'slash',
      parsedParts: [{ kind: 'slash', command, text: `/${command.name}`, promptText: `/${command.name}` }],
    }
    : undefined;
}

/**
 * Builds the user-visible text and LLM payload for a new main-agent turn.
 *
 * Display text keeps resource context visible to the user while edit feedback
 * stays LLM-only.
 */
export function buildUserTurnPayload(
  text: string,
  resourcesText?: string | null,
  editFeedback?: string | null,
  options?: UserTurnRoutingOptions,
): UserTurnPayload {
  const requestMetadata = extractUserTurnRoutingMetadata(text, options);
  let contextPrefix = '';
  if (editFeedback) contextPrefix += editFeedback + '\n';
  if (resourcesText) contextPrefix += resourcesText + '\n\n';

  if (!contextPrefix) {
    return {
      llmText: text,
      displayText: text,
      ...(requestMetadata ? { requestMetadata } : {}),
    };
  }

  return {
    llmText: contextPrefix + text,
    displayText: (resourcesText ? resourcesText + '\n\n' : '') + text,
    ...(requestMetadata ? { requestMetadata } : {}),
  };
}
