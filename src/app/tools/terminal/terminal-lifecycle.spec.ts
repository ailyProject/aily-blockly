import { TerminalComponent } from './terminal.component';
import { TerminalService } from './terminal.service';

describe('bottom panel terminal lifecycle', () => {
  const bridge = window as unknown as { terminal: any };
  let original: any;
  beforeEach(() => { original = bridge.terminal; });
  afterEach(() => { bridge.terminal = original; });

  function panel(service: TerminalService): TerminalComponent {
    const component = Object.create(TerminalComponent.prototype);
    component.terminalService = service;
    component.projectService = { currentProjectPath: '/project' };
    component.terminal = { write: jasmine.createSpy('write') };
    return component;
  }

  it('releases the original late PTY without closing or taking over a reopened panel', async () => {
    const pending: ((value: { pid: number }) => void)[] = [];
    const release = jasmine.createSpy('release');
    const close = jasmine.createSpy('close');
    bridge.terminal = {
      init: () => new Promise(resolve => pending.push(resolve)),
      onPidData: jasmine.createSpy('listen').and.returnValue(release), close,
    };
    const service = new TerminalService();
    const oldPanel = panel(service), nextPanel = panel(service);
    const first = oldPanel.nodePtyInit();
    (oldPanel as any).isDestroyed = true;
    const second = nextPanel.nodePtyInit();
    pending[1]({ pid: 202 }); await second;
    pending[0]({ pid: 101 }); await first;
    oldPanel.closeNodePty();

    expect(close).toHaveBeenCalledOnceWith({ pid: 101 });
    expect(service.currentPid).toBe(202);
    expect(bridge.terminal.onPidData).toHaveBeenCalledOnceWith(202, jasmine.any(Function));
    const output = bridge.terminal.onPidData.calls.first().args[1];
    output({ data: 'live' });
    expect(nextPanel.terminal.write).toHaveBeenCalledOnceWith('live');
    nextPanel.closeNodePty();
    output({ data: 'late' });
    expect(nextPanel.terminal.write).toHaveBeenCalledOnceWith('live');
    expect(release).toHaveBeenCalledTimes(1);
    expect(close.calls.allArgs()).toEqual([[{ pid: 101 }], [{ pid: 202 }]]);
    expect(service.currentPid).toBeUndefined();
  });

  it('retains one global forwarder with old preloads and releases its last panel', () => {
    const onData = jasmine.createSpy('onData');
    bridge.terminal = { onData };
    const service = new TerminalService();
    const previous = jasmine.createSpy('closed view'), current = jasmine.createSpy('current view');
    const closeOld = service.listen(1, previous);
    const closeCurrent = service.listen(2, current);
    closeOld();
    const forward = onData.calls.first().args[0];
    forward('live');
    closeCurrent(); forward('late');
    expect(onData).toHaveBeenCalledTimes(1);
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnceWith('live');
  });
});
