const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePlatformResourceRoots, prepareReadOnlyToolsView } = require('../child/scripts/platform-resource-roots');
const output = path.resolve(__dirname, 'test-results/abs-recovery-restart-20261026/resource-roots');
fs.mkdirSync(output, { recursive: true });
function fixture(t, type, split) {
    const root = fs.mkdtempSync(path.join(output, 'case-'));
    t.after(() => { assert.ok(path.resolve(root).startsWith(output + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
    const project = path.join(root, 'project'), appData = path.join(root, 'private-appdata');
    const sdk = path.join(root, 'shared SDK'), tools = path.join(root, 'shared tools'), compilers = path.join(root, 'shared compilers');
    const write = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents)); };
    const boardModule = '@aily-project/board-test';
    write(path.join(project, 'package.json'), { type, entry: 'src/main.cpp', dependencies: { [boardModule]: '1.0.0' } });
    write(path.join(project, 'sketch/src/main.cpp'), 'void setup() {}\nvoid loop() {}');
    write(path.join(project, 'node_modules', boardModule, 'package.json'), { name: boardModule, version: '1.0.0', boardDependencies: {
        '@aily-project/compiler-test': '1.0.0', '@aily-project/sdk-test': '1.0.0', '@aily-project/tool-testflash': '1.0.0',
    } });
    write(path.join(project, 'node_modules', boardModule, 'board.json'), { type: 'test:test:board', core: 'arduino',
        compilerParam: 'compile -b test:test:board', uploadParam: 'testflash --port ${serial} --boot ${boot_app0}' });
    const executable = process.platform === 'win32' ? 'testflash.exe' : 'testflash';
    const compilerBinary = path.join(split ? compilers : tools, 'test@1.0.0', 'bin', 'test-gcc');
    write(compilerBinary, 'existing compiler'); write(path.join(tools, 'testflash@1.0.0', executable), 'existing tool');
    write(path.join(sdk, 'test_1.0.0/tools/partitions/boot_app0.bin'), 'existing SDK');
    fs.mkdirSync(appData, { recursive: true }); fs.mkdirSync(path.join(project, '.build'), { recursive: true });
    const config = path.join(root, 'build-config.json'), capture = path.join(root, 'captured.json'), preload = path.join(root, 'capture.cjs');
    write(config, { currentProjectPath: project, boardModule, appDataPath: appData, buildPath: path.join(project, '.build'), code: 'void setup() {}\nvoid loop() {}', serialPort: 'NO_DEVICE', use_1200bps_touch: false, wait_for_upload: false });
    write(preload, `const fs=require('node:fs'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
require('node:child_process').spawn=(command,args,options)=>{fs.writeFileSync(process.env.AILY_TEST_TOOL_COMMAND,JSON.stringify({command,args}));const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();process.nextTick(()=>{c.stdout.end();c.stderr.end();c.emit('close',0,null)});return c};`);
    const environment = { ...process.env, AILY_SDK_PATH: sdk, AILY_TOOLS_PATH: tools, AILY_COMPILERS_PATH: split ? compilers : tools,
        AILY_REPAIR_READONLY_NPM_PREFIX: path.join(root, 'existing-managed-tools'), AILY_TEST_TOOL_COMMAND: capture };
    return { root, appData, sdk, tools, compilers, compilerBinary, executable, project,
        run(script) {
            const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../child/scripts', script), config], { env: environment, encoding: 'utf8', timeout: 10000 });
            assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
            return JSON.parse(fs.readFileSync(capture));
        } };
}
const unquote = value => value.replace(/^"|"$/g, '');
test('resource roots use explicit SDK/tool/compiler paths without treating private AppData as a resource root', () => {
    const app = path.resolve('private'), sdk = path.resolve('sdk'), tools = path.resolve('tools'), compiler = path.resolve('compiler');
    assert.deepEqual(resolvePlatformResourceRoots(app, {}), { compilerPath: path.join(app, 'compiler'), sdkPath: path.join(app, 'sdk'), toolsPath: path.join(app, 'tools'), readOnly: false });
    assert.deepEqual(resolvePlatformResourceRoots(app, { AILY_SDK_PATH: sdk, AILY_TOOLS_PATH: tools, AILY_COMPILERS_PATH: compiler, AILY_REPAIR_READONLY_NPM_PREFIX: '/managed' }),
        { compilerPath: compiler, sdkPath: sdk, toolsPath: tools, readOnly: true });
    assert.throws(() => resolvePlatformResourceRoots(app, { AILY_SDK_PATH: 'relative-sdk' }), /absolute/);
});
for (const type of ['blockly', 'coder']) {
    for (const split of [false, true]) test(`${type} actual preprocessing resolves ${split ? 'split' : 'unified'} read-only tool roots without modifying shared resources`, t => {
        const f = fixture(t, type, split), captured = f.run('preprocess.js');
        const sdkFlag = unquote(captured.args[captured.args.indexOf('--sdk-path') + 1]);
        const toolsFlag = unquote(captured.args[captured.args.indexOf('--tools-path') + 1]);
        assert.equal(sdkFlag, path.join(f.sdk, 'test_1.0.0')); assert.ok(!sdkFlag.startsWith(f.appData + path.sep));
        assert.equal(fs.realpathSync(path.join(toolsFlag, 'test@1.0.0/bin/test-gcc')), fs.realpathSync(f.compilerBinary));
        assert.equal(fs.readFileSync(f.compilerBinary, 'utf8'), 'existing compiler');
        if (split) { assert.ok(toolsFlag.startsWith(path.join(f.appData, 'resource-views') + path.sep)); assert.equal(fs.existsSync(path.join(f.tools, 'test@1.0.0')), false); }
        else assert.equal(toolsFlag, f.tools);
        assert.equal(fs.existsSync(path.join(f.appData, 'sdk')), false); assert.equal(fs.existsSync(path.join(f.appData, 'tools')), false);
    });
    test(`${type} actual upload resource lookup shares the explicit SDK/tools roots without touching a device`, t => {
        const f = fixture(t, type, false), captured = f.run('upload.js');
        assert.equal(unquote(captured.command), path.join(f.tools, 'testflash@1.0.0', f.executable));
        assert.deepEqual(captured.args.map(unquote), ['--port', 'NO_DEVICE', '--boot', path.join(f.sdk, 'test_1.0.0/tools/partitions/boot_app0.bin')]);
    });
}
test('private split-root view reuses exact mappings and rejects a conflicting existing mapping', t => {
    const f = fixture(t, 'blockly', true), resources = { toolsPath: f.tools, compilerPath: f.compilers, readOnly: true };
    const compiler = path.dirname(path.dirname(f.compilerBinary));
    const first = prepareReadOnlyToolsView(f.appData, resources, compiler);
    assert.equal(prepareReadOnlyToolsView(f.appData, resources, compiler), first);
    const existing = path.join(first, 'test@1.0.0'); fs.unlinkSync(existing); fs.symlinkSync(f.tools, existing, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => prepareReadOnlyToolsView(f.appData, resources, compiler), /different resource/);
    assert.equal(fs.existsSync(path.join(f.tools, 'test@1.0.0')), false);
});
