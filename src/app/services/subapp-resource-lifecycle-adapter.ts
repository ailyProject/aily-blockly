import {
  normalizeUploadRecoveryPolicy,
  type UploadRecoveryPolicy,
} from './upload-recovery-policy';

export interface HostResourceLifecycleRequest {
  action: 'suspend' | 'resume';
  resource: {
    kind: 'serial';
    id: string;
  };
  operationId: string;
  reason: string;
  restore: boolean;
  safeBoundaryTimeoutMs?: number;
  maxWaitMs?: number;
  retryIntervalMs?: number;
  settleMs?: number;
  outcome?: string;
  recovery?: UploadRecoveryPolicy;
}

export function toHostResourceLifecycleRequest(
  signal: string,
  payload: Record<string, unknown> = {},
): HostResourceLifecycleRequest | null {
  const action = signal === 'serial-monitor:disconnect'
    ? 'suspend'
    : signal === 'serial-monitor:connect'
      ? 'resume'
      : null;
  if (!action) return null;

  const portType = String(payload['portType'] || 'serial').toLowerCase();
  if (portType !== 'serial') return null;
  const port = String(payload['port'] || payload['resourceId'] || '');
  if (!port) return null;

  const reason = String(payload['reason'] || 'firmware-upload');
  const operationId = String(
    payload['operationId']
    || `legacy-${reason}-${port}-${String(payload['source'] || 'host')}`,
  );
  const request: HostResourceLifecycleRequest = {
    action,
    resource: { kind: 'serial', id: port },
    operationId,
    reason,
    restore: payload['restore'] !== false,
  };

  if (action === 'suspend') {
    request.safeBoundaryTimeoutMs = boundedNumber(payload['safeBoundaryTimeoutMs'], 1500, 0, 10000);
  } else {
    const recovery = normalizeUploadRecoveryPolicy(payload['recovery']);
    request.maxWaitMs = boundedNumber(payload['maxWaitMs'], recovery?.maxWaitMs ?? 15000, 0, 60000);
    request.retryIntervalMs = boundedNumber(
      payload['retryIntervalMs'],
      recovery?.retryIntervalMs ?? 250,
      25,
      5000,
    );
    request.settleMs = boundedNumber(payload['settleMs'], recovery?.settleMs ?? 500, 0, 30000);
    if (payload['outcome'] !== undefined) request.outcome = String(payload['outcome']);
    if (recovery) request.recovery = recovery;
  }
  return request;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
