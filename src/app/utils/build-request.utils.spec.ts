import { writeBuildRequest, captureBuildRequestGuard } from './build-request.utils';

describe('isolated build requests', () => {
  it('guards mutable project/board configuration without retaining the caller object', () => {
    const state = { path: '/project', options: { board: 'first' } };
    const check = captureBuildRequestGuard(() => state);
    check(); state.options.board = 'second';
    expect(check).toThrowError(/BUILD_SOURCE_STALE/);
    state.options.board = 'first'; state.path = '/other';
    expect(check).toThrowError(/BUILD_SOURCE_STALE/);
  });
  it('uses distinct disposable inputs and freezes each request before asynchronous work', async () => {
    const writes = new Map<string, string>();
    let mkdir!: () => void;
    const files = { join: (...parts: string[]) => parts.join('/'), exists: () => false,
      mkdir: () => new Promise<void>(resolve => { mkdir = resolve; }),
      write: (name: string, text: string) => { writes.set(name, text); } };
    const config = { code: 'first' };
    const first = writeBuildRequest('/project', config, files);
    config.code = 'second'; mkdir();
    const firstPath = await first;
    const second = writeBuildRequest('/project', config, { ...files, exists: () => true });
    const secondPath = await second;
    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toMatch(/^\/project\/\.temp\/compile-request-[a-f0-9-]{36}\.json$/);
    expect(JSON.parse(writes.get(firstPath)!).code).toBe('first');
    expect(JSON.parse(writes.get(secondPath)!).code).toBe('second');
  });
});
