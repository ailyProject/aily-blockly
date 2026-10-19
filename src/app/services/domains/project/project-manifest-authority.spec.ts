import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from './project.service';

describe('ProjectService root manifest authority', () => {
  const root = '/project';
  const manifestPath = `${root}/package.json`;
  const legacyPath = `${root}/.temp/package.json`;
  const current = { name: 'project', dependencies: { '@aily-project/lib-custom': '1.1.0' }, projectConfig: { pnum: 'DISCO_F407VG' } };
  let files: Map<string, string>;
  let previous: any;
  let service: any;
  let fs: any;

  beforeEach(() => {
    previous = { fs: window['fs'], path: window['path'], libraryDependencies: window['libraryDependencies'], packageJson: window['packageJson'] };
    files = new Map([[manifestPath, JSON.stringify(current)]]);
    fs = {
      existsSync: (path: string) => files.has(path),
      readFileSync: jasmine.createSpy('read').and.callFake((path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      }),
      writeFileSync: jasmine.createSpy('write').and.callFake((path: string, content: string) => files.set(path, content)),
    };
    Object.assign(window, { fs, path: { join: (...parts: string[]) => parts.join('/') }, libraryDependencies: undefined });
    service = Object.create(ProjectService.prototype);
    service.currentProjectPathSubject = new BehaviorSubject(root);
    service.libraryChanges = new Map();
    service.coderProjectContexts = new Map();
  });

  afterEach(() => Object.assign(window, previous));

  for (const legacy of [undefined, '{ invalid old backup']) {
    it(`reads and updates only the root manifest with ${legacy ? 'a damaged' : 'no'} legacy backup`, async () => {
      if (legacy) files.set(legacyPath, legacy);
      expect(await service.getPackageJson()).toEqual(current);
      const next = { ...current, nickname: 'Renamed' };
      await service.setPackageJson(next);
      expect(JSON.parse(files.get(manifestPath)!)).toEqual(next);
      expect(files.get(legacyPath)).toBe(legacy);
      expect(fs.readFileSync.calls.allArgs().every(args => args[0] === manifestPath)).toBeTrue();
      expect(fs.writeFileSync).toHaveBeenCalledOnceWith(manifestPath, JSON.stringify(next, null, 2));
    });
  }

  it('does not resurrect a missing root manifest from a legacy backup', async () => {
    files.delete(manifestPath);
    files.set(legacyPath, JSON.stringify(current));
    await expectAsync(service.getPackageJson()).toBeRejectedWithError(`ENOENT: ${manifestPath}`);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('publishes acknowledged library dirtiness and serves title reads without IPC/filesystem work', async () => {
    service.libraryChangesChanged = new Subject();
    const changed = jasmine.createSpy('changed'); service.libraryChangesChanged.subscribe(changed);
    const status = jasmine.createSpy('status').and.resolveTo({dirty:true,manifest:current});
    window['libraryDependencies'] = {status};
    await service.getPackageJson();
    for(let i=0;i<10;i++) expect(service.hasCachedLibraryChanges(root)).toBeTrue();
    expect(status).toHaveBeenCalledTimes(1); expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    status.and.resolveTo({dirty:false,manifest:current}); await service.getPackageJson();
    expect(service.hasCachedLibraryChanges(root)).toBeFalse(); expect(changed).toHaveBeenCalledTimes(2);
  });

  it('discards the pending view using the manifest restored by Chat, leaving the old backup untouched', async () => {
    files.set(legacyPath, JSON.stringify(current));
    const restored = { name: 'restored', dependencies: {} };
    files.set(manifestPath, JSON.stringify(restored));
    service.libraryChanges.set(root, current);
    const discard = jasmine.createSpy('discard').and.resolveTo({ dirty: false, manifest: restored });
    window['libraryDependencies'] = { discard };
    await service.discardLibraryChanges(root, true);
    expect(discard).toHaveBeenCalledOnceWith(root, { reconcile: true, historyRestored: false });
    expect(service.currentPackageData).toEqual(restored);
    expect(JSON.parse(service.getEffectivePackageText(root))).toEqual(restored);
    expect(files.get(legacyPath)).toBe(JSON.stringify(current));
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
