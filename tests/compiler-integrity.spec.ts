import { NpmService } from '../src/app/services/domains/dependencies/npm.service';
import { findCompilerIntegrityProblem } from '../src/app/utils/compiler-integrity.utils';

describe('Compiler integrity and automatic repair', () => {
  const name = '@aily-project/compiler-esp-x32';
  const directory = '/tools/esp-x32@14.2.0';
  const join = (...parts: string[]) => parts.join('/');
  let original: any;
  let files: Map<string, number>;
  let npm: any;
  let session: any;
  let current: boolean;
  let windows: boolean;
  const addCompiler = () => {
    files.set(directory, -1);
    const suffix = windows ? '.exe' : '';
    for (const target of ['xtensa-esp-elf', 'xtensa-esp32-elf', 'xtensa-esp32s2-elf', 'xtensa-esp32s3-elf']) {
      for (const tool of ['gcc', 'g++', 'ar', 'as', 'ld', 'objcopy', 'size']) {
        files.set(`${directory}/bin/${target}-${tool}${suffix}`, 100);
      }
    }
    for (const tool of ['cc1', 'cc1plus', 'collect2']) files.set(`${directory}/libexec/gcc/xtensa-esp-elf/14.2.0/${tool}${suffix}`, 100);
  };
  beforeEach(() => {
    original = Object.fromEntries(['fs', 'path', 'platform', 'env', 'ipcRenderer', 'npm'].map(key => [key, window[key]]));
    files = new Map([[directory, -1], [`/app/node_modules/${name}/package.json`, 100]]);
    windows = true; current = true; session = { projectPath: '/project' };
    window['fs'] = {
      readFileSync: () => JSON.stringify({ version: '14.2.0' }),
      readDirSync: () => ['14.2.0'],
      statSync: (filename: string) => {
        if (!files.has(filename)) throw Object.assign(new Error(filename), { code: 'ENOENT' });
        return { size: Math.max(0, files.get(filename)!), _isFile: files.get(filename)! >= 0, mode: 0o100755 };
      },
    };
    window['path'] = { join, basename: (filename: string) => filename.split('/').pop(),
      getAppDataPath: () => '/app', isExists: (filename: string) => files.has(filename) };
    window['platform'] = { isWindows: true };
    window['env'] = { get: jasmine.createSpy('env').and.resolveTo(undefined) };
    window['ipcRenderer'] = { invoke: jasmine.createSpy('remove').and.callFake(async (_channel: string, data: any) => {
      for (const filename of files.keys()) if (filename === data.target || filename.startsWith(data.target + '/')) files.delete(filename);
      return { ok: true };
    }) };
    window['npm'] = { run: jasmine.createSpy('nativeNpm').and.resolveTo() };
    npm = Object.assign(Object.create(NpmService.prototype), {
      configService: { isCoderProduct: () => false, getNpmRegistryForProject: () => '' },
      application: { updateNotice: jasmine.createSpy('notice') },
      translate: { instant: (key: string) => key }, traceToAppLog: () => {},
      cmdService: { runAsyncChecked: jasmine.createSpy('postinstall').and.callFake(async () => { addCompiler(); }) },
      getPlatformPathBases: async () => ({ sdkBase: '/sdk', toolsBase: '/tools', compilersBase: '/tools' }),
      isCloudBuild: () => false,
      prjService: { getProjectDependencySession: () => session,
        getBoardPackageJson: async () => ({ boardDependencies: { [name]: '14.2.0' } }),
        assertProjectDependencySession: () => { if (!current) throw new Error('cancelled'); },
        getCoderProjectContext: () => ({ getBoardPackageJson: async () => ({ boardDependencies: { [name]: '14.2.0' } }) }) },
    });
  });
  afterEach(() => Object.assign(window, original));
  const problem = () => findCompilerIntegrityProblem(name, directory, window['fs'], join, windows);
  const install = () => npm.installBoardDependencies({ boardDependencies: { [name]: '14.2.0' } }, false, false, session);

  for (const win of [true, false]) {
    it(`accepts healthy ${win ? 'Windows' : 'POSIX'} compilers and rejects missing internal executables`, () => {
      windows = win; window['platform'].isWindows = win; addCompiler();
      expect(problem()).toBeUndefined();
      files.delete(`${directory}/libexec/gcc/xtensa-esp-elf/14.2.0/cc1plus${win ? '.exe' : ''}`);
      expect(problem()).toContain('/libexec/gcc/');
    });
  }
  for (const kind of ['missing', 'empty', 'directory']) {
    it(`rejects a ${kind} chip-specific g++ wrapper`, () => {
      addCompiler();
      const filename = `${directory}/bin/xtensa-esp32-elf-g++.exe`;
      if (kind === 'missing') files.delete(filename);
      else files.set(filename, kind === 'empty' ? 0 : -1);
      expect(problem()).toBe(filename);
    });
  }
  it('rejects files without POSIX execute permission', () => {
    windows = false; addCompiler();
    const stat = window['fs'].statSync;
    window['fs'].statSync = (filename: string) => ({ ...stat(filename), mode: 0o100644 });
    expect(problem()).toContain('/bin/');
  });
  it('recognizes missing-file errors after Electron drops their custom code', () => {
    window['fs'].statSync = () => { throw new Error('ENOENT: no such file or directory, stat compiler'); };
    expect(problem()).toContain('/bin/');
  });
  it('retains the readiness policy of unregistered compiler layouts', () => {
    expect(findCompilerIntegrityProblem('@aily-project/compiler-custom', directory, window['fs'], join, true)).toBeUndefined();
  });
  it('accepts the older ARM lib/gcc layout instead of reinstalling a healthy compiler', () => {
    for (const tool of ['gcc', 'g++', 'ar', 'as', 'ld', 'objcopy', 'size']) files.set(`${directory}/bin/arm-none-eabi-${tool}.exe`, 100);
    for (const tool of ['cc1', 'cc1plus', 'collect2']) files.set(`${directory}/lib/gcc/arm-none-eabi/14.2.0/${tool}.exe`, 100);
    expect(findCompilerIntegrityProblem('@aily-project/compiler-arm-none-eabi-gcc', directory, window['fs'], join, true)).toBeUndefined();
  });
  for (const coder of [true, false]) {
    it(`repairs an existing empty directory once in ${coder ? 'Coder' : 'Blockly'}, then skips healthy tools`, async () => {
      npm.configService.isCoderProduct = () => coder;
      await install();
      expect(window['ipcRenderer'].invoke).toHaveBeenCalledOnceWith('appdata-resource-remove', { target: directory });
      expect(npm.cmdService.runAsyncChecked).toHaveBeenCalledOnceWith('npm run postinstall', `/app/node_modules/${name}`, true, false, session);
      expect(window['npm'].run).not.toHaveBeenCalled();
      expect(problem()).toBeUndefined();
      await install();
      expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(1);
      expect(npm.cmdService.runAsyncChecked).toHaveBeenCalledTimes(1);
    });
  }
  it('does not label a successful npm exit as a successful compiler extraction', async () => {
    npm.cmdService.runAsyncChecked.and.resolveTo();
    await expectAsync(install()).toBeRejectedWithError('NPM.DEPENDENCY_INCOMPLETE');
    expect(window['npm'].run).toHaveBeenCalledTimes(1);
    expect(npm.application.updateNotice.calls.allArgs().some(([notice]: any[]) => notice.state === 'done')).toBeFalse();
  });
  it('retries postinstall after npm says up to date following a failed cached-archive extraction', async () => {
    let attempts = 0;
    npm.cmdService.runAsyncChecked.and.callFake(async () => {
      if (++attempts === 1) {
        files.set(directory, -1);
        throw new Error('cached archive is truncated');
      }
      expect(files.has(directory)).toBeFalse();
      addCompiler();
    });
    await install();
    expect(window['npm'].run).toHaveBeenCalledTimes(1);
    expect(npm.cmdService.runAsyncChecked).toHaveBeenCalledTimes(2);
    expect(window['ipcRenderer'].invoke).toHaveBeenCalledTimes(2);
    expect(problem()).toBeUndefined();
  });
  it('does not remove a toolchain when a metadata read is denied', async () => {
    window['fs'].statSync = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
    await expectAsync(install()).toBeRejectedWithError('access denied');
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
  });
  it('stops on cleanup failure before executing the installer', async () => {
    window['ipcRenderer'].invoke.and.resolveTo({ ok: false, error: 'resource busy' });
    await expectAsync(install()).toBeRejectedWithError('resource busy');
    expect(npm.cmdService.runAsyncChecked).not.toHaveBeenCalled();
  });
  it('preserves read-only shared toolchains', async () => {
    window['env'].get.and.resolveTo('/shared');
    await expectAsync(install()).toBeRejectedWithError(/read-only/);
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
  });
  it('discards a cancelled session before cleanup', async () => {
    current = false;
    await expectAsync(install()).toBeRejectedWithError('cancelled');
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
  });
  it('rechecks files and repairs tools removed after the project was opened', async () => {
    addCompiler();
    npm.installBoardDeps = jasmine.createSpy('repair').and.callFake(async () => { await install(); });
    await npm.ensureLocalCompilerDependencies('/project');
    expect(npm.installBoardDeps).not.toHaveBeenCalled();
    files.delete(`${directory}/bin/xtensa-esp32-elf-g++.exe`);
    await npm.ensureLocalCompilerDependencies('/project');
    expect(npm.installBoardDeps).toHaveBeenCalledOnceWith(session, { showSuccessNotice: false });
    expect(problem()).toBeUndefined();
  });
  it('skips local compiler reads and installation for cloud compilation', async () => {
    npm.isCloudBuild = () => true;
    const read = spyOn(npm, 'getPlatformPathBases');
    await npm.ensureLocalCompilerDependencies('/project');
    expect(read).not.toHaveBeenCalled();
    expect(window['ipcRenderer'].invoke).not.toHaveBeenCalled();
  });
});
