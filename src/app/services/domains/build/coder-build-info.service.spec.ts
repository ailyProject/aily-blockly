import { CoderBuildInfoService } from './coder-build-info.service';
import { CompileService } from './compile.service';
import { of } from 'rxjs';

describe('Coder build metadata', () => {
  const root = '/projects/coder';
  let files: Map<string, string>;
  let originalFs: any;
  let originalPath: any;
  let originalBuilder: any;
  let electron: any;
  let project: any;
  let metadata: CoderBuildInfoService;
  const packagePath = `${root}/package.json`;
  const readManifest = () => JSON.parse(files.get(packagePath)!);
  const writeManifest = (value: any) => files.set(packagePath, JSON.stringify(value));

  beforeEach(() => {
    originalFs = window['fs'];
    originalPath = window['path'];
    originalBuilder = window['builder'];
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
    window['builder'] = { captureBuildSource: jasmine.createSpy('captureBuildSource').and.returnValue({ digest: 'captured' }),
      patchBuildMetadata: (projectPath: string, patch: any) => {
      const target = `${projectPath}/package.json`;
      const manifest = { ...JSON.parse(files.get(target)!), ...patch };
      files.set(target, JSON.stringify(manifest)); return manifest;
    } };
  });

  afterEach(() => {
    window['fs'] = originalFs;
    window['path'] = originalPath;
    window['builder'] = originalBuilder;
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

  it('ignores retired platform metadata while still hashing board dependency changes', async () => {
    const hash = await metadata.updateCodeHash(root);
    writeManifest({ ...readManifest(), platform: '@aily-project/platform-unused', platformVersion: '9.0.0' });
    expect(await metadata.updateCodeHash(root)).toBe(hash);
    writeManifest({ ...readManifest(), dependencies: { '@aily-project/board-test': '2.0.0' } });
    expect(await metadata.updateCodeHash(root)).not.toBe(hash);
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
      project, {} as any, { createDirectory: async () => {} } as any, electron,
      { startBuild: () => true, finishBuild: () => {}, updateNotice: () => {} } as any,
      { za7: '/7z' } as any, { data: {} } as any,
      { warning: () => {}, error: () => {} } as any,
      { triggerAfterSuccessfulCompile: () => {} } as any,
      { update: () => {} } as any,
      { instant: (key: string) => key } as any, metadata,
      { runShared: async (_label: string, task: (token: string) => Promise<unknown>) => task('reader-token') } as any,
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
      if (call === 1) files.set(`${root}/sketch/src/helper.h`, 'changed while compiling');
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

  it('hands normal compilation to one transactional child instead of preprocessing twice', async () => {
    const service = createCompiler(() => 0);
    expect((await service.runCompileFromDisk()).success).toBeTrue();
    const calls = (service as any).runOneShotCommand.calls;
    expect(calls.count()).toBe(1);
    expect(calls.first().args[0].scriptPath).toContain('compile.js');
    expect(calls.first().args[0].configFilePath).toContain('/.temp/compile-request-');
    expect(calls.first().args[0].buildDeliveryRequest).toBeUndefined();
    expect(calls.first().args[3]).toBe('reader-token');
  });

  it('opts into host delivery for compilation but not preprocess-only commands', async () => {
    for (const preprocessOnly of [false, true]) {
      const service = createCompiler(() => 0);
      expect((await service.runCompileFromDisk({ recordProjectDelivery: true, preprocessOnly })).success).toBeTrue();
      const request = (service as any).runOneShotCommand.calls.first().args[0];
      expect(request.buildDeliveryRequest).toBe(preprocessOnly ? undefined : request.configFilePath);
      expect(JSON.parse(files.get(request.configFilePath)!).recordProjectDelivery).toBeTrue();
    }
  });

  it('launches the supervised child directly with separate arguments and a fixed working directory', async () => {
    const service = createCompiler(() => 0);
    (service as any).runOneShotCommand.and.callThrough();
    const spawn = jasmine.createSpy('spawn').and.returnValue(of({ type: 'close', code: 0, streamId: 'test' }));
    (service as any).cmdService.spawn = spawn;
    expect((await service.runCompileFromDisk()).success).toBeTrue();
    const [command, args, options] = spawn.calls.first().args;
    expect(command).toBe('node'); expect(args[0]).toBe('/child/scripts/compile.js');
    expect(args[1]).toContain('/.temp/compile-request-');
    expect(options.cwd).toBe(root); expect(options.shellProfile).toBeFalse();
    expect(options.appDataResourceToken).toBe('reader-token'); expect(options.buildWorkspace).toBe(root);
  });

  it('waits before reading inputs and retains the requested root across a project switch', async () => {
    const service = createCompiler(() => 0);
    let grant!: () => void;
    (service as any).appDataResourceLock.runShared = (_label: string, task: (token: string) => Promise<unknown>) =>
      new Promise(resolve => { grant = () => resolve(task('delayed-reader')); });
    const read = spyOn<any>(service, 'readCompileSource').and.callThrough();
    const build = service.runCompileFromDisk();
    expect(read).not.toHaveBeenCalled();
    project.currentProjectPath = '/projects/other';
    files.set(`${root}/sketch/src/main.cpp`, 'void setup() { /* saved while queued */ }');
    grant();
    expect((await build).success).toBeTrue();
    expect(read.calls.first().args[0]).toBe(root);
    const request = [...files.entries()].find(([filename]) => filename.includes('compile-request-'))!;
    expect(JSON.parse(request[1]).code).toContain('saved while queued');
    expect((service as any).runOneShotCommand.calls.first().args[3]).toBe('delayed-reader');
  });

  it('cancels a queued build without reading, writing metadata or launching a child', async () => {
    const service = createCompiler(() => 0);
    (service as any).appDataResourceLock.runShared = (_label: string, _task: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('APPDATA_RESOURCE_LOCK_CANCELLED'))));
    const read = spyOn<any>(service, 'readCompileSource').and.callThrough();
    const save = spyOn(metadata, 'saveBuildInfo').and.callThrough();
    const finish = spyOn((service as any).application, 'finishBuild');
    const build = service.runCompileFromDisk(); service.cancel();
    expect((await build).result.state).toBe('warn');
    expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect((service as any).runOneShotCommand).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('does not launch when target configuration changes during asynchronous resolution', async () => {
    const service = createCompiler(() => 0);
    spyOn<any>(service, 'resolveBoardModule').and.callFake(async () => {
      writeManifest({ ...readManifest(), projectConfig: { CPUFreq: '80' } });
      return '@aily-project/board-test';
    });
    const result = await service.runCompileFromDisk();
    expect(result.success).toBeFalse(); expect(result.result.text).toContain('BUILD_SOURCE_STALE');
    expect((service as any).runOneShotCommand).not.toHaveBeenCalled();
  });

  it('does not launch when the host rejects an outdated disk source capture', async () => {
    const service = createCompiler(() => 0);
    window['builder'].captureBuildSource.and.throwError('BUILD_SOURCE_STALE: newer disk edit');
    const result = await service.runCompileFromDisk();
    expect(result.success).toBeFalse(); expect(result.result.text).toContain('newer disk edit');
    expect((service as any).runOneShotCommand).not.toHaveBeenCalled();
  });

  it('checks configuration again after writing the isolated request', async () => {
    const service = createCompiler(() => 0);
    window['fs'].writeFileSync = (filename: string, content: string) => {
      files.set(filename, content);
      if (filename.includes('compile-request-')) writeManifest({ ...readManifest(), entry: 'src/other.cpp' });
    };
    const result = await service.runCompileFromDisk();
    expect(result.success).toBeFalse(); expect(result.result.text).toContain('BUILD_SOURCE_STALE');
    expect((service as any).runOneShotCommand).not.toHaveBeenCalled();
  });

  it('does not publish cancelled metadata or finish the build before supervised stop completes', async () => {
    let stopped!: () => void;
    let entered!: () => void;
    const cancelling = new Promise<void>(resolve => { entered = resolve; });
    const service = createCompiler((_call, compiler) => {
      (compiler as any).activeStreamId = 'registered-build';
      (compiler as any).cmdService.kill = () => {
        entered(); return new Promise<void>(resolve => { stopped = resolve; });
      };
      compiler.cancel(); return 1;
    });
    const save = spyOn(metadata, 'saveBuildInfo').and.callThrough();
    let resourceHeld = false;
    (service as any).appDataResourceLock.runShared = async (_label: string, task: (token: string) => Promise<unknown>) => {
      resourceHeld = true;
      try { return await task('reader'); } finally { resourceHeld = false; }
    };
    const finish = spyOn((service as any).application, 'finishBuild');
    const result = service.runCompileFromDisk();
    await cancelling; await Promise.resolve();
    expect(save).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
    expect(resourceHeld).toBeTrue();
    stopped(); await result;
    expect(resourceHeld).toBeFalse();
    expect(readManifest().buildInfo.lastBuildStatus).toBe('cancelled');
    expect(finish).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ['failed', 'cancelled'] as const) {
    it(`replaces previous successful build metadata after ${outcome} compilation`, async () => {
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
