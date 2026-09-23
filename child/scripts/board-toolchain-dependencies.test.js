const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function fixture(t, type) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-board-toolchain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    const appData = path.join(root, 'app-data');
    const boardModule = '@aily-project/board-test';
    const write = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write(path.join(project, 'package.json'), {
        type, entry: 'src/main.cpp', dependencies: { [boardModule]: '1.0.0' },
        platform: '@aily-project/platform-unused', platformVersion: '9.0.0',
    });
    write(path.join(project, 'sketch/src/main.cpp'), 'void setup() {}\nvoid loop() {}\n');
    write(path.join(project, 'node_modules', boardModule, 'package.json'), {
        name: boardModule, version: '1.0.0', boardDependencies: {
            '@aily-project/sdk-test': '1.0.0',
            '@aily-project/compiler-test': '1.0.0',
            '@aily-project/tool-testflash': '1.0.0',
        },
    });
    write(path.join(project, 'node_modules', boardModule, 'board.json'), {
        type: 'test:test:board', core: 'arduino', compilerParam: 'compile -b test:test:board',
        uploadParam: 'testflash --port ${serial} --boot ${boot_app0}',
    });
    // An installed obsolete package must not override the selected board.
    write(path.join(appData, 'node_modules/@aily-project/platform-unused/platform.json'), {
        runtimeDependencies: ['sdk-test', 'compiler-test', 'tool-testflash'].map(name => ({
            package: `@aily-project/${name}`, version: '9.0.0',
        })),
    });
    const executable = process.platform === 'win32' ? 'testflash.exe' : 'testflash';
    for (const version of ['1.0.0', '9.0.0']) {
        write(path.join(appData, `tools/testflash@${version}`, executable), 'fixture tool');
        write(path.join(appData, `sdk/test_${version}/tools/partitions/boot_app0.bin`), 'fixture boot');
    }
    const capture = path.join(root, 'command.json');
    const preload = path.join(root, 'capture-spawn.cjs');
    // Run the actual script entry points, replacing only external tool execution.
    // This prevents tests from invoking a compiler or accessing a serial device.
    write(preload, `
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
require('node:child_process').spawn = (command, args) => {
    fs.writeFileSync(process.env.AILY_TEST_TOOL_COMMAND, JSON.stringify({ command, args }));
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); });
    return child;
};
`);
    const buildPath = path.join(project, '.build');
    fs.mkdirSync(buildPath, { recursive: true });
    const config = path.join(root, 'config.json');
    write(config, {
        currentProjectPath: project, boardModule, appDataPath: appData, buildPath,
        code: 'void setup() {}\nvoid loop() {}\n', serialPort: 'TEST_PORT',
        use_1200bps_touch: false, wait_for_upload: false,
    });
    return {
        appData, executable,
        run(script) {
            const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, script), config], {
                encoding: 'utf8', timeout: 10000,
                env: { ...process.env, AILY_TEST_TOOL_COMMAND: capture },
            });
            assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
            return JSON.parse(fs.readFileSync(capture, 'utf8'));
        },
    };
}

const unquote = value => value.replace(/^"|"$/g, '');
for (const type of ['coder', 'blockly']) {
    test(`${type} preprocessing uses only the selected board SDK and tool versions`, t => {
        const f = fixture(t, type);
        const { command, args } = f.run('preprocess.js');
        assert.equal(command, 'aily-builder');
        assert.equal(unquote(args[args.indexOf('--sdk-path') + 1]), path.join(f.appData, 'sdk/test_1.0.0'));
        assert.equal(unquote(args[args.indexOf('--tool-versions') + 1]), 'test@1.0.0,testflash@1.0.0');
    });

    test(`${type} upload resolves its executable and SDK assets from board dependencies`, t => {
        const f = fixture(t, type);
        const { command, args } = f.run('upload.js');
        assert.equal(unquote(command), path.join(f.appData, 'tools/testflash@1.0.0', f.executable));
        assert.deepEqual(args.map(unquote), [
            '--port', 'TEST_PORT', '--boot', path.join(f.appData, 'sdk/test_1.0.0/tools/partitions/boot_app0.bin'),
        ]);
    });
}
