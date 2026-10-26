import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';

describe('project Save As preserves the saved source', () => {
  const source = '/projects/A', target = '/projects/B';
  let service: any, files: Map<string, string>, directories: Set<string>, original: any;
  let app: any, snapshot: any, fs: any, fsp: any;
  beforeEach(() => {
    original = { fs: window['fs'], fsp: window['fsp'], path: window['path'], libraryDependencies: window['libraryDependencies'] };
    window['libraryDependencies'] = undefined;
    files = new Map([[`${source}/package.json`, '{"name":"A","type":"coder","cloudId":"original","path":"/projects/A"}'],
      [`${source}/main.cpp`, 'saved'], [`${source}/assets/data.bin`, 'resource']]);
    directories = new Set([source, '/projects']);
    fs = {
      existsSync: path => files.has(path) || directories.has(path), realpathAsync: async path => path,
      readFileSync: path => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path); },
      writeFileSync: jasmine.createSpy('write').and.callFake((path, text) => files.set(path, text)),
      copyProjectDirectory: jasmine.createSpy('copy').and.callFake((from, to) => {
        for (const [path, text] of [...files]) if (path.startsWith(from + '/')) files.set(to + path.slice(from.length), text);
      }),
    };
    fsp = {
      mkdir: jasmine.createSpy('mkdir').and.callFake(async path => { if (fs.existsSync(path)) throw new Error('EEXIST'); directories.add(path); }),
      rm: jasmine.createSpy('rm').and.callFake(async path => {
        directories.delete(path); for (const file of [...files.keys()]) if (file.startsWith(path + '/')) files.delete(file);
      }),
    };
    Object.assign(window, { fs, fsp, path: {
      join: (...parts) => parts.join('/'), resolve: path => path, normalize: path => path,
      basename: path => path.slice(path.lastIndexOf('/') + 1), dirname: path => path.slice(0, path.lastIndexOf('/')),
      isAbsolute: path => path.startsWith('/'), isExists: fs.existsSync,
      relative: (from, to) => to.startsWith(from + '/') ? to.slice(from.length + 1) : '../' + to.split('/').pop(),
    } });
    service = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject(source);
    service.libraryChanges = new Map(); service.projectLifecycle = new ProjectLifecycleGate();
    service.dependencyLifecycleState = { isStopping: () => false, get: () => undefined };
    service.translate = { instant: () => 'AI 任务正在运行，请等待完成后再另存为。' };
    snapshot = { assertCurrent: jasmine.createSpy('assert').and.resolveTo(), release: jasmine.createSpy('release'),
      write: jasmine.createSpy('snapshotWrite').and.callFake(async path => files.set(`${path}/main.cpp`, 'unsaved')),
      complete: jasmine.createSpy('complete').and.resolveTo() };
    app = { hasRunningAi: () => false, hasActiveProjectMutation: () => false,
      prepareProjectCopy: jasmine.createSpy('prepare').and.resolveTo(snapshot) };
    service.injector = { get: () => app };
    service.save = jasmine.createSpy('save').and.throwError('Must not save A');
    service.projectOpen = jasmine.createSpy('open').and.callFake(async path => { service.currentProjectPathSubject.next(path); return true; });
  });
  afterEach(() => Object.assign(window, original));

  for (const mode of ['blockly', 'coder']) {
    it(`writes the dirty ${mode} snapshot to B and preserves every source file`, async () => {
      if (mode === 'blockly') { files.set(`${source}/project.abi`, '{"saved":true}'); files.set(`${source}/package.json`, '{"name":"A","type":"blockly","path":"/projects/A"}'); }
      const before = [...files];
      await service.saveAs(target);
      for (const [path, text] of before) expect(files.get(path)).withContext(path).toBe(text);
      expect(files.get(`${target}/main.cpp`)).toBe('unsaved');
      expect(files.get(`${target}/assets/data.bin`)).toBe('resource');
      expect(JSON.parse(files.get(`${target}/package.json`)!)).toEqual({ name: 'b', nickname: 'B', type: mode, path: target });
      expect(service.save).not.toHaveBeenCalled(); expect(snapshot.complete).toHaveBeenCalled();
      expect(service.currentProjectPath).toBe(target); expect(service.projectLifecycle.hasActive(source)).toBeFalse();
    });
    it(`rejects active AI before preparing a ${mode} copy`, async () => {
      app.hasRunningAi = () => true;
      await expectAsync(service.saveAs(target)).toBeRejectedWithError(/AI 任务正在运行/);
      expect(app.prepareProjectCopy).not.toHaveBeenCalled(); expect(fsp.mkdir).not.toHaveBeenCalled();
    });
  }
  it('preserves B identity even when its package.json had an unsaved buffer', async () => {
    snapshot.write.and.callFake(async path => files.set(`${path}/package.json`, '{"name":"A","cloudId":"old","description":"dirty","path":"/projects/A"}'));
    await service.saveAs(target);
    expect(JSON.parse(files.get(`${target}/package.json`)!)).toEqual({ name: 'b', nickname: 'B', description: 'dirty', path: target });
  });
  it('includes pending dependency edits without saving the original manifest', async () => {
    service.libraryChanges.set(source.toLowerCase(), { name: 'A', type: 'coder', dependencies: { local: '2' } });
    const before = files.get(`${source}/package.json`);
    await service.saveAs(target);
    expect(JSON.parse(files.get(`${target}/package.json`)!).dependencies).toEqual({ local: '2' });
    expect(files.get(`${source}/package.json`)).toBe(before);
  });
  it('keeps editors untouched and creates no directory when snapshot capture fails', async () => {
    app.prepareProjectCopy.and.rejectWith(new Error('editor not ready'));
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('editor not ready');
    expect(fsp.mkdir).not.toHaveBeenCalled(); expect(service.currentProjectPath).toBe(source);
    expect(service.projectLifecycle.hasActive(source)).toBeFalse();
  });
  it('preserves pending libraries and dirty manifest editor content together', async () => {
    service.libraryChanges.set(source.toLowerCase(), { name: 'A', dependencies: { local: '2' } });
    snapshot.write.and.callFake(async path => files.set(`${path}/package.json`, '{"name":"A","description":"unsaved","dependencies":{"local":"1"}}'));
    await service.saveAs(target);
    const copy = JSON.parse(files.get(`${target}/package.json`)!);
    expect(copy.description).toBe('unsaved'); expect(copy.dependencies).toEqual({ local: '2' });
    expect(JSON.parse(files.get(`${source}/package.json`)!).cloudId).toBe('original');
  });
  it('rejects existing and nested destinations without deleting their data', async () => {
    directories.add(target); files.set(`${target}/keep`, 'keep');
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/已存在/);
    await expectAsync(service.saveAs(source + '/copy')).toBeRejectedWithError(/当前项目内部/);
    expect(fsp.rm).not.toHaveBeenCalled(); expect(app.prepareProjectCopy).not.toHaveBeenCalled();
  });
  it('does not delete a destination created concurrently while capturing editors', async () => {
    app.prepareProjectCopy.and.callFake(async () => { directories.add(target); files.set(`${target}/keep`, 'keep'); return snapshot; });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('EEXIST');
    expect(fsp.rm).not.toHaveBeenCalled(); expect(files.get(`${target}/keep`)).toBe('keep');
  });
  it('removes only the incomplete copy on disk failure and keeps unsaved source buffers', async () => {
    snapshot.write.and.rejectWith(new Error('disk full'));
    const before = [...files];
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('disk full');
    expect([...files]).toEqual(before); expect(fsp.rm).toHaveBeenCalledOnceWith(target, { recursive: true, force: true });
    expect(snapshot.complete).not.toHaveBeenCalled(); expect(service.projectOpen).not.toHaveBeenCalled();
    expect(snapshot.release).toHaveBeenCalled();
  });
  it('rejects an AI task that starts during snapshot capture', async () => {
    app.prepareProjectCopy.and.callFake(async () => { app.hasRunningAi = () => true; return snapshot; });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/AI 任务正在运行/);
    expect(fsp.mkdir).not.toHaveBeenCalled(); expect(snapshot.release).toHaveBeenCalled();
  });
  it('rejects changed editor contents before activation', async () => {
    snapshot.write.and.callFake(async path => { files.set(`${path}/main.cpp`, 'snapshot'); snapshot.assertCurrent.and.rejectWith(new Error('editor changed')); });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('editor changed');
    expect(service.projectOpen).not.toHaveBeenCalled(); expect(files.get(`${source}/main.cpp`)).toBe('saved');
    expect(directories.has(target)).toBeFalse(); expect(snapshot.complete).not.toHaveBeenCalled();
  });
  it('keeps a complete copy and original buffers when activation is refused', async () => {
    service.projectOpen.and.resolveTo(false);
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/项目已另存至/);
    expect(files.get(`${target}/main.cpp`)).toBe('unsaved'); expect(snapshot.complete).not.toHaveBeenCalled();
    expect(fsp.rm).not.toHaveBeenCalled(); expect(service.currentProjectPath).toBe(source);
  });
  it('refuses a stale same-path editor session', async () => {
    const active = { signal: { aborted: false } };
    service.dependencyLifecycleState = { get: () => active, isStopping: () => false };
    app.prepareProjectCopy.and.callFake(async () => { active.signal.aborted = true; return snapshot; });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/会话已切换/);
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
  });
});
