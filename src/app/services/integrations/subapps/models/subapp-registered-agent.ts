/** A borrowed request port on an existing presentation instance. No Runtime,
 * Session or product lifetime is created or transferred by this interface. */
export interface SubappRegisteredAgentContext {
  readonly ownerSessionId: string;
  readonly sessionId?: string;
  readonly ownerLeaseId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly workspaceRoot?: string;
  readonly developmentMode?: 'blockly' | 'coder';
}

export type SubappRegisteredAgentRequest = (
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
  context: SubappRegisteredAgentContext,
) => Promise<unknown>;

/** The same trusted per-tool selection used by the presentation component. */
export function getChildToolPresentationPlatform(
  toolId: string,
  platform: 'native' | 'web',
  overrides: Readonly<Record<string, 'native' | 'web'>>,
): 'native' | 'web' {
  return Object.hasOwn(overrides, toolId) ? overrides[toolId] ?? platform : platform;
}

export function subappRegisteredAgentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
