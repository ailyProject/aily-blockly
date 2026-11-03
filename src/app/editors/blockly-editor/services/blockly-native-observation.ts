import { boundedAbsNativeUiTiming, type AbsNativeTiming, type AbsNativeUiTiming } from '../../../integrations/blockly/abs/abs-diagnostics';
import { NATIVE_CANDIDATE_PHASES, type NativeCandidatePhase, type NativeCandidateProgress } from './blockly-native-progress';

type PhaseTime = { phase: NativeCandidatePhase; elapsedMs: number };
const elapsed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** Realm clock durations, independent of when the host can receive a message. */
export class NativeCandidateProgressReporter {
  private phase: NativeCandidatePhase = 'replay';
  private phaseStarted: number;
  private readonly completed = new Map<NativeCandidatePhase, number>();
  private uiTiming?: AbsNativeUiTiming;
  constructor(private readonly send: (value: Record<string, unknown>) => void, private readonly clock = () => performance.now()) {
    this.phaseStarted = clock();
  }
  readonly progress: NativeCandidateProgress = phase => {
    const now = this.clock();
    if (phase !== this.phase) {
      this.completed.set(this.phase, (this.completed.get(this.phase) ?? 0) + Math.max(0, now - this.phaseStarted));
      this.phase = phase; this.phaseStarted = now;
    }
    this.emit();
  };
  ui(timing: AbsNativeUiTiming): void { this.uiTiming = timing; this.emit(); }
  private emit(): void {
    this.send({ phase: this.phase, completedPhases: [...this.completed].map(([phase, elapsedMs]) => ({ phase, elapsedMs })),
      ...(this.uiTiming ? { ui: this.uiTiming } : {}) });
  }
}

/** Last-delivered evidence only, never an assertion about a blocked realm's
 * current execution point. No per-block contents or unbounded trace history. */
export class NativeCandidateTiming {
  private readonly started: number;
  private receivedAt: number;
  private realmElapsedMs?: number;
  private readonly hostPhases: PhaseTime[] = [];
  private completedPhases: PhaseTime[] = [];
  private ui?: AbsNativeUiTiming;
  private hostPhase: NativeCandidatePhase = 'asset';
  private hostPhaseStarted: number;
  private receivedRealm = false;
  constructor(private readonly clock = () => performance.now()) {
    this.started = this.receivedAt = this.hostPhaseStarted = clock();
  }
  hostPhaseChanged(phase: NativeCandidatePhase): void {
    const now = this.clock();
    if (!this.receivedRealm) this.hostPhases.push({ phase: this.hostPhase, elapsedMs: Math.max(0, now - this.hostPhaseStarted) });
    this.hostPhase = phase; this.hostPhaseStarted = now;
  }
  observe(reply: Record<string, any>): void {
    if (!elapsed(reply['elapsedMs'])) return;
    if (this.realmElapsedMs !== undefined && reply['elapsedMs'] < this.realmElapsedMs) return;
    if (!this.receivedRealm) this.hostPhaseChanged(reply['phase']);
    this.receivedRealm = true; this.receivedAt = this.clock(); this.realmElapsedMs = reply['elapsedMs'];
    if (Array.isArray(reply['completedPhases'])) {
      this.completedPhases = reply['completedPhases'].slice(0, NATIVE_CANDIDATE_PHASES.length)
        .filter((entry: any) => entry && NATIVE_CANDIDATE_PHASES.includes(entry.phase) && elapsed(entry.elapsedMs))
        .map((entry: PhaseTime) => ({ phase: entry.phase, elapsedMs: entry.elapsedMs }));
    }
    this.ui = boundedAbsNativeUiTiming(reply['ui']) ?? this.ui;
  }
  snapshot(): AbsNativeTiming {
    const now = this.clock();
    return { elapsedMs: Math.max(0, now - this.started), lastObservationAgeMs: Math.max(0, now - this.receivedAt),
      ...(this.realmElapsedMs !== undefined ? { realmElapsedMs: this.realmElapsedMs } : {}),
      completedPhases: [...this.hostPhases, ...this.completedPhases].slice(0, NATIVE_CANDIDATE_PHASES.length),
      ...(this.ui ? { ui: { ...this.ui } } : {}) };
  }
}
