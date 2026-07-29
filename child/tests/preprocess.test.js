const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    collectLibraryPackages,
    normalizeExtractedSourceDirectory,
    processLibrariesParallel,
} = require('../scripts/preprocess');

function createPackage(packagePath, packageJson) {
    fs.mkdirSync(packagePath, { recursive: true });
    fs.writeFileSync(
        path.join(packagePath, 'package.json'),
        JSON.stringify(packageJson, null, 2)
    );
}

test('collects indirect libraries recursively without duplicates or cycles', t => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-preprocess-test-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));

    const miaouiPath = path.join(projectPath, 'node_modules', '@aily-project', 'lib-miaoui');
    const u8g2Path = path.join(projectPath, 'node_modules', '@aily-project', 'lib-u8g2');

    createPackage(miaouiPath, {
        name: '@aily-project/lib-miaoui',
        dependencies: {
            '@aily-project/lib-u8g2': '1.0.10',
        },
    });
    createPackage(u8g2Path, {
        name: '@aily-project/lib-u8g2',
        dependencies: {
            '@aily-project/lib-miaoui': '1.0.0',
        },
    });

    const result = collectLibraryPackages({
        '@aily-project/lib-miaoui': '^1.0.0',
        '@aily-project/lib-core-io': '1.0.0',
    }, projectPath);

    assert.deepEqual(result, [
        '@aily-project/lib-miaoui',
        '@aily-project/lib-u8g2',
    ]);
});

test('copies recursively collected libraries into the compiler libraries directory', async t => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-preprocess-test-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));

    const miaouiPath = path.join(projectPath, 'node_modules', '@aily-project', 'lib-miaoui');
    const u8g2Path = path.join(projectPath, 'node_modules', '@aily-project', 'lib-u8g2');
    const librariesPath = path.join(projectPath, '.temp', 'libraries');

    createPackage(miaouiPath, {
        name: '@aily-project/lib-miaoui',
        dependencies: {
            '@aily-project/lib-u8g2': '1.0.10',
        },
    });
    createPackage(u8g2Path, {
        name: '@aily-project/lib-u8g2',
        dependencies: {},
    });
    fs.mkdirSync(path.join(miaouiPath, 'src', 'MiaoUI'), { recursive: true });
    fs.writeFileSync(path.join(miaouiPath, 'src', 'MiaoUI', 'MiaoUI.h'), '#pragma once\n');
    fs.mkdirSync(path.join(u8g2Path, 'src', 'u8g2'), { recursive: true });
    fs.writeFileSync(path.join(u8g2Path, 'src', 'u8g2', 'U8g2lib.h'), '#pragma once\n');
    fs.mkdirSync(librariesPath, { recursive: true });

    const libraries = collectLibraryPackages({
        '@aily-project/lib-miaoui': '^1.0.0',
    }, projectPath);
    const copiedLibraries = await processLibrariesParallel(
        libraries,
        librariesPath,
        projectPath,
        '7za',
        false,
        {}
    );

    assert.deepEqual(copiedLibraries.sort(), ['MiaoUI', 'u8g2']);
    assert.equal(fs.existsSync(path.join(librariesPath, 'MiaoUI', 'MiaoUI.h')), true);
    assert.equal(fs.existsSync(path.join(librariesPath, 'u8g2', 'U8g2lib.h')), true);
});

test('normalizes extracted library archives into src directory', t => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-preprocess-test-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));

    const packagePath = path.join(projectPath, 'node_modules', '@aily-project', 'lib-miaoui');
    const sourcePath = path.join(packagePath, 'src');
    const flatExtractPath = path.join(packagePath, '.flat-extract');
    fs.mkdirSync(flatExtractPath, { recursive: true });
    fs.writeFileSync(path.join(flatExtractPath, 'MiaoUI.h'), '#pragma once\n');

    normalizeExtractedSourceDirectory(flatExtractPath, sourcePath);

    assert.equal(fs.existsSync(path.join(sourcePath, 'MiaoUI.h')), true);
    assert.equal(fs.existsSync(flatExtractPath), false);

    const nestedExtractPath = path.join(packagePath, '.nested-extract');
    fs.mkdirSync(path.join(nestedExtractPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(nestedExtractPath, 'src', 'MiaoUI.cpp'), 'void setup() {}\n');

    normalizeExtractedSourceDirectory(nestedExtractPath, sourcePath);

    assert.equal(fs.existsSync(path.join(sourcePath, 'MiaoUI.cpp')), true);
    assert.equal(fs.existsSync(path.join(sourcePath, 'MiaoUI.h')), false);
    assert.equal(fs.existsSync(path.join(nestedExtractPath, 'src')), false);

    const mixedExtractPath = path.join(packagePath, '.mixed-extract');
    fs.mkdirSync(path.join(mixedExtractPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mixedExtractPath, 'src', 'Nested.h'), '#pragma once\n');
    fs.writeFileSync(path.join(mixedExtractPath, 'README.md'), 'library notes\n');

    normalizeExtractedSourceDirectory(mixedExtractPath, sourcePath);

    assert.equal(fs.existsSync(path.join(sourcePath, 'src', 'Nested.h')), true);
    assert.equal(fs.existsSync(path.join(sourcePath, 'README.md')), true);
    assert.equal(fs.existsSync(mixedExtractPath), false);
});
