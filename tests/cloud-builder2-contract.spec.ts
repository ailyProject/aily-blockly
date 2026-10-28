// Product baseline: origin/cloud-builder2, 32b528613. Do not restore implicit
// local fallback, local SDK installation, or slot-count-based target ranking.
import { selectCloudBoardProfile } from '../src/app/utils/cloud-build-settings.utils';
import { resolveVariantPaths } from '../src/app/utils/board-variant.utils';
import { runCloudBuildWithProgress } from '../src/app/utils/cloud-build-progress.utils';
import { NpmService } from '../src/app/services/domains/dependencies/npm.service';
import { _UploaderService } from '../src/app/editors/blockly-editor/services/uploader.service';

describe('cloud-builder2 target selection', () => {
  const board = { boardModule: '@aily-project/board-test', boardVersion: '1.0.0', boardDigest: 'b'.repeat(64) };
  const profile = (id: string, availability: any) => ({ ...board, profileDigest: id.repeat(64),
    fqbn: 'vendor:arch:test', runner: 'aily-builder', capabilities: { compile: true },
    metadata: { boardOptions: {}, defaults: {} }, availability } as any);

  for (const [name, left, right] of [
    ['online before offline', { onlineNodes: 0, freeSlots: 10, idleNodes: 10, priority: 0 }, { onlineNodes: 1, freeSlots: 0, idleNodes: 0, priority: 9 }],
    ['accepting before full', { onlineNodes: 1, freeSlots: 0, idleNodes: 0, priority: 0 }, { onlineNodes: 1, freeSlots: 1, idleNodes: 0, priority: 9 }],
    ['idle physical server before busy', { onlineNodes: 1, freeSlots: 10, idleNodes: 0, priority: 0 }, { onlineNodes: 1, freeSlots: 1, idleNodes: 1, priority: 9 }],
    ['server priority before slot quantity', { onlineNodes: 1, freeSlots: 100, idleNodes: 1, priority: 8 }, { onlineNodes: 1, freeSlots: 1, idleNodes: 1, priority: 2 }],
  ] as const) it(`selects ${name}`, () => {
    const a = profile('a', left), b = profile('b', right);
    expect(selectCloudBoardProfile([a, b], board)).toBe(b);
  });

  it('excludes another board digest and fixture targets despite their priority', () => {
    const valid = profile('a', { onlineNodes: 1, freeSlots: 1, idleNodes: 1, priority: 9 });
    const wrong = { ...profile('b', { ...valid.availability, priority: 0 }), boardDigest: 'c'.repeat(64) };
    const fixture = { ...profile('c', { ...valid.availability, priority: 0 }), metadata: { ...valid.metadata, fixture: true } };
    expect(selectCloudBoardProfile([wrong, fixture, valid], board)).toBe(valid);
  });

  it('expands the selected variant with option overrides and a default header', () => {
    expect(resolveVariantPaths({ 'build.variant': '{family}/{chip}', family: 'stm32', chip: 'old' }, { chip: 'new' }))
      .toEqual({ variant: 'stm32/new', header: 'variant_generic.h' });
  });

  it('rejects unresolved or recursive variant paths', () => {
    expect(() => resolveVariantPaths({ 'build.variant': '{missing}' })).toThrowError(/unresolved/);
    expect(() => resolveVariantPaths({ 'build.variant': '{a}', a: '{b}', b: '{a}' })).toThrowError(/unresolved/);
  });
});

