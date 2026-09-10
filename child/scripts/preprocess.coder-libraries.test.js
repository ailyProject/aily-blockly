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

test('localized sketch libraries are searched last without copying npm sources', async t => {
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

    const packages = collectDependencyLibraryPackages({ '@aily-project/lib-demo': '1.0.0' }, root);
    const searchPaths = await resolveCoderLibrarySearchPaths(
        packages,
        root,
        '',
        path.join(root, 'sketch', 'libraries')
    );

    assert.equal(searchPaths.length, 2);
    assert.equal(searchPaths.at(-1), await realpath(path.join(root, 'sketch', 'libraries')));
    assert.equal(await readFile(path.join(searchPaths[0], 'Demo', 'Demo.h'), 'utf8'), 'npm');
    assert.equal(await readFile(path.join(searchPaths[1], 'Demo', 'Demo.h'), 'utf8'), 'localized');
    await assert.rejects(access(path.join(root, '.temp', 'libraries')));
});
