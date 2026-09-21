import { sha256Hex } from '../../../utils/crypto.utils';

/** A proven model effect, independent of ABS spelling and block argument order. */
export interface VariableDeclarationContract {
  nameField: string;
  nativeType: string;
  owner: { type: string; input: string };
}
export interface VariableDeclarationRegistration {
  get(type: string): VariableDeclarationContract | undefined;
  assertCurrent(): void;
}
// Audited core-variables generator, normalized LF. A name/version alone is not provenance.
const sourceHashes = new Set([
  '649a4ad7fb764dba056225b26f1a3fe3d25d96caad1fb2cbc9a3541825623450',
  // Installed preview differs only by two unused GORP reads; model/scope effects are identical.
  'ec225f027de729fe77f5f33efc8afcbe61c2cacea61b94b7c014d2b4eba3122a',
]);
const registrations = new WeakMap<object, { owner: object; capture(): VariableDeclarationRegistration }>();
export function captureVariableDeclarationRegistration(registry: object): VariableDeclarationRegistration | undefined {
  return registrations.get(registry)?.capture();
}
export function clearVariableDeclarationRegistration(registry: object, owner: object): void {
  if (registrations.get(registry)?.owner === owner) registrations.delete(registry);
}

/** Runs at the existing generator load boundary; no probe workspace or library edits. */
export async function registerVariableDeclarationContract(
  source: string, realm: any, generator: any, registry: object, owner: object, isCurrent: () => boolean,
): Promise<void> {
  if (!source.includes('function registerVariableToBlockly(')) return;
  const handler = generator.forBlock?.['variable_define'];
  const helpers = ['registerVariableToBlockly', 'addVariableToToolbox', 'renameVariableInBlockly', 'isBlockConnected']
    .map(name => [name, Object.getOwnPropertyDescriptor(realm, name)?.value] as const);
  const intact = () => isCurrent() && typeof handler === 'function' && generator.forBlock?.['variable_define'] === handler
    && helpers.every(([name, fn]) => typeof fn === 'function' && Object.getOwnPropertyDescriptor(realm, name)?.value === fn);
  if (!sourceHashes.has(await sha256Hex(source.replace(/\r\n/g, '\n'))) || !intact()) return;
  registrations.set(registry, { owner, capture: () => {
    let used = false;
    const entries = JSON.stringify(realm.ENTRY_BLOCK_TYPES);
    const current = () => intact() && JSON.stringify(realm.ENTRY_BLOCK_TYPES) === entries;
    const assertCurrent = () => { if (used && !current()) throw new Error('Variable declaration runtime contract changed.'); };
    return { assertCurrent, get: type => {
      assertCurrent();
      if (type !== 'variable_define' || !current() || !Array.isArray(realm.ENTRY_BLOCK_TYPES)
        || realm.ENTRY_BLOCK_TYPES.includes('arduino_global')) return undefined;
      used = true;
      return { nameField: 'VAR', nativeType: '', owner: { type: 'arduino_global', input: 'ARDUINO_GLOBAL' } };
    } };
  } });
}
