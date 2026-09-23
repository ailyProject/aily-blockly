'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const state = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
// Some Windows Electron versions report stat.dev=0 while fstat has the actual
// device. Persist descriptor identity, not that runtime-specific path sentinel.
const sameFile = (a, b) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
    && (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0 || b.dev === 0)));
const fail = text => { throw new Error(`LIBRARY_INPUTS_CHANGED: ${text}`); };
const identity = filename => hash(process.platform === 'win32' ? filename.toLowerCase() : filename);

/** Preserves the existing library cache fingerprint; adds bounded race evidence. */
function captureLibrarySource(sourcePath) {
    const root = fs.realpathSync(sourcePath), active = new Set(), digest = crypto.createHash('sha256');
    const states = [];
    let fileCount = 0, sizeBytes = 0;
    const visit = (filename, relative, depth) => {
        if (depth > 64) fail('Source depth exceeds limit.');
        const real = fs.realpathSync(filename);
        if (!within(root, real)) fail(`Library source link escapes its root: ${filename}`);
        const before = fs.statSync(filename), normalized = relative.split(path.sep).join('/');
        if (before.isDirectory()) {
            if (active.has(real)) fail('Library source contains a directory link cycle.');
            digest.update(`directory\0${normalized}\0`); active.add(real);
            for (const name of fs.readdirSync(filename).sort((a, b) => a.localeCompare(b))) visit(path.join(filename, name), path.join(relative, name), depth + 1);
            active.delete(real);
        } else if (before.isFile()) {
            if (++fileCount > 4096 || (sizeBytes += before.size) > 256 * 1024 * 1024) fail('Source exceeds capture budget.');
            const fd = fs.openSync(filename, 'r');
            try {
                const opened = fs.fstatSync(fd);
                if (!opened.isFile() || !sameFile(before, opened)) fail('Source changed before reading.');
                digest.update(`file\0${normalized}\0${opened.size}\0`);
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, opened.size + 1));
                let size = 0, count;
                while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
                    if ((size += count) > opened.size) fail('Source grew while hashing.');
                    digest.update(buffer.subarray(0, count));
                }
                const after = fs.fstatSync(fd), bound = fs.statSync(filename);
                if (state(opened) !== state(after) || !sameFile(after, bound) || size !== opened.size) fail('Source changed while hashing.');
                digest.update('\0');
                states.push(`${normalized}:${state(after)}`);
            } finally { fs.closeSync(fd); }
        } else fail('Unsupported source entry.');
    };
    visit(root, '', 0);
    return { location: root, requestedPath: path.resolve(sourcePath), fingerprint: `sha256:${digest.digest('hex')}`, states, fileCount, sizeBytes };
}
const createLibrarySourceFingerprint = source => captureLibrarySource(source).fingerprint;
function confirmSource(before) {
    const after = captureLibrarySource(before.requestedPath);
    if (before.location !== after.location || before.fingerprint !== after.fingerprint || JSON.stringify(before.states) !== JSON.stringify(after.states)) fail('Library source changed during preparation/build.');
}
function projectionSummary(entries) {
    return entries.map(entry => ({ owner: entry.owner, source: identity(entry.source.location), target: identity(entry.target.location),
        fingerprint: entry.source.fingerprint,
        inputs: entry.inputs.map(input => ({ location: identity(input.location), fingerprint: input.fingerprint })) }));
}
function confirmLibraryProjections(record) {
    if (record?.schemaVersion !== 1 || record.kind !== 'aily-library-projections' || !Array.isArray(record.entries) || record.entries.length > 128) fail('Invalid projection record.');
    for (const entry of record.entries) {
        if (entry.source.fingerprint !== entry.target.fingerprint) fail('Library projection differs from its source.');
        confirmSource(entry.source); confirmSource(entry.target);
        for (const input of entry.inputs) confirmSource(input);
    }
    if (hash(JSON.stringify(projectionSummary(record.entries))) !== record.digest) fail('Projection digest mismatch.');
    return { scope: 'prepared-library-projections', digest: record.digest, count: record.entries.length };
}
function createLibraryProjectionRecorder() {
    const entries = new Map();
    return {
        capture: captureLibrarySource,
        add(owner, before, targetPath, inputs = [], override = false) {
            confirmSource(before);
            const target = captureLibrarySource(targetPath), key = identity(target.location);
            if (before.fingerprint !== target.fingerprint) fail(`Projection mismatch for ${owner}.`);
            if (entries.has(key) && entries.get(key).owner !== owner && !override) fail('Two packages project into the same library directory.');
            entries.set(key, { owner, source: before, target, inputs });
            if (entries.size > 128 || [...entries.values()].reduce((n, e) => n + e.source.sizeBytes, 0) > 256 * 1024 * 1024) fail('Projection inventory exceeds budget.');
        },
        snapshot(config) {
            const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
            const record = { schemaVersion: 1, kind: 'aily-library-projections', project: fs.realpathSync(config.currentProjectPath),
                sourceSha256: hash(config.code), entries: sorted, digest: hash(JSON.stringify(projectionSummary(sorted))) };
            confirmLibraryProjections(record);
            return record;
        },
    };
}
function writeLibraryProjections(config, recorder) {
    const record = recorder.snapshot(config), text = JSON.stringify(record);
    if (Buffer.byteLength(text) > 1024 * 1024) fail('Projection record exceeds 1 MiB.');
    fs.writeFileSync(path.join(config.currentProjectPath, '.build/aily-library-projections.json'), text);
}
function readLibraryProjections(config) {
    const filename = path.join(config.currentProjectPath, '.build/aily-library-projections.json');
    if (fs.statSync(filename).size > 1024 * 1024) fail('Projection record exceeds 1 MiB.');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (record.project !== fs.realpathSync(config.currentProjectPath) || record.sourceSha256 !== hash(config.code)) fail('Projection belongs to another build request.');
    confirmLibraryProjections(record);
    return record;
}

module.exports = { captureLibrarySource, createLibrarySourceFingerprint, createLibraryProjectionRecorder,
    confirmLibraryProjections, writeLibraryProjections, readLibraryProjections };
