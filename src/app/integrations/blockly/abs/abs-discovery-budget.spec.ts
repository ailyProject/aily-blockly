import { searchBoardsLibrariesTool } from '../board-library-search';

describe('board/library discovery budgets', () => {
  const config = { libraryList: Array.from({ length: 17 }, (_, i) => ({ name: `lib-sensor-${i}`, nickname: `Sensor ${i}`, description: 'sensor' })) } as any;
  it('returns a focused default page without losing access to remaining matches', async () => {
    const result = await searchBoardsLibrariesTool.handler({ query: 'sensor', type: 'libraries' }, config);
    expect(result.is_error).toBeFalse();
    expect(result.metadata).toEqual(jasmine.objectContaining({ totalMatches: 17, returnedCount: 8, truncated: true, nextOffset: 8, detail: 'summary' }));
    expect(result.metadata!.results!.length).toBe(8);
    const limited = await searchBoardsLibrariesTool.handler({ query: 'sensor', type: 'libraries', maxResults: 10 }, config);
    expect(limited.metadata).toEqual(jasmine.objectContaining({ totalMatches: 17, returnedCount: 10, truncated: true }));
  });
  it('uses the same projection and exact-name ranking for boards and libraries', async () => {
    for (const type of ['boards', 'libraries'] as const) {
      const prefix = type === 'boards' ? 'board-' : 'lib-';
      const items = [{ name: `${prefix}broad`, nickname: 'Demo Helper', description: 'Demo Demo Demo' },
        { name: `${prefix}exact`, nickname: 'Demo', description: 'full description '.repeat(100) }];
      const source = { boardList: items, libraryList: items } as any;
      const result = await searchBoardsLibrariesTool.handler({ type, query: 'Demo', maxResults: 1 }, source);
      expect(result.metadata!.results![0]).toEqual(jasmine.objectContaining({
        packageName: `@aily-project/${prefix}exact`, description: items[1].description
      }));
      expect(result.content).not.toContain(items[1].description); // No duplicate prose copy.
      const next = await searchBoardsLibrariesTool.handler({ type, query: 'Demo', maxResults: 1, offset: 1 }, source);
      expect(next.metadata).toEqual(jasmine.objectContaining({ totalMatches: 2, nextOffset: null }));
      expect(next.metadata!.results![0]).toEqual(jasmine.objectContaining({ packageName: `@aily-project/${prefix}broad` }));
      const full = await searchBoardsLibrariesTool.handler({ type, query: 'Demo', detail: 'full' }, source);
      expect(full.metadata!.results![0]).toEqual(jasmine.objectContaining({ name: `${prefix}exact`, matchedQueries: ['demo'] }));
      const exactPackage = await searchBoardsLibrariesTool.handler({ type, query: `@aily-project/${prefix}exact`, detail: 'full' }, source);
      expect(exactPackage.metadata!.results!.length).toBe(1);
      expect(exactPackage.metadata!.results![0]).toEqual(jasmine.objectContaining({ packageName: `@aily-project/${prefix}exact` }));
      const past = await searchBoardsLibrariesTool.handler({ type, query: 'Demo', offset: 99 }, source);
      expect(past.metadata).toEqual(jasmine.objectContaining({ totalMatches: 2, returnedCount: 0, nextOffset: null }));
    }
  });
  it('rejects invalid offsets and projections', async () => {
    for (const params of [{ offset: -1 }, { offset: 0.5 }, { offset: Infinity }, { detail: 'unknown' }]) {
      expect((await searchBoardsLibrariesTool.handler({ query: 'sensor', ...params } as any, config)).is_error).toBeTrue();
    }
  });
  it('rejects invalid budgets instead of interpreting negative slice indices', async () => {
    for (const maxResults of [0, -1, 51, 1.5, NaN]) {
      expect((await searchBoardsLibrariesTool.handler({ query: 'sensor', maxResults }, config)).is_error).toBeTrue();
    }
  });
  it('reports an empty catalog without a second metadata query', async () => {
    const result = await searchBoardsLibrariesTool.handler({ query: 'absent', type: 'libraries' }, config);
    expect(result.metadata).toEqual(jasmine.objectContaining({ totalMatches: 0, returnedCount: 0, truncated: false, results: [] }));
  });
});
