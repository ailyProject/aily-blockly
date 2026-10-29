import {
  validateProjectHardwareIntentBoardV1,
  type ProjectHardwareIntentBoardV1,
} from '@aily-project/simulator-protocol/scene';

export type ProjectHardwareIntentBoard = ProjectHardwareIntentBoardV1;

/**
 * Projects may select a concrete board variant through a package-owned option
 * while the board package exposes one generic FQBN. Project options therefore
 * participate in the Host projection; Simulator still receives only its
 * provider-neutral, exact board identity.
 */
export function resolveProjectHardwareIntentBoard(
  boardValue: unknown,
  projectValue: unknown,
  installedBoardPackageValue?: unknown,
  targetMarkers?: Readonly<{ boardId?: string; mcu?: string }> | null,
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
  const declaredMcu = text(board['mcu']).toLowerCase();
  const resolvedMcu = text(targetMarkers?.mcu).toLowerCase();
  if (targetMarkers?.boardId !== undefined && targetMarkers.boardId !== boardId) {
    throw new Error('Resolved compiler Board identity conflicts with the current project selection.');
  }
  if (declaredMcu && resolvedMcu && !compatibleMcu(declaredMcu, resolvedMcu)) {
    throw new Error('Resolved compiler MCU conflicts with the current Board declaration.');
  }
  if (!declaredMcu && architecture === 'stm32' && !resolvedMcu) {
    throw new Error('Exact STM32 MCU identity requires current resolved compiler target markers.');
  }
  const mcu =
    declaredMcu || resolvedMcu ||
    commandMcu(text(board['linkUploadParam'])) ||
    commandMcu(text(board['uploadParam'])) ||
    inferMcu(boardId, text(board['name']), fqbn);
  if (!fqbn || !boardId || !architecture || !mcu) {
    throw new Error(
      'Current board metadata is incomplete for Scene generation.',
    );
  }
  let projectPackage: ProjectHardwareIntentBoard['projectPackage'];
  if (installedBoardPackageValue !== undefined) {
    const installed = record(installedBoardPackageValue);
    const name = text(installed['name']);
    if (![project['dependencies'], project['boardDependencies']]
      .some(group => Object.hasOwn(record(group), name))) {
      throw new Error('Installed Board package is not selected by the current project.');
    }
    projectPackage = { name, version: text(installed['version']) };
  }
  return validateProjectHardwareIntentBoardV1({ fqbn, boardId, architecture, mcu,
    ...(projectPackage ? { projectPackage } : {}),
  });
}

function compatibleMcu(left: string, right: string): boolean {
  if (left === right) return true;
  // A compiler product family may be less specific than an explicit Board
  // declaration. It cannot replace that declaration or equate distinct chips.
  return (/^stm32[a-z]\d{3}xx$/u.test(left) && inferStm32Mcu(right) === left)
    || (/^stm32[a-z]\d{3}xx$/u.test(right) && inferStm32Mcu(left) === right);
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
    'esp32c5',
    'esp32c6',
    'esp32h2',
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
