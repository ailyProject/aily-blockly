import type { ToolResultContent } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';

export interface BlocklyToolInvocationContext {
  sessionId?: string;
  toolCallId?: string;
  trace?: { turnId?: string };
  signal?: AbortSignal;
  cwd?: string;
  host?: { getExtension<T>(id: string): T | undefined };
  emitEvent?: (event: unknown) => void;
}

export type InvokeHandler = (
  input: Record<string, unknown>,
  hostAPI: IExternalHostAPI,
  invocationContext?: BlocklyToolInvocationContext,
) => Promise<ToolResultContent>;

export function text(s: string): ToolResultContent {
  return { content: [{ type: 'text', text: s }] };
}

export function error(s: string): ToolResultContent {
  return { content: [{ type: 'text', text: `Error: ${s}` }], isError: true };
}

export function fromToolResult(result: { is_error: boolean; content: string }): ToolResultContent {
  return result.is_error ? error(result.content) : text(result.content);
}
