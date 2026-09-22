import type { NativeReplayStep } from './blockly-native-candidate-protocol';

/** Ordered source provenance for a disposable candidate, not a second active runtime. */
export class BlocklyNativeReplayJournal {
  private steps: NativeReplayStep[] = [];
  private revision = 0;
  private unavailable = false;

  append(step: NativeReplayStep): void {
    this.revision++;
    try { this.steps.push(structuredClone(step)); }
    catch { this.unavailable = true; } // Native project use remains unchanged; replay must fail closed.
  }

  capture(assertSession: () => void) {
    assertSession();
    if (this.unavailable) throw new Error('Native replay context contains non-transferable values.');
    const revision = this.revision;
    return {
      steps: structuredClone(this.steps),
      assertCurrent: () => {
        assertSession();
        if (revision !== this.revision) throw new Error('Native replay sources changed during candidate preparation.');
      },
    };
  }
}
