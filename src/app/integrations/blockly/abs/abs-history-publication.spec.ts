import { historyPublicationIdentity, readAbsHistoryPublication } from './abs-history-publication';
import { hashAbsText } from './abs-identity-map';

describe('R2 History object transport', () => {
  async function input(base: string, target: string) {
    const digest = await hashAbsText('saved');
    return { version: 2, requestId: `pub2-${crypto.randomUUID()}`, history: {
      id: 'frozen-original-transition', expected: { generation: 'original-generation',
        scope: { projectKey: 'D:/project', pageId: 'main' }, abiHash: digest, absHash: digest, mapHash: digest },
      base: { hash: await hashAbsText(base), bytes: new TextEncoder().encode(base).length },
      candidate: { hash: await hashAbsText(target), bytes: new TextEncoder().encode(target).length },
    } };
  }

  it('reads existing immutable objects while keeping large sources off the wire and preserving the original identity', async () => {
    const base = 'x'.repeat(1_863_008), target = base.slice(0, -1) + 'y', request = await input(base, target);
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThan(2048);
    const reads: string[] = [];
    const hydrated = await readAbsHistoryPublication(request, true, async digest => {
      reads.push(digest); return digest === request.history.base.hash ? base : target;
    });
    expect(reads).toEqual([request.history.base.hash, request.history.candidate.hash]);
    expect(hydrated.history.base.source).toBe(base); expect(hydrated.history.source).toBe(target);
    const inline = await readAbsHistoryPublication({ ...request, history: { ...request.history,
      base: { ...request.history.base, source: base }, source: target } }, true);
    expect(await historyPublicationIdentity('D:/project', hydrated)).toEqual(await historyPublicationIdentity('D:/project', inline));
  });

  it('rejects missing corrupt or truncated objects before any native mutation can be admitted', async () => {
    const request = await input('original base', 'original target');
    for (const object of [null, 'corrupt bytes', 'original bas']) {
      await expectAsync(readAbsHistoryPublication(request, true, async () => object))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_HISTORY_PUBLICATION_INVALID' }));
    }
  });

  it('observes the original descriptor without reading objects and does not accept arbitrary object paths', async () => {
    const request = await input('base', 'target');
    const read = jasmine.createSpy('readObject').and.rejectWith(new Error('Observation cannot read bodies'));
    await readAbsHistoryPublication(request, false, read); expect(read).not.toHaveBeenCalled();
    await expectAsync(readAbsHistoryPublication({ ...request, history: { ...request.history,
      base: { ...request.history.base, path: '../foreign.blob' } } }, true, read))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_HISTORY_PUBLICATION_INVALID' }));
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a large dependency lock off publication and observation requests without changing their identity', async () => {
    const base = 'base', target = 'target', request = await input(base, target);
    const packageText = '{"name":"original-project"}', lockText = JSON.stringify({ lockfileVersion: 3, retained: 'x'.repeat(1_200_000) });
    const packageHash = await hashAbsText(packageText), lockHash = await hashAbsText(lockText);
    const reference = { ...request, history: { ...request.history, environment: { version: 1, requestId: request.requestId,
      files: { 'package.json': { expectedHash: packageHash, contentHash: packageHash },
        'package-lock.json': { expectedHash: null, contentHash: lockHash }, '.npmrc': { expectedHash: null, contentHash: null } } } } };
    expect(new TextEncoder().encode(JSON.stringify(reference)).length).toBeLessThan(8192);
    const objects = new Map([[request.history.base.hash, base], [request.history.candidate.hash, target],
      [packageHash, packageText], [lockHash, lockText]]);
    const read = jasmine.createSpy('readObject').and.callFake(async digest => objects.get(digest) ?? null);
    const observed = await readAbsHistoryPublication(reference, false, read); expect(read).not.toHaveBeenCalled();
    const hydrated = await readAbsHistoryPublication(reference, true, read);
    expect(hydrated.history.environment!.files['package-lock.json']!.content).toBe(lockText);
    expect(hydrated.history.environment!.files['.npmrc']!.content).toBeNull();
    expect(read.calls.allArgs().map(args => args[0])).toEqual([...objects.keys()]);
    expect(await historyPublicationIdentity('D:/project', observed)).toEqual(await historyPublicationIdentity('D:/project', hydrated));
  });
});
