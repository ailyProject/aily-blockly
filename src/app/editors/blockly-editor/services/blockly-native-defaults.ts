import type * as Blockly from 'blockly';
import type { AbsNativeCreation } from '../../../integrations/blockly/abs/abs-native-binding';

/** A transaction-local birth journal. IDs reach init, not a post-serialization rewrite. */
export class NativeDefaultCreations {
  readonly entries: AbsNativeCreation[] = [];
  private readonly owners = new Map<string, number>();
  private readonly started = new Set<string>();
  private readonly counts = new Map<number, number>();
  private readonly planned: Map<string, AbsNativeCreation> | undefined;

  constructor(private readonly native: typeof Blockly, replay?: AbsNativeCreation[]) {
    this.planned = replay && new Map(replay.map(entry => [this.key(entry.owner, entry.ordinal), entry]));
  }

  owner(id: string, start: number): void { this.owners.set(id, start); }
  source(id: string): number | undefined { return this.owners.get(id); }
  private key(owner: number, ordinal: number): string { return `${owner}:${ordinal}`; }

  allocate(type: string, id: string | undefined, ownerId: string | undefined): string | undefined {
    if (!ownerId || !this.owners.has(ownerId)) return id;
    if (id === ownerId && !this.started.has(ownerId)) { this.started.add(ownerId); return id; }
    const owner = this.owners.get(ownerId)!;
    const ordinal = this.counts.get(owner) ?? 0;
    this.counts.set(owner, ordinal + 1);
    const planned = this.planned?.get(this.key(owner, ordinal));
    if (this.entries.length >= 2000) throw new Error('Native default creation exceeds block limits.');
    if (this.planned && (!planned || planned.type !== type || id !== undefined && id !== planned.id)) {
      throw new Error('Native default creation changed during identity replay.');
    }
    const assigned = planned?.id ?? id ?? this.native.utils.idGenerator.genUid();
    this.entries.push({ owner, ordinal, type, id: assigned });
    return assigned;
  }

  assertComplete(): void {
    if (this.planned && this.entries.length !== this.planned.size) throw new Error('Native default creation replay is incomplete.');
  }
}
