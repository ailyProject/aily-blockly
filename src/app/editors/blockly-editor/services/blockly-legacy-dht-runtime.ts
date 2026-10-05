import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { DeclarativeBlockSnapshot } from './blockly-declarative-block-catalog';

const READ_TYPES = ['dht_read_temperature', 'dht_read_humidity', 'dht_read_success'] as const;

/** Adapt a saved variable-based DHT graph only when the installed library
 * actually exposes the older TYPE/PIN shape. The source ABI is not rewritten. */
export function adaptLegacyDhtRuntimeState<T>(source: T, definitions: Pick<DeclarativeBlockSnapshot, 'get'>): T {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const hasFields = (type: string, required: readonly string[]) => {
    const definition = definitions.get(type);
    const names = definition?.['args0']?.filter((arg: any) => arg?.type?.startsWith('field_')).map((arg: any) => arg.name);
    return Array.isArray(names) && !names.includes('VAR') && required.every(name => names.includes(name));
  };
  if (!hasFields('dht_init', ['TYPE', 'PIN']) || READ_TYPES.some(type => !hasFields(type, ['TYPE', 'PIN']))) return source;
  if (!collectProjectBlocks(source).some(({ state }) => state['type'] === 'dht_init'
    && typeof (state['fields'] as Record<string, unknown> | undefined)?.['VAR'] === 'string')) return source;

  const document = structuredClone(source) as any;
  const entries = collectProjectBlocks(document);
  const variables = new Map<string, string>();
  for (const model of document.variables ?? []) {
    if (model?.type === 'DHT' && typeof model.id === 'string' && typeof model.name === 'string') {
      variables.set(model.id, model.name);
    }
  }
  const sensors = new Map<string, { type: string; pin: string }>();
  const ambiguous = new Set<string>();
  for (const { state } of entries) {
    if (state['type'] !== 'dht_init') continue;
    const fields = state['fields'] as Record<string, any> | undefined, name = fields?.['VAR'];
    if (typeof name !== 'string' || typeof fields['TYPE'] !== 'string' || typeof fields['PIN'] !== 'string') continue;
    if (sensors.has(name)) ambiguous.add(name);
    else sensors.set(name, { type: fields['TYPE'], pin: fields['PIN'] });
  }
  if (ambiguous.size) return source;
  const reads = entries.filter(({ state }) => READ_TYPES.includes(state['type'] as typeof READ_TYPES[number]));
  for (const { state } of reads) {
    const fields = state['fields'] as Record<string, any> | undefined;
    if (!fields || !Object.hasOwn(fields, 'VAR')) continue;
    const name = variables.get(fields['VAR']?.id);
    if (!name || !sensors.has(name) || fields['TYPE'] !== undefined || fields['PIN'] !== undefined) return source;
  }
  let changed = false;
  for (const { state } of reads) {
    const fields = state['fields'] as Record<string, any> | undefined;
    if (!fields || !Object.hasOwn(fields, 'VAR')) continue;
    const name = variables.get(fields['VAR']?.id), sensor = name ? sensors.get(name) : undefined;
    if (!sensor) continue;
    delete fields['VAR'];
    fields['TYPE'] = sensor.type;
    fields['PIN'] = sensor.pin;
    changed = true;
  }
  for (const { state } of entries) {
    if (state['type'] !== 'dht_init') continue;
    const fields = state['fields'] as Record<string, any> | undefined, name = fields?.['VAR'];
    if (typeof name !== 'string' || !sensors.has(name)) continue;
    delete fields['VAR'];
    changed = true;
  }
  return changed ? document : source;
}
