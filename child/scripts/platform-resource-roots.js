'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

/** AppData owns mutable application state, not necessarily SDK/tool bodies.
 * Respect the same explicit resource roots as Host readiness checks; legacy
 * script callers without these variables retain their original directory layout. */
function resolvePlatformResourceRoots(appDataPath, environment = process.env) {
    const root = (name, fallback) => {
        const configured = environment[name];
        if (configured === undefined || configured === '') return path.join(appDataPath, fallback);
        if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error(`${name} must be an absolute platform resource root.`);
        return path.resolve(configured);
    };
    return {
        compilerPath: root('AILY_COMPILERS_PATH', 'compiler'),
        sdkPath: root('AILY_SDK_PATH', 'sdk'),
        toolsPath: root('AILY_TOOLS_PATH', 'tools'),
        readOnly: !!environment.AILY_REPAIR_READONLY_NPM_PREFIX,
    };
}

/** Builder accepts one tools root. A legacy split compiler directory is
 * projected into a private directory view instead of linking into shared tools.
 * Only directory entries are mapped; no SDK/tool body is copied or changed. */
function prepareReadOnlyToolsView(appDataPath, resources, compilerDirectory) {
    if (!resources.readOnly || path.resolve(resources.compilerPath) === path.resolve(resources.toolsPath)
        || !fs.existsSync(compilerDirectory)) return resources.toolsPath;
    const compilerName = path.basename(compilerDirectory);
    if (fs.existsSync(path.join(resources.toolsPath, compilerName))) return resources.toolsPath;
    const identity = createHash('sha256').update(JSON.stringify([resources.compilerPath, resources.toolsPath, compilerName])).digest('hex');
    const base = path.join(appDataPath, 'resource-views'), view = path.join(base, identity);
    fs.mkdirSync(base, { recursive: true });
    if (fs.lstatSync(base).isSymbolicLink()) throw new Error('Private resource view root must not be linked.');
    fs.mkdirSync(view, { recursive: true });
    if (fs.lstatSync(view).isSymbolicLink()) throw new Error('Private resource view must not be linked.');
    const map = (name, target) => {
        const entry = path.join(view, name);
        try { fs.symlinkSync(path.resolve(target), entry, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const real = value => { const resolved = fs.realpathSync(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
        if (real(entry) !== real(target)) throw new Error('An existing private tool view maps to a different resource.');
    };
    for (const entry of fs.readdirSync(resources.toolsPath, { withFileTypes: true })) {
        const target = path.join(resources.toolsPath, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink() && fs.statSync(target).isDirectory()) map(entry.name, target);
    }
    map(compilerName, compilerDirectory);
    return view;
}

module.exports = { resolvePlatformResourceRoots, prepareReadOnlyToolsView };
