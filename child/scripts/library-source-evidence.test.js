const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { createLibraryProjectionRecorder, confirmLibraryProjections, writeLibraryProjections, readLibraryProjections } = require('./library-source-evidence');
const { processLibrariesParallel, processComponentLibraries, resolveCoderLibrarySearchPaths } = require('./preprocess');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-library-evidence-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^aily-library-evidence-/); fs.rmSync(root, { recursive: true, force: true }); });
    const put = (filename, text) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); };
    const name = '@aily-project/lib-unit', packagePath = path.join(root, 'node_modules', name);
    const source = path.join(packagePath, 'src/Unit'), target = path.join(root, '.temp/libraries');
    put(path.join(source, 'Unit.h'), '#define VALUE 17'); put(path.join(packagePath, 'package.json'), JSON.stringify({ name }));
    fs.mkdirSync(path.join(root, '.build'));
    const config = { currentProjectPath: root, code: '#include <Unit.h>' };
    const libs = [{ packageName: name, packagePath }];
    return { root, put, name, packagePath, source, target, config, libs };
}

test('ordinary library cache repairs a changed/missing projection instead of accepting a directory', async t => {
    const f = fixture(t), cache = {};
    const run = () => processLibrariesParallel(f.libs, f.target, f.root, '', false, cache);
    await run();
    const header = path.join(f.target, 'Unit/Unit.h');
    // Break the legacy hard link: only the derived target changes.
    fs.unlinkSync(header); f.put(header, 'stale'); f.put(path.join(f.target, 'Unit/stale.h'), 'old');
    await run();
    assert.equal(fs.readFileSync(header, 'utf8'), '#define VALUE 17');
    assert.equal(fs.existsSync(path.join(f.target, 'Unit/stale.h')), false);
    fs.unlinkSync(header); await run(); assert.equal(fs.existsSync(header), true);
});

test('Windows unavailable path device uses descriptor identity without accepting changed content or file identity', { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder();
    recorder.add(f.name, recorder.capture(f.source), f.source);
    const record = recorder.snapshot(f.config), stat = fs.statSync;
    t.mock.method(fs, 'statSync', (...args) => { const value = stat(...args); value.dev = 0; return value; });
    assert.equal(confirmLibraryProjections(record).count, 1);
    f.put(path.join(f.source, 'Unit.h'), '#define VALUE 18');
    assert.throws(() => confirmLibraryProjections(record), /changed/);
});

test('path-to-descriptor replacement is rejected and its handle is closed', t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder(), fstat = fs.fstatSync, close = fs.closeSync;
    let opened = 0, closed = 0;
    t.mock.method(fs, 'fstatSync', (...args) => { const value = fstat(...args); opened++; value.ino = -1; return value; });
    t.mock.method(fs, 'closeSync', fd => { closed++; return close(fd); });
    assert.throws(() => recorder.capture(f.source), /changed before reading/);
    assert.equal(opened, 1); assert.equal(closed, 1);
});

test('a library file growing during capture cannot exceed its captured byte budget', t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder();
    t.mock.method(fs, 'readSync', (_fd, buffer) => buffer.fill(0).length);
    assert.throws(() => recorder.capture(f.source), /grew while hashing/);
});

test('recorded Blockly libraries are independent copies with source/package/target binding', async t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder();
    // Include migration from existing hard links.
    await processLibrariesParallel(f.libs, f.target, f.root, '', false, {});
    await processLibrariesParallel(f.libs, f.target, f.root, '', false, {}, recorder);
    const record = recorder.snapshot(f.config);
    assert.equal(record.entries.length, 1);
    assert.notEqual(fs.statSync(path.join(f.source, 'Unit.h')).ino, fs.statSync(path.join(f.target, 'Unit/Unit.h')).ino);
    writeLibraryProjections(f.config, recorder);
    assert.equal(readLibraryProjections(f.config).digest, record.digest);
    f.put(path.join(f.target, 'Unit/Unit.h'), 'changed target');
    assert.equal(fs.readFileSync(path.join(f.source, 'Unit.h'), 'utf8'), '#define VALUE 17');
    assert.throws(() => confirmLibraryProjections(record), /changed/);
});

for (const change of ['source', 'package', 'delete', 'alias']) test(`projection invalidates changed ${change}`, async t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder();
    await processLibrariesParallel(f.libs, f.target, f.root, '', false, {}, recorder);
    const record = recorder.snapshot(f.config);
    if (change === 'source') f.put(path.join(f.source, 'Unit.h'), '#define VALUE 18');
    if (change === 'package') f.put(path.join(f.packagePath, 'package.json'), '{}');
    if (change === 'delete') fs.unlinkSync(path.join(f.source, 'Unit.h'));
    if (change === 'alias') {
        const previous = path.join(f.root, 'old-package'); fs.renameSync(f.packagePath, previous);
        f.put(path.join(f.packagePath, 'src/Unit/Unit.h'), '#define VALUE 17');
        f.put(path.join(f.packagePath, 'package.json'), JSON.stringify({ name: f.name }));
    }
    assert.throws(() => confirmLibraryProjections(record));
});

