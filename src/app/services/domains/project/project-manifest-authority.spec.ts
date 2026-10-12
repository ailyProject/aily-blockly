import { ProjectService } from './project.service';

describe('ProjectService canonical manifest mirror', () => {
  const root = '/project';
  const manifestPath = `${root}/package.json`;
  const mirrorPath = `${root}/.temp/package.json`;
  const current = JSON.stringify({
    name: 'project',
    dependencies: {
      '@aily-project/board-stm32f407g-discovery': '3.0.0',
      '@aily-project/lib-core-custom': '1.1.0',
    },
    projectConfig: { pnum: 'DISCO_F407VG' },
    MACROS: [['USER_OPTION', '1']],
  }, null, 2);
  let files: Map<string, string>;
  let directories: Set<string>;
  let previous: { fs: any; path: any };
  let service: any;
  let fs: any;

  beforeEach(() => {
    previous = { fs: window['fs'], path: window['path'] };
    files = new Map([[manifestPath, current]]);
    directories = new Set([root]);
    fs = {
      existsSync: (path: string) => files.has(path) || directories.has(path),
      readFileSync: jasmine.createSpy('read').and.callFake((path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path);
      }),
      writeFileSync: jasmine.createSpy('write').and.callFake((path: string, content: string) => files.set(path, content)),
      mkdirSync: jasmine.createSpy('mkdir').and.callFake((path: string) => directories.add(path)),
    };
    window['fs'] = fs;
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    service = Object.create(ProjectService.prototype);
    service.isAilyCodeProject = jasmine.createSpy('coder').and.returnValue(false);
  });

  afterEach(() => {
    window['fs'] = previous.fs;
    window['path'] = previous.path;
  });

  it('refreshes a stale mirror without rolling back dependencies, board configuration or macros', async () => {
    files.set(mirrorPath, JSON.stringify({ name: 'old', dependencies: {}, projectConfig: { pnum: 'old' } }));
    await service.syncPackageJsonWithTemp(root);
    expect(files.get(manifestPath)).toBe(current);
    expect(files.get(mirrorPath)).toBe(current);
    expect(fs.readFileSync).toHaveBeenCalledOnceWith(manifestPath, 'utf8');
    expect(fs.writeFileSync).toHaveBeenCalledOnceWith(mirrorPath, current);
  });

  it('preserves a normal npm declaration added between two project opens', async () => {
    await service.syncPackageJsonWithTemp(root);
    const installed = JSON.parse(current);
    installed.dependencies['@aily-project/lib-user'] = '2.0.0';
    const installedText = JSON.stringify(installed, null, 2);
    files.set(manifestPath, installedText);
    await service.syncPackageJsonWithTemp(root);
    expect(files.get(manifestPath)).toBe(installedText);
    expect(files.get(mirrorPath)).toBe(installedText);
    expect(fs.writeFileSync.calls.allArgs().every(args => args[0] === mirrorPath)).toBeTrue();
  });

  it('creates a missing mirror from the actual root bytes', async () => {
    await service.syncPackageJsonWithTemp(root);
    expect(fs.mkdirSync).toHaveBeenCalledOnceWith(`${root}/.temp`, { recursive: true });
    expect(files.get(manifestPath)).toBe(current);
    expect(files.get(mirrorPath)).toBe(current);
  });

  it('never parses or restores a damaged mirror', async () => {
    files.set(mirrorPath, '{ invalid old cache');
    await service.syncPackageJsonWithTemp(root);
    expect(files.get(manifestPath)).toBe(current);
    expect(files.get(mirrorPath)).toBe(current);
    expect(fs.readFileSync).toHaveBeenCalledOnceWith(manifestPath, 'utf8');
  });

  it('does not resurrect a missing root manifest from its mirror', async () => {
    files.delete(manifestPath);
    files.set(mirrorPath, current);
    await service.syncPackageJsonWithTemp(root);
    expect(files.has(manifestPath)).toBeFalse();
    expect(files.get(mirrorPath)).toBe(current);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('leaves Coder projects and their absent temp directory untouched', async () => {
    service.isAilyCodeProject.and.returnValue(true);
    await service.syncPackageJsonWithTemp(root);
    expect(service.isAilyCodeProject).toHaveBeenCalledOnceWith(root);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('retains root bytes when refreshing the mirror fails', async () => {
    spyOn(console, 'warn');
    fs.writeFileSync.and.throwError('cache is read-only');
    await service.syncPackageJsonWithTemp(root);
    expect(files.get(manifestPath)).toBe(current);
    expect(files.has(mirrorPath)).toBeFalse();
    expect(console.warn).toHaveBeenCalled();
  });

  it('mirrors an explicitly restored root rather than undoing that restore', async () => {
    files.set(mirrorPath, current);
    const restored = JSON.stringify({ name: 'restored', dependencies: {} });
    files.set(manifestPath, restored);
    await service.syncPackageJsonWithTemp(root);
    expect(files.get(manifestPath)).toBe(restored);
    expect(files.get(mirrorPath)).toBe(restored);
    expect(fs.writeFileSync).toHaveBeenCalledOnceWith(mirrorPath, restored);
  });
});
