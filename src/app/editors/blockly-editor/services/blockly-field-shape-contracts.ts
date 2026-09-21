import * as Blockly from 'blockly';
import { proveBlocklyFieldShapeRegistration, ProvenFieldShape } from './blockly-field-shape-proof';

/** Declaration fragments activated by a dropdown; no models, callbacks or inferred slots. */
export interface BlocklyFieldShapeRule {
  field: string;
  values: readonly string[];
  args: readonly { type: 'input_value' | 'input_statement'; name: string }[];
  /** Omitted means append, as the registered implementation does. */
  after?: string;
  /** Native placement anchor; resolved against the original JSON before publication. */
  afterInput?: string;
  /** Redundant boolean emitted by this bundled version's native XML serializer. */
  mutationAttribute?: string;
  /** Only when the audited serializer creates its element in an HTML document. */
  mutationNamespace?: string;
}
const registry = () => (Blockly.Extensions as any).TEST_ONLY?.allExtensions;
const originalRegistry = registry(), originalApply = Blockly.Extensions.apply;
const recipes = new Map<string, readonly BlocklyFieldShapeRule[]>([
  ['math_is_divisibleby_mutator', [{ field: 'PROPERTY', values: ['DIVISIBLE_BY'], args: [{ type: 'input_value', name: 'DIVISOR' }], mutationAttribute: 'divisor_input' }]],
  ['text_charAt_mutator', [{ field: 'WHERE', values: ['FROM_START', 'FROM_END'], args: [{ type: 'input_value', name: 'AT' }], mutationAttribute: 'at' }]],
]);
const registrations = new Map([...recipes.keys()].map(name => [name, originalRegistry?.[name]]));
const observed = new WeakMap<Function, ProvenFieldShape>();

export function observeBlocklyFieldShape(kind: 'register' | 'registerMutator', args: unknown[], realm: object, intact: () => boolean): void {
  const proof = proveBlocklyFieldShapeRegistration(kind, args, realm);
  const callback = Object.getOwnPropertyDescriptor(registry() ?? {}, String(args[0]))?.value;
  if (proof && typeof callback === 'function') observed.set(callback, { rules: proof.rules, intact: () => intact() && proof.intact() });
}

/** Version-local bundled mechanisms, shared by any declaration using the same registration. */
export function captureBlocklyFieldShapes() {
  const used = new Map<string, { callback: Function; proof?: ProvenFieldShape }>();
  const current = (name: string) => Object.getOwnPropertyDescriptor(registry() ?? {}, name)?.value;
  const intact = (name: string, callback: unknown, proof?: ProvenFieldShape) => typeof callback === 'function'
    && registry() === originalRegistry && current(name) === callback && Blockly.Extensions.apply === originalApply
    && (proof ? proof.intact() : registrations.get(name) === callback);
  return {
    get(name: string): readonly BlocklyFieldShapeRule[] | undefined {
      const callback = current(name), proof = typeof callback === 'function' ? observed.get(callback) : undefined;
      if (!intact(name, callback, proof)) return undefined;
      used.set(name, { callback, proof }); return JSON.parse(JSON.stringify(proof?.rules ?? recipes.get(name)));
    },
    assertCurrent() {
      if ([...used].some(([name, { callback, proof }]) => !intact(name, callback, proof))) throw new Error('Field-dependent registration or dependency changed.');
    },
  };
}
