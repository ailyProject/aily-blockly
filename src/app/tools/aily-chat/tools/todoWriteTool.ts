import type { ToolUseResult } from '../core/tool-types';

export function injectTodoReminder<T extends ToolUseResult>(result: T, _toolName?: string): T {
  return result;
}
