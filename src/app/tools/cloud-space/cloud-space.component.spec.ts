import { BehaviorSubject, from, NEVER, of, Subject, throwError } from 'rxjs';
import { AILY_LOCAL_LIBRARY_SOURCES_KEY } from '@domain/dependencies/public-api';
import { detectProjectMode, projectDataRuntime } from '@domain/project/public-api';
import { CloudSpaceComponent } from './cloud-space.component';
import { AbsBaselineStore, absBaselineKey } from '../../integrations/blockly/abs/abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText } from '../../integrations/blockly/abs/abs-identity-map';
import { projectCloudIdentity, writeCloudSyncState } from './services/cloud-sync-state';

describe('CloudSpace opening state', () => {
  let component: CloudSpaceComponent, open: jasmine.Spy, message: { error: jasmine.Spy };
  beforeEach(() => {
    open = jasmine.createSpy('open');
    message = { error: jasmine.createSpy('error') };
    component = new CloudSpaceComponent({} as any, {} as any, {} as any, {} as any,
      message as any, {} as any, {} as any, {} as any, {} as any, { open } as any,
      {} as any, {} as any, {} as any);
  });

  for (const outcome of ['success', 'error']) {
    it(`suppresses duplicate opens and clears pending state on ${outcome}`, async () => {
      let settle: () => void;
      const error = new Error('open failed');
      open.and.returnValue(new Promise<void>((resolve, reject) => {
        settle = () => outcome === 'success' ? resolve() : reject(error);
      }));
      const item = { id: '42' };

      const pending = component.openInNewTab(item);
      expect(component.openingProjectIds.has(item.id)).toBeTrue();
      await component.openInNewTab(item);
      expect(open).toHaveBeenCalledOnceWith('42', false, undefined, jasmine.any(Function));

      settle();
      await pending;
      expect(component.openingProjectIds.has(item.id)).toBeFalse();
      if (outcome === 'error') expect(message.error).toHaveBeenCalledOnceWith(error.message);
      else expect(message.error).not.toHaveBeenCalled();
    });
  }

  it('invalidates the previous open when a new project is selected or the view is destroyed', async () => {
    let settle: () => void;
    open.and.returnValue(new Promise<void>(resolve => { settle = resolve; }));
    const first = component.openInNewTab({ id: 'old' });
    const firstIsCurrent = open.calls.mostRecent().args[3];
    expect(firstIsCurrent()).toBeTrue();
    const second = component.openInNewTab({ id: 'new' });
    const secondIsCurrent = open.calls.mostRecent().args[3];
    expect(firstIsCurrent()).toBeFalse();
    expect(secondIsCurrent()).toBeTrue();
    component.ngOnDestroy();
    expect(secondIsCurrent()).toBeFalse();
    settle();
    await Promise.all([first, second]);
  });
});

describe('CloudSpace Hub publishing', () => {
  let component: any;
  const ownProject = { id: 17, uuid: 'cloud & project', owner_id: 'author', category: 'blockly', is_published: false };

  beforeEach(() => {
    component = Object.create(CloudSpaceComponent.prototype);
    component.isStudent = false;
    component.authService = { userInfo: { id: 'author' } };
    component.electronService = { openUrl: jasmine.createSpy('openUrl') };
    component.hubNavigation = { open: jasmine.createSpy('open').and.resolveTo() };
    component.cloudService = {
      publishProject: jasmine.createSpy('publish'),
      unpublishProject: jasmine.createSpy('unpublish').and.returnValue(of({ status: 200 })),
    };
  });

  it('offers Hub only for the signed-in non-student owner of a supported cloud project', () => {
    expect(component.canPublishToHub(ownProject)).toBeTrue();
    expect(component.canPublishToHub({ ...ownProject, category: 'coder' })).toBeTrue();
    for (const item of [
      { ...ownProject, owner_id: 'other' },
      { ...ownProject, student: { active: true } },
      { ...ownProject, uuid: undefined },
      { ...ownProject, category: 'other' },
    ]) {
      expect(component.canPublishToHub(item)).toBeFalse();
      component.publishToHub(item);
    }
    component.isStudent = true;
    component.publishToHub(ownProject);
    component.isStudent = false;
    component.authService.userInfo = null;
    component.publishToHub(ownProject);
    expect(component.hubNavigation.open).not.toHaveBeenCalled();
  });

  it('hands the encoded cloud UUID to Hub account navigation without changing publication state', () => {
    const item = { ...ownProject };
    component.publishToHub(item);
    expect(component.hubNavigation.open).toHaveBeenCalledOnceWith('/publish?cloudProject=cloud%20%26%20project');
    expect(component.electronService.openUrl).not.toHaveBeenCalled();
    expect(component.cloudService.publishProject).not.toHaveBeenCalled();
    expect(component.cloudService.unpublishProject).not.toHaveBeenCalled();
    expect(item).toEqual(ownProject);
  });

});

