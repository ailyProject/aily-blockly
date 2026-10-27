const objectPrototype = Object.prototype;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const functionToString = Function.prototype.toString;
const objectConstructorSource = functionToString.call(Object);

/** JSON dictionaries may originate in a library iframe, not only this realm.
 * Accept its intrinsic Object.prototype, never an arbitrary null-root prototype
 * merely carrying a borrowed/named Object constructor. The native constructor's
 * non-writable, non-configurable prototype property must point back to it.
 * Arrays are checked separately by callers; no input hooks or toJSON are used.
 */
export function isPlainProjectJsonObject(value: object): boolean {
  try {
    const prototype = getPrototypeOf(value);
    if (prototype === null || prototype === objectPrototype) return true;
    if (getPrototypeOf(prototype) !== null) return false;
    const constructor = getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function'
      || functionToString.call(constructor.value) !== objectConstructorSource) return false;
    const backlink = getOwnPropertyDescriptor(constructor.value, 'prototype');
    return !!backlink && 'value' in backlink && backlink.value === prototype
      && backlink.writable === false && backlink.configurable === false && backlink.enumerable === false;
  } catch {
    // Inaccessible/exotic prototypes remain invalid. Callers retain the normal
    // ProjectDataError and JSON pointer, rather than losing data by normalizing.
    return false;
  }
}
