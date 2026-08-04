export type FullFlowMode = 'specified-boards' | 'all-boards' | 'project-plaza';

const LEGACY_MODE_FLAGS: Array<{ name: string; mode: FullFlowMode }> = [
  { name: 'AILY_E2E_FULLFLOW', mode: 'specified-boards' },
  { name: 'AILY_E2E_ALL_BOARDS', mode: 'all-boards' },
  { name: 'AILY_E2E_PROJECT_PLAZA', mode: 'project-plaza' },
];

export function readFullFlowMode(env: NodeJS.ProcessEnv = process.env): FullFlowMode | null {
  const explicitMode = env['AILY_E2E_MODE'];
  if (explicitMode) {
    if (isFullFlowMode(explicitMode)) {
      return explicitMode;
    }
    throw new Error(
      `[e2e] AILY_E2E_MODE 必须是 specified-boards、all-boards 或 project-plaza，当前值：${explicitMode}`,
    );
  }

  const enabledLegacyModes = LEGACY_MODE_FLAGS.filter(({ name }) => env[name] === '1');
  if (enabledLegacyModes.length > 1) {
    throw new Error(
      `[e2e] 检测到多个全流程场景开关：${enabledLegacyModes.map(({ name }) => name).join(', ')}。` +
        '请改用 AILY_E2E_MODE 明确选择当前场景，避免一个场景结束后继续运行其他场景。',
    );
  }

  return enabledLegacyModes[0]?.mode ?? null;
}

function isFullFlowMode(value: string): value is FullFlowMode {
  return value === 'specified-boards' || value === 'all-boards' || value === 'project-plaza';
}