describe('CloudSpace project packaging and sync mode isolation', () => {
  const root = '/aily Projects/demo';
  const baseline = 'a'.repeat(64);
  const scope = JSON.stringify(['https://local-cloud.example', 'local-user']);
  let component: any;
  let files: Map<string, string>;
  let directories: Set<string>;
  let previousApis: any;
  let flush: jasmine.Spy;
  let getStore: jasmine.Spy;
  let validate: jasmine.Spy;

  beforeEach(() => {
    previousApis = { fs: window['fs'], path: window['path'], os: window['os'] };
    files = new Map([
      [`${root}/package.json`, JSON.stringify({ name: 'demo', type: 'coder', entry: 'src/main.cpp', cloudId: 'existing-id' })],
      [`${root}/sketch/src/main.cpp`, 'saved code'],
      [`${root}/sketch/libraries/Local/Local.h`, 'local library'],
    ]);
    directories = new Set([root, `${root}/sketch`]);
    const isDirectory = (path: string) => directories.has(path) || [...files.keys()].some(file => file.startsWith(path + '/'));
    window['fs'] = {
      existsSync: (path: string) => files.has(path) || directories.has(path),
      readFileSync: jasmine.createSpy('read').and.callFake((path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      }),
      writeFileSync: jasmine.createSpy('write').and.callFake((path: string, content: string) => files.set(path, content)),
      mkdirSync: (path: string) => directories.add(path),
      rmSync: jasmine.createSpy('rm').and.callFake((path: string) => {
        directories.delete(path);
        for (const file of files.keys()) {
          if (file.startsWith(path + '/')) files.delete(file);
        }
      }),
      unlinkSync: (path: string) => files.delete(path),
      statSync: (path: string) => ({ _isFile: files.has(path), size: files.get(path)?.length || 0 }),
      lstatSync: (path: string) => ({ _isFile: files.has(path), _isDirectory: isDirectory(path),
        size: files.get(path)?.length || 0, mtime: files.get(path) }),
      readDirSync: (path: string) => [...new Set([...files.keys(), ...directories].filter(file => file.startsWith(path + '/'))
        .map(file => file.slice(path.length + 1).split('/')[0]))]
        .map(name => ({ name, _isFile: files.has(path + '/' + name), _isDirectory: isDirectory(path + '/' + name) })),
      readFileBufferAsync: async (path: string) => new TextEncoder().encode(files.get(path)).buffer,
      renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      captureProjectAttachment: (path: string) => ({ path }),
      replaceProjectText: async ({ projectPath, fileName, expectedHash, content }, guard) => {
        guard();
        const path = projectPath + '/' + fileName;
        if (await hashAbsText(files.get(path)!) !== expectedHash) return { status: 'CONFLICT' };
        guard();
        files.set(path, content);
        return { status: 'COMMITTED', hash: await hashAbsText(content) };
      },
    };
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    const filePath = (key: string) => root + '/' + (['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'].includes(key) ? key : '.aily/abs-sync/' + key);
    const read = async (key: string) => files.get(filePath(key)) ?? null;
    const access = { read, replace: async (key: string, expected: string | null, content: string | null) => {
      const before = await read(key);
      if ((before === null ? null : await hashAbsText(before)) !== expected) return false;
      if (content === null) files.delete(filePath(key)); else files.set(filePath(key), content);
      return true;
    } };
    window['fs'].projectSyncStorageVersion = 2;
    window['fs'].openProjectSyncStorage = async () => ({ read, withLock: run => new Promise((resolve, reject) =>
      run(access, result => result.ok ? resolve(result.value) : reject(result.error))) });
    window['os'] = { tmpdir: () => '/tmp' };
    component = Object.create(CloudSpaceComponent.prototype);
    spyOn(component, 'cloudSyncReceiptsEnabled').and.returnValue(true);
    component.message = { error: jasmine.createSpy('error'), success: jasmine.createSpy('success'),
      warning: jasmine.createSpy('warning'), info: jasmine.createSpy('info') };
    component.authService = { currentUser: { id: 'local-user' } };
    component.configService = { isCoderProduct: () => false };
    component.getCloudProjects = jasmine.createSpy('projects').and.resolveTo();
    component.electronService = { readFile: (path: string) => window['fs'].readFileSync(path, 'utf8') };
    component.platformService = { za7: '7zz' };
    component.cmdService = {
      runAsync: jasmine.createSpy('pack').and.callFake(async (command: string) => {
        const archivePath = command.match(/ a -t7z(?: -mx=9)? "([^"]+)"/)?.[1];
        if (archivePath) files.set(archivePath, 'archive');
        return { type: 'close', code: 0 };
      }),
    };
    component.projectService = {
      currentProjectPath: root,
      captureCurrentProjectGuard: () => () => component.projectService.currentProjectPath === root,
      hasUnsavedChanges: async () => false,
      save: jasmine.createSpy('save').and.resolveTo({ success: true }),
      getPackageJson: async () => JSON.parse(files.get(`${root}/package.json`)!),
      getProjectMode: () => detectProjectMode({
        manifest: JSON.parse(files.get(`${root}/package.json`)!),
        hasAbi: files.has(`${root}/project.abi`), hasAci: files.has(`${root}/project.aci`),
      }),
    };
    component.cloudService = {
      baseUrl: 'https://local-cloud.example',
      observeSyncRequest: jasmine.createSpy('observe').and.callFake(requestId =>
        of({ status: 200, data: { request_id: requestId, state: 'unconfirmed' } })),
      syncProject: jasmine.createSpy('sync').and.callFake(request => from(committed(request))),
    };
    writeCloudSyncState(root, { version: 1, identity: projectCloudIdentity(root), scope,
      binding: { cloudId: 'existing-id', archiveSha256: baseline } });
    flush = spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    validate = jasmine.createSpy('validate').and.resolveTo({ valid: true });
    getStore = spyOn(projectDataRuntime, 'getStore').and.returnValue({
      collectReferences: (value: unknown) => [value], validateReferences: validate,
    } as any);
  });

  afterEach(() => Object.assign(window, previousApis));

  async function committed(request: any) {
    const digest = await crypto.subtle.digest('SHA-256', request.archiveContents);
    return { status: 200, data: { id: request.pid ?? 'created-id', request_id: request.requestId,
      state: 'committed', archive_sha256: Array.from(new Uint8Array(digest), digit => digit.toString(16).padStart(2, '0')).join('') } };
  }

  function useBlockly() {
    files.set(`${root}/package.json`, '{"name":"demo"}');
    files.set(`${root}/project.abi`, '{"blocks":{}}');
    files.delete(`${root}/.aily/cloud-sync-state.json`);
  }

  it('packages Coder without ABI or touching the Blockly data runtime', async () => {
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(flush).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
    expect(window['fs'].readFileSync).not.toHaveBeenCalledWith(`${root}/project.abi`, 'utf8');
    expect(component.message.error).not.toHaveBeenCalled();
    const command = component.cmdService.runAsync.calls.first().args[0];
    expect(command).toContain('"-xr!.*/"');
    expect(command).not.toContain('"-xr!.*"');
    expect(command).toContain('"-x!sketch/preprocess.json"');
    expect(command).toContain('"-x!sketch/library-cache.json"');
    expect(command).toContain('"-x!sketch/target-compile.json"');
    expect(command).toContain('"-x!sketch/compile-preprocess-*.json"');
    expect(command).toContain('"-xr!.build"');
    expect(command).toContain('"-xr!.aily"');
    expect(command).toContain('"-x!project.abs.map.json"');
  });

  it('treats a manifest-declared Coder project with a leftover invalid ABI as Coder', async () => {
    files.set(`${root}/project.abi`, 'invalid leftover');
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(getStore).not.toHaveBeenCalled();
    expect(component.cmdService.runAsync.calls.first().args[0]).toContain('"-x!project.abi"');
  });

  it('supports legacy project.aci without a sketch directory', async () => {
    files.set(`${root}/package.json`, '{"name":"legacy"}');
    files.set(`${root}/project.aci`, 'legacy code');
    directories.delete(`${root}/sketch`);
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(getStore).not.toHaveBeenCalled();
  });

  it('rejects a Coder project with only an empty project association file before packing', async () => {
    directories.delete(`${root}/sketch`);
    files.set(`${root}/project.aci`, '');
    expect(await component.packageProject(root)).toBeUndefined();
    expect(component.message.error).toHaveBeenCalledWith('Coder 项目源码不存在，无法打包');
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
  });

  it('validates Blockly resources while excluding both local ABS files from the archive', async () => {
    useBlockly();
    files.set(`${root}/project.abs`, 'field: "@json:{\\"resource\\":1}"');
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledOnceWith([{ blocks: {} }, { resource: 1 }]);
    expect(component.cmdService.runAsync.calls.first().args).toEqual([
      `7zz a -t7z -mx=9 "${root}/project.7z" * "-x!node_modules" "-xr!.*" "-x!package-lock.json" "-x!project.7z" "-x!project.abi" "-x!package.json" "-x!project.abi.backup" "-x!project.abs" "-x!project.abs.map.json"`,
      root, false,
    ]);
    expect(component.cmdService.runAsync).toHaveBeenCalledTimes(2);
  });

  it('packages one immutable saved source when public mirrors and the manifest change during archive creation', async () => {
    useBlockly();
    const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
      pages: [{ id: 'main', title: 'Main', content: { blocks: { blocks: [] } } }], sharedModel: { procedureBlocks: [] } };
    const abi = absJson(document), generation = 'cloud-original';
    files.set(`${root}/project.abi`, abi);
    const native = await window['fs'].openProjectSyncStorage(root, () => {});
    const port = { read: native.read, withLock: action => native.withLock((io, settle) =>
      action(io).then(value => settle({ ok: true, value }), error => settle({ ok: false, error }))) };
    const store = new AbsBaselineStore(port, { projectKey: root, pageId: 'main' });
    const projection = await createAbsProjection(document.pages[0].content, { document, generation,
      baselineRef: absBaselineKey(generation), scope: { projectKey: root, pageId: 'main' }, savedAbiHash: await hashAbsText(abi) });
    await store.stage({ projection, abi, mode: 'import', inputAbs: projection.abs, expected: await store.captureDisk() });
    await store.commit(generation, () => {}, async (text, expected, io) => { expect(await io.replace('project.abi', expected, text)).toBeTrue(); });
    files.set(`${root}/project.abi`, 'partial next ABI');
    files.set(`${root}/project.abs`, 'unpublished next draft');
    component.cmdService.runAsync.and.callFake(async (_command, cwd) => {
      if (cwd === root) files.set(`${root}/package.json`, '{"name":"later manifest"}');
      else {
        expect(files.get(cwd + '/project.abi')).toBe(abi);
        expect(JSON.parse(files.get(cwd + '/package.json')!)).toEqual({ name: 'demo' });
      }
      files.set(`${root}/project.7z`, 'archive'); return { type: 'close', code: 0 };
    });
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(component.cmdService.runAsync).toHaveBeenCalledTimes(2);
    expect(files.get(`${root}/project.abi`)).toBe('partial next ABI');
    expect(files.get(`${root}/project.abs`)).toBe('unpublished next draft');
    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('still refuses Blockly archives with missing external resources', async () => {
    useBlockly();
    validate.and.resolveTo({ valid: false, issues: [{ error: 'missing resource' }] });
    expect(await component.packageProject(root)).toBeUndefined();
    expect(component.message.error).toHaveBeenCalledWith('项目数据资源不完整，无法打包');
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
  });

  it('still refuses malformed Blockly ABI and ABS documents', async () => {
    useBlockly();
    files.set(`${root}/project.abi`, 'invalid JSON');
    expect(await component.packageProject(root)).toBeUndefined();
    files.set(`${root}/project.abi`, '{}');
    files.set(`${root}/project.abs`, 'field: "@json:unterminated');
    expect(await component.packageProject(root)).toBeUndefined();
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
  });

  it('strips local library paths only from the archived manifest', async () => {
    const manifest = { name: 'demo', type: 'coder', [AILY_LOCAL_LIBRARY_SOURCES_KEY]: { local: '/private/library' } };
    files.set(`${root}/package.json`, JSON.stringify(manifest));
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    const stagedManifest = window['fs'].writeFileSync.calls.mostRecent().args[1];
    expect(JSON.parse(stagedManifest)).toEqual({ name: 'demo', type: 'coder' });
    expect(JSON.parse(files.get(`${root}/package.json`)!)).toEqual(manifest);
    expect(component.cmdService.runAsync.calls.first().args[0]).toContain('"-x!package.json"');
    expect(window['fs'].rmSync).toHaveBeenCalled();
  });

  it('defaults to the legacy upload and accepts an old response without a receipt or archive hash', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    component.cloudService.syncProject.and.returnValue(of({ status: 200, data: { id: 'legacy-cloud-id' } }));

    await component.syncToCloud();

    expect(component.projectService.save).toHaveBeenCalledOnceWith(root);
    expect(component.cloudService.observeSyncRequest).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith({
      pid: 'existing-id', projectData: { name: 'demo', type: 'coder', entry: 'src/main.cpp', cloudId: 'existing-id' },
      archive: jasmine.stringMatching(/^\/tmp\/aily-cloud-legacy-[a-f0-9-]+\/project\.7z$/), category: 'coder',
    });
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('legacy-cloud-id');
    expect(component.message.success).toHaveBeenCalledWith('同步成功');
  });

  it('uploads a first-time project through the legacy route without creating a receipt binding', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    useBlockly();
    component.cloudService.syncProject.and.returnValue(of({ status: 200, data: { id: 42 } }));

    await component.syncToCloud();

    expect(component.cloudService.observeSyncRequest).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith({
      pid: undefined, projectData: { name: 'demo' },
      archive: jasmine.stringMatching(/^\/tmp\/aily-cloud-legacy-[a-f0-9-]+\/project\.7z$/), category: 'blockly',
    });
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe(42);
    expect(files.has(`${root}/.aily/cloud-sync-state.json`)).toBeFalse();
  });

  it('uses a separate archive and submits directly with an unresolved receipt request present', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    useBlockly();
    const statePath = `${root}/.aily/cloud-sync-state.json`;
    const archivePath = `${root}/project.7z`;
    writeCloudSyncState(root, { version: 1, identity: projectCloudIdentity(root), scope,
      pending: { requestId: '123e4567-e89b-12d3-a456-426614174000', archiveSha256: baseline,
        category: 'blockly', projectData: {}, before: 'original stamp' } });
    files.set(archivePath, 'unconfirmed original');
    const originalState = files.get(statePath);
    component.cloudService.syncProject.and.callFake(request => {
      expect(files.get(request.archive)).toBe('archive');
      expect(files.get(archivePath)).toBe('unconfirmed original');
      return of({ status: 200, data: { id: 42 } });
    });

    await component.syncToCloud();

    expect(component.projectService.save).toHaveBeenCalledOnceWith(root);
    expect(window['fs'].readFileSync).not.toHaveBeenCalledWith(statePath, 'utf8');
    expect(component.cloudService.observeSyncRequest).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith({
      pid: undefined, projectData: { name: 'demo' }, archive: jasmine.stringMatching(/^\/tmp\/aily-cloud-legacy-[a-f0-9-]+\/project\.7z$/),
      category: 'blockly',
    });
    const uploadedArchive = component.cloudService.syncProject.calls.mostRecent().args[0].archive;
    expect(files.has(uploadedArchive)).toBeFalse();
    expect(window['fs'].rmSync).toHaveBeenCalledWith(uploadedArchive.slice(0, -'/project.7z'.length), { recursive: true, force: true });
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe(42);
    expect(files.get(statePath)).toBe(originalState);
    expect(files.get(archivePath)).toBe('unconfirmed original');
  });

  it('uploads persisted Coder code with its category and existing cloud ID', async () => {
    component.projectService.save.and.callFake(async () => {
      files.set(`${root}/sketch/src/main.cpp`, 'newly saved code');
      return { success: true };
    });
    component.cmdService.runAsync.and.callFake(async () => {
      expect(files.get(`${root}/sketch/src/main.cpp`)).toBe('newly saved code');
      files.set(`${root}/project.7z`, 'archive');
      return { type: 'close', code: 0 };
    });
    await component.syncToCloud();
    expect(component.projectService.save).toHaveBeenCalledOnceWith(root);
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      pid: 'existing-id', projectData: { name: 'demo', type: 'coder', entry: 'src/main.cpp', cloudId: 'existing-id' },
      archive: `${root}/project.7z`, category: 'coder', expectedArchiveSha256: baseline, requestId: jasmine.any(String),
    }));
    expect(getStore).not.toHaveBeenCalled();
  });

  it('uploads Blockly with an explicit category', async () => {
    useBlockly();
    await component.syncToCloud();
    expect(component.cloudService.syncProject.calls.first().args[0]).toEqual(jasmine.objectContaining({
      pid: undefined, projectData: { name: 'demo' }, archive: `${root}/project.7z`, category: 'blockly',
    }));
  });

  it('aborts before packing or uploading if saving the editor fails', async () => {
    component.projectService.save.and.resolveTo({ success: false, error: 'save failed' });
    await component.syncToCloud();
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(component.isSyncing).toBeFalse();
  });

  it('syncs an existing Blockly cloud project without a local cloud baseline', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    component.cloudService.syncProject.and.returnValue(of({ status: 200, data: { id: 2057 } }));
    useBlockly();
    files.set(`${root}/package.json`, '{"name":"demo","cloudId":2057}');
    await component.syncToCloud();
    expect(component.projectService.save).toHaveBeenCalledOnceWith(root);
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith({
      pid: 2057, projectData: { name: 'demo', cloudId: 2057 },
      archive: jasmine.stringMatching(/^\/tmp\/aily-cloud-legacy-[a-f0-9-]+\/project\.7z$/), category: 'blockly',
    });
    expect(window['fs'].readFileSync).not.toHaveBeenCalledWith(`${root}/.aily/cloud-sync.json`, 'utf8');
    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('aborts a sign-out while packaging', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    let packed: string;
    spyOn(component, 'packageProject').and.callFake(async (_projectPath, { archivePath }) => {
      packed = archivePath;
      files.set(archivePath, 'archive');
      component.authService.currentUser = null;
      return archivePath;
    });
    await component.syncToCloud();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(packed).toBeDefined();
    expect(files.has(packed)).toBeFalse();
  });

  it('updates the cloud ID after syncing without reading or writing legacy cloud baseline metadata', async () => {
    component.cloudSyncReceiptsEnabled.and.callThrough();
    const legacyBaseline = '{"cloudId":"old-project","accountId":"old-account","archiveSha256":"obsolete"}';
    files.set(`${root}/.aily/cloud-sync.json`, legacyBaseline);
    component.cloudService.syncProject.and.returnValue(of({ status: 200, data: { id: 'updated-id' } }));
    await component.syncToCloud();
    expect(component.message.success).toHaveBeenCalledOnceWith('同步成功');
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('updated-id');
    expect(files.get(`${root}/.aily/cloud-sync.json`)).toBe(legacyBaseline);
    expect(window['fs'].readFileSync).not.toHaveBeenCalledWith(`${root}/.aily/cloud-sync.json`, 'utf8');
    expect(window['fs'].writeFileSync).not.toHaveBeenCalledWith(`${root}/.aily/cloud-sync.json`, jasmine.anything());
    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('does not upload another project metadata when the active project changes while packing', async () => {
    component.cmdService.runAsync.and.callFake(async () => {
      files.set(`${root}/project.7z`, 'archive');
      component.projectService.currentProjectPath = '/aily Projects/other';
      return { type: 'close', code: 0 };
    });
    await component.syncToCloud();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(files.has(`${root}/project.7z`)).toBeFalse();
    expect(component.isSyncing).toBeFalse();
  });

  it('writes the returned cloud ID to the uploaded project even after switching projects', async () => {
    const otherPath = '/aily Projects/other';
    const otherData = { name: 'other', cloudId: 'other-cloud' };
    files.set(`${otherPath}/package.json`, JSON.stringify(otherData));
    component.projectService.currentPackageData = otherData;
    useBlockly();
    component.cloudService.syncProject.and.callFake(request => {
      component.projectService.currentProjectPath = otherPath;
      return from(committed(request));
    });

    await component.syncToCloud();

    expect(JSON.parse(files.get(`${root}/package.json`)!)).toEqual(jasmine.objectContaining({ cloudId: 'created-id' }));
    expect(JSON.parse(files.get(`${otherPath}/package.json`)!)).toEqual(otherData);
    expect(component.projectService.currentPackageData).toBe(otherData);
    expect(files.has(`${root}/.temp/package.json`)).toBeFalse();
  });

  it('does not upload an archive when 7z reports a failure', async () => {
    component.cmdService.runAsync.and.resolveTo({ type: 'close', code: 2 });
    await component.syncToCloud();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(component.isSyncing).toBeFalse();
    expect(component.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/磁盘空间/));
  });

  it('updates only the matching active student original and keeps its cloud ID', async () => {
    component.isTeacher = true;
    await component.syncToCloud({ id: 'existing-id', student: { active: true } });
    expect(component.cloudService.syncProject.calls.first().args[0].pid).toBe('existing-id');
  });

  it('rejects a mismatched student target before saving or uploading', async () => {
    component.isTeacher = true;
    await component.syncToCloud({ id: 'other-student-project', student: { active: true } });
    expect(component.projectService.save).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(component.isSyncing).toBeFalse();
  });

  it('reconciles a lost create response with GET after exactly one POST', async () => {
    useBlockly();
    let receipt: any;
    component.cloudService.syncProject.and.callFake(request => from((async () => {
      receipt = await committed(request);
      throw { status: 0 };
    })()));
    component.cloudService.observeSyncRequest.and.callFake(requestId =>
      of(receipt ?? { status: 200, data: { request_id: requestId, state: 'unconfirmed' } }));
    await component.syncToCloud();
    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(1);
    expect(component.cloudService.observeSyncRequest.calls.allArgs()).toEqual([[receipt.data.request_id], [receipt.data.request_id]]);
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('created-id');
    expect(component.message.success).toHaveBeenCalledWith('同步成功');
  });

  it('dispatches the checked archive bytes even if a local file is replaced during the probe', async () => {
    component.cloudService.observeSyncRequest.and.callFake(requestId => {
      files.set(`${root}/project.7z`, 'unrelated bytes');
      return of({ status: 200, data: { request_id: requestId, state: 'unconfirmed' } });
    });
    await component.syncToCloud();
    const request = component.cloudService.syncProject.calls.first().args[0];
    expect(new TextDecoder().decode(request.archiveContents)).toBe('archive');
    expect(component.message.success).toHaveBeenCalledWith('同步成功');
  });

  it('recovers the original receipt before submitting newer local edits', async () => {
    let receipt: any;
    let online = true;
    component.cloudService.syncProject.and.callFake(request => from((async () => {
      receipt = await committed(request);
      online = false;
      throw { status: 0 };
    })()));
    component.cloudService.observeSyncRequest.and.callFake(requestId => online
      ? of(receipt ?? { status: 200, data: { request_id: requestId, state: 'unconfirmed' } })
      : throwError(() => ({ status: 0 })));
    await component.syncToCloud();
    expect(files.has(`${root}/project.7z`)).toBeTrue();
    files.set(`${root}/sketch/src/main.cpp`, 'newer local code');
    online = true;

    await component.syncToCloud();

    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(1);
    expect(component.projectService.save).toHaveBeenCalledTimes(1);
    expect(component.message.success).not.toHaveBeenCalled();
    expect(component.message.warning).toHaveBeenCalledWith('上次提交已同步，工程还有新的本地修改，尚未同步');
    expect(files.has(`${root}/project.7z`)).toBeFalse();
    expect(files.get(`${root}/sketch/src/main.cpp`)).toBe('newer local code');
    expect(JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!).binding.archiveSha256).toBe(receipt.data.archive_sha256);
  });

  it('keeps the old project binding and local edits if the server rejects a stale version', async () => {
    component.cloudService.syncProject.and.returnValue(throwError(() => ({ error: {
      status: 409, errorCode: 'WORKSPACE_PROJECT_SOURCE_CHANGED',
    } })));
    await component.syncToCloud();
    expect(component.cloudService.syncProject.calls.first().args[0].expectedArchiveSha256).toBe(baseline);
    expect(component.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/云端工程已更新/));
    expect(files.get(`${root}/sketch/src/main.cpp`)).toBe('saved code');
    expect(JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!).binding.archiveSha256).toBe(baseline);
    expect(files.has(`${root}/project.7z`)).toBeFalse();
  });

  const conflictingArchive = 'b'.repeat(64);
  const observedRevision = 'c'.repeat(64);
  const nextRevision = 'd'.repeat(64);
  const conflictResponse = (revision = observedRevision) => ({ status: 409,
    errorCode: 'WORKSPACE_PROJECT_SOURCE_CHANGED',
    data: { project_id: 'existing-id', archive_sha256: conflictingArchive, archive_revision: revision },
  });

  function configureConflictChoices(choices: string[], approvals: boolean[] = []) {
    component.modal = {
      create: jasmine.createSpy('conflict').and.returnValues(...choices.map(choice => ({ afterClose: of(choice) }))),
      confirm: jasmine.createSpy('confirmOverwrite').and.returnValues(...approvals.map(choice => ({ afterClose: of(choice) }))),
    };
  }

  it('requires separate confirmation before sending an overwrite against the displayed revision', async () => {
    configureConflictChoices(['overwrite']);
    const confirmation = new Subject<boolean>();
    let shown: () => void;
    const confirming = new Promise<void>(resolve => { shown = resolve; });
    component.modal.confirm.and.callFake(() => { shown(); return { afterClose: confirmation }; });
    component.cloudService.syncProject.and.callFake(request => request.expectedArchiveRevision
      ? from(committed(request)) : of(conflictResponse()));

    const sync = component.syncToCloud();
    await confirming;
    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(1);
    confirmation.next(true);
    await sync;

    const [original, overwrite] = component.cloudService.syncProject.calls.allArgs().map(([request]) => request);
    expect(overwrite).toEqual(jasmine.objectContaining({
      pid: 'existing-id', expectedArchiveSha256: conflictingArchive, expectedArchiveRevision: observedRevision,
    }));
    expect(overwrite.requestId).not.toBe(original.requestId);
    expect(overwrite.archiveContents).toBe(original.archiveContents);
    expect(component.message.success).toHaveBeenCalledWith('同步成功');
  });

  it('asks again when another same-project revision replaces the displayed version during confirmation', async () => {
    configureConflictChoices(['overwrite', 'overwrite'], [true, true]);
    component.cloudService.syncProject.and.callFake(request => {
      if (!request.expectedArchiveRevision) return of(conflictResponse());
      if (request.expectedArchiveRevision === observedRevision) return of(conflictResponse(nextRevision));
      return from(committed(request));
    });

    await component.syncToCloud();

    const requests = component.cloudService.syncProject.calls.allArgs().map(([request]) => request);
    expect(requests.map(request => request.expectedArchiveRevision)).toEqual([undefined, observedRevision, nextRevision]);
    expect(new Set(requests.map(request => request.requestId)).size).toBe(3);
    expect(component.modal.create.calls.mostRecent().args[0].nzTitle).toBe('云端工程再次更新');
    expect(component.modal.confirm).toHaveBeenCalledTimes(2);
    expect(component.message.success).toHaveBeenCalledOnceWith('同步成功');
  });

  for (const choice of ['cancel', 'overwrite']) {
    it(`leaves the original binding and does not upload again after cancelling ${choice}`, async () => {
      configureConflictChoices([choice], [false]);
      component.cloudService.syncProject.and.returnValue(of(conflictResponse()));

      await component.syncToCloud();

      expect(component.cloudService.syncProject).toHaveBeenCalledTimes(1);
      expect(component.modal.confirm).toHaveBeenCalledTimes(choice === 'overwrite' ? 1 : 0);
      expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('existing-id');
      expect(JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!).pending).toBeUndefined();
      expect(files.has(`${root}/project.7z`)).toBeFalse();
    });
  }

  it('creates a cloud project from a detached archive and binds it after the matching receipt', async () => {
    configureConflictChoices(['save-new']);
    component.cloudService.syncProject.and.callFake(request => request.pid
      ? of(conflictResponse()) : from(committed(request)));

    await component.syncToCloud();

    const [original, copy] = component.cloudService.syncProject.calls.allArgs().map(([request]) => request);
    expect(copy).toEqual(jasmine.objectContaining({
      pid: undefined, expectedArchiveSha256: undefined, expectedArchiveRevision: undefined,
    }));
    expect(copy.projectData.cloudId).toBeUndefined();
    expect(copy.requestId).not.toBe(original.requestId);
    const [, stagedManifest] = window['fs'].writeFileSync.calls.allArgs()
      .find(([path]) => path.startsWith('/tmp/aily-cloud-package-') && path.endsWith('/package.json'));
    expect(JSON.parse(stagedManifest).cloudId).toBeUndefined();
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('created-id');
    expect(JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!).binding.cloudId).toBe('created-id');
    expect(component.message.success).toHaveBeenCalledOnceWith('已另存为新云工程');
    expect(component.modal.confirm).not.toHaveBeenCalled();
  });

  it('keeps the existing cloud association and local files when the new cloud project exceeds the quota', async () => {
    configureConflictChoices(['save-new']);
    component.cloudService.syncProject.and.callFake(request => request.pid ? of(conflictResponse()) : of({
      status: 403, errorCode: 'WORKSPACE_STORAGE_PROJECT_LIMIT_REACHED', data: { used: 12, limit: 12 },
    }));

    await component.syncToCloud();

    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(2);
    expect(component.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/云空间项目已达上限.*12\/12/));
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('existing-id');
    const state = JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!);
    expect(state.binding.archiveSha256).toBe(baseline);
    expect(state.pending).toBeUndefined();
    expect(files.get(`${root}/sketch/src/main.cpp`)).toBe('saved code');
  });

  it('recovers the original new-cloud-project receipt after a lost response without creating another copy', async () => {
    configureConflictChoices(['save-new']);
    let receipt: any;
    let online = true;
    component.cloudService.syncProject.and.callFake(request => request.pid ? of(conflictResponse()) : from((async () => {
      receipt = await committed(request);
      online = false;
      throw { status: 0 };
    })()));
    component.cloudService.observeSyncRequest.and.callFake(requestId => online
      ? of(receipt ?? { status: 200, data: { request_id: requestId, state: 'unconfirmed' } })
      : throwError(() => ({ status: 0 })));

    await component.syncToCloud();
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('existing-id');
    expect(JSON.parse(files.get(`${root}/.aily/cloud-sync-state.json`)!).pending.resolution.kind).toBe('save-new');
    online = true;
    await component.syncToCloud();

    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(2);
    expect(JSON.parse(files.get(`${root}/package.json`)!).cloudId).toBe('created-id');
    expect(component.message.success).toHaveBeenCalledOnceWith('已另存为新云工程');
  });

  it('does not submit an overwrite if the local project changed while the dialog was open', async () => {
    configureConflictChoices(['overwrite']);
    component.modal.confirm.and.callFake(() => {
      files.set(`${root}/sketch/src/main.cpp`, 'edited while confirming');
      return { afterClose: of(true) };
    });
    component.cloudService.syncProject.and.returnValue(of(conflictResponse()));

    await component.syncToCloud();

    expect(component.cloudService.syncProject).toHaveBeenCalledTimes(1);
    expect(component.message.error).toHaveBeenCalledWith(jasmine.stringMatching(/本地工程在确认期间已修改/));
  });

});

