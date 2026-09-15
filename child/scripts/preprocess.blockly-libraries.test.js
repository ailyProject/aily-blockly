const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    collectDependencyLibraryPackages,
    prependSdkLibrarySearchPath,
    processLibrariesParallel,
} = require('./preprocess');

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aily-blockly-preprocess-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageName = '@aily-project/lib-espnow';
    const packageRoot = path.join(root, 'node_modules', packageName);
    const source = path.join(packageRoot, 'src', 'AilyEspNow');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName, version: '0.0.1', main: 'generator.js', aily: { type: 'blockly-library' }
    }));
    await writeFile(path.join(source, 'AilyEspNow.h'), '#pragma once');
    const libraries = path.join(root, '.temp', 'libraries');
    const packages = collectDependencyLibraryPackages({ [packageName]: 'file:local-libraries/@aily-project/lib-espnow' }, root);
    const materialize = () => processLibrariesParallel(packages, libraries, root, '', false, {});
    return { root, source, libraries, materialize };
}

test('Blockly stages a canonical library without additional builder metadata', async t => {
    const { libraries, materialize } = await fixture(t);
    assert.deepEqual(await materialize(), ['AilyEspNow']);
    assert.equal(await readFile(path.join(libraries, 'AilyEspNow', 'AilyEspNow.h'), 'utf8'), '#pragma once');
});

test('Blockly prepends SDK Arduino libraries while keeping project libraries as overrides', async t => {
    const { root, libraries } = await fixture(t);
    const sdkRoot = path.join(root, 'sdk', 'ci13xx_1.0.17');
    const sdkLibraries = path.join(sdkRoot, 'libraries');
    await mkdir(path.join(sdkLibraries, 'ChipIntelliAudio'), { recursive: true });

    assert.deepEqual(prependSdkLibrarySearchPath(sdkRoot, [libraries]), [sdkLibraries, libraries]);
    assert.deepEqual(
        prependSdkLibrarySearchPath(sdkRoot, [sdkLibraries, libraries]),
        [sdkLibraries, libraries]
    );
});

test('Blockly leaves search paths unchanged when the board SDK has no libraries directory', async t => {
    const { root, libraries } = await fixture(t);
    assert.deepEqual(prependSdkLibrarySearchPath(path.join(root, 'sdk', 'without-libraries'), [libraries]), [libraries]);
});

test('Blockly follows project node_modules links to canonical local libraries outside the project', async t => {
    const { root } = await fixture(t);
    const project = path.join(root, 'project');
    const linkedPackageName = '@aily-project/lib-linked';
    const nestedPackageName = '@aily-project/lib-linked-support';
    const linkedPackage = path.join(root, 'local-library-store', 'lib-linked');
    const nestedPackage = path.join(linkedPackage, 'node_modules', nestedPackageName);
    const projectPackage = path.join(project, 'node_modules', linkedPackageName);
    const libraries = path.join(project, '.temp', 'libraries');

    await mkdir(path.join(linkedPackage, 'src', 'Linked'), { recursive: true });
    await mkdir(path.join(nestedPackage, 'src', 'LinkedSupport'), { recursive: true });
    await writeFile(path.join(linkedPackage, 'src', 'Linked', 'Linked.h'), '#pragma once\n');
    await writeFile(path.join(nestedPackage, 'src', 'LinkedSupport', 'LinkedSupport.h'), '#pragma once\n');
    await writeFile(path.join(linkedPackage, 'package.json'), JSON.stringify({
        name: linkedPackageName,
        version: '1.0.0',
        dependencies: { [nestedPackageName]: '1.0.0' },
    }));
    await writeFile(path.join(nestedPackage, 'package.json'), JSON.stringify({
        name: nestedPackageName,
        version: '1.0.0',
        dependencies: {},
    }));
    await mkdir(path.dirname(projectPackage), { recursive: true });
    await symlink(linkedPackage, projectPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const blocklyPackages = collectDependencyLibraryPackages({ [linkedPackageName]: 'file:../lib-linked' }, project);
    assert.deepEqual(blocklyPackages.map(item => item.packageName), [linkedPackageName, nestedPackageName]);
    assert.equal(blocklyPackages[0].packagePath, projectPackage);
    assert.equal(await realpath(blocklyPackages[0].packagePath), await realpath(linkedPackage));
    assert.deepEqual(
        (await processLibrariesParallel(blocklyPackages, libraries, project, '', false, {})).sort(),
        ['Linked', 'LinkedSupport']
    );
    assert.equal(await readFile(path.join(libraries, 'Linked', 'Linked.h'), 'utf8'), '#pragma once\n');
    assert.equal(
        await readFile(path.join(libraries, 'LinkedSupport', 'LinkedSupport.h'), 'utf8'),
        '#pragma once\n'
    );

    // The relaxed link handling belongs to Blockly only. Coder still refuses a
    // dependency whose canonical package root escapes the project boundary.
    assert.deepEqual(
        collectDependencyLibraryPackages({ [linkedPackageName]: 'file:../lib-linked' }, project, true),
        []
    );
});

test('a nested library copy failure stops preprocessing with the package identity', async t => {
    const { root, source, materialize } = await fixture(t);
    const target = path.join(root, 'removed-source');
    await mkdir(target);
    await symlink(target, path.join(source, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
    await rm(target, { recursive: true });
    await assert.rejects(materialize(), /Library source preparation failed:[\s\S]*@aily-project\/lib-espnow:[\s\S]*ENOENT/);
});

test('an invalid source tree cannot degrade to a successful empty library list', async t => {
    const { source, materialize } = await fixture(t);
    await rm(path.dirname(source), { recursive: true });
    await writeFile(path.dirname(source), 'not a source directory');
    await assert.rejects(materialize(), /Library source preparation failed:[\s\S]*@aily-project\/lib-espnow:/);
});
