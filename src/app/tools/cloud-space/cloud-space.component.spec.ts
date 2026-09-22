import { NEVER } from 'rxjs';
import { AILY_LOCAL_LIBRARY_SOURCES_KEY } from '@domain/dependencies/public-api';
import { detectProjectMode, projectDataRuntime } from '@domain/project/public-api';
import { CloudSpaceComponent } from './cloud-space.component';

describe('CloudSpace project packaging and sync mode isolation', () => {
  const root = '/Aily Projects/demo';
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
    window['fs'] = {
      existsSync: (path: string) => files.has(path) || directories.has(path),
      readFileSync: jasmine.createSpy('read').and.callFake((path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      }),
      writeFileSync: jasmine.createSpy('write').and.callFake((path: string, content: string) => files.set(path, content)),
      mkdirSync: (path: string) => directories.add(path),
      rmSync: jasmine.createSpy('rm'),
      unlinkSync: (path: string) => files.delete(path),
      statSync: (path: string) => ({ size: files.get(path)?.length || 0 }),
    };
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['os'] = { tmpdir: () => '/tmp' };
    component = Object.create(CloudSpaceComponent.prototype);
    component.message = { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') };
    component.electronService = { readFile: (path: string) => window['fs'].readFileSync(path, 'utf8') };
    component.platformService = { za7: '7zz' };
    component.cmdService = {
      runAsync: jasmine.createSpy('pack').and.callFake(async () => {
        files.set(`${root}/project.7z`, 'archive');
        return { type: 'close', code: 0 };
      }),
    };
    component.projectService = {
      currentProjectPath: root,
      save: jasmine.createSpy('save').and.resolveTo({ success: true }),
      getPackageJson: async () => JSON.parse(files.get(`${root}/package.json`)!),
      getProjectMode: () => detectProjectMode({
        manifest: JSON.parse(files.get(`${root}/package.json`)!),
        hasAbi: files.has(`${root}/project.abi`), hasAci: files.has(`${root}/project.aci`),
      }),
    };
    component.cloudService = { syncProject: jasmine.createSpy('sync').and.returnValue(NEVER) };
    flush = spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    validate = jasmine.createSpy('validate').and.resolveTo({ valid: true });
    getStore = spyOn(projectDataRuntime, 'getStore').and.returnValue({
      collectReferences: (value: unknown) => [value], validateReferences: validate,
    } as any);
  });

  afterEach(() => Object.assign(window, previousApis));

  function useBlockly() {
    files.set(`${root}/package.json`, '{"name":"demo"}');
    files.set(`${root}/project.abi`, '{"blocks":{}}');
  }

  it('packages Coder without ABI or touching the Blockly data runtime', async () => {
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(flush).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
    expect(window['fs'].readFileSync).not.toHaveBeenCalledWith(`${root}/project.abi`, 'utf8');
    expect(component.message.error).not.toHaveBeenCalled();
    const command = component.cmdService.runAsync.calls.first().args[0];
    expect(command).not.toContain('"-xr!.*"');
    expect(command).toContain('"-x!sketch/preprocess.json"');
    expect(command).toContain('"-x!sketch/library-cache.json"');
    expect(command).toContain('"-xr!.build"');
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

  it('rejects a Coder project with no source workspace before packing', async () => {
    directories.delete(`${root}/sketch`);
    expect(await component.packageProject(root)).toBeUndefined();
    expect(component.message.error).toHaveBeenCalledWith('Coder 项目源码不存在，无法打包');
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
  });

  it('retains Blockly ABI/ABS resource validation and the original archive command', async () => {
    useBlockly();
    files.set(`${root}/project.abs`, 'field: "@json:{\\"resource\\":1}"');
    expect(await component.packageProject(root)).toBe(`${root}/project.7z`);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledOnceWith([{ blocks: {} }, { resource: 1 }]);
    expect(component.cmdService.runAsync).toHaveBeenCalledOnceWith(
      `7zz a -t7z -mx=9 "${root}/project.7z" * "-x!node_modules" "-xr!.*" "-x!package-lock.json" "-x!project.7z" "-x!project.abi.backup" "-x!project.abs"`,
      root, false,
    );
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
    expect(component.cloudService.syncProject).toHaveBeenCalledOnceWith({
      pid: 'existing-id', projectData: { name: 'demo', type: 'coder', entry: 'src/main.cpp', cloudId: 'existing-id' },
      archive: `${root}/project.7z`, category: 'coder',
    });
    expect(getStore).not.toHaveBeenCalled();
  });

  it('uploads Blockly with an explicit category', async () => {
    useBlockly();
    await component.syncToCloud();
    expect(component.cloudService.syncProject.calls.first().args[0]).toEqual({
      pid: undefined, projectData: { name: 'demo' }, archive: `${root}/project.7z`, category: 'blockly',
    });
  });

  it('aborts before packing or uploading if saving the editor fails', async () => {
    component.projectService.save.and.resolveTo({ success: false, error: 'save failed' });
    await component.syncToCloud();
    expect(component.cmdService.runAsync).not.toHaveBeenCalled();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(component.isSyncing).toBeFalse();
  });

  it('does not upload another project metadata when the active project changes while packing', async () => {
    component.cmdService.runAsync.and.callFake(async () => {
      files.set(`${root}/project.7z`, 'archive');
      component.projectService.currentProjectPath = '/Aily Projects/other';
      return { type: 'close', code: 0 };
    });
    await component.syncToCloud();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(files.has(`${root}/project.7z`)).toBeFalse();
    expect(component.isSyncing).toBeFalse();
  });

  it('writes the returned cloud ID to the uploaded project even after switching projects', async () => {
    const otherPath = '/Aily Projects/other';
    const otherData = { name: 'other', cloudId: 'other-cloud' };
    files.set(`${otherPath}/package.json`, JSON.stringify(otherData));
    component.projectService.currentProjectPath = otherPath;
    component.projectService.currentPackageData = otherData;
    component.projectService.copyPackageJsonToTemp = jasmine.createSpy('copy');

    await component.setCurrentProjectCloudId('uploaded-cloud', root);

    expect(JSON.parse(files.get(`${root}/package.json`)!)).toEqual(jasmine.objectContaining({ cloudId: 'uploaded-cloud' }));
    expect(JSON.parse(files.get(`${otherPath}/package.json`)!)).toEqual(otherData);
    expect(component.projectService.currentPackageData).toBe(otherData);
    expect(component.projectService.copyPackageJsonToTemp).toHaveBeenCalledOnceWith(root);
  });

  it('does not upload an archive when 7z reports a failure', async () => {
    component.cmdService.runAsync.and.resolveTo({ type: 'close', code: 2, data: 'disk full' });
    await component.syncToCloud();
    expect(component.cloudService.syncProject).not.toHaveBeenCalled();
    expect(component.isSyncing).toBeFalse();
  });
});
