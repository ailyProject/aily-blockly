'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { acquireBuildWorkspace } = require('./build-workspace-lease');
const { publishArduinoGeneratedCode: publish, patchBuildMetadata: patch } = require('./build-workspace-publication');
const header = (content = 'const int a = 1;') => ({ fileName: 'variables_data-12345678.h', content, sourceTag: 'data' });

function fixture(t, type = 'blockly') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-publication-'));
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-build-publication-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write('package.json', JSON.stringify({ type, dependencies: { board: '1' }, unrelated: 'keep' }));
    return { root, write, read: name => fs.readFileSync(path.join(root, name), 'utf8'), exists: name => fs.existsSync(path.join(root, name)) };
}

function resolutionCommit(f, options = {}) {
    const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const generation = 'resolved-source', scope = { projectKey: f.root, pageId: 'main' };
    const token = `sha256:${'a'.repeat(64)}`, abi = '{"external":"retained raw ABI"}\r\n';
    const archive = { schemaVersion: 1, generation, authority: 'workspace', repairToken: token, scope,
        disk: { abi }, resolution: { token, choice: 'keep_view', inputAbiHash: hash(abi), ...options.resolution } };
    if (options.scope) archive.scope = options.scope;
    if (options.repairToken) archive.repairToken = options.repairToken;
    const archiveKey = `recoveries/${generation}.json`, rawArchive = JSON.stringify(archive);
    f.write(`.aily/abs-sync/${archiveKey}`, rawArchive);
    // The publisher reads only the hash-bound metadata, never decodes or uses
    // this deliberately opaque snapshot as code or project-write authority.
    const context = { generation, baselineRef: `baselines/${generation}.json`, scope };
    const record = { ...(options.legacy ? { schemaVersion: 1, projection: { map: context } }
        : { schemaVersion: 2, snapshot: 'opaque-not-decoded', context }),
        recoveryArchive: { key: archiveKey, hash: hash(rawArchive) } };
    if (options.ordinary) delete record.recoveryArchive;
    const rawRecord = JSON.stringify(record), baseline = `.aily/abs-sync/baselines/${generation}.json`;
    f.write(baseline, rawRecord);
    f.write('.aily/abs-sync/committed.json', JSON.stringify({ schemaVersion: 1, generation, hash: hash(rawRecord) }));
    return { archive: `.aily/abs-sync/${archiveKey}`, baseline };
}

test('publishes headers and sketch together, removes only owned names, leaves firmware bytes intact', t => {
    const f = fixture(t);
    for (const name of ['src/user.h', 'src/objects_old-abcdef12.h', '.temp/sketch/generated/objects_old-abcdef12.h',
        '.temp/sketch/generated/user.h', '.build/aily-artifact-manifest.json', '.build/aily-build-delivery.json', '.build/firmware.elf']) f.write(name, 'old');
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'sketch' }), { changed: true });
    assert.equal(f.read('src/variables_data-12345678.h'), header().content);
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'sketch');
    assert.equal(f.read('src/user.h'), 'old'); assert.equal(f.read('.temp/sketch/generated/user.h'), 'old');
    for (const name of ['src/objects_old-abcdef12.h', '.temp/sketch/generated/objects_old-abcdef12.h', '.build/aily-artifact-manifest.json', '.build/aily-build-delivery.json', '.build/aily-workspace.lock']) assert.equal(f.exists(name), false);
    assert.equal(f.read('.build/firmware.elf'), 'old');
});

test('identical publication does not touch inputs, old success tickets or their mtimes', t => {
    const f = fixture(t); publish(f.root, { artifacts: [header()], sketchCode: 'sketch' });
    f.write('.build/aily-artifact-manifest.json', 'success');
    const before = fs.statSync(path.join(f.root, 'src', header().fileName));
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'sketch' }), { changed: false });
    assert.equal(fs.statSync(path.join(f.root, 'src', header().fileName)).mtimeMs, before.mtimeMs);
    assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

for (const operation of ['compile', 'preprocess']) test(`${operation} owner blocks all publication before changing any file`, t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, operation);
    f.write('src/user.h', 'keep'); f.write('.temp/sketch/sketch.ino', 'keep');
    const pkg = f.read('package.json');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /BUILD_WORKSPACE_BUSY/);
    assert.throws(() => patch(f.root, { codeHash: 'a'.repeat(64) }), /BUILD_WORKSPACE_BUSY/);
    assert.equal(f.read('package.json'), pkg); assert.equal(f.read('.temp/sketch/sketch.ino'), 'keep');
    assert.equal(f.exists(`src/${header().fileName}`), false); lease.release();
});

