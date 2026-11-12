const fs = require('node:fs');
const path = require('node:path');
const { platformResourcePaths } = require('./platform-resource-layout.cjs');

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
    if (!path.isAbsolute(command)) return false;
    const relative = path.relative(directory, command);
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        && !path.isAbsolute(relative) && fs.statSync(command, { throwIfNoEntry: false })?.isFile();
}

module.exports = { findUploadToolDependency, findPinnedUploadToolDirectories, isToolExecutableInDirectory };
