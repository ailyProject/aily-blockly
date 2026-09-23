import { publishProjectText } from '@core/platform/public-api';
import type { GeneratorMacroEffect } from './generator-project-effects';

/** Preserve user macros; retire only unchanged values previously owned by generation. */
export function mergeGeneratorMacros(pkg: Record<string, any>, effects: readonly GeneratorMacroEffect[]) {
  const macros = new Map<string, string>();
  for (const item of pkg['MACROS'] ?? []) {
    const value = String(Array.isArray(item) ? item[0] : item).trim();
    if (value) macros.set(value.split('=')[0], value);
  }
  for (const [name, value] of Object.entries(pkg['ailyGeneratorMacros'] ?? {})) {
    if (macros.get(name) === value) macros.delete(name);
  }
  const owned: Record<string, string> = Object.create(null);
  for (const { name, value } of effects) {
    if (value === null) macros.delete(name);
    else { macros.set(name, value); owned[name] = value; }
  }
  return { ...pkg, MACROS: [...macros.values()].map(value => [value]), ailyGeneratorMacros: owned };
}

/** Called only by save/build publication, never candidate validation or preview. */
export async function publishGeneratorMacros(project: string, effects: readonly GeneratorMacroEffect[] | undefined, assertCurrent: () => void) {
  if (!effects) return;
  assertCurrent();
  const files = window['fs'];
  const original = files.readFileSync(`${project}/package.json`, 'utf8');
  const pkg = JSON.parse(original);
  if (!effects.length && !pkg.ailyGeneratorMacros) return;
  const next = JSON.stringify(mergeGeneratorMacros(pkg, effects), null, 2);
  if (next === original) return;
  await publishProjectText(project, 'package.json', next, original, assertCurrent, files);
  assertCurrent();
}
