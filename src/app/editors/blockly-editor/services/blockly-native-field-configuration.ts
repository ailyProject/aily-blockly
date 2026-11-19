import type * as Blockly from 'blockly';

/** One construction-only worklist. Selectors may replace a field instance;
 * already-configured instances are never run again just to reach a fixed point. */
export class NativeFieldConfiguration {
  private readonly applied = new Map<string, Blockly.Field>();

  constructor(private readonly block: Blockly.Block) {}

  hasApplied(name: string): boolean { return this.applied.has(name); }

  restore<T>(values: Record<string, T>, order: () => readonly string[] | undefined,
    apply: (name: string, value: T, replaced: boolean) => void,
    canDefer: (error: unknown) => boolean): string[] {
    const names = Object.keys(values);
    let remaining = names.length * (names.length + 1);
    while (true) {
      let progress = false;
      for (const name of new Set([...(order() ?? []), ...names])) {
        if (!Object.hasOwn(values, name)) continue;
        const field = this.block.getField(name);
        if (!field || this.applied.get(name) === field) continue;
        try { apply(name, values[name], this.applied.has(name)); }
        catch (error) { if (canDefer(error)) continue; throw error; }
        if (remaining-- <= 0) throw new Error(`Native field configuration did not stabilize: ${this.block.type}/${this.block.id}.`);
        this.applied.set(name, field);
        progress = true;
        // Re-read actual order after every setter: it may replace later fields.
        break;
      }
      if (!progress) break;
    }
    return names.filter(name => this.applied.get(name) !== this.block.getField(name) || !this.applied.has(name));
  }
}
