import { parseBlocklyFunction } from './blockly-source-pattern';

const sourceOf = Function.prototype.toString;
const cache = new WeakMap<Function, boolean>();
const method = (node: any, name: string) => node?.type === 'MemberExpression' && !node.computed && node.property.name === name;
const blockReceiver = (node: any, aliases: Set<string>) => node?.type === 'ThisExpression' || node?.type === 'Identifier' && aliases.has(node.name);

/** A small effect checker, not a JS interpreter. Unknown calls/writes are rejected. */
function tooltipOnly(fn: any): boolean {
  // An outer arrow captures unrelated lexical `this`, not the block passed to apply.
  if (fn.type !== 'FunctionExpression' || fn.async || fn.generator || fn.params.length || fn.body?.type !== 'BlockStatement') return false;
  const aliases = new Set<string>();
  let calls = 0;
  const read = (node: any): boolean => {
    if (!node) return true;
    switch (node.type) {
      case 'Literal': case 'Identifier': return true;
      case 'ChainExpression': return read(node.expression);
      case 'MemberExpression': return read(node.object) && (!node.computed || read(node.property));
      case 'UnaryExpression': return ['!', 'typeof', '+', '-'].includes(node.operator) && read(node.argument);
      case 'BinaryExpression': case 'LogicalExpression': return read(node.left) && read(node.right);
      case 'ConditionalExpression': return read(node.test) && read(node.consequent) && read(node.alternate);
      case 'CallExpression': return method(node.callee, 'getFieldValue') && blockReceiver(node.callee.object, aliases)
        && node.arguments.length === 1 && node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string';
      default: return false;
    }
  };
  const pure = (node: any): boolean => {
    if (!node) return true;
    if (node.type === 'BlockStatement') return node.body.every(pure);
    if (node.type === 'ReturnStatement') return read(node.argument);
    if (node.type === 'IfStatement') return read(node.test) && pure(node.consequent) && pure(node.alternate);
    if (node.type === 'VariableDeclaration') return node.declarations.every((item: any) => item.id.type === 'Identifier' && !aliases.has(item.id.name) && read(item.init));
    return false;
  };
  return fn.body.body.every((statement: any) => {
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') return statement.declarations.every((item: any) => {
      if (item.id.type !== 'Identifier' || item.init?.type !== 'ThisExpression') return false;
      aliases.add(item.id.name); return true;
    });
    const call = statement.type === 'ExpressionStatement' && statement.expression;
    const callback = call?.arguments?.[0];
    if (call?.type !== 'CallExpression' || !method(call.callee, 'setTooltip') || !blockReceiver(call.callee.object, aliases)
      || call.arguments.length !== 1 || !['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type)
      || callback.async || callback.generator || callback.params.length) return false;
    calls++;
    return callback.body.type === 'BlockStatement' ? pure(callback.body) : read(callback.body);
  }) && calls === 1;
}

// Audited shared UI mechanism. Literal field names and enum values do not change
// its effect; method names, bindings and complete control flow must match exactly.
const visibilityBody = `
  let renderScheduled = false;
  const getLoopInput = () => {
    return this.inputList.find(input => input.fieldRow && input.fieldRow.some(field => field.name === 'LOOP'));
  };
  const scheduleRender = () => {
    if (!this.rendered || renderScheduled) { return; }
    renderScheduled = true;
    Promise.resolve().then(() => {
      renderScheduled = false;
      const rootBlock = typeof this.getRootBlock === 'function' ? this.getRootBlock() : this;
      if (rootBlock && rootBlock.rendered) { rootBlock.render(); }
      else if (this.rendered) { this.render(); }
    });
  };
  const updatePlaybackMode = modeValue => {
    const loopInput = getLoopInput();
    if (loopInput) { loopInput.setVisible(modeValue === 'NON_BLOCKING'); }
    scheduleRender();
  };`;
const validator = `option => { updatePlaybackMode(option); return option; }`;
function key(node: any): string {
  return JSON.stringify(node, (name, value) => ['start', 'end', 'raw'].includes(name) ? undefined
    : name === 'value' && typeof value === 'string' ? '<string>' : value);
}
const visibility = new Set([
  `this.getField('PLAY_MODE').setValidator(${validator});`,
  `const playModeField = this.getField('PLAY_MODE'); if (playModeField) { playModeField.setValidator(${validator}); }`,
].map(binding => key(parseBlocklyFunction(`function() { ${visibilityBody} ${binding} updatePlaybackMode(this.getFieldValue('PLAY_MODE')); }`))));

export function provesBlocklyUiOnly(callback: unknown): boolean {
  if (typeof callback !== 'function') return false;
  if (!cache.has(callback)) {
    let supported = false;
    try { const fn = parseBlocklyFunction(sourceOf.call(callback)); supported = tooltipOnly(fn) || visibility.has(key(fn)); }
    catch { /* Native, oversized or unsupported syntax has no proof. */ }
    cache.set(callback, supported);
  }
  return cache.get(callback)!;
}
