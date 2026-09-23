'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveInstalledPackagePath } = require('./subapp-manager');
const MANIFEST = 'aily-simulator-runtime.json';
const PACKAGE = { id: 'aily-simulator', package: '@aily-project/aily-simulator' };
const fault = (code, message, details) => Object.assign(new Error(message), { code, details });

/** Locate one Runtime, not a source tree or a second engine validator.
 * The caller holds the existing Subapp install lock while selecting packages.
 * A broken explicit/pinned selection is actionable, never silently bypassed.
 */
function resolveDebuggerRuntime({ runtimeManifestPath, subappRoot, resourcesPath }) {
    const select = (filename, source, root) => {
        if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
            throw fault('DEBUG_RUNTIME_INVALID', 'Runtime manifest must be an absolute path.');
        }
        let resolved;
        try {
            resolved = fs.realpathSync(filename);
            const metadata = fs.statSync(resolved);
            if (!metadata.isFile() || metadata.size < 1 || metadata.size > 2 * 1024 * 1024) throw new Error('Invalid size or file type.');
            if (root) {
                const relative = path.relative(fs.realpathSync(root), resolved);
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Manifest is outside the selected package.');
            }
        } catch (error) {
            throw fault('DEBUG_RUNTIME_INVALID', `Selected Runtime manifest is unavailable: ${filename}`, { source, reason: error.message });
        }
        return { manifestPath: resolved, source };
    };
    if (runtimeManifestPath !== undefined && runtimeManifestPath !== '') {
        return select(runtimeManifestPath, 'explicit');
    }
    const installed = resolveInstalledPackagePath(subappRoot, PACKAGE);
    if (installed.disabled || installed.selectionError) {
        throw fault('DEBUG_RUNTIME_UNAVAILABLE', 'Installed Simulator Runtime selection is unavailable; finish or repair its installation.',
            { reason: installed.selectionError || 'Package is being uninstalled.' });
    }
    const packageManifest = path.join(installed.packagePath, 'package.json');
    if (fs.existsSync(packageManifest)) {
        let metadata;
        try { metadata = JSON.parse(fs.readFileSync(packageManifest, 'utf8')); } catch { /* Invalid installed selection must not fall back. */ }
        if (metadata?.name !== PACKAGE.package) throw fault('DEBUG_RUNTIME_INVALID', 'Installed Simulator package identity is invalid.');
        return select(path.join(installed.packagePath, MANIFEST), 'installed', installed.packagePath);
    }
    if (resourcesPath) {
        const root = path.join(resourcesPath, 'simulator'), filename = path.join(root, MANIFEST);
        if (fs.existsSync(filename)) return select(filename, 'bundled', root);
    }
    throw fault('DEBUG_RUNTIME_NOT_INSTALLED', 'Install the Simulator Runtime package, or configure AILY_SIMDEBUG_RUNTIME_MANIFEST for a local development bundle.',
        { packageName: PACKAGE.package, manifestName: MANIFEST });
}

module.exports = { resolveDebuggerRuntime };
