const adapted = Symbol('xiaozhi-parameter-declarations');
const declarationTypes = new Set(['aivox_mcp_control_param', 'esp32ai_mcp_control_param']);
const consumerType = 'aivox_control_message_event_fuction';

/** Published Xiaozhi generators register parameter types while emitting their
 * declaration block. A consumer above that declaration otherwise sees Boolean
 * on the first pass and the previous pass's type thereafter. Prepare only this
 * library's declared type metadata, without running any generator twice. */
export function adaptXiaozhiParameterDeclarations(generator: any, realm: any): void {
  if (![...declarationTypes].some(type => typeof generator?.forBlock?.[type] === 'function')
      || typeof generator?.forBlock?.[consumerType] !== 'function'
      || typeof realm?.registerMcpControlParam !== 'function'
      || !Array.isArray(realm.mcpControlParams)
      || typeof generator.init !== 'function' || generator.init[adapted]) return;
  const original = generator.init;
  const wrapped = function(this: unknown, workspace: any, ...args: unknown[]) {
    const result = original.call(this, workspace, ...args);
    const declarations = new Map<string, string>();
    for (const block of workspace.getAllBlocks(false)) {
      if (!declarationTypes.has(block.type)) continue;
      let enabled = true;
      for (let current = block; current; current = current.getSurroundParent()) {
        if (!current.isEnabled()) { enabled = false; break; }
      }
      if (!enabled) continue;
      const name = block.getFieldValue('VAR') || 'state';
      const selected = block.getFieldValue('TYPE');
      const type = ['Boolean', 'Number', 'String'].includes(selected) ? selected : 'Boolean';
      if (declarations.has(name) && declarations.get(name) !== type) {
        throw new Error(`Xiaozhi parameter '${name}' has conflicting type declarations.`);
      }
      declarations.set(name, type);
    }
    // Removed, renamed or disabled declarations must not inherit a previous
    // generation's registry. The original declaration handler still supplies
    // ranges, validators, model registration and emitted code in its own turn.
    realm.mcpControlParams.length = 0;
    for (const [name, type] of declarations) realm.registerMcpControlParam(name, type);
    return result;
  };
  Object.defineProperty(wrapped, adapted, { value: true });
  generator.init = wrapped;
}
