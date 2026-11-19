const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const test = require('node:test');
const { normalizeExtractedSourceDirectory, processLibrariesParallel } = require('../child/scripts/preprocess');

const outputRoot = process.env.AILY_PREPROCESS_ARCHIVE_TEST_ROOT
    ? path.resolve(process.env.AILY_PREPROCESS_ARCHIVE_TEST_ROOT)
    : path.resolve(__dirname, 'test-results/serial-dropdown-analysis-20261028/archive-tests');
const za7Path = path.resolve(__dirname, '../child/7za.exe');
const supported = process.platform === 'win32' && fs.existsSync(za7Path);

// Keep failure injection local to this module instance; production filesystem
// and extractor APIs (including other tests) are never monkey-patched.
function withExtractor(extract) {
    const filename = require.resolve('../child/scripts/preprocess');
    const nativeRequire = createRequire(filename);
    const isolatedModule = { exports: {} };
    const isolatedProcess = Object.create(process);
    isolatedProcess.on = () => {};
    const load = new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', fs.readFileSync(filename, 'utf8'));
    load(name => name === 'child_process'
        ? { ...nativeRequire(name), execFileSync: extract }
        : nativeRequire(name), isolatedModule, isolatedModule.exports, filename, path.dirname(filename), isolatedProcess);
    return isolatedModule.exports;
}

function assertNoExtractionResidue(f) {
    assert.deepEqual(fs.readdirSync(f.physicalPackage).filter(name => name.startsWith('.src-extract-')), []);
}

function fixture(t, { junction = false, nested = false } = {}) {
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, 'case-'));
    t.after(() => {
        assert.equal(path.dirname(root), outputRoot);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const packageName = '@aily-project/lib-archive-fixture';
    const logicalPackage = path.join(root, 'project/node_modules', packageName);
    const physicalPackage = junction ? path.join(root, 'local-libraries', packageName) : logicalPackage;
    const inputRoot = path.join(root, 'archive-input');
    const source = nested ? path.join(inputRoot, 'src') : inputRoot;
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(physicalPackage, { recursive: true });
    fs.writeFileSync(path.join(source, 'ArchiveFixture.h'), '#pragma once\n');
    fs.writeFileSync(path.join(source, 'ArchiveFixture.cpp'), 'int archive_fixture() { return 7; }\n');
    fs.writeFileSync(path.join(physicalPackage, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }));
    const archive = path.join(physicalPackage, 'src.7z');
    execFileSync(za7Path, ['a', '-t7z', archive, './*'], { cwd: inputRoot, stdio: 'pipe' });
    if (junction) {
        fs.mkdirSync(path.dirname(logicalPackage), { recursive: true });
        fs.symlinkSync(physicalPackage, logicalPackage, 'junction');
    }
    const archiveBytes = fs.readFileSync(archive);
    const libraries = path.join(root, 'project/.temp/libraries');
    return {
        root, packageName, logicalPackage, physicalPackage, archive, archiveBytes, libraries,
        run: (preprocess = { processLibrariesParallel }) => preprocess.processLibrariesParallel(
            [packageName], libraries, path.join(root, 'project'), za7Path, false, {}
        ),
    };
}

for (const junction of [false, true]) {
    for (const nested of [false, true]) {
        test(`extracts ${nested ? 'src-wrapped' : 'root-layout'} library archive from ${junction ? 'a real junction' : 'an ordinary directory'}`, { skip: !supported }, async t => {
            const f = fixture(t, { junction, nested });
            assert.deepEqual(await f.run(), ['lib-archive-fixture']);
            assert.equal(fs.readFileSync(path.join(f.physicalPackage, 'src/ArchiveFixture.h'), 'utf8'), '#pragma once\n');
            assert.equal(fs.readFileSync(path.join(f.libraries, 'lib-archive-fixture/ArchiveFixture.cpp'), 'utf8'), 'int archive_fixture() { return 7; }\n');
            assert.deepEqual(fs.readFileSync(f.archive), f.archiveBytes);
            assertNoExtractionResidue(f);
        });
    }
}

test('archive failure leaves the original inputs intact and does not publish partial source', { skip: !supported }, async t => {
    const f = fixture(t, { junction: true });
    const packageBytes = fs.readFileSync(path.join(f.physicalPackage, 'package.json'));
    const extractor = withExtractor((...args) => {
        execFileSync(...args);
        throw Object.assign(new Error('injected extraction failure'), { code: 'EIO' });
    });
    await assert.rejects(f.run(extractor), /@aily-project\/lib-archive-fixture: 解压失败: injected extraction failure/);
    assert.equal(fs.existsSync(path.join(f.physicalPackage, 'src')), false);
    assert.deepEqual(fs.readFileSync(f.archive), f.archiveBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.physicalPackage, 'package.json')), packageBytes);
    assertNoExtractionResidue(f);
});

