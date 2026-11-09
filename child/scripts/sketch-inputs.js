'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SOURCES = new Set(['.c', '.cc', '.cpp', '.cxx', '.S', '.s']);
const HEADERS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inc']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const fail = message => { throw Object.assign(new Error(`BUILD_SOURCE_STALE: ${message}`), { code: 'BUILD_SOURCE_STALE' }); };

/** Captured Arduino sketch inputs: direct and recursive src/ translation units,
 * plus headers anywhere in the explicit sketch root (including include/).
 * Captured headers are not a claim that every header is compiled or included.
 * The generated main entry has its own identity. Never read unrelated project
 * directories, non-source attachments or the contents of links.
 */
function captureSketchInputs(root, entry = 'sketch.ino', options = {}) {
    const files = [], states = [];
    let sizeBytes = 0, entryCount = 0, directoryCount = 0;
    const present = filename => {
        try { return fs.lstatSync(filename); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    };
    const visit = (directory, relative = '', depth = 0) => {
        if (depth > 64 || relative.length > 512) fail('Sketch source directory exceeds its boundary.');
        const before = present(directory);
        if (!before) {
            if (relative) fail('Sketch source directory disappeared during capture.');
            states.push(['', 'absent']);
            return;
        }
        if (before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) {
            fail('Sketch source directory must be physical.');
        }
        if (relative && ++directoryCount > 4096) fail('Sketch source traversal exceeds its boundary.');
        const names = fs.readdirSync(directory);
        if ((entryCount += names.length) > 16384) fail('Sketch source traversal exceeds its boundary.');
        for (const name of names.sort(compare)) {
            if (options.recursiveSources === true && ['node_modules', '.git', '.temp', '.build', '.log', '.workspace-history', '.aily'].includes(name)) continue;
            const filename = path.join(directory, name), child = relative ? `${relative}/${name}` : name;
            if (child.length > 512 || child.split('/').length > 64 || /[\\\u0000-\u001f\u007f:]/.test(child)) {
                fail('Sketch source path exceeds its boundary.');
            }
            const extension = path.extname(name);
            const selected = child !== entry && (HEADERS.has(extension)
                || ((options.recursiveSources === true || !relative || relative === 'src' || relative.startsWith('src/')) && SOURCES.has(extension))
                || (options.recursiveSources === true && extension === '.ino'));
            const stat = fs.lstatSync(filename);
            if (stat.isSymbolicLink()) fail('Sketch inputs cannot traverse implicit links.');
            if (stat.isDirectory()) {
                visit(filename, child, depth + 1);
                continue;
            }
            if (!selected) continue;
            if (!stat.isFile() || child.length > 512 || files.length >= 4096
                || stat.size > 4 * 1024 * 1024 || stat.size > 16 * 1024 * 1024 - sizeBytes) fail('Sketch source file exceeds its boundary.');
            const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let bytes, opened;
            try {
                opened = fs.fstatSync(fd);
                if (!opened.isFile() || opened.ino !== stat.ino || (stat.dev && opened.dev !== stat.dev)
                    || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) {
                    fail('Sketch source changed while opening.');
                }
                bytes = Buffer.alloc(opened.size + 1);
                let length = 0, count;
                while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += count;
                if (length !== stat.size || state(opened) !== state(fs.fstatSync(fd))) fail('Sketch source changed during capture.');
                bytes = bytes.subarray(0, length);
            } finally { fs.closeSync(fd); }
            const after = fs.lstatSync(filename);
            if (after.isSymbolicLink() || state(stat) !== state(after)) fail('Sketch source changed during capture.');
            sizeBytes += bytes.length;
            files.push({ path: child, sizeBytes: bytes.length, sha256: hash(bytes) });
            states.push([child, state(after)]);
        }
        const after = fs.lstatSync(directory);
        if (after.isSymbolicLink() || state(before) !== state(after)) fail('Sketch source directory changed during capture.');
        states.push([relative, state(after)]);
    };
    visit(root);
    files.sort((a, b) => compare(a.path, b.path));
    states.sort((a, b) => compare(a[0], b[0]));
    const body = { schemaVersion: 1, scope: 'arduino-sketch-inputs', files };
    return { manifest: { ...body, digest: hash(JSON.stringify(body)) }, states };
}

module.exports = { captureSketchInputs };
