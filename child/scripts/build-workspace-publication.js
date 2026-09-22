'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireBuildWorkspace } = require('./build-workspace-lease');
const { invalidateBuildDelivery } = require('./compile-delivery');
const HEADER = /^(?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h$/;
const MAX_BYTES = 128 * 1024 * 1024;
const fail = message => { throw new Error(`BUILD_PUBLICATION_INVALID: ${message}`); };

// Closed publication operations, not an arbitrary filesystem bridge. All I/O
// and the final release are synchronous: no renderer context-change await gap.
function publish(projectPath, action) {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) fail('Expected an absolute project path.');
    const owner = acquireBuildWorkspace(projectPath, 'publish');
    try { return action(owner.projectRoot, owner.assertOwned); }
    finally { owner.release(); }
}

function physical(root, relative) {
    let cursor = root;
    for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
            fail(`Refusing linked or non-regular publication path: ${relative}`);
        }
    }
    return cursor;
}

function read(root, relative, limit = MAX_BYTES) {
    const filename = physical(root, relative);
    try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > limit) fail(`Invalid or oversized publication file: ${relative}`);
        return fs.readFileSync(filename, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function replace(root, relative, content, assertOwned) {
    const filename = physical(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { flag: 'wx' });
        assertOwned(); physical(root, relative);
        fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function publishArduinoGeneratedCode(projectPath, { artifacts = null, sketchCode } = {}) {
    if (sketchCode !== undefined && typeof sketchCode !== 'string') fail('Invalid generated code.');
    if (artifacts !== null && (!Array.isArray(artifacts) || artifacts.length > 256)) fail('Invalid generated artifact list.');
    const names = new Set();
    let size = Buffer.byteLength(sketchCode || '', 'utf8');
    for (const artifact of artifacts || []) {
        if (!artifact || typeof artifact.fileName !== 'string' || !HEADER.test(artifact.fileName)
            || typeof artifact.content !== 'string' || typeof artifact.sourceTag !== 'string'
            || names.has(artifact.fileName.toLowerCase())) fail('Invalid or duplicate generated header.');
        names.add(artifact.fileName.toLowerCase());
        size += Buffer.byteLength(artifact.content, 'utf8');
    }
    if (size > MAX_BYTES) fail('Generated publication exceeds 128 MiB.');
    if (artifacts === null && sketchCode === undefined) return { changed: false };
    return publish(projectPath, (root, assertOwned) => {
        const original = read(root, 'package.json', 2 * 1024 * 1024);
        if (original === null) fail('Project package.json is missing.');
        const manifest = JSON.parse(original);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Invalid project manifest.');
        if (manifest?.type === 'coder') fail('Generated Arduino publication is only for Blockly projects.');
        const writes = [], removals = [];
        if (artifacts !== null) {
            const source = physical(root, 'src');
            for (const name of fs.existsSync(source) ? fs.readdirSync(source) : []) {
                if (HEADER.test(name) && !names.has(name.toLowerCase())) {
                    read(root, `src/${name}`); removals.push(`src/${name}`);
                }
            }
            for (const artifact of artifacts) {
                if (read(root, `src/${artifact.fileName}`) !== artifact.content) writes.push([`src/${artifact.fileName}`, artifact.content]);
            }
            const legacy = physical(root, '.temp/sketch/generated');
            for (const name of fs.existsSync(legacy) ? fs.readdirSync(legacy) : []) {
                if (HEADER.test(name)) { read(root, `.temp/sketch/generated/${name}`); removals.push(`.temp/sketch/generated/${name}`); }
            }
        }
        if (sketchCode !== undefined && read(root, '.temp/sketch/sketch.ino') !== sketchCode) {
            writes.push(['.temp/sketch/sketch.ino', sketchCode]);
        }
        if (!writes.length && !removals.length) return { changed: false };
        // Never leave a previous successful ticket after changing generated input.
        // Validate the whole requested publication before this first mutation.
        assertOwned(); invalidateBuildDelivery(root);
        for (const [name, content] of writes) replace(root, name, content, assertOwned);
        for (const name of removals) { assertOwned(); fs.unlinkSync(physical(root, name)); }
        return { changed: true };
    });
}

function patchBuildMetadata(projectPath, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['codeHash', 'buildInfo'].includes(key))) fail('Only build metadata may be patched.');
    if (patch.codeHash !== undefined && !/^[a-f0-9]{64}$/.test(patch.codeHash)) fail('Invalid code hash.');
    if (patch.buildInfo !== undefined) {
        const info = patch.buildInfo;
        if (!info || !['success', 'failed', 'cancelled'].includes(info.lastBuildStatus)
            || !/^[a-f0-9]{64}$/.test(info.lastBuildCode) || typeof info.lastBuildTime !== 'string'
            || !Number.isFinite(Date.parse(info.lastBuildTime)) || !Number.isFinite(info.lastBuildDuration) || info.lastBuildDuration < 0
            || Object.keys(info).some(key => !['lastBuildTime', 'lastBuildCode', 'lastBuildStatus', 'lastBuildDuration'].includes(key))) fail('Invalid build result metadata.');
    }
    return publish(projectPath, (root, assertOwned) => {
        const original = read(root, 'package.json', 2 * 1024 * 1024);
        if (original === null) fail('Project package.json is missing.');
        const manifest = JSON.parse(original);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Invalid project manifest.');
        Object.assign(manifest, patch);
        const content = JSON.stringify(manifest, null, 2);
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) fail('Project manifest exceeds 2 MiB.');
        // Blockly retains a package mirror used by its existing save/open flow.
        // Patch only metadata there too; never overwrite its dependency edits.
        let mirror;
        if (manifest.type !== 'coder') {
            const previous = read(root, '.temp/package.json', 2 * 1024 * 1024);
            const value = previous === null ? manifest : JSON.parse(previous);
            if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid package mirror.');
            mirror = JSON.stringify({ ...value, ...patch }, null, 2);
            if (Buffer.byteLength(mirror) > 2 * 1024 * 1024) fail('Package mirror exceeds 2 MiB.');
            if (mirror === previous) mirror = undefined;
        }
        if (content !== original) replace(root, 'package.json', content, assertOwned);
        if (mirror !== undefined) replace(root, '.temp/package.json', mirror, assertOwned);
        return manifest;
    });
}

module.exports = { publishArduinoGeneratedCode, patchBuildMetadata };
