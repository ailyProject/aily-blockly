const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { processUploadParams } = require('../child/scripts/upload');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily upload tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = path.join(root, 'tools');
    const put = (...parts) => {
        const filename = path.join(root, ...parts);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, '');
        return filename;
    };
    const resolve = (command, dependencies = {}, preprocess = false, platform = 'win32') => processUploadParams(
        command, root, tools, root, '115200', dependencies, 'COM1', platform, undefined, preprocess
    );
    return { root, put, resolve };
}

test('board and preprocess upload use the exact pin while two esptool versions coexist', async t => {
    const { put, resolve } = fixture(t);
    const pinned = put('tools', 'esptool_py@5.3.0', 'esptool.exe');
    const other = put('tools', 'esptool_py@5.3.1', 'esptool.exe');
    const dependencies = { esptool_py: '5.3.0' };
    assert.equal((await resolve('esptool write-flash', dependencies)).command, pinned);
    assert.equal((await resolve(`"${pinned}" write-flash`, dependencies, true)).command, `"${pinned}"`);
    await assert.rejects(resolve(`"${other}" write-flash`, dependencies, true), /esptool_py@5\.3\.0/);
});

test('a missing pinned executable never resolves from another version or PATH', async t => {
    const { put, resolve } = fixture(t);
    put('tools', 'esptool_py@5.3.0', 'README.md');
    const other = put('tools', 'esptool_py@5.3.1', 'esptool.exe');
    const fromPath = put('bin', 'esptool.exe');
    const previousPath = process.env.PATH;
    t.after(() => { process.env.PATH = previousPath; });
    process.env.PATH = path.dirname(fromPath);
    await assert.rejects(resolve('esptool write-flash', { esptool_py: '5.3.0' }), /esptool_py@5\.3\.0/);
    assert.equal((await resolve('esptool write-flash')).command, other);
    assert.equal((await resolve('esptool write-flash', { esptool_py: '^5.3.0' })).command, other);
    assert.equal((await resolve(`"${other}" write-flash`, { esptool_py: '^5.3.0' }, true)).command, `"${other}"`);
});

test('an SDK uploader cannot delegate to a stale version from cached preprocessing', async t => {
    const { root, put, resolve } = fixture(t);
    const sdkUploader = put('sdk', 'tools', 'flasher.exe');
    const pinned = put('tools', 'esptool_py@5.3.0', 'esptool.exe');
    const other = put('tools', 'esptool_py@5.3.1', 'esptool.exe');
    const dependencies = { esptool_py: '5.3.0' };
    const recipe = tool => `"${sdkUploader}" --esptool "${tool}"`;
    assert.equal((await resolve(recipe(pinned), dependencies, true)).args[1], `"${pinned}"`);
    const view = path.join(root, 'short-view');
    fs.symlinkSync(path.dirname(pinned), view, process.platform === 'win32' ? 'junction' : 'dir');
    const throughView = path.join(view, path.basename(pinned));
    assert.equal((await resolve(recipe(throughView), dependencies, true)).args[1], `"${throughView}"`);
    await assert.rejects(resolve(recipe(other), dependencies, true), /esptool_py@5\.3\.0/);
});

test('legacy directories keep the executable and config file on the same version', async t => {
    const { put, resolve } = fixture(t);
    put('tools', 'avrdude@6.2.0', 'avrdude.conf');
    const pinned = put('tools', 'avrdude@6.3.0-arduino17', 'bin', 'avrdude.exe');
    const config = put('tools', 'avrdude@6.3.0-arduino17', 'etc', 'avrdude.conf');
    const upload = await resolve("avrdude -C ${'avrdude.conf'}", { avrdude: '6.3.0' });
    assert.equal(upload.command, pinned);
    assert.deepEqual(upload.args, ['-C', `"${config}"`]);
});

test('the Pico command resolves the known archive revision for its declared package', async t => {
    const { put, resolve } = fixture(t);
    const pinned = put('tools', 'pqt-picotool@4.1.0-1aec55e', 'picotool.exe');
    put('tools', 'pqt-picotool@4.2.0', 'picotool.exe');
    assert.equal((await resolve('picotool load', { 'pqt-picotool': '4.1.0' })).command, pinned);
});

test('Windows preprocess resolves an omitted .exe in the pinned Python distribution and preserves arguments', async t => {
    const { put, resolve } = fixture(t);
    const pinned = put('tools', 'python3@3.7.2', 'python3.exe');
    put('tools', 'python3@3.7.3', 'python3.exe');
    const script = put('sdk', 'tools', 'esptool.py');
    const command = `"${pinned.slice(0, -4)}" -I "${script}" --port "\${serial}" --baud \${baud}`;
    const upload = await resolve(command, { python3: '3.7.2' }, true);
    assert.equal(upload.command, `"${pinned}"`);
    assert.deepEqual(upload.args, ['-I', `"${script}"`, '--port', '"COM1"', '--baud', '115200']);
});

test('Windows SDK delegation resolves omitted .exe paths in both positional and named arguments', async t => {
    const { put, resolve } = fixture(t);
    const uploader = put('sdk', 'tools', 'flasher.exe');
    const pinned = put('tools', 'python3@3.7.2', 'python3.exe');
    for (const prefix of ['', '--python=']) {
        const upload = await resolve(`"${uploader}" ${prefix}"${pinned.slice(0, -4)}" --port \${serial}`, { python3: '3.7.2' }, true);
        assert.equal(upload.command, `"${uploader}"`);
        assert.deepEqual(upload.args, [`${prefix}"${pinned}"`, '--port', 'COM1']);
    }
});

