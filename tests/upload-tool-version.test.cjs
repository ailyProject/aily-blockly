const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    const resolve = (command, dependencies = {}, preprocess = false) => processUploadParams(
        command, root, tools, root, '115200', dependencies, 'COM1', 'win32', undefined, preprocess
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
