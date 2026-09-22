import { switchProjectBoard, type BoardSwitchPort } from './board-switch-operation';

describe('native board switch operation', () => {
  const target = '@aily-project/board-new';
  function fixture() {
    const state = { project: '/project', board: '@aily-project/board-old', ready: true };
    const change = jasmine.createSpy('changeBoard').and.callFake(async board => { state.board = board.name; });
    const ensure = jasmine.createSpy('ensureRuntime').and.resolveTo();
    const port: BoardSwitchPort = {
      currentProject: () => state.project, readBoard: async () => ({ ok: true, boardPackage: state.board }),
      resolveBoard: async name => ({ name, version: '1.0.0' }),
      changeBoard: change, ensureRuntime: ensure, isReady: () => state.ready,
    };
    return { state, change, ensure, port };
  }
  it('uses native lifecycle and checks runtime before acknowledging a switch', async () => {
    const f = fixture();
    const result = await switchProjectBoard({ boardName: target }, f.port);
    expect(result['ok']).toBeTrue();
    expect(result['boardPackage']).toBe(target);
    expect(f.change).toHaveBeenCalledOnceWith({ name: target, version: '1.0.0' });
    expect(f.ensure).toHaveBeenCalledOnceWith('/project');
  });
  it('same-board requests are idempotent but still check runtime readiness', async () => {
    const f = fixture(); f.state.board = target;
    const result = await switchProjectBoard({ boardName: target }, f.port);
    expect(result['ok']).toBeTrue(); expect(result['changed']).toBeFalse();
    expect(f.change).not.toHaveBeenCalled(); expect(f.ensure).toHaveBeenCalled();
  });
  it('rejects invalid or undiscovered boards before any lifecycle mutation', async () => {
    const f = fixture();
    for (const boardName of ['board-new', '@aily-project/lib-new', target + ';anything', undefined]) {
      expect((await switchProjectBoard({ boardName }, f.port))['ok']).toBeFalse();
    }
    f.port.resolveBoard = async () => undefined;
    expect((await switchProjectBoard({ boardName: target }, f.port))['reason']).toBe('board_not_in_catalog');
    expect(f.change).not.toHaveBeenCalled();
  });
  it('stops before mutation when the project changes during catalog loading', async () => {
    const f = fixture();
    f.port.resolveBoard = async name => { f.state.project = '/other'; return { name, version: '1' }; };
    expect((await switchProjectBoard({ boardName: target }, f.port))['changed']).toBeFalse();
    expect(f.change).not.toHaveBeenCalled();
  });
  it('does not claim a successful switch when the loader or board readback disagrees', async () => {
    const f = fixture(); f.state.ready = false;
    expect((await switchProjectBoard({ boardName: target }, f.port))['reason']).toBe('board_runtime_not_ready');
    f.state.ready = true; f.port.readBoard = async () => ({ ok: false, reason: 'board_state_mismatch', boardPackage: '@aily-project/board-old' });
    const result = await switchProjectBoard({ boardName: target }, f.port);
    expect(result['ok']).toBeFalse();
    expect(result['boardState'].reason).toBe('board_state_mismatch');
    expect(result['recovery'].automaticRetry).toBeFalse();
  });
  it('reports possible partial persistence on lifecycle failure and avoids further writes', async () => {
    const f = fixture(); f.change.and.rejectWith(new Error('reload failed'));
    const result = await switchProjectBoard({ boardName: target }, f.port);
    expect(result['ok']).toBeFalse(); expect(result['changed']).toBeNull();
    expect(result['stateMayHaveChanged']).toBeTrue();
    expect(result['message']).toBe('reload failed'); expect(f.ensure).not.toHaveBeenCalled();
  });
  it('reports host reload rejection as a terminal lifecycle failure, not asynchronous loading', async () => {
    const f = fixture();
    f.change.and.rejectWith(Object.assign(new Error('reload rejected'), { code: 'PROJECT_RELOAD_REJECTED' }));
    const result = await switchProjectBoard({ boardName: target }, f.port);
    expect(result['reason']).toBe('project_reload_rejected');
    expect(result['code']).toBe('PROJECT_RELOAD_REJECTED');
    expect(result['recovery'].automaticRetry).toBeFalse();
    expect(f.ensure).not.toHaveBeenCalled();
  });
});