test('Windows omitted .exe remains usable through a resource directory view', async t => {
    const { root, put, resolve } = fixture(t);
    const pinned = put('tools', 'python3@3.7.2', 'python3.exe');
    const view = path.join(root, 'short-view');
    fs.symlinkSync(path.dirname(pinned), view, process.platform === 'win32' ? 'junction' : 'dir');
    const throughView = path.join(view, 'python3');
    assert.equal((await resolve(`"${throughView}" -I esptool.py`, { python3: '3.7.2' }, true)).command, `"${throughView}.exe"`);
});

test('Windows omitted .exe cannot fall back to another location or bypass the pinned version through a view', async t => {
    const { root, put, resolve } = fixture(t);
    const nested = put('tools', 'python3@3.7.2', 'nested', 'python3.exe');
    const pinnedDirectory = path.dirname(path.dirname(nested));
    const other = put('tools', 'python3@3.7.3', 'python3.exe');
    const fromPath = put('bin', 'python3.exe');
    const previousPath = process.env.PATH;
    t.after(() => { process.env.PATH = previousPath; });
    process.env.PATH = path.dirname(fromPath);
    const uploader = put('sdk', 'tools', 'flasher.exe');
    const view = path.join(pinnedDirectory, 'foreign-view');
    fs.symlinkSync(path.dirname(other), view, process.platform === 'win32' ? 'junction' : 'dir');
    const dependencies = { python3: '3.7.2' };
    for (const executable of [path.join(pinnedDirectory, 'python3'), other.slice(0, -4), path.join(view, 'python3')]) {
        await assert.rejects(resolve(`"${executable}" -I esptool.py`, dependencies, true), /python3@3\.7\.2/);
        await assert.rejects(resolve(`"${uploader}" --python="${executable}"`, dependencies, true), /python3@3\.7\.2/);
    }
    const pinned = put('tools', 'python3@3.7.2', 'python3.exe');
    assert.equal((await resolve(`"${pinned.slice(0, -4)}" -I esptool.py`, dependencies, true)).command, `"${pinned}"`);
    await assert.rejects(resolve(`"${other.slice(0, -4)}" -I esptool.py`, dependencies, true), /python3@3\.7\.2/);
    assert(fs.existsSync(path.join(root, 'bin', 'python3.exe')));
});

for (const platform of ['darwin', 'linux']) {
    test(`${platform} keeps native extensionless tools and never substitutes a Windows executable`, async t => {
        const { put, resolve } = fixture(t);
        const native = put('tools', 'python3@3.7.2', 'python3');
        put('tools', 'python3@3.7.2', 'python3.exe');
        const uploader = put('sdk', 'tools', 'flasher');
        const dependencies = { python3: '3.7.2' };
        const command = `"${native}" -I esptool.py --port \${serial}`;
        const upload = await resolve(command, dependencies, true, platform);
        assert.equal(upload.command, `"${native}"`);
        assert.deepEqual(upload.args, ['-I', 'esptool.py', '--port', 'COM1']);
        assert.equal((await resolve(`"${uploader}" --python="${native}"`, dependencies, true, platform)).args[0], `--python="${native}"`);
        fs.unlinkSync(native);
        await assert.rejects(resolve(command, dependencies, true, platform), /python3@3\.7\.2/);
        await assert.rejects(resolve(`"${uploader}" --python="${native}"`, dependencies, true, platform), /python3@3\.7\.2/);
    });
}

test(`${process.platform} upload entry executes the pinned native launcher from a path with spaces`, t => {
    const { root, put } = fixture(t);
    const launcher = path.join(root, 'tools', 'python3@3.7.2', process.platform === 'win32' ? 'python3.exe' : 'python3');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    // Use a real native executable as a test uploader without accessing a device.
    try { fs.linkSync(process.execPath, launcher); }
    catch { fs.copyFileSync(process.execPath, launcher); }
    const capture = path.join(root, 'captured.json');
    const script = put('sdk', 'tools', 'capture.cjs');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ platform: process.platform, args: process.argv.slice(2) }));`);
    const firmware = put('build', 'sketch.bin');
    const boardModule = '@aily-project/board-test';
    const writeJson = (parts, value) => {
        const filename = put(...parts);
        fs.writeFileSync(filename, JSON.stringify(value));
        return filename;
    };
    writeJson(['project', 'package.json'], { type: 'blockly', projectConfig: { UploadSpeed: '115200' } });
    writeJson(['project', 'node_modules', boardModule, 'package.json'], { boardDependencies: { '@aily-project/tool-python3': '3.7.2' } });
    writeJson(['project', 'node_modules', boardModule, 'board.json'], { core: 'esp8266:esp8266' });
    const command = `"${launcher.replace(/\.exe$/, '')}" "${script}" --port \${serial} --baud \${baud} write_flash 0x0 "${firmware}"`;
    const preprocessPath = writeJson(['preprocess.json'], { upload: { command, toolName: 'python3' } });
    const config = writeJson(['upload-config.json'], {
        currentProjectPath: path.join(root, 'project'), buildPath: path.join(root, 'build'),
        boardModule, appDataPath: path.join(root, 'appdata'), toolsPath: path.join(root, 'tools'),
        preprocessPath, serialPort: 'NO_DEVICE', use_1200bps_touch: false, wait_for_upload: false,
    });
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../child/scripts/upload.js'), config], {
        env: { ...process.env, AILY_TOOLS_PATH: path.join(root, 'tools'), AILY_SDK_PATH: path.join(root, 'sdk'), AILY_COMPILERS_PATH: path.join(root, 'compiler') },
        encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
        platform: process.platform, args: ['--port', 'NO_DEVICE', '--baud', '115200', 'write_flash', '0x0', firmware],
    });
});
