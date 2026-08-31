export type UploadBoardFamily =
  | 'avr-classic'
  | 'avr-native-usb'
  | 'esp32-uart'
  | 'esp32-native-usb'
  | 'rp-native-usb'
  | 'samd-native-usb'
  | 'native-usb'
  | 'unknown';

export type ExpectedReenumeration = 'none' | 'possible' | 'required';

export interface UploadReadyMarker {
  type: 'text' | 'line' | 'regex' | 'hex';
  value?: string;
  pattern?: string;
  flags?: string;
  timeoutMs: number;
  required: boolean;
}

export interface UploadLogReplay {
  request: {
    mode: 'text' | 'hex';
    data: string;
    appendCr: boolean;
    appendLf: boolean;
  };
  captureMs: number;
  quietMs: number;
  maxBytes: number;
}

export interface UploadRecoveryPolicy {
  protocolVersion: 1;
  boardFamily: UploadBoardFamily;
  expectedReenumeration: ExpectedReenumeration;
  maxWaitMs: number;
  retryIntervalMs: number;
  settleMs: number;
  guard: {
    blockMutationsUntilSettled: true;
    reason: string;
  };
  portMatch: {
    allowPathChange: boolean;
    allowProductIdChange: boolean;
  };
  readyMarker?: UploadReadyMarker;
  logReplay?: UploadLogReplay;
}

export interface UploadRecoveryPolicyInput {
  boardJson?: Record<string, any> | null;
  boardModule?: string;
  uploadParam?: string;
  use1200bpsTouch?: boolean;
  waitForUploadPort?: boolean;
  cdcOnBoot?: boolean;
}

export function resolveUploadRecoveryPolicy(
  input: UploadRecoveryPolicyInput,
): UploadRecoveryPolicy {
  const boardJson = input.boardJson || {};
  const fingerprint = [
    boardJson['core'],
    boardJson['type'],
    boardJson['name'],
    input.boardModule,
    input.uploadParam,
  ].map(value => String(value || '').toLowerCase()).join(' ');
  const family = inferBoardFamily(fingerprint, input);
  const base = familyDefaults(family, fingerprint);
  const override = isRecord(boardJson['serialRecovery'])
    ? boardJson['serialRecovery']
    : {};

  return mergeRecoveryPolicy(base, override);
}

export function normalizeUploadRecoveryPolicy(value: unknown): UploadRecoveryPolicy | null {
  if (!isRecord(value)) return null;
  const family = normalizeBoardFamily(value['boardFamily'], 'unknown');
  return mergeRecoveryPolicy(familyDefaults(family, ''), value);
}

function mergeRecoveryPolicy(
  base: UploadRecoveryPolicy,
  override: Record<string, any>,
): UploadRecoveryPolicy {
  return {
    protocolVersion: 1,
    boardFamily: normalizeBoardFamily(override['boardFamily'], base.boardFamily),
    expectedReenumeration: normalizeReenumeration(
      override['expectedReenumeration'],
      base.expectedReenumeration,
    ),
    maxWaitMs: boundedNumber(override['maxWaitMs'], base.maxWaitMs, 0, 60000),
    retryIntervalMs: boundedNumber(override['retryIntervalMs'], base.retryIntervalMs, 25, 5000),
    settleMs: boundedNumber(override['settleMs'], base.settleMs, 0, 30000),
    guard: {
      blockMutationsUntilSettled: true,
      reason: String(
        override['guard']?.['reason']
        || override['guardReason']
        || base.guard.reason,
      ).slice(0, 160),
    },
    portMatch: {
      allowPathChange: booleanValue(
        override['portMatch']?.['allowPathChange'],
        base.portMatch.allowPathChange,
      ),
      allowProductIdChange: booleanValue(
        override['portMatch']?.['allowProductIdChange'],
        base.portMatch.allowProductIdChange,
      ),
    },
    ...normalizeReadyMarker(override['readyMarker']),
    ...normalizeLogReplay(override['logReplay']),
  };
}

function inferBoardFamily(
  fingerprint: string,
  input: UploadRecoveryPolicyInput,
): UploadBoardFamily {
  if (fingerprint.includes('avr')) {
    return input.use1200bpsTouch || input.waitForUploadPort
      ? 'avr-native-usb'
      : 'avr-classic';
  }
  if (fingerprint.includes('esp32')) {
    const nativeUsbCapableChip = /esp32(?:s2|s3|c3|c6|h2|p4)/.test(fingerprint);
    return input.cdcOnBoot || nativeUsbCapableChip
      ? 'esp32-native-usb'
      : 'esp32-uart';
  }
  if (/\brp(?:2040|2350)\b|raspberry.*pico/.test(fingerprint)) {
    return 'rp-native-usb';
  }
  if (fingerprint.includes('samd')) return 'samd-native-usb';
  if (input.use1200bpsTouch || input.waitForUploadPort) return 'native-usb';
  return 'unknown';
}

