import type { BlocklyFieldShapeRule } from './blockly-field-shape-contracts';
import { matchBlocklyFunction } from './blockly-source-pattern';

// Audited mechanisms, not block/library names. Explicit captures preserve all
// relationships between selectors, native state, input names and helper bindings.
const indexed = {
  mutationToDom: `function () {
    const container = document.createElement('mutation');
    container.setAttribute('$attribute1', this.isAt1_ ? 'true' : 'false');
    container.setAttribute('$attribute2', this.isAt2_ ? 'true' : 'false');
    return container;
  }`,
  domToMutation: `function (xmlElement) {
    this.isAt1_ = xmlElement.getAttribute('$attribute1') !== 'false';
    this.isAt2_ = xmlElement.getAttribute('$attribute2') !== 'false';
    this.updateAt_(1, this.isAt1_);
    this.updateAt_(2, this.isAt2_);
  }`,
  updateAt_: `function (n, isAt) {
    const dummyInputName = '$prefix' + n + '$dummySuffix';
    const dummyInput = this.getInput(dummyInputName);
    if (!dummyInput) { console.error('$missingInputMessage', dummyInputName); return; }
    const fieldName = '$prefix' + n;
    const valueInputName = '$prefix' + n + '$valueSuffix';
    const existingInput = this.getInput(valueInputName);
    if (existingInput) { this.removeInput(valueInputName); }
    if (isAt) {
      const valueInput = this.appendValueInput(valueInputName).setCheck('Number');
      const inputList = this.inputList;
      const dummyIndex = inputList.findIndex(input => input.name === dummyInputName);
      if (dummyIndex < inputList.length - 1) {
        const nextInputName = inputList[dummyIndex + 1].name;
        this.moveInputBefore(valueInputName, nextInputName);
      }
    }
    if (n === 1) this.isAt1_ = isAt;
    if (n === 2) this.isAt2_ = isAt;
  }`,
};
const indexedInit = `function () {
  this.isAt1_ = true; this.isAt2_ = true;
  const dropdown1 = this.getField('$selector1');
  if (dropdown1) { dropdown1.setValidator((value) => {
    const isAt = value === '$fromStart' || value === '$fromEnd';
    this.updateAt_(1, isAt); return undefined;
  }); }
  const dropdown2 = this.getField('$selector2');
  if (dropdown2) { dropdown2.setValidator((value) => {
    const isAt = value === '$fromStart' || value === '$fromEnd';
    this.updateAt_(2, isAt); return undefined;
  }); }
  this.updateAt_(1, this.isAt1_); this.updateAt_(2, this.isAt2_);
}`;
const conditionalInit = `function() {
  const block = this;
  const addressField = block.getField('$selector');
  if (!addressField) return;
  addressField.setValidator(function(newValue) {
    $helper(block, newValue);
    if (block.rendered) block.render();
    return newValue;
  });
  $helper(block, block.getFieldValue('$selector'));
}`;
const conditionalHelper = `function $helper(block, address) {
  const hasInput = !!block.getInput('$input');
  if (address === '$active' && !hasInput) {
    block.appendValueInput('$input').setCheck('Number').appendField('$label');
  } else if (address !== '$active' && hasInput) { block.removeInput('$input'); }
}`;
const own = (object: object, name: string) => Object.getOwnPropertyDescriptor(object, name)?.value;
const identifier = (value: string) => /^[A-Za-z_]\w*$/.test(value);

export interface ProvenFieldShape { rules: readonly BlocklyFieldShapeRule[]; intact(): boolean }
export function proveBlocklyFieldShapeRegistration(kind: 'register' | 'registerMutator', args: unknown[], realm: object): ProvenFieldShape | undefined {
  const captured = Object.create(null) as Record<string, string>;
  if (kind === 'register' && args.length === 2 && matchBlocklyFunction(args[1], conditionalInit, captured)) {
    const helper = own(realm, captured['$helper']);
    if (!matchBlocklyFunction(helper, conditionalHelper, captured) || !identifier(captured['$selector']) || !identifier(captured['$input'])) return undefined;
    return { rules: [{ field: captured['$selector'], values: [captured['$active']], args: [{ type: 'input_value', name: captured['$input'] }] }],
      intact: () => own(realm, captured['$helper']) === helper };
  }
  const mixin = args[1];
  if (kind !== 'registerMutator' || args.length !== 3 || !mixin || typeof mixin !== 'object') return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(mixin), prototype = Object.getPrototypeOf(mixin);
  if (Reflect.ownKeys(mixin).length !== Object.keys(indexed).length
    || !Object.entries(indexed).every(([name, pattern]) => matchBlocklyFunction(descriptors[name]?.value, pattern, captured))
    || !matchBlocklyFunction(args[2], indexedInit, captured)) return undefined;
  const document = (realm as { document?: Document }).document, createElement = document?.createElement;
  const mutationNamespace = document?.documentElement?.namespaceURI;
  if (mutationNamespace !== 'http://www.w3.org/1999/xhtml' || typeof createElement !== 'function') return undefined;
  const rules = [1, 2].map(n => ({ field: captured['$selector' + n], values: [captured['$fromStart'], captured['$fromEnd']],
    args: [{ type: 'input_value' as const, name: captured['$prefix'] + n + captured['$valueSuffix'] }],
    afterInput: captured['$prefix'] + n + captured['$dummySuffix'], mutationAttribute: captured['$attribute' + n], mutationNamespace }));
  if (rules.some(rule => ![rule.field, rule.args[0].name, rule.afterInput, rule.mutationAttribute].every(identifier))
    || rules[0].field === rules[1].field || rules[0].mutationAttribute === rules[1].mutationAttribute) return undefined;
  return { rules, intact: () => {
    const now = Object.getOwnPropertyDescriptors(mixin);
    return (realm as any).document === document && document!.createElement === createElement
      && Object.getPrototypeOf(mixin) === prototype && Reflect.ownKeys(now).length === Reflect.ownKeys(descriptors).length
      && Object.keys(descriptors).every(name => ['value', 'get', 'set', 'enumerable', 'configurable', 'writable']
        .every(key => now[name]?.[key] === descriptors[name][key]));
  } };
}