test('actual compile/preprocess processes cannot enter while publication owns the workspace', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.root, 'publish');
    const filename = path.join(f.root, 'request.json'); f.write('request.json', JSON.stringify({ currentProjectPath: f.root }));
    for (const command of ['compile', 'preprocess']) {
        const result = spawnSync(process.execPath, [path.join(__dirname, `${command}.js`), filename], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, 1); assert.match(result.stderr, /BUILD_WORKSPACE_BUSY/);
    }
    owner.release();
});

test('invalid namespace, duplicates, wrong project mode and oversized lists fail without partial writes', t => {
    const f = fixture(t);
    const invalid = [[header(), { ...header(), fileName: '../user.h' }], [header(), header()], Array(257).fill(header())];
    for (const artifacts of invalid) assert.throws(() => publish(f.root, { artifacts }), /BUILD_PUBLICATION_INVALID/);
    assert.equal(f.exists('src'), false);
    f.write('package.json', '{"type":"coder"}');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /only for Blockly/);
    assert.equal(f.exists('src'), false); assert.equal(f.exists('.build/aily-workspace.lock'), false);
    for (const value of ['null', '[]']) {
        f.write('package.json', value);
        assert.throws(() => publish(f.root, { artifacts: [header()] }), /Invalid project manifest/);
    }
    fs.unlinkSync(path.join(f.root, 'package.json'));
    assert.throws(() => publish(f.root, { artifacts: [header()] }), /package.json is missing/);
    assert.equal(f.exists('src'), false);
});

for (const directory of ['src', '.temp', '.temp/sketch', '.temp/sketch/generated']) test(`refuses ${directory} junction without changing external targets or tickets`, t => {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const link = path.join(f.root, directory); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link, 'junction');
    f.write('.build/aily-artifact-manifest.json', 'success');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /linked/);
    assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