function familyDefaults(
  boardFamily: UploadBoardFamily,
  fingerprint: string,
): UploadRecoveryPolicy {
  const common = {
    protocolVersion: 1 as const,
    boardFamily,
    retryIntervalMs: 250,
    guard: {
      blockMutationsUntilSettled: true as const,
      reason: 'firmware-upload-recovery',
    },
  };
  switch (boardFamily) {
    case 'avr-classic':
      return {
        ...common,
        expectedReenumeration: 'none',
        maxWaitMs: 10000,
        settleMs: fingerprint.includes('mega') ? 8000 : 1800,
        guard: { ...common.guard, reason: 'avr-bootloader-settle' },
        portMatch: { allowPathChange: false, allowProductIdChange: false },
      };
    case 'avr-native-usb':
      return {
        ...common,
        expectedReenumeration: 'required',
        maxWaitMs: 25000,
        settleMs: 1000,
        guard: { ...common.guard, reason: 'avr-native-usb-reenumeration' },
        portMatch: { allowPathChange: true, allowProductIdChange: true },
      };
    case 'esp32-native-usb':
      return {
        ...common,
        expectedReenumeration: 'possible',
        maxWaitMs: 20000,
        settleMs: 500,
        portMatch: { allowPathChange: true, allowProductIdChange: true },
      };
    case 'esp32-uart':
      return {
        ...common,
        expectedReenumeration: 'none',
        maxWaitMs: 10000,
        settleMs: 400,
        portMatch: { allowPathChange: false, allowProductIdChange: false },
      };
    case 'rp-native-usb':
      return {
        ...common,
        expectedReenumeration: 'required',
        maxWaitMs: 30000,
        settleMs: 800,
        portMatch: { allowPathChange: true, allowProductIdChange: true },
      };
    case 'samd-native-usb':
    case 'native-usb':
      return {
        ...common,
        expectedReenumeration: 'required',
        maxWaitMs: 25000,
        settleMs: 800,
        portMatch: { allowPathChange: true, allowProductIdChange: true },
      };
    default:
      return {
        ...common,
        expectedReenumeration: 'possible',
        maxWaitMs: 15000,
        settleMs: 500,
        portMatch: { allowPathChange: true, allowProductIdChange: false },
      };
  }
}

function normalizeReadyMarker(value: unknown): Pick<UploadRecoveryPolicy, 'readyMarker'> | {} {
  if (!isRecord(value)) return {};
  const type = String(value['type'] || (value['pattern'] ? 'regex' : 'text')).toLowerCase();
  if (!['text', 'line', 'regex', 'hex'].includes(type)) return {};
  const markerValue = String(value['value'] ?? value['text'] ?? '').slice(0, 500);
  const pattern = String(value['pattern'] || '').slice(0, 500);
  if (type === 'regex' ? !pattern : !markerValue) return {};
  return {
    readyMarker: {
      type: type as UploadReadyMarker['type'],
      ...(markerValue ? { value: markerValue } : {}),
      ...(pattern ? { pattern } : {}),
      ...(value['flags'] ? { flags: String(value['flags']).replace(/[^imsuy]/g, '') } : {}),
      timeoutMs: boundedNumber(value['timeoutMs'], 5000, 100, 30000),
      required: booleanValue(value['required'], false),
    },
  };
}

function normalizeLogReplay(value: unknown): Pick<UploadRecoveryPolicy, 'logReplay'> | {} {
  if (!isRecord(value) || !isRecord(value['request'])) return {};
  const request = value['request'];
  const mode = String(request['mode'] || 'text').toLowerCase() === 'hex' ? 'hex' : 'text';
  const data = String(request['data'] || '').slice(0, 2048);
  if (!data) return {};
  return {
    logReplay: {
      request: {
        mode,
        data,
        appendCr: booleanValue(request['appendCr'], false),
        appendLf: booleanValue(request['appendLf'], false),
      },
      captureMs: boundedNumber(value['captureMs'], 1500, 50, 10000),
      quietMs: boundedNumber(value['quietMs'], 200, 0, 5000),
      maxBytes: boundedNumber(value['maxBytes'], 65536, 1, 1024 * 1024),
    },
  };
}

function normalizeBoardFamily(value: unknown, fallback: UploadBoardFamily): UploadBoardFamily {
  const normalized = String(value || '').toLowerCase() as UploadBoardFamily;
  return [
    'avr-classic',
    'avr-native-usb',
    'esp32-uart',
    'esp32-native-usb',
    'rp-native-usb',
    'samd-native-usb',
    'native-usb',
    'unknown',
  ].includes(normalized) ? normalized : fallback;
}

function normalizeReenumeration(
  value: unknown,
  fallback: ExpectedReenumeration,
): ExpectedReenumeration {
  const normalized = String(value || '').toLowerCase() as ExpectedReenumeration;
  return ['none', 'possible', 'required'].includes(normalized) ? normalized : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
