import { allocatePartitions, createPreset, MIB, serializePartitions } from './partition-layout';
import { handlePartitionManagerRequest, resolvePartitionPaths, writePartitionTransaction } from './partition-manager-host';

describe('Partition manager project persistence', () => {
  let original: any;
  let files: Map<string, string>;
  let fs: any;
  let paths: any;
  let project: any;
  let builder: any;
  let failRename: ((from: string, to: string) => boolean) | null;
  const pkgPath = '/project/package.json';
  const csvPath = '/project/src/partitions.csv';
  const csv = () => serializePartitions(allocatePartitions(createPreset('iot', 8 * MIB)).rows);

  beforeEach(() => {
    original = { fs: window['fs'], path: window['path'] };
    const normalize = (s: string) => {
      const parts: string[] = [];
      for (const p of s.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
      return '/' + parts.join('/');
    };
    paths = { join: (...s: string[]) => normalize(s.join('/')), resolve: normalize,
      dirname: (s: string) => s.slice(0, s.lastIndexOf('/')), basename: (s: string) => s.split('/').pop(),
      relative: (a: string, b: string) => b.startsWith(a + '/') ? b.slice(a.length + 1) : '../outside', isAbsolute: (s: string) => s.startsWith('/') };
    const pkg = { name: 'project', projectConfig: { FlashSize: '8M', PartitionScheme: 'default' }, unrelated: 'keep' };
    files = new Map([[pkgPath, JSON.stringify(pkg)], [csvPath, csv()], ['/project/.temp/package.json', JSON.stringify(pkg)]]);
    failRename = null;
    fs = { existsSync: (p: string) => files.has(p), readFileSync: (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p); },
      mkdirSync: () => {}, writeFileSync: (p: string, text: string) => files.set(p, text),
      unlinkSync: (p: string) => files.delete(p), renameSync: (a: string, b: string) => {
        if (failRename?.(a, b)) throw new Error('write failed');
        if (!files.has(a)) throw new Error('missing source');
        files.set(b, files.get(a)!); files.delete(a);
      } };
    Object.assign(window, { fs, path: paths });
    project = {
      currentProjectPath: '/project', currentBoardConfig: { core: 'esp32', type: 'esp32:esp32:esp32s3' }, currentPackageData: pkg,
      isAilyCodeProject: () => false, getSdkPath: async () => '', getBoardFile: async () => null,
      getPackageJson: async () => JSON.parse(files.get(pkgPath)!),
      getBoardConfigMenu: async () => [
        { key: 'PartitionScheme', children: [{ key: 'PartitionScheme', data: 'custom' }] },
        { key: 'FlashSize', children: [{ key: 'FlashSize', data: '8M' }, { key: 'FlashSize', data: '4M' }] },
      ],
    };
    builder = { triggerPreprocess: jasmine.createSpy('preprocess') };
  });
  afterEach(() => Object.assign(window, original));
  const load = () => handlePartitionManagerRequest(project, builder, { action: 'partition-manager-load', projectPath: '/project' });
  const save = (token: string, extra = {}) => handlePartitionManagerRequest(project, builder, { action: 'partition-manager-save', token, csv: csv(), flashBytes: 8 * MIB, ...extra });

  it('loads without selecting custom, writing files, or triggering a build', async () => {
    const before = [...files]; const result = await load();
    expect(result.success).toBeTrue(); expect(result.context.csv).toBe(csv());
    expect([...files]).toEqual(before); expect(builder.triggerPreprocess).not.toHaveBeenCalled();
    expect(result.context['projectConfig']).toBeUndefined();
  });

  it('commits CSV, project config, and Blockly temp config together, merging unrelated edits', async () => {
    const loaded = await load();
    const latest = JSON.parse(files.get(pkgPath)!); latest.nickname = 'Renamed'; files.set(pkgPath, JSON.stringify(latest));
    const result = await save(loaded.context.token);
    expect(result.success).toBeTrue();
    const stored = JSON.parse(files.get(pkgPath)!);
    expect(stored.projectConfig.PartitionScheme).toBe('custom'); expect(stored.nickname).toBe('Renamed');
    expect(files.get('/project/.temp/package.json')).toBe(files.get(pkgPath));
    expect(project.currentPackageData).toEqual(stored);
    expect(builder.triggerPreprocess).toHaveBeenCalledOnceWith('config-changed');
    expect((await save(loaded.context.token)).success).toBeFalse();
  });

  it('rejects project switching, external CSV changes, and changed board settings', async () => {
    let loaded = await load(); project.currentProjectPath = '/other';
    expect((await save(loaded.context.token)).success).toBeFalse(); project.currentProjectPath = '/project';
    loaded = await load(); files.set(csvPath, csv() + '# external\n');
    expect((await save(loaded.context.token)).success).toBeFalse();
    loaded = await load(); const pkg = JSON.parse(files.get(pkgPath)!); pkg.projectConfig.FlashSize = '4M'; files.set(pkgPath, JSON.stringify(pkg));
    expect((await save(loaded.context.token)).success).toBeFalse();
    expect(builder.triggerPreprocess).not.toHaveBeenCalled();
  });

  it('validates at the host boundary instead of trusting the editor', async () => {
    const loaded = await load();
    expect((await save(loaded.context.token, { flashBytes: 16 * MIB })).success).toBeFalse();
    expect((await save(loaded.context.token, { csv: 'broken csv' })).success).toBeFalse();
    expect((await save(loaded.context.token, { draft: createPreset('xiaozhi', 8 * MIB) })).success).toBeFalse();
    expect(builder.triggerPreprocess).not.toHaveBeenCalled();
  });

  it('keeps the draft retryable while a build or upload is running', async () => {
    const loaded = await load(); const before = [...files];
    const request = { action: 'partition-manager-save', token: loaded.context.token, csv: csv(), flashBytes: 8 * MIB };
    const result = await handlePartitionManagerRequest(project, builder, request, () => true);
    expect(result.success).toBeFalse(); expect([...files]).toEqual(before);
    let checks = 0;
    expect((await handlePartitionManagerRequest(project, builder, request, () => ++checks > 1)).success).toBeFalse();
    expect([...files]).toEqual(before);
    expect((await save(loaded.context.token)).success).toBeTrue();
  });

  it('updates both active and cached Coder context without writing a Blockly temp config', async () => {
    const cachedContext = { currentPackageData: null };
    project.isAilyCodeProject = () => true;
    project.getCoderProjectContext = () => cachedContext;
    files.set('/project/sketch/src/partitions.csv', csv());
    const tempBefore = files.get('/project/.temp/package.json');
    const loaded = await load();
    expect((await save(loaded.context.token)).success).toBeTrue();
    expect(cachedContext.currentPackageData).toEqual(project.currentPackageData);
    expect(files.get('/project/.temp/package.json')).toBe(tempBefore);
    expect(files.get('/project/sketch/src/partitions.csv')).toBe(csv());
  });

  it('restores all original files when the final rename fails', async () => {
    const before = [...files]; let failed = false;
    failRename = (a, b) => { if (!failed && a.endsWith('.tmp') && b === '/project/.temp/package.json') { failed = true; return true; } return false; };
    expect(() => writePartitionTransaction(fs, paths, [
      { path: csvPath, content: 'new csv' }, { path: pkgPath, content: 'new package' }, { path: '/project/.temp/package.json', content: 'new temp' },
    ])).toThrowError('write failed');
    expect([...files].sort()).toEqual(before.sort());
  });

  it('removes newly created files on rollback and supports nested Coder entry directories', () => {
    files.delete(csvPath); let failed = false;
    failRename = (a, b) => { if (!failed && a.endsWith('.tmp') && b === pkgPath) { failed = true; return true; } return false; };
    expect(() => writePartitionTransaction(fs, paths, [{ path: csvPath, content: 'csv' }, { path: pkgPath, content: 'pkg' }])).toThrow();
    expect(files.has(csvPath)).toBeFalse();
    expect(resolvePartitionPaths('/project', { entry: 'custom/main.cpp' }, true, paths).filePath).toBe('/project/sketch/custom/partitions.csv');
    expect(() => resolvePartitionPaths('/project', { entry: '../../../outside/main.cpp' }, true, paths)).toThrow();
  });
});
