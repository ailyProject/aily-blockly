import { absJson, createAbsNodeFingerprinter, createAbsProjection, fingerprintAbsNodeGroups, fingerprintAbsNodes, hashAbsText, indexAbsAbi, indexAbsSyntax, validateAbsProjection } from './abs-identity-map';
import { parseAbsSyntax } from './abs-syntax';
import { absInputPath, type AbsAbiBlock, type AbsAbiWorkspace } from './abs-state';
import { reconcileAbs } from './abs-reconciler';
import { copyAbsBlockForRebuild } from './abs-reconciled-block';

const parse = (text: string) => indexAbsSyntax(parseAbsSyntax('# ABS Schema: 2\n' + text));
const project = (blocks: AbsAbiBlock[]) => {
  const workspace: AbsAbiWorkspace = { blocks: { blocks } };
  return createAbsProjection(workspace, { document: workspace, generation: 'performance', baselineRef: 'performance',
    scope: { projectKey: 'test', pageId: 'main' }, savedAbiHash: null });
};

/** Previous projection algorithm, intentionally without reuse. Exact bytes are
 * the compatibility oracle, not a second call through the optimized path. */
async function originalFingerprints(entries: ReturnType<typeof parse>) {
  const result = new Map<string, string>();
  for (const { path, node } of [...entries].reverse()) {
    result.set(path, await hashAbsText(absJson({
      type: node.type,
      fields: Object.fromEntries(Object.entries(node.fields).map(([key, token]) => [key, token.value])),
      inputs: Object.fromEntries(Object.keys(node.inputs).sort().map(name => [name, result.get(absInputPath(path, name)) ?? null])),
      disabled: node.disabled,
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}),
      next: result.get(`${path}/next`) ?? null,
    })));
  }
  return result;
}

