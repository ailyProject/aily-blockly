import { absJson } from './abs-json';
import { absMapJson, decodeAbsMap, encodeAbsMap } from './abs-map-json';
import { ABS_PROJECTION_VERSION, type AbsIdentityMap } from './abs-state';

const chain = (count: number): AbsIdentityMap => {
  let path = '/blocks/0';
  const nodes = Array.from({ length: count }, (_, index) => {
    if (index) path += '/next';
    return { nodeKey: 'n' + index, blockId: 'b' + index, blockType: 'statement', astPath: path,
      start: index, end: index + 1, fingerprint: 'sha256:' + 'a'.repeat(64) };
  });
  return { schemaVersion: 1, absSchemaVersion: 2, projectionVersion: ABS_PROJECTION_VERSION, generation: 'g1',
    baselineRef: 'baselines/g1.json', scope: { projectKey: 'project', pageId: 'main' }, savedAbiHash: null,
    baseAbiHash: 'abi', pageAbiHash: 'page', baseAbsHash: 'abs', contractsHash: 'contracts', nodes,
    symbols: [{ nodeKey: nodes.at(-1)!.nodeKey, astPath: nodes.at(-1)!.astPath + '/fields/VAR', kind: 'variable', modelId: 'v1' }] };
};
describe('compact public identity maps', () => {
  it('retains every binding while storing each ancestor edge once', () => {
    const map = chain(512), text = absMapJson(map), wire = JSON.parse(text);
    expect(wire.schemaVersion).toBe(2);
    expect(wire.nodes[1].astPath).toEqual([0, '/next']);
    expect(absJson(decodeAbsMap(wire))).toBe(absJson(map));
    expect(text.length).toBeLessThan(absMapJson(chain(256)).length * 2.1);
    expect(text.length).toBeLessThan(absJson(map).length / 3);
  });
  it('keeps renderer paths lazy and immutable without changing serialized evidence', () => {
    const wire = encodeAbsMap(chain(512)), map = decodeAbsMap(wire, true), before = absMapJson(map);
    expect(map.nodes.at(-1)!.astPath).toBe(chain(512).nodes.at(-1)!.astPath);
    expect(map.symbols[0].astPath).toBe(map.nodes.at(-1)!.astPath + '/fields/VAR');
    expect(() => { map.nodes[0].blockId = 'changed'; }).toThrow();
    expect(() => { wire.nodes[0].astPath[1] = '/blocks/99'; }).toThrow();
    expect(absMapJson(map)).toBe(before);
  });
  it('rejects forward parents, malformed edges and symbol ownership changes', () => {
    for (const edit of [(m: any) => m.nodes[1].astPath[0] = 1,
      (m: any) => m.nodes[1].astPath[1] = '/unknown', (m: any) => m.symbols[0].astPath[0] = 0]) {
      const wire = encodeAbsMap(chain(3)); edit(wire); expect(() => decodeAbsMap(wire)).toThrow();
    }
  });
  it('reads and emits legacy map bytes with their original schema', () => {
    const legacy = { ...chain(3), projectionVersion: 'abs-v2.preview.7' };
    expect(absMapJson(legacy)).toBe(absJson(legacy));
    expect(decodeAbsMap(JSON.parse(absMapJson(legacy)))).toEqual(legacy);
    expect(absMapJson(decodeAbsMap(encodeAbsMap(legacy, true), true))).toBe(absJson(legacy));
  });
});
