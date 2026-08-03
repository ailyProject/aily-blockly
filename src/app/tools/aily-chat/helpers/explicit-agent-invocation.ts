import type {
  ExplicitAgentInvocationChildRequestState,
  ExplicitAgentInvocationRequestState,
} from 'aily-lex/browser';

export interface BuildExplicitAgentInvocationPayloadInput {
  readonly targetAgent: string;
  readonly strippedPrompt: string;
  readonly originalText: string;
  readonly resourcesText?: string | null;
  readonly editFeedback?: string | null;
  readonly childRequest?: ExplicitAgentInvocationChildRequestState;
}

function summarizeTask(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Explicit agent task';
  }
  return normalized.slice(0, 60);
}

export function buildExplicitAgentInvocationPrompt(input: BuildExplicitAgentInvocationPayloadInput): string {
  const task = input.strippedPrompt.trim();
  const resourcesText = typeof input.resourcesText === 'string' && input.resourcesText.trim()
    ? input.resourcesText.trim()
    : '';
  const editFeedback = typeof input.editFeedback === 'string' && input.editFeedback.trim()
    ? input.editFeedback.trim()
    : '';

  return [
    `Handle the following task as ${input.targetAgent}.`,
    ...(resourcesText ? ['Referenced resources:', resourcesText] : []),
    ...(editFeedback ? ['Recent edit context:', editFeedback] : []),
    `User request: ${task || input.originalText}`,
  ].join('\n');
}

export function buildExplicitAgentInvocationPayload(
  input: BuildExplicitAgentInvocationPayloadInput,
): ExplicitAgentInvocationRequestState {
  return {
    kind: 'explicit-agent-invocation',
    targetAgent: input.targetAgent,
    strippedPrompt: input.strippedPrompt,
    originalText: input.originalText,
    source: 'mention',
    prompt: buildExplicitAgentInvocationPrompt(input),
    description: summarizeTask(input.strippedPrompt || input.originalText),
    ...(input.childRequest ? { childRequest: input.childRequest } : {}),
  };
}
