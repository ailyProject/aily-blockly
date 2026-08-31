export type ProjectCreationCategory = 'blockly' | 'coder';

/**
 * Coder 只在配置显式开启时可选；配置缺失或关闭时强制回退 Blockly。
 */
export function resolveInitialProjectCategory(
  coderEnabled: boolean,
  explicitCategory?: ProjectCreationCategory | null,
  preferredRuntimeMode?: string | null,
  fallbackCategory: ProjectCreationCategory = 'blockly',
): ProjectCreationCategory {
  if (!coderEnabled) {
    return 'blockly';
  }

  if (explicitCategory === 'blockly' || explicitCategory === 'coder') {
    return explicitCategory;
  }

  if (preferredRuntimeMode === 'blockly' || preferredRuntimeMode === 'coder') {
    return preferredRuntimeMode;
  }

  return fallbackCategory;
}
