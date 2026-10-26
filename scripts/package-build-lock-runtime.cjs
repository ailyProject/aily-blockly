'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

// Child scripts run under both Electron and the bundled standalone Node. Ship
// one N-API runtime outside ASAR so neither relies on a developer/global install.
async function packageBuildLockRuntime({ destination, platform, arch, workspaceRoot = path.resolve(__dirname, '..') }) {
    const copied = new Map();
    async function copyPackage(name, from) {
        const resolve = createRequire(path.join(from, 'package.json')).resolve;
        let directory = path.dirname(resolve(name));
        let manifest;
        while (true) {
            try {
                const value = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
                if (value.name === name) { manifest = value; break; }
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const parent = path.dirname(directory);
            if (parent === directory) throw new Error(`Cannot locate runtime package ${name}`);
            directory = parent;
        }
        if (copied.has(name)) {
            if (copied.get(name) !== manifest.version) throw new Error(`Conflicting runtime versions of ${name}`);
            return;
        }
        copied.set(name, manifest.version);
        const target = path.join(destination, 'node_modules', name);
        await fs.cp(directory, target, { recursive: true, dereference: true, filter: source => {
            const relative = path.relative(directory, source).split(path.sep);
            if (relative[0] === 'node_modules') return false;
            if (relative[0] === 'prebuilds' && relative.length > 1) {
                const platforms = arch === 'universal' ? ['darwin-arm64', 'darwin-x64'] : [`${platform}-${arch}`];
                if (!platforms.includes(relative[1])) return false;
                if (relative.length > 2 && !source.endsWith('.node')) return false;
            }
            return true;
        } });
        for (const dependency of Object.keys(manifest.dependencies || {})) await copyPackage(dependency, directory);
    }
    await copyPackage('fs-native-extensions', workspaceRoot);
    for (const targetArch of arch === 'universal' ? ['arm64', 'x64'] : [arch]) {
        await fs.access(path.join(destination, 'node_modules/fs-native-extensions/prebuilds', `${platform}-${targetArch}`, 'fs-native-extensions.node'));
    }
    return Object.fromEntries(copied);
}
module.exports = { packageBuildLockRuntime };
