const fs = require('node:fs');
const path = require('node:path');

function findUploadToolDependency(command, dependencies) {
    const name = path.basename(command).replace(/\.exe$/i, '').toLowerCase();
    const names = [name, `${name}_py`, `pqt-${name}`, `xpack-${name}`];
    const keys = Object.keys(dependencies);
    for (const candidate of names) {
        const tool = keys.find(key => key.toLowerCase() === candidate);
        if (tool && dependencies[tool]) {
            return { tool, version: dependencies[tool] };
        }
    }
    return null;
}

function findPinnedUploadToolDirectory(toolsPath, tool, version) {
    if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version) || version === '.' || version === '..') {
        return null;
    }
    const stems = [
        path.join(toolsPath, `${tool}@`),
        path.join(toolsPath, tool) + path.sep,
        path.join(toolsPath, `${tool}_`),
    ];
    for (const stem of stems) {
        const directory = stem + version;
        if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
            return directory;
        }
    }

    // The Pico SDK wrapper and its distributed executable use different revisions.
    if (tool === 'pqt-picotool' && version === '4.1.0') {
        for (const stem of stems) {
            const directory = stem + '4.1.0-1aec55e';
            if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
                return directory;
            }
        }
    }

    // Older Arduino archives have an -arduinoN suffix and may omit a zero patch.
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
    const legacyVersions = new Set([version, version.replace(/^(\d+\.\d+)\.0$/, '$1')]);
    for (const legacyVersion of legacyVersions) {
        for (const stem of stems) {
            const prefix = stem + legacyVersion + '-arduino';
            const parent = path.dirname(prefix);
            if (!fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) continue;
            const name = path.basename(prefix);
            const entry = fs.readdirSync(parent).sort().find(candidate =>
                candidate.startsWith(name)
                && /^\d+$/.test(candidate.slice(name.length))
                && fs.statSync(path.join(parent, candidate), { throwIfNoEntry: false })?.isDirectory()
            );
            if (entry) return path.join(parent, entry);
        }
    }
    return null;
}

function isToolExecutableInDirectory(command, directory) {
    if (!path.isAbsolute(command)) return false;
    const relative = path.relative(directory, command);
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        && !path.isAbsolute(relative) && fs.statSync(command, { throwIfNoEntry: false })?.isFile();
}

module.exports = { findUploadToolDependency, findPinnedUploadToolDirectory, isToolExecutableInDirectory };
