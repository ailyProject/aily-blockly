export const AILY_BUILDER_PROGRESS_PREFIX = '[aily-builder:progress]';
export const AILY_BUILDER_PROGRESS_PROTOCOL_VERSION = 1;

export type AilyBuilderProgressStage =
  | 'preparing'
  | 'sketch'
  | 'libraries'
  | 'core'
  | 'linking'
  | 'objcopy'
  | 'resources'
  | 'finalizing'
  | 'complete';

export interface AilyBuilderProgressEvent {
  protocolVersion: number;
  stage: AilyBuilderProgressStage;
  percent: number;
  status: 'running' | 'complete';
  message: string;
}

export type AilyBuilderOutputStream = 'stdout' | 'stderr';

export interface AilyBuilderOutputLine {
  line: string;
  type: AilyBuilderOutputStream;
}

/**
 * Reassembles complete output lines without mixing stdout and stderr chunks.
 */
export class AilyBuilderOutputLineBuffer {
  private readonly buffers: Record<AilyBuilderOutputStream, string> = {
    stdout: '',
    stderr: ''
  };

  append(type: AilyBuilderOutputStream, chunk: string): AilyBuilderOutputLine[] {
    const lines = (this.buffers[type] + chunk).split(/\r\n|\n|\r/);
    this.buffers[type] = lines.pop() || '';
    return lines.map(line => ({ line, type }));
  }

  flush(): AilyBuilderOutputLine[] {
    const lines: AilyBuilderOutputLine[] = [];
    (['stdout', 'stderr'] as const).forEach(type => {
      if (this.buffers[type]) {
        lines.push({ line: this.buffers[type], type });
        this.buffers[type] = '';
      }
    });
    return lines;
  }
}

const VALID_STAGES = new Set<AilyBuilderProgressStage>([
  'preparing',
  'sketch',
  'libraries',
  'core',
  'linking',
  'objcopy',
  'resources',
  'finalizing',
  'complete'
]);

function removeAnsiColors(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

export function isAilyBuilderProgressLine(line: string): boolean {
  return removeAnsiColors(line).includes(AILY_BUILDER_PROGRESS_PREFIX);
}

export function parseAilyBuilderProgressLine(line: string): AilyBuilderProgressEvent | null {
  const normalizedLine = removeAnsiColors(line).trim();
  const prefixIndex = normalizedLine.indexOf(AILY_BUILDER_PROGRESS_PREFIX);
  if (prefixIndex < 0) {
    return null;
  }

  const payloadText = normalizedLine
    .slice(prefixIndex + AILY_BUILDER_PROGRESS_PREFIX.length)
    .trim();
  if (!payloadText) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadText) as Partial<AilyBuilderProgressEvent>;
    if (
      payload.protocolVersion !== AILY_BUILDER_PROGRESS_PROTOCOL_VERSION
      || typeof payload.stage !== 'string'
      || !VALID_STAGES.has(payload.stage as AilyBuilderProgressStage)
      || typeof payload.percent !== 'number'
      || !Number.isFinite(payload.percent)
      || payload.percent < 0
      || payload.percent > 100
      || (payload.status !== 'running' && payload.status !== 'complete')
      || typeof payload.message !== 'string'
    ) {
      return null;
    }

    return {
      protocolVersion: payload.protocolVersion,
      stage: payload.stage as AilyBuilderProgressStage,
      percent: Math.round(payload.percent),
      status: payload.status,
      message: payload.message
    };
  } catch {
    return null;
  }
}
