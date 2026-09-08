export interface ProjectHardwareIntentBoard {
  fqbn: string;
  boardId: string;
  architecture: string;
  mcu: string;
}

/**
 * Projects may select a concrete board variant through a package-owned option
 * while the board package exposes one generic FQBN. Project options therefore
 * participate in the Host projection; Simulator still receives only its
 * provider-neutral, exact board identity.
 */
export function resolveProjectHardwareIntentBoard(
  boardValue: unknown,
  projectValue: unknown,
): ProjectHardwareIntentBoard {
  const board = record(boardValue);
  const project = record(projectValue);
  const projectConfig = record(project['projectConfig']);
  const fqbn = text(board['fqbn']) || text(board['type']);
  const coreSegments = segments(text(board['core']));
  const fqbnSegments = segments(fqbn);
  const boardId =
    text(board['boardId']) ||
    text(projectConfig['pnum']) ||
    fqbnSegments.at(-1) ||
    text(board['name']);
  const architecture =
    text(board['architecture']) ||
    coreSegments.at(-1) ||
    fqbnSegments.at(-2) ||
    fqbnSegments[0];
  const mcu =
    text(board['mcu']) ||
    commandMcu(text(board['linkUploadParam'])) ||
    commandMcu(text(board['uploadParam'])) ||
    inferMcu(boardId, text(board['name']), fqbn);
  if (!fqbn || !boardId || !architecture || !mcu) {
    throw new Error(
      'Current board metadata is incomplete for Scene generation.',
    );
  }
  return { fqbn, boardId, architecture, mcu };
}

function commandMcu(command: string): string {
  return normalizeMcu(
    command.match(/(?:--chip|-p)\s+([a-z0-9_-]+)/iu)?.[1] ?? '',
  );
}

function inferMcu(...values: string[]): string {
  const normalized = values.join(' ').toLowerCase();
  const stm32 = inferStm32Mcu(normalized);
  if (stm32) return stm32;
  for (const candidate of [
    'esp32s3',
    'esp32c3',
    'esp32c6',
    'esp32s2',
    'esp32',
  ]) {
    if (normalized.includes(candidate)) return candidate;
  }
  const avr = normalized.match(/\b(?:atmega|attiny)\d+[a-z0-9]*\b/u)?.[0];
  if (avr) return avr;
  if (/\bmega(?:2560)?\b/u.test(normalized)) return 'atmega2560';
  if (/\b(?:uno|nano)\b/u.test(normalized)) return 'atmega328p';
  if (/\b(?:leonardo|micro)\b/u.test(normalized)) return 'atmega32u4';
  return segments(values.at(-1) ?? '').at(-1) ?? '';
}

function normalizeMcu(value: string): string {
  const normalized = value.toLowerCase();
  return inferStm32Mcu(normalized) ?? normalized;
}

function inferStm32Mcu(value: string): string | null {
  const family = value.match(/stm32([a-z]\d{3})[a-z0-9]*/u)?.[1];
  return family ? `stm32${family}xx` : null;
}

function segments(value: string): string[] {
  return value
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