test('refuses hardlinked generated headers before invalidating the previous success', t => {
    const f = fixture(t); f.write('other.h', 'keep'); fs.mkdirSync(path.join(f.root, 'src'));
    fs.linkSync(path.join(f.root, 'other.h'), path.join(f.root, 'src', header().fileName));
    f.write('.build/aily-artifact-manifest.json', 'success');
    assert.throws(() => publish(f.root, { artifacts: [header()] }), /linked/);
    assert.equal(f.read('other.h'), 'keep'); assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

test('metadata patches preserve the root manifest and success ticket, ignoring a damaged legacy backup', t => {
    const f = fixture(t), legacy = '{ invalid old backup'; f.write('.temp/package.json', legacy);
    f.write('.build/aily-artifact-manifest.json', 'success');
    const info = { lastBuildTime: new Date().toISOString(), lastBuildCode: 'b'.repeat(64), lastBuildStatus: 'success', lastBuildDuration: 1 };
    const result = patch(f.root, { codeHash: 'a'.repeat(64), buildInfo: info });
    assert.equal(result.unrelated, 'keep'); assert.deepEqual(result.dependencies, { board: '1' });
    assert.equal(f.read('.temp/package.json'), legacy);
    assert.deepEqual(JSON.parse(f.read('package.json')).buildInfo, info);
    assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
    assert.equal(f.exists('.build/aily-workspace.lock'), false);
});

for (const type of ['blockly', 'coder']) test(`${type} metadata does not create a package backup; unrelated fields are not patchable`, t => {
    const f = fixture(t, type); patch(f.root, { codeHash: 'a'.repeat(64) });
    assert.equal(f.exists('.temp'), false);
    const original = f.read('package.json');
    for (const change of [{ dependencies: {} }, { codeHash: 'bad' }, { buildInfo: {} }]) assert.throws(() => patch(f.root, change), /BUILD_PUBLICATION_INVALID/);
    assert.equal(f.read('package.json'), original);
});

test('preserving publication archives only superseded source bytes with a verified readable manifest', t => {
    const f = fixture(t), old = new Map([
        ['src/variables_data-12345678.h', Buffer.from('manual old header\r\n')],
        ['src/objects_stale-abcdef12.h', Buffer.from('removed old header')],
        ['.temp/sketch/generated/variables_legacy-abcdef12.h', Buffer.from('legacy old header')],
        ['.temp/sketch/sketch.ino', Buffer.from([0xff, 0xfe, 0x0a, 0x00, 0x61])],
    ]);
    for (const [name, value] of old) f.write(name, value);
    const same = { fileName: 'objects_same-abcdef12.h', content: 'unchanged', sourceTag: 'same' };
    f.write(`src/${same.fileName}`, same.content);
    for (const name of ['src/user.h', '.temp/sketch/generated/user.h', 'node_modules/library/cache', '.build/firmware.bin']) f.write(name, 'untouched');
    const result = publish(f.root, { artifacts: [header('new header'), same], sketchCode: 'new sketch', preserveSuperseded: true });
    assert.equal(result.changed, true); assert.equal(result.sourceArchive.version, 1);
    const raw = fs.readFileSync(path.join(f.root, result.sourceArchive.manifest));
    assert.equal(result.sourceArchive.hash, `sha256:${createHash('sha256').update(raw).digest('hex')}`);
    const manifest = JSON.parse(raw), directory = path.dirname(result.sourceArchive.manifest);
    assert.equal(manifest.kind, 'superseded-generated-source'); assert.equal(manifest.version, 1);
    assert.equal(result.sourceArchive.fileCount, old.size); assert.equal(manifest.files.length, old.size);
    assert.deepEqual(manifest.files.map(file => file.path).sort(), [...old.keys()].sort());
    let bytes = 0;
    for (const file of manifest.files) {
        const content = fs.readFileSync(path.join(f.root, directory, file.archivedPath));
        assert.deepEqual(content, old.get(file.path)); bytes += content.length;
        assert.equal(file.bytes, content.length);
        assert.equal(file.hash, `sha256:${createHash('sha256').update(content).digest('hex')}`);
        assert.equal(file.operation, file.path.includes('stale') || file.path.includes('legacy') ? 'remove' : 'replace');
    }
    assert.equal(bytes, result.sourceArchive.bytes);
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'new sketch'); assert.equal(f.read(`src/${header().fileName}`), 'new header');
    assert.equal(f.exists('src/objects_stale-abcdef12.h'), false);
    assert.equal(f.exists('.temp/sketch/generated/variables_legacy-abcdef12.h'), false);
    for (const name of ['src/user.h', '.temp/sketch/generated/user.h', 'node_modules/library/cache', '.build/firmware.bin']) assert.equal(f.read(name), 'untouched');
    const files = fs.readdirSync(path.join(f.root, directory), { recursive: true }).filter(name => fs.statSync(path.join(f.root, directory, name)).isFile());
    assert.equal(files.length, old.size + 1);
});

test('preservation creates no archive for new-only or identical publication', t => {
    const f = fixture(t);
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'new', preserveSuperseded: true }), { changed: true });
    assert.equal(f.exists('.aily/generated-source-archives'), false);
    f.write('.build/aily-build-delivery.json', 'success');
    const before = fs.statSync(path.join(f.root, '.temp/sketch/sketch.ino')).mtimeMs;
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'new', preserveSuperseded: true }), { changed: false });
    assert.equal(f.exists('.aily/generated-source-archives'), false);
    assert.equal(fs.statSync(path.join(f.root, '.temp/sketch/sketch.ino')).mtimeMs, before);
    assert.equal(f.read('.build/aily-build-delivery.json'), 'success');
});

for (const reason of ['unwritable', 'linked']) test(`archive ${reason} failure preserves every source and success ticket`, t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'manual source'); f.write(`src/${header().fileName}`, 'manual header');
    f.write('.build/aily-build-delivery.json', 'success');
    if (reason === 'unwritable') f.write('.aily/generated-source-archives', 'not a directory');
    else {
        const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.mkdirSync(path.join(f.root, '.aily'), { recursive: true });
        fs.symlinkSync(outside, path.join(f.root, '.aily/generated-source-archives'), 'junction');
    }
    assert.throws(() => publish(f.root, { artifacts: [header('new')], sketchCode: 'new', preserveSuperseded: true }));
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'manual source'); assert.equal(f.read(`src/${header().fileName}`), 'manual header');
    assert.equal(f.read('.build/aily-build-delivery.json'), 'success');
    assert.equal(f.exists('.build/aily-workspace.lock'), false);
    if (reason === 'linked') assert.deepEqual(fs.readdirSync(path.join(f.root, 'outside')), []);
});

