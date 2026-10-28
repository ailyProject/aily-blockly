import { CodeEditorProProjectService } from './services/code-editor-pro-project.service';

describe('Coder copy persistence', () => {
  let service: CodeEditorProProjectService, oldApis: any, bridge: any;
  let writes: any[];
  beforeEach(() => {
    oldApis = { fs: window['fs'], path: window['path'] }; writes = [];
    window['path'] = {
      relative: (a, b) => b.startsWith(a + '/') ? b.slice(a.length + 1) : '../outside',
      isAbsolute: value => value.startsWith('/'), join: (...parts) => parts.join('/'),
      dirname: path => path.slice(0, path.lastIndexOf('/')), basename: path => path.split('/').pop(),
    };
    window['fs'] = { existsSync: () => true, realpathAsync: async value => value,
      writeFileSync: (...args) => writes.push(args) };
    service = new CodeEditorProProjectService({} as any, {} as any, {} as any);
    bridge = { saveAll: jasmine.createSpy('save'), hasUnsavedChanges: async () => true,
      captureCopy: async () => ({ token: 'one', files: [{ path: '/A/main.cpp', bytes: new Uint8Array([255, 254, 65, 0]) }] }),
      checkCopy: jasmine.createSpy('check').and.resolveTo(), completeCopy: jasmine.createSpy('complete').and.resolveTo() };
    service.registerPersistenceBridge('/A', bridge);
  });
  afterEach(() => Object.assign(window, oldApis));
  it('writes exact encoded bytes only into B and acknowledges only after activation', async () => {
    const snapshot = await service.prepareCopy('/A');
    await snapshot.write('/B');
    expect(writes).toEqual([['/B/main.cpp', new Uint8Array([255, 254, 65, 0])]]);
    expect(bridge.saveAll).not.toHaveBeenCalled(); expect(bridge.completeCopy).not.toHaveBeenCalled();
    await snapshot.complete!(); expect(bridge.completeCopy).toHaveBeenCalledOnceWith('one');
  });
  it('rejects symlinks leading back into A before writing', async () => {
    window['fs'].realpathAsync = async value => value === '/B/main.cpp' ? '/A/main.cpp' : value;
    const snapshot = await service.prepareCopy('/A');
    await expectAsync(snapshot.write('/B')).toBeRejectedWithError(/项目外部/); expect(writes).toEqual([]);
  });
  it('rejects dirty files outside the selected source project', async () => {
    bridge.captureCopy = async () => ({ token: 'one', files: [{ path: '/other/file.cpp', bytes: new Uint8Array() }] });
    const snapshot = await service.prepareCopy('/A');
    await expectAsync(snapshot.write('/B')).toBeRejectedWithError(/不在当前项目/); expect(writes).toEqual([]);
  });
  it('refuses changed or unmounted editors without clearing their dirty state', async () => {
    const snapshot = await service.prepareCopy('/A');
    bridge.checkCopy.and.rejectWith(new Error('new edit'));
    await expectAsync(snapshot.write('/B')).toBeRejectedWithError('new edit'); expect(writes).toEqual([]);
    service.unregisterPersistenceBridge('/A', bridge);
    await expectAsync(snapshot.assertCurrent()).toBeRejectedWithError(/编辑器已切换/);
    expect(bridge.completeCopy).not.toHaveBeenCalled();
  });
});
