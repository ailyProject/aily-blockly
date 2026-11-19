import { captureAbsAbiRecipe, deriveAbsAbi, type AbsAbiRecipe } from './abs-abi-derivation';

describe('compact ABI formatting recipe', () => {
  it('retains exact key order, whitespace, resource markers and opaque values', () => {
    const document = { nested: [{ b: '中文', a: 2 }], first: false };
    const text = JSON.stringify({ first: false, nested: document.nested,
      $ailyProjectData: { schemaVersion: 1, mode: 'external-only' } }, null, 3) + '\r\n';
    const snapshot: any = { document, workspace: {} }, recipe = captureAbsAbiRecipe(snapshot, text);
    expect(Array.isArray(recipe.order)).toBeTrue();
    expect(deriveAbsAbi(snapshot, recipe)).toBe(text);
  });

  it('reads legacy pointer recipes without changing their bytes', () => {
    const snapshot: any = { document: { a: { b: 3 }, c: [null, { d: 4 }] }, workspace: {} };
    const recipe: AbsAbiRecipe = { source: 'document', space: 2, ending: '\n',
      order: { '': ['c', 'a'], '/a': ['b'], '/c/1': ['d'] } };
    expect(deriveAbsAbi(snapshot, recipe)).toBe(JSON.stringify({ c: [null, { d: 4 }], a: { b: 3 } }, null, 2) + '\n');
  });

  it('keeps formatting metadata linear for long statement chains and rejects unused entries', () => {
    const recipe = (count: number) => {
      let document: any = null;
      while (count--) document = { type: 'statement', fields: { VALUE: count }, next: document };
      return captureAbsAbiRecipe({ document, workspace: {} } as any, JSON.stringify(document));
    };
    const small = recipe(128), large = recipe(256);
    expect(JSON.stringify(large).length).toBeLessThan(JSON.stringify(small).length * 2.1);
    const snapshot: any = { document: { a: 1 }, workspace: {} };
    expect(() => deriveAbsAbi(snapshot, { source: 'document', space: 0, ending: '', order: [['a'], []] })).toThrow();
  });
  it('captures and restores deep statement formatting without recursive stack growth', () => {
    let document: any = { type: 'tail' };
    for (let i = 0; i < 1400; i++) document = { type: 'statement', next: { block: document } };
    const snapshot: any = { document, workspace: {} }, text = JSON.stringify(document);
    expect(deriveAbsAbi(snapshot, captureAbsAbiRecipe(snapshot, text))).toBe(text);
  });

});
