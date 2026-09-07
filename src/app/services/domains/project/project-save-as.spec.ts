import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { projectDataRuntime } from './project-data/project-data-runtime';

describe('ProjectService save as mode isolation', () => {
  const source = '/Aily Projects/source';
  const target = '/Aily Projects/My Copy';
  let service: any;
  let files: Map<string, string>;
  let directories: Set<string>;
  let previousApis: any;
  let fs: any;
  let fsp: any;
  let flush: jasmine.Spy;
  let configure: jasmine.Spy;
  let getStore: jasmine.Spy;

  beforeEach(() => {
    previousApis = { fs: window['fs'], fsp: window['fsp'], path: window['path'] };
    files = new Map([
      [`${source}/package.json`, JSON.stringify({
        name: 'source', nickname: 'Source', type: 'coder', cloudId: 'original-cloud',
        dependencies: { '@aily-project/board-test': '1.0.0' }, path: source,
      })],
      [`${source}/sketch/src/main.cpp`, 'old code'],
      [`${source}/sketch/libraries/Local/Local.h`, 'local library'],
    ]);
    directories = new Set(['/Aily Projects', source]);
    fs = {
      existsSync: (path: string) => files.has(path) || directories.has(path),
      realpathAsync: jasmine.createSpy('realpath').and.callFake(async (path: string) => path),
      readFileSync: jasmine.createSpy('read').and.callFake((path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      }),
      writeFileSync: jasmine.createSpy('write').and.callFake((path: string, content: string) => files.set(path, content)),
      mkdirSync: jasmine.createSpy('mkdirSync').and.callFake((path: string) => directories.add(path)),
      copySync: jasmine.createSpy('copy').and.callFake((from: string, to: string) => {
        for (const [path, content] of [...files]) {
          if (path.startsWith(`${from}/`)) files.set(to + path.slice(from.length), content);
        }
      }),
    };
    fsp = {
      mkdir: jasmine.createSpy('mkdir').and.callFake(async (path: string) => {
        if (fs.existsSync(path)) throw new Error('EEXIST');
        directories.add(path);
      }),
      rm: jasmine.createSpy('rm').and.callFake(async (path: string) => {
        directories.delete(path);
        for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
      }),
    };
    window['fs'] = fs;
    window['fsp'] = fsp;
    window['path'] = {
      join: (...parts: string[]) => parts.join('/'),
      basename: (path: string) => path.slice(path.lastIndexOf('/') + 1),
      dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
      isAbsolute: (path: string) => path.startsWith('/'),
      resolve: (path: string) => path,
      normalize: (path: string) => path,
      isExists: fs.existsSync,
      relative: (from: string, to: string) => to.startsWith(`${from}/`)
        ? to.slice(from.length + 1) : '../' + to.slice(to.lastIndexOf('/') + 1),
    };
    service = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject(source);
    service.stateSubject = new BehaviorSubject('loaded');
    service.electronService = { isElectron: true };
    service.save = jasmine.createSpy('save').and.callFake(async () => {
      files.set(`${source}/sketch/src/main.cpp`, 'saved dirty editor');
      return { success: true };
    });
    service.projectOpen = jasmine.createSpy('projectOpen').and.callFake(async (path: string) => {
      expect(service.currentProjectPath).toBe(source);
      expect(files.has(`${path}/package.json`)).toBeTrue();
      service.currentProjectPath = path;
      return true;
    });
    service.addRecentlyProject = jasmine.createSpy('recent');
    flush = spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    configure = spyOn(projectDataRuntime, 'configure');
    getStore = spyOn(projectDataRuntime, 'getStore').and.throwError('Blockly runtime is not configured');
  });

  afterEach(() => Object.assign(window, previousApis));

  it('copies persisted Coder source and local libraries without requiring project.abi', async () => {
    await service.saveAs(target);

    expect(service.save).toHaveBeenCalledOnceWith(source, 15_000);
    expect(files.get(`${target}/sketch/src/main.cpp`)).toBe('saved dirty editor');
    expect(files.get(`${target}/sketch/libraries/Local/Local.h`)).toBe('local library');
    expect(JSON.parse(files.get(`${target}/package.json`)!)).toEqual({
      name: 'my_copy', nickname: 'My Copy', type: 'coder', path: target,
      dependencies: { '@aily-project/board-test': '1.0.0' },
    });
    expect(JSON.parse(files.get(`${source}/package.json`)!)).toEqual(jasmine.objectContaining({ cloudId: 'original-cloud', name: 'source' }));
    expect(service.projectOpen).toHaveBeenCalledOnceWith(target);
    expect(flush).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it('retains legacy project.aci while activating the copy as Coder', async () => {
    files.set(`${source}/package.json`, '{"name":"legacy"}');
    files.set(`${source}/project.aci`, 'legacy source');
    await service.saveAs(target);
    expect(files.get(`${target}/project.aci`)).toBe('legacy source');
    expect(service.getProjectMode(target)).toBe('coder');
  });

  it('keeps the source active and creates no destination when editor persistence fails', async () => {
    service.save.and.resolveTo({ success: false, error: 'dirty editor failed to save' });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('dirty editor failed to save');
    expect(fsp.mkdir).not.toHaveBeenCalled();
    expect(fs.copySync).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe(source);
  });

  it('rejects existing destinations without overwriting their contents', async () => {
    directories.add(target);
    files.set(`${target}/keep.txt`, 'existing data');
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/已存在/);
    expect(service.save).not.toHaveBeenCalled();
    expect(files.get(`${target}/keep.txt`)).toBe('existing data');
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  it('rejects destinations inside the source, including symlinked parents', async () => {
    await expectAsync(service.saveAs(`${source}/copy`)).toBeRejectedWithError(/当前项目内部/);
    fs.realpathAsync.and.callFake(async (path: string) => path === '/alias' ? source : path);
    await expectAsync(service.saveAs('/alias/copy')).toBeRejectedWithError(/当前项目内部/);
    expect(fs.copySync).not.toHaveBeenCalled();
  });

  it('does not overwrite a destination created while waiting for the editor', async () => {
    service.save.and.callFake(async () => {
      directories.add(target);
      files.set(`${target}/keep.txt`, 'created during save');
      return { success: true };
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('EEXIST');
    expect(fs.copySync).not.toHaveBeenCalled();
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(files.get(`${target}/keep.txt`)).toBe('created during save');
  });

  it('cleans up an incomplete copy and leaves the original active after a write failure', async () => {
    fs.writeFileSync.and.throwError('disk full');
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('disk full');
    expect(fs.existsSync(target)).toBeFalse();
    expect(files.has(`${target}/sketch/src/main.cpp`)).toBeFalse();
    expect(files.has(`${source}/sketch/src/main.cpp`)).toBeTrue();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe(source);
  });

  it('keeps the completed copy and reports its location when project activation is refused', async () => {
    service.projectOpen.and.resolveTo(false);
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/项目已另存至.*My Copy/);
    expect(files.get(`${target}/sketch/src/main.cpp`)).toBe('saved dirty editor');
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe(source);
  });

  it('aborts if the active project changes while saving', async () => {
    service.save.and.callFake(async () => {
      service.currentProjectPath = '/another/project';
      return { success: true };
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/当前项目已切换/);
    expect(fs.copySync).not.toHaveBeenCalled();
  });

  it('saves manifest-declared Coder projects even when a leftover project.abi exists', async () => {
    files.set(`${source}/project.abi`, '{}');
    service.save = ProjectService.prototype.save;
    service.injector = { get: () => ({ dispatchProjectSave: async () => ({ success: true }) }) };
    service.copyPackageJsonToTemp = jasmine.createSpy('snapshot').and.resolveTo(true);
    service.getPackageJson = async () => JSON.parse(files.get(`${source}/package.json`)!);
    service.getBlocklyProjectLoadStatus = jasmine.createSpy('blocklyLoad').and.returnValue({ ready: false });
    expect((await service.save(source)).success).toBeTrue();
    expect(service.getBlocklyProjectLoadStatus).not.toHaveBeenCalled();
  });

  it('preserves Blockly flush, resource validation, copying and in-place activation', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}');
    files.set(`${source}/project.abi`, '{"blocks":{}}');
    const validate = jasmine.createSpy('validate').and.resolveTo({ valid: true });
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: validate } as any);
    await service.saveAs('/blockly-copy');
    expect(service.save).toHaveBeenCalledOnceWith(source);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledOnceWith('/blockly-copy');
    expect(files.get('/blockly-copy/project.abi')).toBe('{"blocks":{}}');
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe('/blockly-copy');
  });

  it('still rejects Blockly copies with missing external resources', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}');
    files.set(`${source}/project.abi`, '{}');
    getStore.and.returnValue({
      collectReferences: () => [],
      validateReferences: async () => ({ valid: false, issues: [{ error: 'missing resource' }] }),
    } as any);
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/missing resource/);
    expect(fs.copySync).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe(source);
  });
});
