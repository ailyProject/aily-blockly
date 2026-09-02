'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareCoderPackageLibraries } = require('./preprocess');

test('Coder builds shared libraries directly from each intact npm package src directory', async t => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-package-library-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const packageName = '@aily-project/lib-arduinojson';
    const packageRoot = path.join(projectRoot, 'node_modules', packageName);
    const packageSourceRoot = path.join(packageRoot, 'src');
    const libraryRoot = path.join(packageSourceRoot, 'ArduinoJson');
    fs.mkdirSync(libraryRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        version: '1.0.0'
    }));
    fs.writeFileSync(path.join(libraryRoot, 'ArduinoJson.h'), '#pragma once\n');

    const paths = await prepareCoderPackageLibraries([packageName], projectRoot, '/unused/7zz');

    assert.deepEqual(paths, [packageSourceRoot]);
    assert.equal(fs.existsSync(path.join(projectRoot, 'sketch', 'libraries', 'ArduinoJson')), false);
    assert.equal(fs.readFileSync(path.join(libraryRoot, 'ArduinoJson.h'), 'utf8'), '#pragma once\n');
});
