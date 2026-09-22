import { captureVariableDeclarationRegistration, clearVariableDeclarationRegistration, registerVariableDeclarationContract }
  from '../../../editors/blockly-editor/services/blockly-variable-declaration-contract';

describe('variable declaration runtime provenance', () => {
  const source = 'function registerVariableToBlockly() {}';
  const setup = () => {
    let active = true;
    return { realm: { registerVariableToBlockly() {}, addVariableToToolbox() {}, renameVariableInBlockly() {}, isBlockConnected() {},
      ENTRY_BLOCK_TYPES: ['arduino_setup', 'arduino_loop'] }, generator: { forBlock: { variable_define() {} } }, registry: {}, owner: {},
      current: () => active, deactivate: () => { active = false; } };
  };
  // Isolate lifecycle checks; actual source/code-generation validation must not use this substitute.
  const acceptDigest = () => spyOn(crypto.subtle, 'digest').and.resolveTo(Uint8Array.from(
    '649a4ad7fb764dba056225b26f1a3fe3d25d96caad1fb2cbc9a3541825623450'.match(/../g)!, byte => parseInt(byte, 16)).buffer);
  const register = f => registerVariableDeclarationContract(source, f.realm, f.generator, f.registry, f.owner, f.current);
  it('does not trust a block/helper name or an unknown generator source', async () => {
    const f = setup(); await register(f); expect(captureVariableDeclarationRegistration(f.registry)).toBeUndefined();
  });
  it('captures an effect without requiring block.json to have loaded first', async () => {
    acceptDigest(); const f = setup(); await register(f);
    const snapshot = captureVariableDeclarationRegistration(f.registry)!;
    expect(snapshot.get('variable_define')).toEqual({ nameField: 'VAR', nativeType: '', owner: { type: 'arduino_global', input: 'ARDUINO_GLOBAL' } });
    expect(snapshot.get('variable_define_scoped')).toBeUndefined();
  });
  it('invalidates used effects on handler/helper/session/scope changes', async () => {
    acceptDigest();
    for (const mutate of [f => { f.generator.forBlock.variable_define = () => {}; },
      f => { f.realm.registerVariableToBlockly = () => {}; }, f => { f.realm.ENTRY_BLOCK_TYPES.push('arduino_global'); }, f => f.deactivate()]) {
      const f = setup(); await register(f); const snapshot = captureVariableDeclarationRegistration(f.registry)!;
      expect(snapshot.get('variable_define')).toBeDefined(); mutate(f); expect(() => snapshot.assertCurrent()).toThrow();
    }
  });
  it('does not register after session replacement and only clears its own registration', async () => {
    acceptDigest(); const f = setup(); const pending = register(f); f.deactivate(); await pending;
    expect(captureVariableDeclarationRegistration(f.registry)).toBeUndefined();
    const next = setup(); await register(next); clearVariableDeclarationRegistration(next.registry, {});
    expect(captureVariableDeclarationRegistration(next.registry)).toBeDefined();
    clearVariableDeclarationRegistration(next.registry, next.owner); expect(captureVariableDeclarationRegistration(next.registry)).toBeUndefined();
  });
});
