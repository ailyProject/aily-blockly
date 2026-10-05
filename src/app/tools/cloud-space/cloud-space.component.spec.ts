import { BehaviorSubject, NEVER, of, Subject } from 'rxjs';
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
    expect(command).toContain('"-x!sketch/target-compile.json"');
    expect(command).toContain('"-x!sketch/compile-preprocess-*.json"');
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
      {} as any, {} as any, { instant: () => '发布状态更新失败' } as any, { getDefaultProjectImageSrc: () => '/default.png' } as any);
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
