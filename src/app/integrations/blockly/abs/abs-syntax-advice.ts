import { indexAbsAbi } from './abs-abi-index';
import { absJson } from './abs-json';
import type { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';
import type { AbsArgumentDefinition } from './abs-syntax';

interface AbsSyntaxVariant {
  type: string;
  sourceStart: number;
  argsOrder: AbsArgumentDefinition[];
  fields: Record<string, unknown>;
  selectors?: Record<string, string | number | boolean>;
  truncated: boolean;
}

/** Bounded, payload-free descriptions built from an already captured snapshot.
 * Keep discovery and validation on the same argument-order/field evidence. */
export class AbsSyntaxAdviceIndex {
  private readonly entries = new Map<string, { variants: AbsSyntaxVariant[]; seen: Set<string>; bytes: number; truncated: boolean }>();

  constructor(workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts, identities: readonly { start: number; id: string }[]) {
    const blocks = indexAbsAbi(workspace);
    for (const { start, id } of identities) {
      const block = blocks.get(id), args = contracts.syntax?.[id];
      if (!block || !args) continue;
      let entry = this.entries.get(block.type);
      if (!entry) this.entries.set(block.type, entry = { variants: [], seen: new Set(), bytes: 0, truncated: false });
      const fields: Record<string, unknown> = Object.create(null);
      const selectors: Record<string, string | number | boolean> = Object.create(null);
      let limited = args.length > 64;
      for (const arg of args.slice(0, 64).filter(arg => arg.kind === 'field')) {
        const field = contracts.fields[id]?.[arg.name];
        if (!field) continue;
        const { type, min, max, precision } = field;
        const values = field.options?.map(option => option[1]);
        const options = values?.slice(0, 32).filter(value => typeof value !== 'string' || value.length <= 256);
        const optionsTruncated = !!values && options!.length !== values.length;
        const allowedTypes = field.symbol?.allowedTypes;
        const variableTypes = allowedTypes?.slice(0, 32).filter(value => value.length <= 256);
        const variableTypesTruncated = !!allowedTypes && variableTypes!.length !== allowedTypes.length;
        limited ||= optionsTruncated || variableTypesTruncated;
        fields[arg.name] = { type, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
          ...(precision !== undefined ? { precision } : {}), ...(options ? { options, optionsTruncated } : {}),
          ...(variableTypes ? { variableTypes, variableTypesTruncated } : {}) };
        if (contracts.selectors?.[id]?.includes(arg.name)) {
          const value = block.fields?.[arg.name];
          if (typeof value === 'string' && value.length <= 256 || typeof value === 'boolean'
            || typeof value === 'number' && Number.isFinite(value)) selectors[arg.name] = value as string | number | boolean;
          else limited = true;
        }
      }
      const variant = { type: block.type, argsOrder: args.slice(0, 64).map(arg => ({ ...arg })), fields,
        ...(Object.keys(selectors).length ? { selectors } : {}), truncated: limited };
      const key = absJson(variant);
      if (entry.seen.has(key)) continue;
      const bytes = new TextEncoder().encode(key).length;
      if (entry.variants.length === 32 || entry.bytes + bytes > 48 * 1024) { entry.truncated = true; continue; }
      entry.seen.add(key); entry.bytes += bytes; entry.truncated ||= limited;
      entry.variants.push({ ...variant, sourceStart: start });
    }
  }

  describe(types: readonly string[] = [...this.entries.keys()]) {
    const variants: AbsSyntaxVariant[] = [];
    let truncated = false, bytes = 0;
    for (const type of new Set(types)) {
      const entry = this.entries.get(type);
      if (!entry) continue;
      truncated ||= entry.truncated;
      for (const variant of entry.variants) {
        const size = new TextEncoder().encode(absJson(variant)).length;
        if (variants.length === 32 || bytes + size > 48 * 1024) { truncated = true; continue; }
        bytes += size; variants.push(variant);
      }
    }
    // Callers cannot mutate the retained index through a tool response.
    return { authority: false as const, truncated, variants: JSON.parse(absJson(variants)) as AbsSyntaxVariant[] };
  }
}

/** Read-only advice from an already prepared candidate. No probes, authority,
 * persisted IDs, payload values or alternate syntax schema. */
export function describePreparedAbsSyntax(workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts,
  identities: readonly { start: number; id: string }[]) {
  return { scope: 'prepared-candidate' as const, ...new AbsSyntaxAdviceIndex(workspace, contracts, identities).describe() };
}
