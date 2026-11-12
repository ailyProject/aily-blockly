'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');

const LEGACY_ARM_GCC = 'arm-none-eabi-gcc@7.2.1';
const LEGACY_WINDOWS_PATH_LIMIT = 260;
// GCC 7's MinGW build appends an unnormalized multilib search path to its
// executable directory. Budget for that path, including the relative segments.
const LEGACY_GCC_HEADER = '/bin/../lib/gcc/arm-none-eabi/7.2.1/../../../../'
    + 'arm-none-eabi/include/c++/7.2.1/arm-none-eabi/thumb/v7e-m/fpv4-sp/hard/bits/c++config.h';

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

function exceedsLegacyGccPathLimit(toolsPath) {
    return Buffer.byteLength(path.join(toolsPath, LEGACY_ARM_GCC) + LEGACY_GCC_HEADER) >= LEGACY_WINDOWS_PATH_LIMIT;
}

function isLegacyWindowsGcc(compiler) {
    return process.platform === 'win32' && compiler === LEGACY_ARM_GCC;
}

function createViewDirectory(directory) {
    try { fs.mkdirSync(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return fs.lstatSync(directory).isDirectory();
}

function shortenDirectory(directory, fits, preserveName = false) {
    const realpath = fs.realpathSync.native;
    const target = realpath(directory);
    const identity = createHash('sha256').update(target).digest('hex').slice(0, 24);
    // LocalAppData is independent of the selected Coder profile. A normal
    // per-user home also works if LocalAppData has been redirected to a long path.
    for (const parent of new Set([process.env.LOCALAPPDATA, os.homedir()])) {
        if (!parent || !path.isAbsolute(parent)) continue;
        const root = path.join(parent, 'aily-toolchains');
        const aliasParent = preserveName ? path.join(root, `l${identity}`) : root;
        const alias = path.join(aliasParent, preserveName ? path.basename(directory) : identity);
        if (!fits(alias)) continue;
        try {
            if (!createViewDirectory(root) || preserveName && !createViewDirectory(aliasParent)) continue;
            try { fs.symlinkSync(target, alias, 'junction'); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            if (fs.lstatSync(alias).isSymbolicLink() && realpath(alias) === target) return alias;
        } catch {
            // Leave unusable entries alone and try the other per-user location.
        }
    }
    return directory;
}

/** Keep the full tool tree available under the same short root for dependency
 * discovery, compilation, linking and firmware conversion. */
function prepareBuilderToolsPath(appDataPath, resources, compilerDirectory) {
    const toolsPath = prepareReadOnlyToolsView(appDataPath, resources, compilerDirectory);
    if (!isLegacyWindowsGcc(path.basename(compilerDirectory)) || !exceedsLegacyGccPathLimit(toolsPath)
        || !fs.existsSync(path.join(toolsPath, LEGACY_ARM_GCC, 'bin', 'arm-none-eabi-g++.exe'))) return toolsPath;
    return shortenDirectory(toolsPath, candidate => !exceedsLegacyGccPathLimit(candidate));
}

function prepareBuilderLibraryPath(compiler, { location, maxRelativePathBytes }) {
    const fits = directory => Buffer.byteLength(directory) + 1 + maxRelativePathBytes < LEGACY_WINDOWS_PATH_LIMIT;
    if (!isLegacyWindowsGcc(compiler) || fits(location)) return location;
    // Builder derives a library name from its source directory, or from the
    // parent of a conventional src/ directory. Keep both names in the view.
    if (path.basename(location) === 'src') {
        return path.join(shortenDirectory(path.dirname(location), candidate => fits(path.join(candidate, 'src')), true), 'src');
    }
    return shortenDirectory(location, fits, true);
}

module.exports = { resolvePlatformResourceRoots, prepareReadOnlyToolsView, prepareBuilderToolsPath, prepareBuilderLibraryPath };
