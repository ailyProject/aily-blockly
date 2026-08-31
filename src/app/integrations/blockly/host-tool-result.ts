export interface HostToolResult {
  readonly is_error: boolean;
  readonly content: unknown;
  readonly metadata?: Record<string, unknown>;
}