test('a mid-archive write failure cannot overwrite sources or invalidate the successful build', t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'manual sketch'); f.write(`src/${header().fileName}`, 'manual header');
    f.write('.build/aily-build-delivery.json', 'success');
    const open = fs.openSync;
    fs.openSync = (filename, ...args) => {
        if (typeof filename === 'string' && filename.includes('generated-source-archives') && filename.endsWith('sketch.ino')) throw new Error('Injected archive write failure');
        return open(filename, ...args);
    };
    try { assert.throws(() => publish(f.root, { artifacts: [header('new')], sketchCode: 'new', preserveSuperseded: true }), /archive write failure/); }
    finally { fs.openSync = open; }
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'manual sketch'); assert.equal(f.read(`src/${header().fileName}`), 'manual header');
    assert.equal(f.read('.build/aily-build-delivery.json'), 'success'); assert.equal(f.exists('.build/aily-workspace.lock'), false);
});

for (const target of ['existing', 'new']) test(`preserving publication rejects ${target} source changes during archival before overwriting`, t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'old sketch');
    if (target === 'existing') f.write(`src/${header().fileName}`, 'old header');
    f.write('.build/aily-build-delivery.json', 'success');
    const write = fs.writeFileSync; let changed = false;
    fs.writeFileSync = (filename, ...args) => {
        const result = write(filename, ...args);
        if (!changed && typeof filename === 'number') { changed = true; f.write(`src/${header().fileName}`, 'new external header'); }
        return result;
    };
    try { assert.throws(() => publish(f.root, { artifacts: [header('new')], sketchCode: 'new', preserveSuperseded: true }), /changed during preservation/); }
    finally { fs.writeFileSync = write; }
    assert.equal(changed, true); assert.equal(f.read(`src/${header().fileName}`), 'new external header');
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'old sketch'); assert.equal(f.read('.build/aily-build-delivery.json'), 'success');
});

test('preservation never bypasses an active build owner and rejects malformed preservation flags', t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'old');
    const owner = acquireBuildWorkspace(f.root, 'compile');
    try { assert.throws(() => publish(f.root, { artifacts: [], sketchCode: 'new', preserveSuperseded: true }), /BUILD_WORKSPACE_BUSY/); }
    finally { owner.release(); }
    for (const flag of [false, 1, 'true', {}]) assert.throws(() => publish(f.root, { sketchCode: 'new', preserveSuperseded: flag }), /preservation option/);
    assert.equal(f.exists('.aily/generated-source-archives'), false); assert.equal(f.read('.temp/sketch/sketch.ino'), 'old');
});

test('the lazy Electron bridge refuses old child implementations rather than ignoring preservation', t => {
    const f = fixture(t), resolver = require('../../electron/child-script-path');
    const old = resolver.childScriptPath, bridgePath = require.resolve('../../electron/build-workspace-publication');
    f.write('scripts/build-workspace-publication.js', 'module.exports = { publishArduinoGeneratedCode() { throw new Error("old implementation invoked"); } };');
    resolver.childScriptPath = name => path.join(f.root, 'scripts', name); delete require.cache[bridgePath];
    try {
        const bridge = require('../../electron/build-workspace-publication');
        assert.equal(bridge.GENERATED_SOURCE_ARCHIVE_VERSION, 1);
        assert.throws(() => bridge.publishArduinoGeneratedCode(f.root, { artifacts: [], preserveSuperseded: true }), /restart the host/);
    } finally { resolver.childScriptPath = old; delete require.cache[bridgePath]; }
});

