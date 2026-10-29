import { preserveLegacyCloudProjectMap } from './legacy-cloud-project';

describe('fresh cloud archive legacy map compatibility', () => {
  const root = '/cloud-extracted';
  const rawMap = '{"generation":"old-local-generation"}\r\n';
  let files: Map<string, string>, directories: Set<string>, links: Set<string>, io: any;
  const paths = { join: (...parts: string[]) => parts.join('/') };
  const run = () => preserveLegacyCloudProjectMap(root, io, paths);

  beforeEach(() => {
    files = new Map([[`${root}/package.json`, '{"name":"old-cloud-project"}'],
      [`${root}/project.abi`, '{"blocks":{"blocks":[]}}'], [`${root}/project.abs.map.json`, rawMap],
      [`${root}/assets/project-data/data.bin`, 'resource'], [`${root}/local-libraries/lib-driver/driver.cpp`, 'source']]);
    directories = new Set([root]); links = new Set();
    io = {
      existsSync: path => files.has(path) || directories.has(path) || links.has(path),
      lstatSync: path => ({ _isFile: files.has(path), _isDirectory: directories.has(path), _isSymbolicLink: links.has(path) }),
      readFileSync: path => files.get(path),
      readDirSync: path => [...new Set([...directories, ...files.keys()].filter(name => name.startsWith(path + '/'))
        .map(name => name.slice(path.length + 1).split('/')[0]))].map(name => ({ name, _isDirectory: directories.has(path + '/' + name) })),
      mkdirSync: jasmine.createSpy('mkdir').and.callFake(path => directories.add(path)),
      renameSync: jasmine.createSpy('rename').and.callFake((source, target) => {
        if (files.has(target)) throw new Error('backup collision');
        files.set(target, files.get(source)!); files.delete(source);
      }),
    };
  });

  it('preserves exact orphan map bytes and leaves ABI, resources and local sources untouched', () => {
    const before = new Map(files), backup = run()!;
    expect(backup).toMatch(/\/\.cloud-import-backup\/project\.abs\.map\..+\.json$/);
    expect(files.get(backup)).toBe(rawMap);
    expect(files.has(`${root}/project.abs.map.json`)).toBeFalse();
    for (const [name, content] of before) if (!name.endsWith('project.abs.map.json')) expect(files.get(name)).toBe(content);
    expect(run()).toBeUndefined(); expect(io.renameSync).toHaveBeenCalledTimes(1);
  });

  it('recognizes complete multipage ABI without changing pages or shared models', () => {
    const abi = JSON.stringify({ schemaVersion: 3, activePageId: 'main', pages: [
      { id: 'main', content: { blocks: { blocks: [] } } }, { id: 'other', content: { blocks: { blocks: [] } } }],
      sharedModel: { variables: [{ id: 'v', name: 'count' }], procedureBlocks: [] } });
    files.set(`${root}/project.abi`, abi);
    expect(run()).toBeDefined(); expect(files.get(`${root}/project.abi`)).toBe(abi);
  });

  for (const extra of ['project.abs', '.aily/abs-sync/prepared.json', '.aily/abs-sync/committed.json'])
    it(`retains ABS/draft/transaction protection when ${extra} is present`, () => {
      files.set(`${root}/${extra}`, 'retained');
      if (extra.includes('/')) directories.add(`${root}/.aily/abs-sync`);
      const before = [...files]; expect(run()).toBeUndefined(); expect([...files]).toEqual(before);
      expect(io.renameSync).not.toHaveBeenCalled();
    });

  it('does not change a Coder project with leftover ABI and map', () => {
    files.set(`${root}/package.json`, '{"name":"coder","type":"coder"}');
    expect(run()).toBeUndefined(); expect(files.get(`${root}/project.abs.map.json`)).toBe(rawMap);
  });

  for (const abi of ['not json', 'null', '[]', '{}', '{"blocks":[]}', '{"pages":[]}'])
    it(`does not authorize initialization from unrecognized ABI: ${abi}`, () => {
      files.set(`${root}/project.abi`, abi);
      expect(run()).toBeUndefined(); expect(io.renameSync).not.toHaveBeenCalled();
    });

  for (const missing of ['project.abi', 'project.abs.map.json']) it(`leaves an archive without ${missing} unchanged`, () => {
    files.delete(`${root}/${missing}`); const before = [...files];
    expect(run()).toBeUndefined(); expect([...files]).toEqual(before); expect(io.mkdirSync).not.toHaveBeenCalled();
  });

  for (const link of ['package.json', 'project.abi', 'project.abs.map.json', '.cloud-import-backup'])
    it(`does not follow ${link} through a symbolic link`, () => {
      links.add(`${root}/${link}`);
      expect(run()).toBeUndefined(); expect(io.renameSync).not.toHaveBeenCalled();
    });

  it('preserves existing backups and refuses to change the active map when backup publication fails', () => {
    directories.add(`${root}/.cloud-import-backup`);
    files.set(`${root}/.cloud-import-backup/previous.json`, 'previous');
    io.renameSync.and.throwError('disk full'); const before = [...files];
    expect(run).toThrowError('disk full'); expect([...files]).toEqual(before);
  });

  it('handles the same single-wrapper layout accepted by cloud example import', () => {
    files = new Map([...files].map(([name, content]) => [name.replace(root + '/', root + '/wrapped/'), content]));
    directories.add(`${root}/wrapped`);
    expect(run()).toContain(`${root}/wrapped/.cloud-import-backup/`);
  });
});