describe('CloudSpace education access', () => {
  let component: CloudSpaceComponent;
  let cloud: any;
  let user: BehaviorSubject<any>;
  let project: any;
  let modal: any;

  beforeEach(() => {
    cloud = {
      getProjects: jasmine.createSpy('mine').and.returnValue(of({ status: 200, data: { list: [], total: 0 } })),
      getStudentProjects: jasmine.createSpy('students').and.returnValue(of({ status: 200, data: { list: [], total: 0 } })),
      getProject: jasmine.createSpy('details').and.returnValue(NEVER),
      getProjectImage: jasmine.createSpy('image'),
      publishProject: jasmine.createSpy('publish'),
      unpublishProject: jasmine.createSpy('unpublish'),
      deleteProject: jasmine.createSpy('delete'),
    };
    user = new BehaviorSubject({ id: 'teacher', education_teacher: true });
    project = { currentProjectPath$: new BehaviorSubject('/project'), currentProjectPath: '/project', currentPackageData: { cloudId: 'student-project' } };
    modal = { confirm: jasmine.createSpy('confirm') };
    component = new CloudSpaceComponent({} as any, cloud, project, {} as any,
      { error: jasmine.createSpy('error'), info: jasmine.createSpy('info') } as any, { userInfo$: user } as any, modal,
      { readFile: () => JSON.stringify(project.currentPackageData) } as any,
      {} as any, {} as any, { instant: () => '发布状态更新失败' } as any, { getDefaultProjectImageSrc: () => '/default.png' } as any, {} as any);
  });

  afterEach(() => component.ngOnDestroy());

  it('allows students to edit their own projects while refusing publish even by direct handler invocation', () => {
    component.isStudent = true;
    const ownProject = { id: 'own' };
    expect(component.canEditProject(ownProject)).toBeTrue();
    expect(component.canPublishProject(ownProject)).toBeFalse();
    component.toggleVisibility(ownProject);
    expect(cloud.publishProject).not.toHaveBeenCalled();
  });

  it('restricts inactive student projects to read operations', () => {
    component.isTeacher = true;
    const active = { id: 'student-project', student: { active: true } };
    const inactive = { ...active, student: { active: false } };
    expect(component.canEditProject(active)).toBeTrue();
    expect(component.canPublishProject(active)).toBeTrue();
    expect(component.canEditProject(inactive)).toBeFalse();
    expect(component.canPublishProject(inactive)).toBeFalse();
    component.openEditor(inactive);
    component.deleteCloudProject(inactive);
    expect(cloud.getProject).not.toHaveBeenCalled();
    expect(modal.confirm).not.toHaveBeenCalled();
  });

  it('refreshes student permissions before confirming an update to the original', async () => {
    component.isTeacher = true;
    const target = { id: 'student-project', nickname: '作品', student: { nickname: '学生', active: true } };
    cloud.getProject.and.returnValue(of({ status: 200, data: target }));
    const sync = spyOn(component, 'syncToCloud').and.resolveTo();
    await component.requestSync();
    expect(cloud.getProject).toHaveBeenCalledOnceWith('student-project');
    expect(sync).not.toHaveBeenCalled();
    await modal.confirm.calls.mostRecent().args[0].nzOnOk();
    expect(sync).toHaveBeenCalledOnceWith(target);
    modal.confirm.calls.reset();
    cloud.getProject.and.returnValue(of({ status: 200, data: { ...target, student: { active: false } } }));
    await component.requestSync();
    expect(modal.confirm).not.toHaveBeenCalled();
  });

  it('keeps the published state when unpublishing is rejected after student permissions change', () => {
    component.isTeacher = true;
    const item = { id: 'student-project', is_published: true, student: { active: true } };
    cloud.unpublishProject.and.returnValue(of({ status: 403, messages: '该学生已停用' }));
    component.toggleVisibility(item);
    expect(cloud.unpublishProject).toHaveBeenCalledOnceWith(item.id);
    expect(item.is_published).toBeTrue();
  });

  it('does not sync a different local project after a pending teacher permission check returns', async () => {
    component.isTeacher = true;
    const pending = new Subject<any>();
    cloud.getProject.and.returnValue(pending);
    const sync = spyOn(component, 'syncToCloud').and.resolveTo();
    const request = component.requestSync();
    project.currentProjectPath = '/another-project';
    project.currentPackageData = { cloudId: 'another-student-project' };
    pending.next({ status: 200, data: { id: 'student-project' } });
    await request;
    expect(sync).not.toHaveBeenCalled();
    expect(modal.confirm).not.toHaveBeenCalled();
    expect((component as any).message.error).toHaveBeenCalledWith(jasmine.stringMatching('当前项目已切换'));
  });

  it('allows students to make their own teacher-published project private', () => {
    component.isStudent = true;
    const item = { id: 'own-project', is_published: true };
    cloud.unpublishProject.and.returnValue(of({ status: 200 }));
    component.toggleVisibility(item);
    expect(cloud.unpublishProject).toHaveBeenCalledOnceWith(item.id);
    expect(item.is_published).toBeFalse();
  });

  it('loads student pages, releases private cover URLs, and cancels stale list responses after sign-out', () => {
    const images = new Subject<Blob>();
    cloud.getProjectImage.and.returnValue(images);
    cloud.getStudentProjects.and.returnValue(of({ status: 200, data: { list: [{ id: 'student-project', image_url: '/files/cover.webp' }], total: 1 } }));
    const createUrl = spyOn(URL, 'createObjectURL').and.returnValue('blob:private-cover');
    const revokeUrl = spyOn(URL, 'revokeObjectURL');
    component.ngOnInit();
    component.switchProjectView('students');
    expect(cloud.getStudentProjects).toHaveBeenCalledOnceWith(1, 100);
    images.next(new Blob(['image']));
    expect(component.itemList[0].image_url).toBe('blob:private-cover');
    const pending = new Subject<any>();
    cloud.getStudentProjects.and.returnValue(pending);
    component.changePage(2);
    expect(revokeUrl).toHaveBeenCalledOnceWith('blob:private-cover');
    user.next(null);
    pending.next({ status: 200, data: { list: [{ id: 'stale-private-project' }], total: 1 } });
    images.next(new Blob(['late-image']));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(component.itemList).toEqual([]);
    expect(component.projectView).toBe('mine');
    expect(component.isTeacher).toBeFalse();
  });

  it('allows teachers to fork public or deleted source IDs when private details return 404', async () => {
    component.isTeacher = true;
    const sync = spyOn(component, 'syncToCloud').and.resolveTo();
    cloud.getProject.and.returnValue(of({ status: 404 }));
    await component.requestSync();
    expect(sync).toHaveBeenCalledOnceWith();
    expect(modal.confirm).not.toHaveBeenCalled();
    sync.calls.reset();
    cloud.getProject.and.returnValue(of({ status: 503 }));
    await component.requestSync();
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns to an existing page when deleting the final project on the last page', () => {
    component.projectView = 'students';
    cloud.getStudentProjects.and.callFake((page: number) => of({
      status: 200, data: { list: page === 1 ? [{ id: 'remaining-project' }] : [], total: 100 },
    }));
    component.changePage(2);
    expect(component.currentPage).toBe(1);
    expect(cloud.getStudentProjects.calls.allArgs()).toEqual([[2, 100], [1, 100]]);
    expect(component.itemList.map(item => item.id)).toEqual(['remaining-project']);
  });

  it('refuses to open the editor for a student disabled since the list was loaded', () => {
    component.isTeacher = true;
    cloud.getProject.and.returnValue(of({ status: 200, data: { id: 'student-project', student: { active: false } } }));
    component.openEditor({ id: 'student-project', image_url: 'blob:cover', student: { active: true } });
    expect(component.showEditor).toBeFalse();
    expect(component.editorProjectData).toBeNull();
    expect((component as any).message.error).toHaveBeenCalledWith('该学生已停用，项目仅可查看和打开');
  });
});