test('a post-archive publication failure retains failure semantics and exposes the verified archive through an Error message', t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'manual sketch'); f.write(`src/${header().fileName}`, 'manual header');
    const rename = fs.renameSync; let failure;
    fs.renameSync = (source, target) => {
        if (path.basename(target) === 'sketch.ino') throw Object.assign(new Error('Injected source write failure'), { code: 'EACCES' });
        return rename(source, target);
    };
    try { publish(f.root, { artifacts: [header('new')], sketchCode: 'new', preserveSuperseded: true }); }
    catch (error) { failure = error; }
    finally { fs.renameSync = rename; }
    assert.ok(failure); assert.equal(failure.code, 'EACCES'); assert.match(failure.message, /^Injected source write failure/);
    const receipt = failure.message.match(/Preserved generated source archive: ([^\s]+) \((sha256:[a-f0-9]{64})\)/);
    assert.ok(receipt); const manifest = fs.readFileSync(path.join(f.root, receipt[1]));
    assert.equal(`sha256:${createHash('sha256').update(manifest).digest('hex')}`, receipt[2]);
    const directory = path.dirname(receipt[1]), files = JSON.parse(manifest).files;
    const archived = filename => fs.readFileSync(path.join(f.root, directory, files.find(file => file.path === filename).archivedPath), 'utf8');
    assert.equal(archived('.temp/sketch/sketch.ino'), 'manual sketch'); assert.equal(archived(`src/${header().fileName}`), 'manual header');
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'manual sketch'); assert.equal(f.exists('.build/aily-workspace.lock'), false);
});

for (const choice of ['keep_view', 'replace_view']) test(`a committed ${choice} proof preserves old sources after restart without the renderer flag`, t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'manual sketch'); f.write(`src/${header().fileName}`, 'manual header');
    resolutionCommit(f, { resolution: { choice } });
    const pointer = f.read('.aily/abs-sync/committed.json');
    const result = publish(f.root, { artifacts: [header('new')], sketchCode: 'new' });
    assert.equal(result.changed, true); assert.equal(result.sourceArchive.fileCount, 2);
    const manifest = JSON.parse(f.read(result.sourceArchive.manifest));
    for (const entry of manifest.files) {
        const text = f.read(`${path.dirname(result.sourceArchive.manifest)}/${entry.archivedPath}`);
        assert.equal(text, entry.path === '.temp/sketch/sketch.ino' ? 'manual sketch' : 'manual header');
    }
    assert.equal(f.read('.aily/abs-sync/committed.json'), pointer);
    assert.deepEqual(publish(f.root, { artifacts: [header('new')], sketchCode: 'new' }), { changed: false });
    assert.equal(fs.readdirSync(path.join(f.root, '.aily/generated-source-archives')).length, 1);
});

for (const fault of ['baseline-hash', 'archive-hash', 'missing-archive', 'scope', 'token', 'input-hash', 'choice']) {
    test(`invalid ${fault} resolution chain refuses publication without guessing or touching sources`, t => {
        const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'manual sketch'); f.write('.build/aily-build-delivery.json', 'success');
        const options = fault === 'scope' ? { scope: { projectKey: path.dirname(f.root), pageId: 'main' } }
            : fault === 'token' ? { repairToken: `sha256:${'b'.repeat(64)}` }
            : fault === 'input-hash' ? { resolution: { inputAbiHash: `sha256:${'b'.repeat(64)}` } }
            : fault === 'choice' ? { resolution: { choice: 'guess' } } : {};
        const chain = resolutionCommit(f, options);
        if (fault === 'baseline-hash') f.write(chain.baseline, f.read(chain.baseline) + ' ');
        if (fault === 'archive-hash') f.write(chain.archive, f.read(chain.archive) + ' ');
        if (fault === 'missing-archive') fs.unlinkSync(path.join(f.root, chain.archive));
        assert.throws(() => publish(f.root, { artifacts: [], sketchCode: 'new' }), /BUILD_PUBLICATION_INVALID/);
        assert.equal(f.read('.temp/sketch/sketch.ino'), 'manual sketch'); assert.equal(f.read('.build/aily-build-delivery.json'), 'success');
        assert.equal(f.exists('.aily/generated-source-archives'), false); assert.equal(f.exists('.build/aily-workspace.lock'), false);
    });
}

for (const legacy of [false, true]) test(`a normal schema-${legacy ? 1 : 2} committed generation does not make ordinary publication archival`, t => {
    const f = fixture(t); f.write('.temp/sketch/sketch.ino', 'old'); resolutionCommit(f, { ordinary: true, legacy });
    assert.deepEqual(publish(f.root, { artifacts: [], sketchCode: 'new' }), { changed: true });
    assert.equal(f.exists('.aily/generated-source-archives'), false);
});
