import { stringifyProjectJson } from '@domain/project/project-document-json';
import { absJson } from './abs-json';
import { AbsProjection, AbsSyncError } from './abs-state';

/** Only formatting and the resource marker are retained; all program values come from ABS. */
export interface AbsAbiRecipe {
  source: 'document' | 'workspace';
  marker?: unknown;
  /** New records use object preorder; legacy records address every object by its full JSON pointer. */
  order: Record<string, string[]> | string[][];
  space: number | '\t';
  ending: '' | '\n' | '\r\n';
}
const fail = (): never => { throw new AbsSyncError('ABS_ABI_DERIVATION_INVALID', 'ABI is not a derivation of this complete ABS snapshot.'); };
const keyPath = (path: string, key: string) => path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
export function deriveAbsAbi(snapshot: Pick<AbsProjection, 'document' | 'workspace'>, recipe: AbsAbiRecipe): string {
  let value: any = snapshot[recipe.source];
  if (Object.hasOwn(recipe, 'marker')) value = { ...value, $ailyProjectData: recipe.marker };
  const compact = Array.isArray(recipe.order);
  let position = 0;
  let ordered: any;
  const pending = [{ item: value, path: '', assign: (value: any) => { ordered = value; } }];
  while (pending.length) {
    const { item, path, assign } = pending.pop()!;
    if (!item || typeof item !== 'object') { assign(item); continue; }
    const array = Array.isArray(item);
    const keys = array ? Object.keys(item) : compact ? recipe.order[position++] : recipe.order[path];
    if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')
      || [...keys].sort().join('\0') !== Object.keys(item).sort().join('\0')) return fail();
    const result: any = array ? [] : {};
    assign(result);
    // Create keys in their original order, then visit children in preorder.
    for (const key of keys) Object.defineProperty(result, key, { value: undefined, enumerable: true, writable: true, configurable: true });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      pending.push({ item: item[key], path: compact ? '' : keyPath(path, key), assign: value => { result[key] = value; } });
    }
  }
  if (compact && position !== recipe.order.length) return fail();
  return stringifyProjectJson(ordered, recipe.space) + recipe.ending;
}
export function captureAbsAbiRecipe(snapshot: Pick<AbsProjection, 'document' | 'workspace'>, text: string): AbsAbiRecipe {
  const abi = JSON.parse(text);
  const marker = Object.hasOwn(abi, '$ailyProjectData') ? { marker: abi.$ailyProjectData } : {};
  const source = (['document', 'workspace'] as const).find(key => absJson(abi) === absJson(
    Object.hasOwn(marker, 'marker') ? { ...snapshot[key] as object, $ailyProjectData: marker.marker } : snapshot[key]));
  if (!source) return fail();
  const order: string[][] = [];
  const pending = [abi];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item)) order.push(Object.keys(item));
    pending.push(...Object.values(item).reverse());
  }
  for (const space of [0, 2, 4, '\t', 1, 3, 5, 6, 7, 8, 9, 10] as const) for (const ending of ['', '\n', '\r\n'] as const) {
    const recipe: AbsAbiRecipe = { source, ...marker, order, space, ending };
    if (deriveAbsAbi(snapshot, recipe) === text) return recipe;
  }
  return fail();
}