test('components explicitly supersede a package projection while conflicting packages fail', async t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder();
    await processLibrariesParallel(f.libs, f.target, f.root, '', false, {}, recorder);
    const component = path.join(f.root, 'components/Unit'); f.put(path.join(component, 'Unit.h'), 'local');
    await processComponentLibraries([{ name: 'Unit', sourcePath: component }], f.target, recorder);
    assert.equal(recorder.snapshot(f.config).entries[0].owner, 'component:Unit');
    assert.equal(fs.readFileSync(path.join(f.target, 'Unit/Unit.h'), 'utf8'), 'local');
    const collision = createLibraryProjectionRecorder();
    collision.add('one', collision.capture(f.source), f.source);
    assert.throws(() => collision.add('two', collision.capture(f.source), f.source), /same library/);
});

test('Coder records direct source and editable local libraries without projecting into .temp', async t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder(), locals = path.join(f.root, 'sketch/libraries');
    f.put(path.join(locals, 'Local/Local.h'), 'local');
    const search = await resolveCoderLibrarySearchPaths(f.libs, f.root, '', locals, recorder);
    const record = recorder.snapshot(f.config);
    assert.equal(record.entries.length, 2);
    assert.ok(record.entries.every(entry => entry.source.location === entry.target.location));
    assert.ok(search.includes(fs.realpathSync(path.join(f.packagePath, 'src'))));
    assert.equal(fs.existsSync(f.target), false);
    f.put(path.join(locals, 'Local/Local.h'), 'changed');
    assert.throws(() => confirmLibraryProjections(record), /changed/);
});

test('archive used for extraction remains part of the projection checkpoint', t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder(), archive = path.join(f.packagePath, 'src.7z');
    f.put(archive, 'archive fixture');
    const archiveBefore = recorder.capture(archive);
    recorder.add(f.name, recorder.capture(f.source), f.source, [archiveBefore]);
    const record = recorder.snapshot(f.config);
    f.put(archive, 'changed archive');
    assert.throws(() => confirmLibraryProjections(record), /changed/);
});

test('actual source archive extraction binds the archive, extracted tree and prepared copy', async t => {
    const executable = path.resolve(__dirname, '../7za.exe');
    if (!fs.existsSync(executable)) { t.skip('Bundled 7za is required for the archive integration check.'); return; }
    const f = fixture(t), recorder = createLibraryProjectionRecorder(), archive = path.join(f.packagePath, 'src.7z');
    const sourceRoot = path.join(f.packagePath, 'src');
    execFileSync(executable, ['a', archive, '.'], { cwd: sourceRoot, windowsHide: true, stdio: 'ignore' });
    assert.ok(sourceRoot.startsWith(f.root + path.sep));
    fs.rmSync(sourceRoot, { recursive: true });
    await processLibrariesParallel(f.libs, f.target, f.root, executable, false, {}, recorder);
    const record = recorder.snapshot(f.config);
    assert.equal(record.entries[0].inputs.length, 2);
    assert.equal(fs.readFileSync(path.join(f.target, 'Unit/Unit.h'), 'utf8'), '#define VALUE 17');
    fs.appendFileSync(archive, 'changed');
    assert.throws(() => confirmLibraryProjections(record), /changed/);
});

test('record rejects source mismatch, tampered digest, wrong build request and link escape', t => {
    const f = fixture(t), recorder = createLibraryProjectionRecorder(), other = path.join(f.root, 'other');
    f.put(path.join(other, 'Unit.h'), 'different');
    assert.throws(() => recorder.add('unit', recorder.capture(f.source), other), /mismatch/);
    recorder.add('unit', recorder.capture(f.source), f.source);
    const record = recorder.snapshot(f.config); record.digest = '0'.repeat(64);
    assert.throws(() => confirmLibraryProjections(record), /digest/);
    writeLibraryProjections(f.config, recorder);
    assert.throws(() => readLibraryProjections({ ...f.config, code: 'different' }), /another build/);
    fs.symlinkSync(other, path.join(f.source, 'escape'), 'junction');
    assert.throws(() => recorder.capture(f.source), /escapes/);
});

test('projection refuses a destination junction without deleting its external contents', async t => {
    const f = fixture(t), outside = path.join(f.root, 'outside');
    f.put(path.join(outside, 'Unit/keep.h'), 'keep');
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    fs.symlinkSync(outside, f.target, 'junction');
    await assert.rejects(processLibrariesParallel(f.libs, f.target, f.root, '', false, {}, createLibraryProjectionRecorder()), /junction/);
    assert.equal(fs.readFileSync(path.join(outside, 'Unit/keep.h'), 'utf8'), 'keep');
});
