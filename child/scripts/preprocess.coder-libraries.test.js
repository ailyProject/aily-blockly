const assert = require('node:assert/strict');
const { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    collectDependencyLibraryPackages,
    resolveCoderLibrarySearchPaths,
} = require('./preprocess');

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aily-coder-preprocess-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root };
}

async function packageSource(root, packageName, relativeFile, content) {
    const target = path.join(root, 'node_modules', packageName, 'src', relativeFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
}

test('Coder passes both npm scopes from their package-local final src roots', async t => {
    const { root } = await fixture(t);
    await packageSource(root, '@aily-project/lib-wrapped', 'src/src/Display/Display.h', 'aily');
    await packageSource(root, '@aily-project/lib-wrapped', 'src/src/Support/Support.h', 'support');
    await writeFile(path.join(root, 'node_modules', '@aily-project/lib-wrapped', 'src', '.DS_Store'), 'ignored');
    await packageSource(root, '@aily-project-coder/lib-direct', 'Direct.h', 'official');
    await packageSource(root, '@aily-project-coder/lib-direct', 'library.properties', 'name=Direct');

    const dependencies = {
        '@aily-project/lib-wrapped': '1.0.0',
        '@aily-project-coder/lib-direct': '2.0.0',
        '@aily-project/lib-meta': '3.0.0',
    };
    for (const [name, version] of Object.entries(dependencies)) {
        const packageRoot = path.join(root, 'node_modules', name);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
            name,
            version,
            dependencies: {},
        }));
    }
    const metaRoot = path.join(root, 'node_modules', '@aily-project', 'lib-meta');
    const nestedName = '@aily-project/lib-nested';
    const nestedRoot = path.join(metaRoot, 'node_modules', nestedName);
    await mkdir(path.join(nestedRoot, 'src', 'Nested'), { recursive: true });
    await writeFile(path.join(nestedRoot, 'src', 'Nested', 'Nested.h'), 'nested');
    await writeFile(path.join(nestedRoot, 'package.json'), JSON.stringify({
        name: nestedName,
        version: '4.0.0',
        dependencies: {},
    }));
    await writeFile(path.join(metaRoot, 'package.json'), JSON.stringify({
        name: '@aily-project/lib-meta',
        version: '3.0.0',
        dependencies: { [nestedName]: '4.0.0' },
    }));

    const packages = collectDependencyLibraryPackages(dependencies, root);
    assert.deepEqual(packages.map(item => item.packageName).sort(), [
        '@aily-project-coder/lib-direct',
        '@aily-project/lib-meta',
        '@aily-project/lib-nested',
        '@aily-project/lib-wrapped',
    ]);
    const searchPaths = await resolveCoderLibrarySearchPaths(packages, root, '', null);
    const canonicalRoot = await realpath(root);
    assert.deepEqual(searchPaths.map(item => path.relative(canonicalRoot, item)).sort(), [
        'node_modules/@aily-project-coder/lib-direct/src',
        'node_modules/@aily-project/lib-meta/node_modules/@aily-project/lib-nested/src',
        'node_modules/@aily-project/lib-wrapped/src/src/src',
    ]);
    assert.equal(await readFile(path.join(searchPaths.find(item => item.endsWith('lib-direct/src')), 'Direct.h'), 'utf8'), 'official');
    await assert.rejects(access(path.join(root, '.temp', 'libraries')));
});

test('Coder adds the standard src compile root without changing Blockly staging', async t => {
    const { root } = await fixture(t);
    const packageName = '@aily-project-coder/lib-arduinojson';
    await packageSource(root, packageName, 'arduinojson/library.properties', 'name=ArduinoJson');
    await packageSource(root, packageName, 'arduinojson/ArduinoJson.h', '#include "src/ArduinoJson.h"');
    await packageSource(root, packageName, 'arduinojson/src/ArduinoJson.h', '#include <ArduinoJson/Detail.hpp>');
    await packageSource(root, packageName, 'arduinojson/src/ArduinoJson/Detail.hpp', '#pragma once');
    await writeFile(path.join(root, 'node_modules', packageName, 'package.json'), JSON.stringify({
        name: packageName,
        version: '7.4.3',
        dependencies: {},
    }));

    const packages = collectDependencyLibraryPackages({ [packageName]: '7.4.3' }, root);
    const searchPaths = await resolveCoderLibrarySearchPaths(packages, root, '', null);
    const canonicalRoot = await realpath(root);

    assert.deepEqual(searchPaths.map(item => path.relative(canonicalRoot, item)), [
        'node_modules/@aily-project-coder/lib-arduinojson/src',
        'node_modules/@aily-project-coder/lib-arduinojson/src/arduinojson/src',
    ]);
    await assert.rejects(access(path.join(root, '.temp', 'libraries')));
});

