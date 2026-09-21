import type { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';
import type { AbsArgumentDefinition, AbsSyntaxOptions } from './abs-syntax';
import { indexAbsAbi } from './abs-abi-index';
import { canonicalJsonStringify } from '@domain/project/public-api';

/** A type may use positional syntax only when all captured instances agree.
 * Never borrow one dynamic instance's order/options for a different shape.
 */
export function absSyntaxOptions(
  workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts, fallback: AbsSyntaxOptions = {},
): AbsSyntaxOptions {
  const instances = new Map<string, string[]>();
  const blocks = indexAbsAbi(workspace);
  for (const block of blocks.values()) {
    // Dormant shadows are serialized but have no live field/syntax contracts and
    // are not rendered as calls. They must not make visible calls ambiguous.
    if (!Object.hasOwn(contracts.fields, block.id)) continue;
    const ids = instances.get(block.type);
    if (ids) ids.push(block.id); else instances.set(block.type, [block.id]);
  }
  const common = <T>(type: string, value: (id: string) => T | undefined, otherwise: () => T | undefined): T | undefined => {
    const ids = instances.get(type);
    if (!ids?.length) return otherwise();
    const values = ids.map(value);
    if (values.every(item => item === undefined)) return otherwise();
    return values.every(item => item !== undefined && JSON.stringify(item) === JSON.stringify(values[0])) ? values[0] : undefined;
  };
  const fieldSelectors = (type: string) => common<readonly string[]>(type, id => contracts.selectors?.[id], () => fallback.fieldSelectors?.(type));
  return {
    prepareExtraState: fallback.prepareExtraState,
    fieldSelectors,
    argumentOrder: (type, extraState, fields) => {
      // A mutator's state selects its instance order; another shape is not a default.
      const state = canonicalJsonStringify(extraState ?? null);
      const selectors = fieldSelectors(type);
      // Current declarations can prepare a new variant. Baseline-only parsing
      // selects captured variants by attested selectors, never by arbitrary field differences.
      if (selectors?.length && fallback.fieldSelectors?.(type)?.length) return fallback.argumentOrder?.(type, extraState, fields);
      const ids = instances.get(type)?.filter(id => canonicalJsonStringify(blocks.get(id)?.extraState ?? null) === state
        && (!selectors || selectors.every(name => !Object.hasOwn(fields ?? {}, name)
          || canonicalJsonStringify(blocks.get(id)?.fields?.[name]) === canonicalJsonStringify(fields![name]))));
      if (!ids?.length) return fallback.argumentOrder?.(type, extraState, fields);
      const orders = ids.map(id => contracts.syntax?.[id]);
      if (orders.every(order => order === undefined)) return fallback.argumentOrder?.(type, extraState, fields);
      if (orders.every(order => order !== undefined && JSON.stringify(order) === JSON.stringify(orders[0]))) return orders[0];
      if (selectors?.length && orders.every(order => order !== undefined)) {
        // Only the common prefix is known until the next selector is parsed.
        const prefix = [];
        for (const [index, arg] of orders[0]!.entries()) {
          if (!orders.every(order => JSON.stringify(order![index]) === JSON.stringify(arg))) break;
          prefix.push(arg);
        }
        return prefix;
      }
      return undefined;
    },
    fieldDefinition: (type, name) => common(type, id => contracts.fields[id]?.[name], () => fallback.fieldDefinition?.(type, name)),
  };
}
