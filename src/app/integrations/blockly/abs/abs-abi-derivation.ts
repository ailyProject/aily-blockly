import { absJson } from './abs-json';
import { AbsProjection, AbsSyncError } from './abs-state';

/** Only formatting and the resource marker are retained; all program values come from ABS. */
export interface AbsAbiRecipe {
  source: 'document' | 'workspace';
  marker?: unknown;
  order: Record<string, string[]>;
  space: number | '\t';
  ending: '' | '\n' | '\r\n';
}
const fail = (): never => { throw new AbsSyncError('ABS_ABI_DERIVATION_INVALID', 'ABI is not a derivation of this complete ABS snapshot.'); };
const keyPath = (path: string, key: string) => path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
export function deriveAbsAbi(snapshot: Pick<AbsProjection, 'document' | 'workspace'>, recipe: AbsAbiRecipe): string {
  let value: any = snapshot[recipe.source];
  if (Object.hasOwn(recipe, 'marker')) value = { ...value, $ailyProjectData: recipe.marker };
  const reorder = (item: any, path: string): any => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((child, index) => reorder(child, keyPath(path, String(index))));
    const keys = recipe.order[path];
    if (!keys || [...keys].sort().join('\0') !== Object.keys(item).sort().join('\0')) return fail();
    return Object.fromEntries(keys.map(key => [key, reorder(item[key], keyPath(path, key))]));
  };
  return JSON.stringify(reorder(value, ''), null, recipe.space) + recipe.ending;
}
export function captureAbsAbiRecipe(snapshot: Pick<AbsProjection, 'document' | 'workspace'>, text: string): AbsAbiRecipe {
  const abi = JSON.parse(text);
  const marker = Object.hasOwn(abi, '$ailyProjectData') ? { marker: abi.$ailyProjectData } : {};
  const source = (['document', 'workspace'] as const).find(key => absJson(abi) === absJson(
    Object.hasOwn(marker, 'marker') ? { ...snapshot[key] as object, $ailyProjectData: marker.marker } : snapshot[key]));
  if (!source) return fail();
  const order: Record<string, string[]> = Object.create(null);
  const visit = (item: any, path: string): void => {
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item)) order[path] = Object.keys(item);
    for (const [key, value] of Object.entries(item)) visit(value, keyPath(path, key));
  };
  visit(abi, '');
  for (const space of [0, 2, 4, '\t', 1, 3, 5, 6, 7, 8, 9, 10] as const) for (const ending of ['', '\n', '\r\n'] as const) {
    const recipe: AbsAbiRecipe = { source, ...marker, order, space, ending };
    if (deriveAbsAbi(snapshot, recipe) === text) return recipe;
  }
  return fail();
}
