const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { runCompilePreprocess } = require('./compile-preprocess');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-compile-preprocess-'));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-compile-preprocess-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('refreshes existing preprocess data from a frozen current configuration without clearing archives', async t => {
    const root = fixture(t), child = new EventEmitter();
    const cached = path.join(root, 'preprocess.json'), archive = path.join(root, 'core.a');
    fs.writeFileSync(cached, '{"success":true,"dependencies":[]}'); fs.writeFileSync(archive, 'keep archive');
    const config = { currentProjectPath: root, code: '#include <SPI.h>\n', boardModule: 'board' };
    let snapshot;
    const running = runCompilePreprocess(config, root, cached, (command, args, options) => {
        assert.equal(command, process.execPath); assert.equal(path.basename(args[0]), 'preprocess.js');
        snapshot = args[1]; assert.notEqual(snapshot, path.join(root, 'build-config.json'));
        assert.deepEqual(JSON.parse(fs.readFileSync(snapshot)), config);
        assert.equal(options.cwd, root); assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
        return child;
    });
    config.code = 'changed later';
    assert.equal(JSON.parse(fs.readFileSync(snapshot)).code, '#include <SPI.h>\n');
    assert.equal(fs.existsSync(cached), false);
    fs.writeFileSync(cached, '{"success":true,"dependencies":["SPI"]}');
    child.emit('close', 0, null); await running;
    assert.equal(fs.existsSync(snapshot), false); assert.equal(fs.readFileSync(archive, 'utf8'), 'keep archive');
});

for (const failure of ['error', 'exit', 'signal', 'launch', 'missing-result', 'failed-result']) test(`rejects ${failure} without retaining a compile snapshot`, async t => {
    const root = fixture(t), child = new EventEmitter();
    const result = path.join(root, 'preprocess.json');
    const running = runCompilePreprocess({ currentProjectPath: root, code: '' }, root, result, () => {
        if (failure === 'launch') throw new Error('launch failure');
        return child;
    });
    if (failure === 'error') child.emit('error', new Error('spawn failure'));
    if (failure === 'exit') child.emit('close', 1, null);
    if (failure === 'signal') child.emit('close', null, 'SIGTERM');
    if (failure === 'failed-result') fs.writeFileSync(result, '{"success":false}');
    if (failure.endsWith('result')) child.emit('close', 0, null);
    await assert.rejects(running); assert.equal(fs.readdirSync(root).some(file => file.startsWith('compile-preprocess-')), false);
});

test('a created child retains its owner until close even after an error event', async t => {
    const root = fixture(t), child = new EventEmitter(); child.pid = 123;
    let settled = false;
    const environment = { ...process.env, AILY_BUILD_WORKSPACE_OWNER: 'owner' };
    const running = runCompilePreprocess({ currentProjectPath: root, code: '' }, root, path.join(root, 'result.json'),
        (_command, _args, options) => { assert.equal(options.env, environment); return child; }, environment);
    running.then(() => { settled = true; }, () => { settled = true; });
    child.emit('error', new Error('child error'));
    await Promise.resolve(); assert.equal(settled, false);
    child.emit('close', 1, null); await assert.rejects(running, /child error/);
});
