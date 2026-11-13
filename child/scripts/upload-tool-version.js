const fs = require('node:fs');
const path = require('node:path');
const { platformResourcePaths } = require('./platform-resource-layout.cjs');

function findUploadToolDependency(command, dependencies) {
    const name = path.basename(command).replace(/\.exe$/i, '').toLowerCase();
    const names = [name, `${name}_py`, `pqt-${name}`, `xpack-${name}`];
    const keys = Object.keys(dependencies);
    for (const candidate of names) {
        const tool = keys.find(key => key.toLowerCase() === candidate);
        const version = tool && dependencies[tool];
        if (typeof version === 'string' && /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
            return { tool, version };
        }
    }
    return null;
}

function findPinnedUploadToolDirectories(toolsPath, tool, version) {
    if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version) || version === '.' || version === '..') {
        return [];
    }
    if (!fs.statSync(toolsPath, { throwIfNoEntry: false })?.isDirectory()) return [];
    return platformResourcePaths('tool', tool, version, fs.readdirSync(toolsPath))
        .map(directory => path.join(toolsPath, directory))
        .filter(directory => fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
}

function isToolExecutableInDirectory(command, directory) {
    if (!path.isAbsolute(command) || !fs.statSync(command, { throwIfNoEntry: false })?.isFile()) return false;
    // Preprocessing can use a read-only or short-path view of the same payload.
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(command));
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        && !path.isAbsolute(relative);
}

module.exports = { findUploadToolDependency, findPinnedUploadToolDirectories, isToolExecutableInDirectory };
