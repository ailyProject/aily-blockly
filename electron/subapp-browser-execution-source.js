'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const PROTOCOL = 'aily-browser-execution-v1';

function relativeEntry(value) {
    if (typeof value !== 'string' || !value || value.length > 1024
        || /[\\:%?#\u0000-\u0020]/.test(value) || value.startsWith('/')
        || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Browser execution entries must be package-relative paths');
    }
    return value;
}

function contained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Only main-process installed-package selection may provide config. Never accept
 * a renderer URL, source directory, manifest or content hash as this argument. */
function readBrowserExecutionSource(config) {
    const packageRoot = fs.realpathSync(config.packagePath);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (!config.version || config.version !== manifest.version || config.packageName !== manifest.name) {
        throw new Error('Browser execution package identity does not match selected version');
    }
    const declaration = manifest.ailySubapp?.runtime?.browserExecution;
    if (!declaration || declaration.protocol !== PROTOCOL || manifest.ailySubapp.runtime.headless === true) {
        throw new Error('Package does not declare a supported Browser execution domain');
    }
    const rootEntry = relativeEntry(declaration.root), entry = relativeEntry(declaration.entry);
    if (path.extname(entry) !== '.html') throw new Error('Browser execution entry must be an HTML document');
    let publicPart = packageRoot;
    for (const part of [...rootEntry.split('/'), ...entry.split('/')]) {
        publicPart = path.join(publicPart, part);
        if (fs.lstatSync(publicPart).isSymbolicLink()) throw new Error('Browser execution public root and entry cannot use symlinks');
    }
    const rootDirectory = fs.realpathSync(path.resolve(packageRoot, rootEntry));
    if (!contained(packageRoot, rootDirectory) || !fs.statSync(rootDirectory).isDirectory()) {
        throw new Error('Browser execution public root escapes selected package');
    }
    const entryPath = fs.realpathSync(path.resolve(rootDirectory, entry));
    if (!contained(rootDirectory, entryPath) || !fs.statSync(entryPath).isFile()) {
        throw new Error('Browser execution entry escapes public root');
    }
    if (fs.statSync(entryPath).size > 1024 * 1024) throw new Error('Browser execution entry exceeds the HTML byte budget');
    const sha256 = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(declaration.sha256 || '') || declaration.sha256 !== sha256) {
        throw new Error('Browser execution entry integrity mismatch');
    }
    const surfaces = {};
    if (Object.keys(manifest.ailySubapp.ui?.surfaces || {}).length > 16) throw new Error('Browser execution surface limit reached');
    for (const [name, surface] of Object.entries(manifest.ailySubapp.ui?.surfaces || {})) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid Browser surface name');
        const surfacePath = fs.realpathSync(path.resolve(packageRoot, relativeEntry(surface.entry)));
        if (!contained(rootDirectory, surfacePath) || !fs.statSync(surfacePath).isFile()) {
            throw new Error('Browser execution surfaces must remain inside the public root');
        }
        surfaces[name] = path.relative(rootDirectory, surfacePath).split(path.sep).join('/');
    }
    const identity = JSON.stringify([manifest.name, manifest.version, packageRoot, rootEntry, entry, sha256, surfaces]);
    return Object.freeze({ protocol: PROTOCOL, packageName: manifest.name, version: manifest.version,
        packageRoot, rootDirectory, entry, sha256, identity, surfaces: Object.freeze(surfaces) });
}

module.exports = { PROTOCOL, relativeEntry, readBrowserExecutionSource };
