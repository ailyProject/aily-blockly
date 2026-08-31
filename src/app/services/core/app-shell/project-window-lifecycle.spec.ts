import {
  closeConnectionGraphSubWindows,
  isConnectionGraphWindowPath,
  type ProjectSubWindowBridge,
} from './project-window-lifecycle';

describe('project window lifecycle', () => {
  const graphPath = '/iframe?url=https%3A%2F%2Ftool.aily.pro%2Fconnection-graph%3Ftype%3Djson%26theme%3Ddark';

  it('recognizes only iframe windows whose target is the connection graph', () => {
    expect(isConnectionGraphWindowPath(graphPath)).toBeTrue();
    expect(isConnectionGraphWindowPath('/iframe?url=https%3A%2F%2Ftool.aily.pro%2Fcomponent-viewer')).toBeFalse();
    expect(isConnectionGraphWindowPath('/child-tool/connection-graph')).toBeFalse();
  });

  it('closes all connection graph windows and leaves unrelated windows open', async () => {
    const controlledPaths: string[] = [];
    const bridge: ProjectSubWindowBridge = {
      list: async () => ({
        windows: [
          { path: graphPath, open: true },
          { path: '/settings', open: true },
        ],
      }),
      control: async (path) => {
        controlledPaths.push(path);
        return { success: true, state: { path, open: false } };
      },
    };

    await expectAsync(closeConnectionGraphSubWindows(bridge)).toBeResolvedTo(true);
    expect(controlledPaths).toEqual([graphPath]);
  });

  it('reports failure when Electron leaves a connection graph window open', async () => {
    const bridge: ProjectSubWindowBridge = {
      list: async () => ({ windows: [{ path: graphPath, open: true }] }),
      control: async (path) => ({ success: true, state: { path, open: true } }),
    };

    await expectAsync(closeConnectionGraphSubWindows(bridge)).toBeResolvedTo(false);
  });
});
