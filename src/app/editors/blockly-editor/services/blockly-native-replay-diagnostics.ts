import type { NativeReplayStep } from './blockly-native-candidate-protocol';
import type { NativeRegistrationTaskEvent } from './blockly-native-registration-tasks';

/** Scalar, bounded observations only. Never used as registration/commit authority. */
export type NativeReplayEvent = { step: number } & (
  | { event: 'step-start' | 'step-end' | 'drain-start' | 'drain-end' }
  | NativeRegistrationTaskEvent
);

export function nativeReplayEvent(value: unknown): NativeReplayEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event['step']) || (event['step'] as number) < 0) return undefined;
  const step = event['step'] as number;
  if (['step-start', 'step-end', 'drain-start', 'drain-end'].includes(event['event'] as string)) {
    return { event: event['event'] as 'step-start', step };
  }
  if (!['timer-scheduled', 'timer-start', 'timer-end', 'timer-cancel'].includes(event['event'] as string)) return undefined;
  if (!['id', 'pending'].every(key => Number.isSafeInteger(event[key]) && (event[key] as number) >= 0)
    || !['delayMs', 'elapsedMs'].every(key => typeof event[key] === 'number' && Number.isFinite(event[key]) && (event[key] as number) >= 0)) return undefined;
  return { step, event: event['event'] as NativeRegistrationTaskEvent['event'], id: event['id'] as number,
    pending: event['pending'] as number, delayMs: event['delayMs'] as number, elapsedMs: event['elapsedMs'] as number };
}

export function describeNativeReplayEvent(event: NativeReplayEvent, steps: NativeReplayStep[]): string {
  if (event.event === 'drain-start' || event.event === 'drain-end') return `${event.event} registration tasks`;
  const step = steps[event.step];
  if (!step) return '';
  // Keep only a short package/file suffix. Never include source, field values,
  // project paths, URI credentials or arbitrary extra properties from the realm.
  let label = (step.kind === 'script' ? step.label : step.kind === 'definitions' ? step.libraryName :
    step.kind === 'i18n' ? step.packageName : '') ?? '';
  if (/^[a-z]+:\/\//i.test(label)) {
    try { label = new URL(label).pathname; } catch { label = ''; }
  }
  label = label.split(/[?#]/, 1)[0];
  const suffix = label.replace(/\\/g, '/').split('/').slice(-2).join('/').replace(/[^a-zA-Z0-9._@/-]/g, '_').slice(-96);
  const timer = 'id' in event ? `; timer=${event.id}, requested=${Math.round(event.delayMs)}ms, elapsed=${Math.round(event.elapsedMs)}ms, pending=${event.pending}` : '';
  return `${event.event} step=${event.step} ${step.kind}${suffix ? ` ${suffix}` : ''}${timer}`;
}
