'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    collectDependencyLibraryPackages,
    collectWorkspaceLibraries,
} = require('./preprocess');

test('Coder library inputs come from sketch/libraries and not npm dependencies', t => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-sketch-library-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    const packageName = '@aily-project/lib-arduinojson';
    const packageRoot = path.join(projectRoot, 'node_modules', packageName);
    const npmLibraryRoot = path.join(packageRoot, 'src', 'ArduinoJson');
    const sketchLibrariesRoot = path.join(projectRoot, 'sketch', 'libraries');
    const coderLibraryRoot = path.join(sketchLibrariesRoot, 'CoderDisplay');
    fs.mkdirSync(npmLibraryRoot, { recursive: true });
    fs.mkdirSync(coderLibraryRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        version: '1.0.0'
    }));
    fs.writeFileSync(path.join(npmLibraryRoot, 'ArduinoJson.h'), '#pragma once\n');
    fs.writeFileSync(path.join(coderLibraryRoot, 'CoderDisplay.h'), '#pragma once\n');

    const dependencies = { [packageName]: '1.0.0' };
    assert.deepEqual(
        collectDependencyLibraryPackages(dependencies, projectRoot, true),
        [],
    );
    // Blockly retains its established dependency-library path.
    assert.deepEqual(
        collectDependencyLibraryPackages(dependencies, projectRoot, false),
        [packageName],
    );

    const coderLibraries = collectWorkspaceLibraries(sketchLibrariesRoot);
    assert.deepEqual(coderLibraries, [{
        name: 'CoderDisplay',
        sourcePath: coderLibraryRoot,
    }]);
    assert.equal(coderLibraries.some(library => library.sourcePath.startsWith(packageRoot)), false);
});
