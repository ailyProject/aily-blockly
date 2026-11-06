'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const FILE = 'aily-build-inputs.json', LIMIT = 4 * 1024 * 1024;
const GRAPH = 'build.ninja', GRAPH_LIMIT = 8 * 1024 * 1024;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
const fail = () => { throw Object.assign(new Error('Build-graph record is unsafe or does not match this build.'), { code: 'BUILD_INPUT_RECORD_INVALID' }); };

function readBoundedFile(directory, relative, limit) {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || key(fs.realpathSync(directory)) !== key(directory)) fail();
    const filename = path.join(directory, relative), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail();
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
        const opened = fs.fstatSync(fd);
        // Windows Node/Electron versions may report dev=0 for pathname stats
        // but a real device ID for fstat. Compare it only when available.
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino
            || (stat.dev !== 0 && opened.dev !== stat.dev) || opened.size !== stat.size
            || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) fail();
        bytes = Buffer.alloc(stat.size + 1);
        let size = 0, read;
        while (size < bytes.length && (read = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += read;
        if (size !== stat.size || state(opened) !== state(fs.fstatSync(fd))) fail();
        bytes = bytes.subarray(0, size);
    } finally { fs.closeSync(fd); }
    const after = fs.lstatSync(filename), currentDirectory = fs.lstatSync(directory);
    if (after.isSymbolicLink() || state(stat) !== state(after)
        || currentDirectory.isSymbolicLink() || directoryStat.dev !== currentDirectory.dev
        || directoryStat.ino !== currentDirectory.ino || key(fs.realpathSync(directory)) !== key(directory)) fail();
    return bytes;
}

// The existing public record hashes the actual Ninja plan. Bind the private
// source inventory through a literal variable in that plan, without extending
// the public record schema or inventing a recipe execution.
function confirmSketchGraph(directory, record, expected) {
    if (!/^[a-f0-9]{64}$/.test(expected?.digest) || !Array.isArray(record.steps)) fail();
    const linking = record.steps.filter(step => step?.kind === 'ninja-plan' && step.name === 'linking');
    if (linking.length !== 1 || !/^[a-f0-9]{64}$/.test(linking[0].sha256)) fail();
    const graph = readBoundedFile(directory, GRAPH, GRAPH_LIMIT);
    if (createHash('sha256').update(graph).digest('hex') !== linking[0].sha256) fail();
    const lines = graph.toString('utf8').split('\n');
    const assignments = lines.map((line, index) => ({ line, index }))
        .filter(({ line }) => /^[ \t]*aily_sketch_inputs_digest(?:[ \t=]|$)/.test(line));
    if (assignments.length !== 1) fail();
    const { line, index } = assignments[0];
    if (line !== `aily_sketch_inputs_digest = ${expected.digest}`
        || (index > 0 && lines[index - 1].endsWith('$'))) fail();
}

// Bind the exact bounded producer metadata, not SDK/tool content or freshness.
function readBuildInputRecordBinding(projectPath, reference, expectedSketchInputs) {
    if (reference?.schemaVersion !== 1 || reference.kind !== 'aily-build-input-reference'
        || reference.scope !== 'build-graph-facts' || reference.path !== FILE
        || !/^[a-f0-9]{64}$/.test(reference.digest)) fail();
    const directory = path.join(fs.realpathSync(projectPath), '.build');
    const bytes = readBoundedFile(directory, FILE, LIMIT);
    const record = JSON.parse(bytes.toString('utf8'));
    if (record?.schemaVersion !== 1 || record.kind !== 'aily-build-input-record'
        || record.scope !== 'build-graph-facts' || record.digest !== reference.digest
        || Object.keys(record).some(name => !['schemaVersion', 'kind', 'scope', 'configurationSha256', 'targetSelection', 'steps', 'digest'].includes(name))) fail();
    const { digest, ...body } = record;
    if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest) fail();
    if (expectedSketchInputs !== undefined) confirmSketchGraph(directory, record, expectedSketchInputs);
    return createHash('sha256').update(bytes).digest('hex');
}

module.exports = { readBuildInputRecordBinding };
