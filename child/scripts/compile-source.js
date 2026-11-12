'use strict';

const fs = require('node:fs');
const path = require('node:path');
const project = require('./aily-code-project');
const { createHash } = require('node:crypto');
const sourceFault = message => Object.assign(new Error(`BUILD_SOURCE_STALE: ${message}`), { code: 'BUILD_SOURCE_STALE' });
const stamp = stat => [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/** The Builder consumes this original sketch; its generated .build/sketch C++
 * may legitimately add prototypes. Verify the actual input, including ordinary
 * CLI builds without full delivery recording. Never change Coder's contract. */
function captureBlocklyCompileSource(config, filename, previous) {
    const root = fs.realpathSync(config.currentProjectPath);
    if (project.isAilyCodeProjectRoot(root)) return undefined;
    const expectedPath = path.join(root, '.temp', 'sketch', 'sketch.ino');
    if (path.resolve(filename) !== expectedPath || typeof config.code !== 'string') throw sourceFault('Unexpected materialized Blockly input.');
    const expected = Buffer.from(config.code, 'utf8');
    if (expected.length > 128 * 1024 * 1024) throw sourceFault('Materialized Blockly input exceeds its capture budget.');
    const digest = createHash('sha256').update(expected).digest('hex');
    if (config.sourceCapture && config.sourceCapture.sourceSha256 !== digest) throw sourceFault('Materialized input differs from the trusted code capture.');
    for (let cursor = expectedPath; cursor !== root; cursor = path.dirname(cursor)) {
        if (fs.lstatSync(cursor).isSymbolicLink()) throw sourceFault('Materialized Blockly input traverses a link.');
    }
    const fd = fs.openSync(expectedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(fd), named = fs.lstatSync(expectedPath);
        if (!before.isFile() || before.nlink !== 1 || before.size !== expected.length || before.ino !== named.ino
            || previous && (previous.path !== expectedPath || previous.sha256 !== digest || previous.stamp !== stamp(before))) {
            throw sourceFault('Materialized Blockly input was replaced or changed.');
        }
        const bytes = Buffer.alloc(expected.length + 1);
        let offset = 0, count;
        while (offset < bytes.length && (count = fs.readSync(fd, bytes, offset, bytes.length - offset, null))) offset += count;
        if (offset !== expected.length || !bytes.subarray(0, offset).equals(expected)
            || stamp(fs.fstatSync(fd)) !== stamp(before) || stamp(fs.lstatSync(expectedPath)) !== stamp(before)) {
            throw sourceFault('Materialized Blockly sketch bytes differ from the captured request.');
        }
        return Object.freeze({ path: expectedPath, sha256: digest, stamp: stamp(before) });
    } finally { fs.closeSync(fd); }
}

function assertPhysicalTree(root) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) throw new Error(`Compile source must not traverse a symlink/junction: ${root}`);
    if (stat.isDirectory()) {
        for (const name of fs.readdirSync(root)) assertPhysicalTree(path.join(root, name));
    } else if (!stat.isFile()) throw new Error(`Unsupported compile source: ${root}`);
}

/** Only the derived Blockly sketch is replaceable. Coder's sketch is user-owned. */
async function prepareCompileSource(config) {
    const root = fs.realpathSync(config.currentProjectPath);
    if (typeof config.code !== 'string') throw new Error('Compile code must be a string.');
    if (project.isAilyCodeProjectRoot(root)) {
        const filename = project.resolveCompileSourcePath(root);
        // Check every existing ancestor; an entry inside a junction is not project-owned.
        for (let cursor = filename; cursor !== root; cursor = path.dirname(cursor)) {
            if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
                throw new Error(`Coder entry traverses a symlink/junction: ${cursor}`);
            }
        }
        const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined;
        if (config.recordProjectDelivery === true && previous !== config.code) {
            throw new Error('PROJECT_INPUTS_CHANGED: Coder entry differs from the requested build; save and retry.');
        }
        if (previous !== config.code) {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, config.code);
        }
        return filename;
    }

    const temporary = path.join(root, '.temp');
    const destination = path.join(temporary, 'sketch');
    const source = path.join(root, 'src');
    if (fs.existsSync(source)) assertPhysicalTree(source);
    // Validate the exact, owned destination before recursive removal. Never follow links.
    if (fs.existsSync(temporary) && fs.realpathSync(temporary) !== temporary) {
        throw new Error('Blockly temporary directory must not be a symlink/junction.');
    }
    if (fs.existsSync(destination)) assertPhysicalTree(destination);
    fs.mkdirSync(temporary, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination);
    if (fs.existsSync(source)) {
        // Async cp avoids the bundled Node's Windows Unicode cpSync crash.
        await fs.promises.cp(source, destination, { recursive: true });
    }
    const filename = path.join(destination, 'sketch.ino');
    // Generated code owns the entry, even when src contains an old sketch.ino.
    fs.writeFileSync(filename, config.code);
    return filename;
}

module.exports = { prepareCompileSource, captureBlocklyCompileSource };
