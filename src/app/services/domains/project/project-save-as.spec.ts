import { BehaviorSubject } from 'rxjs';
import { ProjectService } from './project.service';
import { projectDataRuntime } from './project-data/project-data-runtime';
import { ProjectLifecycleGate } from './project-lifecycle-gate';
import { sha256Hex } from '../../../utils/crypto.utils';

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
  let snapshot: any;
  let application: any;

  beforeEach(() => {
    previousApis = { fs: window['fs'], fsp: window['fsp'], path: window['path'], libraryDependencies: window['libraryDependencies'] };
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
      copyProjectDirectory: jasmine.createSpy('copy').and.callFake((from: string, to: string) => {
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
    service.projectLifecycle = new ProjectLifecycleGate();
    service.coderOperations = new Map();
    service.coderOperationsSubject = new BehaviorSubject(new Map());
    service.coderOperationSubject = new BehaviorSubject(null);
    service.coderProjectsSubject = new BehaviorSubject([]);
    service.coderWorkspaceSubject = new BehaviorSubject(null);
    service.configService = {
      data: { coderWorkspaceGroups: [], recentlyProjects: [] },
      save: jasmine.createSpy('configSave'),
    };
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
    service.hasUnsavedChanges = jasmine.createSpy('dirty').and.resolveTo(false);
    service.isProjectTransitionInProgress = jasmine.createSpy('transition').and.returnValue(false);
    service.getBlocklyProjectLoadStatus = jasmine.createSpy('loadStatus').and.returnValue({ project: source, state: 'loaded', ready: true });
    Object.defineProperty(service, 'message', { value: { warning: jasmine.createSpy('warning') } });
    snapshot = {
      publish: jasmine.createSpy('publishSnapshot'),
      isCurrent: jasmine.createSpy('snapshotCurrent').and.returnValue(true),
      dispose: jasmine.createSpy('disposeSnapshot'),
    };
    application = {
      hasActiveProjectMutation: jasmine.createSpy('activeMutation').and.returnValue(false),
      hasActiveBlocklyBuildOrUpload: jasmine.createSpy('activeBuild').and.returnValue(false),
      captureBlocklySaveAsSnapshot: jasmine.createSpy('captureSnapshot').and.callFake(async () => {
        const text = files.get(`${source}/project.abi`);
        snapshot.publish.and.callFake(async (path: string) => {
          files.set(`${path}/project.abi`, text!);
          return { projectSaved: true, generatedCodePublished: true, partial: false };
        });
        return snapshot;
      }),
    };
    application.captureBlocklyRecoveryCopySnapshot = jasmine.createSpy('captureRecovery').and.callFake(
      (path: string) => application.captureBlocklySaveAsSnapshot(path));
    fs.copyRecoveryProjectDirectory = jasmine.createSpy('copyRecovery').and.callFake((from: string, to: string) => {
      fs.copyProjectDirectory(from, to);
      files.delete(`${to}/project.abs`); files.delete(`${to}/project.abs.map.json`);
    });
    window['libraryDependencies'] = { status: jasmine.createSpy('libraryStatus').and.callFake(async () => ({
      dirty: false, busy: false, manifest: JSON.parse(files.get(`${source}/package.json`)!),
    })) };
    service.injector = { get: () => application };
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
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
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
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
  });

  it('does not overwrite a destination created while waiting for the editor', async () => {
    service.save.and.callFake(async () => {
      directories.add(target);
      files.set(`${target}/keep.txt`, 'created during save');
      return { success: true };
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('EEXIST');
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
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
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
  });

  it('saves manifest-declared Coder projects even when a leftover project.abi exists', async () => {
    files.set(`${source}/project.abi`, '{}');
    service.save = ProjectService.prototype.save;
    service.injector = { get: () => ({ dispatchProjectSave: async () => ({ success: true }) }) };
    service.getPackageJson = async () => JSON.parse(files.get(`${source}/package.json`)!);
    service.getBlocklyProjectLoadStatus = jasmine.createSpy('blocklyLoad').and.returnValue({ ready: false });
    expect((await service.save(source)).success).toBeTrue();
    expect(service.getBlocklyProjectLoadStatus).not.toHaveBeenCalled();
  });

  it('activates a Blockly copy through normal loading instead of rebinding only the resource store', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}');
    files.set(`${source}/project.abi`, '{"blocks":{}}');
    const validate = jasmine.createSpy('validate').and.resolveTo({ valid: true });
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: validate } as any);
    await service.saveAs('/blockly-copy');
    expect(service.save).not.toHaveBeenCalled();
    expect(application.captureBlocklySaveAsSnapshot).toHaveBeenCalledOnceWith(source);
    expect(snapshot.publish).toHaveBeenCalledOnceWith('/blockly-copy');
    expect(flush).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(files.get('/blockly-copy/project.abi')).toBe('{"blocks":{}}');
    expect(service.projectOpen).toHaveBeenCalledOnceWith('/blockly-copy');
    expect(service.currentProjectPath).toBe('/blockly-copy');
  });

  it('still rejects Blockly copies with missing external resources', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}');
    files.set(`${source}/project.abi`, '{}');
    application.captureBlocklySaveAsSnapshot.and.rejectWith(new Error('missing resource'));
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/missing resource/);
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
    expect(service.currentProjectPath).toBe(source);
  });

  it('keeps a complete Blockly copy and the original context if activation is refused', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true }) } as any);
    service.projectOpen.and.resolveTo(false);
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, activated: false }));
    expect(files.get(`${target}/project.abi`)).toBe('{}');
    expect(service.currentProjectPath).toBe(source); expect(configure).not.toHaveBeenCalled();
    expect(fsp.rm).not.toHaveBeenCalledWith(target, jasmine.anything());
  });

  it('does not merge a Blockly copy into a concurrently created directory', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    application.captureBlocklySaveAsSnapshot.and.callFake(async () => {
      directories.add(target); files.set(`${target}/keep`, 'external'); return snapshot;
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('EEXIST');
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled(); expect(fsp.rm).not.toHaveBeenCalled();
    expect(files.get(`${target}/keep`)).toBe('external');
  });

  it('cleans up only the reserved incomplete Blockly copy on publication failure', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true }) } as any);
    fs.writeFileSync.and.throwError('disk full');
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('disk full');
    expect(fsp.rm).toHaveBeenCalledOnceWith(target, { recursive: true, force: true });
    expect(files.get(`${source}/project.abi`)).toBe('{}'); expect(service.projectOpen).not.toHaveBeenCalled();
  });

  for (const change of ['workspace', 'disk', 'failed-check']) it(`retains the original and completed copy after a late ${change} change`, async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true }) } as any);
    snapshot.isCurrent.and.callFake(() => {
      if (change === 'failed-check') throw new Error('comparison unavailable');
      if (change === 'disk') files.set(`${source}/project.abi`, '{"external":true}');
      return false;
    });
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, activated: false }));
    expect(service.projectOpen).not.toHaveBeenCalled(); expect(service.currentProjectPath).toBe(source);
    expect(files.get(`${target}/project.abi`)).toBe('{}');
    expect(fsp.rm).not.toHaveBeenCalledWith(target, jasmine.anything());
  });

  it('preserves spaces for Blockly destinations and uses the filtered project copy bridge', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true }) } as any);
    await service.saveAs(target);
    expect(fs.copyProjectDirectory).toHaveBeenCalledOnceWith(source, target);
    expect(service.currentProjectPath).toBe(target);
  });

  it('stops a Blockly copy when the runtime is replaced at the same path during resource validation', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    let session = 'a'; spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
    application.captureBlocklySaveAsSnapshot.and.callFake(async () => { session = 'b'; return snapshot; });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/会话已切换/);
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled(); expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('stops a Blockly copy when snapshot capture switches the active project', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}');
    application.captureBlocklySaveAsSnapshot.and.callFake(async () => { service.currentProjectPath = '/new-project'; return snapshot; });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/会话已切换/);
    expect(flush).not.toHaveBeenCalled(); expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
  });

  it('rejects an old copy host before saving or reserving a destination', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); delete fs.copyProjectDirectory;
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/完整重启/);
    expect(service.save).not.toHaveBeenCalled(); expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('does not copy an ABI changed externally during resource validation', async () => {
    files.set(`${source}/package.json`, '{"name":"source"}'); files.set(`${source}/project.abi`, '{}');
    application.captureBlocklySaveAsSnapshot.and.callFake(async () => {
      files.set(`${source}/project.abi`, '{"external":true}'); throw new Error('project.abi 已被修改');
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/project.abi 已被修改/);
    expect(fs.copyProjectDirectory).not.toHaveBeenCalled(); expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(files.get(`${source}/project.abi`)).toBe('{"external":true}');
  });

  function dirtyBlocklySnapshot() {
    const original = JSON.stringify({ schemaVersion: 3, pages: [
      { id: 'main', content: { blocks: { blocks: [{ type: 'text', id: 'label', fields: { TEXT: 'disk value' } }] } } },
    ], sharedModel: { variables: [{ id: 'v', name: 'counter', type: 'int' }] } });
    const document = JSON.parse(original);
    document.pages[0].content.blocks.blocks[0].fields.TEXT = 'unsaved canvas';
    document.pages.push({ id: 'second', content: { blocks: { blocks: [] } } });
    const captured = JSON.stringify(document);
    files.set(`${source}/package.json`, '{"name":"source"}');
    files.set(`${source}/project.abi`, original);
    files.set(`${source}/assets/project-data/test.bin`, 'retained resource');
    getStore.and.returnValue({ collectReferences: () => [], validateReferences: async () => ({ valid: true }) } as any);
    service.save.and.callFake(async () => {
      files.set(`${source}/project.abi`, captured);
      return { success: true };
    });
    const snapshot: any = {
      publish: jasmine.createSpy('publishSnapshot').and.callFake(async (path: string) => {
        files.set(`${path}/project.abi`, captured);
        return { projectSaved: true, generatedCodePublished: true, partial: false };
      }),
      isCurrent: jasmine.createSpy('snapshotCurrent').and.returnValue(true),
      dispose: jasmine.createSpy('disposeSnapshot'),
    };
    const application = { captureBlocklySaveAsSnapshot: jasmine.createSpy('captureSnapshot').and.resolveTo(snapshot),
      captureBlocklyRecoveryCopySnapshot: jasmine.createSpy('captureRecoverySnapshot').and.resolveTo(snapshot),
      captureBlocklyRecoveryFragment: jasmine.createSpy('captureRecoveryFragment').and.resolveTo({ documentText: '{}' }),
      hasActiveProjectMutation: jasmine.createSpy('activeMutation').and.returnValue(false),
      hasActiveBlocklyBuildOrUpload: jasmine.createSpy('activeBuild').and.returnValue(false) };
    service.injector = { get: () => application };
    return { original, captured, application, snapshot };
  }

  it('writes the unsaved Blockly snapshot only to the new target, leaving the original project bytes unchanged', async () => {
    const { original, captured, application } = dirtyBlocklySnapshot();
    await service.saveAs(target);
    expect(service.save).not.toHaveBeenCalled();
    expect(application.captureBlocklySaveAsSnapshot).toHaveBeenCalledOnceWith(source);
    expect(files.get(`${source}/project.abi`)).toBe(original);
    expect(files.get(`${target}/project.abi`)).toBe(captured);
    expect(files.get(`${target}/assets/project-data/test.bin`)).toBe('retained resource');
  });

  it('can create the Blockly target when a source build lock rejects source persistence', async () => {
    const { original, captured, application } = dirtyBlocklySnapshot();
    service.save.and.resolveTo({ success: false, error: 'PROJECT_FILE_BUSY: compiler owns source output' });
    application.hasActiveProjectMutation.and.returnValue(true);
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, activated: false }));
    expect(service.save).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${source}/project.abi`)).toBe(original);
    expect(files.get(`${target}/project.abi`)).toBe(captured);
  });

  it('fences input for activation, then releases the fence and snapshot', async () => {
    const { snapshot } = dirtyBlocklySnapshot();
    let frozen = false;
    const release = jasmine.createSpy('unfreeze').and.callFake(() => { frozen = false; });
    snapshot.freezeForActivation = jasmine.createSpy('freeze').and.callFake(() => { frozen = true; return release; });
    service.projectOpen.and.callFake(async () => { expect(frozen).toBeTrue(); return true; });
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, activated: true }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
    expect(frozen).toBeFalse();
  });

  for (const transition of ['navigation', 'lifecycle']) it(`does not enqueue activation after a newer ${transition} starts while publishing`, async () => {
    const { captured, snapshot } = dirtyBlocklySnapshot();
    snapshot.publish.and.callFake(async () => {
      files.set(`${target}/project.abi`, captured);
      if (transition === 'navigation') service.stateSubject.next('loading');
      else service.isProjectTransitionInProgress.and.returnValue(true);
      return { projectSaved: true, generatedCodePublished: true, partial: false };
    });
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, activated: false }));
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${target}/project.abi`)).toBe(captured);
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed target when its generated code is only partially published', async () => {
    const { captured, snapshot } = dirtyBlocklySnapshot();
    snapshot.publish.and.callFake(async () => {
      files.set(`${target}/project.abi`, captured);
      return { projectSaved: true, generatedCodePublished: false, partial: true, code: 'BUILD_WORKSPACE_BUSY', error: 'Project saved; generated code is busy.' };
    });
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true, generatedCodePublished: false, partial: true }));
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(files.get(`${target}/project.abi`)).toBe(captured);
    expect(service.message.warning).toHaveBeenCalled();
  });

  it('retains a committed target when publication loses its acknowledgement', async () => {
    const { captured, snapshot } = dirtyBlocklySnapshot();
    snapshot.publish.and.callFake(async () => {
      files.set(`${target}/project.abi`, captured);
      throw Object.assign(new Error('publication acknowledgement lost'), {
        projectSaved: true, uncertain: true, code: 'ABS_SAVE_AS_INCOMPLETE',
      });
    });
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: true,
      generatedCodePublished: false, partial: true, activated: false, error: jasmine.stringMatching('My Copy') }));
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${target}/project.abi`)).toBe(captured);
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves an uncertain target without asserting that the project was saved', async () => {
    const { snapshot } = dirtyBlocklySnapshot();
    snapshot.publish.and.rejectWith(Object.assign(new Error('commit result unavailable'), { uncertain: true }));
    expect(await service.saveAs(target)).toEqual(jasmine.objectContaining({ projectSaved: false,
      generatedCodePublished: false, partial: true, activated: false, code: 'PROJECT_SAVE_AS_UNKNOWN' }));
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(directories.has(target)).toBeTrue();
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
  });

  it('removes only the reserved target after a definite precommit publication failure', async () => {
    const { original, snapshot } = dirtyBlocklySnapshot();
    snapshot.publish.and.rejectWith(new Error('target reference validation failed'));
    await expectAsync(service.saveAs(target)).toBeRejectedWithError('target reference validation failed');
    expect(fsp.rm).toHaveBeenCalledOnceWith(target, { recursive: true, force: true });
    expect(files.get(`${source}/project.abi`)).toBe(original);
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains a committed-source acknowledgement when derived code publication is incomplete', async () => {
    service.save = ProjectService.prototype.save;
    application.dispatchProjectSave = async () => ({ success: false, projectSaved: true,
      generatedCodePublished: false, partial: true, code: 'BUILD_WORKSPACE_BUSY', error: 'Project saved; generated code is busy.' });
    expect(await service.save(source)).toEqual(jasmine.objectContaining({ success: false, projectSaved: true,
      generatedCodePublished: false, partial: true, code: 'BUILD_WORKSPACE_BUSY' }));
    expect(service.stateSubject.value).toBe('saved');
  });

  function pendingLibraryCopy() {
    const document = dirtyBlocklySnapshot();
    const disk = {
      name: 'source', nickname: 'Old source', cloudId: 'source-cloud', path: source,
      dependencies: { '@aily-project/core-test': '1.0.0', '@aily-project/removed': '1.0.0' },
      devDependencies: { '@aily-project/dev-test': '1.0.0' },
      customMetadata: { retain: ['source', 'metadata'] },
    };
    files.set(`${source}/package.json`, JSON.stringify(disk));
    const state: any = {
      dirty: true, busy: false, manifest: { ...disk,
        dependencies: { '@aily-project/core-test': '2.0.0', '@aily-project/added': '3.0.0' },
        devDependencies: { '@aily-project/dev-test': '2.0.0' },
        ailyLocalLibrarySources: { '@aily-project/added': { sourcePath: 'local/added' } },
        ailyBoardConfig: { flashMode: 'dio' },
      },
    };
    const manager = {
      status: jasmine.createSpy('copyLibraryStatus').and.callFake(async () => JSON.parse(JSON.stringify(state))),
      save: jasmine.createSpy('saveLibraries'), discard: jasmine.createSpy('discardLibraries'),
    };
    window['libraryDependencies'] = manager;
    return { ...document, diskText: JSON.stringify(disk), state, manager };
  }

  it('retains an external destination mirror change after a rejected copy publication instead of deleting its directory', async () => {
    const f = pendingLibraryCopy();
    f.snapshot.publish.and.callFake(async () => {
      files.set(`${target}/project.abi`, '{"externalTargetEdit":true}');
      throw Object.assign(new Error('Destination changed before commit'), { code: 'PROJECT_FILE_CONFLICT' });
    });
    expect(await service.saveRecoveryAs(target)).toEqual(jasmine.objectContaining({
      projectSaved: false, activated: false, partial: true, code: 'PROJECT_SAVE_AS_TARGET_CONFLICT',
    }));
    expect(files.get(`${target}/project.abi`)).toBe('{"externalTargetEdit":true}');
    expect(fsp.rm).not.toHaveBeenCalled(); expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
  });

  for (const mode of ['save-as', 'recovery'] as const) it(`publishes effective dirty library additions, removals and versions only into the ${mode} destination`, async () => {
    const f = pendingLibraryCopy();
    if (mode === 'recovery') {
      f.application.captureBlocklyRecoveryCopySnapshot = jasmine.createSpy('captureRecovery').and.resolveTo(f.snapshot);
      fs.copyRecoveryProjectDirectory.and.callFake((from: string, to: string) => {
        for (const [path, text] of [...files]) if (path.startsWith(`${from}/`)) files.set(to + path.slice(from.length), text);
      });
    }
    const outcome = await (mode === 'recovery' ? service.saveRecoveryAs(target) : service.saveAs(target));
    expect(outcome).toEqual(jasmine.objectContaining({ projectSaved: true, activated: true }));
    const copied = JSON.parse(files.get(`${target}/package.json`)!);
    expect(copied.dependencies).toEqual({ '@aily-project/core-test': '2.0.0', '@aily-project/added': '3.0.0' });
    expect(copied.devDependencies).toEqual({ '@aily-project/dev-test': '2.0.0' });
    expect(copied.ailyLocalLibrarySources).toEqual(f.state.manifest.ailyLocalLibrarySources);
    expect(copied.ailyBoardConfig).toEqual(f.state.manifest.ailyBoardConfig);
    expect(copied.customMetadata).toEqual(f.state.manifest.customMetadata);
    expect(copied.name).toBe('my_copy'); expect(copied.nickname).toBe('My Copy');
    expect(copied.path).toBe(target); expect(copied.cloudId).toBeUndefined();
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
    expect(files.get(`${target}/project.abi`)).toBe(f.captured);
    expect(f.manager.status).toHaveBeenCalledWith(source);
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.discard).not.toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
    if (mode === 'recovery') {
      expect(f.application.captureBlocklyRecoveryCopySnapshot).toHaveBeenCalledOnceWith(source);
      expect(f.application.captureBlocklySaveAsSnapshot).not.toHaveBeenCalled();
      expect(fs.copyRecoveryProjectDirectory).toHaveBeenCalledOnceWith(source, target);
      expect(fs.copyProjectDirectory).not.toHaveBeenCalled();
    }
  });

  for (const [label, facts] of [
    ['busy', { dirty: true, busy: true, manifest: {} }],
    ['missing', undefined], ['invalid dirty', { busy: false, manifest: {} }],
    ['invalid busy', { dirty: false, busy: 'false', manifest: {} }],
    ['invalid manifest', { dirty: false, busy: false, manifest: [] }],
  ] as Array<[string, any]>) it(`rejects ${label} library facts before capturing or reserving a copy`, async () => {
    const f = pendingLibraryCopy();
    f.manager.status.and.resolveTo(facts);
    await expectAsync(service.saveAs(target)).toBeRejected();
    expect(f.application.captureBlocklySaveAsSnapshot).not.toHaveBeenCalled();
    expect(fsp.mkdir).not.toHaveBeenCalled(); expect(f.snapshot.publish).not.toHaveBeenCalled();
    expect(service.projectOpen).not.toHaveBeenCalled(); expect(service.save).not.toHaveBeenCalled();
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.discard).not.toHaveBeenCalled();
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('rejects effective library changes during document capture before reserving the destination', async () => {
    const f = pendingLibraryCopy();
    f.application.captureBlocklySaveAsSnapshot.and.callFake(async () => {
      f.state.manifest.dependencies['@aily-project/added'] = '4.0.0';
      return f.snapshot;
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/Effective library dependencies changed/);
    expect(fsp.mkdir).not.toHaveBeenCalled(); expect(f.snapshot.publish).not.toHaveBeenCalled();
    expect(f.snapshot.dispose).toHaveBeenCalledTimes(1);
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('cleans only an uncommitted reserved target when library facts change during directory copy', async () => {
    const f = pendingLibraryCopy();
    fs.copyProjectDirectory.and.callFake((from: string, to: string) => {
      for (const [path, text] of [...files]) if (path.startsWith(`${from}/`)) files.set(to + path.slice(from.length), text);
      f.state.manifest.dependencies['@aily-project/added'] = '4.0.0';
    });
    await expectAsync(service.saveAs(target)).toBeRejectedWithError(/Effective library dependencies changed/);
    expect(f.snapshot.publish).not.toHaveBeenCalled();
    expect(fsp.rm).toHaveBeenCalledOnceWith(target, { recursive: true, force: true });
    expect(directories.has(target)).toBeFalse(); expect(files.has(`${target}/package.json`)).toBeFalse();
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
    expect(f.snapshot.dispose).toHaveBeenCalledTimes(1); expect(service.projectOpen).not.toHaveBeenCalled();
  });

  for (const change of ['manifest', 'busy'] as const) it(`keeps a published target but does not activate after library ${change} changes`, async () => {
    const f = pendingLibraryCopy();
    f.snapshot.publish.and.callFake(async () => {
      files.set(`${target}/project.abi`, f.captured);
      if (change === 'manifest') f.state.manifest.dependencies['@aily-project/added'] = '4.0.0';
      else f.state.busy = true;
      return { projectSaved: true, generatedCodePublished: true, partial: false };
    });
    const outcome = await service.saveAs(target);
    expect(outcome).toEqual(jasmine.objectContaining({ projectSaved: true, generatedCodePublished: true, activated: false }));
    expect(outcome.warnings.length).toBeGreaterThan(0);
    expect(files.get(`${target}/project.abi`)).toBe(f.captured);
    expect(JSON.parse(files.get(`${target}/package.json`)!).dependencies['@aily-project/added']).toBe('3.0.0');
    expect(fsp.rm).not.toHaveBeenCalled(); expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
    expect(f.snapshot.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses the independent recovery capture without ordinary save or clearing original quarantine', async () => {
    const f = pendingLibraryCopy();
    const quarantine = { blocked: true };
    f.application.captureBlocklySaveAsSnapshot.and.rejectWith(new Error('ordinary editor lease is quarantined'));
    f.application.captureBlocklyRecoveryCopySnapshot = jasmine.createSpy('recoveryCapture').and.callFake(async () => {
      expect(quarantine.blocked).toBeTrue(); return f.snapshot;
    });
    const outcome = await service.saveRecoveryAs(target);
    expect(outcome).toEqual(jasmine.objectContaining({ projectSaved: true, activated: true }));
    expect(f.application.captureBlocklySaveAsSnapshot).not.toHaveBeenCalled();
    expect(f.application.captureBlocklyRecoveryCopySnapshot).toHaveBeenCalledOnceWith(source);
    expect(fs.copyRecoveryProjectDirectory).toHaveBeenCalledOnceWith(source, target);
    expect(quarantine.blocked).toBeTrue(); expect(service.save).not.toHaveBeenCalled();
    expect(f.manager.save).not.toHaveBeenCalled(); expect(f.manager.discard).not.toHaveBeenCalled();
    expect(files.get(`${source}/package.json`)).toBe(f.diskText);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  for (const kind of ['workspace', 'saved-document'] as const) it(`publishes a native-deferred ${kind} copy without freezing or replacing the source view`, async () => {
    const f = dirtyBlocklySnapshot();
    const freeze = jasmine.createSpy('freezeForActivation').and.throwError('No navigation fence is needed');
    f.snapshot.freezeForActivation = freeze;
    if (kind === 'saved-document') {
      service.getBlocklyProjectLoadStatus.and.returnValue({ project: source, ready: false, state: 'error', error: 'missing library' });
      f.application.captureBlocklyRecoveryFragment.and.resolveTo({ documentText: '{"partial":"retained"}' });
    }
    const before = [...files].filter(([name]) => name.startsWith(source + '/'));
    const result = await service.saveRecoveryAs(target, { activation: 'retain-source' });
    expect(result.projectSaved).toBeTrue(); expect(result.activated).toBeFalse();
    expect(result.activationDeferred).toEqual({ reason: 'isolated-repair-host' });
    expect(result.recoverySource.kind).toBe(kind); expect(result.recoverySource.partialCanvas).not.toBe('unavailable');
    expect(service.projectOpen).not.toHaveBeenCalled(); expect(service.currentProjectPath).toBe(source);
    expect(service.save).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
    expect(files.get(`${target}/project.abi`)).toBe(kind === 'workspace' ? f.captured : f.original);
    if (kind === 'workspace') expect(f.snapshot.dispose).toHaveBeenCalledTimes(1);
    for (const [name, text] of before) expect(files.get(name)).toBe(text);
  });

  it('native workspace primary admission permits only the exact saved target and preserves origin through normalizer CAS', async () => {
    const f = dirtyBlocklySnapshot();
    const text = f.captured, hash = `sha256:${await sha256Hex(text)}`, sourceHash = `sha256:${await sha256Hex(f.original)}`;
    const archive = `${target}/.aily/recovery-primary/${'a'.repeat(64)}.json`;
    const origin = { sourceKind: 'workspace', sourceAbiHash: sourceHash };
    const proof = { version: 1, kind: 'native-completed-fork-primary', project: target, sourceProject: source,
      requestId: 'native-workspace-primary', abiHash: hash, archive, origin };
    files.set(`${target}/project.abi`, text);
    files.set(`${target}/package.json`, files.get(`${source}/package.json`)!);
    files.set(archive, JSON.stringify({ version: 1, kind: proof.kind, project: target, sourceProject: source,
      requestId: proof.requestId, primary: { text, hash }, origin }));
    const outcome = { sourceProject: source, project: target, projectSaved: true, generatedCodePublished: false,
      partial: false, activated: false, recoveryArchive: archive, nativePrimaryProof: proof, targetAbiHash: hash,
      recoverySource: { version: 1, kind: 'workspace', complete: true, loadFailed: false, partialCanvas: 'not-applicable' } };
    service.currentProjectPath = '';
    fs.projectRepairEnvironment = { admission: jasmine.createSpy('nativeAdmission').and.resolveTo(outcome) };
    service.projectOpen.and.callFake(async (project: string) => { service.currentProjectPath = project; return false; });
    service.getBlocklyProjectLoadStatus.and.callFake((project: string) => ({ project, ready: false, state: 'error', error: 'missing library' }));
    await service.openIndependentRepairTarget();
    const admitted = await service.inspectSavedRecoveryTarget(target);
    expect(admitted.nativePrimaryProof).toEqual(proof); expect(admitted.recoverySource.kind).toBe('workspace');
    expect(admitted.abiHash).toBe(hash); expect(await service.inspectSavedRecoveryTarget(source)).toBeNull();
    const afterText = '{"schemaVersion":3,"normalized":true}', afterHash = `sha256:${await sha256Hex(afterText)}`;
    files.set(`${target}/project.abi`, afterText);
    await service.recoveryTargets.advanceNormalization(target, { beforeAbiHash: hash, afterAbiHash: afterHash,
      publication: { status: 'COMMITTED', hash: afterHash, backupHash: hash } }, () => {});
    const advanced = await service.inspectSavedRecoveryTarget(target);
    expect(advanced.abiHash).toBe(afterHash); expect(advanced.nativePrimaryProof.abiHash).toBe(hash);
    expect(JSON.parse(files.get(archive)!).primary.text).toBe(text);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  for (const invalid of ['foreign-project', 'foreign-archive', 'wrong-hash', 'forged-source'] as const)
    it(`refuses native primary admission with ${invalid} without opening a target`, async () => {
      const f = dirtyBlocklySnapshot(), text = f.captured, hash = `sha256:${await sha256Hex(text)}`;
      const archive = `${target}/.aily/recovery-primary/${'b'.repeat(64)}.json`;
      const proof: any = { version: 1, kind: 'native-completed-fork-primary', project: target, sourceProject: source,
        requestId: 'native-workspace-invalid', abiHash: hash, archive, origin: { sourceKind: 'workspace', sourceAbiHash: hash } };
      files.set(`${target}/project.abi`, text);
      files.set(archive, JSON.stringify({ version: 1, kind: proof.kind, project: target, sourceProject: source,
        requestId: proof.requestId, primary: { text, hash }, origin: proof.origin }));
      if (invalid === 'foreign-project') proof.project = '/foreign';
      if (invalid === 'foreign-archive') proof.archive = '/foreign/primary.json';
      if (invalid === 'wrong-hash') proof.abiHash = 'sha256:' + '0'.repeat(64);
      if (invalid === 'forged-source') proof.origin.sourceKind = 'saved-document';
      const outcome = { projectSaved: true, project: target, sourceProject: source, targetAbiHash: hash,
        recoveryArchive: proof.archive, nativePrimaryProof: proof, recoverySource: { kind: 'workspace', complete: true } };
      service.currentProjectPath = '';
      fs.projectRepairEnvironment = { admission: async () => outcome };
      await expectAsync(service.openIndependentRepairTarget()).toBeRejected();
      expect(service.projectOpen).not.toHaveBeenCalled(); expect(service.hasSavedRecoveryTarget(target)).toBeFalse();
      expect(files.get(`${source}/project.abi`)).toBe(f.original);
    });

  it('recovers a closed legacy source without loading or migrating any source file', async () => {
    const f = dirtyBlocklySnapshot();
    const legacy = '{ "blocks": { "blocks": [] }, "retained": "' + 'large-data-'.repeat(1000) + '" }';
    files.set(`${source}/project.abi`, legacy);
    files.set(`${source}/project.abs`, 'retained old candidate');
    files.set(`${source}/project.abs.map.json`, '{"old":"map"}');
    service.currentProjectPath = '';
    const before = [...files];
    service.projectOpen.and.callFake(async (project: string) => {
      expect(service.currentProjectPath).toBe('');
      expect(project).toBe(target);
      files.set(`${target}/project.abi`, '{"schemaVersion":3,"normalizedOnlyInTarget":true}');
      service.currentProjectPath = target;
      return true;
    });
    const result = await service.saveClosedRecoveryAs(source, target);
    expect(result.projectSaved).toBeTrue(); expect(result.activated).toBeTrue();
    expect(result.recoverySource).toEqual({ version: 1, kind: 'saved-document', complete: true,
      loadFailed: false, partialCanvas: 'not-applicable' });
    const archive = JSON.parse(files.get(result.recoveryArchive)!);
    expect(archive.files['project.abi']).toBe(legacy);
    expect(archive.partialCanvas).toEqual({ applicable: false });
    for (const [name, value] of before) expect(files.get(name)).toBe(value);
    expect(service.save).not.toHaveBeenCalled();
    expect(f.application.captureBlocklyRecoveryCopySnapshot).not.toHaveBeenCalled();
    expect(f.application.captureBlocklyRecoveryFragment).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  for (const reason of ['view', 'writer', 'build', 'libraries'] as const)
    it(`does not open a closed source over ${reason} ownership or discard any view`, async () => {
      const f = dirtyBlocklySnapshot();
      service.currentProjectPath = reason === 'view' ? '/another-open-project' : '';
      if (reason === 'writer') f.application.hasActiveProjectMutation.and.returnValue(true);
      if (reason === 'build') f.application.hasActiveBlocklyBuildOrUpload.and.returnValue(true);
      if (reason === 'libraries') (service as any).dependencyLifecycle.isBusy = () => true;
      const before = [...files];
      expect(() => service.saveClosedRecoveryAs(source, target)).toThrowError(/replace a live view|active source owner/);
      expect([...files]).toEqual(before); expect(service.save).not.toHaveBeenCalled();
      expect(service.projectOpen).not.toHaveBeenCalled(); expect(fsp.mkdir).not.toHaveBeenCalled();
    });

  it('uses the complete disk document after failed loading and archives the partial canvas separately', async () => {
    const f = dirtyBlocklySnapshot();
    service.getBlocklyProjectLoadStatus.and.returnValue({ project: source, ready: false, state: 'error', error: 'load timeout' });
    const fragment = '{"pages":[{"id":"partial","content":{"blocks":{"blocks":[]}}}]}';
    f.application.captureBlocklyRecoveryFragment = jasmine.createSpy('fragment').and.resolveTo({ documentText: fragment });
    const before = [...files];
    const outcome = await service.saveRecoveryAs(target);
    expect(outcome.recoverySource).toEqual({ version: 1, kind: 'saved-document', complete: true, loadFailed: true, partialCanvas: 'archived' });
    expect(outcome.activated).toBeTrue();
    expect(files.get(`${target}/project.abi`)).toBe(f.original);
    expect(f.application.captureBlocklyRecoveryCopySnapshot).not.toHaveBeenCalled();
    expect(f.application.captureBlocklySaveAsSnapshot).not.toHaveBeenCalled();
    expect(f.snapshot.publish).not.toHaveBeenCalled();
    expect(JSON.parse(files.get(outcome.recoveryArchive)! ).partialCanvas.document).toEqual(JSON.parse(fragment));
    for (const [path, content] of before) expect(files.get(path)).toBe(content);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('saves a disk-based recovery without disposing an unserializable partial view', async () => {
    const f = dirtyBlocklySnapshot();
    service.getBlocklyProjectLoadStatus.and.returnValue({ project: source, ready: false, state: 'error', error: 'load timeout' });
    f.application.captureBlocklyRecoveryFragment = jasmine.createSpy('fragment').and.resolveTo({ error: 'opaque serializer failed' });
    const outcome = await service.saveRecoveryAs(target);
    expect(outcome.projectSaved).toBeTrue(); expect(outcome.activated).toBeFalse();
    expect(outcome.activationBlocked).toEqual({ reason: 'partial-canvas-unavailable', message: 'opaque serializer failed' });
    expect(service.projectOpen).not.toHaveBeenCalled(); expect(service.currentProjectPath).toBe(source);
    expect(files.get(`${target}/project.abi`)).toBe(f.original); expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  for (const reason of ['loading', 'writer']) it(`does not bypass an ongoing ${reason} to create a failed-load copy`, async () => {
    const f = dirtyBlocklySnapshot();
    service.getBlocklyProjectLoadStatus.and.returnValue({ project: source, ready: false,
      state: reason === 'loading' ? 'loading' : 'error', ...(reason === 'writer' ? { error: 'load timeout' } : {}) });
    if (reason === 'writer') f.application.hasActiveProjectMutation.and.returnValue(true);
    await expectAsync(service.saveRecoveryAs(target)).toBeRejected();
    expect(fsp.mkdir).not.toHaveBeenCalled(); expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  async function failedRecoveryTarget() {
    const f = dirtyBlocklySnapshot();
    service.getBlocklyProjectLoadStatus.and.callFake((project: string) => ({ project, ready: false, state: 'error', error: 'missing library' }));
    f.application.captureBlocklyRecoveryFragment = jasmine.createSpy('fragment').and.resolveTo({ documentText: '{"pages":[]}' });
    service.projectOpen.and.callFake(async (project: string) => { service.currentProjectPath = project; return false; });
    const result = await service.saveRecoveryAs(target);
    expect(result.projectSaved).toBeTrue(); expect(result.activated).toBeFalse();
    expect(service.hasSavedRecoveryTarget(target)).toBeTrue();
    return { ...f, result };
  }

  it('offers dependency repair facts only for the exact actual disk recovery target and unchanged ABI', async () => {
    const f = await failedRecoveryTarget();
    const facts = await service.inspectSavedRecoveryTarget(target);
    expect(facts).toEqual(jasmine.objectContaining({ ok: true, operation: 'project_abi_check', project: target,
      sourceProject: source, scope: 'saved-recovery-project', pendingMutation: false, unsavedLibraryChanges: false,
      libraryState: { dirty: false, busy: false } }));
    expect(facts.abiHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(facts.recoverySource.kind).toBe('saved-document');
    expect(await service.inspectSavedRecoveryTarget(source)).toBeNull();
    files.set(`${target}/project.abi`, '{"newer":"document"}');
    expect(await service.inspectSavedRecoveryTarget(target)).toBeNull();
    expect(service.hasSavedRecoveryTarget(target)).toBeFalse();
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('cannot grant recovery dependency permission from an arbitrary copied archive or a former host instance', async () => {
    dirtyBlocklySnapshot();
    files.set(`${target}/project.abi`, '{"pages":[]}');
    files.set(`${target}/recovery-source-manual.json`, '{"recoverySource":{"complete":true}}');
    service.currentProjectPath = target;
    expect(service.hasSavedRecoveryTarget(target)).toBeFalse();
    expect(await service.inspectSavedRecoveryTarget(target)).toBeNull();
    await expectAsync(service.reloadSavedRecoveryTarget(target)).toBeRejected();
    expect(service.projectOpen).not.toHaveBeenCalled();
  });

  it('reopens only an independently saved target after installed dependencies, preserving its latest partial view first', async () => {
    const f = await failedRecoveryTarget();
    f.application.captureBlocklyRecoveryFragment.and.resolveTo({ documentText: '{"partial":"latest target view"}' });
    const priorArchiveCount = [...files.keys()].filter(path => path.startsWith(`${target}/recovery-source-`)).length;
    service.projectOpen.calls.reset();
    service.projectOpen.and.callFake(async (project: string, options: any) => {
      expect(project).toBe(target); expect(options.reason).toBe('reload'); expect(options.saveBeforeReload).toBeFalse();
      expect(options.lifecycleOwner).toBeDefined();
      service.getBlocklyProjectLoadStatus.and.returnValue({ project: target, ready: true, state: 'loaded' });
      return true;
    });
    const result = await service.reloadSavedRecoveryTarget(target);
    expect(result.ok).toBeTrue(); expect(result.ready).toBeTrue();
    expect(result.recoveryReload).toEqual(jasmine.objectContaining({ version: 1, project: target, source: 'saved-document', ready: true }));
    expect(result.recoveryReload.beforeAbiHash).toBe(result.recoveryReload.afterAbiHash);
    expect([...files.keys()].filter(path => path.startsWith(`${target}/recovery-source-`)).length).toBe(priorArchiveCount + 1);
    expect(JSON.parse(files.get(result.recoveryArchive)! ).partialCanvas.document).toEqual({ partial: 'latest target view' });
    expect(files.get(`${target}/project.abi`)).toBe(f.original); expect(files.get(`${source}/project.abi`)).toBe(f.original);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('does not reload through a recovery target capability while another mutation owns it', async () => {
    const f = await failedRecoveryTarget();
    service.projectOpen.calls.reset();
    f.application.hasActiveProjectMutation.and.returnValue(true);
    await expectAsync(service.reloadSavedRecoveryTarget(target)).toBeRejected();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(files.get(`${target}/project.abi`)).toBe(f.original);
  });

  it('does not discard pending library edits through saved-target reload', async () => {
    const f = await failedRecoveryTarget();
    service.projectOpen.calls.reset();
    window['libraryDependencies'].status.and.resolveTo({ dirty: true, busy: false });
    await expectAsync(service.reloadSavedRecoveryTarget(target)).toBeRejectedWithError(/Pending library-manager edits/);
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.projectLifecycle.hasActive(target)).toBeFalse();
    expect(files.get(`${target}/project.abi`)).toBe(f.original);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('keeps an unserializable recovery-target view active and releases only its own reload lease', async () => {
    const f = await failedRecoveryTarget();
    service.projectOpen.calls.reset();
    f.application.captureBlocklyRecoveryFragment.and.resolveTo({ error: 'target serializer unavailable' });
    const result = await service.reloadSavedRecoveryTarget(target);
    expect(result.ok).toBeFalse(); expect(result.ready).toBeFalse();
    expect(result.activationBlocked.reason).toBe('partial-canvas-unavailable');
    expect(result.recoveryReload).toBeUndefined();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.projectLifecycle.hasActive(target)).toBeFalse();
    expect(service.currentProjectPath).toBe(target);
    expect(files.get(`${target}/project.abi`)).toBe(f.original);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('does not turn an unsuccessful normal target reload into readiness', async () => {
    const f = await failedRecoveryTarget();
    service.projectOpen.calls.reset();
    service.projectOpen.and.resolveTo(false);
    const result = await service.reloadSavedRecoveryTarget(target);
    expect(result.ok).toBeFalse(); expect(result.ready).toBeFalse();
    expect(result.recoveryReload.ready).toBeFalse();
    expect(result.loadStatus.error).toBe('missing library');
    expect(service.projectLifecycle.hasActive(target)).toBeFalse();
    expect(files.get(`${target}/project.abi`)).toBe(f.original);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('releases its reload lease after the saved primary changes during partial capture', async () => {
    const f = await failedRecoveryTarget();
    service.projectOpen.calls.reset();
    f.application.captureBlocklyRecoveryFragment.and.callFake(async () => {
      files.set(`${target}/project.abi`, '{"newer":"retained target document"}');
      return { documentText: '{}' };
    });
    // Capturing the changed primary is not permitted to silently adopt it.
    await expectAsync(service.reloadSavedRecoveryTarget(target)).toBeRejected();
    expect(service.projectOpen).not.toHaveBeenCalled();
    expect(service.projectLifecycle.hasActive(target)).toBeFalse();
    expect(files.get(`${target}/project.abi`)).toBe('{"newer":"retained target document"}');
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  it('advances an existing same-renderer recovery capability through normal typed CAS even outside child bootstrap', async () => {
    const f = await failedRecoveryTarget();
    service.createProjectDataStore = () => ({ flushPending: async () => {}, collectReferences: () => [], validateReferences: async () => ({ valid: true, issues: [] }) });
    fs.projectFilePublicationVersion = 2;
    fs.replaceProjectText = jasmine.createSpy('normalizeCAS').and.callFake(async request => {
      const path = `${request.projectPath}/${request.fileName}`;
      if (`sha256:${await sha256Hex(files.get(path)!)}` !== request.expectedHash) return { status: 'CONFLICT' };
      files.set(path, request.content);
      return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}`, backupHash: request.expectedHash };
    });
    expect(service.independentRepairNormalization).toBeUndefined();
    await service.ensureProjectDataSchemaForLoad(target, JSON.parse(f.original), f.original);
    const admitted = await service.inspectSavedRecoveryTarget(target);
    expect(admitted.scope).toBe('saved-recovery-project'); expect(admitted.abiHash).toBe(`sha256:${await sha256Hex(files.get(`${target}/project.abi`)!)}`);
    expect(admitted.recoveryArchive).toBe(f.result.recoveryArchive); expect(admitted.sourceProject).toBe(source);
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
  });

  for (const changed of ['wrong-before', 'external-after', 'session-changed']) it(`does not rebind a recovery marker after ${changed}`, async () => {
    const f = await failedRecoveryTarget(), prior = await service.inspectSavedRecoveryTarget(target);
    const expectedAfter = '{"normalized":"only acknowledged"}', afterHash = `sha256:${await sha256Hex(expectedAfter)}`;
    if (changed !== 'wrong-before') files.set(`${target}/project.abi`, changed === 'external-after' ? '{"external":"retained"}' : expectedAfter);
    let checks = 0;
    await expectAsync(service.recoveryTargets.advanceNormalization(target, {
      beforeAbiHash: changed === 'wrong-before' ? 'sha256:' + '0'.repeat(64) : prior.abiHash, afterAbiHash: afterHash,
      publication: { status: 'COMMITTED', hash: afterHash, backupHash: prior.abiHash },
    }, () => { if (changed === 'session-changed' && ++checks > 1) throw new Error('stale session'); })).toBeRejected();
    if (changed === 'wrong-before') expect((await service.inspectSavedRecoveryTarget(target)).abiHash).toBe(prior.abiHash);
    else expect(await service.inspectSavedRecoveryTarget(target)).toBeNull();
    expect(files.get(`${source}/project.abi`)).toBe(f.original);
    if (changed === 'external-after') expect(files.get(`${target}/project.abi`)).toBe('{"external":"retained"}');
  });
});