test('an invalid archive cannot produce an empty successful library', { skip: !supported }, async t => {
    const f = fixture(t, { junction: true });
    fs.writeFileSync(f.archive, 'not a 7z archive');
    await assert.rejects(f.run(), /@aily-project\/lib-archive-fixture: 解压失败:/);
    assert.equal(fs.existsSync(path.join(f.physicalPackage, 'src')), false);
    assert.equal(fs.readFileSync(f.archive, 'utf8'), 'not a 7z archive');
    assertNoExtractionResidue(f);
});

test('rebinding the logical package aborts before publishing or modifying either source root', { skip: !supported }, async t => {
    const f = fixture(t, { junction: true });
    const replacement = path.join(f.root, 'replacement-package');
    fs.mkdirSync(path.join(replacement, 'src'), { recursive: true });
    fs.writeFileSync(path.join(replacement, 'src/keep.h'), 'replacement source');
    const extractor = withExtractor((...args) => {
        const output = args[1].find(arg => arg.startsWith('-o')).slice(2);
        assert.equal(fs.realpathSync(path.dirname(output)), fs.realpathSync(f.physicalPackage));
        execFileSync(...args);
        fs.unlinkSync(f.logicalPackage);
        fs.symlinkSync(replacement, f.logicalPackage, 'junction');
    });
    await assert.rejects(f.run(extractor), /Library package inputs changed during source extraction/);
    assert.equal(fs.existsSync(path.join(f.physicalPackage, 'src')), false);
    assert.equal(fs.readFileSync(path.join(replacement, 'src/keep.h'), 'utf8'), 'replacement source');
    assert.deepEqual(fs.readFileSync(f.archive), f.archiveBytes);
    assertNoExtractionResidue(f);
});

test('archive changes after extraction are rejected rather than published as the captured input', { skip: !supported }, async t => {
    const f = fixture(t, { junction: true });
    const extractor = withExtractor((...args) => {
        execFileSync(...args);
        fs.writeFileSync(f.archive, 'changed after extraction');
    });
    await assert.rejects(f.run(extractor), /Library package inputs changed during source extraction/);
    assert.equal(fs.existsSync(path.join(f.physicalPackage, 'src')), false);
    assert.equal(fs.readFileSync(f.archive, 'utf8'), 'changed after extraction');
    assertNoExtractionResidue(f);
});

test('a source directory created concurrently is preserved and not replaced by extraction', { skip: !supported }, async t => {
    const f = fixture(t, { junction: true });
    const extractor = withExtractor((...args) => {
        execFileSync(...args);
        fs.mkdirSync(path.join(f.physicalPackage, 'src'));
        fs.writeFileSync(path.join(f.physicalPackage, 'src/keep.h'), 'concurrent source');
    });
    await assert.rejects(f.run(extractor), /Library source destination appeared during archive extraction/);
    assert.equal(fs.readFileSync(path.join(f.physicalPackage, 'src/keep.h'), 'utf8'), 'concurrent source');
    assert.equal(fs.existsSync(path.join(f.physicalPackage, 'src/ArchiveFixture.h')), false);
    assert.deepEqual(fs.readFileSync(f.archive), f.archiveBytes);
    assertNoExtractionResidue(f);
});

test('normalization never removes an existing source directory', { skip: !supported }, t => {
    const f = fixture(t);
    const extractPath = path.join(f.physicalPackage, '.src-extract-normalization-fixture');
    const sourcePath = path.join(f.physicalPackage, 'src');
    fs.mkdirSync(extractPath);
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(extractPath, 'candidate.h'), 'candidate source');
    fs.writeFileSync(path.join(sourcePath, 'keep.h'), 'existing source');
    assert.throws(() => normalizeExtractedSourceDirectory(extractPath, sourcePath), /Library source destination appeared/);
    assert.equal(fs.readFileSync(path.join(sourcePath, 'keep.h'), 'utf8'), 'existing source');
    assert.equal(fs.readFileSync(path.join(extractPath, 'candidate.h'), 'utf8'), 'candidate source');
    assert.equal(fs.existsSync(path.join(sourcePath, 'candidate.h')), false);
});
