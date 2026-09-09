import { CoderBuildInfoService } from './coder-build-info.service';
import { CompileService } from './compile.service';

describe('Coder build metadata', () => {
  const root = '/projects/coder';
  let files: Map<string, string>;
  let originalFs: any;
  let originalPath: any;
  let electron: any;
  let project: any;
  let metadata: CoderBuildInfoService;
  const packagePath = `${root}/package.json`;
  const readManifest = () => JSON.parse(files.get(packagePath)!);
  const writeManifest = (value: any) => files.set(packagePath, JSON.stringify(value));

  beforeEach(() => {
    originalFs = window['fs'];
    originalPath = window['path'];
    files = new Map([
      [packagePath, JSON.stringify({
        type: 'coder', entry: 'src/main.cpp', dependencies: { '@aily-project/board-test': '1.0.0' },
      })],
      [`${root}/sketch/src/main.cpp`, '#include "helper.h"\nvoid setup() {}'],
      [`${root}/sketch/src/helper.h`, '#define VALUE 1'],
      [`${root}/sketch/libraries/Local/src/local.cpp`, 'int local = 1;'],
    ]);
    const exists = (path: string) => files.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`));
    window['fs'] = {
      readFileSync: (path: string) => {
        if (!files.has(path)) throw new Error(`Missing file: ${path}`);
        return files.get(path);
      },
      writeFileSync: (path: string, content: string) => files.set(path, content),
      readFileAsBase64: (path: string) => btoa(files.get(path)!),
      existsSync: exists,
      readDirSync: (path: string) => {
        const names = new Set([...files.keys()].filter(key => key.startsWith(`${path}/`))
          .map(key => key.slice(path.length + 1).split('/')[0]));
        return [...names].map(name => ({
          name, _isFile: files.has(`${path}/${name}`), _isDirectory: !files.has(`${path}/${name}`),
        }));
      },
    };
    window['path'] = {
      isExists: exists,
      getAilyBuilderPath: () => '/builder',
      getAppDataPath: () => '/app-data',
      getAilyChildPath: () => '/child',
    };
    electron = {
      pathJoin: (...segments: string[]) => segments.filter(Boolean).join('/'),
      calculateHash: async (content: string) => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      },
    };
    project = { currentProjectPath: root, isAilyCodeProject: () => true, copyPackageJsonToTemp: async () => true };
    metadata = new CoderBuildInfoService(electron);
  });

  afterEach(() => {
    window['fs'] = originalFs;
    window['path'] = originalPath;
  });

  it('persists a content hash covering headers, local libraries and build configuration', async () => {
    let previous = await metadata.updateCodeHash(root);
    for (const path of [`${root}/sketch/src/helper.h`, `${root}/sketch/libraries/Local/src/local.cpp`]) {
      files.set(path, `${files.get(path)}\n// changed`);
      const next = await metadata.updateCodeHash(root);
      expect(next).not.toBe(previous);
      expect(readManifest().codeHash).toBe(next);
      previous = next;
    }
    writeManifest({ ...readManifest(), projectConfig: { CPUFreq: '240' } });
    expect(await metadata.updateCodeHash(root)).not.toBe(previous);
  });

  it('ignores generated caches and cloud metadata and normalizes manifest key order', async () => {
    const hash = await metadata.updateCodeHash(root);
    for (const path of ['sketch/build-config.json', 'sketch/preprocess.json', 'sketch/library-cache.json',
      'sketch/upload-config.json', '.aily/build/main.bin', 'sketch/.build/cache']) files.set(`${root}/${path}`, 'output');
    const manifest = readManifest();
    writeManifest({ dependencies: manifest.dependencies, entry: manifest.entry, type: manifest.type,
      cloudId: '123', nickname: 'Renamed', buildInfo: { lastBuildTime: 'changed' } });
    expect(await metadata.updateCodeHash(root)).toBe(hash);
  });

  it('hashes legacy custom partitions at their build destination before preprocessing copies them', async () => {
    writeManifest({ ...readManifest(), projectConfig: { PartitionScheme: 'custom' } });
    files.set(`${root}/partitions.csv`, 'partition contents');
    const hash = await metadata.updateCodeHash(root);
    files.set(`${root}/sketch/src/partitions.csv`, 'partition contents');
    expect(await metadata.updateCodeHash(root)).toBe(hash);
    files.set(`${root}/sketch/src/partitions.csv`, 'updated partition');
    expect(await metadata.updateCodeHash(root)).not.toBe(hash);
  });

  function createCompiler(command: (call: number, service: CompileService) => number) {
    const service = new CompileService(
      project, {} as any, {} as any, electron,
      { startBuild: () => true, finishBuild: () => {}, updateNotice: () => {} } as any,
      { za7: '/7z' } as any, { data: {} } as any,
      { warning: () => {}, error: () => {} } as any,
      { triggerAfterSuccessfulCompile: () => {} } as any,
      { update: () => {} } as any,
      { instant: (key: string) => key } as any, metadata,
    );
    let calls = 0;
    spyOn<any>(service, 'runOneShotCommand').and.callFake(async () => ({
      exitCode: command(++calls, service), combined: 'compiler output', stdout: '', stderr: '', signal: null,
    }));
    // Project log I/O is outside the build metadata contract.
    spyOn<any>(service, 'publishBuildLog');
    spyOn<any>(service, 'handleFailNotice');
    return service;
  }

  it('records successful compilation against the captured project even after a project switch', async () => {
    const service = createCompiler(() => {
      project.currentProjectPath = '/projects/other';
      return 0;
    });
    expect((await service.runCompileFromDisk({ projectPath: root })).success).toBeTrue();
    const manifest = readManifest();
    expect(manifest.buildInfo.lastBuildStatus).toBe('success');
    expect(manifest.buildInfo.lastBuildCode).toBe(manifest.codeHash);
    expect(files.has('/projects/other/package.json')).toBeFalse();
    files.set(`${root}/sketch/src/helper.h`, 'modified after successful build');
    await metadata.updateCodeHash(root);
    expect(readManifest().buildInfo.lastBuildCode).not.toBe(readManifest().codeHash);
  });

  it('keeps the compiled hash distinct when input changes during compilation', async () => {
    const before = await metadata.updateCodeHash(root);
    const service = createCompiler(call => {
      if (call === 2) files.set(`${root}/sketch/src/helper.h`, 'changed while compiling');
      return 0;
    });
    expect((await service.runCompileFromDisk()).success).toBeTrue();
    expect(readManifest().buildInfo.lastBuildCode).toBe(before);
    expect(readManifest().codeHash).not.toBe(before);
  });

  it('records preprocess-only completion as successful and releases the build lock once', async () => {
    const service = createCompiler(() => 0);
    const finish = spyOn((service as any).application, 'finishBuild');

    expect((await service.runCompileFromDisk({ preprocessOnly: true })).success).toBeTrue();
    expect(readManifest().buildInfo.lastBuildStatus).toBe('success');
    expect(finish).toHaveBeenCalledOnceWith(true, undefined);
  });

  it('holds the build lock until build metadata has been persisted', async () => {
    const service = createCompiler(() => 0);
    const finish = spyOn((service as any).application, 'finishBuild');
    let completeMetadata!: () => void;
    const enteredMetadata = new Promise<void>(resolve => {
      spyOn(metadata, 'saveBuildInfo').and.callFake(() => {
        resolve();
        return new Promise<void>(complete => { completeMetadata = complete; });
      });
    });
    const build = service.runCompileFromDisk();
    await enteredMetadata;
    expect(finish).not.toHaveBeenCalled();
    completeMetadata();
    await build;
    expect(finish).toHaveBeenCalledOnceWith(true, undefined);
  });

  for (const outcome of ['failed', 'cancelled'] as const) {
    it(`replaces previous successful build metadata after ${outcome} preprocessing`, async () => {
      const hash = await metadata.updateCodeHash(root);
      await metadata.saveBuildInfo(root, hash, 'success', 1);
      const service = createCompiler((_call, compiler) => {
        if (outcome === 'cancelled') compiler.cancel();
        return 1;
      });
      expect((await service.runCompileFromDisk()).success).toBeFalse();
      expect(readManifest().buildInfo.lastBuildStatus).toBe(outcome);
    });
  }
});