describe('ABS pure reconciliation reuse boundaries', () => {
  it('incrementally hashes a changed leaf and its ancestors while retaining unrelated branches', async () => {
    const before = parse('root(VALUE=nested(VALUE=number(NUM=7)))\nother(VALUE=number(NUM=0))');
    const after = parse('root(VALUE=nested(VALUE=number(NUM=8)))\nother(VALUE=number(NUM=0))');
    const expected = await originalFingerprints(after), fingerprint = createAbsNodeFingerprinter();
    await fingerprint([before]);
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const [result] = await fingerprint([after]);
    expect(digest).toHaveBeenCalledTimes(3); expect([...result]).toEqual([...expected]);
    digest.calls.reset(); await fingerprint([before, after]); expect(digest).not.toHaveBeenCalled();
  });

  it('includes next dependencies, disabled and extra state and owns hash values independently of paths', async () => {
    const fingerprint = createAbsNodeFingerprinter();
    const initial = parse('root()\n    @BODY:\n        step(TEXT="one")\n        step(TEXT="two")');
    await fingerprint([initial]);
    const changed = parse('other()\nroot()\n    @BODY:\n        step(TEXT="one")\n        step(TEXT="two") @extra:{"flag":true} @disabled');
    const expected = await originalFingerprints(changed), digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const [result] = await fingerprint([changed]);
    expect(digest).toHaveBeenCalledTimes(4); expect([...result]).toEqual([...expected]);
    result.clear(); digest.calls.reset();
    expect([...(await fingerprint([changed]))[0]]).toEqual([...expected]);
    expect(digest).not.toHaveBeenCalled();
  });

  it('bounds retained entry count and evicts old inputs without changing their recomputed hashes', async () => {
    const fingerprint = createAbsNodeFingerprinter(), first = parse('number(NUM=0)');
    const expected = (await fingerprint([first]))[0];
    await fingerprint([parse(Array.from({ length: 4096 }, (_, i) => `number(NUM=${i + 1})`).join('\n'))]);
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    expect((await fingerprint([first]))[0]).toEqual(expected); expect(digest).toHaveBeenCalledTimes(1);
  });

  it('bounds retained string bytes and bypasses caching for a single oversized hash input', async () => {
    const fingerprint = createAbsNodeFingerprinter();
    const large = parse('text(TEXT="")');
    large[0].node.fields['TEXT'].value = 'x'.repeat(2200000);
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const first = await fingerprint([large]);
    expect(await fingerprint([large])).toEqual(first); expect(digest).toHaveBeenCalledTimes(2);
    const medium = parse('text(TEXT="")'); medium[0].node.fields['TEXT'].value = 'x'.repeat(800000);
    await fingerprint([medium]);
    for (const value of ['a', 'b']) { large[0].node.fields['TEXT'].value = value.repeat(800000); await fingerprint([large]); }
    digest.calls.reset(); await fingerprint([medium]); expect(digest).toHaveBeenCalledTimes(1);
  });

  it('does not publish partial successes after a failed traversal', async () => {
    const fingerprint = createAbsNodeFingerprinter(), entries = parse('number(NUM=1)\nnumber(NUM=2)');
    const digest = crypto.subtle.digest.bind(crypto.subtle); let fail = true;
    const observed = spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      if (fail) { fail = false; return Promise.reject(new Error('injected failure')); }
      return digest(algorithm, data);
    });
    await expectAsync(fingerprint([entries])).toBeRejectedWithError('injected failure');
    observed.calls.reset(); await fingerprint([entries]); expect(observed).toHaveBeenCalledTimes(2);
  });

  it('keeps historical fingerprints for nested inputs, next chains, disabled state and JSON values', async () => {
    const entries = parse(`root(VALUE=number(NUM=7), EMPTY=null) @extra:{"nested":[false,0,"😀"]}
    @BODY:
        step(TEXT="first")
        step(TEXT="second") @disabled
other(VALUE=number(NUM=7))`);
    expect(await fingerprintAbsNodes(entries)).toEqual(await originalFingerprints(entries));
    expect(await fingerprintAbsNodeGroups([])).toEqual([]);
    expect(await fingerprintAbsNodes([])).toEqual(new Map());
  });

  it('hashes identical canonical content once across path-distinct trees and never across invocations', async () => {
    const first = parse(Array.from({ length: 80 }, () => 'number(NUM=7)').join('\n'));
    const second = parse('number(NUM=7)\nnumber(NUM=8)');
    const digest = spyOn(crypto.subtle, 'digest').and.callThrough();
    const [before, after] = await fingerprintAbsNodeGroups([first, second]);
    expect(digest.calls.count()).toBe(2);
    expect(before.size).toBe(80); expect(after.size).toBe(2);
    expect(new Set(before.values()).size).toBe(1);
    expect(before.get('/blocks/0')).toBe(after.get('/blocks/0'));
    expect(before.get('/blocks/0')).not.toBe(after.get('/blocks/1'));
    await fingerprintAbsNodeGroups([first, second]);
    expect(digest.calls.count()).toBe(4);
  });

  it('recomputes the edited ancestor chain while preserving unaffected content fingerprints', async () => {
    const before = parse('root(VALUE=number(NUM=7))\nother(VALUE=number(NUM=7))');
    const after = parse('root(VALUE=number(NUM=8))\nother(VALUE=number(NUM=7))');
    const result = await fingerprintAbsNodeGroups([before, after]);
    expect(result[0]).toEqual(await originalFingerprints(before));
    expect(result[1]).toEqual(await originalFingerprints(after));
    expect(result[0].get('/blocks/0')).not.toBe(result[1].get('/blocks/0'));
    expect(result[0].get('/blocks/1')).toBe(result[1].get('/blocks/1'));
  });

  it('owns entry lists before its first asynchronous hash', async () => {
    const entries = parse('number(NUM=7)\nnumber(NUM=8)');
    const expected = await originalFingerprints(entries);
    const pending = fingerprintAbsNodes(entries);
    entries.length = 0;
    expect(await pending).toEqual(expected);
  });

  it('bounds parallel leaf hashing and preserves historical map iteration order', async () => {
    const entries = parse(Array.from({ length: 180 }, (_, i) => `number(NUM=${i})`).join('\n'));
    const expected = await originalFingerprints(entries);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let active = 0, peak = 0;
    const observed = spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      active++; peak = Math.max(peak, active);
      return digest(algorithm, data).finally(() => active--);
    });
    const [first, repeated] = await fingerprintAbsNodeGroups([entries, entries]);
    expect([...first]).toEqual([...expected]); expect([...repeated]).toEqual([...expected]);
    expect(observed).toHaveBeenCalledTimes(180);
    expect(peak).toBe(64); expect(active).toBe(0);
  });

  it('keeps input/next dependencies correct across forests with different tree depths', async () => {
    const first = parse(Array.from({ length: 15 }, (_, i) => `root(LEFT=number(NUM=${i}), RIGHT=nested(VALUE=number(NUM=${i % 3})))
    @BODY:
        step(TEXT="${i}😀")
        step(TEXT="next") @extra:{"items":[0,false,"x"]}`).join('\n'));
    const second = parse('number(NUM=0)\nroot(LEFT=number(NUM=1), RIGHT=nested(VALUE=number(NUM=2)))');
    const expected = await Promise.all([originalFingerprints(first), originalFingerprints(second)]);
    const actual = await fingerprintAbsNodeGroups([first, second]);
    expect(actual.map(map => [...map])).toEqual(expected.map(map => [...map]));
  });

  it('does not retain failed or in-flight digests across invocations', async () => {
    const entries = parse('number(NUM=1)\nnumber(NUM=2)');
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let fail = true;
    const observed = spyOn(crypto.subtle, 'digest').and.callFake((algorithm, data) => {
      if (fail) { fail = false; return Promise.reject(new Error('injected digest failure')); }
      return digest(algorithm, data);
    });
    await expectAsync(fingerprintAbsNodes(entries)).toBeRejectedWithError('injected digest failure');
    observed.calls.reset();
    const result = await fingerprintAbsNodes(entries);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(2);
    expect(result).toEqual(await originalFingerprints(entries));
  });

  it('accepts pre-optimization map hashes and still rejects a tampered association', async () => {
    const baseline = await project([{ type: 'number', id: 'n', fields: { NUM: 7 } }]);
    const hashes = await originalFingerprints(indexAbsSyntax(parseAbsSyntax(baseline.abs)));
    baseline.map.nodes.forEach(entry => entry.fingerprint = hashes.get(entry.astPath)!);
    await expectAsync(validateAbsProjection(baseline)).toBeResolved();
    baseline.map.nodes[0].fingerprint = 'sha256:' + '0'.repeat(64);
    await expectAsync(validateAbsProjection(baseline)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MAP_INVALID' }));
  });

  it('does not traverse block descendants while detaching local metadata and all shadow trees', () => {
    const child = Object.defineProperty({ id: 'child', type: 'number' }, 'fields', {
      enumerable: true, get() { throw new Error('visible subtree was copied'); },
    });
    const previous: AbsAbiBlock = { id: 'root', type: 'root', icons: { comment: { text: 'note' } },
      inputs: {
        VALUE: { block: child, shadow: { id: 'shadow', type: 'number', fields: { NUM: 0 } }, metadata: { key: 'keep' } },
        VISIBLE_SHADOW: { shadow: { id: 'visible', type: 'number', fields: { NUM: 2 } } },
        EMPTY: { block: null, shadow: null } as any,
      }, next: { block: child, metadata: { key: 'next' } } };
    const copied = copyAbsBlockForRebuild(previous);
    expect(copied.inputs!['VALUE'].block === child).toBeTrue();
    expect(copied.inputs!['VISIBLE_SHADOW'].shadow === previous.inputs!['VISIBLE_SHADOW'].shadow).toBeFalse();
    expect(copied.next!.block === child).toBeTrue();
    expect(copied.inputs!['EMPTY']).toEqual({ block: null, shadow: null } as any);
    (copied['icons'] as any).comment.text = 'changed';
    (copied.inputs!['VALUE']['metadata'] as any).key = 'changed';
    copied.inputs!['VALUE'].shadow!.fields!['NUM'] = 5;
    copied.inputs!['VISIBLE_SHADOW'].shadow!.fields!['NUM'] = 5;
    (copied.next!['metadata'] as any).key = 'changed';
    expect((previous['icons'] as any).comment.text).toBe('note');
    expect((previous.inputs!['VALUE']['metadata'] as any).key).toBe('keep');
    expect(previous.inputs!['VALUE'].shadow!.fields!['NUM']).toBe(0);
    expect(previous.inputs!['VISIBLE_SHADOW'].shadow!.fields!['NUM']).toBe(2);
    expect((previous.next!['metadata'] as any).key).toBe('next');
  });

  it('retains a replaced visible shadow as the dormant fallback', async () => {
    const baseline = await project([{ id: 'root', type: 'root', inputs: { VALUE: {
      shadow: { id: 'fallback', type: 'number', fields: { NUM: 7 } }, metadata: { keep: true },
    } } }]);
    const original = absJson(baseline);
    const result = await reconcileAbs(baseline, baseline.abs.replace('number(NUM=7)', 'text(TEXT="new")'));
    const input = result.workspace.blocks.blocks[0].inputs!['VALUE'];
    expect(input.shadow).toEqual({ id: 'fallback', type: 'number', fields: { NUM: 7 } });
    expect(input.block!.type).toBe('text');
    expect(input.block!.fields).toEqual({ TEXT: 'new' });
    expect(result.removed).not.toContain('fallback');
    input.shadow!.fields!['NUM'] = 0;
    expect(absJson(baseline)).toBe(original);
  });

  for (const adapter of ['absent', 'unknown', 'covered', 'uncovered'] as const) {
    it(`preserves input/next metadata and adapter isolation (${adapter})`, async () => {
      const baseline = await project([{ id: 'root', type: 'root', deletable: false,
        inputs: { VALUE: { block: { id: 'value', type: 'number', fields: { NUM: 7 } },
          shadow: { id: 'fallback', type: 'number', fields: { NUM: 0 } }, metadata: { keep: true } } },
        next: { block: { id: 'tail', type: 'tail', fields: { TEXT: 'old' } }, metadata: { keep: true } } }]);
      const original = absJson(baseline);
      const prepare = jasmine.createSpy('prepare').and.callFake((block: AbsAbiBlock) => {
        if (block.id !== 'root') return;
        block.inputs!['VALUE'].block!.fields!['NUM'] = 999;
        block.inputs!['VALUE'].shadow!.fields!['NUM'] = 9;
        block.next!.block.fields!['TEXT'] = 'adapter';
      });
      const options = adapter === 'absent' ? {} : { prepareBlock: prepare,
        ...(adapter === 'unknown' ? {} : { hostPrepared: () => adapter === 'covered' }) };
      const result = await reconcileAbs(baseline, baseline.abs.replace('"old"', '"new"'), options);
      const blocks = indexAbsAbi(result.workspace);
      expect(blocks.get('value')!.fields!['NUM']).toBe(7);
      expect(blocks.get('tail')!.fields!['TEXT']).toBe('new');
      expect(blocks.get('fallback')!.fields!['NUM']).toBe(['unknown', 'covered'].includes(adapter) ? 9 : 0);
      expect(blocks.get('root')!['deletable']).toBeFalse();
      expect(blocks.get('root')!.inputs!['VALUE']['metadata']).toEqual({ keep: true });
      expect(blocks.get('root')!.next!['metadata']).toEqual({ keep: true });
      expect(prepare.calls.count()).toBe(['unknown', 'covered'].includes(adapter) ? 3 : 0);
      blocks.get('value')!.fields!['NUM'] = 99;
      blocks.get('fallback')!.fields!['NUM'] = 99;
      (blocks.get('root')!.next!['metadata'] as any).keep = false;
      expect(absJson(baseline)).toBe(original);
    });
  }
});
