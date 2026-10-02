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
  const fallbackValue = Symbol('fallback');
  const commonCache = new Map<string, unknown>();
  const ordersCache = new Map<string, readonly AbsArgumentDefinition[] | undefined>();
  const states = new Map([...blocks].map(([id, block]) => [id, canonicalJsonStringify(block.extraState ?? null)]));
  const common = <T>(type: string, key: string, value: (id: string) => T | undefined, otherwise: () => T | undefined): T | undefined => {
    const cacheKey = JSON.stringify([type, key]);
    if (!commonCache.has(cacheKey)) {
      const values = instances.get(type)?.map(value);
      const first = values?.[0];
      const encoded = JSON.stringify(first);
      commonCache.set(cacheKey, !values?.length || values.every(item => item === undefined) ? fallbackValue
        : values.every(item => item !== undefined && JSON.stringify(item) === encoded) ? first : undefined);
    }
    const captured = commonCache.get(cacheKey);
    return captured === fallbackValue ? otherwise() : captured as T | undefined;
  };
  const fieldSelectors = (type: string) => common<readonly string[]>(type, 'selectors', id => contracts.selectors?.[id], () => fallback.fieldSelectors?.(type));
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
      const cacheKey = canonicalJsonStringify([type, state, selectors ?? null, selectors?.map(name =>
        Object.hasOwn(fields ?? {}, name) ? [name, fields![name]] : [name]) ?? null]);
      if (ordersCache.has(cacheKey)) return ordersCache.get(cacheKey);
      const remember = (order: readonly AbsArgumentDefinition[] | undefined) => { ordersCache.set(cacheKey, order); return order; };
      const ids = instances.get(type)?.filter(id => states.get(id) === state
        && (!selectors || selectors.every(name => !Object.hasOwn(fields ?? {}, name)
          || canonicalJsonStringify(blocks.get(id)?.fields?.[name]) === canonicalJsonStringify(fields![name]))));
      if (!ids?.length) return fallback.argumentOrder?.(type, extraState, fields);
      const orders = ids.map(id => contracts.syntax?.[id]);
      if (orders.every(order => order === undefined)) return fallback.argumentOrder?.(type, extraState, fields);
      const first = JSON.stringify(orders[0]);
      if (orders.every(order => order !== undefined && JSON.stringify(order) === first)) return remember(orders[0]);
      if (selectors?.length && orders.every(order => order !== undefined)) {
        // Only the common prefix is known until the next selector is parsed.
        const prefix = [];
        for (const [index, arg] of orders[0]!.entries()) {
          if (!orders.every(order => JSON.stringify(order![index]) === JSON.stringify(arg))) break;
          prefix.push(arg);
        }
        return remember(prefix);
      }
      return remember(undefined);
    },
    fieldDefinition: (type, name) => common(type, 'field:' + name, id => contracts.fields[id]?.[name], () => fallback.fieldDefinition?.(type, name)),
  };
}
