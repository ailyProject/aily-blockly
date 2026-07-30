const MAX_SOURCE_BYTES = 192 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_LIBRARIES = 128;
const MAX_HINTS = 128;
const MAX_EVIDENCE_LENGTH = 512;
const PIN_TOKEN = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|\d{1,3})`;

export interface ProjectSceneGenerationRequestIdentity {
  readonly requestId: string;
  readonly projectIdentity: string;
}

export interface ProjectHardwareIntentBoardInput {
  readonly fqbn: string;
  readonly boardId: string;
  readonly architecture: string;
  readonly mcu: string;
}

export interface ProjectHardwareIntentLibraryInput {
  readonly name: string;
  readonly version?: string | null;
}

export interface ProjectHardwareIntentBuildInput {
  readonly request: ProjectSceneGenerationRequestIdentity;
  readonly board: ProjectHardwareIntentBoardInput;
  readonly sourceText: string;
  readonly libraries?: readonly ProjectHardwareIntentLibraryInput[];
  readonly userIntent?: string | null;
}

type HardwareUsageKind =
  | 'gpio-digital-input'
  | 'gpio-digital-output'
  | 'gpio-analog-input'
  | 'gpio-pwm-output'
  | 'i2c-controller'
  | 'spi-controller'
  | 'uart-controller';

interface HardwareHint {
  hintId: string;
  kind: HardwareUsageKind;
  pins: string[];
  pull: 'none' | 'up' | 'down' | null;
  activeLevel: 'high' | 'low' | null;
  evidence: string;
}

/**
 * Builds the only Blockly-owned payload accepted by SceneGenerationBroker.
 * The input is copied into a bounded semantic snapshot; host paths, workspace
 * objects, Scene bodies and legacy connection-graph bodies are not accepted.
 */
export async function buildProjectHardwareIntentSnapshot(
  input: ProjectHardwareIntentBuildInput,
): Promise<Record<string, unknown>> {
  requireOnlyKeys(input as unknown as Record<string, unknown>, [
    'request',
    'board',
    'sourceText',
    'libraries',
    'userIntent',
  ], 'Project hardware intent input', true);
  const request = requireRecord(input.request, 'request');
  requireOnlyKeys(request, ['requestId', 'projectIdentity'], 'request');
  const board = requireRecord(input.board, 'board');
  requireOnlyKeys(board, ['fqbn', 'boardId', 'architecture', 'mcu'], 'board');
  const sourceText = requireString(input.sourceText, 'sourceText');
  if (utf8Length(sourceText) > MAX_SOURCE_BYTES) {
    throw new Error('Generated Arduino source exceeds the 192 KiB Scene generation limit.');
  }

  const libraries = normalizeLibraries(input.libraries ?? []);
  const hardwareHints = inferArduinoHardwareHints(sourceText);
  const userIntent = input.userIntent === undefined || input.userIntent === null
    ? null
    : boundedText(input.userIntent, 'userIntent');
  const snapshot = {
    schemaVersion: 1,
    kind: 'aily-project-hardware-intent-snapshot',
    requestId: portableIdentifier(request['requestId'], 'requestId'),
    projectIdentity: portableIdentifier(
      request['projectIdentity'],
      'projectIdentity',
    ),
    board: {
      fqbn: boundedText(board['fqbn'], 'board.fqbn'),
      boardId: boundedText(board['boardId'], 'board.boardId'),
      architecture: boundedText(board['architecture'], 'board.architecture'),
      mcu: boundedText(board['mcu'], 'board.mcu'),
    },
    source: {
      language: 'arduino-cpp',
      revision: await sha256(sourceText),
      text: sourceText,
    },
    libraries,
    hardwareHints,
    userIntent,
  };
  if (utf8Length(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) {
    throw new Error('Project hardware intent snapshot exceeds the 256 KiB limit.');
  }
  return structuredClone(snapshot);
}

export function inferArduinoHardwareHints(sourceText: string): HardwareHint[] {
  const source = requireString(sourceText, 'sourceText');
  const hints = new Map<string, HardwareHint>();

  collectMatches(
    source,
    new RegExp(String.raw`\bpinMode\s*\(\s*(${PIN_TOKEN})\s*,\s*(INPUT_PULLUP|INPUT_PULLDOWN|INPUT|OUTPUT)\s*\)`, 'gu'),
    (match) => {
      const pin = match[1];
      const mode = match[2];
      addHint(hints, {
        kind: mode === 'OUTPUT' ? 'gpio-digital-output' : 'gpio-digital-input',
        pins: [pin],
        pull: mode === 'OUTPUT'
          ? null
          : mode === 'INPUT_PULLUP'
            ? 'up'
            : mode === 'INPUT_PULLDOWN'
              ? 'down'
              : 'none',
        activeLevel: null,
        evidence: evidenceFor(source, match.index, match[0]),
      });
    },
  );

  collectMatches(
    source,
    new RegExp(String.raw`\bdigitalWrite\s*\(\s*(${PIN_TOKEN})\s*,\s*(HIGH|LOW|[^,)]+)\s*\)`, 'gu'),
    (match) => addHint(hints, {
      kind: 'gpio-digital-output',
      pins: [match[1]],
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }),
  );

  collectMatches(
    source,
    new RegExp(String.raw`\banalogRead\s*\(\s*(${PIN_TOKEN})\s*\)`, 'gu'),
    (match) => addHint(hints, {
      kind: 'gpio-analog-input',
      pins: [match[1]],
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }),
  );

  for (const pattern of [
    new RegExp(String.raw`\banalogWrite\s*\(\s*(${PIN_TOKEN})\s*,`, 'gu'),
    new RegExp(String.raw`\bledcAttach(?:Channel)?\s*\(\s*(${PIN_TOKEN})\s*,`, 'gu'),
  ]) {
    collectMatches(source, pattern, (match) => addHint(hints, {
      kind: 'gpio-pwm-output',
      pins: [match[1]],
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }));
  }

  collectMatches(
    source,
    new RegExp(String.raw`\bWire(?:\d+)?\.begin\s*\(\s*(${PIN_TOKEN})\s*,\s*(${PIN_TOKEN})`, 'gu'),
    (match) => addHint(hints, {
      kind: 'i2c-controller',
      pins: [match[1], match[2]],
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }),
  );

  collectMatches(
    source,
    new RegExp(String.raw`\bSPI(?:\d+)?\.begin\s*\(\s*(${PIN_TOKEN})\s*,\s*(${PIN_TOKEN})\s*,\s*(${PIN_TOKEN})(?:\s*,\s*(${PIN_TOKEN}))?`, 'gu'),
    (match) => addHint(hints, {
      kind: 'spi-controller',
      pins: [match[1], match[2], match[3], match[4]].filter(Boolean),
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }),
  );

  collectMatches(
    source,
    new RegExp(String.raw`\bSerial\d*\.begin\s*\(\s*[^,()]+\s*,\s*[^,()]+\s*,\s*(${PIN_TOKEN})\s*,\s*(${PIN_TOKEN})`, 'gu'),
    (match) => addHint(hints, {
      kind: 'uart-controller',
      pins: [match[1], match[2]],
      pull: null,
      activeLevel: null,
      evidence: evidenceFor(source, match.index, match[0]),
    }),
  );

  return [...hints.values()].slice(0, MAX_HINTS).map((hint, index) => ({
    ...hint,
    hintId: `hardware-hint-${String(index + 1).padStart(3, '0')}`,
  }));
}

function normalizeLibraries(
  libraries: readonly ProjectHardwareIntentLibraryInput[],
): Array<{ name: string; version: string | null }> {
  if (!Array.isArray(libraries)) throw new Error('libraries must be an array.');
  const normalized = new Map<string, { name: string; version: string | null }>();
  for (const [index, value] of libraries.entries()) {
    const library = requireRecord(value, `libraries[${index}]`);
    requireOnlyKeys(library, ['name', 'version'], `libraries[${index}]`, true);
    const name = boundedText(library['name'], `libraries[${index}].name`);
    if (normalized.has(name)) continue;
    normalized.set(name, {
      name,
      version: library['version'] === undefined || library['version'] === null
        ? null
        : boundedText(library['version'], `libraries[${index}].version`),
    });
  }
  if (normalized.size > MAX_LIBRARIES) {
    throw new Error(`libraries exceeds the ${MAX_LIBRARIES}-item limit.`);
  }
  return [...normalized.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function addHint(
  hints: Map<string, HardwareHint>,
  input: Omit<HardwareHint, 'hintId'>,
): void {
  if (hints.size >= MAX_HINTS) return;
  const pins = [...new Set(input.pins.map(pin => portableIdentifier(pin, 'hardware pin')))];
  const key = `${input.kind}\u0000${pins.join('\u0000')}\u0000${input.pull ?? ''}`;
  if (hints.has(key)) return;
  hints.set(key, {
    hintId: '',
    ...input,
    pins,
    evidence: input.evidence.slice(0, MAX_EVIDENCE_LENGTH),
  });
}

function collectMatches(
  source: string,
  pattern: RegExp,
  collect: (match: RegExpExecArray) => void,
): void {
  let match: RegExpExecArray | null;
  while (hintsRemain() && (match = pattern.exec(source)) !== null) collect(match);

  function hintsRemain(): boolean {
    return pattern.lastIndex <= source.length;
  }
}

function evidenceFor(source: string, index: number, fallback: string): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const lineEndCandidate = source.indexOf('\n', index);
  const lineEnd = lineEndCandidate < 0 ? source.length : lineEndCandidate;
  return (source.slice(lineStart, lineEnd).trim() || fallback.trim())
    .slice(0, MAX_EVIDENCE_LENGTH);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optionalMissing = false,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label}.${key} is not allowed.`);
  }
  if (optionalMissing) return;
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
  }
}

function portableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a portable identifier.`);
  }
  return value;
}

function boundedText(value: unknown, label: string): string {
  const normalized = requireString(value, label).trim();
  if (normalized.length < 1 || normalized.length > 512) {
    throw new Error(`${label} must be non-empty bounded text.`);
  }
  return normalized;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
