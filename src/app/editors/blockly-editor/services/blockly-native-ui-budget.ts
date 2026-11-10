import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { NATIVE_CANDIDATE_LIMITS } from './blockly-native-budget';

export type NativeUiTaskKind = 'timer' | 'frame';

/** IDs are addresses, not consumed callback work. Cancelled native renders
 * release queue capacity; scheduling churn still has an independent bound. */
export class NativeUiTaskBudget {
  private registered = 0;
  private cancelled = 0;
  private executed = 0;
  private peakPending = 0;
  private schedulingOperations = 0;
  private frameRegistrations = 0;
  private frameCancellations = 0;
  private frameCallbacks = 0;

  private assert(resource: string, actual: number, limit: number): void {
    if (actual <= limit) return;
    throw new AbsSyncError('ABS_LIMIT',
      `Native UI tasks exceed the finite callback/delay budget (${resource}: ${actual}, limit: ${limit}).`, undefined, [], {
        reason: 'native-ui-capacity', capacity: { phase: 'ui', resource, actual: Math.ceil(actual), limit },
        hint: 'Deterministic virtual UI capacity failure. Retain ABS and repair the host; waiting or retrying unchanged ABS cannot help.',
      });
  }

  private schedule(): void {
    // Count both allocation and cancellation, including attempts to cancel an
    // unknown ID. No unbounded register/cancel loop can hide behind an empty queue.
    this.assert('schedulingOperations', ++this.schedulingOperations, NATIVE_CANDIDATE_LIMITS.createdBlocks * 2);
  }

  register(pending: number, kind: NativeUiTaskKind): void {
    this.schedule();
    this.assert('pendingCallbacks', pending, 512);
    this.registered++;
    if (kind === 'frame') this.frameRegistrations++;
    this.peakPending = Math.max(this.peakPending, pending);
  }

  cancel(kind?: NativeUiTaskKind): void {
    this.schedule();
    if (!kind) return;
    this.cancelled++;
    if (kind === 'frame') this.frameCancellations++;
  }

  execute(kind: NativeUiTaskKind): void {
    this.assert('callbacks', this.executed + 1, 512);
    this.executed++;
    if (kind === 'frame') this.frameCallbacks++;
  }

  delay(single: number, due: number): void {
    this.assert('singleDelay', single, 2000);
    this.assert('virtualDelay', due, 5000);
  }

  counts() {
    return { registered: this.registered, cancelled: this.cancelled, peakPending: this.peakPending,
      schedulingOperations: this.schedulingOperations, frameRegistrations: this.frameRegistrations,
      frameCancellations: this.frameCancellations, frameCallbacks: this.frameCallbacks };
  }
}
