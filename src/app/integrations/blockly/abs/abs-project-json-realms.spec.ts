import * as Blockly from 'blockly';
import { canonicalProjectJsonStringify, cloneBlocklyJson, cloneProjectJson } from '@domain/project/project-document/public-api';
import { canonicalJsonStringify, createDefaultProjectDataCodecRegistry } from '@domain/project/project-data/public-api';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { beginNativeFieldDependencies } from '../../../editors/blockly-editor/services/blockly-native-field-dependencies';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { nativeUiSemanticSnapshot } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';

describe('strict project JSON across library realms', () => {
  let iframe: HTMLIFrameElement;
  let foreign: (source: string) => any;
  const boundaries = [canonicalProjectJsonStringify, canonicalJsonStringify, cloneProjectJson];

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    foreign = source => (iframe.contentWindow as any).eval(source);
  });
  afterEach(() => iframe.remove());

  it('retains canonical bytes for foreign plain objects, arrays and null-prototype dictionaries', async () => {
    const value = foreign(`(() => {
      const shared = { z: '界😀', a: -0 };
      const dictionary = Object.create(null);
      Object.defineProperty(dictionary, '__proto__', { value: { safe: true }, enumerable: true });
      dictionary['10'] = 10; dictionary['2'] = 2;
      return { z: [shared, shared], a: dictionary, b: new Array(2), c: [null, true, false, 12.3] };
    })()`);
    expect(Object.getPrototypeOf(value)).not.toBe(Object.prototype);
    const expected = '{"a":{"2":2,"10":10,"__proto__":{"safe":true}},"b":[null,null],"c":[null,true,false,12.3],"z":[{"a":0,"z":"界😀"},{"a":0,"z":"界😀"}]}';
    expect(canonicalProjectJsonStringify(value)).toBe(expected);
    expect(canonicalJsonStringify(value)).toBe(expected);
    const copy = cloneProjectJson(value);
    expect(canonicalProjectJsonStringify(copy)).toBe(expected);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.z[0]).not.toBe(value.z[0]);
    expect(copy.z[0]).not.toBe(copy.z[1]);
    expect(Object.hasOwn(copy.a, '__proto__')).toBeTrue();
    expect(({} as any).safe).toBeUndefined();
    const codec = createDefaultProjectDataCodecRegistry().get('canonical-json-v1');
    const bytes = await codec.encode(value);
    expect(new TextDecoder().decode(bytes)).toBe(expected);
    expect(canonicalProjectJsonStringify(await codec.decode(bytes))).toBe(expected);
  });

  it('rejects classes, built-ins and custom prototypes in either realm without calling toJSON', () => {
    const values = [
      new Date(0), new Map(), new Set(), new Number(1), new (class State { value = 1; })(),
      Object.create({ inherited: true }), Object.create(Object.create(null)),
      ...foreign(`[new Date(0), new Map(), new Set(), new Number(1),
        new (class State { constructor() { this.value = 1; } })(),
        Object.create({ inherited: true }), Object.create(Object.create(null))]`),
    ];
    for (const value of values) for (const boundary of boundaries) {
      expect(() => boundary({ extraState: value })).withContext(`${boundary.name}: ${Object.prototype.toString.call(value)}`)
        .toThrowError(/Unsupported JSON object at \$\/extraState\./);
    }
    let calls = 0;
    const custom = { value: 7, toJSON() { calls++; return { lost: true }; } };
    for (const boundary of boundaries) expect(() => boundary(custom)).toThrow();
    expect(calls).toBe(0);
    // A non-enumerable toJSON must not silently transform otherwise valid data.
    Object.defineProperty(custom, 'toJSON', { enumerable: false });
    expect(canonicalProjectJsonStringify(custom)).toBe('{"value":7}');
    expect(canonicalJsonStringify(custom)).toBe('{"value":7}');
    expect(cloneProjectJson<unknown>(custom)).toEqual({ value: 7 });
    expect(calls).toBe(0);
  });

  it('does not trust borrowed native constructors or a spoofed constructor name or toString', () => {
    const values = foreign(`(() => {
      const borrowed = Object.create(null);
      Object.defineProperty(borrowed, 'constructor', { value: Object });
      function ObjectImitation() {}
      Object.defineProperty(ObjectImitation, 'name', { value: 'Object' });
      ObjectImitation.toString = () => Function.prototype.toString.call(Object);
      Object.setPrototypeOf(ObjectImitation.prototype, null);
      const proxyConstructor = new Proxy(Object, {});
      const proxyPrototype = new Proxy(Object.prototype, {});
      const viaProxyConstructor = Object.create(null);
      Object.defineProperty(viaProxyConstructor, 'constructor', { value: proxyConstructor });
      return [Object.create(borrowed), new ObjectImitation(), Object.create(viaProxyConstructor), Object.create(proxyPrototype)];
    })()`);
    const localBorrowed = Object.create(null);
    Object.defineProperty(localBorrowed, 'constructor', { value: Object });
    values.push(Object.create(localBorrowed));
    for (const value of values) for (const boundary of boundaries) {
      expect(() => boundary({ extraState: value })).withContext(boundary.name)
        .toThrowError(/Unsupported JSON object at \$\/extraState\./);
    }
  });

  it('inspects constructor descriptors without invoking arbitrary getters', () => {
    let calls = 0;
    const prototype = Object.create(null);
    Object.defineProperty(prototype, 'constructor', { get() { calls++; throw new Error('constructor getter'); } });
    const value = Object.create(prototype);
    for (const boundary of boundaries) expect(() => boundary(value)).toThrowError(/Unsupported JSON object/);
    expect(calls).toBe(0);
    const inaccessible = new Proxy({}, { getPrototypeOf() { throw new Error('unreadable prototype'); } });
    for (const boundary of boundaries) expect(() => boundary({ extraState: inaccessible }))
      .toThrowError(/Unsupported JSON object at \$\/extraState\./);
    const unreadableConstructor = Object.create(new Proxy(Object.create(null), {
      getOwnPropertyDescriptor() { throw new Error('unreadable constructor'); },
    }));
    for (const boundary of boundaries) expect(() => boundary({ extraState: unreadableConstructor }))
      .toThrowError(/Unsupported JSON object at \$\/extraState\./);
  });

  it('still validates every foreign JSON member and reports its escaped location', () => {
    const values = foreign('[undefined, NaN, Infinity, -Infinity, 1n, Symbol("state"), function state() {}]');
    for (const value of values) for (const boundary of boundaries) {
      expect(() => boundary({ 'a/~': [value] })).withContext(boundary.name).toThrowError(/\$\/a~1~0\/0\./);
    }
    const cycle = foreign('(() => { const value = {}; value["a/~"] = value; return value; })()');
    for (const boundary of boundaries) expect(() => boundary(cycle)).toThrowError(/Circular JSON object at \$\/a~1~0\./);
  });

  it('does not change legacy Blockly JSON normalization', () => {
    const value = foreign('({ date: new Date(0), numbers: [NaN, Infinity], absent: undefined, custom: { toJSON() { return { converted: true }; } } })');
    expect(JSON.stringify(cloneBlocklyJson(value))).toBe(JSON.stringify(value));
  });

  it('loads, settles, snapshots, saves and reapplies extraState produced by the production library iframe', async () => {
    const runtime = new BlocklyGeneratorRuntimeService();
    let current: Blockly.Workspace | null = new Blockly.Workspace();
    const workspaces = [current];
    const originalBlockly = Object.getOwnPropertyDescriptor(window, 'Blockly');
    (window as any).Blockly = Blockly;
    runtime.activate({ mode: 'arduino', projectPath: '/isolated/realm-extra-state', getWorkspace: () => current as any });
    runtime.loadGenerator('/isolated/realm-extra-state/generator.js', `
      Blockly.Blocks.realm_state_fixture = {
        init() {
          this.appendDummyInput().appendField(new Blockly.FieldDropdown([['First', 'A']]), 'PICK');
          this.workspace.addChangeListener(event => {
            if (event.type === Blockly.Events.FINISHED_LOADING) {
              this.getField('PICK').setOptions([['First', 'A'], ['Second', 'B']]);
            }
          });
        },
        saveExtraState() {
          const dictionary = Object.create(null);
          Object.defineProperty(dictionary, '__proto__', { value: { preserved: true }, enumerable: true });
          return { version: 1, params: [{ name: 'value', type: 'int', values: [0, 7, null] }], dictionary };
        },
        loadExtraState(value) { this.loadedState = value; }
      };
      Arduino.forBlock.realm_state_fixture = function() { return ''; };
    `);
    const expected = '{"dictionary":{"__proto__":{"preserved":true}},"params":[{"name":"value","type":"int","values":[0,7,null]}],"version":1}';
    let persisted: any = { blocks: { blocks: [{ type: 'realm_state_fixture', id: 'realm-root', fields: { PICK: 'B' }, extraState: JSON.parse(expected) }] } };
    try {
      for (let iteration = 0; iteration < 2; iteration++) {
        if (iteration) { current = new Blockly.Workspace(); workspaces.push(current); }
        const workspace = current!;
        const scope = beginNativeFieldDependencies(Blockly, workspace);
        try {
          withNativeStateLoading(Blockly, workspace, persisted, () => Blockly.serialization.workspaces.load(persisted, workspace));
          const raw = Blockly.serialization.workspaces.save(workspace) as any;
          expect(Object.getPrototypeOf(raw.blocks.blocks[0].extraState)).not.toBe(Object.prototype);
          scope.finish();
          expect(workspace.getBlockById('realm-root')!.getFieldValue('PICK')).toBe('B');
          expect(canonicalProjectJsonStringify((workspace.getBlockById('realm-root') as any).loadedState)).toBe(expected);
          expect(canonicalProjectJsonStringify(raw.blocks.blocks[0].extraState)).toBe(expected);
          const snapshot = JSON.parse(nativeUiSemanticSnapshot(Blockly, workspace));
          expect(canonicalProjectJsonStringify(snapshot.state.blocks.blocks[0].extraState)).toBe(expected);
          const codec = createDefaultProjectDataCodecRegistry().get('canonical-json-v1');
          const saved = await codec.decode(await codec.encode(Blockly.serialization.workspaces.save(workspace)));
          persisted = cloneProjectJson(saved);
          expect(canonicalProjectJsonStringify(persisted.blocks.blocks[0].extraState)).toBe(expected);
        } finally { scope.dispose(); }
      }
    } finally {
      for (const workspace of workspaces) workspace?.dispose();
      runtime.destroy();
      if (originalBlockly) Object.defineProperty(window, 'Blockly', originalBlockly); else delete (window as any).Blockly;
    }
  });
});
