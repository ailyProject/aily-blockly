const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectDependencyLibraryPackages, processLibrariesParallel } = require('./preprocess');

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