describe('cloud-builder2 isolated uploader preparation', () => {
  let originals: any;
  beforeEach(() => {
    originals = { platform: window['platform'], path: window['path'], fs: window['fs'], cloudBuild: window['cloudBuild'] };
    window['platform'] = { type: 'win32' };
    window['path'] = { getAppDataPath: () => 'C:/Aily', isExists: () => false };
  });
  afterEach(() => Object.assign(window, originals));

  for (const installed of [false, true]) it(`prepares only the exact global uploader package (installed=${installed})`, async () => {
    const command = jasmine.createSpy('command').and.resolveTo();
    const service: any = Object.assign(Object.create(NpmService.prototype), {
      cmdService: { runAsyncChecked: command }, application: { updateNotice() {} }, translate: { instant: (key: string) => key },
    });
    window['path'].isExists = () => installed;
    window['fs'] = { readFileSync: () => JSON.stringify({ name: '@aily-project/tool-esptool_py', version: '5.0.0' }) };
    await service.installCloudUploadTool({ name: '@aily-project/tool-esptool_py', version: '5.0.0' });
    expect(command).toHaveBeenCalledOnceWith(
      `npm ${installed ? 'rebuild' : 'install'} "@aily-project/tool-esptool_py@5.0.0" --global --prefix "C:/Aily" --foreground-scripts`,
      'C:/Aily', true, false);
  });

  it('does not resolve SDK/compiler dependencies while preparing recipe upload tools', async () => {
    const install = jasmine.createSpy('install').and.resolveTo();
    const service: any = Object.assign(Object.create(_UploaderService.prototype), {
      projectService: { currentProjectPath: '/project', getBoardDependencies: jasmine.createSpy('boardDependencies') },
      npmService: { installCloudUploadTool: install, installSDK: jasmine.createSpy('SDK') },
    });
    window['cloudBuild'] = { artifactUploadInfo: async () => ({ protocol: 'cloud-recipe', requirements: [
      { kind: 'tool', name: '@aily-project/tool-avrdude', version: '8.0.0', installed: true },
      { kind: 'tool', name: '@aily-project/tool-esptool_py', version: '5.0.0', installed: false },
    ] }) };
    expect(await service.prepareCloudUploader(() => {})).toBe('cloud-recipe');
    expect(install).toHaveBeenCalledOnceWith({ name: '@aily-project/tool-esptool_py', version: '5.0.0' });
    expect(service.projectService.getBoardDependencies).not.toHaveBeenCalled();
    expect(service.npmService.installSDK).not.toHaveBeenCalled();
  });

  it('rejects a non-exact uploader version before installing anything', async () => {
    const install = jasmine.createSpy('install').and.resolveTo();
    const service: any = Object.assign(Object.create(_UploaderService.prototype), {
      projectService: { currentProjectPath: '/project' }, npmService: { installCloudUploadTool: install },
    });
    window['cloudBuild'] = { artifactUploadInfo: async () => ({ protocol: 'cloud-recipe', requirements: [
      { kind: 'tool', name: '@aily-project/tool-avrdude', version: '^8.0.0', installed: false },
    ] }) };
    await expectAsync(service.prepareCloudUploader(() => {})).toBeRejectedWithError(/exact uploader/);
    expect(install).not.toHaveBeenCalled();
  });
});

describe('cloud-builder2 resource preparation handshake', () => {
  it('installs only missing declared tools before submitting the cloud request', async () => {
    const order: string[] = [];
    const tool = { name: '@aily-project/tool-citool-cli', version: '1.2.2' };
    const bridge = {
      preparationRequirements: async () => [{ ...tool, installed: false }, { name: 'already-ready', version: '1.0.0', installed: true }],
      onProgress: () => () => {}, cancel: () => {}, run: async () => { order.push('run'); return { success: true }; },
    };
    await runCloudBuildWithProgress({ requestId: 'build' }, bridge, {
      isCurrent: () => true, log() {}, progress() {}, prepareTool: async requested => {
        expect(requested.name).toBe(tool.name); expect(requested.version).toBe(tool.version); order.push('prepare');
      },
    });
    expect(order).toEqual(['prepare', 'run']);
  });

  it('acknowledges a worker CI-tool request with its nonce after preparation', async () => {
    let listener: any, complete!: (result: any) => void;
    const prepared = jasmine.createSpy('prepare').and.resolveTo();
    const acknowledge = jasmine.createSpy('acknowledge').and.callFake(async request => {
      expect(prepared).toHaveBeenCalledTimes(1); expect(request).toEqual({ requestId: 'build', nonce: 'resource-1', error: undefined });
      complete({ success: true });
    });
    const bridge = {
      onProgress: (callback: any) => { listener = callback; return () => {}; }, cancel() {},
      completeCIToolPreparation: acknowledge,
      run: () => new Promise<any>(resolve => {
        complete = resolve;
        listener({ requestId: 'build', stage: 'ci-tools-required', nonce: 'resource-1', requirements: [
          { name: '@aily-project/tool-citool-cli', version: '1.2.2', installed: false },
        ] });
      }),
    };
    expect((await runCloudBuildWithProgress({ requestId: 'build' }, bridge, {
      isCurrent: () => true, log() {}, progress() {}, prepareTool: prepared,
    })).success).toBeTrue();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
