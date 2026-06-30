import type { ToolUseResult } from '../../core/tool-types';

const DISPLAY_ONLY_COMPAT_SUFFIX = '显示兼容壳；实际执行已迁移到 lex runtime。';

export function withDisplayOnlyCompat(description: string): string {
  return `${description} ${DISPLAY_ONLY_COMPAT_SUFFIX}`;
}

export function migratedToLexCoreResult(toolName: string): ToolUseResult {
  return {
    is_error: true,
    content: `${toolName} execution migrated to lex core`,
  };
}