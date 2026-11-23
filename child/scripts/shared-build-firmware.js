'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveBuildExecution } = require('./build-execution-workspace');
const { acquireBuildWorkspace } = require('./build-workspace-lease');

function stale() {
    return Object.assign(new Error('BUILD_ARTIFACT_STALE: The selected firmware changed; build again.'), { code: 'BUILD_ARTIFACT_STALE' });
}

function acquireSharedBuildFirmware(reference) {
    if (reference?.layout !== 'shared' || typeof reference.logicalProjectPath !== 'string'
        || !path.isAbsolute(reference.logicalProjectPath)) throw stale();
    const workspace = acquireBuildWorkspace(reference.logicalProjectPath, 'verify');
    try {
        const selected = resolveBuildExecution(workspace.projectRoot);
        if (!selected || selected.layout !== 'shared' || selected.executionId !== reference.executionId
            || selected.buildRequestId !== reference.buildRequestId || selected.inputDigest !== reference.inputDigest
            || selected.buildPath !== reference.buildPath) throw stale();
        return { workspace, selected };
    } catch (error) { workspace.release(); throw error; }
}

function readSharedBuildFirmware(reference, filename) {
    const { workspace, selected } = acquireSharedBuildFirmware(reference);
    try {
        const target = fs.realpathSync(filename), relative = path.relative(selected.buildPath, target);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
            || path.isAbsolute(relative) || !/\.bin$/i.test(relative) || path.resolve(filename) !== target) throw stale();
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > 128 * 1024 * 1024) throw stale();
        const bytes = fs.readFileSync(target), after = fs.lstatSync(target);
        if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino || bytes.length !== stat.size)
            throw stale();
        workspace.assertOwned();
        return bytes;
    } finally { workspace.release(); }
}

module.exports = { acquireSharedBuildFirmware, readSharedBuildFirmware };
