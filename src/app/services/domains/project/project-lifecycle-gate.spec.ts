import { ProjectLifecycleGate } from './project-lifecycle-gate';
import { AiOperationRegistryService } from '@integration/automation/public-api';

describe('project lifecycle resource ownership', () => {
  it('tracks chat activity without treating a thinking/reading session as a project lock', () => {
    const registry = new AiOperationRegistryService();
    registry.setActive('chat:a', true, { projectPath: 'C:\\Project\\A', sessionId: 'a' });
    registry.setActive('chat:b', true, { projectPath: 'C:\\Project\\B', sessionId: 'b' });
    expect(registry.hasActive('c:/project/a')).toBeTrue();
    expect(registry.hasBlocking('c:/project/a')).toBeFalse();
    registry.setActive('write:a', true, { projectPath: 'c:/project/a', blocksProjectLifecycle: true });
    expect(registry.hasBlocking('C:\\Project\\A')).toBeTrue();
    expect(registry.hasBlocking('C:\\Project\\B')).toBeFalse();
    registry.setActive('write:a', false);
    expect(registry.hasActive('c:/project/a')).toBeTrue();
    expect(registry.hasBlocking('c:/project/a')).toBeFalse();
  });

  it('permits only the scoped owner to reload and keeps the parent protected', () => {
    const gate = new ProjectLifecycleGate(), board = gate.acquire(['C:\\Project\\A']);
    expect(() => gate.acquire(['c:/project/a'])).toThrow();
    const reload = gate.acquire(['c:/project/a/'], board.token);
    expect(gate.hasActive('c:/project/a')).toBeTrue();
    expect(() => gate.acquire(['c:/project/b'], board.token)).toThrow();
    reload.release(); expect(gate.hasActive('c:/project/a')).toBeTrue();
    board.release(); expect(gate.hasActive('c:/project/a')).toBeFalse();
    expect(() => gate.acquire(['c:/project/a'], board.token)).toThrow();
  });

  it('does not block unrelated projects but protects close-all against any active lifecycle', () => {
    const gate = new ProjectLifecycleGate(), a = gate.acquire(['/a']), b = gate.acquire(['/b']);
    expect(() => gate.acquire(['*'])).toThrow();
    a.release(); b.release();
    const close = gate.acquire(['*']);
    expect(gate.hasActive('/new-project')).toBeTrue();
    expect(() => gate.acquire(['/new-project'])).toThrow();
    close.release(); expect(gate.hasActive('/new-project')).toBeFalse();
  });

});