test('localized sketch libraries replace matching npm roots across project reloads', async t => {
    const { root } = await fixture(t);
    await packageSource(root, '@aily-project/lib-demo', 'Demo/Demo.h', 'npm');
    await writeFile(path.join(root, 'node_modules', '@aily-project/lib-demo', 'package.json'), JSON.stringify({
        name: '@aily-project/lib-demo',
        version: '1.0.0',
        dependencies: {},
    }));
    const localRoot = path.join(root, 'sketch', 'libraries', 'Demo');
    await mkdir(localRoot, { recursive: true });
    await writeFile(path.join(localRoot, 'Demo.h'), 'localized');
    await writeFile(path.join(localRoot, '.aily-coder-local-library.json'), JSON.stringify({
        source: 'aily-chat',
        sourcePackage: '@aily-project/lib-demo',
        sourceLibraryRoot: 'node_modules/@aily-project/lib-demo/src/Demo',
    }));

    const packages = collectDependencyLibraryPackages({ '@aily-project/lib-demo': '1.0.0' }, root);
    for (let reload = 0; reload < 2; reload += 1) {
        const searchPaths = await resolveCoderLibrarySearchPaths(
            packages,
            root,
            '',
            path.join(root, 'sketch', 'libraries')
        );

        assert.deepEqual(searchPaths, [await realpath(path.join(root, 'sketch', 'libraries'))]);
        assert.equal(await readFile(path.join(searchPaths[0], 'Demo', 'Demo.h'), 'utf8'), 'localized');
    }
    await assert.rejects(access(path.join(root, '.temp', 'libraries')));
});

test('localized standard-layout libraries expose their local src compile root', async t => {
    const { root } = await fixture(t);
    const packageName = '@aily-project-coder/lib-arduinojson';
    const packageLibraryRoot = path.join(
        root,
        'node_modules',
        '@aily-project-coder',
        'lib-arduinojson',
        'src',
        'arduinojson'
    );
    await packageSource(root, packageName, 'arduinojson/library.properties', 'name=ArduinoJson');
    await packageSource(root, packageName, 'arduinojson/ArduinoJson.h', 'npm wrapper');
    await packageSource(root, packageName, 'arduinojson/src/ArduinoJson.h', 'npm source');
    await writeFile(path.join(root, 'node_modules', packageName, 'package.json'), JSON.stringify({
        name: packageName,
        version: '7.4.3',
        dependencies: {},
    }));

    const localRoot = path.join(root, 'sketch', 'libraries', 'arduinojson');
    await mkdir(path.join(localRoot, 'src'), { recursive: true });
    await writeFile(path.join(localRoot, 'library.properties'), 'name=ArduinoJson');
    await writeFile(path.join(localRoot, 'ArduinoJson.h'), 'local wrapper');
    await writeFile(path.join(localRoot, 'src', 'ArduinoJson.h'), 'local source');
    await writeFile(path.join(localRoot, '.aily-coder-local-library.json'), JSON.stringify({
        source: 'aily-chat',
        sourcePackage: packageName,
        sourceLibraryRoot: path.relative(root, packageLibraryRoot),
    }));

    const packages = collectDependencyLibraryPackages({ [packageName]: '7.4.3' }, root);
    const searchPaths = await resolveCoderLibrarySearchPaths(
        packages,
        root,
        '',
        path.join(root, 'sketch', 'libraries')
    );
    const canonicalRoot = await realpath(root);

    assert.deepEqual(searchPaths.map(item => path.relative(canonicalRoot, item)), [
        'sketch/libraries',
        'sketch/libraries/arduinojson/src',
    ]);
    assert.equal(await readFile(path.join(searchPaths[1], 'ArduinoJson.h'), 'utf8'), 'local source');
});

test('localizing one root keeps unrelated roots from the same npm package', async t => {
    const { root } = await fixture(t);
    await packageSource(root, '@aily-project/lib-demo', 'Demo/Demo.h', 'npm demo');
    await packageSource(root, '@aily-project/lib-demo', 'Support/Support.h', 'npm support');
    await writeFile(path.join(root, 'node_modules', '@aily-project/lib-demo', 'package.json'), JSON.stringify({
        name: '@aily-project/lib-demo',
        version: '1.0.0',
        dependencies: {},
    }));
    const localRoot = path.join(root, 'sketch', 'libraries', 'Demo');
    await mkdir(localRoot, { recursive: true });
    await writeFile(path.join(localRoot, 'Demo.h'), 'localized');
    await writeFile(path.join(localRoot, '.aily-coder-local-library.json'), JSON.stringify({
        source: 'aily-chat',
        sourcePackage: '@aily-project/lib-demo',
        sourceLibraryRoot: 'node_modules/@aily-project/lib-demo/src/Demo',
    }));

    const packages = collectDependencyLibraryPackages({ '@aily-project/lib-demo': '1.0.0' }, root);
    const searchPaths = await resolveCoderLibrarySearchPaths(
        packages,
        root,
        '',
        path.join(root, 'sketch', 'libraries')
    );

    const canonicalRoot = await realpath(root);
    assert.deepEqual(searchPaths.map(item => path.relative(canonicalRoot, item)), [
        'node_modules/@aily-project/lib-demo/src/Support',
        'sketch/libraries',
    ]);
});
